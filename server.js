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
const crypto = require('crypto');

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

  // Extract the files array from the JS content using bracket counting
  extractFilesArray(jsContent) {
    const filesStart = jsContent.indexOf('"files":[');
    if (filesStart === -1) {
      const altStart = jsContent.indexOf('files:[');
      if (altStart === -1) return null;
      const bracketStart = altStart + 'files:'.length;
      return this.extractArrayFromPosition(jsContent, bracketStart);
    }
    const bracketStart = filesStart + '"files":'.length;
    return this.extractArrayFromPosition(jsContent, bracketStart);
  }

  extractArrayFromPosition(str, startIdx) {
    let bracketCount = 0;
    let inString = false;
    let escape = false;
    let arrayStart = -1;
    let arrayEnd = -1;

    for (let i = startIdx; i < str.length; i++) {
      const char = str[i];
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
    const arrayStr = str.substring(arrayStart, arrayEnd + 1);
    try {
      const cleaned = arrayStr
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,\s*\]/g, ']');
      return JSON.parse(cleaned);
    } catch (e) {
      log('error', `Failed to parse extracted files array: ${e.message}`);
      return null;
    }
  }

  // --- NEW: Fetch and parse gg.js to get image URL generation parameters ---
  async fetchGgJs(session) {
    const domains = [
      'ltn.gold-usergeneratedcontent.net',
      'ltn.hitomi.la',
    ];
    for (const domain of domains) {
      const url = `https://${domain}/gg.js`;
      try {
        log('info', `Trying gg.js URL: ${url}`);
        const response = await session.get(url, { timeout: 10000 });
        if (response.status === 200) {
          log('info', `✅ Successfully fetched gg.js from ${url}`);
          return response.data;
        }
      } catch (err) {
        // ignore
      }
    }
    throw new Error('Could not fetch gg.js from any domain.');
  }

  parseGgJs(jsContent) {
    // Extract the array from: var GG = [...];
    const match = jsContent.match(/var\s+GG\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) {
      throw new Error('Could not find GG array in gg.js');
    }
    try {
      // Clean up the array string (remove comments, trailing commas)
      const cleaned = match[1]
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,\s*\]/g, ']');
      const ggArray = JSON.parse(cleaned);
      if (!Array.isArray(ggArray) || ggArray.length < 2) {
        throw new Error('GG array is invalid');
      }
      // GG format: [multiplier, index, default_domain?]
      // Based on gallery-dl implementation: https://github.com/mikf/gallery-dl/blob/master/gallery_dl/extractor/hitomi.py
      const multiplier = ggArray[0];
      const index = ggArray[1];
      // The third element is the default domain (optional)
      const defaultDomain = ggArray.length > 2 ? ggArray[2] : null;
      log('info', `Parsed GG: multiplier=${multiplier}, index=${index}, defaultDomain=${defaultDomain}`);
      return { multiplier, index, defaultDomain };
    } catch (e) {
      log('error', `Failed to parse GG array: ${e.message}`);
      throw new Error('Failed to parse gg.js');
    }
  }

  // --- NEW: Generate the correct image URL using the algorithm from gg.js ---
  generateImageUrl(galleryId, image, ggParams) {
    // The algorithm is based on the gallery-dl implementation:
    // https://github.com/mikf/gallery-dl/blob/master/gallery_dl/extractor/hitomi.py
    const { multiplier, index, defaultDomain } = ggParams;
    const hash = image.hash;
    const name = image.name;

    // Calculate the subdomain
    // The hash is a hex string, we need to convert it to a number
    const hashNum = BigInt('0x' + hash);
    // The algorithm: (hashNum / multiplier) % index
    // But we need to handle the division carefully
    const subdomainIndex = Number((hashNum / BigInt(multiplier)) % BigInt(index));
    
    // Map the index to a subdomain letter
    // The subdomains are typically: a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z
    // But we need to map the index to the correct letter
    // Based on gallery-dl: subdomains = "abcdefghijklmnopqrstuvwxyz"
    const subdomains = 'abcdefghijklmnopqrstuvwxyz';
    let subdomain = subdomains[subdomainIndex % subdomains.length] || 'a';
    
    // If there's a default domain, use it instead of the subdomain
    let domain = defaultDomain || `${subdomain}.hitomi.la`;
    
    // Construct the URL
    // Format: https://{subdomain}.hitomi.la/galleries/{galleryId}/{name}
    // Or if defaultDomain is set: https://{defaultDomain}/galleries/{galleryId}/{name}
    const url = `https://${domain}/galleries/${galleryId}/${name}`;
    log('info', `Generated image URL: ${url} (hash: ${hash.substring(0, 8)}..., subdomainIndex: ${subdomainIndex})`);
    return url;
  }

  async fetchGalleryJS(galleryId, session) {
    const domains = [
      'ltn.gold-usergeneratedcontent.net',
      'ltn.hitomi.la',
      'hitomi.la',
    ];
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
        // ignore
      }
    }
    throw new Error('Could not fetch gallery metadata JS from any domain.');
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

    // --- NEW: Fetch and parse gg.js ---
    let ggJs;
    let ggParams;
    try {
      ggJs = await this.fetchGgJs(session);
      ggParams = this.parseGgJs(ggJs);
    } catch (err) {
      log('error', `Failed to fetch/parse gg.js: ${err.message}`);
      throw new Error(`Unable to load gg.js: ${err.message}`);
    }

    // Fetch the gallery JS file
    let jsContent;
    try {
      jsContent = await this.fetchGalleryJS(this.galleryId, session);
    } catch (err) {
      log('error', `Failed to fetch JS: ${err.message}`);
      throw new Error(`Unable to load gallery data: ${err.message}`);
    }

    // Extract files array
    let files = this.extractFilesArray(jsContent);
    if (!files) {
      // Fallback: try parsing the whole galleryinfo object
      try {
        const match = jsContent.match(/var\s+galleryinfo\s*=\s*(\{[\s\S]*?\});/);
        if (match) {
          const cleaned = match[1].replace(/\/\/.*$/gm, '').replace(/,\s*}/g, '}');
          const obj = JSON.parse(cleaned);
          if (obj && obj.files && Array.isArray(obj.files)) {
            files = obj.files;
            log('info', 'Parsed files from full galleryinfo object');
          }
        }
      } catch (e) {
        log('error', `Fallback parsing failed: ${e.message}`);
      }
    }

    if (!files || !files.length) {
      log('error', `No files found. First 500 chars of JS: ${jsContent.substring(0, 500)}`);
      throw new Error('No images found in gallery. The site might have changed its format.');
    }

    // --- NEW: Generate image URLs using gg.js parameters ---
    // We need to store the ggParams in the info so we can use them later for download
    const images = files.map(file => ({
      name: file.name,
      hash: file.hash, // IMPORTANT: we need the hash for URL generation
      width: file.width || 0,
      height: file.height || 0,
      hasavif: file.hasavif || 0,
    }));

    // Title from HTML
    const $ = cheerio.load(html);
    const titleTag = $('title').text().trim();
    let title = titleTag.replace(/^Hitomi\.la\s*[-–—]\s*/i, '');
    if (!title || title === 'Hitomi.la') {
      title = `Gallery ${this.galleryId}`;
    }
    title = title.replace(/\s*[|]\s*Hitomi\.la\s*$/i, '').trim();

    // Available formats
    const formats = [...new Set(images.map(img => img.name.split('.').pop().toLowerCase()))];
    const total = images.length;

    const info = {
      total,
      title,
      formats,
      galleryId: this.galleryId,
      images,
      ggParams, // Store ggParams for later use
    };

    cache.set(cacheKey, info);
    log('info', `Gallery: "${title}" (ID: ${this.galleryId}), ${total} images, formats: ${formats.join(',')}`);
    return info;
  }
}

// Helper: construct image URL using the gg.js algorithm
function constructImageUrl(galleryId, image, ggParams) {
  // Use the gallery's generateImageUrl method
  const gallery = new HitomiGallery(`https://hitomi.la/galleries/${galleryId}.html`);
  // We need to pass the ggParams and the image
  return gallery.generateImageUrl(galleryId, image, ggParams);
}

// --------------- API Routes ---------------
app.post('/api/gallery/info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const gallery = new HitomiGallery(url);
    const info = await gallery.getGalleryInfo();

    // Estimate total size
    const { images, galleryId, ggParams } = info;
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
        // Use the new URL generation
        const url = constructImageUrl(galleryId, img, ggParams);
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
  if (!url || !count) return res.status(400).json({ error: 'URL and count required' });

  try {
    const gallery = new HitomiGallery(url);
    const info = await gallery.getGalleryInfo();
    const downloadCount = Math.min(Math.max(1, parseInt(count, 10)), info.total);
    const { images, galleryId, title, ggParams } = info;

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
      // Use the new URL generation
      const imgUrl = constructImageUrl(galleryId, img, ggParams);
      const ext = img.name.split('.').pop();
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
