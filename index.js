const APP_VERSION = 'v2.5';
const GITHUB_REPO = 'RingoCaviar/CainFlow';

/**
 * CainFlow — Node-based AI Image Generation Tool
 * Canvas, nodes, connections, execution engine, localStorage persistence
 */

// ===== Utility =====
function generateId() {
    return 'n_' + Math.random().toString(36).substr(2, 9);
}

function showToast(message, type = 'info', duration = 3000) {
    const container = elements.toastContainer;
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: '✓', error: '✗', info: 'ℹ', warning: '⚠' };
    toast.innerHTML = `<span>${icons[type] || ''}</span> ${message}`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'toast-out 0.3s ease-out forwards';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function getProxyHeaders(url, method = 'POST') {
    const headers = { 
        'Content-Type': 'application/json', 
        'x-target-url': url,
        'x-target-method': method
    };
    if (state.proxy) {
        headers['x-proxy-enabled'] = state.proxy.enabled ? 'true' : 'false';
        headers['x-proxy-host'] = state.proxy.ip || '127.0.0.1';
        headers['x-proxy-port'] = state.proxy.port || '7890';
    }
    return headers;
}

/**
 * Check for updates from GitHub
 * Throttled to once every 6 hours
 */
async function checkUpdate(isManual = false) {
    if (isManual) {
        showToast('正在检查更新...', 'info');
        localStorage.setItem('cainflow_update_status', 'checking');
        renderGeneralSettings();
    }

    const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    const now = Date.now();
    const lastCheck = localStorage.getItem('cainflow_last_update_check');

    // Skip auto-check if too soon, but ALWAYS allow manual check
    if (!isManual && lastCheck && (now - parseInt(lastCheck)) < CHECK_INTERVAL) {
        return; 
    }

    localStorage.setItem('cainflow_last_update_check', now.toString());

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

        const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
        const fetchOptions = {
            method: 'POST',
            headers: getProxyHeaders(url, 'GET'),
            signal: controller.signal
        };

        const response = await fetch('/proxy', fetchOptions);
        clearTimeout(timeoutId);

        if (!response.ok) {
            localStorage.setItem('cainflow_update_status', 'error');
            if (isManual) {
                showToast('无法连接到更新服务器 (GitHub API 响应异常)', 'error');
                renderGeneralSettings();
            }
            return;
        }
        
        const data = await response.json();
        const latestVersion = data.tag_name; 
        const comparison = compareVersions(latestVersion, APP_VERSION);
        
        if (comparison > 0) {
            localStorage.setItem('cainflow_update_status', 'new_version');
            localStorage.setItem('cainflow_update_version', latestVersion);
            showUpdateModal(data);
        } else {
            localStorage.setItem('cainflow_update_status', 'latest');
            if (isManual) showToast(`当前已是最新版本 (${APP_VERSION})`, 'success');
        }
        if (isManual) renderGeneralSettings();
    } catch (e) {
        console.warn('Update check failed:', e);
        localStorage.setItem('cainflow_update_status', 'error');
        if (isManual) {
            const msg = e.name === 'AbortError' ? '检查更新超时，请稍后重试' : '检查更新失败，请检查网络连接或代理设置';
            showToast(msg, 'error');
            renderGeneralSettings();
        }
    }
}

function compareVersions(v1, v2) {
    const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
    const a = parse(v1);
    const b = parse(v2);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const numA = a[i] || 0;
        const numB = b[i] || 0;
        if (numA > numB) return 1;
        if (numA < numB) return -1;
    }
    return 0;
}

function showUpdateModal(releaseData) {
    const modal = document.getElementById('modal-update');
    const tag = document.getElementById('update-tag');
    const date = document.getElementById('update-date');
    const changelog = document.getElementById('update-changelog-content');
    const settingsBtn = document.getElementById('btn-settings');

    if (tag) tag.textContent = releaseData.tag_name;
    if (date) date.textContent = new Date(releaseData.published_at).toLocaleDateString();
    
    // Simple Markdown-ish to HTML conversion for the changelog
    if (changelog) {
        let body = releaseData.body || '无更新日志详情';
        body = body.replace(/### (.*)/g, '<h4>$1</h4>')
                   .replace(/\n- (.*)/g, '\n<li>$1</li>')
                   .replace(/<li>(.*)<\/li>/g, '<ul><li>$1</li></ul>')
                   .replace(/<\/ul>\n<ul>/g, '') // Merge lists
                   .replace(/\n/g, '<br>');
        changelog.innerHTML = body;
    }

    // Add red dot to settings button
    if (settingsBtn) settingsBtn.classList.add('has-update');

    // Show modal
    modal.classList.add('active');
    
    // Setup listeners for the update modal buttons
    const btnDownload = document.getElementById('btn-update-download');
    const btnBackup = document.getElementById('btn-update-backup');
    
    if (btnDownload) {
        btnDownload.onclick = () => {
            window.open(releaseData.html_url, '_blank');
        };
    }
    
    if (btnBackup) {
        btnBackup.onclick = () => {
            exportWorkflow();
            showToast('备份已导出，您可以放心更新', 'success');
        };
    }
}

function adjustTextareaHeight(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    const height = textarea.scrollHeight;
    textarea.style.height = (height + 2) + 'px';

    // If the textarea is inside a node, we might need to sync connections
    // because the node might have grown.
    if (typeof updateAllConnections === 'function') {
        updateAllConnections();
    }
}

// Get resolution display text from data URL
function getImageResolution(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(`${img.naturalWidth} × ${img.naturalHeight}`);
        img.onerror = () => resolve('');
        img.src = dataUrl;
    });
}

/**
 * Auto-resize image if total pixels exceed maxTotalPixels
 * Preserves aspect ratio.
 */
function processImageResolution(dataUrl, maxTotalPixels = null) {
    if (maxTotalPixels === null) maxTotalPixels = state.imageMaxPixels || 2048 * 2048;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const w = img.naturalWidth;
            const h = img.naturalHeight;
            const currentPixels = w * h;

            if (currentPixels <= maxTotalPixels) {
                resolve({ data: dataUrl, resized: false, originalRes: `${w}x${h}` });
                return;
            }

            // Calculate scaling factor S = sqrt(TargetPixels / CurrentPixels)
            const scale = Math.sqrt(maxTotalPixels / currentPixels);
            const newW = Math.floor(w * scale);
            const newH = Math.floor(h * scale);

            const canvas = document.createElement('canvas');
            canvas.width = newW;
            canvas.height = newH;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, newW, newH);

            // Output as PNG to maintain maximum quality for generation nodes
            const resizedData = canvas.toDataURL('image/png');
            resolve({
                data: resizedData,
                resized: true,
                originalRes: `${w}x${h}`,
                newRes: `${newW}x${newH}`
            });
        };
        img.onerror = () => resolve({ data: dataUrl, resized: false });
        img.src = dataUrl;
    });
}

// Convert dataURL to Blob properly
function dataURLtoBlob(dataUrl) {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const bstr = atob(parts[1]);
    const u8arr = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
    return new Blob([u8arr], { type: mime });
}

function sanitizeDetails(details) {
    if (!details) return null;
    if (typeof details === 'string') {
        if (details.startsWith('data:image/') && details.length > 500) return '[图片数据已隐藏以优化性能]';
        return details.length > 2000 ? details.substring(0, 2000) + '... [已截断]' : details;
    }
    if (typeof details === 'object') {
        try {
            const copy = JSON.parse(JSON.stringify(details));
            const traverse = (obj) => {
                for (const key in obj) {
                    if (typeof obj[key] === 'string' && obj[key].length > 500) {
                        if (obj[key].startsWith('data:image/')) obj[key] = '[图片数据已隐藏]';
                        else obj[key] = obj[key].substring(0, 500) + '... [已截断]';
                    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                        traverse(obj[key]);
                    }
                }
            };
            traverse(copy);
            return JSON.stringify(copy, null, 2);
        } catch (e) { return '[无法序列化的详细信息]'; }
    }
    return details;
}

function addLog(type, title, message, details = null) {
    const log = {
        id: 'log_' + Date.now() + Math.random().toString(36).substr(2, 5),
        time: new Date().toLocaleTimeString(),
        type, // 'success' | 'error' | 'info' | 'warning'
        title,
        message,
        details: sanitizeDetails(details)
    };
    state.logs.unshift(log);
    if (state.logs.length > 50) state.logs.pop();
    renderLogs();

    if (type === 'error' && !state.autoRetry) {
        showErrorModal(title, message, log.details);
    } else if (type === 'error' && state.autoRetry) {
        //静默重试模式下，为日志按钮增加提示，告知有新的背景错误
        const logBtn = elements.btnLogs;
        if (logBtn) logBtn.classList.add('has-new-error');
    }
}

function renderLogs() {
    const list = elements.logList;
    if (!list) return;
    if (state.logs.length === 0) {
        list.innerHTML = '<div class="log-empty">暂无执行记录</div>';
        return;
    }

    const typeLabels = {
        success: '成功',
        error: '错误',
        warning: '警告',
        info: '信息'
    };

    list.innerHTML = state.logs.map(log => `
        <div class="log-item ${log.type}" onclick="showLogDetail('${log.id}')" title="点击查看详情">
            <div class="log-item-main">
                <span class="log-type-tag">${typeLabels[log.type] || '日志'}</span>
                <span class="log-summary-text">${log.title}</span>
            </div>
            <span class="log-time-hint">${log.time}</span>
        </div>
    `).join('');
}

function showLogDetail(id) {
    const log = state.logs.find(l => l.id === id);
    if (!log) return;
    showErrorModal(log.title, log.message, log.details, log.type === 'error' ? '执行错误' : '执行详情');
}

function showErrorModal(title, msg, detail, modalTitle = '执行错误') {
    document.getElementById('error-modal-title').textContent = modalTitle;
    document.getElementById('error-modal-msg').textContent = msg;
    document.getElementById('error-modal-detail').textContent = detail || '无详细信息';
    document.getElementById('modal-error').classList.add('active');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

// ===== IndexedDB for Handle Persistence =====
const DB_NAME = 'NodeFlowDB';
const DB_VERSION = 4;
const STORE_HANDLES = 'handles';
const STORE_ASSETS = 'imageAssets';
const STORE_HISTORY = 'imageHistory';

let _dbInstance = null;
async function openDB() {
    if (_dbInstance) return _dbInstance;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
            if (!db.objectStoreNames.contains(STORE_ASSETS)) db.createObjectStore(STORE_ASSETS);
            if (!db.objectStoreNames.contains(STORE_HISTORY)) db.createObjectStore(STORE_HISTORY, { keyPath: 'id', autoIncrement: true });
        };
        req.onsuccess = () => {
            _dbInstance = req.result;
            resolve(_dbInstance);
        };
        req.onerror = () => reject(req.error);
    });
}

async function saveHandle(key, handle) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_HANDLES, 'readwrite');
        tx.objectStore(STORE_HANDLES).put(handle, key);
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.warn('IDB save handle failed:', e); }
}

async function getHandle(key) {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const req = db.transaction(STORE_HANDLES).objectStore(STORE_HANDLES).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    } catch (e) { return null; }
}

async function saveImageAsset(nodeId, dataUrl) {
    if (!dataUrl || dataUrl.length < 100) return;
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_ASSETS, 'readwrite');
        tx.objectStore(STORE_ASSETS).put(dataUrl, nodeId);
        // Invalidate cache since we don't know if we overwrote or added
        state.cacheSizes[STORE_ASSETS] = null;
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.warn('IDB save asset failed:', e); }
}

async function getImageAsset(nodeId) {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const req = db.transaction(STORE_ASSETS).objectStore(STORE_ASSETS).get(nodeId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    } catch (e) { return null; }
}

async function deleteImageAsset(nodeId) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_ASSETS, 'readwrite');
        tx.objectStore(STORE_ASSETS).delete(nodeId);
        state.cacheSizes[STORE_ASSETS] = null; 
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { return false; }
}

function createThumbnail(dataUrl, size = 256) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');

            // Calculate center crop to avoid stretching
            let sx = 0, sy = 0, sw = img.width, sh = img.height;
            if (sw > sh) {
                sx = (sw - sh) / 2;
                sw = sh;
            } else if (sh > sw) {
                sy = (sh - sw) / 2;
                sh = sw;
            }

            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
            resolve(canvas.toDataURL('image/webp', 0.8));
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

async function saveHistoryEntry(data) {
    try {
        const thumb = await createThumbnail(data.image, 256);
        const entry = { ...data, thumb, timestamp: Date.now() };
        const db = await openDB();
        const tx = db.transaction(STORE_HISTORY, 'readwrite');
        tx.objectStore(STORE_HISTORY).add(entry);
        
        // Incremental update if cache exists
        if (state.cacheSizes[STORE_HISTORY] !== null && state.cacheSizes[STORE_HISTORY] !== undefined) {
            const sizeBytes = JSON.stringify(entry).length;
            state.cacheSizes[STORE_HISTORY] += (sizeBytes / (1024 * 1024));
        }
        
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.warn('IDB save history failed:', e); }
}

async function getHistory() {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const req = db.transaction(STORE_HISTORY).objectStore(STORE_HISTORY).getAll();
            req.onsuccess = () => resolve(req.result.sort((a, b) => b.timestamp - a.timestamp));
            req.onerror = () => resolve([]);
        });
    } catch (e) { return []; }
}

async function clearHistory() {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_HISTORY, 'readwrite');
        tx.objectStore(STORE_HISTORY).clear();
        state.cacheSizes[STORE_HISTORY] = 0;
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.warn('IDB clear history failed:', e); }
}

async function deleteHistoryEntry(id) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_HISTORY, 'readwrite');
        tx.objectStore(STORE_HISTORY).delete(id);
        state.cacheSizes[STORE_HISTORY] = null; // Invalidate
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.warn('IDB delete history failed:', e); }
}

function applyHistoryGridCols(cols) {
    if (cols < 2) cols = 2;
    if (cols > 5) cols = 5;
    state.historyGridCols = cols;
    const sidebar = document.getElementById('history-sidebar');
    const label = document.getElementById('history-grid-cols-label');
    if (sidebar) sidebar.style.setProperty('--history-grid-cols', cols);
    if (label) label.textContent = cols;
}

async function renderHistoryList() {
    const list = document.getElementById('history-list');
    const items = await getHistory();
    if (!items.length) {
        list.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding: 40px 0; font-size:13px;">暂无历史记录</div>';
        return;
    }

    // Performance Optimization: Limit rendering to first 100 items to avoid DOM lag
    const displayItems = items.slice(0, 100);
    const hasMore = items.length > 100;

    let html = displayItems.map(item => {
        const isSelected = state.selectedHistoryIds.has(item.id);
        const modeClass = state.historySelectionMode ? 'multi-select-mode' : '';
        const selectedClass = isSelected ? 'selected' : '';

        // Background Migration: Generate thumb if missing
        if (!item.thumb && item.image) {
            setTimeout(async () => {
                const thumb = await createThumbnail(item.image);
                const db = await openDB();
                const tx = db.transaction(STORE_HISTORY, 'readwrite');
                const store = tx.objectStore(STORE_HISTORY);
                const fullItem = { ...item, thumb };
                store.put(fullItem); // update with thumbnail
            }, 0);
        }

        return `
            <div class="history-card ${modeClass} ${selectedClass}" data-id="${item.id}">
                <img src="${item.thumb || item.image}" loading="lazy" decoding="async" />
                <div class="selection-checkbox"></div>
                <button class="delete-btn" data-id="${item.id}" title="删除记录">×</button>
            </div>
        `;
    }).join('');

    if (hasMore) {
        html += `<div style="grid-column: 1/-1; color:var(--text-dim); text-align:center; padding: 20px; font-size:12px;">已显示最近 100 条记录 (共 ${items.length} 条)</div>`;
    }

    list.innerHTML = html;

    const countEl = document.getElementById('selected-count');
    if (countEl) countEl.textContent = state.selectedHistoryIds.size;

    // Selection Count Update
    document.getElementById('selected-count').textContent = state.selectedHistoryIds.size;

    list.querySelectorAll('.history-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-btn')) return;
            const itemId = Number(card.dataset.id);
            const item = items.find(i => i.id == itemId);

            if (state.historySelectionMode) {
                if (state.selectedHistoryIds.has(itemId)) state.selectedHistoryIds.delete(itemId);
                else state.selectedHistoryIds.add(itemId);
                renderHistoryList();
            } else {
                if (item) openHistoryPreview(item);
            }
        });
    });
    list.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm('确定要删除这条历史记录吗？')) {
                await deleteHistoryEntry(Number(btn.dataset.id));
                renderHistoryList();
            }
        });
    });
}

// Centralized DOM Element Cache
const elements = {
    canvasContainer: document.getElementById('canvas-container'),
    nodesLayer: document.getElementById('nodes-layer'),
    connectionsGroup: document.getElementById('connections-group'),
    tempConnection: document.getElementById('temp-connection'),
    originAxes: document.getElementById('origin-axes'),
    contextMenu: document.getElementById('context-menu'),
    toastContainer: document.getElementById('toast-container'),
    logList: document.getElementById('log-list'),
    historyList: document.getElementById('history-list'),
    workflowList: document.getElementById('workflow-list'),
    zoomLevel: document.getElementById('zoom-level'),
    btnLogs: document.getElementById('btn-logs'),
    errorModal: {
        root: document.getElementById('modal-error'),
        title: document.getElementById('error-modal-title'),
        msg: document.getElementById('error-modal-msg'),
        detail: document.getElementById('error-modal-detail')
    }
};

const { canvasContainer, nodesLayer, connectionsGroup, tempConnection, originAxes, contextMenu } = elements;

// ===== App State =====
const state = {
    nodes: new Map(),
    connections: [],
    canvas: { x: 0, y: 0, zoom: 1, isPanning: false, panStart: { x: 0, y: 0 }, canvasStart: { x: 0, y: 0 } },
    dragging: null,
    connecting: null,
    resizing: null,
    marquee: null,
    contextMenu: { x: 0, y: 0 },
    isRunning: false,
    notificationsEnabled: false,
    autoRetry: false,
    maxRetries: 15,
    clipboard: null,
    clipboardTimestamp: 0,
    lastFocusTime: Date.now(),
    mouseCanvas: { x: 0, y: 0 },
    selectedNodes: new Set(),
    historySelectionMode: false,
    selectedHistoryIds: new Set(),
    providers: [
        { id: 'prov_gxp', name: 'GXP', type: 'google', apikey: '', endpoint: 'https://www.6789api.top/', autoComplete: true }
    ],
    models: [
        { id: 'model_banana_v2', name: '生图-Banana 2', modelId: 'gemini-3.1-flash-image-preview', providerId: 'prov_gxp' },
        { id: 'model_banana_v1', name: '生图-Banana Pro', modelId: 'gemini-3-pro-image-preview', providerId: 'prov_gxp' },
        { id: 'model_chat_3_flash', name: '对话-gemini-3-flash-preview', modelId: 'gemini-3-flash-preview', providerId: 'prov_gxp' }
    ],
    logs: [],
    globalSaveDirHandle: null,
    justDragged: false,
    isInteracting: false,
    zoomTimer: null,
    abortController: null,
    imageMaxPixels: 2048 * 2048, // Default to 4MP
    isMouseOverCanvas: false,
    notificationVolume: 1.0,
    notificationAudio: null,
    proxy: null, // UI level explicit proxy config. If null, we'll try to fetch auto-detect
    historyGridCols: 2,
    cacheSizes: {}, // Maps storeName to MB (number)
    undoStack: [],
    isSpacePressed: false
};

// Directory handles for Save nodes (not serializable)
const dirHandles = new Map();

const STORAGE_KEY = 'nodeflow_ai_state';

// ===== Canvas System =====
function updateCanvasTransform() {
    const { x, y, zoom } = state.canvas;
    // Use translate3d to force a more robust rendering context during scale changes
    nodesLayer.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${zoom})`;
    nodesLayer.style.transformOrigin = '0 0';
    // Sync zoom level to CSS for resolution-independent borders
    nodesLayer.style.setProperty('--canvas-zoom', zoom);

    const gridSize = 20 * zoom;
    canvasContainer.style.backgroundSize = `${gridSize}px ${gridSize}px`;
    canvasContainer.style.backgroundPosition = `${x}px ${y}px`;
    document.getElementById('zoom-level').textContent = `${Math.round(zoom * 100)}%`;
    updateAllConnections();
}

function screenToCanvas(sx, sy) {
    const rect = canvasContainer.getBoundingClientRect();
    const { x, y, zoom } = state.canvas;
    return { x: (sx - rect.left - x) / zoom, y: (sy - rect.top - y) / zoom };
}

// Pan & Selection & Focus Management
canvasContainer.addEventListener('mousedown', (e) => {
    // Stage 1: Absolute Focus Sovereignty
    // Canvas MUST be focused to receive the 'paste' event reliably
    canvasContainer.focus();

    // Focus & Selection Management: Handle background clicking
    if (e.target === canvasContainer || e.target === nodesLayer || e.target.id === 'connections-layer') {
        // Blur active elements to commit changes
        if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
            document.activeElement.blur();
        }
        // Clear highlighted text ranges (blue selection)
        window.getSelection()?.removeAllRanges();
    }

    // Canvas Logic: Panning vs Selection
    // Pan: Middle button (1) OR Alt + Left Click (0) OR Space + Left Click (0)
    const isPanAction = e.button === 1 || (e.button === 0 && (e.altKey || state.isSpacePressed));
    // Marquee: Left click (0) on background, ONLY if not panning
    const isMarqueeAction = e.button === 0 && e.target === canvasContainer && !isPanAction;

    if (isPanAction) {
        e.preventDefault();
        state.canvas.isPanning = true;
        state.canvas.panStart = { x: e.clientX, y: e.clientY };
        state.canvas.canvasStart = { x: state.canvas.x, y: state.canvas.y };
        canvasContainer.classList.add('grabbing');
        document.body.classList.add('is-interacting');
        document.getElementById('connections-group').classList.add('is-panning');
        return;
    }

    if (isMarqueeAction) {
        // Toggle selection logic: Clear if not holding CTRL/SHIFT
        const isToggle = e.ctrlKey || e.metaKey || e.shiftKey;
        if (!isToggle) {
            state.selectedNodes.forEach(nid => {
                const n = state.nodes.get(nid); if (n) n.el.classList.remove('selected');
            });
            state.selectedNodes.clear();
            updateAllConnections();
        }

        e.preventDefault();
        state.marquee = {
            startX: e.clientX, startY: e.clientY,
            endX: e.clientX, endY: e.clientY,
            initialSelection: new Set(state.selectedNodes)
        };
        const box = document.getElementById('selection-box');
        box.style.left = e.clientX + 'px';
        box.style.top = e.clientY + 'px';
        box.style.width = '0px';
        box.style.height = '0px';
        box.classList.remove('hidden');
    }
});

let rafUpdate = null;
function scheduleUIUpdate() {
    if (rafUpdate) return;
    rafUpdate = requestAnimationFrame(() => {
        updateAllConnections();
        rafUpdate = null;
    });
}

window.addEventListener('mousemove', (e) => {
    // Track mouse in canvas coords for paste
    state.mouseCanvas = screenToCanvas(e.clientX, e.clientY);
    if (state.canvas.isPanning) {
        state.canvas.x = state.canvas.canvasStart.x + (e.clientX - state.canvas.panStart.x);
        state.canvas.y = state.canvas.canvasStart.y + (e.clientY - state.canvas.panStart.y);
        updateCanvasTransform();
    }
    if (state.marquee) {
        state.marquee.endX = e.clientX;
        state.marquee.endY = e.clientY;
        const box = document.getElementById('selection-box');
        const x = Math.min(state.marquee.startX, state.marquee.endX);
        const y = Math.min(state.marquee.startY, state.marquee.endY);
        const w = Math.abs(state.marquee.startX - state.marquee.endX);
        const h = Math.abs(state.marquee.startY - state.marquee.endY);
        box.style.left = x + 'px';
        box.style.top = y + 'px';
        box.style.width = w + 'px';
        box.style.height = h + 'px';

        // Real-time marquee selection
        const mX1 = Math.min(state.marquee.startX, state.marquee.endX);
        const mX2 = Math.max(state.marquee.startX, state.marquee.endX);
        const mY1 = Math.min(state.marquee.startY, state.marquee.endY);
        const mY2 = Math.max(state.marquee.startY, state.marquee.endY);

        state.nodes.forEach((node, id) => {
            const nRect = node.el.getBoundingClientRect();
            if (mX1 < nRect.right && mX2 > nRect.left && mY1 < nRect.bottom && mY2 > nRect.top) {
                if (!state.selectedNodes.has(id)) {
                    state.selectedNodes.add(id);
                    node.el.classList.add('selected');
                }
            } else if (!state.marquee.initialSelection.has(id)) {
                if (state.selectedNodes.has(id)) {
                    state.selectedNodes.delete(id);
                    node.el.classList.remove('selected');
                }
            }
        });
        updateAllConnections();
    }
    if (state.dragging) {
        // Alt+drag clone: on first move with alt held, clone the node
        if (state.dragging.altClone && !state.dragging.cloned) {
            state.dragging.cloned = true;
            const origNode = state.nodes.get(state.dragging.origNodeId);
            if (origNode) {
                const data = serializeOneNode(state.dragging.origNodeId);
                data.id = null; // force new ID
                const newId = addNode(origNode.type, origNode.x, origNode.y, data);
                // Now drag the NEW node, leave original in place
                state.dragging.nodeId = newId;
                selectNode(newId);
            }
        }
        const pos = screenToCanvas(e.clientX, e.clientY);
        const dx = pos.x - state.dragging.startX;
        const dy = pos.y - state.dragging.startY;

        for (const nodeId of state.dragging.nodes) {
            const node = state.nodes.get(nodeId);
            if (node) {
                const startPos = state.dragging.startPositions.get(nodeId);
                node.x = startPos.x + dx;
                node.y = startPos.y + dy;
                node.el.style.left = node.x + 'px';
                node.el.style.top = node.y + 'px';
            }
        }
        scheduleUIUpdate();
    }
    if (state.resizing) {
        const r = state.resizing;
        const zoom = state.canvas.zoom;
        const dx = (e.clientX - r.startX) / zoom;
        const dy = (e.clientY - r.startY) / zoom;
        const node = state.nodes.get(r.nodeId);
        if (node) {
            // High-Performance Flux Resizing: Use pre-calculated minimums to eliminate lag
            const targetW = r.startWidth + dx;
            const targetH = r.startHeight + dy;

            const newW = Math.max(targetW, r.minWidth);
            const newH = Math.max(targetH, r.minHeight);
            node.el.style.width = newW + 'px';
            node.el.style.height = newH + 'px';

            // Remove max-height caps on body during resize so containers can expand
            const body = node.el.querySelector('.node-body');
            if (body) body.style.maxHeight = 'none';

            // Remove max-height caps on containers so they fill the space
            node.el.querySelectorAll('.preview-container, .save-preview-container, .file-drop-zone, .chat-response-area, .text-display-box').forEach(c => {
                c.style.maxHeight = 'none';
            });

            // Sync wires in real-time
            updateAllConnections();
        }
    }
    if (state.connecting) {
        const rect = canvasContainer.getBoundingClientRect();
        const { x, y, zoom } = state.canvas;
        const dx = e.clientX - state.connecting.screenX;
        const dy = e.clientY - state.connecting.screenY;
        if (Math.sqrt(dx * dx + dy * dy) > 5) state.connecting.dragged = true;

        drawTempConnection(state.connecting.startX, state.connecting.startY,
            (e.clientX - rect.left - x) / zoom, (e.clientY - rect.top - y) / zoom);
    }
});

window.addEventListener('mouseup', (e) => {
    document.body.classList.remove('is-interacting');
    document.getElementById('connections-group').classList.remove('is-interacting');
    if (state.canvas.isPanning) {
        const dx = Math.abs(e.clientX - state.canvas.panStart.x);
        const dy = Math.abs(e.clientY - state.canvas.panStart.y);
        if (dx > 3 || dy > 3) {
            state.justDragged = true;
            setTimeout(() => { state.justDragged = false; }, 100);
        }
        state.canvas.isPanning = false;
        canvasContainer.classList.remove('grabbing');
    }
    if (state.marquee) {
        // Run one final overlap check using the last mouse coordinate to catch fast drag drop-offs
        state.marquee.endX = e.clientX;
        state.marquee.endY = e.clientY;
        const mX1 = Math.min(state.marquee.startX, state.marquee.endX);
        const mX2 = Math.max(state.marquee.startX, state.marquee.endX);
        const mY1 = Math.min(state.marquee.startY, state.marquee.endY);
        const mY2 = Math.max(state.marquee.startY, state.marquee.endY);

        state.nodes.forEach((node, id) => {
            const nRect = node.el.getBoundingClientRect();
            if (mX1 < nRect.right && mX2 > nRect.left && mY1 < nRect.bottom && mY2 > nRect.top) {
                if (!state.selectedNodes.has(id)) {
                    state.selectedNodes.add(id);
                    node.el.classList.add('selected');
                }
            } else if (!state.marquee.initialSelection.has(id)) {
                if (state.selectedNodes.has(id)) {
                    state.selectedNodes.delete(id);
                    node.el.classList.remove('selected');
                }
            }
        });

        const dw = Math.abs(state.marquee.startX - e.clientX);
        const dh = Math.abs(state.marquee.startY - e.clientY);
        if (dw > 5 || dh > 5) {
            state.justDragged = true;
            setTimeout(() => { state.justDragged = false; }, 100);
        }

        document.getElementById('selection-box').classList.add('hidden');
        state.marquee = null;
    }
    if (state.dragging) {
        const pos = screenToCanvas(e.clientX, e.clientY);
        if (Math.abs(pos.x - state.dragging.startX) > 2 || Math.abs(pos.y - state.dragging.startY) > 2) {
            state.justDragged = true;
            setTimeout(() => { state.justDragged = false; }, 100);
        }
        for (const nodeId of state.dragging.nodes) {
            const n = state.nodes.get(nodeId);
            if (n) n.el.classList.remove('is-interacting');
        }
        state.dragging = null;
        updateAllConnections();
        scheduleSave();
    }
    if (state.resizing) {
        const r = state.resizing;
        const node = state.nodes.get(r.nodeId);
        if (node) {
            // Finalize dimensions from the lived-rendered style
            node.width = parseInt(node.el.style.width);
            node.height = parseInt(node.el.style.height);

            node.el.classList.remove('is-interacting');
            scheduleUIUpdate();
        }
        state.resizing = null;
        scheduleSave();
    }
    if (state.connecting) {
        // If the user was dragging (moved more than 5px), we clear on mouseup.
        // If they just clicked (minimal movement), we KEEP the connection active for the second click.
        if (state.connecting.dragged) {
            tempConnection.setAttribute('d', '');
            state.connecting = null;
        } else if (e.target.closest('#canvas-container') && !e.target.closest('.port-dot')) {
            // Clicked on empty canvas space: cancel connection
            tempConnection.setAttribute('d', '');
            state.connecting = null;
        }
    }
});

canvasContainer.addEventListener('mouseenter', () => { state.isMouseOverCanvas = true; });
canvasContainer.addEventListener('mouseleave', () => { state.isMouseOverCanvas = false; });

function selectAllNodes() {
    state.nodes.forEach((node, id) => {
        state.selectedNodes.add(id);
        node.el.classList.add('selected');
    });
    updateAllConnections();
}

canvasContainer.addEventListener('wheel', (e) => {
    e.preventDefault();

    // Add interaction class to disable heavy blurs during zoom
    if (!state.isInteracting) {
        state.isInteracting = true;
        document.body.classList.add('is-interacting');
        document.getElementById('connections-group').classList.add('is-interacting');
    }

    // Reset timer to remove interaction class
    clearTimeout(state.zoomTimer);
    state.zoomTimer = setTimeout(() => {
        // Step 1: Ensure final transform is applied while interaction state is still active (no blurs)
        // This ensures the browser rasterizes the text sharply at the final scale
        updateCanvasTransform();

        requestAnimationFrame(() => {
            // Step 2: Direct nudge to force a compositor refresh if needed
            // Slightly nudge the layer and update connections to wake up the renderer
            updateCanvasTransform();

            requestAnimationFrame(() => {
                // Step 3: Now that text is sharp, restore the backdrop filters and transitions
                state.isInteracting = false;
                document.body.classList.remove('is-interacting');
                document.getElementById('connections-group').classList.remove('is-interacting');

                // Final sync to ensure everything is perfectly aligned with the restored layout
                updateCanvasTransform();
            });
        });
    }, 250); // Slightly more delay to allow the browser to finish its layout work

    const rect = canvasContainer.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const oldZoom = state.canvas.zoom;
    const newZoom = Math.max(0.1, Math.min(5, oldZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    state.canvas.x = mx - (mx - state.canvas.x) * (newZoom / oldZoom);
    state.canvas.y = my - (my - state.canvas.y) * (newZoom / oldZoom);
    state.canvas.zoom = newZoom;

    // Use RAF for the intermediate zoom transforms to maintain frame alignment
    if (!state._zoomRaf) {
        state._zoomRaf = requestAnimationFrame(() => {
            updateCanvasTransform();
            state._zoomRaf = null;
        });
    }
}, { passive: false });

// ===== Context Menu =====
canvasContainer.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    state.contextMenu = { x: e.clientX, y: e.clientY };

    const nodeEl = e.target.closest('.node');
    const nodeActions = document.getElementById('context-menu-node-actions');
    
    if (nodeEl) {
        state.contextMenuNodeId = nodeEl.id;
        if (nodeActions) nodeActions.style.display = 'block';
        if (!state.selectedNodes.has(nodeEl.id)) {
            state.selectedNodes.forEach(nid => {
                const n = state.nodes.get(nid); if (n) n.el.classList.remove('selected');
            });
            state.selectedNodes.clear();
            state.selectedNodes.add(nodeEl.id);
            nodeEl.classList.add('selected');
        }
    } else {
        state.contextMenuNodeId = null;
        if (nodeActions) nodeActions.style.display = 'none';
    }

    contextMenu.style.left = e.clientX + 'px';
    contextMenu.style.top = e.clientY + 'px';
    contextMenu.classList.remove('hidden');
});
document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) contextMenu.classList.add('hidden');
    // If clicked on canvas background, we usually clear selection.
    // Optimization: Skip clearing if we just finished a drag or selection box (state.justDragged)
    if (e.target.id === 'canvas-container' && !state.justDragged) {
        state.selectedNodes.forEach(nid => {
            const n = state.nodes.get(nid); if (n) n.el.classList.remove('selected');
        });
        state.selectedNodes.clear();
        updateAllConnections();
    }
});
document.querySelectorAll('.context-menu-item').forEach(item => {
    item.addEventListener('click', () => {
        if (item.id === 'context-menu-run-to-here') {
            if (state.contextMenuNodeId) {
                runWorkflow(state.contextMenuNodeId);
            }
        } else if (item.dataset.type) {
            const pos = screenToCanvas(state.contextMenu.x, state.contextMenu.y);
            addNode(item.dataset.type, pos.x, pos.y);
        }
        contextMenu.classList.add('hidden');
    });
});

// ===== Node Configs =====
const NODE_CONFIGS = {
    ImageImport: {
        title: '图片导入', cssClass: 'node-import',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
        inputs: [], outputs: [{ name: 'image', type: 'image', label: '图片输出' }],
        defaultWidth: 240
    },
    ImageGenerate: {
        title: '图片生成 (Gemini)', cssClass: 'node-generate',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
        inputs: [
            { name: 'prompt', type: 'text', label: '提示词输入' },
            { name: 'image_1', type: 'image', label: '参考图 1' },
            { name: 'image_2', type: 'image', label: '参考图 2' },
            { name: 'image_3', type: 'image', label: '参考图 3' },
            { name: 'image_4', type: 'image', label: '参考图 4' },
            { name: 'image_5', type: 'image', label: '参考图 5' }
        ],
        outputs: [{ name: 'image', type: 'image', label: '图片输出' }]
    },
    TextChat: {
        title: '智能对话', cssClass: 'node-chat',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        inputs: [
            { name: 'prompt', type: 'text', label: '提问输入' },
            { name: 'image_1', type: 'image', label: '参考图 1' },
            { name: 'image_2', type: 'image', label: '参考图 2' },
            { name: 'image_3', type: 'image', label: '参考图 3' },
            { name: 'image_4', type: 'image', label: '参考图 4' },
            { name: 'image_5', type: 'image', label: '参考图 5' }
        ],
        outputs: [{ name: 'text', type: 'text', label: '回复文本' }],
        defaultWidth: 380, defaultHeight: 720
    },
    TextInput: {
        title: '文本输入', cssClass: 'node-text-in',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
        inputs: [], outputs: [{ name: 'text', type: 'text', label: '文本输出' }],
        defaultWidth: 260, defaultHeight: 180
    },
    TextDisplay: {
        title: '文本显示', cssClass: 'node-text-out',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
        inputs: [{ name: 'text', type: 'text', label: '文本输入' }], outputs: [],
        defaultWidth: 260, defaultHeight: 180
    },
    ImagePreview: {
        title: '图片预览', cssClass: 'node-preview',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
        inputs: [{ name: 'image', type: 'image', label: '图片输入' }], outputs: [],
        defaultWidth: 240, defaultHeight: 300
    },
    ImageSave: {
        title: '图片保存', cssClass: 'node-save',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        inputs: [{ name: 'image', type: 'image', label: '图片输入' }], outputs: [],
        defaultWidth: 240
    }
};

/**
 * Automatically adjusts node height to fit its internal content without overlap.
 * This is called when dynamic elements (like error messages or AI responses) are added.
 */
function fitNodeToContent(nodeId) {
    const node = state.nodes.get(nodeId);
    if (!node || !node.el) return;

    const el = node.el;
    const body = el.querySelector('.node-body');
    if (!body) return;

    // Temporarily allow content to expand naturally to measure the required height
    const originalHeight = el.style.height;
    const originalBodyMaxHeight = body.style.maxHeight;

    el.style.height = 'auto'; // Change to auto for measurement
    body.style.maxHeight = 'none';

    const requiredHeight = el.offsetHeight;

    // Restore original or update if necessary
    // We only grow the node, we don't shrink it automatically to respect manual sizing
    const currentPx = parseFloat(originalHeight) || el.offsetHeight;

    if (requiredHeight > currentPx + 2) { // 2px margin for sub-pixel differences
        el.style.height = requiredHeight + 'px';
        // Ensure state is updated so it persists
        node.height = requiredHeight;
        updateAllConnections();
        scheduleSave();
    } else {
        el.style.height = originalHeight;
    }
    body.style.maxHeight = originalBodyMaxHeight;
}

// ===== Node Creation =====
function addNode(type, x, y, restoreData, silent = false) {
    if (!silent) pushHistory();
    const config = NODE_CONFIGS[type];
    if (!config) return;
    const id = (restoreData && restoreData.id) ? restoreData.id : generateId();
    const el = document.createElement('div');
    el.className = `node ${config.cssClass}`;
    el.id = id;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (restoreData && restoreData.width) el.style.width = restoreData.width + 'px';
    else if (config.defaultWidth) el.style.width = config.defaultWidth + 'px';

    if (restoreData && restoreData.height) el.style.height = restoreData.height + 'px';
    else if (config.defaultHeight) el.style.height = config.defaultHeight + 'px';

    let html = `
        <div class="node-glass-bg"></div>
        <div class="node-header">
            <div class="header-left">
                ${config.icon}
                <span class="node-title">${config.title}</span>
            </div>
            <div class="header-right">
                <span class="node-time-badge" id="${id}-time-container" style="display:none">
                    <div class="heartbeat-dot" id="${id}-heartbeat" title="连接正常"></div>
                    <span id="${id}-time"></span>
                </span>
                <button class="node-bypass-btn" data-node-id="${id}" title="启用/禁用节点">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
                </button>
                <button class="node-delete" data-node-id="${id}" title="删除节点">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        </div>
        <div class="node-resize-handle" data-node-id="${id}"></div>
        <div class="node-body">
    `;

    // Input ports
    if (config.inputs.length > 0) {
        html += '<div class="node-inputs-section">';
        for (const port of config.inputs) {
            html += `<div class="node-port input" data-node-id="${id}" data-port="${port.name}" data-type="${port.type}" data-direction="input">
                <div class="port-dot type-${port.type}"></div>
                <span class="port-label">${port.label}</span>
            </div>`;
        }
        html += '</div>';
    }

    // Node body content
    if (type === 'ImageImport') {
        html += `
            <div class="file-drop-zone" id="${id}-drop">
                <div class="drop-text">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    拖拽图片到此处
                </div>
            </div>
            <div class="image-resolution-badge" id="${id}-res" style="display:none"></div>
            <button class="select-file-btn" id="${id}-select-btn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                选择文件
            </button>
            <input type="file" accept="image/*" id="${id}-file" style="display:none" />
        `;
    } else if (type === 'ImageGenerate' || type === 'TextChat') {
        const rd = restoreData || {};

        let opts = state.models.map(c => `<option value="${c.id}" ${rd.apiConfigId === c.id ? 'selected' : ''}>${c.name}</option>`).join('');

        html += `<div class="node-field"><label>API 配置</label><select id="${id}-apiconfig">${opts}</select></div>`;

        if (type === 'ImageGenerate') {
            html += `
                <div class="node-field"><label>宽高比</label>
                    <select id="${id}-aspect">
                        <option value="" ${(!rd.aspect) ? 'selected' : ''}>自动</option>
                    <option value="1:1" ${rd.aspect === '1:1' ? 'selected' : ''}>1:1 正方形</option>
                    <option value="16:9" ${rd.aspect === '16:9' ? 'selected' : ''}>16:9 横屏</option>
                    <option value="9:16" ${rd.aspect === '9:16' ? 'selected' : ''}>9:16 竖屏</option>
                    <option value="4:3" ${rd.aspect === '4:3' ? 'selected' : ''}>4:3 标准</option>
                    <option value="3:4" ${rd.aspect === '3:4' ? 'selected' : ''}>3:4 竖版</option>
                    <option value="3:2" ${rd.aspect === '3:2' ? 'selected' : ''}>3:2 经典</option>
                    <option value="2:3" ${rd.aspect === '2:3' ? 'selected' : ''}>2:3 竖版经典</option>
                    <option value="21:9" ${rd.aspect === '21:9' ? 'selected' : ''}>21:9 超宽</option>
                </select></div>
            <div class="node-field"><label>分辨率</label>
                <select id="${id}-resolution">
                    <option value="" ${(!rd.resolution) ? 'selected' : ''}>默认 (1K)</option>
                    <option value="2K" ${rd.resolution === '2K' ? 'selected' : ''}>2K</option>
                    <option value="4K" ${rd.resolution === '4K' ? 'selected' : ''}>4K</option>
                </select></div>
            <div class="node-field node-field-row"><label>启用搜索</label>
                <label class="toggle-switch"><input type="checkbox" id="${id}-search" ${rd.search ? 'checked' : ''} /><span class="toggle-slider"></span></label></div>
            <div class="node-field node-field-expand"><label>提示词</label>
                <textarea id="${id}-prompt" placeholder="描述你想生成的图片..." rows="3">${rd.prompt || ''}</textarea></div>
            <div class="image-resolution-badge" id="${id}-res" style="display:none"></div>
            <div class="node-error-msg" id="${id}-error"></div>
        `;
        } else if (type === 'TextChat') {
            html += `
            <div class="node-field"><label>系统提示词 (可选)</label>
                <textarea id="${id}-sysprompt" placeholder="设定AI的角色或背景..." rows="2">${rd.sysprompt || ''}</textarea></div>
            <div class="node-field node-field-row"><label>启用搜索</label>
                <label class="toggle-switch"><input type="checkbox" id="${id}-search" ${rd.search ? 'checked' : ''} /><span class="toggle-slider"></span></label></div>
            <div class="node-field node-field-row"><label>固定结果</label>
                <label class="toggle-switch"><input type="checkbox" id="${id}-fixed" ${rd.fixed ? 'checked' : ''} /><span class="toggle-slider"></span></label></div>
            <div class="node-field"><label>提问内容</label>
                <textarea id="${id}-prompt" placeholder="输入你的问题..." rows="3">${rd.prompt || ''}</textarea></div>
            <div class="node-field node-field-expand"><label>对话回复</label>
                <div class="chat-response-wrapper" id="${id}-wrapper">
                    <button class="chat-copy-btn" id="${id}-copy-btn" title="复制回复内容">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                    <div class="chat-response-area" id="${id}-response">${rd.lastResponse ? rd.lastResponse : '<div class="chat-response-placeholder">运行后显示对话结果</div>'}</div>
                </div>
            </div>
        `;
        }
    } else if (type === 'ImagePreview') {
        html += `
            <div class="preview-container" id="${id}-preview">
                <div class="preview-placeholder">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                    运行后预览图片
                </div>
            </div>
            <div class="image-resolution-badge" id="${id}-res" style="display:none"></div>
            <div class="preview-controls" id="${id}-controls" style="display:none">
                <button class="preview-ctrl-btn" id="${id}-zoom-in" title="放大"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>
                <button class="preview-ctrl-btn" id="${id}-zoom-out" title="缩小"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>
                <button class="preview-ctrl-btn" id="${id}-zoom-reset" title="重置"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button>
                <button class="preview-ctrl-btn" id="${id}-fullscreen" title="全屏预览"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>
            </div>
        `;
    } else if (type === 'TextInput') {
        const rd = restoreData || {};
        html += `
            <div class="node-field node-field-expand">
                <textarea id="${id}-text" placeholder="输入你想传递的文本提示词..." rows="6">${rd.text || ''}</textarea>
            </div>
        `;
    } else if (type === 'TextDisplay') {
        html += `
            <div class="node-field node-field-expand">
                <div class="text-display-box" id="${id}-display">等待输入文本...</div>
            </div>
        `;
    } else if (type === 'ImageSave') {
        const rd = restoreData || {};
        const showWarning = !state.globalSaveDirHandle;
        html += `
            <div class="save-no-path-warning" id="${id}-path-warning" style="color:#ef4444; font-size:11px; margin-bottom:10px; display:${showWarning ? 'block' : 'none'}; font-weight:500;">
                ⚠️ 未设置全局保存目录，图片无法自动落盘
            </div>
            <div class="save-preview-container" id="${id}-save-preview">
                <div class="save-preview-placeholder">运行后显示图片</div>
            </div>
            <div class="image-resolution-badge" id="${id}-res" style="display:none"></div>
            <div class="node-field"><label>文件名前缀/文件名</label>
                <input type="text" id="${id}-filename" value="${rd.filename || 'generated_image'}" placeholder="不填默认生成" /></div>
            <div class="save-btn-group">
                <button class="save-btn-secondary" id="${id}-view-full" disabled>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    查看图片
                </button>
                <button class="save-btn" id="${id}-manual-save" disabled>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    保存
                </button>
            </div>
        `;
    }

    // Output ports
    if (config.outputs.length > 0) {
        html += '<div class="node-outputs-section">';
        for (const port of config.outputs) {
            html += `<div class="node-port output" data-node-id="${id}" data-port="${port.name}" data-type="${port.type}" data-direction="output">
                <span class="port-label">${port.label}</span>
                <div class="port-dot type-${port.type}"></div>
            </div>`;
        }
        html += '</div>';
    }

    html += '</div>';
    el.innerHTML = html;
    nodesLayer.appendChild(el);

    // If the node has explicit dimensions from restore/resize, remove max-height caps
    // so flex containers fill the saved space properly
    if (restoreData && restoreData.height) {
        el.querySelectorAll('.preview-container, .save-preview-container, .file-drop-zone').forEach(c => {
            c.style.maxHeight = 'none';
        });
    }

    const nodeData = {
        id, type, x, y, el, data: {}, imageData: null, previewZoom: 1,
        width: restoreData?.width || config.defaultWidth || null, height: restoreData?.height || config.defaultHeight || null,
        dirHandle: null, enabled: restoreData?.enabled !== false,
        isSucceeded: restoreData?.isSucceeded || false,
        lastDuration: restoreData?.lastDuration || null,
        lastResponse: restoreData?.lastResponse || ''
    };
    if (nodeData.lastDuration) {
        const timeBadge = el.querySelector(`#${id}-time`);
        const timeContainer = el.querySelector(`#${id}-time-container`);
        if (timeBadge && timeContainer) {
            timeBadge.textContent = `${nodeData.lastDuration}s`;
            timeContainer.style.display = 'flex';
        }
    }
    if (restoreData?.lastText) {
        nodeData.data.text = restoreData.lastText;
    }
    if (nodeData.isSucceeded) el.classList.add('completed');
    if (!nodeData.enabled) el.classList.add('disabled');
    state.nodes.set(id, nodeData);

    // Restore imageData
    if (type === 'ImageImport' || type === 'ImagePreview' || type === 'ImageSave') {
        (async () => {
            // Safety: Check if node still exists after async await
            const hasInitialData = !!(restoreData && restoreData.imageData);
            let data = hasInitialData ? restoreData.imageData : await getImageAsset(id);
            
            if (!state.nodes.has(id)) return;
            
            if (data) {
                nodeData.imageData = data;
                nodeData.data.image = data; // For preview/save
                
                // If this is a new node bootstrapped with serialized image data (Paste/Clone),
                // we must save it to IndexedDB for the new ID to ensure persistence.
                if (hasInitialData) {
                    await saveImageAsset(id, data);
                }

                if (type === 'ImageImport') {
                    const dropZone = el.querySelector(`#${id}-drop`);
                    if (dropZone) {
                        dropZone.classList.add('has-image');
                        dropZone.innerHTML = `<img src="${data}" alt="已导入图片" draggable="false" style="pointer-events: none;" />`;
                    }
                    showResolutionBadge(id, data);
                } else if (type === 'ImagePreview') {
                    const previewContainer = el.querySelector(`#${id}-preview`);
                    if (previewContainer) {
                        previewContainer.innerHTML = `<img src="${data}" alt="预览" draggable="false" style="pointer-events: none;" />`;
                    }
                    const controls = el.querySelector(`#${id}-controls`);
                    if (controls) controls.style.display = 'flex';
                    showResolutionBadge(id, data);
                } else if (type === 'ImageSave') {
                    const savePreview = el.querySelector(`#${id}-save-preview`);
                    if (savePreview) {
                        savePreview.innerHTML = `<img src="${data}" alt="待保存" draggable="false" style="pointer-events: none;" />`;
                    }
                    const mSaveBtn = el.querySelector(`#${id}-manual-save`);
                    const vFullBtn = el.querySelector(`#${id}-view-full`);
                    if (mSaveBtn) mSaveBtn.disabled = false;
                    if (vFullBtn) vFullBtn.disabled = false;
                    showResolutionBadge(id, data);
                }
            }
        })();
    }

    // === Event bindings ===
    // Improved drag logic: allow dragging from header OR blank space of node body
    el.addEventListener('mousedown', (e) => {
        // Prevent drag when clicking interactive elements
        const target = e.target;

        // Priority: if we click a close button or delete button, we don't drag
        if (target.closest('.node-delete, .node-bypass-btn')) return;

        // Interactive list: items that should block the node drag to allow their own interaction
        const interactiveSelector = 'input, textarea, select, button, .port, .node-resize-handle, [contenteditable="true"], .chat-response-area, .preview-controls, .workflow-action-btn';
        const isInteractive = target.closest(interactiveSelector);

        // Exception: even if it's in a potential container, if it's the drop-zone or preview-container itself, we STILL drag
        // This ensures clicking the "empty" space of these zones triggers a drag
        const dragAreaSelector = '.file-drop-zone, .preview-container, .save-preview-container, .node-header, .node-glass-bg';
        const isForceDrag = target.matches(dragAreaSelector) || (target.parentElement && target.parentElement.matches(dragAreaSelector));

        if (isInteractive && !isForceDrag) return;

        // Ensure canvas focus when clicking a node to receive paste events reliably
        canvasContainer.focus();

        // NEW: Prioritize canvas panning for Middle Click (1) or Alt + Left Click (0)
        // This allows dragging the canvas even when the mouse is over a node.
        const isPanAction = e.button === 1 || (e.button === 0 && e.altKey);
        if (isPanAction) return;

        // Prevent default browser behaviors like drag-and-drop for images and text selection
        e.preventDefault();

        e.stopPropagation();
        const pos = screenToCanvas(e.clientX, e.clientY);
        const isMulti = e.ctrlKey || e.metaKey;
        const isAlt = e.altKey;

        if (!state.selectedNodes.has(id)) {
            selectNode(id, isMulti);
        }

        const nodesToDrag = Array.from(state.selectedNodes);
        const startPositions = new Map();
        const draggedNodeIds = new Set(nodesToDrag);

        nodesToDrag.forEach(nid => {
            const n = state.nodes.get(nid);
            if (n) {
                startPositions.set(nid, { x: n.x, y: n.y });
                n.el.classList.add('is-interacting');
            }
        });

        // Optimization: Pre-cache port offsets and connection path elements for zero-lookup rendering during drag
        const portOffsets = new Map();
        const connectionsToUpdate = [];

        for (const conn of state.connections) {
            const isFromDragged = draggedNodeIds.has(conn.from.nodeId);
            const isToDragged = draggedNodeIds.has(conn.to.nodeId);
            if (isFromDragged || isToDragged) {
                const pathEl = connectionsGroup.querySelector(`path[data-conn-id="${conn.id}"]`);
                if (pathEl) {
                    connectionsToUpdate.push({ conn, pathEl });
                    [{ p: conn.from, d: 'output' }, { p: conn.to, d: 'input' }].forEach(item => {
                        const key = `${item.p.nodeId}-${item.p.port}-${item.d}`;
                        if (!portOffsets.has(key)) {
                            const pos = getPortPosition(item.p.nodeId, item.p.port, item.d);
                            const n = state.nodes.get(item.p.nodeId);
                            if (n) portOffsets.set(key, { dx: pos.x - n.x, dy: pos.y - n.y });
                        }
                    });
                }
            }
        }

        state.dragging = {
            nodes: nodesToDrag,
            startX: pos.x,
            startY: pos.y,
            startPositions: startPositions,
            portOffsets: portOffsets,
            connectionsToUpdate: connectionsToUpdate,
            altClone: isAlt,
            cloned: false
        };

        pushHistory(); // Capture state before dragging
        document.body.classList.add('is-interacting');
        document.getElementById('connections-group').classList.add('is-interacting');
    });

    el.querySelector('.node-delete').addEventListener('click', (e) => { e.stopPropagation(); removeNode(id); });
    el.querySelector('.node-bypass-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const targetState = !nodeData.enabled;
        const nodesToUpdate = state.selectedNodes.has(id) ? Array.from(state.selectedNodes) : [id];

        nodesToUpdate.forEach(nid => {
            const nData = state.nodes.get(nid);
            if (nData) {
                nData.enabled = targetState;
                nData.el.classList.toggle('disabled', !targetState);
                if (targetState) {
                    nData.el.classList.remove('completed', 'error', 'running');
                    const timeBadge = document.getElementById(`${nid}-time`);
                    if (timeBadge && timeBadge.textContent === 'Skip') timeBadge.textContent = '';
                }
            }
        });

        showToast(targetState ? `已启用 ${nodesToUpdate.length} 个节点` : `已禁用 ${nodesToUpdate.length} 个节点`, 'info');
        scheduleSave();
    });

    // Resize handle — both width and height (Direct Real-time Scaling)
    el.querySelector('.node-resize-handle').addEventListener('mousedown', (e) => {
        const isPanAction = e.button === 1 || (e.button === 0 && e.altKey);
        if (isPanAction) return;
        e.stopPropagation(); e.preventDefault();

        // Measure minimum viable size: temporarily strip explicit sizing and add measurement caps
        const oldW = el.style.width;
        const oldH = el.style.height;

        // Temporarily constrain expandable containers to small max-heights for compact measurement
        const containers = el.querySelectorAll('.preview-container, .save-preview-container, .file-drop-zone, .chat-response-area, .text-display-box');
        const oldMaxHeights = [];
        containers.forEach(c => {
            oldMaxHeights.push(c.style.maxHeight);
            c.style.maxHeight = '120px';
        });
        const body = el.querySelector('.node-body');
        const oldBodyMaxH = body ? body.style.maxHeight : '';
        if (body) body.style.maxHeight = '';

        el.style.width = 'min-content';
        el.style.height = 'min-content';
        const intrinsicW = el.offsetWidth;
        const intrinsicH = el.offsetHeight;
        el.style.width = oldW;
        el.style.height = oldH;

        // Restore container max-heights
        containers.forEach((c, i) => {
            c.style.maxHeight = oldMaxHeights[i];
        });
        if (body) body.style.maxHeight = oldBodyMaxH;

        state.resizing = {
            nodeId: id,
            startX: e.clientX, startY: e.clientY,
            startWidth: el.offsetWidth, startHeight: el.offsetHeight,
            minWidth: Math.max(intrinsicW, 100), 
            minHeight: Math.max(intrinsicH, 80)
        };

        pushHistory(); // Capture state before resizing
        el.classList.add('is-interacting');
        document.body.classList.add('is-interacting');
        document.getElementById('connections-group').classList.add('is-interacting');
    });

    // Port events
    el.querySelectorAll('.node-port').forEach(portEl => {
        const dot = portEl.querySelector('.port-dot');
        dot.addEventListener('mousedown', (e) => {
            const isPanAction = e.button === 1 || (e.button === 0 && e.altKey);
            if (isPanAction) return;
            e.stopPropagation(); e.preventDefault();

            const tgt = { nodeId: portEl.dataset.nodeId, port: portEl.dataset.port, type: portEl.dataset.type, dir: portEl.dataset.direction };

            if (state.connecting) {
                // Second click of the "Click and Click" method
                if (finishConnection(state.connecting, tgt)) {
                    state.connecting = null;
                    tempConnection.setAttribute('d', '');
                }
                return;
            }

            const dotRect = dot.getBoundingClientRect();
            const containerRect = canvasContainer.getBoundingClientRect();
            const { x: cx, y: cy, zoom } = state.canvas;
            state.connecting = {
                nodeId: portEl.dataset.nodeId, portName: portEl.dataset.port,
                dataType: portEl.dataset.type, isOutput: portEl.dataset.direction === 'output',
                startX: (dotRect.left + dotRect.width / 2 - containerRect.left - cx) / zoom,
                startY: (dotRect.top + dotRect.height / 2 - containerRect.top - cy) / zoom,
                screenX: e.clientX, screenY: e.clientY, dragged: false
            };
            document.body.classList.add('is-interacting');
        });

        dot.addEventListener('mouseup', (e) => {
            if (!state.connecting) return;
            e.stopPropagation();

            const src = state.connecting;
            const tgt = { nodeId: portEl.dataset.nodeId, port: portEl.dataset.port, type: portEl.dataset.type, dir: portEl.dataset.direction };

            // If dragging and dropped on a DIFFERENT port, finish connection
            if (src.nodeId !== tgt.nodeId || src.portName !== tgt.port) {
                if (finishConnection(src, tgt)) {
                    state.connecting = null;
                    tempConnection.setAttribute('d', '');
                }
            } else if (!src.dragged) {
                // If it was just a click on the SAME port, we keep state.connecting active (handled by absence of reset)
            } else {
                // Dragged but dropped on same port: clear
                state.connecting = null;
                tempConnection.setAttribute('d', '');
            }
        });
    });

    if (type === 'ImageImport') setupImageImport(id, el);
    else if (type === 'ImageSave') setupImageSave(id, el);
    else if (type === 'ImagePreview') setupImagePreview(id, el);


    else if (type === 'TextChat') {
        const copyBtn = el.querySelector(`#${id}-copy-btn`);
        if (copyBtn) {
            copyBtn.onclick = () => {
                const area = el.querySelector(`#${id}-response`);
                if (area && !area.querySelector('.chat-response-placeholder')) {
                    copyToClipboard(area.innerText);
                } else {
                    showToast('暂无内容可复制', 'warning');
                }
            };
        }
    }

    el.querySelectorAll('input, select, textarea').forEach(input => {
        input.addEventListener('change', () => scheduleSave());
        input.addEventListener('input', debounce(() => scheduleSave(), 500));

        const isExpandable = input.closest('.node-field-expand');
        if (input.tagName === 'TEXTAREA' && !isExpandable) {
            input.addEventListener('input', () => adjustTextareaHeight(input));
            // Trigger initially to handle restored content
            setTimeout(() => adjustTextareaHeight(input), 0);
        }
    });

    if (!restoreData && !silent) showToast(`已添加「${config.title}」节点`, 'success');
    if (!restoreData) scheduleSave();
    return id;
}

function removeNode(id) {
    pushHistory();
    const idsToRemove = state.selectedNodes.has(id) ? Array.from(state.selectedNodes) : [id];
    idsToRemove.forEach(nid => {
        const node = state.nodes.get(nid);
        if (!node) return;
        state.connections = state.connections.filter(c => c.from.nodeId !== nid && c.to.nodeId !== nid);
        node.el.remove(); state.nodes.delete(nid);
        state.selectedNodes.delete(nid);
        // Clean up orphaned assets from IndexedDB
        deleteImageAsset(nid);
    });
    updateAllConnections(); updatePortStyles();
    showToast(idsToRemove.length > 1 ? `已删除 ${idsToRemove.length} 个节点` : '节点已删除', 'info');
    scheduleSave();
    if (document.getElementById('cache-sidebar')?.classList.contains('active')) {
        updateCacheUsage();
    }
}

function selectNode(id, isMulti) {
    if (!isMulti) {
        state.selectedNodes.forEach(nid => {
            const n = state.nodes.get(nid); if (n) n.el.classList.remove('selected');
        });
        state.selectedNodes.clear();
    }

    if (state.selectedNodes.has(id)) {
        state.selectedNodes.delete(id);
        const n = state.nodes.get(id); if (n) n.el.classList.remove('selected');
    } else {
        state.selectedNodes.add(id);
        const n = state.nodes.get(id); if (n) n.el.classList.add('selected');
    }
    updateAllConnections();
}

// ===== Resolution Badge =====
async function showResolutionBadge(nodeId, dataUrl) {
    const badge = document.getElementById(`${nodeId}-res`);
    if (!badge) return;
    const res = await getImageResolution(dataUrl);
    if (res) {
        badge.textContent = `📐 ${res}`;
        badge.style.display = 'block';

        // Stabilize node width after image resolution is known
        // Removed: We now use fixed default widths and trust user manual resizing
    }
}

// ===== Image Import =====
function setupImageImport(id, el) {
    const fileInput = el.querySelector(`#${id}-file`);
    const dropZone = el.querySelector(`#${id}-drop`);
    const selectBtn = el.querySelector(`#${id}-select-btn`);

    selectBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
    fileInput.addEventListener('change', (e) => { if (e.target.files[0]) loadImageFile(id, e.target.files[0]); });
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--accent-purple)'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = ''; });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault(); dropZone.style.borderColor = '';
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) loadImageFile(id, file);
    });

    dropZone.addEventListener('click', (e) => {
        if (state.justDragged) return;
        const node = state.nodes.get(id);
        if (node && node.imageData) openFullscreenPreview(node.imageData, id);
    });
}

function loadImageFile(nodeId, file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        const node = state.nodes.get(nodeId);
        if (!node) return;

        const rawData = e.target.result;

        // Auto-resize high resolution images
        const result = await processImageResolution(rawData);
        const data = result.data;

        if (result.resized) {
            showToast(`图片尺寸较大 (${result.originalRes})，已自动缩小为约 4MP (${result.newRes}) 以保证性能`, 'warning', 5000);
            addLog('info', '图片自动缩小', `原始分辨率: ${result.originalRes} -> 目标分辨率: ${result.newRes}`);
        }

        node.imageData = data;
        await saveImageAsset(nodeId, data);
        const dropZone = node.el.querySelector(`#${nodeId}-drop`);
        dropZone.classList.add('has-image');
        // Fix for ImageImport dragging: use pointer-events: none on img so clicks fall through to the node container
        // and draggable="false" to prevent native browser ghost drags
        dropZone.innerHTML = `<img src="${data}" alt="已导入图片" draggable="false" style="pointer-events: none;" />`;
        showResolutionBadge(nodeId, data);
        scheduleSave();
    };
    reader.readAsDataURL(file);
}

// ===== Image Save =====
function setupImageSave(id, el) {
    const previewContainer = el.querySelector(`#${id}-save-preview`);
    const manualSaveBtn = el.querySelector(`#${id}-manual-save`);

    manualSaveBtn.addEventListener('click', () => {
        const node = state.nodes.get(id);
        if (!node || !node.data.image) return showToast('没有可保存的图片', 'warning');
        const filename = el.querySelector(`#${id}-filename`).value || 'image';
        try {
            const blob = dataURLtoBlob(node.data.image);
            const pngBlob = new Blob([blob], { type: 'image/png' });
            const url = URL.createObjectURL(pngBlob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename + '.png';
            document.body.appendChild(link);
            link.click();
            setTimeout(() => { document.body.removeChild(link); URL.revokeObjectURL(url); }, 100);
            showToast('图片已手动保存为 PNG', 'success');
        } catch (err) {
            console.error('Manual save error:', err);
            showToast('保存失败: ' + err.message, 'error');
        }
    });

    previewContainer.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.justDragged) return;
        const node = state.nodes.get(id);
        if (node && node.data.image) openFullscreenPreview(node.data.image, id);
    });

    el.querySelector(`#${id}-view-full`).addEventListener('click', (e) => {
        e.stopPropagation();
        const node = state.nodes.get(id);
        if (node && node.data.image) openFullscreenPreview(node.data.image, id);
    });
}

async function autoSaveToDir(nodeId, dataUrl) {
    const node = state.nodes.get(nodeId);
    if (!node) return;
    const handle = state.globalSaveDirHandle;
    if (!handle) {
        showToast('【自动保存提醒】未在通用设置中选取全局保存目录，图片仅保存在节点内。', 'warning', 5000);
        addLog('warning', '自动保存跳过', '未在通用设置中配置保存路径', { nodeId });
        return;
    }
    try {
        // Verify permission
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
            // If not granted, try to request
            try {
                const req = await handle.requestPermission({ mode: 'readwrite' });
                if (req !== 'granted') {
                    showToast('【自动保存失败】目录访问权限被拒绝', 'error');
                    addLog('error', '自动保存失败', '权限被拒绝', { nodeId });
                    return;
                }
            } catch (e) {
                showToast('【自动保存失败】无法请求目录权限，请手动点击选择目录重新激活', 'error', 6000);
                addLog('error', '自动保存失败', '无法请求权限: ' + e.message, { nodeId });
                return;
            }
        }
        const prefix = document.getElementById(`${nodeId}-filename`)?.value || 'image';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `${prefix}_${timestamp}.png`;
        const blob = dataURLtoBlob(dataUrl);
        const fileHandle = await handle.getFileHandle(filename, { create: true });
        if (!fileHandle) throw new Error('无法创建文件');
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        showToast(`图片已自动保存: ${filename}`, 'success');
        addLog('success', '自动保存成功', `已保存至: ${handle.name}/${filename}`);
    } catch (err) {
        console.error('Auto-save error:', err);
        showToast('【自动保存出错】' + err.message, 'error', 5000);
        addLog('error', '自动保存异常', err.message, { nodeId, error: err.stack || err });
    }
}
function setupImagePreview(id, el) {
    const previewContainer = el.querySelector(`#${id}-preview`);
    el.querySelector(`#${id}-zoom-in`).addEventListener('click', (e) => { e.stopPropagation(); adjustPreviewZoom(id, 1.25); });
    el.querySelector(`#${id}-zoom-out`).addEventListener('click', (e) => { e.stopPropagation(); adjustPreviewZoom(id, 0.8); });
    el.querySelector(`#${id}-zoom-reset`).addEventListener('click', (e) => {
        e.stopPropagation();
        const n = state.nodes.get(id); if (n) n.previewZoom = 1;
        const img = previewContainer.querySelector('img'); if (img) img.style.transform = 'scale(1)';
    });
    // No wheel zoom on preview — only buttons and fullscreen
    previewContainer.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.justDragged) return;
        const img = previewContainer.querySelector('img');
        if (img) openFullscreenPreview(img.src, id);
    });
    el.querySelector(`#${id}-fullscreen`).addEventListener('click', (e) => {
        e.stopPropagation();
        const img = previewContainer.querySelector('img');
        if (img) openFullscreenPreview(img.src, id);
    });
}

function adjustPreviewZoom(nodeId, factor) {
    const node = state.nodes.get(nodeId);
    if (!node) return;
    const img = node.el.querySelector(`#${nodeId}-preview img`);
    if (!img) return;
    node.previewZoom = Math.max(0.2, Math.min(10, (node.previewZoom || 1) * factor));
    img.style.transform = `scale(${node.previewZoom})`;
    img.style.transformOrigin = 'center center';
}

// ===== Fullscreen Preview =====
function openFullscreenPreview(src, nodeId = null) {
    const overlay = document.createElement('div');
    overlay.className = 'fullscreen-overlay';
    overlay.innerHTML = `
        <div class="fullscreen-close" title="关闭 (Esc)">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </div>
        ${nodeId ? `
        <div class="fullscreen-paint-btn" title="绘制/编辑">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </div>` : ''}
        <div class="fullscreen-img-wrapper">
            <img src="${src}" alt="全屏预览" draggable="false" />
        </div>`;
    document.body.appendChild(overlay);
    const img = overlay.querySelector('img');
    let fsZoom = 1, fsX = 0, fsY = 0, isDragging = false, dragStart = { x: 0, y: 0 };
    function updateFsT() { img.style.transform = `translate(${fsX}px, ${fsY}px) scale(${fsZoom})`; }
    overlay.addEventListener('wheel', (e) => {
        e.preventDefault();
        const nz = Math.max(0.1, Math.min(20, fsZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
        const rect = overlay.getBoundingClientRect();
        const cx = e.clientX - rect.left - rect.width / 2, cy = e.clientY - rect.top - rect.height / 2;
        fsX = cx - (cx - fsX) * (nz / fsZoom); fsY = cy - (cy - fsY) * (nz / fsZoom);
        fsZoom = nz; updateFsT();
    }, { passive: false });
    const iw = overlay.querySelector('.fullscreen-img-wrapper');
    iw.addEventListener('mousedown', (e) => { if (e.button !== 0) return; e.preventDefault(); isDragging = true; dragStart = { x: e.clientX - fsX, y: e.clientY - fsY }; iw.style.cursor = 'grabbing'; });
    function onMove(e) { if (!isDragging) return; fsX = e.clientX - dragStart.x; fsY = e.clientY - dragStart.y; updateFsT(); }
    function onUp() { isDragging = false; iw.style.cursor = 'grab'; }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    function cleanup() {
        overlay.remove();
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.removeEventListener('keydown', onEsc);
    }
    overlay.querySelector('.fullscreen-close').addEventListener('click', cleanup);
    if (nodeId) {
        overlay.querySelector('.fullscreen-paint-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            cleanup();
            openImagePainter(src, nodeId);
        });
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target === iw) cleanup(); });
    function onEsc(e) { if (e.key === 'Escape') cleanup(); }
    document.addEventListener('keydown', onEsc);
    requestAnimationFrame(() => overlay.classList.add('active'));
}

// ===== Image Painter (Drawing Editor) =====
function openImagePainter(src, nodeId) {
    const overlay = document.createElement('div');
    overlay.className = 'painter-overlay';
    overlay.innerHTML = `
        <div class="painter-header">
            <h2>图片编辑器 - 绘制功能</h2>
            <div style="display: flex; gap: 10px; align-items: center;">
                <div class="painter-btn painter-btn-undo" id="painter-undo" title="撤回 (Ctrl+Z)" disabled>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
                </div>
                <div style="width: 1px; height: 24px; background: rgba(255,255,255,0.1); margin: 0 5px;"></div>
                <div class="painter-btn painter-btn-save" id="painter-save" title="应用并保存 (S)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div class="painter-btn painter-btn-cancel" id="painter-cancel" title="取消并退出 (Esc)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </div>
            </div>
        </div>
        <div class="painter-body">
            <div class="painter-toolbar-left">
                <div class="painter-tool-btn active" data-tool="pen" title="自由绘制 (P)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </div>
                <div class="painter-tool-btn" data-tool="line" title="绘制直线 (L)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"/></svg>
                </div>
                <div class="painter-tool-btn" data-tool="arrow" title="绘制箭头 (A)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="12 5 19 5 19 12"/></svg>
                </div>
                <div class="painter-tool-btn" data-tool="rect" title="绘制矩形 (R)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
                </div>
                <div class="painter-tool-btn" data-tool="circle" title="绘制圆形 (C)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>
                </div>
                <div class="painter-colors">
                    <div class="painter-color-swatch active" data-color="#22d3ee" style="background: #22d3ee;"></div>
                    <div class="painter-color-swatch" data-color="#ef4444" style="background: #ef4444;"></div>
                    <div class="painter-color-swatch" data-color="#10b981" style="background: #10b981;"></div>
                    <div class="painter-color-swatch" data-color="#f59e0b" style="background: #f59e0b;"></div>
                    <div class="painter-color-swatch" data-color="#ffffff" style="background: #ffffff;"></div>
                    <div class="painter-color-swatch" data-color="#000000" style="background: #000000;"></div>
                    <div class="painter-color-swatch painter-color-custom-btn" id="painter-custom-color" title="自定义颜色"></div>
                </div>
                
                <div class="painter-color-panel" id="color-picker-panel">
                    <div class="painter-hue-wrapper">
                        <canvas id="hue-wheel" class="painter-hue-canvas"></canvas>
                    </div>
                    <div class="painter-hsb-controls">
                        <div class="hsb-slider-group">
                            <label>饱和度 (S) <span id="s-val">100%</span></label>
                            <input type="range" id="s-slider" class="hsb-slider" min="0" max="100" value="100">
                        </div>
                        <div class="hsb-slider-group">
                            <label>亮度 (B) <span id="b-val">100%</span></label>
                            <input type="range" id="b-slider" class="hsb-slider" min="0" max="100" value="100">
                        </div>
                        <div class="painter-color-preview-row">
                            <div class="color-preview-box" id="color-preview"></div>
                            <input type="text" class="color-hex-input" id="color-hex" value="#22d3ee" readonly>
                        </div>
                    </div>
                </div>
            </div>
            <div class="painter-canvas-container">
                <canvas id="painter-canvas"></canvas>
            </div>
        </div>`;

    document.body.appendChild(overlay);
    const canvas = overlay.querySelector('#painter-canvas');
    const ctx = canvas.getContext('2d');
    const container = overlay.querySelector('.painter-canvas-container');
    const undoBtn = overlay.querySelector('#painter-undo');

    let img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;

    let scale = 1, offsetX = 0, offsetY = 0;
    let currentTool = 'pen', currentColor = '#22d3ee';
    let isDrawing = false, isPanning = false;
    let startPan = { x: 0, y: 0 };
    let shapes = [];
    let currentShape = null;

    // Reset view logic with robust layout detection
    function resetView() {
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            requestAnimationFrame(resetView);
            return;
        }
        const padding = 100; // Increased padding for higher safety
        const s = Math.min((rect.width - padding) / img.width, (rect.height - padding) / img.height);
        scale = s;
        offsetX = (rect.width - img.width * scale) / 2;
        offsetY = (rect.height - img.height * scale) / 2;
        render();
    }

    img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        // Schedule resetView after initial layout paint
        requestAnimationFrame(() => {
            resetView();
            setTimeout(resetView, 100); // Secondary safety reset
        });
    };

    window.addEventListener('resize', onResize);
    function onResize() { if (document.body.contains(overlay)) { resetView(); } }

    function render() {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        shapes.forEach(shape => drawShape(shape));
        if (currentShape) drawShape(currentShape);

        canvas.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
        canvas.style.transformOrigin = '0 0';
        undoBtn.disabled = shapes.length === 0;
    }

    function drawShape(shape) {
        ctx.beginPath();
        ctx.strokeStyle = shape.color || currentColor;
        ctx.lineWidth = (shape.strokeWidth || 4) / scale;

        if (shape.type === 'pen') {
            if (shape.points.length < 2) return;
            ctx.moveTo(shape.points[0].x, shape.points[0].y);
            for (let i = 1; i < shape.points.length; i++) ctx.lineTo(shape.points[i].x, shape.points[i].y);
            ctx.stroke();
        } else if (shape.type === 'line') {
            ctx.moveTo(shape.start.x, shape.start.y);
            ctx.lineTo(shape.end.x, shape.end.y);
            ctx.stroke();
        } else if (shape.type === 'arrow') {
            const h = 20 / scale;
            const a = Math.atan2(shape.end.y - shape.start.y, shape.end.x - shape.start.x);
            ctx.moveTo(shape.start.x, shape.start.y);
            ctx.lineTo(shape.end.x, shape.end.y);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(shape.end.x, shape.end.y);
            ctx.lineTo(shape.end.x - h * Math.cos(a - Math.PI / 6), shape.end.y - h * Math.sin(a - Math.PI / 6));
            ctx.moveTo(shape.end.x, shape.end.y);
            ctx.lineTo(shape.end.x - h * Math.cos(a + Math.PI / 6), shape.end.y - h * Math.sin(a + Math.PI / 6));
            ctx.stroke();
        } else if (shape.type === 'rect') {
            ctx.strokeRect(shape.start.x, shape.start.y, shape.end.x - shape.start.x, shape.end.y - shape.start.y);
        } else if (shape.type === 'circle') {
            const r = Math.sqrt(Math.pow(shape.end.x - shape.start.x, 2) + Math.pow(shape.end.y - shape.start.y, 2));
            ctx.arc(shape.start.x, shape.start.y, r, 0, 2 * Math.PI);
            ctx.stroke();
        }
    }

    // --- Color Picker Logic ---
    let hsb_h = 190, hsb_s = 85, hsb_b = 93; // Default to Cyan (#22d3ee approx)
    const pickerPanel = overlay.querySelector('#color-picker-panel');
    const hueWheel = overlay.querySelector('#hue-wheel');
    const sSlider = overlay.querySelector('#s-slider');
    const bSlider = overlay.querySelector('#b-slider');
    const previewBox = overlay.querySelector('#color-preview');
    const hexInput = overlay.querySelector('#color-hex');
    const customSwatch = overlay.querySelector('#painter-custom-color');

    function hsbToHex(h, s, b) {
        b /= 100; s /= 100;
        let k = n => (n + h / 60) % 6;
        let f = n => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
        let toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
        return `#${toHex(f(5))}${toHex(f(3))}${toHex(f(1))}`;
    }

    function updateColorFromHSB() {
        const hex = hsbToHex(hsb_h, hsb_s, hsb_b);
        currentColor = hex;
        previewBox.style.background = hex;
        hexInput.value = hex.toUpperCase();
        customSwatch.style.background = hex;
        overlay.querySelectorAll('.painter-color-swatch').forEach(s => s.classList.remove('active'));
        customSwatch.classList.add('active');

        overlay.querySelector('#s-val').textContent = `${Math.round(hsb_s)}%`;
        overlay.querySelector('#b-val').textContent = `${Math.round(hsb_b)}%`;
        render();
    }

    function initHueWheel() {
        hueWheel.width = 160; hueWheel.height = 160;
        const hctx = hueWheel.getContext('2d');
        const cx = 80, cy = 80, r = 70;

        for (let angle = 0; angle < 360; angle++) {
            const start = (angle * Math.PI) / 180;
            const end = ((angle + 2) * Math.PI) / 180;
            hctx.beginPath();
            hctx.moveTo(cx, cy);
            hctx.arc(cx, cy, r, start, end);
            hctx.fillStyle = `hsl(${angle}, 100%, 50%)`;
            hctx.fill();
        }
        // Draw center white for selection clear indicator (optional, keeps it clean)
        hctx.beginPath(); hctx.arc(cx, cy, r - 15, 0, Math.PI * 2);
        hctx.fillStyle = 'rgba(30, 41, 59, 1)'; hctx.fill();
    }

    hueWheel.addEventListener('mousedown', (e) => {
        const pick = (ev) => {
            const rect = hueWheel.getBoundingClientRect();
            const x = ev.clientX - rect.left - 80, y = ev.clientY - rect.top - 80;
            hsb_h = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
            updateColorFromHSB();
        };
        const onMove = (ev) => pick(ev);
        const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        pick(e);
    });

    sSlider.addEventListener('input', (e) => { hsb_s = parseInt(e.target.value); updateColorFromHSB(); });
    bSlider.addEventListener('input', (e) => { hsb_b = parseInt(e.target.value); updateColorFromHSB(); });

    customSwatch.addEventListener('click', (e) => {
        e.stopPropagation();
        pickerPanel.classList.toggle('active');
        if (pickerPanel.classList.contains('active')) {
            initHueWheel();
            updateColorFromHSB();
        }
    });

    overlay.addEventListener('click', (e) => {
        if (!pickerPanel.contains(e.target) && e.target !== customSwatch) {
            pickerPanel.classList.remove('active');
        }
    });

    function getPos(e) {
        const r = canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
    }

    const onWheel = (e) => {
        e.preventDefault();
        const nz = Math.max(0.05, Math.min(50, scale * (e.deltaY > 0 ? 0.9 : 1.1)));
        const rect = container.getBoundingClientRect();
        const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        offsetX = cx - (cx - offsetX) * (nz / scale);
        offsetY = cy - (cy - offsetY) * (nz / scale);
        scale = nz; render();
    };

    const onMouseDown = (e) => {
        if (e.button === 1 || (e.button === 0 && e.altKey)) {
            isPanning = true; startPan = { x: e.clientX - offsetX, y: e.clientY - offsetY };
            container.style.cursor = 'grabbing'; return;
        }
        if (e.button === 0) {
            isDrawing = true; const p = getPos(e);
            currentShape = currentTool === 'pen' ?
                { type: 'pen', points: [p], color: currentColor, strokeWidth: 4 } :
                { type: currentTool, start: p, end: p, color: currentColor, strokeWidth: 4 };
        }
    };
    const onMouseMove = (e) => {
        if (isPanning) { offsetX = e.clientX - startPan.x; offsetY = e.clientY - startPan.y; render(); }
        else if (isDrawing) {
            const p = getPos(e);
            if (currentTool === 'pen') currentShape.points.push(p); else currentShape.end = p;
            render();
        }
    };
    const onMouseUp = () => {
        if (isPanning) { isPanning = false; container.style.cursor = 'crosshair'; }
        else if (isDrawing) {
            isDrawing = false;
            if (currentShape) {
                shapes.push(currentShape);
                if (shapes.length > 20) shapes.shift();
            }
            currentShape = null; render();
        }
    };

    overlay.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    overlay.querySelectorAll('.painter-tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            overlay.querySelectorAll('.painter-tool-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active'); currentTool = btn.dataset.tool;
        });
    });

    overlay.querySelectorAll('.painter-color-swatch:not(.painter-color-custom-btn)').forEach(swatch => {
        swatch.addEventListener('click', () => {
            overlay.querySelectorAll('.painter-color-swatch').forEach(s => s.classList.remove('active'));
            swatch.classList.add('active');
            currentColor = swatch.dataset.color;
            pickerPanel.classList.remove('active');
        });
    });

    function undo() { if (shapes.length > 0) { shapes.pop(); render(); } }

    function cleanup() {
        overlay.classList.remove('active'); setTimeout(() => overlay.remove(), 300);
        window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('resize', onResize);
        document.removeEventListener('keydown', onKey);
    }

    async function save() {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        const tempScale = scale;
        scale = 1;
        shapes.forEach(s => {
            const originalSW = s.strokeWidth;
            s.strokeWidth = 4; drawShape(s);
            s.strokeWidth = originalSW;
        });
        scale = tempScale;
        const data = canvas.toDataURL('image/png');
        const node = state.nodes.get(nodeId);
        if (node) {
            if (node.imageData !== undefined) {
                node.imageData = data;
                const dz = node.el.querySelector(`#${nodeId}-drop`);
                if (dz) dz.innerHTML = `<img src="${data}" alt="已导入图片" draggable="false" style="pointer-events: none;" />`;
            } else if (node.data && node.data.image !== undefined) {
                node.data.image = data;
                const nimg = node.el.querySelector('img'); if (nimg) nimg.src = data;
            }
            if (node.dirHandle || dirHandles.get(nodeId)) await autoSaveToDir(nodeId, data);
            scheduleSave(); showToast('图片已更新', 'success');
        }
        cleanup();
    }

    undoBtn.addEventListener('click', undo);
    overlay.querySelector('#painter-save').addEventListener('click', save);
    overlay.querySelector('#painter-cancel').addEventListener('click', cleanup);

    function onKey(e) {
        if (e.key === 'Escape') cleanup();
        if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
        const tools = { 'p': 'pen', 'l': 'line', 'a': 'arrow', 'r': 'rect', 'c': 'circle' };
        if (tools[e.key.toLowerCase()]) {
            const t = tools[e.key.toLowerCase()];
            overlay.querySelectorAll('.painter-tool-btn').forEach(b => {
                const active = b.dataset.tool === t;
                b.classList.toggle('active', active);
                if (active) currentTool = t;
            });
        }
    }
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => overlay.classList.add('active'));
}

// ===== Connection Rendering =====
function getPortPosition(nodeId, portName, direction) {
    const node = state.nodes.get(nodeId);
    if (!node) return { x: 0, y: 0 };

    // Performance optimization: during drag, use cached relative offsets to dodge getBoundingClientRect reflows
    if (state.dragging && state.dragging.portOffsets) {
        const offset = state.dragging.portOffsets.get(`${nodeId}-${portName}-${direction}`);
        if (offset) return { x: node.x + offset.dx, y: node.y + offset.dy };
    }

    const portEl = node.el.querySelector(`.node-port[data-node-id="${nodeId}"][data-port="${portName}"][data-direction="${direction}"]`);
    if (!portEl) return { x: node.x, y: node.y };
    const dot = portEl.querySelector('.port-dot');
    const dotRect = dot.getBoundingClientRect();
    const containerRect = canvasContainer.getBoundingClientRect();
    const { x: cx, y: cy, zoom } = state.canvas;
    return {
        x: (dotRect.left + dotRect.width / 2 - containerRect.left - cx) / zoom,
        y: (dotRect.top + dotRect.height / 2 - containerRect.top - cy) / zoom
    };
}

function createBezierPath(x1, y1, x2, y2) {
    const cp = Math.max(50, Math.abs(x2 - x1) * 0.4);
    return `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`;
}

function updateAllConnections() {
    const { x, y, zoom } = state.canvas;
    const isDragging = !!state.dragging;
    const isPanning = state.canvas.isPanning;

    connectionsGroup.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);
    if (originAxes) {
        originAxes.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);
    }

    if (isDragging || isPanning) {
        connectionsGroup.classList.add('is-dragging');
    } else {
        connectionsGroup.classList.remove('is-dragging', 'is-panning');
    }

    // Cleanup phase: remove dead connection paths
    const currentConnIds = new Set(state.connections.map(c => c.id));
    connectionsGroup.querySelectorAll('path[data-conn-id]').forEach(p => {
        if (!currentConnIds.has(p.getAttribute('data-conn-id'))) p.remove();
    });

    // Performance optimization: Calculate viewport bounds once
    const containerRect = canvasContainer.getBoundingClientRect();
    const vx1 = -x / zoom, vy1 = -y / zoom;
    const vx2 = (containerRect.width - x) / zoom, vy2 = (containerRect.height - y) / zoom;
    const padding = 100;

    for (const conn of state.connections) {
        let path = connectionsGroup.querySelector(`path[data-conn-id="${conn.id}"]`);

        // Fast culling check: if both nodes are far outside viewport, skip
        const fn = state.nodes.get(conn.from.nodeId);
        const tn = state.nodes.get(conn.to.nodeId);
        if (fn && tn) {
            const isFIn = fn.x > vx1 - padding && fn.x < vx2 + padding && fn.y > vy1 - padding && fn.y < vy2 + padding;
            const isTIn = tn.x > vx1 - padding && tn.x < vx2 + padding && tn.y > vy1 - padding && tn.y < vy2 + padding;
            if (!isFIn && !isTIn && path) {
                path.setAttribute('d', ''); // Hide it
                continue;
            }
        }

        const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output');
        const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input');

        const cp = Math.max(50, Math.abs(to.x - from.x) * 0.4);
        const pathStr = `M ${from.x} ${from.y} C ${from.x + cp} ${from.y}, ${to.x - cp} ${to.y}, ${to.x} ${to.y}`;

        const isSelected = state.selectedNodes.has(conn.from.nodeId) || state.selectedNodes.has(conn.to.nodeId);

        if (!path) {
            path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('data-conn-id', conn.id);
            path.classList.add('connection-path');
            path.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                state.connections = state.connections.filter(c => c.id !== conn.id);
                updateAllConnections(); updatePortStyles();
                showToast('连接已删除', 'info'); scheduleSave();
            });
            connectionsGroup.appendChild(path);
        }

        path.setAttribute('d', pathStr);
        if (isSelected) path.classList.add('selected');
        else path.classList.remove('selected');
        path.removeAttribute('stroke');
    }
}

function finishConnection(src, tgt) {
    pushHistory();
    if (src.nodeId === tgt.nodeId) return showToast('不能连接同一节点', 'warning');
    if (src.isOutput && tgt.dir === 'output') return showToast('不能连接两个输出', 'warning');
    if (!src.isOutput && tgt.dir === 'input') return showToast('不能连接两个输入', 'warning');
    if (src.dataType !== (tgt.type || tgt.dataType)) return showToast('类型不匹配', 'warning');

    const fromId = src.isOutput ? src.nodeId : tgt.nodeId;
    const fromPort = src.isOutput ? src.portName : tgt.port;
    const toId = src.isOutput ? tgt.nodeId : src.nodeId;
    const toPort = src.isOutput ? tgt.port : src.portName;

    if (state.connections.find(c => c.from.nodeId === fromId && c.from.port === fromPort && c.to.nodeId === toId && c.to.port === toPort))
        return showToast('连接已存在', 'warning');

    state.connections = state.connections.filter(c => !(c.to.nodeId === toId && c.to.port === toPort));
    state.connections.push({
        id: 'c_' + Math.random().toString(36).substr(2, 9),
        from: { nodeId: fromId, port: fromPort }, to: { nodeId: toId, port: toPort }, type: src.dataType
    });
    updateAllConnections(); updatePortStyles();
    showToast('连接已创建', 'success'); scheduleSave();
    return true;
}

function drawTempConnection(x1, y1, x2, y2) {
    const { x, y, zoom } = state.canvas;
    const sx1 = x1 * zoom + x, sy1 = y1 * zoom + y, sx2 = x2 * zoom + x, sy2 = y2 * zoom + y;
    const cp = Math.max(50, Math.abs(sx2 - sx1) * 0.4);
    tempConnection.setAttribute('d', `M ${sx1} ${sy1} C ${sx1 + cp} ${sy1}, ${sx2 - cp} ${sy2}, ${sx2} ${sy2}`);
}

function updatePortStyles() {
    document.querySelectorAll('.port-dot').forEach(d => d.classList.remove('connected'));
    for (const conn of state.connections) {
        const fN = state.nodes.get(conn.from.nodeId);
        const tN = state.nodes.get(conn.to.nodeId);
        if (fN) { const p = fN.el.querySelector(`.node-port[data-port="${conn.from.port}"][data-direction="output"] .port-dot`); if (p) p.classList.add('connected'); }
        if (tN) { const p = tN.el.querySelector(`.node-port[data-port="${conn.to.port}"][data-direction="input"] .port-dot`); if (p) p.classList.add('connected'); }
    }
}

// ===== Execution Engine =====
function topologicalSort(targetNodeId = null) {
    const visited = new Set(), result = [], visiting = new Set();
    function visit(nid) {
        if (visited.has(nid)) return true;
        if (visiting.has(nid)) return false;
        visiting.add(nid);
        for (const c of state.connections.filter(c => c.to.nodeId === nid))
            if (!visit(c.from.nodeId)) return false;
        visiting.delete(nid); visited.add(nid); result.push(nid);
        return true;
    }
    
    if (targetNodeId) {
        if (!state.nodes.has(targetNodeId)) return null;
        if (!visit(targetNodeId)) { showToast('循环连接', 'error'); return null; }
    } else {
        for (const [nid] of state.nodes) {
            if (!visit(nid)) { showToast('循环连接', 'error'); return null; }
        }
    }
    return result;
}

async function runWorkflow(targetNodeId = null) {
    if (state.nodes.size === 0) {
        showToast('当前画布没有任何节点，请先添加节点或加载工作流', 'warning');
        return;
    }
    if (state.isRunning) return;

    // Pre-flight check: Warn if models are used without API keys configured
    const missingKeysProviders = new Set();
    for (const [id, node] of state.nodes) {
        if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
            const configSelect = document.getElementById(`${id}-apiconfig`);
            if (configSelect) {
                const modelCfg = state.models.find(m => m.id === configSelect.value);
                if (modelCfg) {
                    const apiCfg = state.providers.find(p => p.id === modelCfg.providerId);
                    if (apiCfg && !apiCfg.apikey.trim()) {
                        missingKeysProviders.add(apiCfg.name);
                    }
                }
            }
        }
    }
    
    if (missingKeysProviders.size > 0) {
        const names = Array.from(missingKeysProviders).join(', ');
        const msg = `场景中存在未配置 API 密钥的模型（涉及供应商: ${names}），可能会导致执行报错。\n\n您确定要强制继续运行吗？`;
        if (!confirm(msg)) {
            return;
        }
    }

    state.isRunning = true;
    state.abortController = new AbortController();

    // Warm up audio context for background notifications
    if (state.notificationsEnabled) {
        if (!state.notificationAudio) {
            state.notificationAudio = new Audio();
            // Use a tiny silent base64 WAV to "occupy" the audio context
            state.notificationAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';
            state.notificationAudio.loop = true;
        }
        state.notificationAudio.muted = true;
        state.notificationAudio.play().catch(e => console.warn('Audio warm-up blocked:', e));
    }

    const runBtn = document.getElementById('btn-run');
    const stopBtn = document.getElementById('btn-stop');
    runBtn.classList.add('running'); runBtn.disabled = true;
    if (stopBtn) { stopBtn.classList.add('running'); stopBtn.disabled = false; }

    // Reset nodes (unless fixed and succeeded)
    for (const [nid, n] of state.nodes) {
        const fixedToggle = document.getElementById(`${nid}-fixed`);
        const isFixed = fixedToggle ? fixedToggle.checked : false;
        
        if (isFixed && n.isSucceeded && n.data && Object.keys(n.data).length > 0) {
            // Keep the node in completed state
            n.el.classList.add('completed');
            n.el.classList.remove('error', 'running');
            continue;
        }

        n.el.classList.remove('completed', 'error', 'running');
        n.data = {};
        n.isSucceeded = false;
    }

    const order = topologicalSort(targetNodeId);
    if (!order) {
        finalizeWorkflow();
        return;
    }

    // Pre-flight check: ImageImport nodes in the path MUST have images
    const emptyImageNodes = [];
    for (const nid of order) {
        const node = state.nodes.get(nid);
        if (node && node.enabled !== false && node.type === 'ImageImport' && !node.imageData) {
            emptyImageNodes.push(nid);
        }
    }
    
    if (emptyImageNodes.length > 0) {
        showToast(`执行中止：当前路径中有 ${emptyImageNodes.length} 个图片导入节点未加载图片`, 'error', 5000);
        emptyImageNodes.forEach(nid => {
            const node = state.nodes.get(nid);
            if (node) {
                node.el.classList.add('error');
                addLog('error', '前置检查未通过', `节点「图片导入」(${nid}) 未载入素材图片`);
            }
        });
        finalizeWorkflow();
        return;
    }

    // Pre-flight check: TextChat nodes in path must have a prompt (from port or textarea)
    const emptyPromptNodes = [];
    for (const nid of order) {
        const node = state.nodes.get(nid);
        if (node && node.enabled !== false && node.type === 'TextChat') {
            const fixedToggle = document.getElementById(`${nid}-fixed`);
            if (fixedToggle && fixedToggle.checked && node.isSucceeded) continue; // Skip fixed nodes with results

            const hasPortInput = state.connections.some(c => c.to.nodeId === nid && c.to.port === 'prompt');
            const textareaValue = document.getElementById(`${nid}-prompt`)?.value || '';
            if (!hasPortInput && !textareaValue.trim()) {
                emptyPromptNodes.push(nid);
            }
        }
    }

    if (emptyPromptNodes.length > 0) {
        showToast(`执行中止：当前路径中有 ${emptyPromptNodes.length} 个智能对话节点内容为空`, 'error', 5000);
        emptyPromptNodes.forEach(nid => {
            const node = state.nodes.get(nid);
            if (node) {
                node.el.classList.add('error');
                addLog('error', '前置检查未通过', `节点「智能对话」(${nid}) 提示词内容缺失（连线或文本框均无内容）`);
            }
        });
        finalizeWorkflow();
        return;
    }

    // Pre-verify Global Save Directory permission (Crucial: Must be requested on user gesture)
    if (state.globalSaveDirHandle) {
        const hasSaveNode = order.some(nid => state.nodes.get(nid)?.type === 'ImageSave');
        if (hasSaveNode) {
            try {
                const status = await state.globalSaveDirHandle.queryPermission({ mode: 'readwrite' });
                if (status !== 'granted') {
                    addLog('info', '目录授权申请', '尝试获取保存目录的写入权限...');
                    const req = await state.globalSaveDirHandle.requestPermission({ mode: 'readwrite' });
                    if (req !== 'granted') {
                        showToast('自动保存未授权：工作流将继续，但图片无法自动落盘', 'warning', 4000);
                        addLog('warning', '目录授权失败', '用户拒绝了目录访问请求，图片将仅保存在节点内');
                    } else {
                        addLog('success', '目录授权成功', '自动保存功能已就绪');
                    }
                }
            } catch (e) {
                console.warn('Directory permission verify failed:', e);
            }
        }
    }

    function finalizeWorkflow() {
        state.isRunning = false;
        runBtn.classList.remove('running'); runBtn.disabled = false;
        if (stopBtn) { stopBtn.classList.remove('running'); stopBtn.disabled = true; }
        state.abortController = null;
    }

    // Auto-inject ImageSave nodes
    let injected = false;
    for (const nid of order) {
        const node = state.nodes.get(nid);
        if (node && node.type === 'ImageGenerate') {
            const hasConnection = state.connections.some(c => c.from.nodeId === nid && c.from.port === 'image');
            if (!hasConnection) {
                const rect = node.el.getBoundingClientRect();
                const nodeWidth = rect.width || 240;
                const saveId = addNode('ImageSave', node.x + nodeWidth + 80, node.y);
                if (saveId) {
                    state.connections.push({ id: 'conn_' + generateId(), from: { nodeId: nid, port: 'image', type: 'image' }, to: { nodeId: saveId, port: 'image', type: 'image' }, type: 'image' });
                    injected = true;
                    addLog('info', '自动注入节点', `为「${NODE_CONFIGS[node.type].title}」自动添加了图片保存节点`);
                }
            }
        }
    }
    if (injected) {
        updateAllConnections(); updatePortStyles();
        const newOrder = topologicalSort(targetNodeId);
        if (newOrder) order.splice(0, order.length, ...newOrder);
    }

    const totalWorkflowStartTime = Date.now();
    addLog('info', '并发工作流启动', `开始运行 ${order.length} 个节点...`);

    let retryAttempt = 0;
    const maxRetries = state.maxRetries || 15;
    const completedNodes = new Set();
    const failedNodes = new Set();
    const runningNodes = new Set();
    let terminatedByError = false;

    try {
        while (true) {
            let hasNewFailuresInRound = false;

            // Parallel execution loop for this round
            while (true) {
                if (!state.isRunning) break;

                // Find nodes that are ready (all dependencies completed successfully)
                const readyNodes = order.filter(nid => {
                    if (completedNodes.has(nid) || runningNodes.has(nid) || failedNodes.has(nid)) return false;
                    const node = state.nodes.get(nid);
                    if (!node || node.enabled === false) { completedNodes.add(nid); return false; }

                    const deps = state.connections.filter(c => c.to.nodeId === nid).map(c => c.from.nodeId);
                    return deps.every(dnid => completedNodes.has(dnid));
                });

                if (readyNodes.length === 0 && runningNodes.size === 0) break;

                if (readyNodes.length > 0) {
                    readyNodes.forEach(nid => {
                        if (runningNodes.has(nid) || completedNodes.has(nid)) return;
                        runningNodes.add(nid);
                        const node = state.nodes.get(nid);
                        const nodeTitle = NODE_CONFIGS[node.type].title;

                        (async () => {
                            node.el.classList.add('running');
                            node.el.classList.remove('completed', 'error');
                            const timeBadge = document.getElementById(`${nid}-time`);
                            const timeContainer = document.getElementById(`${nid}-time-container`);
                            const startTime = Date.now();
                            let timerId = null;
                            if (timeBadge) {
                                if (timeContainer) timeContainer.style.display = 'flex';
                                timerId = setInterval(() => {
                                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                                    timeBadge.textContent = `${elapsed}s`;
                                    if (elapsed > 60) timeBadge.style.color = 'var(--accent-red)';
                                    else timeBadge.style.color = '';
                                }, 100);
                            }

                            try {
                                const inputs = {};
                                for (const c of state.connections.filter(c => c.to.nodeId === nid)) {
                                    const fn = state.nodes.get(c.from.nodeId);
                                    if (fn && fn.data[c.from.port] !== undefined) inputs[c.to.port] = fn.data[c.from.port];
                                }

                                await executeNode(node, inputs, state.abortController?.signal);

                                if (timerId) clearInterval(timerId);
                                const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
                                node.isSucceeded = true;
                                node.lastDuration = durationSec;
                                node.el.classList.remove('running');
                                node.el.classList.add('completed');
                                if (timeBadge) {
                                    timeBadge.textContent = `${durationSec}s`;
                                    timeBadge.style.color = ''; // Reset possible red warn
                                }
                                addLog('success', `节点已完成: ${nodeTitle}`, `耗时 ${durationSec}s`, { nodeId: nid, inputs, data: node.data });
                                scheduleSave(); // Persist duration
                                completedNodes.add(nid);
                            } catch (err) {
                                if (err.name === 'AbortError') {
                                    node.el.classList.remove('running');
                                    addLog('warning', `节点已中止: ${nodeTitle}`, '用户终止了工作流');
                                    return;
                                }
                                hasNewFailuresInRound = true;
                                node.el.classList.remove('running');
                                node.el.classList.add('error');
                                const errorMsg = err.message || '未知错误';
                                if (timeBadge) timeBadge.textContent = 'Err';
                                addLog('error', `节点失败: ${nodeTitle}`, errorMsg, { nodeId: nid, error: err.stack || err });

                                failedNodes.add(nid);

                                if (!state.autoRetry) {
                                    showToast(`「${nodeTitle}」出错: ${errorMsg}`, 'error', 5000);
                                    terminatedByError = true;
                                    state.isRunning = false;
                                }
                            } finally {
                                if (timerId) clearInterval(timerId);
                                runningNodes.delete(nid);
                            }
                        })();
                    });
                }

                // Wait a small amount for state changes to propagate and UI to breathe
                await new Promise(r => setTimeout(r, 100));
                if (!state.isRunning) break; // User stopped or fatal error
            }

            if (!state.isRunning) break;

            // Check round results
            const actualFailures = order.filter(id => {
                const n = state.nodes.get(id);
                return n && n.enabled !== false && !n.isSucceeded;
            });

            if (actualFailures.length === 0) {
                if (retryAttempt > 0) addLog('success', '工作流并行重试完成', `经过 ${retryAttempt} 次重试后，所有节点已成功执行。`);
                break;
            }

            if (!state.autoRetry) break;

            retryAttempt++;
            if (retryAttempt > maxRetries) {
                showToast(`已达到最大重试次数 (${maxRetries})，停止运行`, 'error');
                addLog('error', '并行工作流强制终止', `已超过设定的最大自动重试次数 (${maxRetries} 轮)，执行已停止。请检查网络稳定性或节点配置。`);
                terminatedByError = true;
                break;
            }

            addLog('warning', `自动重试开始 (第 ${retryAttempt} 轮)`, `${actualFailures.length} 个节点未成功，正在准备重新执行相关分支...`);
            showToast(`正在启动第 ${retryAttempt} 轮自动重试 (${actualFailures.length} 个节点)...`, 'warning', 4000);
            failedNodes.clear(); // Clear failures to allow retry in next round
            await new Promise(r => setTimeout(r, 1500));
            if (!state.isRunning) break;
        }
    } finally {
        if (!state.isRunning) {
            addLog('info', '工作流停止', '用户手动终止了运行流程');
            // Cleanup UI for any running nodes
            for (const nid of runningNodes) {
                const node = state.nodes.get(nid);
                if (node) node.el.classList.remove('running');
            }
        }

        // Wrap up
        for (const [id, n] of state.nodes) {
            if (n.type === 'ImageSave' && n.data.image) {
                const btnSave = n.el.querySelector(`#${id}-manual-save`);
                const btnView = n.el.querySelector(`#${id}-view-full`);
                if (btnSave) btnSave.disabled = false;
                if (btnView) btnView.disabled = false;
            }
        }

        const wasRunning = state.isRunning;
        finalizeWorkflow();

        if (state.notificationsEnabled) {
            const totalDuration = ((Date.now() - totalWorkflowStartTime) / 1000).toFixed(2);
            
            if (terminatedByError) {
                showToast(`工作流运行停止 ✗ 耗时 ${totalDuration}s`, 'error', 6000);
                if (Notification.permission === 'granted') {
                    new Notification('CainFlow 运行出错', { 
                        body: `工作流已停止，部分节点执行失败。耗时 ${totalDuration}s`, 
                        icon: 'data:image/svg+xml;base64,...' 
                    });
                }
                playNotificationSound();
            } else if (state.isRunning || wasRunning) {
                // If it was running and not terminated by error, it means it completed successfully
                showToast(`工作流运行完成 ✓ 总耗时 ${totalDuration}s`, 'success', 6000);
                if (Notification.permission === 'granted') {
                    new Notification('CainFlow 运行完毕', { 
                        body: `所有节点执行成功，总耗时 ${totalDuration}s`, 
                        icon: 'data:image/svg+xml;base64,...' 
                    });
                }
                playNotificationSound();
            } else {
                showToast('已手动停止运行', 'info');
            }
        }
    }
}

const NodeHandlers = {
    'ImageImport': async (node, inputs, signal) => {
        if (!node.imageData) throw new Error('未导入图片');
        node.data.image = node.imageData;
    },
    'ImageGenerate': async (node, inputs, signal) => {
        const { id } = node;
        const errorEl = document.getElementById(`${id}-error`);
        if (errorEl) errorEl.style.display = 'none';

        try {
            const configId = document.getElementById(`${id}-apiconfig`).value;
            const modelCfg = state.models.find(m => m.id === configId);
            if (!modelCfg) throw new Error('未找到选定的模型配置');
            const apiCfg = state.providers.find(p => p.id === modelCfg.providerId);
            if (!apiCfg) throw new Error('未找到绑定的 API 供应商');

            const aspect = document.getElementById(`${id}-aspect`).value;
            const resolution = document.getElementById(`${id}-resolution`).value;
            const searchEnabled = document.getElementById(`${id}-search`).checked;

            // Priority: Input port > Textarea
            const prompt = inputs.prompt || document.getElementById(`${id}-prompt`).value;

            if (!apiCfg.apikey) throw new Error('API 供应商密钥未配置');
            if (!prompt) throw new Error('请输入提示词');

            const parts = [{ text: prompt }];
            for (const key of ['image_1', 'image_2', 'image_3', 'image_4', 'image_5']) {
                if (inputs[key]) {
                    const match = inputs[key].match(/^data:(.+?);base64,(.+)$/);
                    if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
                }
            }

            const requestBody = { contents: [{ parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } };
            const imageConfig = {};
            if (aspect) imageConfig.aspectRatio = aspect;
            if (resolution) imageConfig.imageSize = resolution;
            if (Object.keys(imageConfig).length > 0) requestBody.generationConfig.imageConfig = imageConfig;
            if (searchEnabled) requestBody.tools = [{ googleSearch: {} }];

            const url = apiCfg.autoComplete !== false
                ? `${apiCfg.endpoint.replace(/\/+$/, '')}/v1beta/models/${modelCfg.modelId}:generateContent?key=${apiCfg.apikey}`
                : apiCfg.endpoint;
            showToast(`正在调用 ${modelCfg.name}...`, 'info', 5000);

            const headers = getProxyHeaders(url, 'POST');

            const response = await fetch('/proxy', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestBody),
                signal: signal
            });

            if (!response.ok) {
                const t = await response.text();
                let msg = `API 错误 (${response.status})`;
                try {
                    const json = JSON.parse(t);
                    if (json.error?.message) msg += `: ${json.error.message}`;
                    else msg += `: ${t.substring(0, 100)}`;
                } catch (e) {
                    msg += `: ${t.substring(0, 100)}`;
                }
                throw new Error(msg);
            }

            const result = await response.json();
            if (!result) throw new Error('API 返回了空的 JSON 响应');
            
            let imageData = null;
            if (result.candidates && Array.isArray(result.candidates) && result.candidates[0]) {
                const candidate = result.candidates[0];
                if (candidate.content?.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.inlineData) {
                            imageData = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                            break;
                        }
                    }
                }
                
                // Detailed error parsing for Imagen/Gemini when image is missing
                if (!imageData) {
                    let reason = 'API 未返回图片数据';
                    if (result.error?.message) {
                        reason = `API 错误: ${result.error.message}`;
                    } else if (candidate.finishReason) {
                        const fr = candidate.finishReason;
                        if (fr === 'SAFETY') reason = '⚠️ 内容被安全过滤器拦截 (如有违规提示词或敏感动作)';
                        else if (fr === 'RECITATION') reason = '⚠️ 生成内容由于版权保护被拦截';
                        else reason = `生成停止原因: ${fr}`;
                    } else if (result.promptFeedback?.blockReason || result.promptFeedback?.gemini_block_reason) {
                        const br = result.promptFeedback.blockReason || result.promptFeedback.gemini_block_reason;
                        reason = `🚫 请求被屏蔽: ${br}`;
                        if (br === 'SAFETY') reason = '⚠️ 请求因违反安全政策被系统拦截 (SAFETY)';
                    } else if (result.gemini_block_reason) {
                        reason = `🚫 系统屏蔽: ${result.gemini_block_reason}`;
                    }
                    throw new Error(reason);
                }
            } else if (result.error?.message) {
                throw new Error(`API 错误: ${result.error.message}`);
            } else {
                throw new Error('API 返回了空结果 (无候选内容)');
            }

            node.data.image = imageData;
            showResolutionBadge(id, imageData);

            // Auto record to history
            await saveHistoryEntry({
                nodeId: id,
                image: imageData,
                prompt: prompt,
                model: modelCfg.name
            });
            if (document.getElementById('history-sidebar').classList.contains('active')) renderHistoryList();
        } catch (err) {
            if (errorEl) {
                errorEl.innerHTML = `<strong>生成失败</strong>${err.message}`;
                errorEl.style.display = 'block';
                // Automatically expand node to ensure the error message is visible and doesn't overlap
                fitNodeToContent(id);
            }
            throw err;
        }
    },
    'TextChat': async (node, inputs, signal) => {
        const { id } = node;
        const configId = document.getElementById(`${id}-apiconfig`).value;
        const modelCfg = state.models.find(m => m.id === configId);
        if (!modelCfg) throw new Error('未找到选定的模型配置');
        const apiCfg = state.providers.find(p => p.id === modelCfg.providerId);
        if (!apiCfg) throw new Error('未找到绑定的 API 供应商');

        const sysprompt = document.getElementById(`${id}-sysprompt`).value;
        const prompt = inputs.prompt || document.getElementById(`${id}-prompt`).value;
        
        const fixedToggle = document.getElementById(`${id}-fixed`);
        const isFixed = fixedToggle ? fixedToggle.checked : false;
        
        if (isFixed && node.isSucceeded && node.data && node.data.text) {
            return;
        }

        const responseArea = document.getElementById(`${id}-response`);

        if (!apiCfg.apikey) throw new Error('API 供应商密钥未配置');
        if (!prompt) throw new Error('请输入提问内容');

        showToast(`正在调用 ${modelCfg.name}...`, 'info', 5000);
        responseArea.innerHTML = '<div class="chat-response-placeholder">正在生成回复...</div>';

        try {
            let responseText = '';
            if (apiCfg.type === 'google') {
                const searchEnabled = document.getElementById(`${id}-search`)?.checked || false;
                const parts = [{ text: prompt }];
                for (const key of ['image_1', 'image_2', 'image_3', 'image_4', 'image_5']) {
                    if (inputs[key]) {
                        const match = inputs[key].match(/^data:(.+?);base64,(.+)$/);
                        if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
                    }
                }
                const body = { contents: [{ parts }] };
                if (sysprompt) body.systemInstruction = { parts: [{ text: sysprompt }] };
                if (searchEnabled) body.tools = [{ googleSearch: {} }];

                const url = apiCfg.autoComplete !== false
                    ? `${apiCfg.endpoint.replace(/\/+$/, '')}/v1beta/models/${modelCfg.modelId}:generateContent?key=${apiCfg.apikey}`
                    : apiCfg.endpoint;
                
                const headers = getProxyHeaders(url, 'POST');

                const res = await fetch('/proxy', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(body),
                    signal
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
                const json = await res.json();

                let resultText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (json.candidates?.[0]?.groundingMetadata) {
                    const metadata = json.candidates[0].groundingMetadata;
                    if (metadata.searchEntryPoint?.html) {
                        resultText += `\n\n<div class="search-chips">${metadata.searchEntryPoint.html}</div>`;
                    }
                }
                responseText = resultText;
            } else {
                const messages = [];
                if (sysprompt) messages.push({ role: 'system', content: sysprompt });
                const content = [{ type: 'text', text: prompt }];
                for (const key of ['image_1', 'image_2', 'image_3', 'image_4', 'image_5']) {
                    if (inputs[key]) content.push({ type: 'image_url', image_url: { url: inputs[key] } });
                }
                messages.push({ role: 'user', content });

                let url = apiCfg.endpoint.replace(/\/+$/, '');
                if (apiCfg.autoComplete !== false && !url.endsWith('/chat/completions')) url += '/chat/completions';
                
                const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiCfg.apikey}`, 'x-target-url': url };
                if (state.proxy && state.proxy.enabled) {
                    headers['x-proxy-enabled'] = 'true';
                    headers['x-proxy-host'] = state.proxy.ip;
                    headers['x-proxy-port'] = state.proxy.port;
                }

                const res = await fetch('/proxy', {
                    method: 'POST',
                    headers: { ...headers, 'x-target-method': 'POST' },
                    body: JSON.stringify({ model: modelCfg.modelId, messages }),
                    signal
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
                const json = await res.json();
                responseText = json.choices?.[0]?.message?.content || '';
            }

            if (!responseText) throw new Error('API 未返回文本内容');
            if (window.marked && window.marked.parse) {
                responseArea.innerHTML = marked.parse(responseText);
            } else {
                responseArea.innerText = responseText;
            }
            node.data.text = responseText;
            node.lastResponse = responseArea.innerHTML;
            node.isSucceeded = true;
            
            // Automatically expand node to fit the AI response
            fitNodeToContent(id);
            
            updateAllConnections();
        } catch (err) {
            responseArea.innerHTML = `<div class="chat-response-placeholder" style="color:var(--accent-red)">失败: ${err.message}</div>`;
            throw err;
        }
    },
    'ImagePreview': async (node, inputs, signal) => {
        const { id } = node;
        const imgData = inputs.image;
        const previewContainer = document.getElementById(`${id}-preview`);
        const controls = document.getElementById(`${id}-controls`);
        if (imgData) {
            node.previewZoom = 1;
            previewContainer.innerHTML = `<img src="${imgData}" alt="预览" style="cursor:pointer" draggable="false" />`;
            controls.style.display = 'flex';
            node.data.image = imgData;
            saveImageAsset(id, imgData);
            showResolutionBadge(id, imgData);
        } else {
            previewContainer.innerHTML = `<div class="preview-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>无输入图片</div>`;
            controls.style.display = 'none';
        }
    },
    'ImageSave': async (node, inputs, signal) => {
        const { id } = node;
        const imgData = inputs.image;
        const savePreview = document.getElementById(`${id}-save-preview`);
        if (imgData) {
            node.data.image = imgData;
            savePreview.innerHTML = `<img src="${imgData}" alt="待保存" draggable="false" />`;
            saveImageAsset(id, imgData);
            showResolutionBadge(id, imgData);
            await autoSaveToDir(id, imgData);
        } else {
            savePreview.innerHTML = '<div class="save-preview-placeholder">无输入图片</div>';
        }
    },
    'TextInput': async (node, inputs, signal) => {
        node.data.text = document.getElementById(`${node.id}-text`).value;
    },
    'TextDisplay': async (node, inputs, signal) => {
        const text = inputs.text || '';
        const display = document.getElementById(`${node.id}-display`);
        if (display) {
            display.textContent = text || '目前无输入文本';
            node.data.text = text;
            updateAllConnections();
        }
    }
};

async function executeNode(node, inputs, signal) {
    const handler = NodeHandlers[node.type];
    if (handler) {
        await handler(node, inputs, signal);
    } else {
        console.warn(`No handler defined for node type: ${node.type}`);
    }
}

// ===== Persistence =====
let saveTimer = null;
function scheduleSave() {
    if (state.dragging || state.resizing) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 300);
}

function serializeNodes(includeImages = false) {
    const nodes = [];
    for (const [id, node] of state.nodes) {
        const s = { 
            id, 
            type: node.type, 
            x: node.x, 
            y: node.y, 
            width: node.width || null, 
            height: node.height || null, 
            enabled: node.enabled,
            lastDuration: node.lastDuration || null
        };
        
        if (includeImages && node.imageData) {
            s.imageData = node.imageData;
        }

        if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
            s.apiConfigId = document.getElementById(`${id}-apiconfig`)?.value || 'default';
            s.prompt = document.getElementById(`${id}-prompt`)?.value || '';
            if (node.type === 'ImageGenerate') {
                s.aspect = document.getElementById(`${id}-aspect`)?.value || '';
                s.resolution = document.getElementById(`${id}-resolution`)?.value || '';
                s.search = document.getElementById(`${id}-search`)?.checked || false;
            } else if (node.type === 'TextChat') {
                s.sysprompt = document.getElementById(`${id}-sysprompt`)?.value || '';
                s.search = document.getElementById(`${id}-search`)?.checked || false;
                s.fixed = document.getElementById(`${id}-fixed`)?.checked || false;
                s.lastResponse = node.lastResponse || '';
                s.lastText = node.data?.text || '';
                s.isSucceeded = node.isSucceeded || false;
            }
        }
        if (node.type === 'ImageSave') s.filename = document.getElementById(`${id}-filename`)?.value || 'generated_image';
        if (node.type === 'TextInput') s.text = document.getElementById(`${id}-text`)?.value || '';
        nodes.push(s);
    }
    return nodes;
}

function saveState() {
    try {
        const data = {
            canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom },
            nodes: serializeNodes(),
            connections: state.connections.map(c => ({ id: c.id, from: c.from, to: c.to, type: c.type })),
            providers: state.providers,
            models: state.models,
            notificationsEnabled: state.notificationsEnabled,
            notificationVolume: state.notificationVolume,
            autoRetry: state.autoRetry,
            maxRetries: state.maxRetries,
            imageMaxPixels: state.imageMaxPixels,
            proxy: state.proxy,
            historyGridCols: state.historyGridCols
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn('Save failed:', e);
        if (e.name === 'QuotaExceededError') {
            showToast('浏览器存储空间不足，部分状态可能未保存', 'error', 5000);
        }
    }
}

// ===== Undo / Redo System =====
function pushHistory() {
    const snapshot = {
        nodes: serializeNodes(true), // true means include imageData for memory-based history
        connections: state.connections.map(c => ({ ...c }))
    };
    state.undoStack.push(JSON.stringify(snapshot));
    if (state.undoStack.length > 5) state.undoStack.shift();
    updateUndoButton();
}

function updateUndoButton() {
    const btn = document.getElementById('btn-undo');
    if (btn) btn.disabled = state.undoStack.length === 0;
}

async function undo() {
    if (state.undoStack.length === 0) return;
    
    const raw = state.undoStack.pop();
    const snapshot = JSON.parse(raw);
    
    // Clear current canvas
    state.selectedNodes.clear();
    state.nodes.forEach(n => n.el.remove());
    state.nodes.clear();
    state.connections = [];
    
    // Restore nodes
    if (snapshot.nodes && snapshot.nodes.length) {
        for (const nd of snapshot.nodes) {
            addNode(nd.type, nd.x, nd.y, nd, true);
        }
    }
    
    // Restore connections
    if (snapshot.connections && snapshot.connections.length) {
        state.connections = snapshot.connections;
    }
    
    updateAllConnections();
    updatePortStyles();
    updateUndoButton();
    saveState();
    showToast('已撤回上一步操作', 'info');
}

function getSafeProviders() {
    // Return a copy of providers with apikeys removed for security
    return state.providers.map(p => {
        const { apikey, ...rest } = p;
        return { ...rest, apikey: '' };
    });
}

function exportWorkflow() {
    try {
        const data = {
            canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom },
            nodes: serializeNodes(),
            connections: state.connections.map(c => ({ id: c.id, from: c.from, to: c.to, type: c.type })),
            providers: getSafeProviders(),
            models: state.models,
            version: '1.2'
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const time = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.download = `CainFlow_Project_${time}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('项目已导出 (已自动移除 API 密钥以保护安全)', 'success');
    } catch (e) {
        showToast('导出失败: ' + e.message, 'error');
    }
}

function importWorkflow(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.nodes || !Array.isArray(data.nodes)) throw new Error('无效的 CainFlow 项目文件格式');

            if (confirm('导入将覆盖当前所有画布节点、API及模型设置、连线，确定继续吗？')) {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
                showToast('导入成功，正在重新加载...', 'success');
                setTimeout(() => location.reload(), 800);
            }
        } catch (err) {
            showToast('导入失败: ' + err.message, 'error');
        }
    };
    reader.readAsText(file);
}

async function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (data.apiConfigs && Array.isArray(data.apiConfigs)) {
            // Migration
            const newProviders = [];
            const newModels = [];
            data.apiConfigs.forEach(cfg => {
                const provId = 'prov_' + Math.random().toString(36).substr(2, 9);
                newProviders.push({
                    id: provId,
                    name: cfg.name + ' (授权配置)',
                    type: cfg.type,
                    apikey: cfg.apikey || '',
                    endpoint: cfg.endpoint || ''
                });
                newModels.push({
                    id: cfg.id, // Preserve ID for node compatibility
                    name: cfg.name,
                    modelId: cfg.model || '',
                    providerId: provId
                });
            });
            state.providers = newProviders;
            state.models = newModels;
        } else {
            if (data.providers) state.providers = data.providers;
            if (data.models) state.models = data.models;
        }
        if (data.notificationsEnabled !== undefined) {
            state.notificationsEnabled = data.notificationsEnabled;
            const toggle = document.getElementById('toggle-notifications');
            if (toggle) toggle.checked = state.notificationsEnabled;
        }
        if (data.notificationVolume !== undefined) {
            state.notificationVolume = data.notificationVolume;
        }
        if (data.autoRetry !== undefined) {
            state.autoRetry = data.autoRetry;
            const toggle = document.getElementById('toggle-retry');
            if (toggle) toggle.checked = state.autoRetry;
        }
        if (data.maxRetries !== undefined) {
            state.maxRetries = data.maxRetries;
        }
        if (data.imageMaxPixels !== undefined) {
            state.imageMaxPixels = data.imageMaxPixels;
        }
        if (data.proxy !== undefined) {
            state.proxy = data.proxy;
        }
        if (data.historyGridCols !== undefined) {
            applyHistoryGridCols(data.historyGridCols);
        }
        if (data.canvas) { state.canvas.x = data.canvas.x || 0; state.canvas.y = data.canvas.y || 0; state.canvas.zoom = data.canvas.zoom || 1; }
        
        // Restore global save directory
        const globalHandle = await getHandle('GLOBAL_SAVE_DIR');
        if (globalHandle) {
            state.globalSaveDirHandle = globalHandle;
            addLog('info', '全局保存目录已恢复', `已恢复目录: ${globalHandle.name}`);
        }

        if (data.nodes?.length) {
            for (const nd of data.nodes) addNode(nd.type, nd.x, nd.y, nd);
            await restoreHandles();
        }
        if (data.connections?.length) {
            for (const conn of data.connections) {
                if (state.nodes.has(conn.from.nodeId) && state.nodes.has(conn.to.nodeId)) {
                    if (!conn.id) conn.id = 'c_' + Math.random().toString(36).substr(2, 9);
                    state.connections.push(conn);
                }
            }
            updateAllConnections(); updatePortStyles();
        }
        updateCanvasTransform();
        return data.nodes?.length > 0;
    } catch (e) { console.warn('Load failed:', e); return false; }
}

async function restoreHandles() {
    // We only restore global handle now, which is handled in loadState
}

// ===== Toolbar =====
document.getElementById('btn-run').addEventListener('click', () => runWorkflow());
document.getElementById('btn-stop').addEventListener('click', () => {
    if (state.isRunning) {
        state.isRunning = false;
        state.abortController?.abort();
    }
});
document.getElementById('toggle-retry')?.addEventListener('change', (e) => {
    state.autoRetry = e.target.checked;
    saveState();
});
document.getElementById('btn-save').addEventListener('click', () => {
    saveState();
    showToast('工作流已手动保存', 'success');
});
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-export').addEventListener('click', exportWorkflow);
document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
document.getElementById('import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importWorkflow(e.target.files[0]);
});
document.getElementById('btn-zoom-in').addEventListener('click', () => {
    document.body.classList.add('is-interacting');
    const nz = Math.min(5, state.canvas.zoom * 1.2), cx = canvasContainer.clientWidth / 2, cy = canvasContainer.clientHeight / 2;
    state.canvas.x = cx - (cx - state.canvas.x) * (nz / state.canvas.zoom);
    state.canvas.y = cy - (cy - state.canvas.y) * (nz / state.canvas.zoom);
    state.canvas.zoom = nz; updateCanvasTransform();
    setTimeout(() => document.body.classList.remove('is-interacting'), 300);
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
    document.body.classList.add('is-interacting');
    const nz = Math.max(0.1, state.canvas.zoom * 0.8), cx = canvasContainer.clientWidth / 2, cy = canvasContainer.clientHeight / 2;
    state.canvas.x = cx - (cx - state.canvas.x) * (nz / state.canvas.zoom);
    state.canvas.y = cy - (cy - state.canvas.y) * (nz / state.canvas.zoom);
    state.canvas.zoom = nz; updateCanvasTransform();
    setTimeout(() => document.body.classList.remove('is-interacting'), 300);
});
document.getElementById('btn-zoom-reset').addEventListener('click', () => {
    document.body.classList.add('is-interacting');
    // Center world coordinates (0, 0) in the viewport
    state.canvas.x = canvasContainer.clientWidth / 2;
    state.canvas.y = canvasContainer.clientHeight / 2;
    state.canvas.zoom = 1;
    updateCanvasTransform();
    setTimeout(() => document.body.classList.remove('is-interacting'), 300);
});

function zoomToFit(targetNodes = null) {
    let nodesToFit = targetNodes;
    if (!nodesToFit) {
        nodesToFit = state.selectedNodes.size > 0
            ? Array.from(state.selectedNodes).map(id => state.nodes.get(id)).filter(Boolean)
            : Array.from(state.nodes.values());
    }

    if (nodesToFit.length === 0) {
        // Fallback to origin reset if no nodes exist
        state.canvas.x = canvasContainer.clientWidth / 2;
        state.canvas.y = canvasContainer.clientHeight / 2;
        state.canvas.zoom = 1;
        updateCanvasTransform();
        return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodesToFit.forEach(node => {
        // Use offset dimensions or fallback to 300x200 if not rendered
        const w = node.el.offsetWidth || 300;
        const h = node.el.offsetHeight || 200;
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + w);
        maxY = Math.max(maxY, node.y + h);
    });

    const padding = 60;
    const worldW = (maxX - minX) + padding * 2;
    const worldH = (maxY - minY) + padding * 2;

    const viewW = canvasContainer.clientWidth;
    const viewH = canvasContainer.clientHeight;

    // Calculate best fit zoom, clamped between 0.1 and 2.0
    const zoom = Math.min(viewW / worldW, viewH / worldH, 1.2);
    const finalZoom = Math.max(0.1, zoom);

    state.canvas.zoom = finalZoom;
    state.canvas.x = viewW / 2 - (minX + maxX) / 2 * finalZoom;
    state.canvas.y = viewH / 2 - (minY + maxY) / 2 * finalZoom;

    updateCanvasTransform();
}

document.getElementById('btn-focus-selection').addEventListener('click', () => {
    document.body.classList.add('is-interacting');
    zoomToFit();
    setTimeout(() => document.body.classList.remove('is-interacting'), 300);
});
document.getElementById('btn-clear').addEventListener('click', () => {
    if (state.nodes.size === 0) return showToast('画布已经是空的', 'info');
    if (confirm('确定要清除所有节点和连接吗？')) {
        state.connections = [];
        for (const [, n] of state.nodes) n.el.remove();
        state.nodes.clear(); state.selectedNodes.clear();
        updateAllConnections(); showToast('画布已清除', 'info'); scheduleSave();
    }
});

// ===== Node Copy / Clone =====
function serializeOneNode(nodeId) {
    const node = state.nodes.get(nodeId);
    if (!node) return null;
    const id = nodeId;
    const s = { id, type: node.type, x: node.x, y: node.y, width: node.width || null, height: node.height || null };
    if (node.type === 'ImageImport' || node.type === 'ImagePreview' || node.type === 'ImageSave') {
        s.imageData = node.data.image || node.imageData || null;
    }
    if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
        s.apiConfigId = document.getElementById(`${id}-apiconfig`)?.value || 'default';
        s.prompt = document.getElementById(`${id}-prompt`)?.value || '';
        if (node.type === 'ImageGenerate') {
            s.aspect = document.getElementById(`${id}-aspect`)?.value || '';
            s.resolution = document.getElementById(`${id}-resolution`)?.value || '';
            s.search = document.getElementById(`${id}-search`)?.checked || false;
        } else if (node.type === 'TextChat') {
            s.sysprompt = document.getElementById(`${id}-sysprompt`)?.value || '';
            s.search = document.getElementById(`${id}-search`)?.checked || false;
        }
    }
    if (node.type === 'ImageSave') s.filename = document.getElementById(`${id}-filename`)?.value || 'generated_image';
    if (node.type === 'TextInput') s.text = document.getElementById(`${id}-text`)?.value || '';
    return s;
}

function cloneNodeAt(nodeId, x, y) {
    const data = serializeOneNode(nodeId);
    if (!data) return null;
    data.id = null; // Force new ID
    return addNode(data.type, x, y, data);
}

function copySelectedNode() {
    const selectedIds = Array.from(state.selectedNodes);
    if (selectedIds.length === 0) return showToast('未选中节点', 'warning');

    // Group Serialization: capture all nodes and connections between them
    const nodes = selectedIds.map(id => serializeOneNode(id)).filter(n => !!n);
    if (nodes.length === 0) return;

    // Calculate bounding box for mouse-relative placement
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(n => {
        minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + (n.width || 240)); maxY = Math.max(maxY, n.y + (n.height || 100));
    });

    const internalConnections = state.connections.filter(c =>
        selectedIds.includes(c.from.nodeId) && selectedIds.includes(c.to.nodeId)
    );

    state.clipboard = {
        nodes,
        connections: internalConnections,
        center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
    };
    state.clipboardTimestamp = Date.now();

    showToast(`已复制 ${nodes.length} 个节点`, 'success');
}

function pasteNode() {
    if (!state.clipboard || !state.clipboard.nodes.length) return showToast('剪贴板为空', 'warning');

    const mousePos = state.mouseCanvas;
    const clip = state.clipboard;
    const idMap = new Map(); // oldId -> newId

    // Clear current selection to focus on pasted ones
    state.selectedNodes.forEach(nid => {
        const n = state.nodes.get(nid); if (n) n.el.classList.remove('selected');
    });
    state.selectedNodes.clear();

    // Step 1: Instantiate nodes at relative positions
    clip.nodes.forEach(data => {
        const offsetX = data.x - clip.center.x;
        const offsetY = data.y - clip.center.y;
        const newId = addNode(data.type, mousePos.x + offsetX, mousePos.y + offsetY, { ...data, id: null }, true);
        if (newId) {
            idMap.set(data.id, newId);
            state.selectedNodes.add(newId);
            state.nodes.get(newId).el.classList.add('selected');
        }
    });

    // Step 2: Restore internal connections
    clip.connections.forEach(c => {
        const newFromId = idMap.get(c.from.nodeId);
        const newToId = idMap.get(c.to.nodeId);
        if (newFromId && newToId) {
            state.connections.push({
                id: 'c_' + Math.random().toString(36).substr(2, 9),
                from: { nodeId: newFromId, port: c.from.port },
                to: { nodeId: newToId, port: c.to.port },
                type: c.type
            });
        }
    });

    updateAllConnections();
    updatePortStyles();
    scheduleSave();
    showToast(`已粘贴 ${idMap.size} 个节点`, 'success');
}

// ===== Shortcuts =====
// ===== Log Drawer =====

// ===== Panel Management (Mutual Exclusivity) =====
const PanelManager = {
    panels: {
        history: { id: 'history-sidebar', btn: 'btn-history' },
        workflow: { id: 'workflow-sidebar', btn: 'btn-toggle-workflow' },
        cache: { id: 'cache-sidebar', btn: 'btn-toggle-cache' },
        logs: { id: 'log-drawer', btn: 'btn-logs' }
    },
    toggle(panelKey, onOpen = null) {
        const target = this.panels[panelKey];
        if (!target) return;
        const el = document.getElementById(target.id);
        const isOpen = el?.classList.contains('active');
        
        // Close all others
        Object.keys(this.panels).forEach(key => {
            if (key !== panelKey) this.close(key);
        });
        
        const btn = document.getElementById(target.btn);
        if (isOpen) {
            this.close(panelKey);
        } else {
            el?.classList.add('active');
            btn?.classList.add('active');
            if (onOpen) onOpen();
        }
    },
    close(panelKey) {
        const target = this.panels[panelKey];
        if (!target) return;
        document.getElementById(target.id)?.classList.remove('active');
        document.getElementById(target.btn)?.classList.remove('active');
    },
    closeAll() {
        Object.keys(this.panels).forEach(key => this.close(key));
    }
};

function initUI() {
    const btnHistory = document.getElementById('btn-history');
    const sidebar = document.getElementById('history-sidebar');
    const logDrawer = document.getElementById('log-drawer');

    if (btnHistory && sidebar) {
        btnHistory.addEventListener('click', () => {
            PanelManager.toggle('history', () => {
                renderHistoryList().catch(err => console.error('Failed to render history:', err));
            });
        });
    } else {
        console.warn('History UI elements missing:', { btnHistory: !!btnHistory, sidebar: !!sidebar });
    }

    const btnLogs = document.getElementById('btn-logs');
    if (btnLogs && logDrawer) {
        btnLogs.addEventListener('click', () => {
            PanelManager.toggle('logs', () => {
                btnLogs.classList.remove('has-new-error');
                renderLogs(); // Refresh logs on open
            });
        });
    }

    document.getElementById('btn-close-history')?.addEventListener('click', () => {
        sidebar?.classList.remove('active');
    });

    document.getElementById('btn-clear-history')?.addEventListener('click', async () => {
        if (confirm('确定要清空所有历史记录吗？此操作无法撤销。')) {
            await clearHistory();
            renderHistoryList();
            showToast('历史记录已清空', 'info');
        }
    });

    document.getElementById('btn-close-logs')?.addEventListener('click', () => {
        logDrawer?.classList.remove('active');
    });

    document.getElementById('btn-col-decrease')?.addEventListener('click', () => {
        applyHistoryGridCols(state.historyGridCols - 1);
        saveState();
    });

    document.getElementById('btn-col-increase')?.addEventListener('click', () => {
        applyHistoryGridCols(state.historyGridCols + 1);
        saveState();
    });

    document.getElementById('btn-clear-logs')?.addEventListener('click', () => {
        state.logs = [];
        renderLogs();
        showToast('日志已清空', 'info');
    });

    document.getElementById('btn-copy-error')?.addEventListener('click', () => {
        const title = document.getElementById('error-modal-title').textContent;
        const msg = document.getElementById('error-modal-msg').textContent;
        const detail = document.getElementById('error-modal-detail').textContent;
        const fullText = `【${title}】\n${msg}\n\n详细信息：\n${detail}`;

        navigator.clipboard.writeText(fullText).then(() => {
            showToast('错误信息已复制', 'success');
        }).catch(err => {
            console.error('Copy failed:', err);
            showToast('复制失败', 'error');
        });
    });

    // History Batch Mode
    document.getElementById('btn-history-batch')?.addEventListener('click', () => {
        state.historySelectionMode = true;
        state.selectedHistoryIds.clear();
        document.getElementById('history-batch-toolbar').classList.remove('hidden');
        renderHistoryList();
    });

    document.getElementById('btn-batch-select-all')?.addEventListener('click', async () => {
        const items = await getHistory();
        items.forEach(item => state.selectedHistoryIds.add(item.id));
        renderHistoryList();
    });

    document.getElementById('btn-batch-cancel')?.addEventListener('click', () => {
        state.historySelectionMode = false;
        state.selectedHistoryIds.clear();
        document.getElementById('history-batch-toolbar').classList.add('hidden');
        renderHistoryList();
    });

    document.getElementById('btn-batch-download')?.addEventListener('click', async () => {
        if (state.selectedHistoryIds.size === 0) {
            showToast('请先选择要下载的图片', 'warn');
            return;
        }

        const items = await getHistory();
        const selected = items.filter(item => state.selectedHistoryIds.has(item.id));

        for (const item of selected) {
            downloadImage(item.image, `cainflow_${item.id}.png`);
            await new Promise(r => setTimeout(r, 200));
        }

        showToast(`已开始下载 ${selected.length} 张图片`, 'success');

        state.historySelectionMode = false;
        state.selectedHistoryIds.clear();
        document.getElementById('history-batch-toolbar').classList.add('hidden');
        renderHistoryList();
    });

    document.getElementById('btn-batch-delete')?.addEventListener('click', async () => {
        if (state.selectedHistoryIds.size === 0) {
            showToast('请先选择要删除的记录', 'warn');
            return;
        }

        if (!confirm(`确定要删除选中的 ${state.selectedHistoryIds.size} 条记录吗？\n此操作无法撤销。`)) return;

        const idsToDelete = Array.from(state.selectedHistoryIds);
        await deleteHistoryItems(idsToDelete);

        state.selectedHistoryIds.clear();
        state.historySelectionMode = false;
        document.getElementById('history-batch-toolbar').classList.add('hidden');
        renderHistoryList();
        showToast(`已成功删除 ${idsToDelete.length} 条记录`, 'success');
    });

    // Factory Reset
    document.getElementById('btn-factory-reset')?.addEventListener('click', () => {
        const confirmed = confirm('确定要恢复出厂设置吗？\n这将清空所有画布节点、API配置和图片历史记录，且无法撤销。');
        if (confirmed) {
            // Clear LocalStorage
            localStorage.clear();

            // Delete IndexedDB
            const deleteRequest = indexedDB.deleteDatabase('NodeFlowDB');

            deleteRequest.onsuccess = () => {
                console.log('Database deleted successfully');
                location.reload();
            };

            deleteRequest.onerror = () => {
                console.error('Error deleting database');
                alert('数据库清理失败，请手动清除浏览器缓存。');
                location.reload();
            };

            deleteRequest.onblocked = () => {
                console.warn('Delete blocked');
                alert('数据库清理被阻塞，请关闭其他标签页后重试。');
                location.reload();
            };
        }
    });

    // Workflow Notification Toggle
    document.getElementById('toggle-notifications')?.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        if (enabled && Notification.permission !== 'granted') {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                e.target.checked = false;
                state.notificationsEnabled = false;
                showToast('未开启通知权限，请在浏览器设置中手动允许此网站发送通知', 'warning', 5000);
                saveState();
                return;
            }
        }
        state.notificationsEnabled = enabled;

        // Cleanup audio context if notifications are disabled
        if (!enabled && state.notificationAudio) {
            state.notificationAudio.pause();
            state.notificationAudio.src = '';
            state.notificationAudio = null;
        }

        saveState();
        if (enabled) showToast('运行完成通知已开启 🔔', 'success');
        else showToast('运行完成通知已关闭', 'info');
    });

    // Initialize Workflow Management
    if (typeof initWorkflow === 'function') initWorkflow();
    // Initialize Cache Management
    if (typeof initCache === 'function') initCache();
}

function initCache() {
    const btnToggle = document.getElementById('btn-toggle-cache');
    const cacheSidebar = document.getElementById('cache-sidebar');
    const btnClose = document.getElementById('btn-close-cache');
    const btnClear = document.getElementById('btn-clear-cache');

    if (!btnToggle || !cacheSidebar) return;

    btnToggle.addEventListener('click', () => {
        PanelManager.toggle('cache', () => {
            updateCacheUsage();
        });
    });

    btnClose?.addEventListener('click', () => {
        cacheSidebar.classList.remove('active');
        btnToggle.classList.remove('active');
    });

    btnClear?.addEventListener('click', async () => {
        if (!confirm('确定要清理所有历史记录吗？\n\n这将永久删除浏览器本地存储的历史生成图库，无法撤销！')) return;
        
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_HISTORY, 'readwrite');
            await tx.objectStore(STORE_HISTORY).clear();
            
            showToast('历史生成记录已清空', 'success');
            updateCacheUsage();
            if (document.getElementById('history-sidebar')?.classList.contains('active')) {
                renderHistoryList();
            }
        } catch (e) {
            showToast('历史清理失败: ' + e.message, 'error');
        }
    });

    document.getElementById('btn-clear-assets')?.addEventListener('click', async () => {
        if (!confirm('确定要清理所有节点资产吗？\n\n这会删除画布上目前正在显示的所有图片缓存。清理后刷新页面，图片将变成占位符！')) return;
        
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_ASSETS, 'readwrite');
            await tx.objectStore(STORE_ASSETS).clear();
            
            showToast('当前画布资产已清理', 'success');
            updateCacheUsage();
        } catch (e) {
            showToast('资产清理失败: ' + e.message, 'error');
        }
    });
}

async function updateCacheUsage(force = false) {
    const display = document.getElementById('cache-size-display');
    const historyEl = document.getElementById('usage-history');
    const assetsEl = document.getElementById('usage-assets');
    const localEl = document.getElementById('usage-local');
    if (!display) return;

    try {
        // 1. Total OS-reported usage
        if (navigator.storage && navigator.storage.estimate) {
            const estimate = await navigator.storage.estimate();
            const mb = (estimate.usage / (1024 * 1024)).toFixed(2);
            display.textContent = `${mb} MB`;
        }

        // 2. Category-specific calculation with caching
        if (force) {
            state.cacheSizes[STORE_HISTORY] = null;
            state.cacheSizes[STORE_ASSETS] = null;
        }

        const historySize = await getStoreSizeMB(STORE_HISTORY);
        const assetsSize = await getStoreSizeMB(STORE_ASSETS);
        const localSize = getLocalStorageMB();

        if (historyEl) historyEl.textContent = `${Number(historySize).toFixed(2)} MB`;
        if (assetsEl) assetsEl.textContent = `${Number(assetsSize).toFixed(2)} MB`;
        if (localEl) localEl.textContent = `${Number(localSize).toFixed(2)} MB`;

    } catch (e) {
        display.textContent = '获取失败';
        console.error('Cache audit failed:', e);
    }
}

async function getStoreSizeMB(storeName) {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            let bytes = 0;
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const val = cursor.value;
                    // Rough estimate of serializable size
                    if (typeof val === 'string') bytes += val.length;
                    else bytes += JSON.stringify(val).length;
                    cursor.continue();
                } else {
                    resolve((bytes / (1024 * 1024)).toFixed(2));
                }
            };
            req.onerror = () => resolve("0.00");
        });
    } catch (e) { return "0.00"; }
}

function getLocalStorageMB() {
    let bytes = 0;
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const val = localStorage.getItem(key);
            bytes += (key.length + val.length) * 2; // UTF-16
        }
    } catch (e) {}
    return (bytes / (1024 * 1024)).toFixed(2);
}

// ===== Utilities =====
function downloadImage(dataUrl, filename) {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename || 'cainflow_export.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('已复制到剪贴板', 'success');
    }).catch(err => {
        console.error('Copy failed:', err);
        showToast('复制失败', 'error');
    });
}

// Initialization calls moved to end of file

canvasContainer.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

// ===== Settings Modal (Providers & Models) =====
const settingsModal = document.getElementById('settings-modal');
const providersList = document.getElementById('providers-list');
const modelsList = document.getElementById('models-list');

document.getElementById('btn-settings').addEventListener('click', () => {
    // Reset to first tab
    document.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'api'));
    document.querySelectorAll('.settings-tab-pane').forEach(p => p.classList.toggle('active', p.id === 'settings-tab-api'));

    renderProviders();
    renderModels();
    renderGeneralSettings();
    initProxyPanel();
    settingsModal.classList.remove('hidden');
});
document.getElementById('settings-close').addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });

// Tab switching
document.querySelectorAll('.modal-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetTab = btn.dataset.tab;

        // Update buttons
        document.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Update panes
        document.querySelectorAll('.settings-tab-pane').forEach(p => {
            p.classList.toggle('active', p.id === `settings-tab-${targetTab}`);
        });
    });
});

async function initProxyPanel() {
    const enabledCheck = document.getElementById('proxy-enabled');
    const ipInput = document.getElementById('proxy-ip');
    const portInput = document.getElementById('proxy-port');
    const saveBtn = document.getElementById('btn-test-proxy');
    const fieldsDiv = document.getElementById('proxy-settings-fields');

    try {
        const res = await fetch('/api/proxy');
        if (res.ok) {
            const config = await res.json();
            
            // Reattach event listeners by replacing nodes (to avoid duplicates)
            const newCheck = enabledCheck.cloneNode(true);
            const newIp = ipInput.cloneNode(true);
            const newPort = portInput.cloneNode(true);
            const newTestBtn = saveBtn.cloneNode(true);
            
            enabledCheck.parentNode.replaceChild(newCheck, enabledCheck);
            ipInput.parentNode.replaceChild(newIp, ipInput);
            portInput.parentNode.replaceChild(newPort, portInput);
            saveBtn.parentNode.replaceChild(newTestBtn, saveBtn);

            newCheck.checked = config.enabled;
            newIp.value = config.ip || '127.0.0.1';
            newPort.value = config.port || '7890';

            // Sync with local state if different (migration)
            if (!state.proxy) {
                state.proxy = { ...config };
                saveState();
            }

            const updateFields = () => {
                newIp.disabled = !newCheck.checked;
                newPort.disabled = !newCheck.checked;
                newTestBtn.disabled = !newCheck.checked;
                fieldsDiv.style.opacity = newCheck.checked ? '1' : '0.5';
            };
            updateFields();

            const handleSave = async () => {
                const newConfig = {
                    enabled: newCheck.checked,
                    ip: newIp.value.trim(),
                    port: newPort.value.trim()
                };
                
                // Update local state and save to localStorage
                state.proxy = { ...newConfig };
                saveState();

                try {
                    const postRes = await fetch('/api/proxy', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(newConfig)
                    });
                    if (postRes.ok) {
                        showToast('代理设置已保存并立即生效', 'success');
                    } else {
                        showToast('保存代理设置失败', 'error');
                    }
                } catch(e) {
                    showToast('保存代理设置异常' + e, 'error');
                }
            };

            newTestBtn.addEventListener('click', async () => {
                newTestBtn.disabled = true;
                const originalText = newTestBtn.textContent;
                newTestBtn.textContent = '测试中...';
                
                try {
                    const postRes = await fetch('/api/test_proxy', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ip: newIp.value.trim(), port: newPort.value.trim() })
                    });
                    if (postRes.ok) {
                        const resData = await postRes.json();
                        const latency = resData.latency || 0;
                        showToast(`连通性测试成功！延迟: ${latency}ms (Google)`, 'success');
                    } else {
                        const errText = await postRes.text();
                        showToast('代理连通性测试失败！' + errText, 'error');
                    }
                } catch(e) {
                    showToast('检查请求失败: ' + e, 'error');
                } finally {
                    newTestBtn.textContent = originalText;
                    newTestBtn.disabled = false;
                }
            });

            newCheck.addEventListener('change', () => {
                updateFields();
                handleSave();
            });
            
            newIp.addEventListener('change', handleSave);
            newPort.addEventListener('change', handleSave);
        }
    } catch (e) {
        console.error('Failed to init proxy modal', e);
    }
}

async function syncProxyToServer() {
    if (!state.proxy) return;
    try {
        await fetch('/api/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state.proxy)
        });
        console.log('Restored proxy config from localStorage to server.');
    } catch (e) {
        console.error('Failed to sync proxy state to server on startup:', e);
    }
}

function renderProviders() {
    providersList.innerHTML = '';
    if (state.providers.length === 0) {
        providersList.innerHTML = '<div style="color:var(--text-secondary);text-align:center;padding:20px;font-size:12px;">暂无供应商配置</div>';
        return;
    }

    function getEndpointPreview(type, endpoint, autoComplete) {
        const base = (endpoint || '').replace(/\/+$/, '');
        if (!base) return '请输入 API 地址';
        if (autoComplete === false) return base + '  (直接使用，不补全)';
        if (type === 'google') {
            return base + '/v1beta/models/{模型ID}:generateContent?key=***';
        } else {
            if (base.endsWith('/chat/completions')) return base;
            return base + '/chat/completions';
        }
    }

    state.providers.forEach(prov => {
        const el = document.createElement('div');
        el.className = 'api-config-card';
        el.innerHTML = `
            <div class="card-header">
                <input type="text" class="card-name" value="${prov.name}" placeholder="供应商名称" data-id="${prov.id}" data-field="name" style="background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.2);padding:2px 4px;font-size:14px;color:var(--accent-cyan);width:150px" />
                <div style="display:flex;align-items:center;gap:6px;">
                    <select class="card-type ${prov.type}" data-id="${prov.id}" data-field="type">
                        <option value="google" ${prov.type === 'google' ? 'selected' : ''}>Google</option>
                        <option value="openai" ${prov.type === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
                    </select>
                    ${prov.id !== 'prov_default' ? `<button class="card-btn-delete" data-id="${prov.id}" data-target="provider" title="删除此供应商">×</button>` : ''}
                </div>
            </div>
            <div class="card-row">
                <div class="card-field">
                    <label>API 密钥</label>
                    <div class="password-wrapper">
                        <input type="password" value="${prov.apikey}" placeholder="API Key" data-id="${prov.id}" data-field="apikey" spellcheck="false" />
                        <button class="eye-toggle-btn" data-id="${prov.id}" title="显示/隐藏密钥">
                            <svg class="icon-xs"><use href="#icon-eye"/></svg>
                        </button>
                    </div>
                </div>
                <div class="card-field"><label>API 地址</label><input type="text" value="${prov.endpoint}" placeholder="Endpoint URL" data-id="${prov.id}" data-field="endpoint" /></div>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px;">
                <div class="endpoint-preview" id="ep-preview-${prov.id}" style="font-size:12px;color:var(--text-dim);word-break:break-all;line-height:1.4;opacity:0.75;flex:1;">完整地址：${getEndpointPreview(prov.type, prov.endpoint, prov.autoComplete)}</div>
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-dim);cursor:pointer;white-space:nowrap;flex-shrink:0;">
                    <input type="checkbox" ${prov.autoComplete !== false ? 'checked' : ''} data-id="${prov.id}" data-field="autoComplete" style="accent-color:var(--accent-purple);cursor:pointer;" />
                    自动补全
                </label>
            </div>
        `;
        providersList.appendChild(el);

        // Bind visibility toggle
        const toggleBtn = el.querySelector('.eye-toggle-btn');
        const passInput = el.querySelector('input[data-field="apikey"]');
        if (toggleBtn && passInput) {
            toggleBtn.onclick = () => {
                const isPass = passInput.type === 'password';
                passInput.type = isPass ? 'text' : 'password';
                toggleBtn.innerHTML = `<svg class="icon-xs"><use href="#${isPass ? 'icon-eye-off' : 'icon-eye'}"/></svg>`;
            };
        }
    });

    providersList.querySelectorAll('input, select').forEach(input => {
        const updatePreview = (id) => {
            const prov = state.providers.find(c => c.id === id);
            const previewEl = document.getElementById(`ep-preview-${id}`);
            if (prov && previewEl) {
                previewEl.textContent = '完整地址：' + getEndpointPreview(prov.type, prov.endpoint, prov.autoComplete);
            }
        };

        input.addEventListener('change', (e) => {
            const id = e.target.dataset.id;
            const field = e.target.dataset.field;
            const prov = state.providers.find(c => c.id === id);
            if (prov) {
                if (field === 'type') {
                    prov.type = e.target.value;
                    e.target.className = `card-type ${prov.type}`;
                    if (prov.type === 'google') prov.endpoint = 'https://generativelanguage.googleapis.com';
                    else prov.endpoint = 'https://api.openai.com/v1';
                    renderProviders();
                } else if (field === 'autoComplete') {
                    prov.autoComplete = e.target.checked;
                    updatePreview(id);
                } else {
                    prov[field] = e.target.value;
                }
                saveState();
                renderModels();
                updatePreview(id);
            }
        });

        // Real-time preview update while typing endpoint
        if (input.dataset.field === 'endpoint') {
            input.addEventListener('input', (e) => {
                const id = e.target.dataset.id;
                const prov = state.providers.find(c => c.id === id);
                if (prov) {
                    prov.endpoint = e.target.value;
                    updatePreview(id);
                }
            });
        }
    });

    providersList.querySelectorAll('.card-btn-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (!confirm('确定删除此供应商？绑定的模型可能会失效。')) return;
            state.providers = state.providers.filter(c => c.id !== e.target.dataset.id);
            renderProviders();
            renderModels();
            saveState();
        });
    });
}

function renderModels() {
    modelsList.innerHTML = '';
    if (state.models.length === 0) {
        modelsList.innerHTML = '<div style="color:var(--text-secondary);text-align:center;padding:20px;font-size:12px;">暂无模型配置</div>';
        return;
    }
    state.models.forEach(mod => {
        const el = document.createElement('div');
        el.className = 'api-config-card';
        const providerOptions = state.providers.map(p => `<option value="${p.id}" ${mod.providerId === p.id ? 'selected' : ''}>${p.name}</option>`).join('');
        el.innerHTML = `
            <div class="card-header">
                <input type="text" class="card-name" value="${mod.name}" placeholder="自定义名称(显示在节点)" data-id="${mod.id}" data-field="name" style="background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.2);padding:2px 4px;font-size:14px;color:#a855f7;width:200px" />
                ${mod.id !== 'default' ? `<button class="card-btn-delete" data-id="${mod.id}" data-target="model" title="删除此模型">×</button>` : ''}
            </div>
            <div class="card-row">
                <div class="card-field"><label>模型代码 (Model ID)</label><input type="text" value="${mod.modelId}" placeholder="如 gemini-2.5-flash" data-id="${mod.id}" data-field="modelId" /></div>
                <div class="card-field"><label>绑定供应商</label>
                    <select data-id="${mod.id}" data-field="providerId">
                        <option value="">-- 请选择供应商 --</option>
                        ${providerOptions}
                    </select>
                </div>
            </div>
        `;
        modelsList.appendChild(el);
    });

    modelsList.querySelectorAll('input, select').forEach(input => {
        input.addEventListener('change', (e) => {
            const id = e.target.dataset.id;
            const field = e.target.dataset.field;
            const mod = state.models.find(c => c.id === id);
            if (mod) {
                mod[field] = e.target.value;
                saveState();
                if (field === 'name') updateAllNodeModelDropdowns();
            }
        });
    });

    modelsList.querySelectorAll('.card-btn-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (!confirm('确定删除此模型配置？')) return;
            state.models = state.models.filter(c => c.id !== e.target.dataset.id);
            renderModels();
            updateAllNodeModelDropdowns();
            saveState();
        });
    });
}

function playNotificationSound() {
    if (!state.notificationsEnabled) return;

    const soundPath = 'sounds/Sweet_Resolution_notice.mp3';
    const volume = state.notificationVolume !== undefined ? state.notificationVolume : 1.0;

    if (state.notificationAudio) {
        // Reuse pre-activated audio object to bypass background restrictions
        state.notificationAudio.pause();
        state.notificationAudio.muted = false;
        state.notificationAudio.loop = false;
        state.notificationAudio.src = soundPath;
        state.notificationAudio.volume = volume;
        state.notificationAudio.play().catch(err => {
            console.warn('Background audio recovery failed, trying fallback:', err);
            new Audio(soundPath).play().catch(e => console.error('All play attempts failed:', e));
        });
    } else {
        // Fallback for immediate play if no warm-up exists
        const audio = new Audio(soundPath);
        audio.volume = volume;
        audio.play().catch(err => console.warn('Direct play failed:', err));
    }
}

function renderGeneralSettings() {
    const list = document.getElementById('general-settings');
    const currentSide = Math.round(Math.sqrt(state.imageMaxPixels || 4194304));
    
    // Read update status from persistence
    const updateStatus = localStorage.getItem('cainflow_update_status') || 'unknown';
    const lastCheck = localStorage.getItem('cainflow_last_update_check');
    const latestVer = localStorage.getItem('cainflow_update_version');

    let statusHtml = '';
    const timeStr = lastCheck ? new Date(parseInt(lastCheck)).toLocaleString() : '从未检查';

    if (updateStatus === 'checking') {
        statusHtml = `<span class="update-status-loading">正在检查中...</span>`;
    } else if (updateStatus === 'latest') {
        statusHtml = `<span class="update-status-latest">✅ 当前已是最新版本</span>`;
    } else if (updateStatus === 'new_version') {
        statusHtml = `<span class="update-status-new">🚀 发现新版本: ${latestVer}</span>`;
    } else if (updateStatus === 'error') {
        statusHtml = `<span class="update-status-error">❌ 检查失败 (网络原因)</span>`;
    }

    list.innerHTML = `
        <div style="display: flex; gap: 16px; align-items: stretch; margin-bottom: 16px;">
            <div class="api-config-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">图片处理设置</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
                    <div class="card-field">
                        <label>图片导入自适应缩放阈值 (边长)</label>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <input type="number" id="setting-max-side" value="${currentSide}" placeholder="如 2048" style="flex:1" />
                            <span id="pixels-hint" style="font-size:11px; color:var(--text-dim); min-width:60px;">${(state.imageMaxPixels / 1000000).toFixed(1)} MP</span>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px; line-height: 1.4;">提示：过大图片会自动缩放以提升运行速度。</p>
                    </div>
                </div>
            </div>

            <div class="api-config-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">存储设置</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
                    <div class="card-field">
                        <label>全局图片保存目录</label>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span id="global-dir-badge" style="font-size:12px; color:var(--text-primary); padding:6px 10px; border-radius:6px; flex:1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; ${state.globalSaveDirHandle ? 'background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1);' : 'background:rgba(239, 68, 68, 0.08); border:1px solid rgba(239, 68, 68, 0.2);'}">
                                ${state.globalSaveDirHandle ? `📁 ${state.globalSaveDirHandle.name}` : '<span style="color:var(--accent-red); font-weight:500;">⚠️ 未设置</span>'}
                            </span>
                            <button id="btn-set-global-dir" class="btn btn-secondary btn-xs" style="padding: 4px 8px;">更改</button>
                            ${state.globalSaveDirHandle ? `<button id="btn-clear-global-dir" class="btn btn-ghost btn-xs" style="color:var(--accent-red); padding: 4px 8px;">清除</button>` : ''}
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px; line-height: 1.4;">提示：设置全局目录可统一管理生成的图片。</p>
                    </div>
                </div>
            </div>

            <div class="api-config-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">自动化与重试</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
                    <div class="card-field">
                        <label>最大自动重试次数</label>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <div class="retry-input-group" style="display:flex; align-items:center; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.1); border-radius:6px; overflow:hidden; flex:1;">
                                <button class="btn-retry-step" data-step="-1" style="background:transparent; border:none; color:var(--text-secondary); width:32px; height:32px; cursor:pointer; font-size:16px; transition:all 0.2s; display:flex; align-items:center; justify-content:center;">-</button>
                                <input type="number" id="setting-max-retries" value="${state.maxRetries || 15}" min="1" max="100" style="flex:1; background:transparent; border:none; border-left:1px solid rgba(255,255,255,0.05); border-right:1px solid rgba(255,255,255,0.05); text-align:center; padding:0; height:32px; color:var(--accent-purple); font-weight:600; -moz-appearance: textfield;" />
                                <button class="btn-retry-step" data-step="1" style="background:transparent; border:none; color:var(--text-secondary); width:32px; height:32px; cursor:pointer; font-size:16px; transition:all 0.2s; display:flex; align-items:center; justify-content:center;">+</button>
                            </div>
                            <span style="font-size:11px; color:var(--text-dim); min-width:20px;">轮</span>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px; line-height: 1.4;">提示：初始失败后，最多允许再尝试执行多少轮。</p>
                    </div>
                </div>
            </div>
        </div>

        <div style="display: flex; gap: 16px; align-items: stretch;">
            <div class="api-config-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">通知设置</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
                    <div class="card-field">
                        <label>完成音效音量</label>
                        <div style="display:flex; align-items:center; gap:12px;">
                            <input type="range" id="setting-notify-volume" min="0" max="1" step="0.05" value="${state.notificationVolume}" style="flex:1" />
                            <span id="volume-hint" style="font-size:12px; color:var(--text-dim); min-width:40px;">${Math.round(state.notificationVolume * 100)}%</span>
                            <button id="btn-test-sound" class="btn btn-ghost" style="padding:4px 8px; font-size:11px;">测试音效</button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="api-config-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">系统版本与更新</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
                    <div class="card-field">
                        <label>当前版本与检查结果</label>
                        <div style="display:flex; align-items:center; gap:12px;">
                            <span class="version-badge">${APP_VERSION}</span>
                            <div class="update-status-indicator">${statusHtml}</div>
                            <div style="flex:1"></div>
                            <button id="btn-check-update" class="btn btn-secondary btn-sm">检查更新</button>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px;">最后检查: ${timeStr}</p>
                    </div>
                </div>
            </div>
        </div>
    `;

    const input = document.getElementById('setting-max-side');
    const hint = document.getElementById('pixels-hint');
    const volInput = document.getElementById('setting-notify-volume');
    const volHint = document.getElementById('volume-hint');
    const testBtn = document.getElementById('btn-test-sound');
    const btnCheckUpdate = document.getElementById('btn-check-update');

    const btnSetGlobal = document.getElementById('btn-set-global-dir');
    const btnClearGlobal = document.getElementById('btn-clear-global-dir');

    btnSetGlobal?.addEventListener('click', async () => {
        try {
            const handle = await window.showDirectoryPicker();
            if (handle) {
                state.globalSaveDirHandle = handle;
                await saveHandle('GLOBAL_SAVE_DIR', handle);
                renderGeneralSettings();
                updateImageSaveWarnings(); // Sync all nodes
                showToast('全局保存目录设置成功', 'success');
                addLog('success', '存储设置已变更', `全局目录已设置为: ${handle.name}`);
            }
        } catch (e) {
            if (e.name !== 'AbortError') showToast('设置失败: ' + e.message, 'error');
        }
    });

    btnClearGlobal?.addEventListener('click', async () => {
        state.globalSaveDirHandle = null;
        renderGeneralSettings();
        updateImageSaveWarnings(); // Sync all nodes
        showToast('全局保存目录已清除', 'info');
    });

    volInput.addEventListener('input', (e) => {
        const vol = parseFloat(e.target.value);
        state.notificationVolume = vol;
        volHint.textContent = Math.round(vol * 100) + '%';
        saveState();
    });

    document.getElementById('setting-max-retries')?.addEventListener('change', (e) => {
        const val = parseInt(e.target.value);
        if (val >= 1 && val <= 100) {
            state.maxRetries = val;
            saveState();
        } else {
            e.target.value = state.maxRetries;
        }
    });

    document.querySelectorAll('.btn-retry-step').forEach(btn => {
        btn.onclick = () => {
            const step = parseInt(btn.dataset.step);
            const input = document.getElementById('setting-max-retries');
            if (input) {
                let val = (parseInt(input.value) || 0) + step;
                val = Math.max(1, Math.min(100, val));
                input.value = val;
                state.maxRetries = val;
                saveState();
            }
        };
    });

    testBtn.addEventListener('click', () => {
        playNotificationSound();
    });
    btnCheckUpdate?.addEventListener('click', () => {
        checkUpdate(true);
    });
    input.addEventListener('input', (e) => {
        const side = parseInt(e.target.value) || 0;
        const total = side * side;
        state.imageMaxPixels = total;
        hint.textContent = (total / 1000000).toFixed(1) + ' MP';
        saveState();
    });
}

function updateImageSaveWarnings() {
    const hasDir = !!state.globalSaveDirHandle;
    for (const [id, node] of state.nodes) {
        if (node.type === 'ImageSave') {
            const warning = document.getElementById(`${id}-path-warning`);
            if (warning) {
                warning.style.display = hasDir ? 'none' : 'block';
            }
        }
    }
}

document.getElementById('btn-add-provider').addEventListener('click', () => {
    state.providers.push({
        id: 'prov_' + Math.random().toString(36).substr(2, 9),
        name: '新供应商',
        type: 'google',
        apikey: '',
        endpoint: 'https://generativelanguage.googleapis.com',
        autoComplete: true
    });
    renderProviders();
    renderModels();
    saveState();
});

document.getElementById('btn-add-model').addEventListener('click', () => {
    state.models.push({
        id: 'mod_' + Math.random().toString(36).substr(2, 9),
        name: '新模型配置',
        modelId: '',
        providerId: state.providers.length > 0 ? state.providers[0].id : ''
    });
    renderModels();
    updateAllNodeModelDropdowns();
    saveState();
    setTimeout(() => { document.getElementById('settings-body').scrollTop = 9999; }, 50);
});

function updateAllNodeModelDropdowns() {
    for (const [id, node] of state.nodes) {
        if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
            const select = document.getElementById(`${id}-apiconfig`); // ID on node remains apiconfig for backwards compat
            if (select) {
                const currentVal = select.value;
                select.innerHTML = state.models.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
                if (state.models.find(m => m.id === currentVal)) select.value = currentVal;
                else select.value = state.models.length > 0 ? state.models[0].id : '';
            }
        }
    }
}

// ===== Global Drag-and-Drop & Paste =====
window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length > 0) {
        // If single file dropped on existing ImageImport node, update it
        const targetNodeEl = e.target.closest('.node');
        if (targetNodeEl && files.length === 1) {
            const nodeId = targetNodeEl.id;
            const node = state.nodes.get(nodeId);
            if (node && node.type === 'ImageImport') {
                loadImageFile(nodeId, files[0]);
                showToast('已更新现有的图片节点', 'success');
                return;
            }
        }

        const pos = screenToCanvas(e.clientX, e.clientY);
        files.forEach((file, index) => {
            const nid = addNode('ImageImport', pos.x + index * 20, pos.y + index * 20);
            if (nid) loadImageFile(nid, file);
        });
        showToast(`已通过拖拽添加 ${files.length} 个图片节点`, 'success');
    }
});

// Initialization calls moved to end of file
// ===== History Previewer & Interactions =====
let previewState = { scale: 1, x: 0, y: 0, isDragging: false, startX: 0, startY: 0, items: [], currentIndex: -1 };

async function openHistoryPreview(item) {
    const modal = document.getElementById('history-preview-modal');
    const viewport = document.getElementById('preview-viewport');

    // Fetch full history to enable navigation
    const history = await getHistory();
    previewState.items = history;
    previewState.currentIndex = history.findIndex(h => h.id === item.id);

    updatePreviewContent(item);
    modal.classList.remove('hidden');

    // Reset interaction state
    previewState.scale = 1;
    previewState.x = 0;
    previewState.y = 0;
    previewState.isDragging = false;

    // Auto fit after image loads
    const img = document.getElementById('history-preview-img');
    const fitImage = () => {
        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;

        if (iw && ih) {
            const scale = Math.min((vw - 60) / iw, (vh - 60) / ih, 1);
            previewState.scale = scale;
            previewState.x = 0;
            previewState.y = 0;
            updatePreviewTransform();
        }
    };

    if (img.complete) fitImage();
    else img.onload = fitImage;

    updatePreviewTransform();

    // Close on background click
    modal.onclick = (e) => {
        if (e.target === modal || e.target === viewport) {
            closeHistoryPreview();
        }
    };
    
    document.addEventListener('keydown', onPreviewKeyDown);
}

function updatePreviewContent(item) {
    if (!item) return;
    const img = document.getElementById('history-preview-img');
    const promptText = document.getElementById('preview-prompt');
    const metaText = document.getElementById('preview-meta');
    const btnDownload = document.getElementById('btn-download-preview');
    const btnCopy = document.getElementById('btn-copy-prompt');
    const btnDelete = document.getElementById('btn-delete-preview');

    img.src = item.image;
    promptText.textContent = item.prompt;
    metaText.innerHTML = `
        <span>模型: ${item.model}</span>
        <span>时间: ${new Date(item.timestamp).toLocaleString()}</span>
        <span style="margin-left:auto; opacity:0.6; font-family:monospace;">${previewState.currentIndex + 1} / ${previewState.items.length}</span>
    `;

    btnDownload.onclick = (e) => { e.stopPropagation(); downloadImage(item.image, `cainflow_${item.id}.png`); };
    btnCopy.onclick = (e) => { e.stopPropagation(); copyToClipboard(item.prompt); };
    if (btnDelete) btnDelete.onclick = (e) => { e.stopPropagation(); deleteCurrentPreviewItem(); };

    // Update navigation button states
    const btnPrev = document.getElementById('btn-prev-preview');
    const btnNext = document.getElementById('btn-next-preview');
    if (btnPrev) btnPrev.classList.toggle('disabled', previewState.currentIndex <= 0);
    if (btnNext) btnNext.classList.toggle('disabled', previewState.currentIndex >= previewState.items.length - 1);
}

function navigateHistory(direction) {
    const newIndex = previewState.currentIndex + direction;
    if (newIndex >= 0 && newIndex < previewState.items.length) {
        previewState.currentIndex = newIndex;
        const item = previewState.items[newIndex];

        // Reset transform for new image
        previewState.scale = 1;
        previewState.x = 0;
        previewState.y = 0;

        updatePreviewContent(item);

        const img = document.getElementById('history-preview-img');
        const viewport = document.getElementById('preview-viewport');
        
        const applyFit = () => {
            const scale = Math.min((viewport.clientWidth - 60) / (img.naturalWidth || 100), (viewport.clientHeight - 60) / (img.naturalHeight || 100), 1);
            previewState.scale = scale;
            updatePreviewTransform();
        };

        if (img.complete) setTimeout(applyFit, 50);
        else img.onload = applyFit;
    }
}

function onPreviewKeyDown(e) {
    if (e.key === 'Escape') {
        closeHistoryPreview();
    } else if (e.key === 'ArrowLeft') {
        navigateHistory(-1);
    } else if (e.key === 'ArrowRight') {
        navigateHistory(1);
    } else if (e.key === 'Delete') {
        deleteCurrentPreviewItem();
    }
}

async function deleteCurrentPreviewItem() {
    const item = previewState.items[previewState.currentIndex];
    if (!item) return;

    if (confirm('确定要从历史记录中删除这张图片吗？\n此操作无法撤销。')) {
        await deleteHistoryEntry(item.id);
        showToast('已从历史记录中删除', 'info');

        // Update local items array
        previewState.items.splice(previewState.currentIndex, 1);

        if (previewState.items.length === 0) {
            closeHistoryPreview();
        } else {
            // Fix index if we deleted the last item
            if (previewState.currentIndex >= previewState.items.length) {
                previewState.currentIndex = previewState.items.length - 1;
            }
            updatePreviewContent(previewState.items[previewState.currentIndex]);
        }

        // Always refresh the sidebar list
        renderHistoryList();
    }
}

function closeHistoryPreview() {
    const modal = document.getElementById('history-preview-modal');
    if (modal) modal.classList.add('hidden');
    document.removeEventListener('keydown', onPreviewKeyDown);
}

// ===== History Operations =====
async function deleteHistoryItems(ids) {
    if (!ids || ids.length === 0) return;
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_HISTORY, 'readwrite');
        const store = tx.objectStore(STORE_HISTORY);
        ids.forEach(id => store.delete(id));
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.error('Delete history items failed:', e); }
}

function updatePreviewTransform() {
    const img = document.getElementById('history-preview-img');
    if (img) img.style.transform = `translate(${previewState.x}px, ${previewState.y}px) scale(${previewState.scale})`;
}

const previewViewport = document.getElementById('preview-viewport');
if (previewViewport) {
    previewViewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        previewState.scale = Math.max(0.1, Math.min(20, previewState.scale * delta));
        updatePreviewTransform();
    }, { passive: false });

    previewViewport.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        previewState.isDragging = true;
        previewState.startX = e.clientX - previewState.x;
        previewState.startY = e.clientY - previewState.y;
    });

    window.addEventListener('mousemove', (e) => {
        if (!previewState.isDragging) return;
        previewState.x = e.clientX - previewState.startX;
        previewState.y = e.clientY - previewState.startY;
        updatePreviewTransform();
    });

    window.addEventListener('mouseup', () => {
        previewState.isDragging = false;
    });
}

document.getElementById('btn-close-preview')?.addEventListener('click', closeHistoryPreview);

document.getElementById('btn-prev-preview')?.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateHistory(-1);
});

document.getElementById('btn-next-preview')?.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateHistory(1);
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.getElementById('history-preview-modal')?.classList.add('hidden');
        document.getElementById('history-sidebar')?.classList.remove('active');
        document.getElementById('log-drawer')?.classList.remove('active');
    }
});

let lastExternalPasteTime = 0;
// Consolidated paste listener to prevent double-firing
document.addEventListener('paste', (e) => {
    // Phase 1: Throttling & Priority
    const now = Date.now();
    if (now - lastExternalPasteTime < 500) return;
    lastExternalPasteTime = now;

    const active = document.activeElement;
    if (active && (['INPUT', 'TEXTAREA'].includes(active.tagName) || active.isContentEditable)) return;

    const data = e.clipboardData;
    if (!data) return;

    // Phase 2: Atomic capture
    const items = Array.from(data.items);
    let imageFile = null;
    let textContent = data.getData('text/plain');

    for (const item of items) {
        if (item.kind === 'file' && item.type.includes('image')) {
            imageFile = item.getAsFile();
            if (imageFile) break;
        }
    }

    const pos = state.mouseCanvas || {
        x: (window.innerWidth / 2 - state.canvas.x) / state.canvas.zoom,
        y: (window.innerHeight / 2 - state.canvas.y) / state.canvas.zoom
    };

    // Phase 3: Chronological Priority Execution
    // Determine if internal clipboard is newer than the last time the window was blurred (likely external copy)
    const isInternalNewer = state.clipboard && state.clipboardTimestamp > state.lastFocusTime;

    if (isInternalNewer) {
        // Internal Nodes take precedence if they were copied after the last window focus change
        e.preventDefault();
        e.stopImmediatePropagation();
        pasteNode();
    } else if (imageFile) {
        // Otherwise, standard system clipboard priority: Image > Nodes (Fallback) > Text
        e.preventDefault();
        e.stopImmediatePropagation();
        
        // Priority check: If a single 'ImageImport' node is selected, paste into it directly
        let targetNodeId = null;
        if (state.selectedNodes.size === 1) {
            const selectedId = Array.from(state.selectedNodes)[0];
            const node = state.nodes.get(selectedId);
            if (node && node.type === 'ImageImport') {
                targetNodeId = selectedId;
            }
        }

        if (targetNodeId) {
            loadImageFile(targetNodeId, imageFile);
            showToast('图片已导入选中的节点', 'success');
        } else {
            const nodeId = addNode('ImageImport', pos.x, pos.y, null, true);
            if (nodeId) {
                loadImageFile(nodeId, imageFile);
                showToast('已从剪贴板导入图片', 'success');
            }
        }
    } else if (state.clipboard && state.clipboard.nodes.length > 0) {
        // Fallback to internal nodes if no image but nodes exist
        e.preventDefault();
        e.stopImmediatePropagation();
        pasteNode();
    } else if (textContent && textContent.trim().length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const nodeId = addNode('TextInput', pos.x, pos.y, null, true);
        if (nodeId) {
            const textEl = document.getElementById(`${nodeId}-text`);
            if (textEl) { textEl.value = textContent; textEl.dispatchEvent(new Event('change')); }
            showToast('已从剪贴板导入文本', 'success');
            scheduleSave();
        }
    }
});

// ===== Workflow Management Logic =====
async function fetchWorkflows() {
    try {
        const res = await fetch('/api/workflows');
        if (!res.ok) throw new Error('读取工作流列表失败');
        return await res.json();
    } catch (e) {
        console.error(e);
        return [];
    }
}

async function saveWorkflowToFile(name, data) {
    try {
        const res = await fetch('/api/workflows/' + encodeURIComponent(name), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error('保存工作流失败');
        return true;
    } catch (e) {
        showToast(e.message, 'error');
        return false;
    }
}

async function loadWorkflowFromFile(name) {
    try {
        const res = await fetch('/api/workflows/' + encodeURIComponent(name));
        if (!res.ok) throw new Error('读取工作流文件失败');
        return await res.json();
    } catch (e) {
        showToast(e.message, 'error');
        return null;
    }
}

async function deleteWorkflowFile(name) {
    try {
        const res = await fetch('/api/workflows/' + encodeURIComponent(name), { method: 'DELETE' });
        if (!res.ok) throw new Error('删除工作流失败');
        return true;
    } catch (e) {
        showToast(e.message, 'error');
        return false;
    }
}

async function renameWorkflowFile(oldName, newName) {
    try {
        const res = await fetch('/api/workflows/' + encodeURIComponent(oldName), {
            method: 'POST',
            headers: { 'x-rename-to': newName }
        });
        if (!res.ok) throw new Error('重命名失败');
        return true;
    } catch (e) {
        showToast(e.message, 'error');
        return false;
    }
}

async function renderWorkflowList() {
    const list = document.getElementById('workflow-list');
    const names = await fetchWorkflows();
    if (!list) return;

    if (names.length === 0) {
        list.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding: 20px; font-size:12px;">暂无保存的工作流</div>';
        return;
    }

    list.innerHTML = names.map(name => `
        <div class="workflow-item" data-name="${name}">
            <span class="workflow-item-name">${name}</span>
            <div class="workflow-item-actions">
                <button class="workflow-action-btn load-btn" title="加载">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
                </button>
                <button class="workflow-action-btn delete delete-btn" title="删除">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </div>
        </div>
    `).join('');

    list.querySelectorAll('.workflow-item').forEach(item => {
        const name = item.dataset.name;
        item.addEventListener('click', async (e) => {
            if (e.target.closest('.workflow-action-btn')) return;
            const data = await loadWorkflowFromFile(name);
            if (data && confirm('确定要加载工作流「' + name + '」吗？这将覆盖当前画布。')) {
                applyWorkflowData(data);
                showToast('已加载工作流: ' + name, 'success');
            }
        });

        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const menu = document.getElementById('workflow-context-menu');
            if (!menu) return;
            menu.dataset.targetName = name;
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';
            menu.classList.remove('hidden');
        });

        item.querySelector('.load-btn').onclick = (e) => {
            e.stopPropagation();
            item.click();
        };

        item.querySelector('.delete-btn').onclick = async (e) => {
            e.stopPropagation();
            if (confirm('确定要删除工作流「' + name + '」吗？')) {
                if (await deleteWorkflowFile(name)) {
                    showToast('已删除', 'info');
                    renderWorkflowList();
                }
            }
        };
    });
}

function applyWorkflowData(data) {
    state.connections = [];
    for (const [, n] of state.nodes) n.el.remove();
    state.nodes.clear();
    state.selectedNodes.clear();

    if (data.providers) {
        let missingKeys = 0;
        // Merge strategy: Preserve local apikeys for matched provider IDs
        const existingMap = new Map(state.providers.map(p => [p.id, p]));
        state.providers = data.providers.map(newP => {
            const oldP = existingMap.get(newP.id);
            if (oldP && oldP.apikey) return { ...newP, apikey: oldP.apikey };
            missingKeys++;
            return { ...newP, apikey: '' }; // Ensure apikey field exists even if empty
        });

        if (missingKeys > 0) {
            showToast(`检测到 ${missingKeys} 个 API 供应商缺少密钥，请在设置中配置以正常运行`, 'warning', 8000);
        }
    }
    if (data.models) state.models = data.models;
    if (data.canvas) {
        state.canvas.x = data.canvas.x || 0;
        state.canvas.y = data.canvas.y || 0;
        state.canvas.zoom = data.canvas.zoom || 1;
    }

    if (data.nodes?.length) {
        for (const nd of data.nodes) addNode(nd.type, nd.x, nd.y, nd);
    }

    if (data.connections?.length) {
        for (const conn of data.connections) {
            if (state.nodes.has(conn.from.nodeId) && state.nodes.has(conn.to.nodeId)) {
                if (!conn.id) conn.id = 'c_' + Math.random().toString(36).substr(2, 9);
                state.connections.push(conn);
            }
        }
    }
    updateAllConnections();
    updatePortStyles();
    updateCanvasTransform();
    scheduleSave();
}

async function ensureDefaultWorkflow() {
    const names = await fetchWorkflows();
    if (!names.includes('Default')) {
        // Strip apikeys for security
        const safeProviders = state.providers.map(p => { const { apikey, ...rest } = p; return rest; });
        const defaultData = {
            canvas: { x: 0, y: 0, zoom: 1 },
            nodes: [
                { id: 'n_prompt', type: 'TextInput', x: 100, y: 150, width: 240, height: 160, text: 'A futuristic city at sunset, cinematic lighting, 8k resolution' },
                { id: 'n_gen', type: 'ImageGenerate', x: 450, y: 100, width: 260, height: 480, apiConfigId: state.models[0]?.id || 'default' },
                { id: 'n_prev', type: 'ImagePreview', x: 800, y: 150, width: 300, height: 350 }
            ],
            connections: [
                { id: 'c_p_g', from: { nodeId: 'n_prompt', port: 'text' }, to: { nodeId: 'n_gen', port: 'prompt' }, type: 'text' },
                { id: 'c_g_p', from: { nodeId: 'n_gen', port: 'image' }, to: { nodeId: 'n_prev', port: 'image' }, type: 'image' }
            ],
            providers: safeProviders,
            models: state.models,
            version: '1.2'
        };
        await saveWorkflowToFile('Default', defaultData);
    }
}

function initWorkflow() {
    const btnToggle = document.getElementById('btn-toggle-workflow');
    const workflowSidebar = document.getElementById('workflow-sidebar');
    const btnClose = document.getElementById('btn-close-workflow');
    const btnSave = document.getElementById('btn-save-workflow');
    const inputName = document.getElementById('input-workflow-name');

    if (!btnToggle) return;

    btnToggle.addEventListener('click', () => {
        PanelManager.toggle('workflow', () => {
            renderWorkflowList();
        });
    });

    btnClose?.addEventListener('click', () => {
        PanelManager.close('workflow');
    });

    btnSave?.addEventListener('click', async () => {
        const name = inputName.value.trim();
        if (!name) return showToast('请输入工作流名称', 'warning');

        // Strip apikeys for security
        const safeProviders = state.providers.map(p => { const { apikey, ...rest } = p; return rest; });

        const data = {
            canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom },
            nodes: serializeNodes(),
            connections: state.connections.map(c => ({ id: c.id, from: c.from, to: c.to, type: c.type })),
            providers: safeProviders,
            models: state.models,
            version: '1.2'
        };

        if (await saveWorkflowToFile(name, data)) {
            showToast('工作流「' + name + '」已保存', 'success');
            inputName.value = '';
            renderWorkflowList();
        }
    });

    const menu = document.getElementById('workflow-context-menu');
    document.getElementById('menu-rename-workflow')?.addEventListener('click', async () => {
        const oldName = menu.dataset.targetName;
        const newName = prompt('重命名工作流:', oldName);
        if (newName && newName !== oldName) {
            if (await renameWorkflowFile(oldName, newName.trim())) {
                showToast('已重命名', 'success');
                renderWorkflowList();
            }
        }
        menu.classList.add('hidden');
    });

    document.getElementById('menu-delete-workflow')?.addEventListener('click', async () => {
        const name = menu.dataset.targetName;
        if (confirm('确定要删除工作流「' + name + '」吗？')) {
            if (await deleteWorkflowFile(name)) {
                showToast('已删除', 'info');
                renderWorkflowList();
            }
        }
        menu.classList.add('hidden');
    });

    window.addEventListener('click', () => menu?.classList.add('hidden'));
    ensureDefaultWorkflow();
}

// ===== Initial Execution =====
document.addEventListener('DOMContentLoaded', async () => {
    console.log('CainFlow Initializing...');
    try {
        initUI();
        const restored = await loadState();
        if (restored) {
            showToast('已从本地存储恢复工作状态', 'success');
            // Restore proxy config to background server immediately
            syncProxyToServer();
        } else if (state.nodes.size === 0) {
            // No saved nodes, try to load default
            const defaultData = await loadWorkflowFromFile('Default');
            if (defaultData) {
                applyWorkflowData(defaultData);
                showToast('已自动加载默认工作流', 'info');
            } else {
                updateCanvasTransform();
            }
        }
        console.log('CainFlow Initialized successfully.');
        
        // Check for updates after a short delay to not block startup
        setTimeout(checkUpdate, 3000);
        checkRefreshNotice();
    } catch (e) {
        console.error('CainFlow Initialization Failed:', e);
        showToast('初始化失败，请查看控制台日志', 'error');
    }
});

document.addEventListener('keydown', (e) => {
    const a = document.activeElement;
    const inInput = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
    const hasTextSelection = window.getSelection().toString().length > 0;

    // Space Key Panning Support
    if (e.code === 'Space' && !inInput) {
        if (!state.isSpacePressed) {
            state.isSpacePressed = true;
            canvasContainer.classList.add('space-pan-active');
        }
        // Prevent page scrolling on space
        if (e.target === document.body || e.target === canvasContainer) e.preventDefault();
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A') && !inInput && state.isMouseOverCanvas) {
        e.preventDefault();
        selectAllNodes();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runWorkflow(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveState(); showToast('工作流已保存', 'success'); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'e') { e.preventDefault(); exportWorkflow(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); document.getElementById('import-file').click(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !inInput && !hasTextSelection) { e.preventDefault(); copySelectedNode(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undo();
    }
    
    // Ctrl+V for nodes: We now handle this in the 'paste' event listener to avoid blocking system clipboard (images/text)
    
    if (e.key === 'Delete' && state.selectedNodes.size > 0 && !inInput) {
        Array.from(state.selectedNodes).forEach(id => removeNode(id));
    }
    if ((e.key === 'f' || e.key === 'F') && !inInput) {
        e.preventDefault();
        zoomToFit();
    }
    if (e.key === 'Escape') {
        contextMenu.classList.add('hidden');
        state.selectedNodes.forEach(nid => {
            const n = state.nodes.get(nid); if (n) n.el.classList.remove('selected');
        });
        state.selectedNodes.clear();
    }
});

document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
        state.isSpacePressed = false;
        canvasContainer.classList.remove('space-pan-active');
    }
});

// Window focus tracking for chronological paste priority
window.addEventListener('focus', () => { state.lastFocusTime = Date.now(); });
window.addEventListener('blur', () => { 
    state.lastFocusTime = Date.now(); 
    state.isSpacePressed = false;
    canvasContainer.classList.remove('space-pan-active');
});
window.addEventListener('load', () => { state.lastFocusTime = Date.now(); });

// ===== Help Panel Integration =====
const helpContent = `
    <div class="help-section">
        <h4>⌨️ 核心快捷键</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-key">Ctrl + Enter</span><span class="help-desc">运行工作流</span></div>
            <div class="help-item"><span class="help-key">Ctrl + S</span><span class="help-desc">保存工作流</span></div>
            <div class="help-item"><span class="help-key">Ctrl + Z</span><span class="help-desc">撤销操作</span></div>
            <div class="help-item"><span class="help-key">Delete</span><span class="help-desc">删除选中节点</span></div>
            <div class="help-item"><span class="help-key">F</span><span class="help-desc">自适应缩放视图</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>🖱️ 鼠标与画布</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">右键画布</span><span class="help-key">添加节点菜单</span></div>
            <div class="help-item"><span class="help-desc">中键/空格+左键</span><span class="help-key">平移画布</span></div>
            <div class="help-item"><span class="help-desc">滚轮</span><span class="help-key">缩放视图</span></div>
            <div class="help-item"><span class="help-desc">双击连接线</span><span class="help-key">添加路由点</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>🔗 节点协作</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">拖拽圆点</span><span class="help-key">创建/断开连接</span></div>
            <div class="help-item"><span class="help-desc">右键节点</span><span class="help-key">旁路/复制/删除</span></div>
            <div class="help-item"><span class="help-desc">Ctrl+拖拽</span><span class="help-key">克隆节点</span></div>
        </div>
    </div>
    <div class="help-tip">
        <div>配合“自动重试”功能，可大幅提升生图成功率。</div>
        <div style="margin-top: 4px; color: var(--accent-orange); opacity: 0.9;">提示：建议使用 <span class="help-key" style="color: var(--accent-orange); border-color: rgba(245, 158, 11, 0.3);">Ctrl + F5</span> 进行强制刷新以获取最新版本。</div>
    </div>
`;

function toggleHelpPanel() {
    const panel = document.getElementById('help-panel');
    const content = document.getElementById('help-panel-content');
    const btnHelp = document.getElementById('btn-help');
    
    if (panel.classList.contains('hidden')) {
        content.innerHTML = helpContent;
        panel.classList.remove('hidden');
        btnHelp?.classList.add('active');
        
        // Auto-close others if needed
        const historySidebar = document.getElementById('history-sidebar');
        if (historySidebar && !historySidebar.classList.contains('hidden')) {
            closeHistorySidebar?.();
        }
    } else {
        closeHelpPanel();
    }
}

function closeHelpPanel() {
    const panel = document.getElementById('help-panel');
    const btnHelp = document.getElementById('btn-help');
    panel.classList.add('hidden');
    btnHelp?.classList.remove('active');
}

// Bind Help Listeners
document.getElementById('btn-help')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleHelpPanel();
});

document.getElementById('btn-close-help')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeHelpPanel();
});

// Close on canvas click or Escape
canvasContainer.addEventListener('mousedown', (e) => {
    if (e.target === canvasContainer || e.target === nodesLayer) {
        closeHelpPanel();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeHelpPanel();
    }
});

// Refresh Notice Dimissal
document.querySelector('.notice-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('refresh-notice').classList.add('hidden');
    localStorage.setItem('cainflow_refresh_notice_dismissed', 'true');
});

// Check if refresh notice was dismissed
function checkRefreshNotice() {
    if (localStorage.getItem('cainflow_refresh_notice_dismissed') === 'true') {
        const notice = document.getElementById('refresh-notice');
        if (notice) notice.classList.add('hidden');
    }
}


