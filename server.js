const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const { EventEmitter } = require('events');
const winston = require('winston');
const NodeCache = require('node-cache');

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

// --------------- Logger with SSE ---------------
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

const originalLog = log;
log = (level, message) => {
  originalLog(level, message);
  broadcastSSE('log', { timestamp: new Date().toISOString(), level, message });
};

// --------------- Cache ---------------
const cache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 120 });
const galleryCache = new Map();

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

// --------------- Custom Hitomi Parser (No external package) ---------------
class HitomiParser {
  constructor(galleryId) {
    this.galleryId = galleryId;
  }

  // Extract a JSON array from a script using bracket counting
  extractArray(scriptContent, variableName) {
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
      if (escape) { escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (char === '"' || char === "'") {
        if (!inString) inString = char;
        else if (inString === char) inString = false;
        continue;
      }
      if (inString) continue;

      if (char === '[') {
        if (bracketCount === 0) arrayStart = i;
        bracketCount++;
      } else if (char === ']') {
        bracketCount--;
        if (bracketCount === 0) { arrayEnd = i; break; }
      }
    }

    if (arrayStart === -1 || arrayEnd === -1) return null;
    const arrayStr = scriptContent.substring(arrayStart, arrayEnd + 1);
    try {
      return JSON.parse(arrayStr);
    } catch (e) {
      try {
        const cleaned = arrayStr.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const finalStr = cleaned.replace(/,\s*\]/g, ']');
        return JSON.parse(finalStr);
      } catch (e2) {
        return null;
      }
    }
  }

  async fetchGalleryData() {
    const session = antiBlock.createSession();

    // Step 1: Fetch the main gallery page
    const pageUrl = `https://hitomi.la/imageset/${this.galleryId}.html`; // typical pattern
    log('info', `Fetching gallery page: ${pageUrl}`);
    let html;
    await antiBlock.executeWithRetry(async () => {
      const res = await session.get(pageUrl);
      html = res.data;
    }, `fetch page ${this.galleryId}`);

    const $ = cheerio.load(html);

    // Step 2: Extract the domain variable from inline scripts
    let domain = 'ltn.hitomi.la'; // fallback
    const scripts = $('script').map((i, el) => $(el).html()).get();
    for (const script of scripts) {
      if (!script) continue;
      const match = script.match(/var\s+domain\s*=\s*['"]([^'"]+)['"]/i);
      if (match) {
        domain = match[1];
        log('info', `Found domain variable: ${domain}`);
        break;
      }
    }

    // Step 3: Fetch the external JS file from that domain
    const jsUrl = `https://${domain}/galleries/${this.galleryId}.js`;
    log('info', `Fetching external JS: ${jsUrl}`);
    let jsContent;
    await antiBlock.executeWithRetry(async () => {
      const res = await session.get(jsUrl);
      jsContent = res.data;
    }, `fetch external JS ${this.galleryId}`);

    // Step 4: Parse images from the JS
    let images = null;
    const varNames = ['galleryinfo', 'galleryInfo', 'galleryInfoList', 'images', 'imgData'];
    for (const name of varNames) {
      const result = this.extractArray(jsContent, name);
      if (result && Array.isArray(result) && result.length > 0) {
        images = result;
        log('info', `Found image data using variable "${name}"`);
        break;
      }
    }

    // Fallback: generic array search
    if (!images) {
      log('warn', 'Searching for any array containing "url" in JS');
      const arrayMatches = jsContent.match(/\[[\s\S]*?\{[\s\S]*?url[\s\S]*?\}[\s\S]*?\]/g);
      if (arrayMatches) {
        for (const arrStr of arrayMatches) {
          try {
            const parsed = JSON.parse(arrStr);
            if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].url) {
              images = parsed;
              log('info', 'Found image data via generic search');
              break;
            }
          } catch (e) { /* ignore */ }
        }
      }
    }

    if (!images || !images.length) {
      log('error', `No images found. JS snippet: ${jsContent.substring(0, 500)}`);
      throw new Error('No images found in gallery');
    }

    // Step 5: Extract cdns from JS
    let cdns = ['a', 'b', 'c', 'aa', 'ba'];
    const cdnsMatch = jsContent.match(/var\s+cdns\s*=\s*(\[[^\]]*\])/i) || jsContent.match(/cdns\s*=\s*(\[[^\]]*\])/i);
    if (cdnsMatch) {
      try {
        cdns = JSON.parse(cdnsMatch[1]);
        log('info', `Found cdns: ${cdns.join(', ')}`);
      } catch (e) {}
    }

    // Step 6: Get gallery title from HTML
    const titleTag = $('title').text().trim();
    const title = titleTag.replace(/^Hitomi\.la\s*[-–—]\s*/i, '') || `Gallery ${this.galleryId}`;

    // Step 7: Build final info
    const formats = [...new Set(images.map(img => {
      const parts = img.url.split('.');
      return parts.length > 1 ? parts.pop().toLowerCase() : 'jpg';
    }))];

    const info = {
      total: images.length,
      title,
      formats,
      cdns,
      galleryId: this.galleryId,
      images,
    };

    return info;
  }
}

// --------------- Helper: Get gallery info with caching ---------------
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

    const match = url.match(/(\d+)\.html$/);
    if (!match) return res.status(400).json({ error: 'Invalid gallery URL' });
    const galleryId = parseInt(match[1], 10);

    const info = await getGalleryInfo(galleryId);

    // Estimate total size (optional)
    let totalSize = 0;
    const session = antiBlock.createSession();
    const concurrency = 5;
    const queue = [...Array(info.images.length).keys()];
    const fetchHead = async () => {
      while (queue.length) {
        const idx = queue.shift();
        const img = info.images[idx];
        const imgUrl = constructImageUrl(galleryId, img.url, info.cdns);
        try {
          const headRes = await session.head(imgUrl, { timeout: 5000 });
          const len = parseInt(headRes.headers['content-length'], 10);
          if (len) totalSize += len;
        } catch (e) {
          // skip
        }
      }
    };
    const workers = Array(Math.min(concurrency, info.images.length)).fill(0).map(() => fetchHead());
    await Promise.all(workers);
    const sizeEstimate = totalSize ? (totalSize / (1024*1024)).toFixed(2) + ' MB' : 'Unknown';

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
      const ext = img.url.split('.').pop() || 'jpg';
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

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const server = app.listen(PORT, () => {
  log('info', `Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
