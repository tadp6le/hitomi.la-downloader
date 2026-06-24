let currentGalleryId = null;
let eventSource = null;
let downloadLog = [];

function addLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    downloadLog.push({ timestamp, message, type });
    updateLogDisplay();
}

function updateLogDisplay() {
    const logContent = document.getElementById('logContent');
    logContent.innerHTML = downloadLog.map(entry => `
        <div class="log-entry ${entry.type}">
            <span class="log-timestamp">[${entry.timestamp}]</span>
            ${entry.message}
        </div>
    `).join('');
    logContent.scrollTop = logContent.scrollHeight;
}

async function fetchGalleryInfo() {
    const urlInput = document.getElementById('urlInput');
    const fetchBtn = document.getElementById('fetchBtn');
    const errorDisplay = document.getElementById('errorDisplay');
    const galleryInfo = document.getElementById('galleryInfo');
    const url = urlInput.value.trim();

    if (!url) {
        showError('Please enter a Hitomi.la gallery URL');
        return;
    }

    errorDisplay.style.display = 'none';
    galleryInfo.style.display = 'none';
    document.getElementById('progressSection').style.display = 'none';
    
    fetchBtn.disabled = true;
    fetchBtn.textContent = 'Fetching...';
    fetchBtn.style.backgroundColor = '#666'; // Explicitly change color

    try {
        console.log('Sending request to /api/gallery-info with URL:', url);
        const response = await fetch('/api/gallery-info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        console.log('Response status:', response.status);        const data = await response.json();
        console.log('Response data:', data);

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Failed to fetch gallery information');
        }

        currentGalleryId = data.galleryId;
        
        document.getElementById('galleryTitle').textContent = data.title;
        document.getElementById('galleryId').textContent = data.galleryId;
        document.getElementById('pageCount').textContent = data.pageCount;
        document.getElementById('estimatedSize').textContent = `~${data.estimatedSizeMB} MB`;
        
        galleryInfo.style.display = 'block';
        addLog(`Gallery info fetched: ${data.title}`, 'success');

    } catch (error) {
        console.error('Fetch error:', error);
        // Show error and KEEP IT VISIBLE so you can read it
        showError(error.message || 'An unknown error occurred. Check the browser console (F12) for details.');
    } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = 'Fetch Gallery Info';
        fetchBtn.style.backgroundColor = ''; // Reset color
    }
}

// --- FIX: Error message NO LONGER hides automatically ---
function showError(message) {
    const errorDisplay = document.getElementById('errorDisplay');
    errorDisplay.textContent = message;
    errorDisplay.style.display = 'block';
}

function startDownload() {
    if (!currentGalleryId) {
        showError('No gallery selected');
        return;
    }

    const downloadBtn = document.getElementById('downloadBtn');
    const progressSection = document.getElementById('progressSection');
    const downloadId = Math.random().toString(36).substring(2, 15);

    downloadLog = [];
    progressSection.style.display = 'block';
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Downloading...';
        document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressPercentage').textContent = '0%';
    document.getElementById('statusIndicator').textContent = '⏳ Preparing...';
    document.getElementById('progressText').textContent = 'Initializing download...';
    document.getElementById('currentFile').textContent = '-';
    document.getElementById('downloadedSize').textContent = '0 MB / 0 MB';
    document.getElementById('imageProgress').textContent = '0 / 0 images';

    addLog('Starting download...', 'info');

    eventSource = new EventSource(`/api/progress/${downloadId}`);
    eventSource.onmessage = (event) => updateProgress(JSON.parse(event.data));
    eventSource.onerror = () => eventSource.close();

    fetch(`/api/download/${currentGalleryId}?downloadId=${downloadId}`)
        .then(response => {
            if (!response.ok) throw new Error('Download failed');
            return response.blob();
        })
        .then(blob => {
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `gallery_${currentGalleryId}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            
            addLog('Download complete! File saved.', 'success');
            setTimeout(() => {
                downloadBtn.disabled = false;
                downloadBtn.textContent = '⬇️ Download as ZIP';
                eventSource.close();
            }, 2000);
        })
        .catch(error => {
            console.error('Download error:', error);
            addLog(`Download failed: ${error.message}`, 'error');
            document.getElementById('statusIndicator').textContent = '❌ Error';
            downloadBtn.disabled = false;
            downloadBtn.textContent = '⬇️ Download as ZIP';
            eventSource.close();
        });
}

function updateProgress(data) {
    const statusIndicator = document.getElementById('statusIndicator');
    const progressText = document.getElementById('progressText');
    const progressFill = document.getElementById('progressFill');    const progressPercentage = document.getElementById('progressPercentage');
    const currentFile = document.getElementById('currentFile');
    const downloadedSize = document.getElementById('downloadedSize');
    const imageProgress = document.getElementById('imageProgress');

    switch(data.status) {
        case 'fetching':
            statusIndicator.textContent = '⏳ Fetching...';
            progressText.textContent = data.message;
            addLog(data.message, 'info');
            break;
        case 'downloading':
            statusIndicator.textContent = '⬇️ Downloading...';
            progressText.textContent = data.message;
            if (data.total > 0) {
                const percentage = Math.round((data.current / data.total) * 100);
                progressFill.style.width = `${percentage}%`;
                progressPercentage.textContent = `${percentage}%`;
            }
            if (data.currentFile) {
                currentFile.textContent = data.currentFile;
                addLog(`Downloading: ${data.currentFile}`, 'info');
            }
            if (data.downloadedMB && data.totalMB) {
                downloadedSize.textContent = `${data.downloadedMB} MB / ${data.totalMB} MB`;
            }
            if (data.current && data.total) {
                imageProgress.textContent = `${data.current} / ${data.total} images`;
            }
            break;
        case 'archiving':
            statusIndicator.textContent = '📦 Creating ZIP...';
            progressText.textContent = data.message;
            progressFill.style.width = '100%';
            progressPercentage.textContent = '100%';
            addLog('Creating ZIP archive...', 'info');
            break;
        case 'finished':
            statusIndicator.textContent = '✅ Complete!';
            progressText.textContent = 'Download finished successfully!';
            addLog('Archive created successfully!', 'success');
            break;
        case 'error':
            statusIndicator.textContent = '❌ Error';
            progressText.textContent = data.message;
            addLog(`Error: ${data.message}`, 'error');
            break;
    }
}
document.getElementById('urlInput').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') fetchGalleryInfo();
});
