const express = require('express');
const axios = require('axios');
const archiver = require('archiver');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const cors = require('cors');
const crypto = require('crypto');

// Correct import for node-hitomi
const { default: hitomi, Extension } = require('node-hitomi');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const activeDownloads = new Map();

// FIX: Extract ID from ANY Hitomi URL format (/galleries/, /cg/, /imageset/, etc.)
function extractGalleryId(url) {
    // Matches the digits right before .html, regardless of the text before it
    const match = url.match(/(\d+)\.html/);
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
    req.on('close', () => clearInterval(interval));});

// Get gallery info endpoint
app.post('/api/gallery-info', async (req, res) => {
    const { url } = req.body;
    console.log('\n[INFO] Received request for URL:', url);
    
    if (!url) return res.status(400).json({ error: 'URL is required' });
    
    const galleryId = extractGalleryId(url);
    if (!galleryId) {
        console.log('[ERROR] Invalid URL format');
        return res.status(400).json({ error: 'Invalid Hitomi.la URL format.' });
    }
    
    try {
        console.log(`[INFO] Fetching gallery ${galleryId}...`);
        const gallery = await hitomi.galleries.retrieve(parseInt(galleryId));
        
        // FIX: Use gallery.files to get ALL images (not getThumbnails which only returns 2!)
        const allFiles = gallery.files || [];
        console.log(`[INFO] Total files found: ${allFiles.length}`);
        
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
        }    };

    try {
        activeDownloads.set(downloadId, { 
            status: 'fetching', message: 'Fetching gallery information...', current: 0, total: 0, currentFile: '' 
        });

        console.log(`\n[DOWNLOAD] Starting download for gallery ${galleryId}`);
        const gallery = await hitomi.galleries.retrieve(parseInt(galleryId));
        
        // FIX: Get ALL files from the gallery
        const allFiles = gallery.files || [];
        
        if (allFiles.length === 0) {
            throw new Error('No files found in this gallery');
        }
        
        console.log(`[INFO] Found ${allFiles.length} files to download`);
        
        const title = gallery.title.display;
        
        activeDownloads.set(downloadId, { 
            status: 'downloading', message: `Starting download of ${allFiles.length} images...`, 
            current: 0, total: allFiles.length, currentFile: '', downloadedMB: 0, totalMB: Math.round(allFiles.length * 1.5) 
        });

        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `hitomi-${galleryId}-`));
        const downloadedImages = [];
        let successCount = 0;
        let failCount = 0;

        // Download ALL files
        for (let i = 0; i < allFiles.length; i++) {
            const fileObj = allFiles[i]; // This is an Image object!
            
            // Get the original filename from the object
            const originalName = fileObj.name || `image_${i}.webp`;
            
            // Create a padded filename to ensure correct sorting in the ZIP
            const paddedName = `${String(i + 1).padStart(4, '0')}_${originalName}`;
            
            activeDownloads.set(downloadId, { 
                status: 'downloading', message: `Downloading image ${i + 1} of ${allFiles.length}...`, 
                current: i + 1, total: allFiles.length, currentFile: originalName, 
                downloadedMB: Math.round((i / allFiles.length) * (allFiles.length * 1.5)), 
                totalMB: Math.round(allFiles.length * 1.5) 
            });

            try {
                // FIX: Use the Image object's resolveUrl method to get the correct URL                // Hitomi.la serves everything as WebP or AVIF now. We request WebP.
                const imageUrl = await fileObj.resolveUrl(Extension.Webp);
                
                if (!imageUrl) {
                    console.log(`[WARN] Could not resolve URL for ${originalName}`);
                    failCount++;
                    continue;
                }
                
                console.log(`[DOWNLOAD] ${i + 1}/${allFiles.length} - ${originalName}`);
                const filePath = path.join(tempDir, paddedName);
                
                const response = await axios({
                    url: imageUrl,
                    method: 'GET',
                    responseType: 'stream',
                    timeout: 60000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': 'https://hitomi.la/'
                    }
                });

                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);
                downloadedImages.push({ path: filePath, name: paddedName });

                await new Promise((resolve, reject) => {
                    writer.on('finish', () => {
                        successCount++;
                        resolve();
                    });
                    writer.on('error', reject);
                });
                
            } catch (imgError) {
                console.error(`[ERROR] Failed to download ${originalName}:`, imgError.message);
                failCount++;
            }
        }

        console.log(`[INFO] Download complete: ${successCount} succeeded, ${failCount} failed`);

        if (downloadedImages.length === 0) {
            throw new Error('No images were successfully downloaded');
        }

        // Create ZIP archive
        activeDownloads.set(downloadId, { 
            status: 'archiving', message: `Creating ZIP with ${downloadedImages.length} images...`,             current: allFiles.length, total: allFiles.length, 
            currentFile: 'Packaging files...', 
            downloadedMB: Math.round(allFiles.length * 1.5), 
            totalMB: Math.round(allFiles.length * 1.5) 
        });

        const safeTitle = title.replace(/[^a-z0-9]/gi, '_').substring(0, 50).toLowerCase();
        const zipFileName = `${safeTitle}_(${galleryId}).zip`;
        
        console.log(`[INFO] Creating ZIP: ${zipFileName}`);
        
        const archive = archiver('zip', { zlib: { level: 6 } });
        
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

        console.log(`[INFO] Archived ${archivedCount} files`);

        await archive.finalize();
        
        // Wait for the ZIP to finish streaming to the user
        await new Promise((resolve) => {
            res.on('finish', resolve);
        });
        
        activeDownloads.set(downloadId, { 
            status: 'finished', message: 'Download complete!', 
            current: allFiles.length, total: allFiles.length, 
            currentFile: `Done! ${successCount}/${allFiles.length} images`, 
            downloadedMB: Math.round(allFiles.length * 1.5), 
            totalMB: Math.round(allFiles.length * 1.5) 
        });

        console.log('[INFO] ZIP sent successfully');
        await cleanup();

    } catch (error) {
        console.error('[ERROR] Download failed:', error.message);
        activeDownloads.set(downloadId, {             status: 'error', message: error.message, 
            current: 0, total: 0, currentFile: '' 
        });
        await cleanup();
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

app.listen(PORT, () => console.log(`Hitomi.la Downloader running on http://localhost:${PORT}`));
