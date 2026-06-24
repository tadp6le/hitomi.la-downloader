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

// --------------- Improved Hitomi Gallery Parser ---------------
class HitomiGallery {
  constructor(url) {
    this.url = url;
    this.galleryId = this.extractId(url);
  }

  extractId(url) {
    const match = url.match(/(\d+)\.html$/);
    return match ? match[1] : null;
  }

  // Helper: extract a JSON array from a script using bracket counting
  extractArrayFromScript(scriptContent, variableName) {
    // Find the position of variable assignment
    const regex = new RegExp(`(?:var\\s+)?${variableName}\\s*=\\s*`, 'i');
    const match = regex.exec(scriptContent);
    if (!match) return null;

    const startIdx = match.index + match[0].length;
    let bracketCount = 0;
    let inString = false;
    let escape = false;
    let arrayStart = -1;
    let arrayEnd = -1;

    for (let i = startIdx; i < scriptContent.length; i++) {
      const char = scriptContent[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"' || char === "'") {
        if (!inString) {
          inString = char;
        } else if (inString === char) {
          inString = false;
        }
        continue;
      }
      if (inString) continue;

      if (char === '[') {
        if (bracketCount === 0) arrayStart = i;
        bracketCount++;
      } else if (char === ']') {
        bracketCount--;
        if (bracketCount === 0) {
          arrayEnd = i;
          break;
        }
      }
    }

    if (arrayStart === -1 || arrayEnd === -1) return null;
    const arrayStr = scriptContent.substring(arrayStart, arrayEnd + 1);
    try {
      return JSON.parse(arrayStr);
    } catch (e) {
      // Attempt to clean up common issues (trailing commas, comments)
      try {
        const cleaned = arrayStr.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const finalStr = cleaned.replace(/,\s*\]/g, ']');
        return JSON.parse(finalStr);
      } catch (e2) {
        log('error', `Failed to parse array for ${variableName}: ${e2.message}`);
        return null;
      }
    }
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

    // ---------- NEW: Fetch the external JS file that contains the image data ----------
    // The HTML has a script like: document.write(`<script src="//${domain}/galleries/${galleryid}.js"></script>`);
    // We'll directly fetch https://hitomi.la/galleries/${galleryId}.js
    const jsUrl = `https://hitomi.la/galleries/${this.galleryId}.js`;
    log('info', `Fetching external JS: ${jsUrl}`);
    let jsContent;
    await antiBlock.executeWithRetry(async () => {
      const res = await session.get(jsUrl);
      jsContent = res.data;
    }, `fetch external JS ${this.galleryId}`);

    // Now parse jsContent for the image array
    let images = null;
    let cdns = ['a', 'b', 'c', 'aa', 'ba'];

    // Try multiple variable names
    const varNames = ['galleryinfo', 'galleryInfo', 'galleryInfoList', 'images', 'imgData'];
    for (const name of varNames) {
      const result = this.extractArrayFromScript(jsContent, name);
      if (result && Array.isArray(result) && result.length > 0) {
        images = result;
        log('info', `Found image data using variable "${name}" in external JS`);
        break;
      }
    }

    // If still not found, try generic regex for any array containing "url"
    if (!images) {
      log('warn', 'No specific variable found; searching for any array containing "url" in external JS');
      const arrayMatches = jsContent.match(/\[[\s\S]*?\{[\s\S]*?url[\s\S]*?\}[\s\S]*?\]/g);
      if (arrayMatches) {
        for (const arrStr of arrayMatches) {
          try {
            const parsed = JSON.parse(arrStr);
            if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].url) {
              images = parsed;
              log('info', 'Found image data via generic array search in external JS');
              break;
            }
          } catch (e) { /* ignore */ }
        }
      }
    }

    // Also try to extract cdns from the JS (might be defined there)
    const cdnsMatch = jsContent.match(/var\s+cdns\s*=\s*(\[[^\]]*\])/i) || jsContent.match(/cdns\s*=\s*(\[[^\]]*\])/i);
    if (cdnsMatch) {
      try {
        cdns = JSON.parse(cdnsMatch[1]);
        log('info', `Found cdns from external JS: ${cdns.join(', ')}`);
      } catch (e) {}
    }

    if (!images || !images.length) {
      log('error', `No images found in external JS. First 500 chars of JS: ${jsContent.substring(0, 500)}`);
      throw new Error('No images found in gallery. The site might have changed its format. Please check the logs.');
    }

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