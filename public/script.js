let currentGalleryId = null;
let totalPages = 0;
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

    if (!url) return showError('Please enter a Hitomi.la gallery URL');

    errorDisplay.style.display = 'none';
    galleryInfo.style.display = 'none';
    document.getElementById('progressSection').style.display = 'none';
    
    fetchBtn.disabled = true;
    fetchBtn.textContent = 'Fetching...';

    try {
        const response = await fetch('/api/gallery-info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Failed to fetch');

        currentGalleryId = data.galleryId;
        totalPages = data.pageCount;        
        document.getElementById('galleryTitle').textContent = data.title;
        document.getElementById('galleryId').textContent = data.galleryId;
        document.getElementById('pageCount').textContent = data.pageCount;
        document.getElementById('estimatedSize').textContent = `~${data.estimatedSizeMB} MB`;
        
        const limitInput = document.getElementById('imageLimit');
        limitInput.value = totalPages;
        limitInput.max = totalPages;
        
        galleryInfo.style.display = 'block';
        addLog(`Gallery info fetched: ${data.title}`, 'success');

    } catch (error) {
        showError(error.message || 'An unknown error occurred.');
    } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = 'Fetch Gallery Info';
    }
}

document.getElementById('imageLimit').addEventListener('input', function() {
    let limit = parseInt(this.value);
    if (!limit || limit < 1) limit = totalPages;
    if (limit > totalPages) limit = totalPages;
    document.getElementById('estimatedSize').textContent = `~${Math.round(limit * 1.5)} MB`;
});

function showError(message) {
    const errorDisplay = document.getElementById('errorDisplay');
    errorDisplay.textContent = message;
    errorDisplay.style.display = 'block';
}

function startDownload() {
    if (!currentGalleryId) return showError('No gallery selected');

    let limit = parseInt(document.getElementById('imageLimit').value);
    if (!limit || limit < 1) limit = totalPages;
    if (limit > totalPages) limit = totalPages;

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
    document.getElementById('imageProgress').textContent = `0 / ${limit} images`;

    addLog(`Starting download of ${limit} images...`, 'info');

    eventSource = new EventSource(`/api/progress/${downloadId}`);
    eventSource.onmessage = (event) => updateProgress(JSON.parse(event.data));
    eventSource.onerror = () => eventSource.close();

    fetch(`/api/download/${currentGalleryId}?downloadId=${downloadId}&limit=${limit}`)
        .then(async response => {
            // FIX: Get the actual error message from the server if it fails
            if (!response.ok) {
                const errData = await response.json().catch(() => ({ error: 'Unknown server error' }));
                throw new Error(errData.error || `Server error: ${response.status}`);
            }
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
            addLog(`Download failed: ${error.message}`, 'error');
            document.getElementById('statusIndicator').textContent = '❌ Error';
            document.getElementById('progressText').textContent = error.message;
            downloadBtn.disabled = false;
            downloadBtn.textContent = '️ Download as ZIP';
            eventSource.close();
        });
}
function updateProgress(data) {
    const statusIndicator = document.getElementById('statusIndicator');
    const progressText = document.getElementById('progressText');
    const progressFill = document.getElementById('progressFill');
    const progressPercentage = document.getElementById('progressPercentage');
    const currentFile = document.getElementById('currentFile');
    const downloadedSize = document.getElementById('downloadedSize');
    const imageProgress = document.getElementById('imageProgress');

    switch(data.status) {
        case 'fetching':
            statusIndicator.textContent = ' Fetching...';
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
            statusIndicator.textContent = '📦 Compressing (Level 0)...';
            progressText.textContent = data.message;
            progressFill.style.width = '100%';
            progressPercentage.textContent = '100%';
            addLog('Creating ZIP archive (Fast mode)...', 'info');
            break;
        case 'finished':
            statusIndicator.textContent = '✅ Complete!';
            progressText.textContent = 'Download finished successfully!';
            addLog('Archive created successfully!', 'success');
            break;
        case 'error':
            statusIndicator.textContent = '❌ Error';
            progressText.textContent = data.message;
            addLog(`Error: ${data.message}`, 'error');            break;
    }
}

document.getElementById('urlInput').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') fetchGalleryInfo();
});
