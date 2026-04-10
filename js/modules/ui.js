import { 
    NODE_CONFIGS, STORE_HISTORY 
} from './constants.js';

import { 
    generateId, showToast, sanitizeDetails 
} from './utils.js';

import {
    getImageResolution, processImageResolution, dataURLtoBlob,
    createThumbnail, downloadImage
} from './imageUtils.js';

import { state } from './state.js';
import {
    openDB, saveImageAsset, getHistory, saveHistoryEntry
} from './db.js';

/**
 * UI Element Cache with Lazy Getters
 */
export const elements = {
    get canvasContainer() { return document.getElementById('canvas-container'); },
    get nodesLayer() { return document.getElementById('nodes-layer'); },
    get connectionsGroup() { return document.getElementById('connections-group'); },
    get tempConnection() { return document.getElementById('temp-connection'); },
    get originAxes() { return document.getElementById('origin-axes'); },
    get contextMenu() { return document.getElementById('context-menu'); },
    get toastContainer() { return document.getElementById('toast-container'); },
    get logList() { return document.getElementById('log-list'); },
    get historyList() { return document.getElementById('history-list'); },
    get workflowList() { return document.getElementById('workflow-list'); },
    get zoomLevel() { return document.getElementById('zoom-level'); },
    get btnLogs() { return document.getElementById('btn-logs'); },
    get errorModal() {
        return {
            root: document.getElementById('modal-error'),
            title: document.getElementById('error-modal-title'),
            msg: document.getElementById('error-modal-msg'),
            detail: document.getElementById('error-modal-detail')
        };
    }
};

/**
 * UI Utility Functions
 */

export function getProxyHeaders(url, method = 'POST') {
    const headers = { 
        'Content-Type': 'application/json', 
        'x-target-url': url,
        'x-target-method': method,
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) CainFlow/2.6.1`
    };
    if (state.proxy) {
        headers['x-proxy-enabled'] = state.proxy.enabled ? 'true' : 'false';
        headers['x-proxy-host'] = state.proxy.ip || '127.0.0.1';
        headers['x-proxy-port'] = state.proxy.port || '7890';
    }
    return headers;
}

export function addLog(type, title, message, details = null) {
    const sanitized = sanitizeDetails(details);
    const log = {
        id: 'log_' + Date.now() + Math.random().toString(36).substr(2, 5),
        time: new Date().toLocaleTimeString(),
        type, 
        title,
        message,
        details: sanitized,
        rawDetails: (sanitized !== details) ? details : null
    };
    state.logs.unshift(log);
    if (state.logs.length > 50) state.logs.pop();
    renderLogs();

    if (type === 'error' && !state.autoRetry) {
        showErrorModal(title, message, log.details, '执行错误', log);
    } else if (type === 'error' && state.autoRetry) {
        const logBtn = elements.btnLogs;
        if (logBtn) logBtn.classList.add('has-new-error');
    }
}

export function renderLogs() {
    const list = elements.logList;
    if (!list) return;
    if (state.logs.length === 0) {
        list.innerHTML = '<div class="log-empty">暂无执行记录</div>';
        return;
    }

    list.innerHTML = state.logs.map(log => `
        <div class="log-item log-type-${log.type}" data-id="${log.id}">
            <div class="log-item-header">
                <span class="log-time">${log.time}</span>
                <span class="log-badge">${log.type.toUpperCase()}</span>
                <span class="log-title">${log.title}</span>
            </div>
            <div class="log-message">${log.message}</div>
            ${log.details ? `<button class="log-detail-btn" onclick="window.showLogDetail('${log.id}')">查看详情</button>` : ''}
        </div>
    `).join('');
}

export function showErrorModal(title, msg, detail, modalTitle = '执行错误', log = null) {
    const modal = elements.errorModal.root;
    if (!modal) return;
    elements.errorModal.title.textContent = modalTitle;
    elements.errorModal.msg.textContent = msg;
    elements.errorModal.detail.textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);

    const fullLogBtn = document.getElementById('btn-show-full-log');
    if (fullLogBtn) {
        if (log) {
            fullLogBtn.classList.remove('hidden');
            fullLogBtn.onclick = () => {
                closeModal('modal-error');
                const btnLogs = elements.btnLogs;
                if (btnLogs) btnLogs.click();
            };
        } else {
            fullLogBtn.classList.add('hidden');
        }
    }

    modal.classList.add('active');
}

export function closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
}

export async function renderHistoryList() {
    const list = elements.historyList;
    if (!list) return;
    const items = await getHistory();
    if (!items.length) {
        list.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding: 40px 0; font-size:13px;">暂无历史记录</div>';
        return;
    }

    const displayItems = items.slice(0, 100);
    const hasMore = items.length > 100;

    let html = displayItems.map(item => {
        const isSelected = state.selectedHistoryIds.has(item.id);
        const modeClass = state.historySelectionMode ? 'multi-select-mode' : '';
        const selectedClass = isSelected ? 'selected' : '';

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
}

export function pushHistory() {
    const snapshot = {
        nodes: Array.from(state.nodes.entries()).map(([id, n]) => ({
            id, type: n.type, x: n.x, y: n.y, width: n.width, height: n.height,
            data: { ...n.data },
            enabled: n.enabled,
            isSucceeded: n.isSucceeded
        })),
        connections: state.connections.map(c => ({...c}))
    };
    state.history.push(JSON.stringify(snapshot));
    if (state.history.length > 30) state.history.shift();
    
    const undoBtn = document.getElementById('btn-undo');
    if (undoBtn) undoBtn.disabled = false;
}

export function updatePortStyles() {
    document.querySelectorAll('.node-port').forEach(el => {
        const nid = el.dataset.nodeId;
        const port = el.dataset.port;
        const isConnected = state.connections.some(c => 
            (c.from.nodeId === nid && c.from.port === port) || 
            (c.to.nodeId === nid && c.to.port === port)
        );
        el.classList.toggle('connected', isConnected);
    });
}

export function scheduleSave() {
    if (window.saveTimer) clearTimeout(window.saveTimer);
    window.saveTimer = setTimeout(() => {
        // This will be called via a callback or by importing saveState if we move it
        if (typeof window.saveState === 'function') window.saveState();
    }, 2000);
}

export function getPortPosition(nodeId, portName, direction) {
    const node = state.nodes.get(nodeId);
    if (!node) return { x: 0, y: 0 };
    const portEl = node.el.querySelector(`.node-port[data-port="${portName}"][data-direction="${direction}"]`);
    if (!portEl) return { x: node.x, y: node.y };
    const dot = portEl.querySelector('.port-dot');
    const rect = dot.getBoundingClientRect();
    const containerRect = elements.canvasContainer.getBoundingClientRect();
    const { x, y, zoom } = state.canvas;
    return {
        x: (rect.left + rect.width / 2 - containerRect.left - x) / zoom,
        y: (rect.top + rect.height / 2 - containerRect.top - y) / zoom
    };
}

export function updateAllConnections() {
    const { x, y, zoom } = state.canvas;
    const isDragging = !!state.dragging;
    const isPanning = state.canvas.isPanning;
    const group = elements.connectionsGroup;
    const axes = elements.originAxes;

    if (!group) return;

    group.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);
    if (axes) axes.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);

    if (isDragging || isPanning) group.classList.add('is-dragging');
    else group.classList.remove('is-dragging', 'is-panning');

    const currentConnIds = new Set(state.connections.map(c => c.id));
    group.querySelectorAll('path[data-conn-id]').forEach(p => {
        if (!currentConnIds.has(p.getAttribute('data-conn-id'))) p.remove();
    });

    const containerRect = elements.canvasContainer.getBoundingClientRect();
    const vx1 = -x / zoom, vy1 = -y / zoom;
    const vx2 = (containerRect.width - x) / zoom, vy2 = (containerRect.height - y) / zoom;
    const padding = 100;

    for (const conn of state.connections) {
        let path = group.querySelector(`path[data-conn-id="${conn.id}"]`);
        const fn = state.nodes.get(conn.from.nodeId);
        const tn = state.nodes.get(conn.to.nodeId);
        
        if (fn && tn) {
            const isFIn = fn.x > vx1 - padding && fn.x < vx2 + padding && fn.y > vy1 - padding && fn.y < vy2 + padding;
            const isTIn = tn.x > vx1 - padding && tn.x < vx2 + padding && tn.y > vy1 - padding && tn.y < vy2 + padding;
            if (!isFIn && !isTIn && path) {
                path.setAttribute('d', '');
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
            group.appendChild(path);
        }

        path.setAttribute('d', pathStr);
        path.classList.toggle('selected', isSelected);
    }
}

export function fitNodeToContent(nodeId) {
    const node = state.nodes.get(nodeId);
    if (!node) return;
    const body = node.el.querySelector('.node-body');
    if (!body) return;
    
    node.el.style.height = 'auto';
    const newHeight = node.el.offsetHeight;
    node.height = Math.max(newHeight, 100);
    node.el.style.height = node.height + 'px';
    
    updateAllConnections();
}

export async function showResolutionBadge(nodeId, dataUrl) {
    const badge = document.getElementById(`${nodeId}-res`);
    if (!badge) return;
    
    try {
        const img = new Image();
        img.src = dataUrl;
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
        });
        badge.textContent = `${img.naturalWidth} x ${img.naturalHeight}`;
        badge.style.display = 'block';
    } catch (e) {
        badge.style.display = 'none';
    }
}

export function playNotificationSound() {
    if (!state.notificationsEnabled) return;
    // Tiny silent audio to unblock context if needed, though this is for results
    const audio = new Audio();
    audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';
    audio.play().catch(e => console.warn('Sound blocked:', e));
}
