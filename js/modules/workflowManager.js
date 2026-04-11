import { 
    NODE_CONFIGS, STORE_HISTORY, STORAGE_KEY,
    APP_VERSION, GITHUB_REPO
} from './constants.js';

import { 
    generateId, showToast, debounce
} from './utils.js';

import {
    getImageResolution
} from './imageUtils.js';

import { state } from './state.js';
import {
    getHistory, deleteHistoryEntry, saveHistoryEntry
} from './db.js';

import {
    elements, updateAllConnections, updatePortStyles, updateCanvasTransform, addNode
} from './ui_bridge.js';

/**
 * Persistence & History
 */

export function pushHistory() {
    const snapshot = {
        nodes: serializeNodes(true),
        connections: state.connections.map(c => ({...c}))
    };
    state.undoStack.push(JSON.stringify(snapshot));
    if (state.undoStack.length > 50) state.undoStack.shift();
    const btn = document.getElementById('btn-undo');
    if (btn) btn.disabled = false;
}

export function serializeNodes(includeImages = false) {
    const nodes = [];
    for (const [id, node] of state.nodes) {
        const s = {
            id, type: node.type, x: node.x, y: node.y,
            width: node.width, height: node.height, enabled: node.enabled
        };
        if (includeImages && node.imageData) s.imageData = node.imageData;
        if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
            s.apiConfigId = document.getElementById(`${id}-apiconfig`)?.value;
            s.prompt = document.getElementById(`${id}-prompt`)?.value;
        }
        nodes.push(s);
    }
    return nodes;
}

let saveTimer = null;
export function scheduleSave() {
    if (state.dragging || state.resizing) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 300);
}

export function saveState() {
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
    }
}

export async function undo() {
    if (state.undoStack.length === 0) return;
    const raw = state.undoStack.pop();
    const snapshot = JSON.parse(raw);
    state.selectedNodes.clear();
    state.nodes.forEach(n => n.el.remove());
    state.nodes.clear();
    state.connections = [];
    if (snapshot.nodes && snapshot.nodes.length) {
        for (const nd of snapshot.nodes) addNode(nd.type, nd.x, nd.y, nd, true);
    }
    if (snapshot.connections && snapshot.connections.length) state.connections = snapshot.connections;
    updateAllConnections();
    updatePortStyles();
    const btn = document.getElementById('btn-undo');
    if (btn) btn.disabled = state.undoStack.length === 0;
    saveState();
    showToast('已撤回上一步操作', 'info');
}

export function exportWorkflow() {
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

export function importWorkflow(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.nodes || !Array.isArray(data.nodes)) throw new Error('无效的项目格式');
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

export async function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (data.providers) state.providers = data.providers;
        if (data.models) state.models = data.models;
        if (data.notificationsEnabled !== undefined) {
             state.notificationsEnabled = data.notificationsEnabled;
             const t = document.getElementById('toggle-notifications');
             if (t) t.checked = state.notificationsEnabled;
        }
        if (data.autoRetry !== undefined) {
            state.autoRetry = data.autoRetry;
            const t = document.getElementById('toggle-retry');
            if (t) t.checked = state.autoRetry;
        }
        if (data.proxy) state.proxy = data.proxy;
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
                    state.connections.push(conn);
                }
            }
            updateAllConnections();
            updatePortStyles();
        }
        updateCanvasTransform();
        return data.nodes?.length > 0;
    } catch (e) { console.warn('Load failed:', e); return false; }
}

export function serializeOneNode(nodeId) {
    const node = state.nodes.get(nodeId);
    if (!node) return null;
    const id = nodeId;
    const s = { id, type: node.type, x: node.x, y: node.y, width: node.width || null, height: node.height || null };
    if (node.type === 'ImageImport' || node.type === 'ImagePreview' || node.type === 'ImageSave') {
        s.imageData = node.data?.image || node.imageData || null;
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

export function copySelectedNodes() {
    const selectedIds = Array.from(state.selectedNodes);
    if (selectedIds.length === 0) return showToast('未选中节点', 'warning');

    const nodes = selectedIds.map(id => serializeOneNode(id)).filter(n => !!n);
    if (nodes.length === 0) return;

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

export function pasteNodes() {
    if (!state.clipboard || !state.clipboard.nodes.length) return showToast('剪贴板为空', 'warning');
    const mousePos = state.mouseCanvas;
    const clip = state.clipboard;
    const idMap = new Map();

    state.selectedNodes.forEach(nid => {
        const n = state.nodes.get(nid); if (n) n.el.classList.remove('selected');
    });
    state.selectedNodes.clear();

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

    clip.connections.forEach(c => {
        const newFromId = idMap.get(c.from.nodeId);
        const newToId = idMap.get(c.to.nodeId);
        if (newFromId && newToId) {
            state.connections.push({
                id: generateId(),
                from: { nodeId: newFromId, port: c.from.port },
                to: { nodeId: newToId, port: c.to.port },
                type: c.type
            });
        }
    });

    updateAllConnections();
    updatePortStyles();
    scheduleSave();
}

export function zoomToFit(targetNodes = null) {
    let nodesToFit = targetNodes;
    if (!nodesToFit) {
        nodesToFit = state.selectedNodes.size > 0
            ? Array.from(state.selectedNodes).map(id => state.nodes.get(id)).filter(Boolean)
            : Array.from(state.nodes.values());
    }
    if (nodesToFit.length === 0) {
        state.canvas.zoom = 1;
        state.canvas.x = elements.canvasContainer.clientWidth / 2;
        state.canvas.y = elements.canvasContainer.clientHeight / 2;
        updateCanvasTransform();
        return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodesToFit.forEach(node => {
        const w = node.el.offsetWidth || 300;
        const h = node.el.offsetHeight || 200;
        minX = Math.min(minX, node.x); minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + w); maxY = Math.max(maxY, node.y + h);
    });

    const padding = 60;
    const worldW = (maxX - minX) + padding * 2;
    const worldH = (maxY - minY) + padding * 2;
    const viewW = elements.canvasContainer.clientWidth;
    const viewH = elements.canvasContainer.clientHeight;

    const zoom = Math.min(viewW / worldW, viewH / worldH, 1.2);
    state.canvas.zoom = Math.max(0.1, zoom);
    state.canvas.x = viewW / 2 - (minX + maxX) / 2 * state.canvas.zoom;
    state.canvas.y = viewH / 2 - (minY + maxY) / 2 * state.canvas.zoom;
    updateCanvasTransform();
}

export function selectAllNodes() {
    state.nodes.forEach((node, id) => {
        state.selectedNodes.add(id);
        node.el.classList.add('selected');
    });
    updateAllConnections();
}

export function getSafeProviders() {
    return state.providers.map(p => {
        const { apikey, ...rest } = p;
        return { ...rest, apikey: '' };
    });
}
