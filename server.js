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

// --------------- Hitomi Gallery Parser (FIXED) ---------------
class HitomiGallery {
  constructor(url) {
    this.url = url;
    this.galleryId = this.extractId(url);
  }

  extractId(url) {
    const match = url.match(/(\d+)\.html$/);
    return match ? match[1] : null;
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

    const $ = cheerio.load(html);

    // ---------- Extract image list ----------
    // Look for any <script> that contains galleryinfo
    const scripts = $('script').map((i, el) => $(el).html()).get();
    let images = [];

    // Try multiple regex patterns – Hitomi uses different variable names and formats
    const patterns = [
      /var\s+galleryinfo\s*=\s*(\[[\s\S]*?\]);/i,      // galleryinfo
      /var\s+galleryInfo\s*=\s*(\[[\s\S]*?\]);/i,      // galleryInfo
      /galleryinfo\s*=\s*(\[[\s\S]*?\]);/i,            // no var
      /galleryInfo\s*=\s*(\[[\s\S]*?\]);/i,
    ];

    for (const script of scripts) {
      for (const pattern of patterns) {
        const match = script.match(pattern);
        if (match) {
          try {
            images = JSON.parse(match[1]);
            if (Array.isArray(images) && images.length > 0) break;
          } catch (e) {
            // continue trying other patterns
          }
        }
      }
      if (images.length) break;
    }

    if (!images.length) {
      log('error', 'Could not find gallery image data. Page structure may have changed.');
      throw new Error('No images found in gallery. The site might have changed its format.');
    }

    // ---------- CDN subdomains ----------
    let cdns = ['a', 'b', 'c', 'aa', 'ba'];
    for (const script of scripts) {
      const m = script.match(/var\s+cdns\s*=\s*(\[[^\]]*\])/i)
             || script.match(/cdns\s*=\s*(\[[^\]]*\])/i);
      if (m) {
        try {
          cdns = JSON.parse(m[1]);
          break;
        } catch (e) {}
      }
    }

    // ---------- Title ----------
    const titleTag = $('title').text().trim();
    const title = titleTag.replace(/^Hitomi\.la\s*[-–—]\s*/i, '') || `Gallery ${this.galleryId}`;

    // ---------- Available formats ----------
    const formats = [...new Set(images.map(img => img.url.split('.').pop().toLowerCase()))];
    const total = images.length;

    const info = {
      total,
      title,
      formats,
      cdns,
      galleryId: this.galleryId,
      images, // store raw image objects for later use
    };

    cache.set(cacheKey, info);
    log('info', `Gallery: "${title}" (ID: ${this.galleryId}), ${total} images, formats: ${formats.join(',')}`);
    return info;
  }
}

// --------------- Helper: construct image URL ---------------
function constructImageUrl(galleryId, imageFile, cdns) {
  const sub = cdns[Math.floor(Math.random() * cdns.length)];
  return `https://${sub}.hitomi.la/galleries/${galleryId}/${imageFile}`;
}

// --------------- API Routes ---------------
app.post('/api/gallery/info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const gallery = new HitomiGallery(url);
    const info = await gallery.getGalleryInfo();

    // Estimate total size (optional, can skip if timeouts occur)
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
    log('error', `Info error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gallery/download', async (req, res) => {
  const { url, count } = req.body;
  if (!url || !count) return res.status(400).json({ error: 'URL and count required' });

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
        // Get content-length for streaming
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
    log('error', `Download error: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.status(200).send('OK'));

// Global error handlers for debugging
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

const server = app.listen(PORT, () => {
  log('info', `Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
