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
const vm = require('vm');

// --------------- Configuration ---------------
const PORT = process.env.PORT || 10000;
const CACHE_TTL = 300; // 5 minutes

// Domain configuration - allow overrides via environment variables
const HITOMI_BASE_DOMAIN = process.env.HITOMI_BASE_DOMAIN || 'hitomi.la';
const HITOMI_GG_DOMAINS = process.env.HITOMI_GG_DOMAINS ? process.env.HITOMI_GG_DOMAINS.split(',') : [
  'ltn.gold-usergeneratedcontent.net',
  'ltn.hitomi.la',
  'hitomi.la',
  'a.hitomi.la',
  'b.hitomi.la',
  'c.hitomi.la',
];
const HITOMI_IMAGE_DOMAINS = process.env.HITOMI_IMAGE_DOMAINS ? process.env.HITOMI_IMAGE_DOMAINS.split(',') : [
  'a.hitomi.la', 'b.hitomi.la', 'c.hitomi.la', 'd.hitomi.la', 'e.hitomi.la',
  'f.hitomi.la', 'g.hitomi.la', 'h.hitomi.la', 'i.hitomi.la', 'j.hitomi.la',
  'k.hitomi.la', 'l.hitomi.la', 'm.hitomi.la', 'n.hitomi.la', 'o.hitomi.la',
  'p.hitomi.la', 'q.hitomi.la', 'r.hitomi.la', 's.hitomi.la', 't.hitomi.la',
  'u.hitomi.la', 'v.hitomi.la', 'w.hitomi.la', 'x.hitomi.la', 'y.hitomi.la',
  'z.hitomi.la', 'ltn.hitomi.la'
];

// Proxy support - if set, all requests will go through this proxy
const HTTP_PROXY = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || null;

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
    const config = {
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
    };
    
    // Add proxy if configured
    if (HTTP_PROXY) {
      config.proxy = {
        host: HTTP_PROXY.replace(/^https?:\/\//, '').split(':')[0],
        port: parseInt(HTTP_PROXY.replace(/^https?:\/\//, '').split(':')[1] || '8080', 10),
      };
      log('info', `Using proxy: ${HTTP_PROXY}`);
    }
    
    return axios.create(config);
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

  getBaseUrl() {
    return `https://${HITOMI_BASE_DOMAIN}`;
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

  // --- 核心修复: 重写的 gg.js 解析逻辑 ---
  async fetchAndParseGg(session) {
    // Use configurable domains or defaults
    const domains = HITOMI_GG_DOMAINS;
    let ggContent = null;
    for (const domain of domains) {
      const url = `https://${domain}/gg.js`;
      try {
        log('info', `Trying gg.js URL: ${url}`);
        const response = await session.get(url, { timeout: 10000 });
        if (response.status === 200) {
          log('info', `✅ Successfully fetched gg.js from ${url}`);
          ggContent = response.data;
          break;
        }
      } catch (err) {
        log('warn', `Failed to fetch gg.js from ${domain}: ${err.message}`);
      }
    }
    if (!ggContent) {
      log('warn', 'Could not fetch gg.js from any domain, using fallback values');
      // Return fallback ggData instead of throwing
      return {
        multiplierMap: {},
        defaultDomain: null,
        globalMultiplier: 1,
        globalIndex: 26,
      };
    }

    // Create a sandbox context and execute gg.js
    const sandbox = {
      gg: null,
      GG: null,
      console: {
        log: (...args) => log('info', `[gg.js] ${args.join(' ')}`)
      }
    };
    const context = vm.createContext(sandbox);
    
    try {
      const script = new vm.Script(ggContent);
      script.runInContext(context);
      
      const gg = context.gg;
      const GG = context.GG;
      
      log('info', `Successfully executed gg.js. GG: ${GG ? 'found' : 'not found'}, gg: ${gg ? 'found' : 'not found'}`);
      
      // --- 1. 尝试解析简单的 GG 数组 ---
      if (GG && Array.isArray(GG) && GG.length >= 2) {
        const multiplier = GG[0];
        const index = GG[1];
        const defaultDomain = GG.length > 2 ? GG[2] : null;
        log('info', `Found GG array: multiplier=${multiplier}, index=${index}, defaultDomain=${defaultDomain}`);
        return {
          multiplierMap: {},
          defaultDomain: defaultDomain || null,
          globalMultiplier: multiplier,
          globalIndex: index,
        };
      }
      
      // --- 2. 尝试解析复杂的 gg 对象 ---
      if (gg) {
        // 2.1 首先尝试从 gg.m 函数中提取映射
        if (typeof gg.m === 'function') {
          const funcStr = gg.m.toString();
          log('info', `gg.m function extracted (${funcStr.length} chars)`);
          
          // 提取 switch 语句体
          const switchStart = funcStr.indexOf('switch');
          if (switchStart !== -1) {
            const braceStart = funcStr.indexOf('{', switchStart);
            if (braceStart !== -1) {
              const switchBody = this.extractObject(funcStr, braceStart);
              if (switchBody) {
                log('info', `Extracted switch body (${switchBody.length} chars)`);
                const caseGroups = switchBody.split(/break\s*;/);
                const multiplierMap = {};
                for (const group of caseGroups) {
                  const caseMatches = group.match(/case\s+(\d+)\s*:/g);
                  if (!caseMatches) continue;
                  const oMatch = group.match(/o\s*=\s*(\d+)\s*;/);
                  if (!oMatch) continue;
                  const multiplier = parseInt(oMatch[1], 10);
                  for (const caseMatch of caseMatches) {
                    const caseValue = parseInt(caseMatch.match(/\d+/)[0], 10);
                    multiplierMap[caseValue] = multiplier;
                  }
                }
                if (Object.keys(multiplierMap).length > 0) {
                  log('info', `Parsed ${Object.keys(multiplierMap).length} gallery ID mappings from gg.m`);
                  return {
                    multiplierMap,
                    defaultDomain: null,
                    globalMultiplier: null,
                    globalIndex: null,
                  };
                }
              }
            }
          }
        }

        // 2.2 如果 gg.m 没有提供映射，尝试从 gg 对象的其他属性获取
        //    常见属性: gg.o (multiplier), gg.i (index), gg.d (default domain)
        let globalMultiplier = null;
        let globalIndex = null;
        let defaultDomain = null;

        if (gg.o !== undefined) {
          globalMultiplier = parseInt(gg.o, 10);
          log('info', `Found gg.o as global multiplier: ${globalMultiplier}`);
        }
        if (gg.i !== undefined) {
          globalIndex = parseInt(gg.i, 10);
          log('info', `Found gg.i as global index: ${globalIndex}`);
        }
        if (gg.d !== undefined) {
          defaultDomain = gg.d;
          log('info', `Found gg.d as default domain: ${defaultDomain}`);
        }

        if (globalMultiplier !== null) {
          return {
            multiplierMap: {},
            defaultDomain: defaultDomain || null,
            globalMultiplier: globalMultiplier,
            globalIndex: globalIndex || 26,
          };
        }
      }
      
      // --- 3. 最后的备用方案: 使用正则表达式在源代码中查找 GG 数组 ---
      log('warn', 'Could not extract multiplier from gg.js, trying regex fallback');
      const ggMatch = ggContent.match(/var\s+GG\s*=\s*(\[[\s\S]*?\]);/);
      if (ggMatch) {
        try {
          const cleaned = ggMatch[1].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,\s*\]/g, ']');
          const parsed = JSON.parse(cleaned);
          if (Array.isArray(parsed) && parsed.length >= 2) {
            log('info', `Found GG via regex: ${parsed.join(', ')}`);
            return {
              multiplierMap: {},
              defaultDomain: parsed.length > 2 ? parsed[2] : null,
              globalMultiplier: parsed[0],
              globalIndex: parsed[1],
            };
          }
        } catch (e) { /* ignore */ }
      }
      
      // --- 4. 如果所有方法都失败，抛出一个明确的错误 ---
      throw new Error('Could not find any multiplier in gg.js');
      
    } catch (err) {
      log('error', `Failed to execute gg.js in VM: ${err.message}`);
      throw new Error(`Failed to parse gg.js: ${err.message}`);
    }
  }

  // Helper to extract a balanced object/block from a string
  extractObject(str, startPos) {
    let braceCount = 0;
    let inString = false;
    let escape = false;
    let objStart = -1;
    let objEnd = -1;

    for (let i = startPos; i < str.length; i++) {
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

      if (char === '{' || char === '[' || char === '(') {
        if (braceCount === 0) objStart = i;
        braceCount++;
      } else if (char === '}' || char === ']' || char === ')') {
        braceCount--;
        if (braceCount === 0) {
          objEnd = i;
          break;
        }
      }
    }

    if (objStart === -1 || objEnd === -1) return null;
    return str.substring(objStart, objEnd + 1);
  }

  // --- Generate the correct image URL ---
  generateImageUrl(galleryId, image, ggData) {
    const { multiplierMap, defaultDomain, globalMultiplier, globalIndex } = ggData;
    
    // 获取 multiplier，如果找不到则使用全局值，最后才用备用值 1
    let multiplier = null;
    if (multiplierMap && multiplierMap[parseInt(galleryId, 10)]) {
      multiplier = multiplierMap[parseInt(galleryId, 10)];
    } else if (globalMultiplier !== null && globalMultiplier !== undefined) {
      multiplier = globalMultiplier;
    } else {
      // 如果 multiplier 还是 null，使用备用值 1
      multiplier = 1;
      log('warn', `No multiplier found for gallery ${galleryId}, using fallback ${multiplier}`);
    }
    
    // 确保 multiplier 不为 0，防止除零错误
    if (multiplier === 0) {
      log('warn', `Multiplier is 0 for gallery ${galleryId}, using fallback 1`);
      multiplier = 1;
    }
    
    const hash = image.hash;
    const name = image.name;
    const hashNum = BigInt('0x' + hash);
    const idx = globalIndex || 26;
    
    // 执行计算
    const subdomainIndex = Number((hashNum / BigInt(multiplier)) % BigInt(idx));
    
    // 确定域名
    let domain;
    if (defaultDomain) {
      if (defaultDomain.length <= 3 && /^[a-z]+$/.test(defaultDomain)) {
        domain = `${defaultDomain}.${HITOMI_BASE_DOMAIN}`;
      } else if (defaultDomain.includes('.')) {
        domain = defaultDomain;
      } else {
        domain = `${defaultDomain}.${HITOMI_BASE_DOMAIN}`;
      }
    } else {
      const subdomains = 'abcdefghijklmnopqrstuvwxyz';
      const sub = subdomains[subdomainIndex % subdomains.length];
      domain = `${sub}.${HITOMI_BASE_DOMAIN}`;
    }
    
    const url = `https://${domain}/galleries/${galleryId}/${name}`;
    log('info', `Generated URL: ${url} (multiplier: ${multiplier}, subdomainIndex: ${subdomainIndex})`);
    return url;
  }

  // --- Generate alternative image URLs with fallback domains ---
  generateImageUrls(galleryId, image, ggData) {
    const primaryUrl = this.generateImageUrl(galleryId, image, ggData);
    
    // Use configurable image domains or defaults
    const fallbackDomains = HITOMI_IMAGE_DOMAINS;
    
    // Generate fallback URLs by replacing the domain in the primary URL
    const urls = [primaryUrl];
    const primaryDomain = new URL(primaryUrl).hostname;
    
    for (const fallbackDomain of fallbackDomains) {
      if (fallbackDomain !== primaryDomain) {
        const fallbackUrl = primaryUrl.replace(primaryDomain, fallbackDomain);
        urls.push(fallbackUrl);
      }
    }
    
    return urls;
  }

  async fetchGalleryJS(galleryId, session) {
    // Use configurable domains or defaults
    const domains = HITOMI_GG_DOMAINS;
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
        log('warn', `Failed to fetch JS from ${domain}: ${err.message}`);
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

    // Use configurable base domain for gallery page fetch
    const galleryPageUrl = this.url.replace(/^https?:\/\/[^\/]+/, `https://${HITOMI_BASE_DOMAIN}`);
    log('info', `Fetching gallery page: ${galleryPageUrl}`);
    const session = antiBlock.createSession();
    let html;
    await antiBlock.executeWithRetry(async () => {
      const res = await session.get(galleryPageUrl);
      html = res.data;
    }, `fetch gallery page ${this.galleryId}`);

    // --- 获取并解析 gg.js ---
    let ggData;
    try {
      ggData = await this.fetchAndParseGg(session);
    } catch (err) {
      log('error', `Failed to parse gg.js: ${err.message}`);
      // 使用备用数据，确保 multiplier 为 1 而不是 0
      ggData = {
        multiplierMap: {},
        defaultDomain: null,
        globalMultiplier: 1,
        globalIndex: 26,
      };
      log('warn', 'Using fallback ggData with multiplier 1');
    }

    // 获取画廊 JS 文件
    let jsContent;
    try {
      jsContent = await this.fetchGalleryJS(this.galleryId, session);
    } catch (err) {
      log('error', `Failed to fetch JS: ${err.message}`);
      // Try to fetch from the gallery page HTML as a last resort
      try {
        const $ = cheerio.load(html);
        const scriptTag = $('script').filter((i, el) => {
          const content = $(el).html() || '';
          return content.includes('galleryinfo') || content.includes('"files":');
        }).first();
        
        if (scriptTag.length) {
          const scriptContent = scriptTag.html();
          log('info', 'Found gallery data in HTML script tag, attempting to parse');
          jsContent = scriptContent;
        } else {
          throw new Error(`Unable to load gallery data: ${err.message}`);
        }
      } catch (fallbackErr) {
        throw new Error(`Unable to load gallery data: ${err.message}. ${fallbackErr.message}`);
      }
    }

    // 提取 files 数组
    let files = this.extractFilesArray(jsContent);
    if (!files) {
      // 备用方案：尝试解析整个 galleryinfo 对象
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

    // 存储图片及其 hash 用于 URL 生成
    const images = files.map(file => ({
      name: file.name,
      hash: file.hash,
      width: file.width || 0,
      height: file.height || 0,
      hasavif: file.hasavif || 0,
    }));

    // 从 HTML 中提取标题
    const $ = cheerio.load(html);
    const titleTag = $('title').text().trim();
    let title = titleTag.replace(/^Hitomi\.la\s*[-–—]\s*/i, '');
    if (!title || title === 'Hitomi.la') {
      title = `Gallery ${this.galleryId}`;
    }
    title = title.replace(/\s*[|]\s*Hitomi\.la\s*$/i, '').trim();

    // 可用格式
    const formats = [...new Set(images.map(img => img.name.split('.').pop().toLowerCase()))];
    const total = images.length;

    const info = {
      total,
      title,
      formats,
      galleryId: this.galleryId,
      images,
      ggData,
    };

    cache.set(cacheKey, info);
    log('info', `Gallery: "${title}" (ID: ${this.galleryId}), ${total} images, formats: ${formats.join(',')}`);
    return info;
  }
}

// Helper: construct image URL using the gg.js data
function constructImageUrl(galleryId, image, ggData) {
  const gallery = new HitomiGallery(`https://${HITOMI_BASE_DOMAIN}/galleries/${galleryId}.html`);
  return gallery.generateImageUrl(galleryId, image, ggData);
}

// Helper: construct all possible image URLs (primary + fallbacks)
function constructImageUrls(galleryId, image, ggData) {
  const gallery = new HitomiGallery(`https://${HITOMI_BASE_DOMAIN}/galleries/${galleryId}.html`);
  return gallery.generateImageUrls(galleryId, image, ggData);
}

// --------------- API Routes ---------------
app.post('/api/gallery/info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const gallery = new HitomiGallery(url);
    const info = await gallery.getGalleryInfo();

    // Estimate total size
    const { images, galleryId, ggData } = info;
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
        const urls = constructImageUrls(galleryId, img, ggData);
        let success = false;
        
        for (const url of urls) {
          try {
            await antiBlock.executeWithRetry(async () => {
              const headRes = await session.head(url);
              const len = parseInt(headRes.headers['content-length'], 10);
              if (len) {
                totalSize += len;
                success = true;
              }
            }, `HEAD ${url}`);
            if (success) break;
          } catch (e) {
            log('warn', `HEAD failed for ${url}: ${e.message}`);
          }
        }
        
        if (!success) {
          log('warn', `Skipped size check for image ${idx+1}: all URLs failed`);
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
    const { images, galleryId, title, ggData } = info;

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
      const imgUrls = constructImageUrls(galleryId, img, ggData);
      const ext = img.name.split('.').pop();
      const filename = `${i+1}.${ext}`;

      let success = false;
      let size = 0;
      let imageStream = null;
      let workingUrl = null;

      // Try all URLs until one works
      for (const imgUrl of imgUrls) {
        try {
          // Try HEAD first
          await antiBlock.executeWithRetry(async () => {
            const headRes = await session.head(imgUrl);
            size = parseInt(headRes.headers['content-length'], 10) || 0;
          }, `HEAD ${imgUrl}`);

          // Try GET
          imageStream = await antiBlock.executeWithRetry(async () => {
            const response = await session.get(imgUrl, { responseType: 'stream' });
            return response.data;
          }, `GET ${imgUrl}`);

          workingUrl = imgUrl;
          success = true;
          break;
        } catch (err) {
          log('warn', `Failed to fetch ${imgUrl}: ${err.message}`);
        }
      }

      if (success && imageStream) {
        archive.append(imageStream, { name: filename, store: true, size });
        log('info', `Added ${filename} (${(size/1024).toFixed(1)} KB) from ${workingUrl}`);

        const percent = Math.round(((i+1) / downloadCount) * 100);
        broadcastSSE('progress', { current: i+1, total: downloadCount, percent });
      } else {
        log('error', `Failed to add image ${i+1}: all URLs failed`);
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
