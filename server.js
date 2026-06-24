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
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

// --------------- Configuration ---------------
const PORT = process.env.PORT || 10000;
const MAX_IMAGES = parseInt(process.env.MAX_IMAGES, 10) || 200;
const CONCURRENCY = 1; // Stream sequentially to keep memory low
const CACHE_TTL = 300; // 5 minutes
const IMG_REQUEST_TIMEOUT = 30000;
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
  logEmitter.emit('log', { timestamp: new Date().toISOString(), level, message });
}

// --------------- Express App ---------------
const app = express();

app.use(helmet({ contentSecurityPolicy: false })); // allow inline scripts/styles for demo
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
    const jar = new CookieJar();
    const client = wrapper(axios.create({ jar }));
    client.defaults.timeout = IMG_REQUEST_TIMEOUT;
    client.defaults.maxRedirects = 5;
    client.defaults.headers.common = {
      'User-Agent': this.getRandomUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    };
    return client;
  }
}

const antiBlock = new AntiBlockingManager();

// --------------- Hitomi Gallery Class ---------------
class HitomiGallery {
  constructor(url) {
    this.url = url;
    this.galleryId = this.extractId(url);
    this.baseUrl = 'https://hitomi.la';
  }

  extractId(url) {
    const match = url.match(/(\d+)\.html$/);
    return match ? match[1] : null;
  }

  async getGalleryInfo() {
    if (!this.galleryId) throw new Error('Invalid gallery URL');

    // Check cache first
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
    const scripts = $('script').map((i, el) => $(el).html()).get();

    // Extract galleryinfo array
    let galleryinfo = [];
    for (const script of scripts) {
      const match = script.match(/var\s+galleryinfo\s*=\s*(\[[\s\S]*?\]);/);
      if (match) {
        try {
          galleryinfo = JSON.parse(match[1]);
          break;
        } catch (e) {
          log('error', `Failed to parse galleryinfo JSON: ${e.message}`);
          throw new Error('Failed to parse gallery data');
        }
      }
    }
    if (!galleryinfo.length) throw new Error('No images found in gallery');

    // Extract CDN list (subdomains)
    let cdns = ['a', 'b', 'c', 'aa', 'ba']; // fallback
    for (const script of scripts) {
      const match = script.match(/var\s+cdns\s*=\s*(\[[^\]]*\]);/);
      if (match) {
        try {
          cdns = JSON.parse(match[1]);
          break;
        } catch (e) {}
      }
    }

    // Title from <title>
    const titleTag = $('title').text().trim();
    const title = titleTag.replace('Hitomi.la - ', '') || `Gallery ${this.galleryId}`;

    const formats = [...new Set(galleryinfo.map(img => img.url.split('.').pop().toLowerCase()))];
    const total = galleryinfo.length;

    const info = { total, title, formats, cdns, galleryId: this.galleryId };
    cache.set(cacheKey, info);
    log('info', `Gallery info: "${title}" (ID: ${this.galleryId}), ${total} images, formats: ${formats.join(',')}`);
    return info;
  }

  async estimateSize(info, count) {
    const { cdns, galleryId } = info;
    const total = Math.min(count, info.total);
    const sizes = [];
    log('info', `Estimating size for ${total} images...`);

    const session = antiBlock.createSession();
    let completed = 0;

    // Use limited concurrency for HEAD requests
    const queue = Array.from({ length: total }, (_, i) => i);
    const concurrency = 5;
    const promises = [];
    const process = async () => {
      while (queue.length) {
        const idx = queue.shift();
        const subdomain = cdns[Math.floor(Math.random() * cdns.length)];
        const ext = info.formats[0]; // we'll guess based on first format, but actual per image will be determined later
        // We need actual file name from galleryinfo to get correct URL.
        // But we don't have galleryinfo here. We'll store galleryinfo in cache as well.
        // For size estimation we need the actual image filenames, so we'll pass galleryinfo from getGalleryInfo.
        // I'll extend getGalleryInfo to also return the image list or we fetch it again.
        // Let's store galleryinfo in cache along with info.
        // Modify cache: store { info, images } where images is galleryinfo array.
      }
    };

    // Since we need galleryinfo for file names, let's fetch it again or store it. I'll store it.
    // I'll update getGalleryInfo to also return images array.
  }

  // I'll restructure: getGalleryInfo returns { ...info, images: galleryinfo }
      }
