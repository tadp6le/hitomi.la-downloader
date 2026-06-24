const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const { EventEmitter } = require('events');
const winston = require('winston');
const NodeCache = require('node-cache');

// --------------- Configuration ---------------
const PORT = process.env.PORT || 10000;
const MAX_IMAGES = parseInt(process.env.MAX_IMAGES, 10) || 200;
const CACHE_TTL = 300; // 5 minutes

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0',
];

// --------------- Logger with SSE broadcast ---------------
const logEmitter = new EventEmitter();
const sseClients = new Set();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

function log(level, message) {
  logger.log(level, message);
  const entry = { timestamp: new Date().toISOString(), level, message };
  logEmitter.emit('log', entry);
}

// --------------- Express App ---------------
const app = express();

// Fix for rate-limit behind proxy (Render)
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// SSE endpoint
app.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('data: {"connected":true}\n\n');

  const client = { res };
  sseClients.add(client);
  req.on('close', () => sseClients.delete(client));
});

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => client.res.write(payload));
}

// Override log to also broadcast SSE
const originalLog = log;
log = (level, message) => {
  originalLog(level, message);
  broadcastSSE('log', { timestamp: new Date().toISOString(), level, message });
};

// --------------- Cache ---------------
const cache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 120 });

// --------------- Anti-Blocking Manager ---------------
class AntiBlockingManager {
  constructor() {
    this.delayMin = 200;
    this.delayMax = 500;
    this.retryCount = 3;
    this.backoffMultiplier = 2;
  }

  getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  }

  randomDelay() {
    const ms = Math.floor(Math.random() * (this.delayMax - this.delayMin + 1)) + this.delayMin;
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  exponentialBackoff(attempt) {
    const ms = Math.pow(this.backoffMultiplier, attempt) * 1000;
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async executeWithRetry(fn, context = '') {
    for (let attempt = 1; attempt <= this.retryCount; attempt++) {
      try {
        await this.randomDelay();
        return await fn();
      } catch (error) {
        if (attempt === this.retryCount) throw error;
        log('warn', `Retry ${attempt}/${this.retryCount} for ${context} (${error.message})`);
        await this.exponentialBackoff(attempt);
      }
    }
  }

  createSession() {
    return axios.create({
      timeout: 30000,
      maxRedirects: 5,
      headers: {
        'User-Agent': this.getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });
  }
}

const antiBlock = new AntiBlockingManager();

// --------------- Hitomi Gallery Parser ---------------
class HitomiGallery {
  constructor(url) {
    this.url = url;
    this.galleryId = this.extractId(url);
  }

  extractId(url) {
    const match = url.match(/(\d+)\.html$/);
    return match ? match[1] : null;
  }

  async fetchGalleryJS(galleryId, session) {
    // The domain changed from hitomi.la to ltn.gold-usergeneratedcontent.net[reference:1]
    const domains = [
      'ltn.gold-usergeneratedcontent.net',  // New domain
      'ltn.hitomi.la',                      // Old domain (fallback)
      'hitomi.la',                          // Another fallback
    ];
    const errors = [];

    for (const domain of domains) {
      const url = `https://${domain}/galleries/${galleryId}.js`;
      try {
        log('info', `Trying JS URL: ${url}`);
        const response = await session.get(url, { timeout: 10000 });
        if (response.status === 200) {
          log('info', `✅ Successfully fetched JS from ${url}`);
          return response.data;
        }
      } catch (err) {
        errors.push(`${url}: ${err.message}`);
      }
    }

    log('error', `All JS fetch attempts failed: ${errors.join('; ')}`);
    throw new Error(`Could not fetch gallery metadata JS. Tried: ${errors.length} URLs.`);
  }

  async getGalleryInfo() {
    if (!this.galleryId) throw new Error('Invalid gallery URL. Must end with -<id>.html');

    const cacheKey = `gallery_${this.galleryId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      log('info', `Using cached info for gallery ${this.galleryId}`);
      return cached;
    }

    log('info', `Fetching gallery page: ${this.url}`);
    const session = antiBlock.createSession();
    let html;
    await antiBlock.executeWithRetry(async () => {
      const res = await session.get(this.url);
      html = res.data;
    }, `fetch gallery page ${this.galleryId}`);

    // Fetch the JS file containing gallery data
    let jsContent;
    try {
      jsContent = await this.fetchGalleryJS(this.galleryId, session);
    } catch (err) {
      log('error', `Failed to fetch JS: ${err.message}`);
      throw new Error(`Unable to load gallery data: ${err.message}`);
    }

    // Parse the JS to extract galleryinfo object
    // The JS file contains: var galleryinfo = { ... };
    let galleryInfo = null;
    
    // Try to find galleryinfo object
    const match = jsContent.match(/var\s+galleryinfo\s*=\s*(\{[\s\S]*?\});/);
    if (match) {
      try {
        galleryInfo = JSON.parse(match[1]);
        log('info', 'Successfully parsed galleryinfo from JS');
      } catch (e) {
        log('error', `Failed to parse galleryinfo JSON: ${e.message}`);
        // Try to clean up and parse again
        try {
          const cleaned = match[1].replace(/\/\/.*$/gm, '').replace(/,\s*}/g, '}');
          galleryInfo = JSON.parse(cleaned);
          log('info', 'Successfully parsed galleryinfo after cleaning');
        } catch (e2) {
          log('error', `Failed to parse even after cleaning: ${e2.message}`);
        }
      }
    }

    if (!galleryInfo || !galleryInfo.files || !galleryInfo.files.length) {
      log('error', `No files found in galleryinfo. First 500 chars of JS: ${jsContent.substring(0, 500)}`);
      throw new Error('No images found in gallery. The site might have changed its format.');
    }

    // Extract images from files array
    const images = galleryInfo.files.map(file => ({
      url: file.name,
      width: file.width,
      height: file.height,
      hasavif: file.hasavif || 0,
    }));

    // CDN subdomains for images
    const cdns = ['a', 'b', 'c', 'aa', 'ba'];

    // Title from HTML
    const $ = cheerio.load(html);
    const titleTag = $('title').text().trim();
    const title = titleTag.replace(/^Hitomi\.la\s*[-–—]\s*/i, '') || `Gallery ${this.galleryId}`;

    // Formats
    const formats = [...new Set(images.map(img => img.url.split('.').pop().toLowerCase()))];
    const total = images.length;

    const info = {
      total,
      title,
      formats,
      cdns,
      galleryId: this.galleryId,
      images,
    };

    cache.set(cacheKey, info);
    log('info', `Gallery: "${title}" (ID: ${this.galleryId}), ${total} images, formats: ${formats.join(',')}`);
    return info;
  }
}

// Helper: construct image URL
function constructImageUrl(galleryId, imageFile, cdns) {
  const sub = cdns[Math.floor(Math.random() * cdns.length)];
  return `https://${sub}.hitomi.la/galleries/${galleryId}/${imageFile}`;
}

// --------------- API Routes ---------------
app.post('/api/gallery/info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL required' });
    }

    const gallery = new HitomiGallery(url);
    const info = await gallery.getGalleryInfo();

    // Estimate total size
    const { images, cdns, galleryId } = info;
    let totalSize = 0;
    const concurrency = 5;
    const total = images.length;
    const queue = [...Array(total).keys()];

    log('info', `Estimating total size (${total} images)...`);
    const session = antiBlock.createSession();
    const fetchHead = async () => {
      while (queue.length) {
        const idx = queue.shift();
        const img = images[idx];
        const url = constructImageUrl(galleryId, img.url, cdns);
        try {
          await antiBlock.executeWithRetry(async () => {
            const headRes = await session.head(url);
            const len = parseInt(headRes.headers['content-length'], 10);
            if (len) totalSize += len;
          }, `HEAD ${url}`);
        } catch (e) {
          log('warn', `Skipped size check for image ${idx+1}: ${e.message}`);
        }
      }
    };

    const workers = Array(Math.min(concurrency, total)).fill(0).map(() => fetchHead());
    await Promise.all(workers);

    const sizeEstimate = totalSize ? (totalSize / (1024*1024)).toFixed(2) + ' MB' : 'Unknown';
    log('info', `Estimated total size: ${sizeEstimate}`);
    
    res.json({
      total: info.total,
      title: info.title,
      formats: info.formats,
      sizeEstimate,
    });
  } catch (err) {
    console.error('Info endpoint error:', err);
    log('error', `Info error: ${err.message}`);
    res.status(500).json({ 
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

app.post('/api/gallery/download', async (req, res) => {
  const { url, count } = req.body;
  if (!url || !count) {
    return res.status(400).json({ error: 'URL and count required' });
  }

  try {
    const gallery = new HitomiGallery(url);
    const info = await gallery.getGalleryInfo();
    const downloadCount = Math.min(Math.max(1, parseInt(count, 10)), info.total);
    const { images, cdns, galleryId, title } = info;

    log('info', `Starting ZIP creation for ${downloadCount} images from "${title}"`);

    const safeFilename = title.replace(/[\\/:*?"<>|]/g, '_') + '.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Transfer-Encoding', 'chunked');

    const archive = archiver('zip', { zlib: { level: 0 }, store: true });
    archive.on('error', (err) => {
      log('error', `Archive error: ${err.message}`);
      if (!res.headersSent) res.status(500).end();
    });
    archive.pipe(res);

    let aborted = false;
    req.on('close', () => {
      aborted = true;
      archive.abort();
      log('warn', 'Download aborted by client');
    });

    const session = antiBlock.createSession();
    for (let i = 0; i < downloadCount; i++) {
      if (aborted) break;
      const img = images[i];
      const imgUrl = constructImageUrl(galleryId, img.url, cdns);
      const ext = img.url.split('.').pop();
      const filename = `${i+1}.${ext}`;

      try {
        let size = 0;
        await antiBlock.executeWithRetry(async () => {
          const headRes = await session.head(imgUrl);
          size = parseInt(headRes.headers['content-length'], 10) || 0;
        }, `HEAD ${imgUrl}`);

        const imageStream = await antiBlock.executeWithRetry(async () => {
          const response = await session.get(imgUrl, { responseType: 'stream' });
          return response.data;
        }, `GET ${imgUrl}`);

        archive.append(imageStream, { name: filename, store: true, size });
        log('info', `Added ${filename} (${(size/1024).toFixed(1)} KB)`);

        const percent = Math.round(((i+1) / downloadCount) * 100);
        broadcastSSE('progress', { current: i+1, total: downloadCount, percent });
      } catch (err) {
        log('error', `Failed to add image ${i+1}: ${err.message}`);
      }
    }

    await archive.finalize();
    log('info', `ZIP completed: ${safeFilename}`);
    broadcastSSE('progress', { current: downloadCount, total: downloadCount, percent: 100 });
    broadcastSSE('complete', { filename: safeFilename });
  } catch (err) {
    console.error('Download error:', err);
    log('error', `Download error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

app.get('/api/health', (req, res) => res.status(200).send('OK'));

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const server = app.listen(PORT, () => {
  log('info', `Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
