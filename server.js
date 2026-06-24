const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const archiver = require('archiver');
const { EventEmitter } = require('events');
const winston = require('winston');
const NodeCache = require('node-cache');
const { chromium } = require('playwright');

// --------------- Configuration ---------------
const PORT = process.env.PORT || 10000;
const CACHE_TTL = 300;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

// --------------- Logger ---------------
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

// --------------- Express ---------------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// SSE
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

const originalLog = log;
log = (level, message) => {
  originalLog(level, message);
  broadcastSSE('log', { timestamp: new Date().toISOString(), level, message });
};

// --------------- Cache ---------------
const galleryCache = new Map();

// --------------- Anti-Blocking ---------------
class AntiBlockingManager {
  getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  }
  createSession() {
    return axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': this.getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
    });
  }
}
const antiBlock = new AntiBlockingManager();

// --------------- Playwright Parser ---------------
class HitomiParser {
  constructor(galleryId) {
    this.galleryId = galleryId;
  }

  async fetchGalleryData() {
    log('info', 'Launching Playwright browser...');
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent(antiBlock.getRandomUserAgent());

      const url = `https://hitomi.la/imageset/${this.galleryId}.html`;
      log('info', `Navigating to ${url}`);
      
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

      // Wait for gallery data to load
      await page.waitForFunction(
        'typeof galleryinfo !== "undefined" || typeof galleryInfo !== "undefined" || document.querySelector("img") !== null',
        { timeout: 30000 }
      );

      log('info', 'Page loaded, extracting data...');

      // Extract data
      const data = await page.evaluate(() => {
        let images = null;
        let cdns = ['a', 'b', 'c', 'aa', 'ba'];

        if (typeof window.galleryinfo !== 'undefined' && window.galleryinfo) {
          images = window.galleryinfo;
        } else if (typeof window.galleryInfo !== 'undefined' && window.galleryInfo) {
          images = window.galleryInfo;
        }

        if (typeof window.cdns !== 'undefined' && window.cdns) {
          cdns = window.cdns;
        }

        // Fallback: extract from img elements
        if (!images || !images.length) {
          const imgElements = document.querySelectorAll('img');
          const imgUrls = [];
          imgElements.forEach(img => {
            if (img.src && img.src.includes('hitomi.la')) {
              const parts = img.src.split('/');
              const fileName = parts[parts.length - 1];
              imgUrls.push({ url: fileName });
            }
          });
          if (imgUrls.length > 0) images = imgUrls;
        }

        const title = document.querySelector('title')?.textContent?.replace(/^Hitomi\.la\s*[-–—]\s*/, '') || 
                      `Gallery ${window.location.pathname.match(/\d+/)?.[0] || ''}`;

        return { images, cdns, title };
      });

      if (!data.images || !data.images.length) {
        throw new Error('No images found in gallery');
      }

      log('info', `Found ${data.images.length} images`);

      const formats = [...new Set(data.images.map(img => {
        const parts = img.url.split('.');
        return parts.length > 1 ? parts.pop().toLowerCase() : 'jpg';
      }))];

      return {
        total: data.images.length,
        title: data.title,
        formats,
        cdns: data.cdns,
        galleryId: this.galleryId,
        images: data.images,
      };

    } finally {
      await browser.close();
      log('info', 'Browser closed');
    }
  }
}

// --------------- Helper ---------------
async function getGalleryInfo(galleryId) {
  if (galleryCache.has(galleryId)) {
    log('info', `Using cached info for gallery ${galleryId}`);
    return galleryCache.get(galleryId);
  }

  const parser = new HitomiParser(galleryId);
  const info = await parser.fetchGalleryData();
  galleryCache.set(galleryId, info);
  return info;
}

function constructImageUrl(galleryId, imageFile, cdns) {
  const sub = cdns[Math.floor(Math.random() * cdns.length)];
  return `https://${sub}.hitomi.la/galleries/${galleryId}/${imageFile}`;
}

// --------------- API Routes ---------------
app.post('/api/gallery/info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const match = url.match(/(\d+)\.html$/);
    if (!match) return res.status(400).json({ error: 'Invalid gallery URL' });
    const galleryId = parseInt(match[1], 10);

    const info = await getGalleryInfo(galleryId);
    const sizeEstimate = (info.total * 0.5).toFixed(2) + ' MB';

    res.json({
      total: info.total,
      title: info.title,
      formats: info.formats,
      sizeEstimate,
    });
  } catch (err) {
    console.error('Info error:', err);
    log('error', `Info error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gallery/download', async (req, res) => {
  const { url, count } = req.body;
  if (!url || !count) return res.status(400).json({ error: 'URL and count required' });

  try {
    const match = url.match(/(\d+)\.html$/);
    if (!match) return res.status(400).json({ error: 'Invalid gallery URL' });
    const galleryId = parseInt(match[1], 10);

    const info = await getGalleryInfo(galleryId);
    const downloadCount = Math.min(Math.max(1, parseInt(count, 10)), info.total);
    const { images, cdns, title } = info;

    log('info', `Starting ZIP for ${downloadCount} images from "${title}"`);

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
      log('warn', 'Download aborted');
    });

    const session = antiBlock.createSession();
    for (let i = 0; i < downloadCount; i++) {
      if (aborted) break;
      const img = images[i];
      const imgUrl = constructImageUrl(galleryId, img.url, cdns);
      const ext = img.url.split('.').pop() || 'jpg';
      const filename = `${String(i+1).padStart(3, '0')}.${ext}`;

      try {
        const response = await session.get(imgUrl, { responseType: 'stream' });
        archive.append(response.data, { name: filename, store: true });
        log('info', `Added ${filename}`);

        const percent = Math.round(((i+1) / downloadCount) * 100);
        broadcastSSE('progress', { current: i+1, total: downloadCount, percent });
      } catch (err) {
        log('error', `Failed ${filename}: ${err.message}`);
      }
    }

    await archive.finalize();
    log('info', `ZIP complete: ${safeFilename}`);
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

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const server = app.listen(PORT, () => {
  log('info', `Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
