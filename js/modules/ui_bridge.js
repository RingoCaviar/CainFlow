import { 
    NODE_CONFIGS, STORE_HISTORY 
} from './constants.js';

import { 
    generateId, showToast, sanitizeDetails 
} from './utils.js';

import {
    createThumbnail, downloadImage
} from './imageUtils.js';

import { state } from './state.js';
import {
    openDB, getHistory, saveImageAsset
} from './db.js';

/**
 * UI Bridge for Execution Engine and other modules
 * Contains functions that interact with the main UI / DOM
 */

export function getProxyHeaders(url, method = 'POST') {
    const headers = { 
        'Content-Type': 'application/json', 
        'x-target-url': url,
        'x-target-method': method,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CainFlow/2.6.1'
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
        const logBtn = document.getElementById('btn-logs');
        if (logBtn) logBtn.classList.add('has-new-error');
    }
}

export function renderLogs() {
    const list = document.getElementById('log-list');
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
    const modal = document.getElementById('modal-error');
    if (!modal) return;
    document.getElementById('error-modal-title').textContent = modalTitle;
    document.getElementById('error-modal-msg').textContent = msg;
    document.getElementById('error-modal-detail').textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);

    const fullLogBtn = document.getElementById('btn-show-full-log');
    if (fullLogBtn) {
        if (log) {
            fullLogBtn.classList.remove('hidden');
            fullLogBtn.onclick = () => {
                closeModal('modal-error');
                // Open logs panel
                const btnLogs = document.getElementById('btn-logs');
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
    const list = document.getElementById('history-list');
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
    // Basic undo/history implementation
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

export function updateAllConnections() {
    triggerUpdateAllConnections();
}

// Internal trigger for connection updates (to be shared)
export function triggerUpdateAllConnections() {
    // This is often needed after UI changes. 
    // In index.js, this actually iterates over state.connections and updates SVG paths.
    // For now, we will expose the function from index.js or move the logic here.
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
    // This usually debounces saveState()
    if (window.saveTimer) clearTimeout(window.saveTimer);
    window.saveTimer = setTimeout(() => {
        // saveState() is in index.js, but it uses state.js/db.js
        // We'll expose saveState or move its core here.
    }, 2000);
}

export function fitNodeToContent(nodeId) {
    const node = state.nodes.get(nodeId);
    if (!node) return;
    const body = node.el.querySelector('.node-body');
    if (!body) return;
    
    // Reset height to auto to measure
    const originalHeight = node.el.style.height;
    node.el.style.height = 'auto';
    const newHeight = node.el.offsetHeight;
    
    // Cap height or keep as is? Usually we want it to fit.
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
    const audio = new Audio('data:audio/mp3;base64,...'); // Actual sound data in index.js
    audio.play().catch(e => console.warn('Sound blocked:', e));
}
