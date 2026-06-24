const express = require('express');
const axios = require('axios');
const archiver = require('archiver');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const cors = require('cors');
const crypto = require('crypto');
const { Hitomi, Extension } = require('node-hitomi');
const { Agent } = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- CRITICAL: Bypass Hitomi.la SNI Blocking ---
const agent = new Agent({
    keepAlive: true,
    servername: '',
    rejectUnauthorized: false
});

const hitomi = new Hitomi({
    onRequest: function (context) {
        context.options.agent = agent;
    }
});

const activeDownloads = new Map();

// Extract gallery ID from ANY Hitomi URL (/galleries/, /cg/, /manga/, etc.)
function extractGalleryId(url) {
    const match = url.match(/\/(\d+)\.html/);
    return match ? match[1] : null;
}

// SSE endpoint for real-time progress
app.get('/api/progress/:downloadId', (req, res) => {
    const downloadId = req.params.downloadId;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const interval = setInterval(() => {        const progress = activeDownloads.get(downloadId);
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
    
    if (!url) return res.status(400).json({ error: 'URL is required' });
    
    const galleryId = extractGalleryId(url);
    if (!galleryId) {
        return res.status(400).json({ error: 'Invalid Hitomi.la URL. Must end in numbers.html (e.g., /cg/...12345.html)' });
    }
    
    try {
        const gallery = await hitomi.galleries.retrieve(parseInt(galleryId));
        const images = gallery.getThumbnails();
        
        res.json({
            success: true,
            title: gallery.title.display,
            galleryId: galleryId,
            pageCount: images.length,
            estimatedSizeMB: Math.round(images.length * 1.5),
            imageCount: images.length
        });
        
    } catch (error) {
        console.error('Gallery info error:', error.message);
        res.status(500).json({ error: error.message || 'Failed to fetch gallery', success: false });
    }
});

// Download endpoint
app.get('/api/download/:galleryId', async (req, res) => {
    const galleryId = req.params.galleryId;
    const downloadId = req.query.downloadId || crypto.randomUUID();
    let tempDir = null;
    const cleanup = async () => {
        activeDownloads.delete(downloadId);
        if (tempDir) {
            await fs.remove(tempDir).catch(err => console.error('Cleanup error:', err));
            tempDir = null;
        }
    };

    try {
        activeDownloads.set(downloadId, { 
            status: 'fetching', message: 'Fetching gallery information...', current: 0, total: 0, currentFile: '' 
        });

        const gallery = await hitomi.galleries.retrieve(parseInt(galleryId));
        const images = gallery.getThumbnails();
        const title = gallery.title.display;
        
        activeDownloads.set(downloadId, { 
            status: 'downloading', message: `Starting download of ${images.length} images...`, 
            current: 0, total: images.length, currentFile: '', downloadedMB: 0, totalMB: Math.round(images.length * 1.5) 
        });

        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `hitomi-${galleryId}-`));
        const downloadedImages = [];

        // Download images sequentially
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            
            // node-hitomi handles the complex gg.js URL generation automatically!
            const ext = img.hasWebp ? Extension.Webp : (img.hasJpg ? Extension.Jpg : Extension.Avif);
            const extName = ext === Extension.Webp ? 'webp' : (ext === Extension.Jpg ? 'jpg' : 'avif');
            const fileName = `${String(i + 1).padStart(4, '0')}.${extName}`;
            
            activeDownloads.set(downloadId, { 
                status: 'downloading', message: `Downloading image ${i + 1} of ${images.length}...`, 
                current: i + 1, total: images.length, currentFile: fileName, 
                downloadedMB: Math.round((i / images.length) * (images.length * 1.5)), 
                totalMB: Math.round(images.length * 1.5) 
            });

            try {
                const url = await img.resolveUrl(ext);
                const filePath = path.join(tempDir, fileName);
                
                const response = await axios({
                    url: url,
                    method: 'GET',
                    responseType: 'stream',                    timeout: 30000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': 'https://hitomi.la/'
                    }
                });

                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);
                downloadedImages.push({ path: filePath, name: fileName });

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
                
            } catch (imgError) {
                console.error(`Failed to download ${fileName}:`, imgError.message);
            }
        }

        // Create ZIP archive
        activeDownloads.set(downloadId, { 
            status: 'archiving', message: 'Creating ZIP archive...', current: images.length, total: images.length, 
            currentFile: 'Packaging files...', downloadedMB: Math.round(images.length * 1.5), totalMB: Math.round(images.length * 1.5) 
        });

        const safeTitle = title.replace(/[^a-z0-9]/gi, '_').substring(0, 50).toLowerCase();
        const zipFileName = `${safeTitle}_(${galleryId}).zip`;
        
        const archive = archiver('zip', { zlib: { level: 6 } });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);
        archive.pipe(res);

        for (const img of downloadedImages) {
            if (await fs.pathExists(img.path)) {
                archive.file(img.path, { name: img.name });
            }
        }

        await archive.finalize();
        
        activeDownloads.set(downloadId, { 
            status: 'finished', message: 'Download complete!', current: images.length, total: images.length, 
            currentFile: 'Done!', downloadedMB: Math.round(images.length * 1.5), totalMB: Math.round(images.length * 1.5) 
        });

        res.on('finish', cleanup);
        res.on('close', cleanup);
    } catch (error) {
        console.error('Download error:', error.message);
        activeDownloads.set(downloadId, { status: 'error', message: error.message, current: 0, total: 0, currentFile: '' });
        await cleanup();
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`Hitomi.la Downloader running on http://localhost:${PORT}`));
