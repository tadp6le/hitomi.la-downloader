const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const axios = require('axios');
const archiver = require('archiver');
const { EventEmitter } = require('events');
const winston = require('winston');
const NodeCache = require('node-cache');
const hitomi = require('hitomi.la');   // <-- NEW PACKAGE

// --------------- Configuration ---------------
const PORT = process.env.PORT || 10000;
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
const galleryCache = new Map(); // simple in-memory cache for gallery info

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

// --------------- Helper: get gallery info using hitomi.la package ---------------
async function getGalleryInfo(galleryId) {
  // Check memory cache
  if (galleryCache.has(galleryId)) {
    log('info', `Using cached info for gallery ${galleryId}`);
    return galleryCache.get(galleryId);
  }

  // Get image links
  const links = await new Promise((resolve, reject) => {
    hitomi.imageLinks(galleryId, (err, links) => {
      if (err) reject(err);
      else resolve(links);
    });
  });

  if (!links || !links.length) {
    throw new Error('No images found in gallery');
  }

  // Get list of galleries for title
  const list = await new Promise((resolve, reject) => {
    hitomi.list((err, list) => {
      if (err) reject(err);
      else resolve(list);
    });
  });

  const galleryMeta = list.find(g => g.id === galleryId);
  const title = galleryMeta?.name || `Gallery ${galleryId}`;

  // Extract formats
  const formats = [...new Set(links.map(img => {
    const parts = img.name.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : 'jpg';
  }))];

  // Rough size estimate (500KB per image)
  const totalSize = links.length * 500 * 1024;
  const sizeEstimate = (totalSize / (1024 * 1024)).toFixed(2) + ' MB';

  const info = {
    total: links.length,
    title,
    formats,
    sizeEstimate,
    images: links,
    galleryId,
  };

  galleryCache.set(galleryId, info);
  return info;
}

// --------------- API Routes ---------------
app.post('/api/gallery/info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL required' });
    }

    // Extract gallery ID
    const match = url.match(/(\d+)\.html$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid gallery URL' });
    }
    const galleryId = parseInt(match[1], 10);

    log('info', `Fetching gallery info for ID: ${galleryId}`);
    const info = await getGalleryInfo(galleryId);

    res.json({
      total: info.total,
      title: info.title,
      formats: info.formats,
      sizeEstimate: info.sizeEstimate,
    });
  } catch (err) {
    console.error('Info endpoint error:', err);
    log('error', `Info error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gallery/download', async (req, res) => {
  const { url, count } = req.body;
  if (!url || !count) {
    return res.status(400).json({ error: 'URL and count required' });
  }

  try {
    const match = url.match(/(\d+)\.html$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid gallery URL' });
    }
    const galleryId = parseInt(match[1], 10);

    // Get gallery info (cached)
    const info = await getGalleryInfo(galleryId);
    const downloadCount = Math.min(Math.max(1, parseInt(count, 10)), info.total);
    const { images, title } = info;

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
      const imgUrl = img.url; // already full URL from package
      const ext = img.name.split('.').pop() || 'jpg';
      const filename = `${String(i+1).padStart(3, '0')}.${ext}`;

      try {
        const stream = await antiBlock.executeWithRetry(async () => {
          const response = await session.get(imgUrl, { responseType: 'stream' });
          return response.data;
        }, `GET ${imgUrl}`);

        let size = 0;
        try {
          const headRes = await session.head(imgUrl);
          size = parseInt(headRes.headers['content-length'], 10) || 0;
        } catch (e) { /* ignore */ }

        archive.append(stream, { name: filename, store: true, size });
        log('info', `Added ${filename}`);

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
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));

const server = app.listen(PORT, () => {
  log('info', `Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
