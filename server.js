const express = require('express');
const axios = require('axios');
const archiver = require('archiver');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const cors = require('cors');
const crypto = require('crypto');

const { default: hitomi, Extension } = require('node-hitomi');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const activeDownloads = new Map();

function extractGalleryId(url) {
    const match = url.match(/(\d+)\.html/);
    return match ? match[1] : null;
}

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

app.post('/api/gallery-info', async (req, res) => {
    const { url } = req.body;    if (!url) return res.status(400).json({ error: 'URL is required' });
    
    const galleryId = extractGalleryId(url);
    if (!galleryId) return res.status(400).json({ error: 'Invalid Hitomi.la URL format.' });
    
    try {
        const gallery = await hitomi.galleries.retrieve(parseInt(galleryId));
        const allFiles = gallery.files || [];
        
        res.json({
            success: true,
            title: gallery.title.display,
            galleryId: galleryId,
            pageCount: allFiles.length,
            estimatedSizeMB: Math.round(allFiles.length * 1.5),
            imageCount: allFiles.length
        });
    } catch (error) {
        console.error('[ERROR] Gallery info failed:', error.message);
        res.status(500).json({ error: error.message, success: false });
    }
});

app.get('/api/download/:galleryId', async (req, res) => {
    const galleryId = req.params.galleryId;
    const downloadId = req.query.downloadId || crypto.randomUUID();
    const limit = parseInt(req.query.limit) || 0;
    
    let tempDir = null;
    let isFinished = false;

    const cleanup = async () => {
        if (isFinished) return;
        isFinished = true;
        activeDownloads.delete(downloadId);
        if (tempDir) {
            await fs.remove(tempDir).catch(err => console.error('Cleanup error:', err));
            tempDir = null;
        }
    };

    // Ensure cleanup happens if connection drops
    req.on('close', cleanup);

    try {
        activeDownloads.set(downloadId, { 
            status: 'fetching', message: 'Fetching gallery information...', current: 0, total: 0, currentFile: '' 
        });

        const gallery = await hitomi.galleries.retrieve(parseInt(galleryId));        const allFiles = gallery.files || [];
        
        if (allFiles.length === 0) throw new Error('No files found in this gallery');
        
        const filesToDownload = limit > 0 ? allFiles.slice(0, Math.min(limit, allFiles.length)) : allFiles;
        const actualLimit = filesToDownload.length;
        
        const title = gallery.title.display;
        
        activeDownloads.set(downloadId, { 
            status: 'downloading', message: `Starting download of ${actualLimit} images...`, 
            current: 0, total: actualLimit, currentFile: '', downloadedMB: 0, totalMB: Math.round(actualLimit * 1.5) 
        });

        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `hitomi-${galleryId}-`));
        const downloadedImages = [];

        for (let i = 0; i < filesToDownload.length; i++) {
            const fileObj = filesToDownload[i];
            const originalName = fileObj.name || `image_${i}.webp`;
            const paddedName = `${String(i + 1).padStart(4, '0')}_${originalName}`;
            
            activeDownloads.set(downloadId, { 
                status: 'downloading', message: `Downloading image ${i + 1} of ${actualLimit}...`, 
                current: i + 1, total: actualLimit, currentFile: originalName, 
                downloadedMB: Math.round((i / actualLimit) * (actualLimit * 1.5)), 
                totalMB: Math.round(actualLimit * 1.5) 
            });

            try {
                const imageUrl = await fileObj.resolveUrl(Extension.Webp);
                if (!imageUrl) continue;
                
                const filePath = path.join(tempDir, paddedName);
                const response = await axios({
                    url: imageUrl, method: 'GET', responseType: 'stream', timeout: 60000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://hitomi.la/'
                    }
                });

                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);
                
                await new Promise((resolve, reject) => {
                    writer.on('finish', () => {
                        downloadedImages.push({ path: filePath, name: paddedName });
                        resolve();
                    });                    writer.on('error', reject);
                });
                
            } catch (imgError) {
                console.error(`Failed to download ${originalName}:`, imgError.message);
            }
        }

        if (downloadedImages.length === 0) {
            throw new Error('No images were successfully downloaded.');
        }

        activeDownloads.set(downloadId, { 
            status: 'archiving', message: `Creating ZIP (Level 0 - Fast)...`, 
            current: actualLimit, total: actualLimit, currentFile: 'Packaging files...', 
            downloadedMB: Math.round(actualLimit * 1.5), totalMB: Math.round(actualLimit * 1.5) 
        });

        const safeTitle = title.replace(/[^a-z0-9]/gi, '_').substring(0, 50).toLowerCase();
        const zipFileName = `${safeTitle}_(${galleryId}).zip`;
        
        // FIX: Level 0 compression prevents RAM crashes on free hosting tiers
        const archive = archiver('zip', { zlib: { level: 0 } });
        
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);
        archive.pipe(res);

        for (const img of downloadedImages) {
            archive.file(img.path, { name: img.name });
        }

        await archive.finalize();
        
        activeDownloads.set(downloadId, { 
            status: 'finished', message: 'Download complete!', current: actualLimit, total: actualLimit, 
            currentFile: `Done! ${downloadedImages.length} images`, 
            downloadedMB: Math.round(actualLimit * 1.5), totalMB: Math.round(actualLimit * 1.5) 
        });

        // Cleanup is handled by req.on('close')

    } catch (error) {
        console.error('[ERROR] Download failed:', error.message);
        activeDownloads.set(downloadId, { 
            status: 'error', message: error.message, 
            current: 0, total: 0, currentFile: '' 
        });
        await cleanup();
        if (!res.headersSent) {            res.status(500).json({ error: error.message });
        }
    }
});

app.listen(PORT, () => console.log(`Hitomi.la Downloader running on http://localhost:${PORT}`));
