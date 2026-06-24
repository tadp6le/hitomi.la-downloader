const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory store for active download states
const activeDownloads = new Map();

// Hitomi.la configuration
const HITOMI_BASE = 'https://hitomi.la';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const axiosInstance = axios.create({
    timeout: 30000,
    headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
    }
});

// Extract gallery ID from URL
function extractGalleryId(url) {
    const match = url.match(/galleries\/(\d+)/);
    return match ? match[1] : null;
}

// Parse gallery page to extract information
async function parseGalleryPage(galleryId) {
    const url = `${HITOMI_BASE}/galleries/${galleryId}.html`;
    
    try {
        const response = await axiosInstance.get(url);
        const $ = cheerio.load(response.data);
        
        // Extract title
        const title = $('h1').text().trim() || `Gallery ${galleryId}`;
                // Extract image count from gallery info
        const infoText = $('body').text();
        const pageMatch = infoText.match(/(\d+)\s*page/i);
        const pageCount = pageMatch ? parseInt(pageMatch[1]) : 0;
        
        // Extract gallery info script to get actual image URLs
        const scripts = $('script');
        let galleryInfo = null;
        
        for (let i = 0; i < scripts.length; i++) {
            const scriptText = $(scripts[i]).html();
            if (scriptText && scriptText.includes('galleryinfo')) {
                const match = scriptText.match(/var\s+galleryinfo\s*=\s*({.*?});/s);
                if (match) {
                    try {
                        galleryInfo = JSON.parse(match[1]);
                        break;
                    } catch (e) {
                        console.error('Failed to parse galleryinfo:', e);
                    }
                }
            }
        }
        
        if (!galleryInfo) {
            throw new Error('Could not extract gallery information from page');
        }
        
        // Get image list
        const images = galleryInfo.files || [];
        const imageUrls = images.map((img, index) => {
            // Hitomi.la image URL pattern
            const hash = galleryInfo.hash || galleryId;
            const webp = img.endsWith('.webp');
            const ext = webp ? 'webp' : (img.endsWith('.avif') ? 'avif' : 'jpg');
            const subdomain = String.fromCharCode(97 + (index % 4)); // a, b, c, d
            const dir = hash.slice(-1);
            
            return {
                url: `https://${subdomain}a.hitomi.la/${webp ? 'webp' : 'images'}/${dir}/${hash}/${img}`,
                filename: `${String(index + 1).padStart(3, '0')}_${img}`,
                originalName: img
            };
        });
        
        return {
            title,
            galleryId,
            pageCount: images.length,
            images: imageUrls,            estimatedSize: images.length * 1.5 // Rough estimate: 1.5MB per image
        };
        
    } catch (error) {
        console.error('Error parsing gallery:', error.message);
        throw error;
    }
}

// SSE endpoint for real-time progress
app.get('/api/progress/:downloadId', (req, res) => {
    const downloadId = req.params.downloadId;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const interval = setInterval(() => {
        const progress = activeDownloads.get(downloadId);
        if (progress) {
            res.write(`data: ${JSON.stringify(progress)}\n\n`);
            if (progress.status === 'finished' || progress.status === 'error') {
                clearInterval(interval);
                setTimeout(() => res.end(), 500);
            }
        } else {
            res.write(`data: ${JSON.stringify({ status: 'waiting', message: 'Waiting...' })}\n\n`);
        }
    }, 200);

    req.on('close', () => clearInterval(interval));
});

// Get gallery info endpoint
app.post('/api/gallery-info', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    const galleryId = extractGalleryId(url);
    if (!galleryId) {
        return res.status(400).json({ error: 'Invalid Hitomi.la URL. Expected format: https://hitomi.la/galleries/123456.html' });
    }
    
    try {
        const info = await parseGalleryPage(galleryId);        
        res.json({
            success: true,
            title: info.title,
            galleryId: info.galleryId,
            pageCount: info.pageCount,
            estimatedSizeMB: Math.round(info.estimatedSize),
            imageCount: info.images.length
        });
        
    } catch (error) {
        console.error('Gallery info error:', error.message);
        res.status(500).json({ 
            error: error.message || 'Failed to fetch gallery information',
            success: false 
        });
    }
});

// Download endpoint
app.get('/api/download/:galleryId', async (req, res) => {
    const galleryId = req.params.galleryId;
    const downloadId = req.query.downloadId || crypto.randomUUID();
    let tempDir = null;
    let downloadedImages = [];

    const cleanup = async () => {
        activeDownloads.delete(downloadId);
        if (tempDir) {
            await fs.remove(tempDir).catch(err => console.error('Cleanup error:', err));
            tempDir = null;
        }
    };

    try {
        // Parse gallery to get image list
        activeDownloads.set(downloadId, { 
            status: 'fetching', 
            message: 'Fetching gallery information...',
            current: 0,
            total: 0,
            currentFile: ''
        });

        const galleryInfo = await parseGalleryPage(galleryId);
        const images = galleryInfo.images;
        
        activeDownloads.set(downloadId, { 
            status: 'downloading', 
            message: `Starting download of ${images.length} images...`,            current: 0,
            total: images.length,
            currentFile: '',
            downloadedMB: 0,
            totalMB: Math.round(galleryInfo.estimatedSize)
        });

        // Create temp directory
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `hitomi-${galleryId}-`));

        // Download images sequentially to avoid rate limiting
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            const fileName = img.filename;
            
            activeDownloads.set(downloadId, { 
                status: 'downloading', 
                message: `Downloading image ${i + 1} of ${images.length}...`,
                current: i + 1,
                total: images.length,
                currentFile: fileName,
                downloadedMB: Math.round((i / images.length) * galleryInfo.estimatedSize),
                totalMB: Math.round(galleryInfo.estimatedSize)
            });

            try {
                const response = await axiosInstance({
                    url: img.url,
                    method: 'GET',
                    responseType: 'stream',
                    timeout: 20000
                });

                const filePath = path.join(tempDir, fileName);
                const writer = fs.createWriteStream(filePath);
                
                downloadedImages.push({
                    path: filePath,
                    name: fileName
                });

                response.data.pipe(writer);
                
                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
                
            } catch (imgError) {
                console.error(`Failed to download ${fileName}:`, imgError.message);                // Continue with next image even if one fails
            }
        }

        // Create ZIP archive
        activeDownloads.set(downloadId, { 
            status: 'archiving', 
            message: 'Creating ZIP archive...',
            current: images.length,
            total: images.length,
            currentFile: 'Packaging files...',
            downloadedMB: Math.round(galleryInfo.estimatedSize),
            totalMB: Math.round(galleryInfo.estimatedSize)
        });

        const zipFileName = `${galleryInfo.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_(${galleryId}).zip`;
        
        const archive = archiver('zip', { zlib: { level: 6 } });
        
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);
        
        archive.pipe(res);

        // Add all downloaded images to archive
        for (const img of downloadedImages) {
            if (await fs.pathExists(img.path)) {
                archive.file(img.path, { name: img.name });
            }
        }

        await archive.finalize();
        
        activeDownloads.set(downloadId, { 
            status: 'finished', 
            message: 'Download complete!',
            current: images.length,
            total: images.length,
            currentFile: 'Done!',
            downloadedMB: Math.round(galleryInfo.estimatedSize),
            totalMB: Math.round(galleryInfo.estimatedSize)
        });

        res.on('finish', cleanup);
        res.on('close', cleanup);

    } catch (error) {
        console.error('Download error:', error.message);
        activeDownloads.set(downloadId, { 
            status: 'error',             message: error.message,
            current: 0,
            total: 0,
            currentFile: ''
        });
        await cleanup();
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

app.listen(PORT, () => {
    console.log(`Hitomi.la Downloader running on http://localhost:${PORT}`);
});
