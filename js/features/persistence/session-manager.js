/**
 * 负责本地会话状态保存、撤销栈维护与自动保存调度。
 */
import { cleanupElementResources } from '../../core/common-utils.js';
import { DEFAULT_THEME_ID } from '../../core/constants.js';
import { migrateLegacyWorkflowData } from './legacy-node-migration.js';
import { createSelectionApi } from '../../canvas/selection.js';

export function createSessionManagerApi({
    state,
    selectionApi = createSelectionApi({ state }),
    storageKey,
    nodeSerializer,
    localStorageRef = localStorage,
    documentRef = document,
    showToast,
    addNode,
    updateAllConnections,
    updatePortStyles,
    onConnectionsChanged = () => {},
    persistHistoryTransition = async () => true,
    getWorkflowSnapshot = () => Object.freeze({ active: null, open: Object.freeze([]) }),
    clearOrphanedNodeAssets = async () => true,
    beginMediaRestoreBatch = () => {},
    endMediaRestoreBatch = () => {},
    finalizeMediaRestoreBatch = async () => {},
    removeMediaReference = async () => false,
    mediaAssetExists = async () => true,
    undoMedia = { protect() {}, release: async () => {}, end: async () => {} }
}) {
    let saveTimer = null;
    let onBeforeSave = () => {};
    let lastStorageFailureToastAt = 0;
    const uiBootstrapStorageKey = 'cainflow_ui_bootstrap';
    const viewportStorageKey = 'nodeflow_ai_viewport_state';
    const storageFailureToastIntervalMs = 8000;
    let storageTextEncoder = null;
    let historyTransition = null;
    // Older builds persisted whole snapshots to retry releasing undo media.
    // The backend now clears those legacy owners itself; keep no disk copy.
    try {
        if (localStorageRef?.getItem?.('cainflow_pending_undo_media_releases') !== null) {
            localStorageRef?.removeItem?.('cainflow_pending_undo_media_releases');
        }
    } catch { /* Best effort. */ }

    async function updateSnapshotMediaOwners(snapshot, operation) {
        const undoOwnerId = snapshot?.mediaUndoOwnerId || '';
        if (!undoOwnerId) return true;
        let succeeded = true;
        for (const node of snapshot?.nodes || []) {
            for (const key of getSnapshotMediaKeys(node)) {
                try {
                    if (!await operation('workflow-undo', `${undoOwnerId}:${node.id}`, key)) succeeded = false;
                } catch { succeeded = false; }
            }
        }
        return succeeded;
    }

    function getSnapshotMediaKeys(node) {
        const topLevel = Array.isArray(node?.mediaAssetKeys) ? node.mediaAssetKeys : [];
        const nested = Array.isArray(node?.data?.mediaAssetKeys) ? node.data.mediaAssetKeys : [];
        return [...new Set([...topLevel, ...nested, node?.imageAssetKey, node?.data?.imageAssetKey,
            node?.imageImportAssetKey, node?.data?.imageImportAssetKey]
            .filter((key) => typeof key === 'string' && key.startsWith('media:')))];
    }

    async function discardMissingSnapshotMedia(snapshot) {
        const keys = [...new Set((snapshot.nodes || []).flatMap(getSnapshotMediaKeys))];
        if (keys.length === 0) return { snapshot, missingCount: 0 };
        const available = new Set();
        for (let index = 0; index < keys.length; index += 16) {
            const batch = keys.slice(index, index + 16);
            const exists = await Promise.all(batch.map((key) => mediaAssetExists(key)));
            batch.forEach((key, offset) => { if (exists[offset]) available.add(key); });
        }
        if (available.size === keys.length) return { snapshot, missingCount: 0 };
        const nodes = (snapshot.nodes || []).map((original) => {
            const originalKeys = getSnapshotMediaKeys(original);
            if (originalKeys.every((key) => available.has(key))) return original;
            const node = { ...original, data: original.data ? { ...original.data } : undefined };
            const retained = originalKeys.filter((key) => available.has(key));
            for (const holder of [node, node.data].filter(Boolean)) {
                if (Array.isArray(holder.mediaAssetKeys)) {
                    holder.mediaAssetKeys = holder.mediaAssetKeys.filter((key) => (
                        typeof key !== 'string' || !key.startsWith('media:') || available.has(key)
                    ));
                }
                for (const field of ['imageAssetKey', 'imageImportAssetKey']) {
                    if (typeof holder[field] === 'string' && holder[field].startsWith('media:')
                        && !available.has(holder[field])) {
                        if (field === 'imageImportAssetKey') holder[field] = retained[0] || '';
                        else if (retained.length) holder[field] = retained[0];
                        else delete holder[field];
                    }
                }
                if (retained.length === 0) {
                    delete holder.imageCount;
                    delete holder.imageAssetReady;
                    delete holder.imageMemoryReleased;
                    delete holder.imageHydratedAt;
                    delete holder.imagePreviewIndex;
                } else if (Number(holder.imageCount) > retained.length) {
                    holder.imageCount = retained.length;
                    if (Number(holder.imagePreviewIndex) >= retained.length) {
                        holder.imagePreviewIndex = retained.length - 1;
                    }
                }
            }
            return node;
        });
        return { snapshot: { ...snapshot, nodes }, missingCount: keys.length - available.size };
    }

    async function releaseSnapshotMediaOwners(snapshot) {
        await undoMedia.release(snapshot);
        return updateSnapshotMediaOwners(snapshot, removeMediaReference);
    }

    async function releaseLegacySnapshotMediaOwners(snapshots) {
        for (const snapshot of snapshots) await releaseSnapshotMediaOwners(snapshot);
    }

    function clearUndoStack() {
        const snapshots = [...state.undoStack.splice(0), ...getRedoStack().splice(0)].flatMap((raw) => {
            try { return [JSON.parse(raw)]; } catch { return []; }
        });
        void releaseLegacySnapshotMediaOwners(snapshots);
        updateHistoryButtons();
    }

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
        const data = sanitized.data && typeof sanitized.data === 'object'
            ? { ...sanitized.data }
            : {};
        sanitized.data = data;
        const isInlineImageData = (value) => typeof value === 'string' && /^data:image\//i.test(value.trim());

        delete sanitized.imageList;
        delete sanitized.images;
        delete sanitized.imageData;
        delete sanitized.imageDataList;
        delete sanitized.imagePreviewThumbnail;
        delete data.images;
        delete data.imageData;
        delete data.imageDataList;
        delete data.imageList;
        delete data.imagePreviewThumbnail;
        if (isInlineImageData(data.image)) delete data.image;
        if (options.stripCompareImages === true) {
            delete sanitized.compareImageA;
            delete sanitized.compareImageB;
            delete data.compareImageA;
            delete data.compareImageB;
        } else {
            if (isInlineImageData(sanitized.compareImageA)) delete sanitized.compareImageA;
            if (isInlineImageData(sanitized.compareImageB)) delete sanitized.compareImageB;
            if (isInlineImageData(data.compareImageA)) delete data.compareImageA;
            if (isInlineImageData(data.compareImageB)) delete data.compareImageB;
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
                themeId: typeof state.themeId === 'string' && state.themeId ? state.themeId : DEFAULT_THEME_ID,
                globalAnimationEnabled: state.globalAnimationEnabled !== false
            }));
            return true;
        } catch {
            // Ignore quota/privacy failures; this only speeds up the next boot theme restore.
            return false;
        }
    }

    function readViewportStates() {
        try {
            const parsed = JSON.parse(localStorageRef.getItem(viewportStorageKey) || '{}');
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }

    function loadViewportState(workflowId) {
        if (typeof workflowId !== 'string' || !workflowId) return null;
        const canvas = readViewportStates()[workflowId];
        if (!canvas || !Number.isFinite(canvas.x) || !Number.isFinite(canvas.y)
            || !Number.isFinite(canvas.zoom) || canvas.zoom <= 0) return null;
        return { x: canvas.x, y: canvas.y, zoom: canvas.zoom };
    }

    function saveViewportState({ workflowId, canvas } = {}) {
        if (typeof workflowId !== 'string' || !workflowId || !canvas
            || !Number.isFinite(canvas.x) || !Number.isFinite(canvas.y)
            || !Number.isFinite(canvas.zoom) || canvas.zoom <= 0) return false;
        try {
            const viewportStates = readViewportStates();
            const viewport = { x: canvas.x, y: canvas.y, zoom: canvas.zoom };
            viewportStates[workflowId] = viewport;
            localStorageRef.setItem(viewportStorageKey, JSON.stringify(viewportStates));
            const tab = state.workflowTabs?.find((candidate) => (
                candidate?.workflowId === workflowId || candidate?.data?.workflowId === workflowId
            ));
            if (tab?.data) tab.data.canvas = { ...viewport };
            return true;
        } catch {
            return false;
        }
    }

    function saveState() {
        if (state.canvasPlanApplying) return false;
        let serializedData = '';
        try {
            onBeforeSave({ dirty: false });
            const data = sanitizeWorkflowDataForSessionCache(nodeSerializer.buildStatePayload());
            const workflowSnapshot = getWorkflowSnapshot();
            const presentationByWorkflowId = new Map(
                (Array.isArray(state.workflowTabs) ? state.workflowTabs : [])
                    .map((tab) => [tab?.workflowId || tab?.data?.workflowId || '', tab])
                    .filter(([workflowId]) => workflowId)
            );
            const authoritativeLabelByPresentationLabel = new Map();
            const persistedOpenWorkflows = [];
            for (const record of workflowSnapshot?.open || []) {
                const tab = presentationByWorkflowId.get(record.workflowId);
                if (!tab?.data || typeof tab.data !== 'object') {
                    console.warn('Skip Open Workflow without a presentation document:', record.workflowId);
                    continue;
                }
                if (typeof tab.name === 'string' && tab.name) {
                    authoritativeLabelByPresentationLabel.set(tab.name, record.label);
                }
                persistedOpenWorkflows.push({ record, tab });
            }
            const rewriteOpenWorkflowLabel = (label) => (
                authoritativeLabelByPresentationLabel.get(label) ?? label
            );
            data.workflowTabs = persistedOpenWorkflows.map(({ record, tab }) => {
                return {
                    workflowId: record.workflowId,
                    name: record.label,
                    data: sanitizeWorkflowDataForSessionCache(tab.data),
                    dirty: tab.dirty === true,
                    identityPendingSave: record.pendingExplicitSave === true,
                    running: record.running === true,
                    colorIndex: Number.isInteger(tab.colorIndex) ? tab.colorIndex : 0,
                    runResult: tab.runResult === 'success' || tab.runResult === 'error' ? tab.runResult : ''
                };
            });
            const activeWorkflow = persistedOpenWorkflows.some(({ record }) => (
                record.workflowId === workflowSnapshot?.active?.workflowId
            ))
                ? workflowSnapshot.active
                : persistedOpenWorkflows[0]?.record || null;
            data.activeWorkflowName = activeWorkflow?.label || '';
            data.activeWorkflowId = activeWorkflow?.workflowId || '';
            data.workflowOrder = Array.isArray(state.workflowOrder)
                ? state.workflowOrder
                    .filter((name) => typeof name === 'string' && name)
                    .map(rewriteOpenWorkflowLabel)
                : [];
            data.workflowFolders = Array.isArray(state.workflowFolders)
                ? state.workflowFolders
                    .map((folder) => ({
                        id: typeof folder?.id === 'string' ? folder.id : '',
                        name: typeof folder?.name === 'string' ? folder.name : '',
                        collapsed: folder?.collapsed === true,
                        items: Array.isArray(folder?.items)
                            ? folder.items
                                .filter((name) => typeof name === 'string' && name)
                                .map(rewriteOpenWorkflowLabel)
                            : []
                    }))
                    .filter((folder) => folder.id && folder.name)
                : [];
            data.workflowSidebarWidth = Number.isFinite(Number(state.workflowSidebarWidth)) && Number(state.workflowSidebarWidth) > 0
                ? Math.round(Number(state.workflowSidebarWidth))
                : 320;
            data.workspaceMode = state.workspaceMode === 'conversation' ? 'conversation' : 'canvas';
            serializedData = JSON.stringify(data);
            localStorageRef.setItem(storageKey, serializedData);
            if (!saveUiBootstrapState()) return false;
            return true;
        } catch (e) {
            console.warn('Save failed:', e);
            if (e?.name === 'QuotaExceededError') {
                showStorageFailureDetails(e, serializedData);
            }
            return false;
        }
    }

    function scheduleSave(options = {}) {
        if (state.canvasPlanApplying) return;
        if (state.dragging || state.resizing) return;
        if (options.dirty !== false) {
            onBeforeSave({ dirty: true });
        }
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveState, 300);
    }

    function flushSave() {
        clearTimeout(saveTimer);
        saveTimer = null;
        return saveState();
    }

    function getRedoStack() {
        if (!Array.isArray(state.redoStack)) state.redoStack = [];
        return state.redoStack;
    }

    function updateHistoryButtons() {
        const undoButton = documentRef.getElementById('btn-undo');
        const redoButton = documentRef.getElementById('btn-redo');
        if (undoButton) undoButton.disabled = Boolean(historyTransition) || state.undoStack.length === 0;
        if (redoButton) redoButton.disabled = Boolean(historyTransition) || getRedoStack().length === 0;
    }

    function collectActiveNodeAssetIds() {
        const ids = new Set(state.nodes.keys());
        Array.from(state.nodes.values()).forEach((node) => {
            const imageAssetKey = typeof node?.data?.imageAssetKey === 'string' && node.data.imageAssetKey
                ? node.data.imageAssetKey
                : (typeof node?.imageAssetKey === 'string' ? node.imageAssetKey : '');
            if (imageAssetKey) ids.add(imageAssetKey);
            const importAssetKey = typeof node?.imageImportAssetKey === 'string' && node.imageImportAssetKey
                ? node.imageImportAssetKey
                : (typeof node?.data?.imageImportAssetKey === 'string' ? node.data.imageImportAssetKey : '');
            if (importAssetKey) ids.add(importAssetKey);
        });
        (state.workflowTabs || []).forEach((tab) => {
            if (!Array.isArray(tab?.data?.nodes)) return;
            tab.data.nodes.forEach((node) => {
                if (!node?.id) return;
                ids.add(node.id);
                const imageAssetKey = typeof node.imageAssetKey === 'string' && node.imageAssetKey
                    ? node.imageAssetKey
                    : (typeof node.data?.imageAssetKey === 'string' ? node.data.imageAssetKey : '');
                if (imageAssetKey) ids.add(imageAssetKey);
                const importAssetKey = typeof node.imageImportAssetKey === 'string' && node.imageImportAssetKey
                    ? node.imageImportAssetKey
                    : (typeof node.data?.imageImportAssetKey === 'string' ? node.data.imageImportAssetKey : '');
                if (importAssetKey) ids.add(importAssetKey);
            });
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

    function captureHistorySnapshot() {
        const workflowId = getWorkflowSnapshot()?.active?.workflowId || 'workflow';
        const historyId = `${workflowId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const snapshot = sanitizeWorkflowDataForSessionCache({
            nodes: nodeSerializer.serializeNodes(),
            connections: state.connections.map((connection) => ({ ...connection }))
        });
        snapshot.historyId = historyId;
        undoMedia.protect(snapshot, workflowId);
        return snapshot;
    }

    function pushSnapshot(stack, snapshot) {
        stack.push(JSON.stringify(snapshot));
        if (stack.length > 5) {
            const evicted = stack.shift();
            try { void releaseLegacySnapshotMediaOwners([JSON.parse(evicted)]); } catch { /* Legacy snapshot. */ }
            cleanupOrphanedNodeAssetsSoon();
        }
    }

    function pushHistory() {
        if (historyTransition) throw new Error('撤销或重做正在保存，请稍后再修改');
        if (state.canvasPlanApplying) return null;
        const snapshot = captureHistorySnapshot();
        const discardedRedoSnapshots = getRedoStack().splice(0).flatMap((raw) => {
            try { return [JSON.parse(raw)]; } catch { return []; }
        });
        if (discardedRedoSnapshots.length > 0) void releaseLegacySnapshotMediaOwners(discardedRedoSnapshots);
        pushSnapshot(state.undoStack, snapshot);
        updateHistoryButtons();
        return snapshot.historyId;
    }

    function discardLatestHistory(historyId) {
        const raw = state.undoStack.at(-1);
        if (!raw) return false;
        try {
            const snapshot = JSON.parse(raw);
            if ((snapshot.historyId || snapshot.mediaUndoOwnerId) !== historyId) return false;
            state.undoStack.pop();
            void releaseLegacySnapshotMediaOwners([snapshot]);
            updateHistoryButtons();
            return true;
        } catch {
            return false;
        }
    }

    async function applySnapshotGraph(snapshot) {
        beginMediaRestoreBatch();
        try {
            selectionApi.reset();
            state.nodes.forEach((node) => {
                cleanupElementResources(node.el);
                node.el.remove();
            });
            state.nodes.clear();
            state.connections = [];

            for (const nodeData of snapshot.nodes || []) {
                addNode(nodeData.type, nodeData.x, nodeData.y, nodeData, true);
            }
            if (snapshot.connections?.length) state.connections = snapshot.connections;

            updateAllConnections();
            updatePortStyles();
            onConnectionsChanged();
        } finally {
            endMediaRestoreBatch();
        }
        try {
            await finalizeMediaRestoreBatch();
        } catch (error) {
            console.warn('Finalize media restore after history transition failed:', error);
        }
    }

    async function applyHistorySnapshot(sourceStack, destinationStack, { intent, label }) {
        if (sourceStack.length === 0) return;
        if (state.runningNodeIds?.size > 0) {
            showToast(`有节点正在运行，暂不能${label}会修改运行中节点的操作`, 'warning');
            return;
        }

        const currentSnapshot = captureHistorySnapshot();
        const raw = sourceStack.at(-1);
        let originalSnapshot;
        let snapshot;
        let missingCount = 0;
        try {
            originalSnapshot = JSON.parse(raw);
            ({ snapshot, missingCount } = await discardMissingSnapshotMedia(
                migrateLegacyWorkflowData(originalSnapshot)
            ));
        } catch (error) {
            await undoMedia.release(currentSnapshot);
            console.warn('Cannot check history media before restore:', error);
            showToast(`媒体状态检查失败，未${label}操作`, 'error');
            return;
        }
        const currentNodeIds = new Set([...state.nodes.keys()].map(String));
        await applySnapshotGraph(snapshot);
        onBeforeSave({
            dirty: true,
            mediaOwnershipRestoreIntent: intent,
            mediaOwnershipRestoreOwnerIds: (snapshot.nodes || [])
                .filter((node) => !currentNodeIds.has(String(node.id)))
                .map((node) => (
                `${node.type === 'ImageImport' ? 'workflow-import' : 'workflow-node'}:${node.id}`
                ))
        });
        const persistence = await persistHistoryTransition();
        if (!persistence?.committed && persistence !== true) {
            await applySnapshotGraph(currentSnapshot);
            onBeforeSave({ dirty: true, mediaOwnershipClearRestoreMarkers: true });
            await undoMedia.release(currentSnapshot);
            showToast(`工作流已被并发修改或保存失败，未${label}操作`, 'error');
            return;
        }

        sourceStack.pop();
        pushSnapshot(destinationStack, currentSnapshot);
        await releaseLegacySnapshotMediaOwners([originalSnapshot]);
        updateHistoryButtons();
        saveState();
        cleanupOrphanedNodeAssetsSoon();
        showToast(missingCount > 0
            ? `已${label}节点和连线；${missingCount} 项已清理图片无法恢复`
            : `已${label}上一步操作`, missingCount > 0 ? 'warning' : 'info');
    }

    function transitionHistory(source, destination, options) {
        if (historyTransition) return historyTransition;
        state.historyTransitionInProgress = true;
        historyTransition = Promise.resolve().then(() => applyHistorySnapshot(source, destination, options))
            .finally(() => { historyTransition = null; state.historyTransitionInProgress = false; updateHistoryButtons(); });
        updateHistoryButtons();
        return historyTransition;
    }

    async function undo() {
        if (state.canvasPlanApplying) return;
        return transitionHistory(state.undoStack, getRedoStack(), { intent: 'undo', label: '撤回' });
    }

    async function redo() {
        if (state.canvasPlanApplying) return;
        return transitionHistory(getRedoStack(), state.undoStack, { intent: 'redo', label: '重做' });
    }

    async function applyCanvasBatch(mutate, persist) {
        if (historyTransition || state.canvasPlanApplying || state.runningNodeIds?.size || state.isRunStarting) throw new Error('画布正在修改或运行，请稍后再应用');
        clearTimeout(saveTimer);
        const before = captureHistorySnapshot();
        state.canvasPlanApplying = true;
        try {
            const result = await mutate();
            onBeforeSave({ dirty: true });
            const saved = await persist();
            if (saved === false || saved?.committed === false) throw new Error('方案保存失败，请重试应用');
            const redo = getRedoStack().splice(0);
            void releaseLegacySnapshotMediaOwners(redo.flatMap(raw => { try { return [JSON.parse(raw)]; } catch { return []; } }));
            pushSnapshot(state.undoStack, before);
            updateHistoryButtons();
            return { ...result, historyId: before.historyId };
        } catch (error) {
            await applySnapshotGraph(before);
            onBeforeSave({ dirty: true });
            await undoMedia.release(before);
            throw error;
        } finally {
            state.canvasPlanApplying = false;
        }
    }

    return {
        waitForHistoryTransitions: () => historyTransition || Promise.resolve(),
        endUndoSession: () => undoMedia.end(),
        applyCanvasBatch,
        scheduleSave,
        saveState,
        flushSave,
        saveViewportState,
        loadViewportState,
        setBeforeSave,
        pushHistory,
        discardLatestHistory,
        updateUndoButton: updateHistoryButtons,
        undo,
        redo,
        collectActiveNodeAssetIds,
        cleanupOrphanedNodeAssetsSoon,
        clearUndoStack
    };
}
