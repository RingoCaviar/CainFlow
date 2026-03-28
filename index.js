/**
 * CainFlow — Node-based AI Image Generation Tool
 * Canvas, nodes, connections, execution engine, localStorage persistence
 */

// ===== Utility =====
function generateId() {
    return 'n_' + Math.random().toString(36).substr(2, 9);
}

function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
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
function processImageResolution(dataUrl, maxTotalPixels = 2048 * 2048) {
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
    }
}

function renderLogs() {
    const list = document.getElementById('log-list');
    if (state.logs.length === 0) {
        list.innerHTML = '<div class="log-empty">暂无执行记录</div>';
        return;
    }
    list.innerHTML = state.logs.map(log => `
        <div class="log-item ${log.type}" onclick="showLogDetail('${log.id}')">
            <div class="log-item-header">
                <span class="log-status">${log.type === 'success' ? '成功' : (log.type === 'error' ? '错误' : (log.type === 'warning' ? '警告' : '信息'))}</span>
                <span class="log-time">${log.time}</span>
            </div>
            <div class="log-title">${log.title}</div>
            <div class="log-message">${log.message}</div>
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

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
            if (!db.objectStoreNames.contains(STORE_ASSETS)) db.createObjectStore(STORE_ASSETS);
            if (!db.objectStoreNames.contains(STORE_HISTORY)) db.createObjectStore(STORE_HISTORY, { keyPath: 'id', autoIncrement: true });
        };
        req.onsuccess = () => resolve(req.result);
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
    if (!dataUrl || dataUrl.length < 100) return; // Don't save placeholders
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_ASSETS, 'readwrite');
        tx.objectStore(STORE_ASSETS).put(dataUrl, nodeId);
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
        const db = await openDB();
        const tx = db.transaction(STORE_HISTORY, 'readwrite');
        tx.objectStore(STORE_HISTORY).add({ ...data, thumb, timestamp: Date.now() });
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
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.warn('IDB clear history failed:', e); }
}

async function deleteHistoryEntry(id) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_HISTORY, 'readwrite');
        tx.objectStore(STORE_HISTORY).delete(id);
        return new Promise((res) => tx.oncomplete = () => res(true));
    } catch (e) { console.warn('IDB delete history failed:', e); }
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
    clipboard: null,
    mouseCanvas: { x: 0, y: 0 },
    selectedNodes: new Set(),
    historySelectionMode: false,
    selectedHistoryIds: new Set(),
    providers: [
        { id: 'prov_gxp', name: 'GXP', type: 'google', apikey: '', endpoint: 'https://www.6789api.top/' }
    ],
    models: [
        { id: 'model_banana', name: 'Banana Pro 2', modelId: 'gemini-3.1-flash-image-preview', providerId: 'prov_gxp' },
        { id: 'model_chat', name: '对话', modelId: 'gemini-3-flash-preview', providerId: 'prov_gxp' }
    ],
    logs: [],
    justDragged: false,
    abortController: null
};

// Directory handles for Save nodes (not serializable)
const dirHandles = new Map();

const STORAGE_KEY = 'nodeflow_ai_state';

const canvasContainer = document.getElementById('canvas-container');
const nodesLayer = document.getElementById('nodes-layer');
const connectionsGroup = document.getElementById('connections-group');
const tempConnection = document.getElementById('temp-connection');
const contextMenu = document.getElementById('context-menu');

// ===== Canvas System =====
function updateCanvasTransform() {
    const { x, y, zoom } = state.canvas;
    nodesLayer.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
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

    // Focus Management: Blur any active inputs when clicking the workspace background
    if (e.target === canvasContainer || e.target === nodesLayer || e.target.id === 'connections-layer') {
        if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
            document.activeElement.blur();
        }
    }

    // Canvas Logic: Panning vs Selection
    // Pan: Middle button (1) OR Alt + Left Click (0)
    const isPanAction = e.button === 1 || (e.button === 0 && e.altKey);
    // Marquee: Left click (0) on background
    const isMarqueeAction = e.button === 0 && e.target === canvasContainer;

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
            
            // Remove max-height caps on image containers so they fill the space
            node.el.querySelectorAll('.preview-container, .save-preview-container, .file-drop-zone').forEach(c => {
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
        if (Math.sqrt(dx*dx + dy*dy) > 5) state.connecting.dragged = true;
        
        drawTempConnection(state.connecting.startX, state.connecting.startY,
            (e.clientX - rect.left - x) / zoom, (e.clientY - rect.top - y) / zoom);
    }
});

window.addEventListener('mouseup', (e) => {
    document.body.classList.remove('is-interacting');
    document.getElementById('connections-group').classList.remove('is-interacting');
    if (state.canvas.isPanning) { state.canvas.isPanning = false; canvasContainer.classList.remove('grabbing'); }
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

canvasContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvasContainer.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const oldZoom = state.canvas.zoom;
    const newZoom = Math.max(0.1, Math.min(5, oldZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    state.canvas.x = mx - (mx - state.canvas.x) * (newZoom / oldZoom);
    state.canvas.y = my - (my - state.canvas.y) * (newZoom / oldZoom);
    state.canvas.zoom = newZoom;
    updateCanvasTransform();
}, { passive: false });

// ===== Context Menu =====
canvasContainer.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    state.contextMenu = { x: e.clientX, y: e.clientY };
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
        const pos = screenToCanvas(state.contextMenu.x, state.contextMenu.y);
        addNode(item.dataset.type, pos.x, pos.y);
        contextMenu.classList.add('hidden');
    });
});

// ===== Node Configs =====
const NODE_CONFIGS = {
    ImageImport: {
        title: '图片导入', cssClass: 'node-import',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
        inputs: [], outputs: [{ name: 'image', type: 'image', label: '图片输出' }]
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
            { name: 'image_3', type: 'image', label: '参考图 3' }
        ],
        outputs: [{ name: 'text', type: 'text', label: '回复文本' }]
    },
    TextInput: {
        title: '文本输入', cssClass: 'node-text-in',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
        inputs: [], outputs: [{ name: 'text', type: 'text', label: '文本输出' }]
    },
    TextDisplay: {
        title: '文本显示', cssClass: 'node-text-out',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
        inputs: [{ name: 'text', type: 'text', label: '文本输入' }], outputs: []
    },
    ImagePreview: {
        title: '图片预览', cssClass: 'node-preview',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
        inputs: [{ name: 'image', type: 'image', label: '图片输入' }], outputs: []
    },
    ImageSave: {
        title: '图片保存', cssClass: 'node-save',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        inputs: [{ name: 'image', type: 'image', label: '图片输入' }], outputs: []
    }
};

// ===== Node Creation =====
function addNode(type, x, y, restoreData, silent = false) {
    const config = NODE_CONFIGS[type];
    if (!config) return;
    const id = (restoreData && restoreData.id) ? restoreData.id : generateId();
    const el = document.createElement('div');
    el.className = `node ${config.cssClass}`;
    el.id = id;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (restoreData && restoreData.width) el.style.width = restoreData.width + 'px';
    if (restoreData && restoreData.height) el.style.height = restoreData.height + 'px';

    let html = `
        <div class="node-glass-bg"></div>
        <div class="node-header">
            <div class="node-header-color"></div>
            <div class="header-left">
                ${config.icon}
                <span class="node-title">${config.title}</span>
            </div>
            <div class="header-right">
                <span class="node-time-badge" id="${id}-time"></span>
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
                        <option value="" ${(!rd.aspect)?'selected':''}>自动</option>
                    <option value="1:1" ${rd.aspect==='1:1'?'selected':''}>1:1 正方形</option>
                    <option value="16:9" ${rd.aspect==='16:9'?'selected':''}>16:9 横屏</option>
                    <option value="9:16" ${rd.aspect==='9:16'?'selected':''}>9:16 竖屏</option>
                    <option value="4:3" ${rd.aspect==='4:3'?'selected':''}>4:3 标准</option>
                    <option value="3:4" ${rd.aspect==='3:4'?'selected':''}>3:4 竖版</option>
                    <option value="3:2" ${rd.aspect==='3:2'?'selected':''}>3:2 经典</option>
                    <option value="2:3" ${rd.aspect==='2:3'?'selected':''}>2:3 竖版经典</option>
                    <option value="21:9" ${rd.aspect==='21:9'?'selected':''}>21:9 超宽</option>
                </select></div>
            <div class="node-field"><label>分辨率</label>
                <select id="${id}-resolution">
                    <option value="" ${(!rd.resolution)?'selected':''}>默认 (1K)</option>
                    <option value="2K" ${rd.resolution==='2K'?'selected':''}>2K</option>
                    <option value="4K" ${rd.resolution==='4K'?'selected':''}>4K</option>
                </select></div>
            <div class="node-field node-field-row"><label>启用搜索</label>
                <label class="toggle-switch"><input type="checkbox" id="${id}-search" ${rd.search?'checked':''} /><span class="toggle-slider"></span></label></div>
            <div class="node-field"><label>提示词</label>
                <textarea id="${id}-prompt" placeholder="描述你想生成的图片..." rows="3">${rd.prompt || ''}</textarea></div>
            <div class="image-resolution-badge" id="${id}-res" style="display:none"></div>
        `;
        } else if (type === 'TextChat') {
            html += `
            <div class="node-field"><label>系统提示词 (可选)</label>
                <textarea id="${id}-sysprompt" placeholder="设定AI的角色或背景..." rows="2">${rd.sysprompt || ''}</textarea></div>
            <div class="node-field"><label>提问内容</label>
                <textarea id="${id}-prompt" placeholder="输入你的问题..." rows="3">${rd.prompt || ''}</textarea></div>
            <div class="node-field"><label>对话回复</label>
                <div class="chat-response-wrapper" id="${id}-wrapper">
                    <button class="chat-copy-btn" id="${id}-copy-btn" title="复制回复内容">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                    <div class="chat-response-area" id="${id}-response">
                        <div class="chat-response-placeholder">运行后显示对话结果</div>
                    </div>
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
            <div class="node-field">
                <textarea id="${id}-text" placeholder="输入你想传递的文本提示词..." rows="6">${rd.text || ''}</textarea>
            </div>
        `;
    } else if (type === 'TextDisplay') {
        html += `
            <div class="node-field">
                <div class="text-display-box" id="${id}-display">等待输入文本...</div>
            </div>
        `;
    } else if (type === 'ImageSave') {
        const rd = restoreData || {};
        html += `
            <button class="choose-dir-btn" id="${id}-choosedir">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                选择保存目录
            </button>
            <div class="dir-path-badge" id="${id}-dirpath" style="display:none"></div>
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
        width: restoreData?.width || null, height: restoreData?.height || null, 
        dirHandle: null, enabled: restoreData?.enabled !== false 
    };
    if (!nodeData.enabled) el.classList.add('disabled');
    state.nodes.set(id, nodeData);

    // Restore imageData
    if (type === 'ImageImport' || type === 'ImagePreview' || type === 'ImageSave') {
        (async () => {
            let data = (restoreData && restoreData.imageData) ? restoreData.imageData : await getImageAsset(id);
            if (data) {
                nodeData.imageData = data;
                nodeData.data.image = data; // For preview/save
                if (type === 'ImageImport') {
                    const dropZone = el.querySelector(`#${id}-drop`);
                    dropZone.classList.add('has-image');
                    dropZone.innerHTML = `<img src="${data}" alt="已导入图片" draggable="false" style="pointer-events: none;" />`;
                    showResolutionBadge(id, data);
                } else if (type === 'ImagePreview') {
                    const previewContainer = el.querySelector(`#${id}-preview`);
                    previewContainer.innerHTML = `<img src="${data}" alt="预览" draggable="false" style="pointer-events: none;" />`;
                    el.querySelector(`#${id}-controls`).style.display = 'flex';
                    showResolutionBadge(id, data);
                } else if (type === 'ImageSave') {
                    const savePreview = el.querySelector(`#${id}-save-preview`);
                    savePreview.innerHTML = `<img src="${data}" alt="待保存" draggable="false" style="pointer-events: none;" />`;
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
        const isInteractive = target.closest('input, textarea, select, button, .port, .node-resize-handle, [contenteditable="true"], .chat-response-area, .preview-controls');
        if (isInteractive) return;

        if (target.closest('.node-delete')) return;

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
        
        // Temporarily constrain image containers to small max-heights for compact measurement
        const containers = el.querySelectorAll('.preview-container, .save-preview-container, .file-drop-zone');
        const oldMaxHeights = [];
        containers.forEach(c => {
            oldMaxHeights.push(c.style.maxHeight);
            c.style.maxHeight = '120px';
        });
        const body = el.querySelector('.node-body');
        const oldBodyMaxH = body ? body.style.maxHeight : '';
        if (body) body.style.maxHeight = '';
        
        el.style.width = '';
        el.style.height = '';
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
            minWidth: Math.max(intrinsicW, 120), 
            minHeight: Math.max(intrinsicH, 80)
        };
        
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
    });

    if (!restoreData && !silent) showToast(`已添加「${config.title}」节点`, 'success');
    if (!restoreData) scheduleSave();
    return id;
}

function removeNode(id) {
    const idsToRemove = state.selectedNodes.has(id) ? Array.from(state.selectedNodes) : [id];
    idsToRemove.forEach(nid => {
        const node = state.nodes.get(nid);
        if (!node) return;
        state.connections = state.connections.filter(c => c.from.nodeId !== nid && c.to.nodeId !== nid);
        node.el.remove(); state.nodes.delete(nid);
        state.selectedNodes.delete(nid);
    });
    updateAllConnections(); updatePortStyles();
    showToast(idsToRemove.length > 1 ? `已删除 ${idsToRemove.length} 个节点` : '节点已删除', 'info'); 
    scheduleSave();
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
        if (node && node.imageData) openFullscreenPreview(node.imageData);
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
    const chooseDirBtn = el.querySelector(`#${id}-choosedir`);
    const dirPathBadge = el.querySelector(`#${id}-dirpath`);
    const previewContainer = el.querySelector(`#${id}-save-preview`);
    const manualSaveBtn = el.querySelector(`#${id}-manual-save`);

    chooseDirBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            const node = state.nodes.get(id);
            if (node) node.dirHandle = handle;
            dirHandles.set(id, handle);
            await saveHandle(id, handle); // Persist to IDB
            dirPathBadge.textContent = `📁 ${handle.name}`;
            dirPathBadge.style.display = 'block';
            showToast(`已选择保存目录: ${handle.name}`, 'success');
        } catch (err) {
            if (err.name !== 'AbortError') showToast('选择目录失败: ' + err.message, 'error');
        }
    });

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
        if (node && node.data.image) openFullscreenPreview(node.data.image);
    });

    el.querySelector(`#${id}-view-full`).addEventListener('click', (e) => {
        e.stopPropagation();
        const node = state.nodes.get(id);
        if (node && node.data.image) openFullscreenPreview(node.data.image);
    });
}

async function autoSaveToDir(nodeId, dataUrl) {
    const node = state.nodes.get(nodeId);
    if (!node) return;
    const handle = node.dirHandle || dirHandles.get(nodeId);
    if (!handle) {
        showToast('【自动保存提醒】未选择目录，图片仅保存在节点内', 'warning', 5000);
        addLog('warning', '自动保存跳过', '未选择保存目录', { nodeId });
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

// ===== Image Preview =====
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
        if (img) openFullscreenPreview(img.src);
    });
    el.querySelector(`#${id}-fullscreen`).addEventListener('click', (e) => {
        e.stopPropagation();
        const img = previewContainer.querySelector('img');
        if (img) openFullscreenPreview(img.src);
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
function openFullscreenPreview(src) {
    const overlay = document.createElement('div');
    overlay.className = 'fullscreen-overlay';
    overlay.innerHTML = `
        <div class="fullscreen-close" title="关闭 (Esc)">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </div>
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
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target === iw) cleanup(); });
    function onEsc(e) { if (e.key === 'Escape') cleanup(); }
    document.addEventListener('keydown', onEsc);
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
    
    if (isDragging || isPanning) {
        connectionsGroup.classList.add('is-dragging');
        // Fast rendering: skip complex curves and DOM updates
        if (isDragging && state.dragging.connectionsToUpdate) {
            for (const item of state.dragging.connectionsToUpdate) {
                const from = getPortPosition(item.conn.from.nodeId, item.conn.from.port, 'output');
                const to = getPortPosition(item.conn.to.nodeId, item.conn.to.port, 'input');
                item.pathEl.setAttribute('d', `M ${from.x} ${from.y} L ${to.x} ${to.y}`);
            }
            return;
        }
        if (isPanning) {
            // Also enable linear paths for panning to maintain 120 FPS
            for (const conn of state.connections) {
                let path = connectionsGroup.querySelector(`path[data-conn-id="${conn.id}"]`);
                if (path) {
                    const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output');
                    const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input');
                    path.setAttribute('d', `M ${from.x} ${from.y} L ${to.x} ${to.y}`);
                }
            }
            return;
        }
    } else {
        connectionsGroup.classList.remove('is-dragging');
        connectionsGroup.classList.remove('is-panning');
    }

    // Full update (reconciliation) when not dragging
    const existingPaths = Array.from(connectionsGroup.querySelectorAll('path[data-conn-id]'));
    const currentConnIds = new Set(state.connections.map(c => c.id));
    
    existingPaths.forEach(p => {
        if (!currentConnIds.has(p.getAttribute('data-conn-id'))) p.remove();
    });

    for (const conn of state.connections) {
        let path = connectionsGroup.querySelector(`path[data-conn-id="${conn.id}"]`);
        const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output');
        const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input');
        
        const cp = Math.max(50, Math.abs(to.x - from.x) * 0.4);
        const pathStr = `M ${from.x} ${from.y} C ${from.x + cp} ${from.y}, ${to.x - cp} ${to.y}, ${to.x} ${to.y}`;

        const isSelected = state.selectedNodes.has(conn.from.nodeId) || state.selectedNodes.has(conn.to.nodeId);
        
        if (path) {
            path.setAttribute('d', pathStr);
            if (isSelected) path.classList.add('selected');
            else path.classList.remove('selected');
        } else {
            path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('data-conn-id', conn.id);
            path.setAttribute('d', pathStr);
            path.classList.add('connection-path');
            if (isSelected) path.classList.add('selected');
            path.setAttribute('stroke', `url(#conn-gradient-${conn.type || 'image'})`);
            path.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                state.connections = state.connections.filter(c => c.id !== conn.id);
                updateAllConnections(); updatePortStyles();
                showToast('连接已删除', 'info'); scheduleSave();
            });
            connectionsGroup.appendChild(path);
        }
    }
}

function finishConnection(src, tgt) {
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
function topologicalSort() {
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
    for (const [nid] of state.nodes) if (!visit(nid)) { showToast('循环连接', 'error'); return null; }
    return result;
}

async function runWorkflow() {
    if (state.isRunning) return;
    state.isRunning = true;
    state.abortController = new AbortController();
    
    const runBtn = document.getElementById('btn-run');
    const stopBtn = document.getElementById('btn-stop');
    runBtn.classList.add('running'); runBtn.disabled = true;
    if (stopBtn) { stopBtn.classList.add('running'); stopBtn.disabled = false; }
    
    // Reset all nodes
    for (const [, n] of state.nodes) { 
        n.el.classList.remove('completed', 'error', 'running'); 
        n.data = {}; 
        n.isSucceeded = false;
    }
    
    const order = topologicalSort();
    if (!order) { 
        finalizeWorkflow();
        return; 
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
        const newOrder = topologicalSort();
        if (newOrder) order.splice(0, order.length, ...newOrder);
    }

    addLog('info', '并发工作流启动', `开始运行 ${order.length} 个节点...`);

    let retryAttempt = 0;
    const maxRetries = 100;
    const completedNodes = new Set();
    const failedNodes = new Set();
    const runningNodes = new Set();

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
                        runningNodes.add(nid);
                        const node = state.nodes.get(nid);
                        const nodeTitle = NODE_CONFIGS[node.type].title;
                        
                        (async () => {
                            node.el.classList.add('running');
                            node.el.classList.remove('completed', 'error');
                            const timeBadge = document.getElementById(`${nid}-time`);
                            const startTime = Date.now();
                            let timerId = null;
                            if (timeBadge) {
                                timerId = setInterval(() => {
                                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                                    timeBadge.textContent = `${elapsed}s`;
                                }, 100);
                            }

                            try {
                                const inputs = {};
                                for (const c of state.connections.filter(c => c.to.nodeId === nid)) {
                                    const fn = state.nodes.get(c.from.nodeId);
                                    if (fn && fn.data[c.from.port] !== undefined) inputs[c.to.port] = fn.data[c.from.port];
                                }

                                await executeNode(node, inputs, state.abortController?.signal);
                                
                                const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
                                node.isSucceeded = true;
                                node.el.classList.remove('running');
                                node.el.classList.add('completed');
                                if (timeBadge) timeBadge.textContent = `${durationSec}s`;
                                addLog('success', `节点已完成: ${nodeTitle}`, `耗时 ${durationSec}s`, { nodeId: nid, inputs, data: node.data });
                                
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
            if (retryAttempt >= maxRetries) {
                showToast('已达到最大重试次数 (100)，停止运行', 'error');
                break;
            }

            addLog('warning', `自动重试开始 (第 ${retryAttempt} 轮)`, `${actualFailures.length} 个节点未成功，正在准备重新执行相关分支...`);
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
        
        if (wasRunning) {
            showToast('工作流运行完成 ✓', 'success');
            if (Notification.permission === 'granted' && state.notificationsEnabled) {
                new Notification('CainFlow 运行结束', { body: '所有就绪的流程已并行执行完毕。', icon: 'data:image/svg+xml;base64,...' });
            }
        } else {
            showToast('已停止运行', 'info');
        }
    }
}

async function executeNode(node, inputs, signal) {
    const { id, type } = node;
    switch (type) {
        case 'ImageImport': {
            if (!node.imageData) throw new Error('未导入图片');
            node.data.image = node.imageData;
            break;
        }
        case 'ImageGenerate': {
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

            const url = `${apiCfg.endpoint.replace(/\/+$/, '')}/v1beta/models/${modelCfg.modelId}:generateContent?key=${apiCfg.apikey}`;
            showToast(`正在调用 ${modelCfg.name}...`, 'info', 5000);

            const response = await fetch('/proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-target-url': url },
                body: JSON.stringify(requestBody),
                signal
            });
            if (!response.ok) {
                const t = await response.text();
                throw new Error(`API 错误 (${response.status}): ${t.substring(0, 300)}`);
            }
            const result = await response.json();
            let imageData = null;
            if (result.candidates?.[0]) {
                for (const part of result.candidates[0].content.parts) {
                    if (part.inlineData) {
                        imageData = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                        break;
                    }
                }
            }
            if (!imageData) throw new Error('API 未返回图片数据');
            node.data.image = imageData;
            showResolutionBadge(id, imageData);
            
            // Auto record to history
            saveHistoryEntry({
                nodeId: id,
                image: imageData,
                prompt: prompt,
                model: modelCfg.name
            }).then(() => {
                if (document.getElementById('history-sidebar').classList.contains('active')) renderHistoryList();
            });
            break;
        }
        case 'TextChat': {
            const configId = document.getElementById(`${id}-apiconfig`).value;
            const modelCfg = state.models.find(m => m.id === configId);
            if (!modelCfg) throw new Error('未找到选定的模型配置');
            const apiCfg = state.providers.find(p => p.id === modelCfg.providerId);
            if (!apiCfg) throw new Error('未找到绑定的 API 供应商');
            
            const sysprompt = document.getElementById(`${id}-sysprompt`).value;
            // Priority: Input port > Textarea
            const prompt = inputs.prompt || document.getElementById(`${id}-prompt`).value;
            const responseArea = document.getElementById(`${id}-response`);

            if (!apiCfg.apikey) throw new Error('API 供应商密钥未配置');
            if (!prompt) throw new Error('请输入提问内容');

            showToast(`正在调用 ${modelCfg.name}...`, 'info', 5000);
            responseArea.innerHTML = '<div class="chat-response-placeholder">正在生成回复...</div>';

            try {
                let responseText = '';
                if (apiCfg.type === 'google') {
                    const parts = [{ text: prompt }];
                    for (const key of ['image_1', 'image_2', 'image_3']) {
                        if (inputs[key]) {
                            const match = inputs[key].match(/^data:(.+?);base64,(.+)$/);
                            if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
                        }
                    }
                    const body = { contents: [{ parts }] };
                    if (sysprompt) body.systemInstruction = { parts: [{ text: sysprompt }] };
                    
                    const url = `${apiCfg.endpoint.replace(/\/+$/, '')}/v1beta/models/${modelCfg.modelId}:generateContent?key=${apiCfg.apikey}`;
                    const res = await fetch('/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-target-url': url }, body: JSON.stringify(body), signal });
                    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
                    const json = await res.json();
                    responseText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
                } else {
                    // OpenAI format
                    const messages = [];
                    if (sysprompt) messages.push({ role: 'system', content: sysprompt });
                    
                    const content = [{ type: 'text', text: prompt }];
                    for (const key of ['image_1', 'image_2', 'image_3']) {
                        if (inputs[key]) content.push({ type: 'image_url', image_url: { url: inputs[key] } });
                    }
                    messages.push({ role: 'user', content });

                    let url = apiCfg.endpoint.replace(/\/+$/, '');
                    if (!url.endsWith('/chat/completions')) url += '/chat/completions';
                    
                    const res = await fetch('/proxy', { 
                        method: 'POST', 
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiCfg.apikey}`, 'x-target-url': url }, 
                        body: JSON.stringify({ model: modelCfg.modelId, messages }),
                        signal 
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
                    const json = await res.json();
                    responseText = json.choices?.[0]?.message?.content || '';
                }

                if (!responseText) throw new Error('API 未返回文本内容');
                responseArea.textContent = responseText;
                node.data.text = responseText; // Set output for other nodes
            } catch (err) {
                responseArea.innerHTML = `<div class="chat-response-placeholder" style="color:var(--accent-red)">失败: ${err.message}</div>`;
                throw err;
            }
            break;
        }
        case 'ImagePreview': {
            const imgData = inputs.image;
            const previewContainer = document.getElementById(`${id}-preview`);
            const controls = document.getElementById(`${id}-controls`);
            if (imgData) {
                node.previewZoom = 1;
                previewContainer.innerHTML = `<img src="${imgData}" alt="预览" style="cursor:pointer" draggable="false" />`;
                controls.style.display = 'flex';
                node.data.image = imgData;
                saveImageAsset(id, imgData); // Save generated/previewed image to IDB
                showResolutionBadge(id, imgData);
            } else {
                previewContainer.innerHTML = `<div class="preview-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>无输入图片</div>`;
                controls.style.display = 'none';
            }
            break;
        }
        case 'ImageSave': {
            const imgData = inputs.image;
            const savePreview = document.getElementById(`${id}-save-preview`);
            if (imgData) {
                node.data.image = imgData;
                savePreview.innerHTML = `<img src="${imgData}" alt="待保存" draggable="false" />`;
                saveImageAsset(id, imgData);
                showResolutionBadge(id, imgData);
                // Auto-save to chosen directory
                await autoSaveToDir(id, imgData);
            } else {
                savePreview.innerHTML = '<div class="save-preview-placeholder">无输入图片</div>';
            }
            break;
        }
        case 'TextInput': {
            const text = document.getElementById(`${id}-text`).value;
            node.data.text = text;
            break;
        }
        case 'TextDisplay': {
            const text = inputs.text || '';
            const display = document.getElementById(`${id}-display`);
            display.textContent = text || '目前无输入文本';
            node.data.text = text;
            break;
        }
    }
}

// ===== Persistence =====
let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 300); }

function serializeNodes() {
    const nodes = [];
    for (const [id, node] of state.nodes) {
        const s = { id, type: node.type, x: node.x, y: node.y, width: node.width || null, height: node.height || null, enabled: node.enabled };
        // We skip imageData here because it's now in IndexedDB to avoid localStorage QuotaExceededError
        if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
            s.apiConfigId = document.getElementById(`${id}-apiconfig`)?.value || 'default';
            s.prompt = document.getElementById(`${id}-prompt`)?.value || '';
            if (node.type === 'ImageGenerate') {
                s.aspect = document.getElementById(`${id}-aspect`)?.value || '';
                s.resolution = document.getElementById(`${id}-resolution`)?.value || '';
                s.search = document.getElementById(`${id}-search`)?.checked || false;
            } else if (node.type === 'TextChat') {
                s.sysprompt = document.getElementById(`${id}-sysprompt`)?.value || '';
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
            autoRetry: state.autoRetry
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { 
        console.warn('Save failed:', e); 
        if (e.name === 'QuotaExceededError') {
            showToast('浏览器存储空间不足，部分状态可能未保存', 'error', 5000);
        }
    }
}

function exportWorkflow() {
    try {
        const data = {
            canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom },
            nodes: serializeNodes(),
            connections: state.connections.map(c => ({ id: c.id, from: c.from, to: c.to, type: c.type })),
            providers: state.providers,
            models: state.models,
            version: '1.1'
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const time = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.download = `CainFlow_Project_${time}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('整个项目（含 API 配置）已导出', 'success');
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
        if (data.autoRetry !== undefined) {
            state.autoRetry = data.autoRetry;
            const toggle = document.getElementById('toggle-retry');
            if (toggle) toggle.checked = state.autoRetry;
        }
        if (data.canvas) { state.canvas.x = data.canvas.x || 0; state.canvas.y = data.canvas.y || 0; state.canvas.zoom = data.canvas.zoom || 1; }
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
    for (const [id, node] of state.nodes) {
        if (node.type === 'ImageSave') {
            const handle = await getHandle(id);
            if (handle) {
                node.dirHandle = handle;
                dirHandles.set(id, handle);
                const badge = node.el.querySelector(`#${id}-dirpath`);
                if (badge) {
                    badge.textContent = `📁 ${handle.name}`;
                    badge.style.display = 'block';
                }
                addLog('info', '目录句柄已恢复', `节点 ${id} 已恢复目录: ${handle.name}`);
            }
        }
    }
}

// ===== Toolbar =====
document.getElementById('btn-run').addEventListener('click', runWorkflow);
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
document.getElementById('btn-export').addEventListener('click', exportWorkflow);
document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
document.getElementById('import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importWorkflow(e.target.files[0]);
});
document.getElementById('btn-zoom-in').addEventListener('click', () => {
    const nz = Math.min(5, state.canvas.zoom * 1.2), cx = canvasContainer.clientWidth / 2, cy = canvasContainer.clientHeight / 2;
    state.canvas.x = cx - (cx - state.canvas.x) * (nz / state.canvas.zoom);
    state.canvas.y = cy - (cy - state.canvas.y) * (nz / state.canvas.zoom);
    state.canvas.zoom = nz; updateCanvasTransform();
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
    const nz = Math.max(0.1, state.canvas.zoom * 0.8), cx = canvasContainer.clientWidth / 2, cy = canvasContainer.clientHeight / 2;
    state.canvas.x = cx - (cx - state.canvas.x) * (nz / state.canvas.zoom);
    state.canvas.y = cy - (cy - state.canvas.y) * (nz / state.canvas.zoom);
    state.canvas.zoom = nz; updateCanvasTransform();
});
document.getElementById('btn-zoom-reset').addEventListener('click', () => { state.canvas.x = 0; state.canvas.y = 0; state.canvas.zoom = 1; updateCanvasTransform(); });
document.getElementById('btn-clear').addEventListener('click', () => {
    if (state.nodes.size === 0) return;
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
    if (node.type === 'ImageImport') s.imageData = node.imageData || null;
        if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
            s.apiConfigId = document.getElementById(`${id}-apiconfig`)?.value || 'default';
            s.prompt = document.getElementById(`${id}-prompt`)?.value || '';
            if (node.type === 'ImageGenerate') {
                s.aspect = document.getElementById(`${id}-aspect`)?.value || '';
                s.resolution = document.getElementById(`${id}-resolution`)?.value || '';
                s.search = document.getElementById(`${id}-search`)?.checked || false;
            } else if (node.type === 'TextChat') {
                s.sysprompt = document.getElementById(`${id}-sysprompt`)?.value || '';
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
document.getElementById('btn-logs').addEventListener('click', () => {
    document.getElementById('history-sidebar').classList.remove('active');
    document.getElementById('log-drawer').classList.toggle('active');
});

function initUI() {
    const btnHistory = document.getElementById('btn-history');
    const sidebar = document.getElementById('history-sidebar');
    const logDrawer = document.getElementById('log-drawer');

    if (btnHistory && sidebar) {
        btnHistory.addEventListener('click', (e) => {
            console.log('History button clicked');
            logDrawer?.classList.remove('active');
            sidebar.classList.toggle('active');
            if (sidebar.classList.contains('active')) {
                renderHistoryList().catch(err => console.error('Failed to render history:', err));
            }
        });
    } else {
        console.warn('History UI elements missing:', { btnHistory: !!btnHistory, sidebar: !!sidebar });
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
        saveState();
        if (enabled) showToast('运行完成通知已开启 🔔', 'success');
        else showToast('运行完成通知已关闭', 'info');
    });
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

initUI();

document.addEventListener('keydown', (e) => {
    const a = document.activeElement;
    const inInput = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
    const hasTextSelection = window.getSelection().toString().length > 0;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runWorkflow(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveState(); showToast('工作流已保存', 'success'); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'e') { e.preventDefault(); exportWorkflow(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); document.getElementById('import-file').click(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !inInput && !hasTextSelection) { e.preventDefault(); copySelectedNode(); }
    // Only intercept Ctrl+V if there's something in our internal clipboard.
    // Otherwise, let the browser trigger the 'paste' event (for images).
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !inInput && state.clipboard && state.clipboard.nodes.length) { 
        e.preventDefault(); 
        pasteNode(); 
        return; // Consumed by internal paste
    }
    if (e.key === 'Delete' && state.selectedNodes.size > 0 && !inInput) {
        const firstId = Array.from(state.selectedNodes)[0];
        removeNode(firstId); 
    }
    if (e.key === 'Escape') {
        contextMenu.classList.add('hidden');
        state.selectedNodes.forEach(nid => {
            const n = state.nodes.get(nid); if (n) n.el.classList.remove('selected');
        });
        state.selectedNodes.clear();
    }
});

canvasContainer.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

// ===== Settings Modal (Providers & Models) =====
const settingsModal = document.getElementById('settings-modal');
const providersList = document.getElementById('providers-list');
const modelsList = document.getElementById('models-list');

document.getElementById('btn-settings').addEventListener('click', () => {
    renderProviders();
    renderModels();
    settingsModal.classList.remove('hidden');
});
document.getElementById('settings-close').addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });

function renderProviders() {
    providersList.innerHTML = '';
    if (state.providers.length === 0) {
        providersList.innerHTML = '<div style="color:var(--text-secondary);text-align:center;padding:20px;font-size:12px;">暂无供应商配置</div>';
        return;
    }
    state.providers.forEach(prov => {
        const el = document.createElement('div');
        el.className = 'api-config-card';
        el.innerHTML = `
            <div class="card-header">
                <input type="text" class="card-name" value="${prov.name}" placeholder="供应商名称" data-id="${prov.id}" data-field="name" style="background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.2);padding:2px 4px;font-size:14px;color:var(--accent-cyan);width:150px" />
                <select class="card-type ${prov.type}" data-id="${prov.id}" data-field="type">
                    <option value="google" ${prov.type === 'google' ? 'selected' : ''}>Google</option>
                    <option value="openai" ${prov.type === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
                </select>
            </div>
            <div class="card-row">
                <div class="card-field"><label>API 密钥</label><input type="password" value="${prov.apikey}" placeholder="API Key" data-id="${prov.id}" data-field="apikey" /></div>
                <div class="card-field"><label>API 地址</label><input type="text" value="${prov.endpoint}" placeholder="Endpoint URL" data-id="${prov.id}" data-field="endpoint" /></div>
            </div>
            ${prov.id !== 'prov_default' ? `<div class="card-actions"><button class="card-btn-delete" data-id="${prov.id}" data-target="provider">删除</button></div>` : ''}
        `;
        providersList.appendChild(el);
    });

    providersList.querySelectorAll('input, select').forEach(input => {
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
                } else {
                    prov[field] = e.target.value;
                }
                saveState();
                renderModels(); // Provider name changes affect model dropdowns
            }
        });
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
            ${mod.id !== 'default' ? `<div class="card-actions"><button class="card-btn-delete" data-id="${mod.id}" data-target="model">删除</button></div>` : ''}
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

document.getElementById('btn-add-provider').addEventListener('click', () => {
    state.providers.push({
        id: 'prov_' + Math.random().toString(36).substr(2, 9),
        name: '新供应商',
        type: 'google',
        apikey: '',
        endpoint: 'https://generativelanguage.googleapis.com'
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
        const pos = screenToCanvas(e.clientX, e.clientY);
        files.forEach((file, index) => {
            const nid = addNode('ImageImport', pos.x + index * 20, pos.y + index * 20);
            if (nid) loadImageFile(nid, file);
        });
        showToast(`已通过拖拽添加 ${files.length} 个图片节点`, 'success');
    }
});

// ===== Initialize =====
loadState().then(restored => {
    if (restored) showToast('已恢复上次的工作状态', 'success');
    else updateCanvasTransform();
});
// ===== History Previewer & Interactions =====
let previewState = { scale: 1, x: 0, y: 0, isDragging: false, startX: 0, startY: 0 };

function openHistoryPreview(item) {
    const modal = document.getElementById('history-preview-modal');
    const img = document.getElementById('history-preview-img');
    const promptText = document.getElementById('preview-prompt');
    const metaText = document.getElementById('preview-meta');
    const viewport = document.getElementById('preview-viewport');
    
    img.src = item.image;
    promptText.textContent = item.prompt;
    metaText.innerHTML = `
        <span>模型: ${item.model}</span>
        <span>时间: ${new Date(item.timestamp).toLocaleString()}</span>
    `;
    modal.classList.remove('hidden');
    
    // Wire up actions
    const btnDownload = document.getElementById('btn-download-preview');
    const btnCopy = document.getElementById('btn-copy-prompt');
    
    btnDownload.onclick = () => downloadImage(item.image, `cainflow_${item.id}.png`);
    btnCopy.onclick = () => copyToClipboard(item.prompt);
    
    // Reset state first
    previewState = { scale: 1, x: 0, y: 0, isDragging: false, startX: 0, startY: 0 };
    
    // Auto fit after image loads
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
            modal.classList.add('hidden');
            document.removeEventListener('keydown', onEsc);
        }
    };
    function onEsc(e) { if (e.key === 'Escape') { modal.classList.add('hidden'); document.removeEventListener('keydown', onEsc); } }
    document.addEventListener('keydown', onEsc);
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

document.getElementById('btn-close-preview')?.addEventListener('click', () => {
    document.getElementById('history-preview-modal').classList.add('hidden');
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

    // Phase 3: Single-branch execution
    if (imageFile) {
        e.preventDefault();
        e.stopImmediatePropagation(); // Crucial to prevent bubble duplicates
        const nodeId = addNode('ImageImport', pos.x, pos.y, null, true);
        if (nodeId) { 
            loadImageFile(nodeId, imageFile); 
            showToast('已完成剪贴板图片快速导入', 'success'); 
        }
    } else if (textContent && textContent.trim().length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const nodeId = addNode('TextInput', pos.x, pos.y, null, true);
        if (nodeId) {
            const textEl = document.getElementById(`${nodeId}-text`);
            if (textEl) { textEl.value = textContent; textEl.dispatchEvent(new Event('change')); }
            showToast('已完成剪贴板文本快速导入', 'success');
            scheduleSave();
        }
    }
});
