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
    const { url } = req.body;    console.log('\n[INFO] Received request for URL:', url);
    
    if (!url) return res.status(400).json({ error: 'URL is required' });
    
    const galleryId = extractGalleryId(url);
    if (!galleryId) return res.status(400).json({ error: 'Invalid Hitomi.la URL format.' });
    
    try {
        console.log(`[INFO] Fetching gallery ${galleryId}...`);
        const gallery = await hitomi.galleries.retrieve(parseInt(galleryId));
        const allFiles = gallery.files || [];
        
        console.log(`[SUCCESS] Found ${allFiles.length} files`);
        
        res.json({
            success: true,
            title: gallery.title.display,
            galleryId: galleryId,
            pageCount: allFiles.length,
            estimatedSizeMB: Math.round(allFiles.length * 1.5),
            imageCount: allFiles.length
        });
    } catch (error) {
        console.error('[ERROR] Failed to fetch gallery:', error.message);
        res.status(500).json({ error: error.message || 'Failed to fetch gallery', success: false });
    }
});

app.get('/api/download/:galleryId', async (req, res) => {
    const galleryId = req.params.galleryId;
    const downloadId = req.query.downloadId || crypto.randomUUID();
    const limit = parseInt(req.query.limit) || 0;
    
    console.log(`\n[DOWNLOAD] Request received - Gallery: ${galleryId}, Limit: ${limit}`);
    
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
        console.log(`[DOWNLOAD] Retrieving gallery ${galleryId}...`);
        const gallery = await hitomi.galleries.retrieve(parseInt(galleryId));
        const allFiles = gallery.files || [];
        
        if (allFiles.length === 0) {
            throw new Error('No files found in this gallery');
        }
        
        const filesToDownload = limit > 0 ? allFiles.slice(0, Math.min(limit, allFiles.length)) : allFiles;
        const actualLimit = filesToDownload.length;
        
        console.log(`[DOWNLOAD] Will download ${actualLimit} out of ${allFiles.length} files`);
        
        const title = gallery.title.display;
        
        activeDownloads.set(downloadId, { 
            status: 'downloading', message: `Starting download of ${actualLimit} images...`, 
            current: 0, total: actualLimit, currentFile: '', downloadedMB: 0, totalMB: Math.round(actualLimit * 1.5) 
        });

        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `hitomi-${galleryId}-`));
        const downloadedImages = [];
        let successCount = 0;

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
                console.log(`[DOWNLOAD] ${i + 1}/${actualLimit} - Resolving URL for ${originalName}`);
                const imageUrl = await fileObj.resolveUrl(Extension.Webp);
                
                if (!imageUrl) {
                    console.log(`[WARN] Could not resolve URL for ${originalName}`);
                    continue;
                }
                
                console.log(`[DOWNLOAD] ${i + 1}/${actualLimit} - Downloading from ${imageUrl.substring(0, 50)}...`);
                const filePath = path.join(tempDir, paddedName);
                
                const response = await axios({
                    url: imageUrl,                    method: 'GET',
                    responseType: 'stream',
                    timeout: 60000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': 'https://hitomi.la/'
                    }
                });

                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);
                
                await new Promise((resolve, reject) => {
                    writer.on('finish', () => {
                        downloadedImages.push({ path: filePath, name: paddedName });
                        successCount++;
                        console.log(`[SUCCESS] ${i + 1}/${actualLimit} - ${originalName} downloaded`);
                        resolve();
                    });
                    writer.on('error', (err) => {
                        console.error(`[ERROR] Write failed for ${originalName}:`, err.message);
                        reject(err);
                    });
                });
                
            } catch (imgError) {
                console.error(`[ERROR] Failed to download ${originalName}:`, imgError.message);
                // Continue with next file
            }
        }

        console.log(`[INFO] Download phase complete: ${successCount}/${actualLimit} succeeded`);

        if (downloadedImages.length === 0) {
            throw new Error('No images were successfully downloaded. Check server logs for details.');
        }

        activeDownloads.set(downloadId, { 
            status: 'archiving', message: `Creating ZIP (Level 9 Max Compression)...`, 
            current: actualLimit, total: actualLimit, currentFile: 'Packaging files...', 
            downloadedMB: Math.round(actualLimit * 1.5), totalMB: Math.round(actualLimit * 1.5) 
        });

        const safeTitle = title.replace(/[^a-z0-9]/gi, '_').substring(0, 50).toLowerCase();
        const zipFileName = `${safeTitle}_(${galleryId}).zip`;
        
        console.log(`[ARCHIVE] Creating ZIP: ${zipFileName}`);
        
        const archive = archiver('zip', { zlib: { level: 9 } });
                res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);
        archive.pipe(res);

        let archivedCount = 0;
        for (const img of downloadedImages) {
            const exists = await fs.pathExists(img.path);
            if (exists) {
                archive.file(img.path, { name: img.name });
                archivedCount++;
            }
        }

        console.log(`[ARCHIVE] Added ${archivedCount} files to ZIP`);

        await archive.finalize();
        
        await new Promise((resolve, reject) => {
            res.on('finish', () => {
                console.log('[INFO] ZIP sent successfully');
                resolve();
            });
            res.on('error', reject);
        });
        
        activeDownloads.set(downloadId, { 
            status: 'finished', message: 'Download complete!', current: actualLimit, total: actualLimit, 
            currentFile: `Done! ${successCount}/${actualLimit} images`, 
            downloadedMB: Math.round(actualLimit * 1.5), totalMB: Math.round(actualLimit * 1.5) 
        });

        await cleanup();

    } catch (error) {
        console.error('[ERROR] Download failed:', error.message);
        console.error('[ERROR] Stack:', error.stack);
        activeDownloads.set(downloadId, { 
            status: 'error', message: error.message, 
            current: 0, total: 0, currentFile: '' 
        });
        await cleanup();
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

app.listen(PORT, () => console.log(`Hitomi.la Downloader running on http://localhost:${PORT}`));
