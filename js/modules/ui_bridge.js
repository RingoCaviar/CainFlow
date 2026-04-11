import { 
    NODE_CONFIGS, STORE_HISTORY, STORAGE_KEY,
    APP_VERSION, GITHUB_REPO
} from './constants.js';

import { 
    generateId, showToast, sanitizeDetails, debounce, 
    checkLineIntersection, copyToClipboard, hsbToHex,
    compareVersions
} from './utils.js';

import {
    getImageResolution, processImageResolution, dataURLtoBlob,
    createThumbnail, downloadImage
} from './imageUtils.js';

import { state } from './state.js';
import {
    openDB, getHistory, saveImageAsset, getImageAsset, deleteHistoryEntry, 
    deleteImageAsset, saveHistoryEntry, clearHistory
} from './db.js';

/**
 * UI Elements lookup (getters to ensure they are looked up after DOM is ready)
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
    get historySidebar() { return document.getElementById('history-sidebar'); },
    get btnHistory() { return document.getElementById('btn-history'); },
    get btnLogs() { return document.getElementById('btn-logs'); },
    get logDrawer() { return document.getElementById('log-drawer'); }
};

/**
 * Panel Management (Mutual Exclusivity)
 */
export const PanelManager = {
    panels: {
        history: { id: 'history-sidebar', btn: 'btn-history' },
        workflow: { id: 'workflow-sidebar', btn: 'btn-toggle-workflow' },
        cache: { id: 'cache-sidebar', btn: 'btn-toggle-cache' },
        logs: { id: 'log-drawer', btn: 'btn-logs' }
    },
    toggle(panelKey, onOpen = null) {
        console.log(`[PanelManager] Toggling panel: ${panelKey}`);
        const target = this.panels[panelKey];
        if (!target) return;
        
        const el = document.getElementById(target.id);
        if (!el) return;
        
        const isOpen = el.classList.contains('active');
        
        // Close all others
        Object.keys(this.panels).forEach(key => {
            if (key !== panelKey) this.close(key);
        });
        
        const btn = document.getElementById(target.btn);
        if (isOpen) {
            this.close(panelKey);
        } else {
            console.log(`[PanelManager] Opening: ${panelKey}`);
            el.classList.add('active');
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

/**
 * Shared UI Utilities
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
    const typeLabels = { success: '成功', error: '错误', warning: '警告', info: '信息' };
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

export function showErrorModal(title, msg, detail, modalTitle = '执行错误', log = null) {
    const modal = document.getElementById('modal-error');
    if (!modal) return;
    const content = modal.querySelector('.modal-content');
    if (content) {
        content.className = 'modal-content';
        const type = log ? log.type : 'error';
        content.classList.add(type);
        if (type === 'error') content.classList.add('modal-error-content');
    }
    
    document.getElementById('error-modal-title').textContent = modalTitle;
    document.getElementById('error-modal-msg').textContent = msg;
    document.getElementById('error-modal-detail').textContent = detail || '无详细信息';
    
    const imgContainer = document.getElementById('error-modal-images');
    if (imgContainer) imgContainer.innerHTML = ''; // Simplification: don't move searchForImages yet

    const btnFull = document.getElementById('btn-show-full-log');
    if (btnFull) {
        if (log && log.rawDetails) {
            btnFull.classList.remove('hidden');
            btnFull.onclick = () => {
                let fullText = log.rawDetails;
                if (typeof fullText !== 'string') {
                    try { fullText = JSON.stringify(fullText, null, 2); } catch (e) { fullText = String(fullText); }
                }
                showErrorModal(title, msg, fullText, modalTitle, log);
            };
        } else {
            btnFull.classList.add('hidden');
        }
    }
    modal.classList.add('active');
}

export function closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
}

/**
 * History UI
 */
export async function renderHistoryList() {
    const list = elements.historyList;
    if (!list) return;
    const items = await getHistory();
    if (!items.length) {
        list.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding: 40px 0; font-size:13px;">暂无历史记录</div>';
        return;
    }
    const displayItems = items.slice(0, 100);
    const html = displayItems.map(item => {
        const isSelected = state.selectedHistoryIds.has(item.id);
        return `<div class="history-card ${state.historySelectionMode ? 'multi-select-mode' : ''} ${isSelected ? 'selected' : ''}" data-id="${item.id}">
            <img src="${item.thumb || item.image}" loading="lazy" />
            <div class="selection-checkbox"></div>
            <button class="delete-btn" data-id="${item.id}">×</button>
        </div>`;
    }).join('');
    list.innerHTML = html;
    document.getElementById('selected-count').textContent = state.selectedHistoryIds.size;
    
    list.querySelectorAll('.history-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-btn')) return;
            const id = Number(card.dataset.id);
            if (state.historySelectionMode) {
                if (state.selectedHistoryIds.has(id)) state.selectedHistoryIds.delete(id);
                else state.selectedHistoryIds.add(id);
                renderHistoryList();
            } else {
                const item = items.find(i => i.id === id);
                if (item) openHistoryPreview(item);
            }
        });
    });
}

/**
 * Canvas & Connections
 */
export function getPortPosition(nodeId, portName, direction) {
    const node = state.nodes.get(nodeId);
    if (!node) return { x: 0, y: 0 };
    if (state.dragging && state.dragging.portOffsets) {
        const offset = state.dragging.portOffsets.get(`${nodeId}-${portName}-${direction}`);
        if (offset) return { x: node.x + offset.dx, y: node.y + offset.dy };
    }
    const portEl = node.el.querySelector(`.node-port[data-node-id="${nodeId}"][data-port="${portName}"][data-direction="${direction}"]`);
    if (!portEl) return { x: node.x, y: node.y };
    const dot = portEl.querySelector('.port-dot');
    const dotRect = dot.getBoundingClientRect();
    const containerRect = elements.canvasContainer.getBoundingClientRect();
    const { x, y, zoom } = state.canvas;
    return {
        x: (dotRect.left + dotRect.width / 2 - containerRect.left - x) / zoom,
        y: (dotRect.top + dotRect.height / 2 - containerRect.top - y) / zoom
    };
}

export function updateAllConnections() {
    const { x, y, zoom } = state.canvas;
    const group = elements.connectionsGroup;
    if (!group) return;
    group.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);
    
    // Simple rendering of current connections
    const currentIds = new Set(state.connections.map(c => c.id));
    group.querySelectorAll('path[data-conn-id]').forEach(p => {
        if (!currentIds.has(p.getAttribute('data-conn-id'))) p.remove();
    });

    for (const conn of state.connections) {
        const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output');
        const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input');
        const cp = Math.max(50, Math.abs(to.x - from.x) * 0.4);
        const d = `M ${from.x} ${from.y} C ${from.x + cp} ${from.y}, ${to.x - cp} ${to.y}, ${to.x} ${to.y}`;
        let path = group.querySelector(`path[data-conn-id="${conn.id}"]`);
        if (!path) {
            path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('data-conn-id', conn.id);
            path.classList.add('connection-path');
            group.appendChild(path);
        }
        path.setAttribute('d', d);
        path.classList.toggle('selected', state.selectedNodes.has(conn.from.nodeId) || state.selectedNodes.has(conn.to.nodeId));
    }
}

export function finishConnection(src, tgt) {
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

export function updatePortStyles() {
    document.querySelectorAll('.port-dot').forEach(d => d.classList.remove('connected'));
    for (const conn of state.connections) {
        const fN = state.nodes.get(conn.from.nodeId);
        const tN = state.nodes.get(conn.to.nodeId);
        if (fN) {
            const p = fN.el.querySelector(`.node-port[data-port="${conn.from.port}"][data-direction="output"] .port-dot`);
            if (p) p.classList.add('connected');
        }
        if (tN) {
            const p = tN.el.querySelector(`.node-port[data-port="${conn.to.port}"][data-direction="input"] .port-dot`);
            if (p) p.classList.add('connected');
        }
    }
}

/**
 * Node Management
 */

export function adjustTextareaHeight(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = (textarea.scrollHeight + 2) + 'px';
    updateAllConnections();
}

export function fitNodeToContent(nodeId) {
    const node = state.nodes.get(nodeId);
    if (!node || !node.el) return;
    const el = node.el;
    el.style.height = 'auto';
    node.height = Math.max(el.offsetHeight, 100);
    el.style.height = node.height + 'px';
    updateAllConnections();
    scheduleSave();
}

export async function showResolutionBadge(nodeId, dataUrl) {
    const badge = document.getElementById(`${nodeId}-res`);
    if (!badge) return;
    const res = await getImageResolution(dataUrl);
    if (res) {
        badge.textContent = `📐 ${res}`;
        badge.style.display = 'block';
    }
}

export function selectNode(id, isMulti) {
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

export function removeNode(id) {
    pushHistory();
    const ids = state.selectedNodes.has(id) ? Array.from(state.selectedNodes) : [id];
    ids.forEach(nid => {
        const node = state.nodes.get(nid);
        if (!node) return;
        state.connections = state.connections.filter(c => c.from.nodeId !== nid && c.to.nodeId !== nid);
        node.el.remove();
        state.nodes.delete(nid);
        state.selectedNodes.delete(nid);
        deleteImageAsset(nid);
    });
    updateAllConnections();
    updatePortStyles();
    scheduleSave();
}

export function toggleNodesEnabled(nodeIds, referenceNodeId) {
    if (!nodeIds.length) return;
    const ref = state.nodes.get(referenceNodeId || nodeIds[0]);
    if (!ref) return;
    const target = !ref.enabled;
    nodeIds.forEach(id => {
        const n = state.nodes.get(id);
        if (n) {
            n.enabled = target;
            n.el.classList.toggle('disabled', !target);
            if (target) n.el.classList.remove('completed', 'error', 'running');
        }
    });
    scheduleSave();
}

/**
 * Workflow Logic is now managed by workflowManager.js
 */
export { 
    pushHistory, serializeNodes, scheduleSave, saveState, undo, 
    exportWorkflow, importWorkflow, loadState, copySelectedNodes, 
    pasteNodes, selectAllNodes, zoomToFit, getSafeProviders 
} from './workflowManager.js';

/**
 * Add Node Implementation (Bridge to window.addNodeInternal for side-effect-free migration first, then move)
 */
export function addNode(type, x, y, restoreData, silent = false) {
    if (typeof window.addNodeInternal === 'function') {
        return window.addNodeInternal(type, x, y, restoreData, silent);
    }
    console.error('addNodeInternal not found on window');
    return null;
}

export function updateCanvasTransform() {
    const { x, y, zoom } = state.canvas;
    const layer = elements.nodesLayer;
    if (!layer) return;
    layer.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${zoom})`;
    layer.style.setProperty('--canvas-zoom', zoom);
    const container = elements.canvasContainer;
    if (container) {
        const gridSize = 20 * zoom;
        container.style.backgroundSize = `${gridSize}px ${gridSize}px`;
        container.style.backgroundPosition = `${x}px ${y}px`;
    }
    const zoomEl = document.getElementById('zoom-level');
    if (zoomEl) zoomEl.textContent = `${Math.round(zoom * 100)}%`;
    updateAllConnections();
}

// ===== Fullscreen Preview =====
export function openFullscreenPreview(src, nodeId = null) {
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
export function openImagePainter(src, nodeId) {
    if (typeof window.openImagePainterInternal === 'function') {
        return window.openImagePainterInternal(src, nodeId);
    }
    console.error('openImagePainterInternal not found');
}

export function applyHistoryGridCols(cols) {
    const list = elements.historyList;
    if (list) list.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    localStorage.setItem('cainflow_history_cols', cols);
}

export async function deleteHistoryItems(ids) {
    if (!confirm(`确定要删除选中的 ${ids.length} 条记录吗？`)) return;
    for (const id of ids) {
        await deleteHistoryEntry(id);
    }
    state.selectedHistoryIds.clear();
    renderHistoryList();
    showToast('记录已删除', 'info');
}

// Persistence & History logic moved to workflowManager.js

export function showLogDetail(id) {
    const log = state.logs.find(l => l.id === id);
    if (!log) return;
    showErrorModal(log.title, log.message, log.details, log.type === 'error' ? '执行错误' : '执行详情', log);
}

export async function checkUpdate(isManual = false) {
    if (isManual) {
        showToast('正在检查更新...', 'info');
        localStorage.setItem('cainflow_update_status', 'checking');
        if (window.renderGeneralSettings) window.renderGeneralSettings();
    }

    const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    const now = Date.now();
    const lastCheck = localStorage.getItem('cainflow_last_update_check');

    if (!isManual && lastCheck && (now - parseInt(lastCheck)) < CHECK_INTERVAL) return;

    localStorage.setItem('cainflow_last_update_check', now.toString());

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

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
                showToast('无法连接到更新服务器', 'error');
                if (window.renderGeneralSettings) window.renderGeneralSettings();
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
        if (isManual && window.renderGeneralSettings) window.renderGeneralSettings();
    } catch (e) {
        console.warn('Update check failed:', e);
        localStorage.setItem('cainflow_update_status', 'error');
        if (isManual) {
            showToast('检查更新失败，请检查网络', 'error');
            if (window.renderGeneralSettings) window.renderGeneralSettings();
        }
    }
}

export function showUpdateModal(releaseData) {
    const modal = document.getElementById('modal-update');
    if (!modal) return;
    const tag = document.getElementById('update-tag');
    const date = document.getElementById('update-date');
    const changelog = document.getElementById('update-changelog-content');
    const settingsBtn = document.getElementById('btn-settings');

    if (tag) tag.textContent = releaseData.tag_name;
    if (date) date.textContent = new Date(releaseData.published_at).toLocaleDateString();
    
    if (changelog) {
        let body = releaseData.body || '无更新日志详情';
        body = body.replace(/### (.*)/g, '<h4>$1</h4>')
                   .replace(/\n- (.*)/g, '\n<li>$1</li>')
                   .replace(/<li>(.*)<\/li>/g, '<ul><li>$1</li></ul>')
                   .replace(/<\/ul>\n<ul>/g, '')
                   .replace(/\n/g, '<br>');
        changelog.innerHTML = body;
    }

    if (settingsBtn) settingsBtn.classList.add('has-update');
    modal.classList.add('active');
    
    const btnDownload = document.getElementById('btn-update-download');
    if (btnDownload) btnDownload.onclick = () => window.open(releaseData.html_url, '_blank');
    const btnBackup = document.getElementById('btn-update-backup');
    if (btnBackup) btnBackup.onclick = () => {
        exportWorkflow();
        showToast('备份已导出', 'success');
    };
}
