/**
 * 负责本地会话状态保存、撤销栈维护与自动保存调度。
 */
import { cleanupElementResources } from '../../core/common-utils.js';

export function createSessionManagerApi({
    state,
    storageKey,
    nodeSerializer,
    localStorageRef = localStorage,
    documentRef = document,
    showToast,
    addNode,
    updateAllConnections,
    updatePortStyles,
    onConnectionsChanged = () => {},
    clearOrphanedNodeAssets = async () => true
}) {
    let saveTimer = null;
    let onBeforeSave = () => {};
    let lastStorageFailureToastAt = 0;
    const uiBootstrapStorageKey = 'cainflow_ui_bootstrap';
    const storageFailureToastIntervalMs = 8000;
    let storageTextEncoder = null;

    function getStringStorageBytes(value) {
        const text = String(value ?? '');
        const Encoder = globalThis.TextEncoder;
        if (Encoder) {
            storageTextEncoder = storageTextEncoder || new Encoder();
            return storageTextEncoder.encode(text).length;
        }
        return text.length * 2;
    }

    function formatStorageBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) return '未知';
        if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${Math.round(bytes)} B`;
    }

    function getLocalStorageBytes() {
        let bytes = 0;
        try {
            for (let i = 0; i < localStorageRef.length; i++) {
                const key = localStorageRef.key(i);
                bytes += getStringStorageBytes(key);
                bytes += getStringStorageBytes(localStorageRef.getItem(key));
            }
        } catch {
            return null;
        }
        return bytes;
    }

    function shouldShowStorageFailureToast() {
        const now = Date.now();
        if (now - lastStorageFailureToastAt < storageFailureToastIntervalMs) return false;
        lastStorageFailureToastAt = now;
        return true;
    }

    async function getBrowserStorageEstimate() {
        try {
            const storage = globalThis.navigator?.storage;
            if (!storage?.estimate) return null;
            const estimate = await storage.estimate();
            const usage = Number.isFinite(estimate?.usage) ? estimate.usage : null;
            const quota = Number.isFinite(estimate?.quota) ? estimate.quota : null;
            return { usage, quota };
        } catch {
            return null;
        }
    }

    async function showStorageFailureDetails(error, payloadText = '') {
        if (!shouldShowStorageFailureToast()) return;

        const payloadBytes = getStringStorageBytes(storageKey) + getStringStorageBytes(payloadText);
        const localBytes = getLocalStorageBytes();
        const estimate = await getBrowserStorageEstimate();
        const quotaFreeBytes = estimate?.usage !== null && estimate?.quota !== null
            ? estimate.quota - estimate.usage
            : null;
        const localAfterWriteBytes = localBytes !== null ? localBytes + payloadBytes : null;

        const details = [
            `本次会话状态 ${formatStorageBytes(payloadBytes)}`
        ];
        if (localBytes !== null) details.push(`localStorage 当前 ${formatStorageBytes(localBytes)}`);
        if (estimate?.quota !== null) {
            details.push(`浏览器配额剩余约 ${formatStorageBytes(quotaFreeBytes)}`);
        }

        let reason = '浏览器拒绝写入 localStorage';
        if (quotaFreeBytes !== null && quotaFreeBytes < payloadBytes) {
            reason = `浏览器配额剩余不足，需要 ${formatStorageBytes(payloadBytes)}，剩余约 ${formatStorageBytes(quotaFreeBytes)}`;
        } else if (localAfterWriteBytes !== null && localAfterWriteBytes > 4.5 * 1024 * 1024) {
            reason = `localStorage 接近或超过单域常见上限，写入后约 ${formatStorageBytes(localAfterWriteBytes)}`;
        } else if (estimate?.quota !== null) {
            reason = '浏览器总配额看起来足够，可能是 localStorage 单独上限、隐私模式或浏览器策略限制';
        }

        showToast(`${reason}；${details.join('，')}。错误: ${error?.name || '未知'}`, 'error', 9000);
    }

    function setBeforeSave(callback) {
        onBeforeSave = typeof callback === 'function' ? callback : () => {};
    }

    function sanitizeNodeForSessionCache(node, options = {}) {
        if (!node || typeof node !== 'object') return node;
        const sanitized = { ...node };
        delete sanitized.images;
        delete sanitized.imageData;
        if (options.stripCompareImages === true) {
            delete sanitized.compareImageA;
            delete sanitized.compareImageB;
        }
        return sanitized;
    }

    function sanitizeWorkflowDataForSessionCache(workflowData) {
        if (!workflowData || typeof workflowData !== 'object') return workflowData;
        const sanitized = { ...workflowData };
        const incomingImageTargets = new Set(
            (Array.isArray(workflowData.connections) ? workflowData.connections : [])
                .filter((connection) => (
                    connection?.to?.nodeId
                    && (connection.to.port === 'image' || connection.to.port === 'imageA' || connection.to.port === 'imageB')
                ))
                .map((connection) => connection.to.nodeId)
        );
        if (Array.isArray(workflowData.nodes)) {
            sanitized.nodes = workflowData.nodes.map((node) => sanitizeNodeForSessionCache(node, {
                stripCompareImages: node?.type === 'ImageCompare' && incomingImageTargets.has(node.id)
            }));
        }
        if (Array.isArray(workflowData.connections)) {
            sanitized.connections = workflowData.connections.map((connection) => ({ ...connection }));
        }
        return sanitized;
    }

    function saveUiBootstrapState() {
        try {
            localStorageRef.setItem(uiBootstrapStorageKey, JSON.stringify({
                themeId: typeof state.themeId === 'string' && state.themeId ? state.themeId : 'dark',
                globalAnimationEnabled: state.globalAnimationEnabled !== false
            }));
        } catch {
            // Ignore quota/privacy failures; this only speeds up the next boot theme restore.
        }
    }

    function saveState() {
        let serializedData = '';
        try {
            onBeforeSave({ dirty: false });
            const data = sanitizeWorkflowDataForSessionCache(nodeSerializer.buildStatePayload());
            data.workflowTabs = Array.isArray(state.workflowTabs)
                ? state.workflowTabs.map((tab) => ({
                    name: tab.name,
                    data: sanitizeWorkflowDataForSessionCache(tab.data),
                    dirty: tab.dirty === true,
                    colorIndex: Number.isInteger(tab.colorIndex) ? tab.colorIndex : 0,
                    runResult: tab.runResult === 'success' || tab.runResult === 'error' ? tab.runResult : ''
                }))
                : [];
            data.activeWorkflowName = state.activeWorkflowName || '';
            data.workflowOrder = Array.isArray(state.workflowOrder)
                ? state.workflowOrder.filter((name) => typeof name === 'string' && name)
                : [];
            data.workflowFolders = Array.isArray(state.workflowFolders)
                ? state.workflowFolders
                    .map((folder) => ({
                        id: typeof folder?.id === 'string' ? folder.id : '',
                        name: typeof folder?.name === 'string' ? folder.name : '',
                        collapsed: folder?.collapsed === true,
                        items: Array.isArray(folder?.items) ? folder.items.filter((name) => typeof name === 'string' && name) : []
                    }))
                    .filter((folder) => folder.id && folder.name)
                : [];
            data.workflowSidebarWidth = Number.isFinite(Number(state.workflowSidebarWidth)) && Number(state.workflowSidebarWidth) > 0
                ? Math.round(Number(state.workflowSidebarWidth))
                : 320;
            serializedData = JSON.stringify(data);
            localStorageRef.setItem(storageKey, serializedData);
            saveUiBootstrapState();
        } catch (e) {
            console.warn('Save failed:', e);
            if (e?.name === 'QuotaExceededError') {
                showStorageFailureDetails(e, serializedData);
            }
        }
    }

    function scheduleSave(options = {}) {
        if (state.dragging || state.resizing) return;
        if (options.dirty !== false) {
            onBeforeSave({ dirty: true });
        }
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveState, 300);
    }

    function updateUndoButton() {
        const btn = documentRef.getElementById('btn-undo');
        if (btn) btn.disabled = state.undoStack.length === 0;
    }

    function collectActiveNodeAssetIds() {
        const ids = new Set(state.nodes.keys());
        (state.workflowTabs || []).forEach((tab) => {
            if (!Array.isArray(tab?.data?.nodes)) return;
            tab.data.nodes.forEach((node) => {
                if (!node?.id) return;
                ids.add(node.id);
                if (typeof node.imageAssetKey === 'string' && node.imageAssetKey) {
                    ids.add(node.imageAssetKey);
                }
            });
        });
        state.undoStack.forEach((raw) => {
            try {
                const snapshot = JSON.parse(raw);
                if (!Array.isArray(snapshot?.nodes)) return;
                snapshot.nodes.forEach((node) => {
                    if (node?.id) ids.add(node.id);
                });
            } catch {
                // Ignore invalid legacy undo entries.
            }
        });
        return ids;
    }

    function cleanupOrphanedNodeAssetsSoon() {
        setTimeout(() => {
            clearOrphanedNodeAssets(collectActiveNodeAssetIds()).catch((error) => {
                console.warn('Clear orphaned node assets failed:', error);
            });
        }, 0);
    }

    function pushHistory() {
        const snapshot = {
            nodes: nodeSerializer.serializeNodes(false),
            connections: state.connections.map((connection) => ({ ...connection }))
        };
        state.undoStack.push(JSON.stringify(snapshot));
        if (state.undoStack.length > 5) {
            state.undoStack.shift();
            cleanupOrphanedNodeAssetsSoon();
        }
        updateUndoButton();
    }

    async function undo() {
        if (state.undoStack.length === 0) return;
        if (state.runningNodeIds?.size > 0) {
            showToast('有节点正在运行，暂不能撤销会修改运行中节点的操作', 'warning');
            return;
        }

        const raw = state.undoStack.pop();
        const snapshot = JSON.parse(raw);

        state.selectedNodes.clear();
        state.nodes.forEach((node) => {
            cleanupElementResources(node.el);
            node.el.remove();
        });
        state.nodes.clear();
        state.connections = [];

        if (snapshot.nodes && snapshot.nodes.length) {
            for (const nodeData of snapshot.nodes) {
                addNode(nodeData.type, nodeData.x, nodeData.y, nodeData, true);
            }
        }

        if (snapshot.connections && snapshot.connections.length) {
            state.connections = snapshot.connections;
        }

        updateAllConnections();
        updatePortStyles();
        onConnectionsChanged();
        updateUndoButton();
        onBeforeSave({ dirty: true });
        saveState();
        cleanupOrphanedNodeAssetsSoon();
        showToast('已撤回上一步操作', 'info');
    }

    return {
        scheduleSave,
        saveState,
        setBeforeSave,
        pushHistory,
        updateUndoButton,
        undo,
        collectActiveNodeAssetIds,
        cleanupOrphanedNodeAssetsSoon
    };
}
