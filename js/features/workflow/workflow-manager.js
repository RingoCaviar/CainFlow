/**
 * 负责工作流文件管理，包括列表渲染、保存、加载、删除与校验提示。
 */
import {
    createWorkflowFolder as createWorkflowFolderService,
    deleteWorkflowFolder as deleteWorkflowFolderService,
    deleteWorkflowFile as deleteWorkflowFileService,
    fetchWorkflows as fetchWorkflowsService,
    fetchWorkflowEntries as fetchWorkflowEntriesService,
    loadWorkflowFromFile as loadWorkflowFromFileService,
    renameWorkflowFolder as renameWorkflowFolderService,
    renameWorkflowFile as renameWorkflowFileService,
    saveWorkflowToFile as saveWorkflowToFileService
} from '../../services/workflow-api.js';
import {
    buildWorkflowModelWarningMessage,
    resolveWorkflowModelReferences
} from '../persistence/workflow-model-resolver.js';
import { migrateLegacyWorkflowData } from '../persistence/legacy-node-migration.js';
import { openDialogStyle1 } from '../ui/dialog-style-1.js';
import { cleanupElementResources } from '../../core/common-utils.js';

export function createWorkflowManagerApi({
    state,
    nodeSerializer,
    viewportApi,
    addNode,
    updateAllConnections,
    updatePortStyles,
    onConnectionsChanged = () => {},
    scheduleSave,
    showToast,
    panelManager,
    clearImageAssets = null,
    clearOrphanedNodeAssets = null,
    clearUndoStack = () => {},
    updateCacheUsage = () => {},
    onWorkflowViewApplied = () => {},
    refreshRecoverableMediaNodes = async () => {},
    waitForImageRestores = async () => {},
    beginMediaRestoreBatch = () => {},
    endMediaRestoreBatch = () => {},
    finalizeMediaRestoreBatch = async () => {},
    documentRef = document,
    windowRef = window,
    localStorageRef = localStorage
}) {
    const WORKFLOW_VERSION = '1.3';
    const TAB_COLORS = 6;
    const RUN_RESULT_SUCCESS = 'success';
    const RUN_RESULT_ERROR = 'error';
    const WORKFLOW_ROOT_DROP_GAP = 12;
    const WORKFLOW_SIDEBAR_DEFAULT_WIDTH = 320;
    const WORKFLOW_SIDEBAR_MIN_WIDTH = 260;
    const WORKFLOW_SIDEBAR_MAX_WIDTH = 680;
    let workflowSelectionMode = false;
    let draggingWorkflowName = '';
    let pendingAssetCleanupIncludeCanvas = false;
    let assetCleanupRunning = false;
    let assetCleanupQueued = false;
    let cachedWorkflowEntries = { workflows: [], folders: [] };
    let hasCachedWorkflowEntries = false;
    const selectedWorkflowNames = new Set();

    function normalizeWorkflowSidebarWidth(value) {
        const width = Number(value);
        const viewportWidth = Number(windowRef?.innerWidth) || 0;
        const viewportMax = viewportWidth > 0
            ? Math.max(WORKFLOW_SIDEBAR_MIN_WIDTH, viewportWidth - 96)
            : WORKFLOW_SIDEBAR_MAX_WIDTH;
        const maxWidth = Math.min(WORKFLOW_SIDEBAR_MAX_WIDTH, viewportMax);
        if (!Number.isFinite(width) || width <= 0) {
            return Math.min(WORKFLOW_SIDEBAR_DEFAULT_WIDTH, maxWidth);
        }
        return Math.max(WORKFLOW_SIDEBAR_MIN_WIDTH, Math.min(maxWidth, Math.round(width)));
    }

    function applyWorkflowSidebarWidth(width = state.workflowSidebarWidth) {
        const normalizedWidth = normalizeWorkflowSidebarWidth(width);
        state.workflowSidebarWidth = normalizedWidth;
        const sidebar = documentRef.getElementById('workflow-sidebar');
        if (!sidebar) return;
        sidebar.style.setProperty('--workflow-sidebar-width', `${normalizedWidth}px`);
    }

    function bindWorkflowSidebarResize() {
        const sidebar = documentRef.getElementById('workflow-sidebar');
        const handle = documentRef.getElementById('workflow-sidebar-resize-handle');
        if (!sidebar || !handle || handle.dataset.bound === '1') return;
        handle.dataset.bound = '1';

        let resizing = false;

        const onPointerMove = (event) => {
            if (!resizing) return;
            const rect = sidebar.getBoundingClientRect();
            applyWorkflowSidebarWidth(event.clientX - rect.left);
        };

        const stopResize = () => {
            if (!resizing) return;
            resizing = false;
            documentRef.body?.classList.remove('workflow-sidebar-resizing');
            windowRef.removeEventListener('pointermove', onPointerMove);
            windowRef.removeEventListener('pointerup', stopResize);
            windowRef.removeEventListener('pointercancel', stopResize);
            scheduleSave({ dirty: false });
        };

        handle.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            resizing = true;
            documentRef.body?.classList.add('workflow-sidebar-resizing');
            applyWorkflowSidebarWidth();
            windowRef.addEventListener('pointermove', onPointerMove);
            windowRef.addEventListener('pointerup', stopResize);
            windowRef.addEventListener('pointercancel', stopResize);
        });

        windowRef.addEventListener('resize', () => {
            applyWorkflowSidebarWidth();
        });
    }

    function normalizeWorkflowRunResult(value) {
        return value === RUN_RESULT_SUCCESS || value === RUN_RESULT_ERROR ? value : '';
    }

    async function fetchWorkflows() {
        return fetchWorkflowsService();
    }

    async function fetchWorkflowEntries() {
        return fetchWorkflowEntriesService();
    }

    function updateWorkflowEntriesCache(entries) {
        cachedWorkflowEntries = {
            workflows: Array.from(new Set(Array.isArray(entries?.workflows) ? entries.workflows.filter(Boolean) : [])),
            folders: Array.from(new Set(Array.isArray(entries?.folders) ? entries.folders.filter(Boolean) : []))
        };
        hasCachedWorkflowEntries = true;
        return cachedWorkflowEntries;
    }

    async function getWorkflowEntriesForRender({ forceReload = false } = {}) {
        if (!forceReload && hasCachedWorkflowEntries) return cachedWorkflowEntries;
        return updateWorkflowEntriesCache(await fetchWorkflowEntries());
    }

    function removeWorkflowEntriesFromCache(names = []) {
        if (!hasCachedWorkflowEntries || !Array.isArray(names) || names.length === 0) return;
        const deleted = new Set(names.filter(Boolean));
        cachedWorkflowEntries = {
            workflows: cachedWorkflowEntries.workflows.filter((name) => !deleted.has(name)),
            folders: cachedWorkflowEntries.folders.slice()
        };
    }

    async function saveWorkflowToFile(name, data) {
        const result = await saveWorkflowToFileService(name, stripInlineImagesFromWorkflowData(data));
        if (result !== true) {
            showToast(result.message, 'error');
            return false;
        }
        return true;
    }

    async function loadWorkflowFromFile(name) {
        const result = await loadWorkflowFromFileService(name);
        if (result?.ok === false) {
            showToast(result.message, 'error');
            return null;
        }
        return result;
    }

    async function deleteWorkflowFile(name) {
        const result = await deleteWorkflowFileService(name);
        if (result !== true) {
            showToast(result.message, 'error');
            return false;
        }
        return true;
    }

    async function renameWorkflowFile(oldName, newName) {
        const result = await renameWorkflowFileService(oldName, newName);
        if (result !== true) {
            showToast(result.message, 'error');
            return false;
        }
        return true;
    }

    async function createWorkflowFolderOnDisk(name) {
        const result = await createWorkflowFolderService(name);
        if (result !== true) {
            showToast(result.message, 'error');
            return false;
        }
        return true;
    }

    async function renameWorkflowFolderOnDisk(oldName, newName) {
        const result = await renameWorkflowFolderService(oldName, newName);
        if (result?.ok === false) {
            showToast(result.message, 'error');
            return null;
        }
        return result;
    }

    async function deleteWorkflowFolderOnDisk(name, { deleteContents = false } = {}) {
        const result = await deleteWorkflowFolderService(name, { deleteContents });
        if (result?.ok === false) {
            showToast(result.message, 'error');
            return null;
        }
        return result;
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function promptWorkflowCloseDecision({
        title = '关闭工作流',
        message = '',
        note = '选择“是”会保存并关闭，选择“否”会直接关闭，选择“取消”会保留当前工作流。',
        yesText = '是',
        noText = '否',
        cancelText = '取消'
    } = {}) {
        return openDialogStyle1({
            id: 'workflow-confirm-dialog',
            title,
            message,
            note,
            cancelActionId: 'cancel',
            documentRef,
            actions: [
                { id: 'cancel', label: cancelText, variant: 'secondary' },
                { id: 'discard', label: noText, variant: 'secondary' },
                { id: 'save', label: yesText, variant: 'primary', autofocus: true }
            ]
        });
    }

    async function confirmWorkflowAction(options = {}) {
        const decision = await promptWorkflowCloseDecision(options);
        return decision === 'save';
    }

    function promptWorkflowDeleteDecision({
        title = '删除工作流',
        message = '',
        note = '选择“是”会删除，选择“否”会保留。',
        yesText = '是',
        noText = '否'
    } = {}) {
        return openDialogStyle1({
            id: 'workflow-delete-dialog',
            title,
            message,
            note,
            cancelActionId: 'cancel',
            documentRef,
            actions: [
                { id: 'decline', label: noText, variant: 'secondary' },
                { id: 'confirm', label: yesText, variant: 'primary', autofocus: true }
            ]
        });
    }

    async function confirmWorkflowDelete(options = {}) {
        const decision = await promptWorkflowDeleteDecision(options);
        return decision === 'confirm';
    }

    function getWorkflowPayload() {
        return {
            canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom },
            nodes: nodeSerializer.serializeNodes(),
            connections: state.connections.map((conn) => ({ id: conn.id, from: conn.from, to: conn.to, type: conn.type })),
            version: WORKFLOW_VERSION
        };
    }

    function cloneWorkflowData(data) {
        if (!data || typeof data !== 'object') return getEmptyWorkflowData();
        try {
            return JSON.parse(JSON.stringify(data));
        } catch {
            return {
                canvas: { ...(data.canvas || {}) },
                nodes: Array.isArray(data.nodes) ? data.nodes.map((node) => ({ ...node })) : [],
                connections: Array.isArray(data.connections) ? data.connections.map((connection) => ({ ...connection })) : [],
                version: data.version || WORKFLOW_VERSION
            };
        }
    }

    function cloneWorkflowItem(item) {
        if (!item || typeof item !== 'object') return item;
        try {
            return JSON.parse(JSON.stringify(item));
        } catch {
            return { ...item };
        }
    }

    function normalizeConnectionId(connection, index = 0) {
        if (connection?.id) return String(connection.id);
        const from = connection?.from || {};
        const to = connection?.to || {};
        return [
            from.nodeId || '',
            from.port || '',
            to.nodeId || '',
            to.port || '',
            connection?.type || '',
            index
        ].join('::');
    }

    function mergeRunWorkflowData(currentData, runtimeData, options = {}) {
        const current = cloneWorkflowData(currentData);
        const runtime = cloneWorkflowData(runtimeData);
        const runtimeNodes = Array.isArray(runtime.nodes) ? runtime.nodes : [];
        const baseNodeIds = options.baseNodeIds instanceof Set ? options.baseNodeIds : null;
        const baseConnectionIds = options.baseConnectionIds instanceof Set ? options.baseConnectionIds : null;
        const mergeNodeIds = options.mergeNodeIds instanceof Set ? options.mergeNodeIds : null;
        const mergedNodeIds = new Set();
        const runtimeNodeById = new Map(runtimeNodes.map((node) => [node?.id, node]).filter(([id]) => id));
        const mergedNodes = [];

        (Array.isArray(current.nodes) ? current.nodes : []).forEach((node) => {
            if (!node?.id) return;
            const runtimeNode = runtimeNodeById.get(node.id);
            const shouldMergeRuntimeNode = runtimeNode && (!mergeNodeIds || mergeNodeIds.has(node.id));
            mergedNodes.push(shouldMergeRuntimeNode ? cloneWorkflowItem(runtimeNode) : node);
            mergedNodeIds.add(node.id);
            runtimeNodeById.delete(node.id);
        });

        runtimeNodeById.forEach((node, nodeId) => {
            if (!nodeId) return;
            if (baseNodeIds?.has(nodeId)) return;
            mergedNodes.push(node);
            mergedNodeIds.add(nodeId);
        });

        const mergedConnections = [];
        const mergedConnectionIds = new Set();
        (Array.isArray(current.connections) ? current.connections : []).forEach((connection, index) => {
            if (!connection?.from?.nodeId || !connection?.to?.nodeId) return;
            if (!mergedNodeIds.has(connection.from.nodeId) || !mergedNodeIds.has(connection.to.nodeId)) return;
            mergedConnectionIds.add(normalizeConnectionId(connection, index));
            mergedConnections.push(connection);
        });

        (Array.isArray(runtime.connections) ? runtime.connections : []).forEach((connection, index) => {
            if (!connection?.from?.nodeId || !connection?.to?.nodeId) return;
            if (!mergedNodeIds.has(connection.from.nodeId) || !mergedNodeIds.has(connection.to.nodeId)) return;
            const connectionId = normalizeConnectionId(connection, index);
            if (mergedConnectionIds.has(connectionId)) return;
            if (baseConnectionIds?.has(connectionId)) return;
            mergedConnectionIds.add(connectionId);
            mergedConnections.push(connection);
        });

        return {
            canvas: current.canvas || runtime.canvas || getEmptyWorkflowData().canvas,
            nodes: mergedNodes,
            connections: mergedConnections,
            version: runtime.version || current.version || WORKFLOW_VERSION
        };
    }

    function getSafeWorkflowFileName(name) {
        const safeName = String(name || 'workflow')
            .trim()
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/^\.+/, '')
            .slice(0, 80);
        return safeName || 'workflow';
    }

    function downloadWorkflowJson(name, data) {
        const blob = new Blob([JSON.stringify(stripInlineImagesFromWorkflowData(data), null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = documentRef.createElement('a');
        link.href = url;
        link.download = `${getSafeWorkflowFileName(name)}.json`;
        link.click();
        URL.revokeObjectURL(url);
    }

    async function getWorkflowDataForAction(name) {
        if (!name) return null;
        if (state.activeWorkflowName === name) snapshotActiveWorkflow();
        const tab = getWorkflowTab(name);
        if (tab) return cloneWorkflowData(tab.data);
        const data = await loadWorkflowFromFile(name);
        return data ? cloneWorkflowData(data) : null;
    }

    function collectOpenWorkflowNodeIds({ includeCanvas = true } = {}) {
        const ids = new Set();
        (state.workflowTabs || []).forEach((tab) => {
            if (tab?.name === state.activeWorkflowName) return;
            if (!Array.isArray(tab?.data?.nodes)) return;
            tab.data.nodes.forEach((node) => {
                if (node?.id) ids.add(node.id);
            });
        });
        if (includeCanvas) {
            state.nodes.forEach((node, id) => {
                ids.add(node?.id || id);
            });
        }
        return ids;
    }

    async function cleanupOpenWorkflowAssets({ includeCanvas = true } = {}) {
        if (typeof clearOrphanedNodeAssets === 'function') {
            const ok = await clearOrphanedNodeAssets(collectOpenWorkflowNodeIds({ includeCanvas }));
            updateCacheUsage();
            return ok;
        }
        if (clearImageAssets) {
            const ok = await clearImageAssets({ preserveHistory: true });
            updateCacheUsage();
            return ok;
        }
        return true;
    }

    function scheduleOpenWorkflowAssetCleanup({ includeCanvas = true } = {}) {
        pendingAssetCleanupIncludeCanvas = pendingAssetCleanupIncludeCanvas || includeCanvas;
        assetCleanupQueued = true;
        if (assetCleanupRunning) return;

        assetCleanupRunning = true;
        windowRef.setTimeout(async () => {
            try {
                while (assetCleanupQueued) {
                    const nextIncludeCanvas = pendingAssetCleanupIncludeCanvas;
                    assetCleanupQueued = false;
                    pendingAssetCleanupIncludeCanvas = false;
                    await cleanupOpenWorkflowAssets({ includeCanvas: nextIncludeCanvas });
                }
            } catch (error) {
                console.warn('Deferred workflow asset cleanup failed:', error);
            } finally {
                assetCleanupRunning = false;
                if (assetCleanupQueued) {
                    scheduleOpenWorkflowAssetCleanup({ includeCanvas: pendingAssetCleanupIncludeCanvas });
                }
            }
        }, 0);
    }

    function getWorkflowTab(name) {
        return (state.workflowTabs || []).find((tab) => tab.name === name) || null;
    }

    function getActiveWorkflowTab() {
        return state.activeWorkflowName ? getWorkflowTab(state.activeWorkflowName) : null;
    }

    function snapshotActiveWorkflow({ markDirty = false } = {}) {
        const tab = getActiveWorkflowTab();
        if (!tab) return null;
        tab.data = getWorkflowPayload();
        if (markDirty) tab.dirty = true;
        return tab;
    }

    function refreshWorkflowCardState(name) {
        const list = documentRef.getElementById('workflow-list');
        if (!list || !name) return;
        const item = Array.from(list.querySelectorAll('.workflow-item'))
            .find((candidate) => candidate.dataset.name === name);
        if (!item) return;
        const tab = getWorkflowTab(name);
        const isOpen = !!tab;
        const isActive = state.activeWorkflowName === name;
        const runResult = !isActive ? normalizeWorkflowRunResult(tab?.runResult) : '';
        item.classList.toggle('is-open', isOpen);
        item.classList.toggle('is-active', isActive);
        item.classList.toggle('is-dirty', tab?.dirty === true);
        item.classList.toggle('is-running', tab?.running === true);
        item.classList.toggle('has-run-result', !!runResult);
        item.classList.toggle('is-run-success', runResult === RUN_RESULT_SUCCESS);
        item.classList.toggle('is-run-error', runResult === RUN_RESULT_ERROR);
        item.classList.toggle('is-selected', selectedWorkflowNames.has(name));
        const stateLabel = item.querySelector('.workflow-item-state');
        if (stateLabel) stateLabel.textContent = getWorkflowCardStateLabel({ isActive, isOpen, running: tab?.running === true, runResult });
    }

    function refreshWorkflowSelectionUi() {
        const list = documentRef.getElementById('workflow-list');
        list?.classList.toggle('workflow-multi-select-mode', workflowSelectionMode);
        list?.querySelectorAll('.workflow-item').forEach((item) => {
            item.classList.toggle('is-selected', selectedWorkflowNames.has(item.dataset.name));
        });

        const menuToggle = documentRef.getElementById('menu-toggle-workflow-selection');
        if (menuToggle) {
            menuToggle.classList.toggle('is-active', workflowSelectionMode);
            const label = menuToggle.querySelector('.context-menu-label');
            if (label) label.textContent = workflowSelectionMode ? '退出多选模式' : '开启多选模式';
        }
    }

    function setWorkflowSelectionMode(enabled) {
        workflowSelectionMode = enabled === true;
        if (!workflowSelectionMode) selectedWorkflowNames.clear();
        refreshWorkflowSelectionUi();
    }

    function toggleWorkflowSelection(name) {
        if (!name) return;
        if (selectedWorkflowNames.has(name)) {
            selectedWorkflowNames.delete(name);
        } else {
            selectedWorkflowNames.add(name);
        }
        refreshWorkflowSelectionUi();
    }

    function pruneWorkflowSelection(names = []) {
        const validNames = new Set(names);
        selectedWorkflowNames.forEach((name) => {
            if (!validNames.has(name)) selectedWorkflowNames.delete(name);
        });
    }

    function getWorkflowBaseName(name) {
        return String(name || '').split('/').filter(Boolean).pop() || String(name || '');
    }

    function hasWorkflowBaseName(names = [], baseName, excludeName = '') {
        return names.some((name) => name !== excludeName && getWorkflowBaseName(name) === baseName);
    }

    function getWorkflowFolderPath(name) {
        const parts = String(name || '').split('/').filter(Boolean);
        if (parts.length <= 1) return '';
        return parts.slice(0, -1).join('/');
    }

    function getFolderDisplayName(folderPath) {
        return String(folderPath || '').split('/').filter(Boolean).pop() || String(folderPath || '文件夹');
    }

    function normalizeWorkflowFolders(names = [], folderPaths = []) {
        const previousFolders = Array.isArray(state.workflowFolders) ? state.workflowFolders : [];
        const collapsedById = new Map(previousFolders.map((folder) => [folder.id, folder.collapsed === true]));
        const previousItemsById = new Map(previousFolders.map((folder) => [
            folder.id,
            Array.isArray(folder.items) ? folder.items.filter((name) => typeof name === 'string' && name) : []
        ]));
        const folderMap = new Map();
        const ensureFolder = (folderPath) => {
            if (!folderPath) return null;
            if (!folderMap.has(folderPath)) {
                folderMap.set(folderPath, {
                    id: folderPath,
                    name: getFolderDisplayName(folderPath),
                    collapsed: collapsedById.get(folderPath) === true,
                    items: []
                });
            }
            return folderMap.get(folderPath);
        };

        folderPaths.forEach((folderPath) => ensureFolder(folderPath));
        const nestedNames = new Set();
        names.forEach((name) => {
            const folderPath = getWorkflowFolderPath(name);
            if (!folderPath) return;
            const folder = ensureFolder(folderPath);
            if (!folder) return;
            folder.items.push(name);
            nestedNames.add(name);
        });

        folderMap.forEach((folder) => {
            const available = new Set(folder.items);
            const previousItems = previousItemsById.get(folder.id) || [];
            const orderedItems = previousItems.filter((name) => available.has(name));
            folder.items.forEach((name) => {
                if (!orderedItems.includes(name)) orderedItems.push(name);
            });
            folder.items = orderedItems;
        });
        state.workflowFolders = Array.from(folderMap.values()).sort((a, b) => a.id.localeCompare(b.id));
        return nestedNames;
    }

    function normalizeWorkflowOrder(names = [], folderPaths = []) {
        const validNames = Array.from(new Set(names.filter((name) => typeof name === 'string' && name)));
        const validSet = new Set(validNames);
        const folderItemNames = normalizeWorkflowFolders(validNames, folderPaths);
        const folderIds = new Set((state.workflowFolders || []).map((folder) => folder.id));
        const ordered = Array.isArray(state.workflowOrder)
            ? state.workflowOrder.filter((name, index, arr) => (
                typeof name === 'string'
                && arr.indexOf(name) === index
                && (
                    (name.startsWith('folder:') && folderIds.has(name.slice('folder:'.length)))
                    || (validSet.has(name) && !folderItemNames.has(name))
                )
            ))
            : [];
        state.workflowFolders.forEach((folder) => {
            const token = `folder:${folder.id}`;
            if (!ordered.includes(token)) ordered.push(token);
        });
        validNames.forEach((name) => {
            if (!folderItemNames.has(name) && !ordered.includes(name)) ordered.push(name);
        });
        state.workflowOrder = ordered;
        return ordered;
    }

    function getWorkflowFolderById(folderId) {
        return (state.workflowFolders || []).find((folder) => folder.id === folderId) || null;
    }

    function removeWorkflowFromFolders(name) {
        (state.workflowFolders || []).forEach((folder) => {
            folder.items = Array.isArray(folder.items) ? folder.items.filter((item) => item !== name) : [];
        });
    }

    function replaceWorkflowNameInState(oldName, newName) {
        const tab = getWorkflowTab(oldName);
        if (tab) tab.name = newName;
        if (state.activeWorkflowName === oldName) state.activeWorkflowName = newName;
        if (Array.isArray(state.workflowOrder)) {
            const orderIndex = state.workflowOrder.indexOf(oldName);
            if (orderIndex >= 0) state.workflowOrder[orderIndex] = newName;
        }
        (state.workflowFolders || []).forEach((folder) => {
            if (!Array.isArray(folder.items)) return;
            const itemIndex = folder.items.indexOf(oldName);
            if (itemIndex >= 0) folder.items[itemIndex] = newName;
        });
        if (selectedWorkflowNames.has(oldName)) {
            selectedWorkflowNames.delete(oldName);
            selectedWorkflowNames.add(newName);
        }
    }

    function applyMovedWorkflowNames(moved = []) {
        moved.forEach((item) => {
            const oldName = item?.old || '';
            const newName = item?.new || '';
            if (oldName && newName) replaceWorkflowNameInState(oldName, newName);
        });
    }

    function replaceWorkflowFolderInState(oldFolderId, newFolderId) {
        if (Array.isArray(state.workflowOrder)) {
            const oldToken = `folder:${oldFolderId}`;
            const newToken = `folder:${newFolderId}`;
            const orderIndex = state.workflowOrder.indexOf(oldToken);
            if (orderIndex >= 0) state.workflowOrder[orderIndex] = newToken;
        }
        const folder = getWorkflowFolderById(oldFolderId);
        if (folder) {
            folder.id = newFolderId;
            folder.name = getFolderDisplayName(newFolderId);
        }
    }

    function removeWorkflowFolderFromState(folderId) {
        state.workflowOrder = (state.workflowOrder || []).filter((entry) => entry !== `folder:${folderId}`);
        state.workflowFolders = (state.workflowFolders || []).filter((folder) => folder.id !== folderId);
    }

    function syncWorkflowLayoutFromDom() {
        const list = documentRef.getElementById('workflow-list');
        if (!list) return false;
        const rootEntries = [];
        Array.from(list.children).forEach((child) => {
            if (child.classList.contains('workflow-folder')) {
                const folderId = child.dataset.folderId || '';
                const folder = getWorkflowFolderById(folderId);
                if (!folder) return;
                rootEntries.push(`folder:${folderId}`);
                const children = list.querySelector(`.workflow-folder-children[data-folder-id="${folderId}"]`);
                folder.items = children
                    ? Array.from(children.children)
                        .filter((item) => item.classList.contains('workflow-item'))
                        .map((item) => item.dataset.name)
                        .filter(Boolean)
                    : (Array.isArray(folder.items) ? folder.items : []);
                return;
            }
            if (child.classList.contains('workflow-folder-children')) return;
            if (child.classList.contains('workflow-item')) {
                const name = child.dataset.name || '';
                if (name) rootEntries.push(name);
            }
        });
        state.workflowOrder = rootEntries;
        return true;
    }

    function moveWorkflowItemElement(sourceItem, targetItem, placement = 'before') {
        if (!sourceItem || !targetItem || sourceItem === targetItem) return false;
        const list = targetItem.parentElement;
        if (!list) return false;
        const targetReference = placement === 'after' ? targetItem.nextSibling : targetItem;
        if (targetReference === sourceItem) return false;
        list.insertBefore(sourceItem, targetReference);
        return true;
    }

    function getDraggedWorkflowItemsInContainer(sourceName, container) {
        if (!container) return [];
        const draggedNames = new Set(getDraggedWorkflowNames(sourceName));
        return Array.from(container.children)
            .filter((candidate) => candidate.classList?.contains('workflow-item') && draggedNames.has(candidate.dataset.name));
    }

    function moveWorkflowItemGroupElements(sourceItems, targetItem, placement = 'before') {
        if (!Array.isArray(sourceItems) || sourceItems.length === 0 || !targetItem) return false;
        const list = targetItem.parentElement;
        if (!list) return false;
        const sourceSet = new Set(sourceItems);
        if (sourceSet.has(targetItem)) return false;

        let targetReference = placement === 'after' ? targetItem.nextSibling : targetItem;
        while (targetReference && sourceSet.has(targetReference)) {
            targetReference = targetReference.nextSibling;
        }

        const fragment = documentRef.createDocumentFragment();
        sourceItems.forEach((sourceItem) => {
            if (sourceItem.parentElement === list) fragment.appendChild(sourceItem);
        });
        list.insertBefore(fragment, targetReference);
        return true;
    }

    function clearWorkflowDragState(list = documentRef.getElementById('workflow-list')) {
        draggingWorkflowName = '';
        list?.classList.remove('workflow-list-dragging');
        list?.querySelectorAll('.workflow-item').forEach((candidate) => {
            candidate.classList.remove('is-dragging');
        });
        list?.querySelectorAll('.workflow-folder, .workflow-folder-children').forEach((candidate) => {
            candidate.classList.remove('is-drop-target');
            candidate.classList.remove('is-root-drop-target');
        });
    }

    function clearWorkflowRootDropTargets(list = documentRef.getElementById('workflow-list')) {
        list?.querySelectorAll('.workflow-folder.is-root-drop-target').forEach((candidate) => {
            candidate.classList.remove('is-root-drop-target');
        });
    }

    function markWorkflowRootDropTarget(folderEl, list = documentRef.getElementById('workflow-list')) {
        clearWorkflowRootDropTargets(list);
        folderEl?.classList.add('is-root-drop-target');
    }

    function canDropWorkflowToRoot(sourceName) {
        return !!getWorkflowFolderPath(sourceName);
    }

    function getDraggedWorkflowNames(sourceName) {
        if (!sourceName) return [];
        if (workflowSelectionMode && selectedWorkflowNames.has(sourceName)) {
            return Array.from(selectedWorkflowNames).filter(Boolean);
        }
        return [sourceName];
    }

    function canDropDraggedWorkflowsToRoot(sourceName) {
        return getDraggedWorkflowNames(sourceName).some((name) => canDropWorkflowToRoot(name));
    }

    function isFolderTopRootDropZone(event, folderEl) {
        const rect = folderEl?.getBoundingClientRect();
        if (!rect) return false;
        return event.clientY <= rect.top + WORKFLOW_ROOT_DROP_GAP;
    }

    function getFolderRootGapTarget(event, list = documentRef.getElementById('workflow-list')) {
        if (!list) return null;
        return Array.from(list.querySelectorAll('.workflow-folder')).find((folderEl) => {
            const rect = folderEl.getBoundingClientRect();
            return event.clientY >= rect.top - WORKFLOW_ROOT_DROP_GAP
                && event.clientY <= rect.top + WORKFLOW_ROOT_DROP_GAP;
        }) || null;
    }

    function getWorkflowFolderElement(folderId, list = documentRef.getElementById('workflow-list')) {
        if (!list) return null;
        return Array.from(list.querySelectorAll('.workflow-folder'))
            .find((folderEl) => folderEl.dataset.folderId === folderId) || null;
    }

    function isFolderChildrenRootDropZone(event, childrenEl, sourceName, folderId) {
        if (getWorkflowFolderPath(sourceName) !== folderId) return false;
        if (event.target !== childrenEl) return false;
        const rect = childrenEl.getBoundingClientRect();
        return event.clientY <= rect.top + WORKFLOW_ROOT_DROP_GAP
            || event.clientX <= rect.left + WORKFLOW_ROOT_DROP_GAP + 8;
    }

    async function moveWorkflowsToFolder(names, folderId) {
        const folder = getWorkflowFolderById(folderId);
        if (!folder || !Array.isArray(names) || names.length === 0) return false;
        let moved = 0;
        let failed = 0;
        for (const name of names) {
            if (!name) continue;
            const nextName = `${folder.id}/${getWorkflowBaseName(name)}`;
            if (nextName === name) continue;
            if (await renameWorkflowFile(name, nextName)) {
                replaceWorkflowNameInState(name, nextName);
                moved += 1;
            } else {
                failed += 1;
            }
        }
        folder.collapsed = false;
        if (failed > 0) showToast(`${failed} 个工作流移动失败`, 'warning');
        return moved > 0;
    }

    async function moveWorkflowsToRoot(names) {
        if (!Array.isArray(names) || names.length === 0) return false;
        let moved = 0;
        let failed = 0;
        for (const name of names) {
            if (!name) continue;
            const nextName = getWorkflowBaseName(name);
            if (nextName === name) continue;
            if (await renameWorkflowFile(name, nextName)) {
                replaceWorkflowNameInState(name, nextName);
                moved += 1;
            } else {
                failed += 1;
            }
        }
        if (failed > 0) showToast(`${failed} 个工作流移动失败`, 'warning');
        return moved > 0;
    }

    function getNextFolderName() {
        const existing = new Set((state.workflowFolders || []).map((folder) => folder.name));
        if (!existing.has('新建文件夹')) return '新建文件夹';
        let index = 1;
        while (existing.has(`新建文件夹 ${index}`)) index += 1;
        return `新建文件夹 ${index}`;
    }

    async function createWorkflowFolder() {
        const folderName = getNextFolderName();
        if (!(await createWorkflowFolderOnDisk(folderName))) return false;
        state.workflowOrder = Array.isArray(state.workflowOrder) ? state.workflowOrder : [];
        state.workflowOrder.push(`folder:${folderName}`);
        renderWorkflowList();
        scheduleSave({ dirty: false });
        showToast(`已新建文件夹「${folderName}」`, 'success');
        return true;
    }

    function getWorkflowNamesInFolder(folderId) {
        const names = [];
        (state.workflowFolders || []).forEach((folder) => {
            if (folder.id !== folderId && !folder.id.startsWith(`${folderId}/`)) return;
            if (!Array.isArray(folder.items)) return;
            folder.items.forEach((name) => {
                if (name && !names.includes(name)) names.push(name);
            });
        });
        return names;
    }

    async function promptRenameWorkflowFolder(folderId) {
        if (!folderId) return false;
        const parentPath = getWorkflowFolderPath(folderId);
        const oldBaseName = getFolderDisplayName(folderId);
        const result = await openDialogStyle1({
            id: 'workflow-folder-rename-dialog',
            title: '重命名文件夹',
            message: '请输入新的文件夹名称。',
            note: '名称不能包含 \\ / : * ? " < > |',
            cancelActionId: 'cancel',
            submitActionId: 'confirm',
            documentRef,
            input: {
                id: 'workflow-folder-rename-input',
                label: '文件夹名称',
                value: oldBaseName,
                maxLength: 120,
                rejectPattern: /[\\/:*?"<>|]/
            },
            actions: [
                { id: 'cancel', label: '取消', variant: 'secondary' },
                { id: 'confirm', label: '确定', variant: 'primary' }
            ]
        });
        if (result?.actionId !== 'confirm') return false;

        const newBaseName = result.value.trim();
        if (!newBaseName) {
            showToast('请输入新的文件夹名称', 'warning');
            return false;
        }
        if (newBaseName === oldBaseName) {
            showToast('文件夹名称未改变', 'info');
            return false;
        }
        if (/[\\/:*?"<>|]/.test(newBaseName)) {
            showToast('文件夹名称不能包含 \\ / : * ? " < > |', 'warning');
            return false;
        }

        const newFolderId = parentPath ? `${parentPath}/${newBaseName}` : newBaseName;
        if (getWorkflowFolderById(newFolderId)) {
            showToast(`已存在名为「${newBaseName}」的文件夹`, 'warning');
            return false;
        }

        const payload = await renameWorkflowFolderOnDisk(folderId, newFolderId);
        if (!payload) return false;
        applyMovedWorkflowNames(payload.moved || []);
        replaceWorkflowFolderInState(folderId, newFolderId);
        showToast(`文件夹「${oldBaseName}」已重命名为「${newBaseName}」`, 'success');
        renderWorkflowList();
        scheduleSave({ dirty: false });
        return true;
    }

    async function confirmAndDeleteWorkflowFolder(folderId) {
        if (!folderId) return false;
        const folderName = getFolderDisplayName(folderId);
        const workflowNames = getWorkflowNamesInFolder(folderId);
        const result = await openDialogStyle1({
            id: 'workflow-folder-delete-dialog',
            title: '删除文件夹',
            message: `要删除文件夹「${folderName}」吗？`,
            note: workflowNames.length > 0
                ? `文件夹内有 ${workflowNames.length} 个工作流。可以一起删除，也可以只删除文件夹并把工作流移到根目录。`
                : '这个文件夹内没有工作流，将直接删除文件夹。',
            cancelActionId: 'cancel',
            submitActionId: 'move-out',
            documentRef,
            actions: workflowNames.length > 0
                ? [
                    { id: 'cancel', label: '取消', variant: 'secondary' },
                    { id: 'move-out', label: '只删除文件夹', variant: 'secondary', autofocus: true },
                    { id: 'delete-contents', label: '删除文件夹和工作流', variant: 'danger' }
                ]
                : [
                    { id: 'cancel', label: '取消', variant: 'secondary' },
                    { id: 'move-out', label: '删除文件夹', variant: 'danger', autofocus: true }
                ]
        });
        if (result === 'cancel' || result?.actionId === 'cancel') return false;

        const actionId = typeof result === 'string' ? result : result?.actionId;
        const deleteContents = actionId === 'delete-contents';
        if (deleteContents) {
            const dirtyNames = workflowNames.filter((name) => getWorkflowTab(name)?.dirty === true);
            if (dirtyNames.length > 0) {
                const discardConfirmed = await confirmWorkflowDelete({
                    title: '删除未保存的工作流',
                    message: `文件夹内有 ${dirtyNames.length} 个工作流存在未保存修改，仍要删除吗？`,
                    note: '选择“是”会直接删除文件，并丢失未保存修改；选择“否”会停止删除。',
                    noText: '否'
                });
                if (!discardConfirmed) return false;
            }
        }

        const payload = await deleteWorkflowFolderOnDisk(folderId, { deleteContents });
        if (!payload) return false;
        if (deleteContents) {
            await applyDeletedWorkflowNames(payload.deleted || []);
            showToast(`已删除文件夹${(payload.deleted || []).length ? `和 ${payload.deleted.length} 个工作流` : ''}`, 'info');
        } else {
            applyMovedWorkflowNames(payload.moved || []);
            showToast((payload.moved || []).length > 0
                ? `已删除文件夹，${payload.moved.length} 个工作流已移到根目录`
                : '已删除文件夹', 'info');
        }
        removeWorkflowFolderFromState(folderId);
        renderWorkflowList();
        scheduleSave({ dirty: false });
        return true;
    }

    function getWorkflowCardStateLabel({ isActive, isOpen, running, runResult }) {
        if (running) return '\u8fd0\u884c\u4e2d';
        if (runResult === RUN_RESULT_SUCCESS) return '\u5df2\u5b8c\u6210';
        if (runResult === RUN_RESULT_ERROR) return '\u5931\u8d25';
        if (isActive) return '\u5f53\u524d';
        if (isOpen) return '\u5df2\u6253\u5f00';
        return '';
    }

    function clearWorkflowRunResult(name) {
        const tab = getWorkflowTab(name);
        if (!tab || !tab.runResult) return false;
        tab.runResult = '';
        refreshWorkflowCardState(name);
        return true;
    }

    function syncActiveWorkflowBeforeSessionSave({ dirty = false } = {}) {
        const tab = snapshotActiveWorkflow({ markDirty: dirty });
        if (tab && dirty) refreshWorkflowCardState(tab.name);
    }

    function markActiveWorkflowDirty() {
        const tab = snapshotActiveWorkflow({ markDirty: true });
        if (tab) refreshWorkflowCardState(tab.name);
    }

    function normalizeWorkflowTabs() {
        state.workflowTabs = Array.isArray(state.workflowTabs) ? state.workflowTabs : [];
        state.workflowTabs = state.workflowTabs
            .filter((tab) => tab?.name && tab?.data)
            .map((tab, index) => ({
                name: String(tab.name),
                data: tab.data,
                dirty: tab.dirty === true,
                colorIndex: Number.isInteger(tab.colorIndex) ? tab.colorIndex : index,
                running: tab.running === true,
                runResult: normalizeWorkflowRunResult(tab.runResult)
            }));
        if (state.activeWorkflowName && !getWorkflowTab(state.activeWorkflowName)) {
            state.activeWorkflowName = '';
        }
        if (state.activeWorkflowName) {
            const activeTab = getWorkflowTab(state.activeWorkflowName);
            if (activeTab) activeTab.runResult = '';
        }
    }

    function pruneWorkflowStateToNames(names = []) {
        normalizeWorkflowTabs();
        const validNames = new Set(names.filter((name) => typeof name === 'string' && name));
        state.workflowTabs = (state.workflowTabs || []).filter((tab) => validNames.has(tab.name));
        state.workflowOrder = (state.workflowOrder || []).filter((entry) => (
            entry.startsWith('folder:') || validNames.has(entry)
        ));
        (state.workflowFolders || []).forEach((folder) => {
            folder.items = Array.isArray(folder.items)
                ? folder.items.filter((name) => validNames.has(name))
                : [];
        });
        selectedWorkflowNames.forEach((name) => {
            if (!validNames.has(name)) selectedWorkflowNames.delete(name);
        });
        if (state.activeWorkflowName && !validNames.has(state.activeWorkflowName)) {
            state.activeWorkflowName = '';
        }
    }

    function findNextUnsavedName(names) {
        if (!hasWorkflowBaseName(names, 'Unsaved')) return 'Unsaved';
        let index = 1;
        while (hasWorkflowBaseName(names, `Unsaved ${index}`)) index += 1;
        return `Unsaved ${index}`;
    }

    function renderWorkflowEmpty(list, text = '暂无保存的工作流') {
        list.innerHTML = `<div class="workflow-empty">${escapeHtml(text)}</div>`;
    }

    function getCenteredCanvasState() {
        const canvasContainer = documentRef.getElementById('canvas-container');
        return {
            x: (canvasContainer?.clientWidth || windowRef.innerWidth || 0) / 2,
            y: (canvasContainer?.clientHeight || windowRef.innerHeight || 0) / 2,
            zoom: 1
        };
    }

    function isInlineImageData(value) {
        return typeof value === 'string' && /^data:image\//i.test(value.trim());
    }

    function stripInlineImagesFromNode(node) {
        if (!node || typeof node !== 'object') return node;
        const sanitized = { ...node };
        const data = sanitized.data && typeof sanitized.data === 'object'
            ? { ...sanitized.data }
            : null;

        delete sanitized.imageData;
        delete sanitized.imageDataList;
        delete sanitized.imageList;
        delete sanitized.images;
        delete sanitized.imagePreviewThumbnail;

        if (isInlineImageData(sanitized.compareImageA)) delete sanitized.compareImageA;
        if (isInlineImageData(sanitized.compareImageB)) delete sanitized.compareImageB;

        if (data) {
            if (isInlineImageData(data.image)) delete data.image;
            delete data.images;
            delete data.imageData;
            delete data.imageDataList;
            delete data.imageList;
            delete data.imagePreviewThumbnail;
            if (isInlineImageData(data.compareImageA)) delete data.compareImageA;
            if (isInlineImageData(data.compareImageB)) delete data.compareImageB;
            sanitized.data = data;
        }

        return sanitized;
    }

    function stripInlineImagesFromWorkflowData(workflowData) {
        if (!workflowData || typeof workflowData !== 'object') return workflowData;
        const sanitized = { ...workflowData };
        if (Array.isArray(workflowData.nodes)) {
            sanitized.nodes = workflowData.nodes.map(stripInlineImagesFromNode);
        }
        if (Array.isArray(workflowData.connections)) {
            sanitized.connections = workflowData.connections.map((connection) => ({ ...connection }));
        }
        return sanitized;
    }

    function getEmptyWorkflowData() {
        return {
            canvas: getCenteredCanvasState(),
            nodes: [],
            connections: [],
            version: WORKFLOW_VERSION
        };
    }

    function hasCurrentCanvasContent() {
        return state.nodes.size > 0 || state.connections.length > 0;
    }

    function getNewWorkflowData({ inheritCurrentCanvas = false } = {}) {
        return inheritCurrentCanvas && hasCurrentCanvasContent()
            ? getWorkflowPayload()
            : getEmptyWorkflowData();
    }

    function centerEmptyWorkflowCanvas() {
        const centered = getCenteredCanvasState();
        state.canvas.x = centered.x;
        state.canvas.y = centered.y;
        state.canvas.zoom = centered.zoom;
        viewportApi.updateCanvasTransform();
    }

    async function ensureActiveWorkflowExists({ inheritCurrentCanvas = true, showNotice = true, applyToCanvas = false, centerEmptyCanvas = false } = {}) {
        normalizeWorkflowTabs();
        if (getActiveWorkflowTab()) return true;

        const names = await fetchWorkflows();
        const name = findNextUnsavedName(names);
        const data = getNewWorkflowData({ inheritCurrentCanvas });

        state.workflowTabs.push({
            name,
            data,
            dirty: false,
            colorIndex: (state.workflowTabs || []).length % TAB_COLORS
        });
        state.activeWorkflowName = name;
        if (applyToCanvas) {
            await applyWorkflowData(data, { saveSession: false });
        }
        if (centerEmptyCanvas && !inheritCurrentCanvas) {
            centerEmptyWorkflowCanvas();
            data.canvas = { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom };
            const tab = getWorkflowTab(name);
            if (tab) tab.data = data;
        }
        scheduleSave({ dirty: false });

        const saved = await saveWorkflowToFile(name, data);
        renderWorkflowList();
        if (showNotice) {
            showToast(saved ? `已自动新建工作流「${name}」` : `已创建工作流「${name}」，但保存文件失败`, saved ? 'info' : 'warning');
        }
        return true;
    }

    async function activateFallbackWorkflow() {
        const nextTab = state.workflowTabs[0] || null;
        state.activeWorkflowName = nextTab?.name || '';
        if (nextTab) {
            clearWorkflowRunResult(nextTab.name);
            await applyWorkflowData(nextTab.data, { saveSession: false });
        } else {
            await applyWorkflowData(getEmptyWorkflowData(), { saveSession: false });
        }
    }

    async function removeWorkflowTab(name) {
        const wasActive = state.activeWorkflowName === name;
        state.workflowTabs = (state.workflowTabs || []).filter((item) => item.name !== name);
        if (wasActive) {
            if (state.workflowTabs.length > 0) {
                await activateFallbackWorkflow();
            } else {
                state.activeWorkflowName = '';
                await ensureActiveWorkflowExists({ inheritCurrentCanvas: false, showNotice: false, applyToCanvas: true, centerEmptyCanvas: true });
            }
        }
        renderWorkflowList();
        scheduleSave({ dirty: false });
        return true;
    }

    async function promptRenameWorkflow(oldName) {
        if (!oldName) return;
        const folderPath = getWorkflowFolderPath(oldName);
        const oldBaseName = getWorkflowBaseName(oldName);
        const result = await openDialogStyle1({
            id: 'workflow-rename-dialog',
            title: '重命名工作流',
            message: '请输入新的工作流名称。',
            note: '名称不能包含 \\ / : * ? " < > |',
            cancelActionId: 'cancel',
            submitActionId: 'confirm',
            documentRef,
            input: {
                id: 'workflow-rename-input',
                label: '工作流名称',
                value: oldBaseName,
                maxLength: 120,
                rejectPattern: /[\\/:*?"<>|]/
            },
            actions: [
                { id: 'cancel', label: '取消', variant: 'secondary' },
                { id: 'confirm', label: '确定', variant: 'primary' }
            ]
        });
        if (result?.actionId !== 'confirm') return;

        const newBaseName = result.value.trim();
        if (!newBaseName) {
            showToast('请输入新的工作流名称', 'warning');
            return;
        }
        if (newBaseName === oldBaseName) {
            showToast('工作流名称未改变', 'info');
            return;
        }
        if (/[\\/:*?"<>|]/.test(newBaseName)) {
            showToast('工作流名称不能包含 \\ / : * ? " < > |', 'warning');
            return;
        }
        const newName = folderPath ? `${folderPath}/${newBaseName}` : newBaseName;
        const names = await fetchWorkflows();
        if (hasWorkflowBaseName(names, newBaseName, oldName)) {
            showToast(`已存在名为「${newBaseName}」的工作流`, 'warning');
            return;
        }
        if (await renameWorkflowFile(oldName, newName)) {
            replaceWorkflowNameInState(oldName, newName);
            showToast(`工作流「${oldName}」已重命名为「${newName}」`, 'success');
            renderWorkflowList();
            scheduleSave({ dirty: false });
        }
    }

    async function renderWorkflowList({ forceReload = true } = {}) {
        const list = documentRef.getElementById('workflow-list');
        const workflowEntries = await getWorkflowEntriesForRender({ forceReload });
        if (!list) return;
        const workflowNames = Array.from(new Set(workflowEntries.workflows || []));
        pruneWorkflowStateToNames(workflowNames);
        const rootEntries = normalizeWorkflowOrder(workflowNames, workflowEntries.folders);
        pruneWorkflowSelection(workflowNames);

        if (rootEntries.length === 0) {
            selectedWorkflowNames.clear();
            renderWorkflowEmpty(list);
            refreshWorkflowSelectionUi();
            return;
        }

        const renderWorkflowItem = (name, folderId = '') => {
            const tab = getWorkflowTab(name);
            const isOpen = !!tab;
            const isActive = state.activeWorkflowName === name;
            const dirty = tab?.dirty === true;
            const running = tab?.running === true;
            const runResult = !isActive ? normalizeWorkflowRunResult(tab?.runResult) : '';
            const runResultClass = runResult ? `has-run-result is-run-${runResult}` : '';
            const selectedClass = selectedWorkflowNames.has(name) ? 'is-selected' : '';
            const colorIndex = Number.isInteger(tab?.colorIndex) ? tab.colorIndex % TAB_COLORS : 0;
            const displayName = getWorkflowBaseName(name);
            return `
        <div class="workflow-item ${folderId ? 'is-nested' : ''} ${isOpen ? 'is-open' : ''} ${isActive ? 'is-active' : ''} ${dirty ? 'is-dirty' : ''} ${running ? 'is-running' : ''} ${runResultClass} ${selectedClass}"
             data-name="${escapeHtml(name)}"
             data-folder-id="${escapeHtml(folderId)}"
             data-tab-color="${colorIndex}"
             draggable="true">
            <span class="workflow-select-check" aria-hidden="true"></span>
            <span class="workflow-item-name" title="${escapeHtml(name)}" aria-label="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
            <span class="workflow-item-state">${getWorkflowCardStateLabel({ isActive, isOpen, running, runResult })}</span>
            <span class="workflow-dirty-dot" aria-hidden="true"></span>
        </div>
    `;
        };

        const renderFolder = (folder) => {
            const itemCount = Array.isArray(folder.items) ? folder.items.length : 0;
            const collapsed = folder.collapsed === true;
            const children = folder.items.map((name) => renderWorkflowItem(name, folder.id)).join('');
            return `
        <div class="workflow-folder ${collapsed ? 'is-collapsed' : ''}" data-folder-id="${escapeHtml(folder.id)}">
            <button type="button" class="workflow-folder-toggle" title="${collapsed ? '展开文件夹' : '折叠文件夹'}" aria-label="${collapsed ? '展开文件夹' : '折叠文件夹'}">
                <svg class="workflow-folder-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 18l6-6-6-6"></path>
                </svg>
                <svg class="workflow-folder-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1H3V7z"></path>
                    <path d="M3 10h18l-2 9H5L3 10z"></path>
                </svg>
            </button>
            <span class="workflow-folder-name" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</span>
            <span class="workflow-folder-count">${itemCount}</span>
        </div>
        <div class="workflow-folder-children ${collapsed ? 'hidden' : ''}" data-folder-id="${escapeHtml(folder.id)}">
            ${children}
        </div>
    `;
        };

        list.innerHTML = rootEntries.map((entry) => {
            if (entry.startsWith('folder:')) {
                const folder = getWorkflowFolderById(entry.slice('folder:'.length));
                return folder ? renderFolder(folder) : '';
            }
            return workflowNames.includes(entry) ? renderWorkflowItem(entry) : '';
        }).join('');

        list.querySelectorAll('.workflow-folder').forEach((folderEl) => {
            const folderId = folderEl.dataset.folderId || '';
            const toggleFolder = () => {
                const folder = getWorkflowFolderById(folderId);
                if (!folder) return;
                folder.collapsed = !folder.collapsed;
                renderWorkflowList();
                scheduleSave({ dirty: false });
            };

            folderEl.addEventListener('click', () => {
                toggleFolder();
            });

            folderEl.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const menu = documentRef.getElementById('workflow-folder-context-menu');
                documentRef.getElementById('workflow-context-menu')?.classList.add('hidden');
                if (!menu) return;
                menu.dataset.folderId = folderId;
                menu.style.left = `${event.clientX}px`;
                menu.style.top = `${event.clientY}px`;
                menu.classList.remove('hidden');
            });

            folderEl.querySelector('.workflow-folder-toggle')?.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleFolder();
            });

            folderEl.addEventListener('dragover', (event) => {
                const sourceName = draggingWorkflowName || event.dataTransfer.getData('text/plain');
                if (!sourceName) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                if (canDropDraggedWorkflowsToRoot(sourceName) && isFolderTopRootDropZone(event, folderEl)) {
                    folderEl.classList.remove('is-drop-target');
                    markWorkflowRootDropTarget(folderEl, list);
                    return;
                }
                clearWorkflowRootDropTargets(list);
                const folder = getWorkflowFolderById(folderId);
                if (folder?.collapsed === true) {
                    folder.collapsed = false;
                    folderEl.classList.remove('is-collapsed');
                    const childrenEl = list.querySelector(`.workflow-folder-children[data-folder-id="${folderId}"]`);
                    childrenEl?.classList.remove('hidden');
                }
                folderEl.classList.add('is-drop-target');
            });

            folderEl.addEventListener('dragleave', () => {
                folderEl.classList.remove('is-drop-target');
                folderEl.classList.remove('is-root-drop-target');
            });

            folderEl.addEventListener('drop', async (event) => {
                const sourceName = draggingWorkflowName || event.dataTransfer.getData('text/plain');
                if (!sourceName) return;
                event.preventDefault();
                event.stopPropagation();
                folderEl.classList.remove('is-drop-target');
                folderEl.classList.remove('is-root-drop-target');
                if (canDropDraggedWorkflowsToRoot(sourceName) && isFolderTopRootDropZone(event, folderEl)) {
                    if (await moveWorkflowsToRoot(getDraggedWorkflowNames(sourceName))) {
                        clearWorkflowDragState(list);
                        renderWorkflowList();
                        scheduleSave({ dirty: false });
                    }
                    return;
                }
                if (await moveWorkflowsToFolder(getDraggedWorkflowNames(sourceName), folderId)) {
                    clearWorkflowDragState(list);
                    renderWorkflowList();
                    scheduleSave({ dirty: false });
                }
            });
        });

        list.querySelectorAll('.workflow-folder-children').forEach((childrenEl) => {
            const folderId = childrenEl.dataset.folderId || '';
            childrenEl.addEventListener('dragover', (event) => {
                const sourceName = draggingWorkflowName || event.dataTransfer.getData('text/plain');
                if (!sourceName) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                if (isFolderChildrenRootDropZone(event, childrenEl, sourceName, folderId)) {
                    childrenEl.classList.remove('is-drop-target');
                    markWorkflowRootDropTarget(getWorkflowFolderElement(folderId, list), list);
                    return;
                }
                clearWorkflowRootDropTargets(list);
                childrenEl.classList.add('is-drop-target');
            });

            childrenEl.addEventListener('dragleave', () => {
                childrenEl.classList.remove('is-drop-target');
                clearWorkflowRootDropTargets(list);
            });

            childrenEl.addEventListener('drop', async (event) => {
                const sourceName = draggingWorkflowName || event.dataTransfer.getData('text/plain');
                if (!sourceName) return;
                event.preventDefault();
                event.stopPropagation();
                childrenEl.classList.remove('is-drop-target');
                if (isFolderChildrenRootDropZone(event, childrenEl, sourceName, folderId)) {
                    clearWorkflowRootDropTargets(list);
                    if (await moveWorkflowsToRoot(getDraggedWorkflowNames(sourceName))) {
                        clearWorkflowDragState(list);
                        renderWorkflowList();
                        scheduleSave({ dirty: false });
                    }
                    return;
                }
                if (await moveWorkflowsToFolder(getDraggedWorkflowNames(sourceName), folderId)) {
                    clearWorkflowDragState(list);
                    renderWorkflowList();
                    scheduleSave({ dirty: false });
                }
            });
        });

        list.ondragover = (event) => {
            const sourceName = draggingWorkflowName || event.dataTransfer.getData('text/plain');
            if (!sourceName || event.target.closest('.workflow-item, .workflow-folder, .workflow-folder-children')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            markWorkflowRootDropTarget(
                canDropDraggedWorkflowsToRoot(sourceName) ? getFolderRootGapTarget(event, list) : null,
                list
            );
        };

        list.ondrop = async (event) => {
            const sourceName = draggingWorkflowName || event.dataTransfer.getData('text/plain');
            if (!sourceName || event.target.closest('.workflow-item, .workflow-folder, .workflow-folder-children')) return;
            event.preventDefault();
            clearWorkflowRootDropTargets(list);
            if (await moveWorkflowsToRoot(getDraggedWorkflowNames(sourceName))) {
                clearWorkflowDragState(list);
                renderWorkflowList();
                scheduleSave({ dirty: false });
            }
        };

        list.querySelectorAll('.workflow-item').forEach((item) => {
            const name = item.dataset.name;
            item.addEventListener('dragstart', (e) => {
                draggingWorkflowName = name;
                item.classList.add('is-dragging');
                list.classList.add('workflow-list-dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', name);
            });

            item.addEventListener('dragover', (e) => {
                const sourceName = draggingWorkflowName || e.dataTransfer.getData('text/plain');
                if (!sourceName) return;
                const draggedNames = getDraggedWorkflowNames(sourceName);
                if (draggedNames.includes(name)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                clearWorkflowRootDropTargets(list);
                const rect = item.getBoundingClientRect();
                const placement = e.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
                const sourceItem = Array.from(list.querySelectorAll('.workflow-item'))
                    .find((candidate) => candidate.dataset.name === sourceName);
                const sameContainer = sourceItem?.parentElement === item.parentElement;
                const sourceItems = sameContainer
                    ? getDraggedWorkflowItemsInContainer(sourceName, item.parentElement)
                    : [];
                const moved = sourceItems.length > 1
                    ? moveWorkflowItemGroupElements(sourceItems, item, placement)
                    : sameContainer && moveWorkflowItemElement(sourceItem, item, placement);
                if (moved) {
                    syncWorkflowLayoutFromDom();
                }
            });

            item.addEventListener('drop', async (e) => {
                const sourceName = draggingWorkflowName || e.dataTransfer.getData('text/plain');
                if (!sourceName || getDraggedWorkflowNames(sourceName).includes(name)) return;
                e.preventDefault();
                e.stopPropagation();
                const sourceItem = Array.from(list.querySelectorAll('.workflow-item'))
                    .find((candidate) => candidate.dataset.name === sourceName);
                const sameContainer = sourceItem?.parentElement === item.parentElement;
                const targetFolderId = item.dataset.folderId || '';
                const movedAcrossFolder = !sameContainer && (
                    targetFolderId
                        ? await moveWorkflowsToFolder(getDraggedWorkflowNames(sourceName), targetFolderId)
                        : await moveWorkflowsToRoot(getDraggedWorkflowNames(sourceName))
                );
                if (movedAcrossFolder) {
                    clearWorkflowDragState(list);
                    renderWorkflowList();
                    scheduleSave({ dirty: false });
                    return;
                }
                if (syncWorkflowLayoutFromDom()) {
                    scheduleSave({ dirty: false });
                }
            });

            item.addEventListener('dragend', () => {
                clearWorkflowDragState(list);
                if (syncWorkflowLayoutFromDom()) {
                    scheduleSave({ dirty: false });
                }
            });

            item.addEventListener('click', async (e) => {
                if (workflowSelectionMode) {
                    toggleWorkflowSelection(name);
                    return;
                }
                await openWorkflow(name);
            });

            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const menu = documentRef.getElementById('workflow-context-menu');
                if (!menu) return;
                documentRef.getElementById('workflow-folder-context-menu')?.classList.add('hidden');
                menu.dataset.targetName = name;
                menu.style.left = e.clientX + 'px';
                menu.style.top = e.clientY + 'px';
                menu.classList.remove('hidden');
                refreshWorkflowSelectionUi();
            });
        });
        refreshWorkflowSelectionUi();
    }

    async function applyDeletedWorkflowNames(deletedNames) {
        if (!Array.isArray(deletedNames) || deletedNames.length === 0) return;
        const deletedSet = new Set(deletedNames);
        deletedNames.forEach((name) => selectedWorkflowNames.delete(name));
        const wasActive = deletedSet.has(state.activeWorkflowName);
        state.workflowTabs = (state.workflowTabs || []).filter((item) => !deletedSet.has(item.name));
        state.workflowOrder = (state.workflowOrder || []).filter((entry) => !deletedSet.has(entry));
        (state.workflowFolders || []).forEach((folder) => {
            folder.items = Array.isArray(folder.items) ? folder.items.filter((name) => !deletedSet.has(name)) : [];
        });
        if (wasActive) {
            if (state.workflowTabs.length > 0) {
                await activateFallbackWorkflow();
            } else {
                state.activeWorkflowName = '';
                await ensureActiveWorkflowExists({ inheritCurrentCanvas: false, showNotice: false, applyToCanvas: true, centerEmptyCanvas: true });
            }
        }
    }

    async function confirmAndDeleteSelectedWorkflows() {
        const names = Array.from(selectedWorkflowNames);
        if (names.length === 0) return false;

        const confirmed = await confirmWorkflowDelete({
            title: '删除选中的工作流',
            message: `确定要删除选中的 ${names.length} 个工作流吗？`,
            note: '选择“是”会删除这些工作流文件；选择“否”会保留它们。',
            noText: '否'
        });
        if (!confirmed) return false;

        const dirtyNames = names.filter((name) => getWorkflowTab(name)?.dirty === true);
        if (dirtyNames.length > 0) {
            const discardConfirmed = await confirmWorkflowDelete({
                title: '删除未保存的工作流',
                message: `选中的工作流里有 ${dirtyNames.length} 个存在未保存修改，仍要删除文件吗？`,
                note: '选择“是”会直接删除文件，并丢失未保存修改；选择“否”会停止删除。',
                noText: '否'
            });
            if (!discardConfirmed) return false;
        }

        const deletedNames = [];
        for (const name of names) {
            if (await deleteWorkflowFile(name)) {
                deletedNames.push(name);
            }
        }

        if (deletedNames.length === 0) return false;
        await applyDeletedWorkflowNames(deletedNames);
        removeWorkflowEntriesFromCache(deletedNames);
        if (deletedNames.length === names.length) {
            showToast(`已删除 ${deletedNames.length} 个工作流`, 'info');
        } else {
            showToast(`已删除 ${deletedNames.length} 个工作流，${names.length - deletedNames.length} 个删除失败`, 'warning');
        }
        renderWorkflowList({ forceReload: false });
        scheduleSave({ dirty: false });
        return true;
    }

    async function confirmAndDeleteWorkflow(name) {
        const confirmed = await confirmWorkflowDelete({
            title: '删除工作流',
            message: `确定要删除工作流「${name}」吗？`,
            note: '选择“是”会删除工作流文件；选择“否”会保留它。',
            noText: '否'
        });
        if (!confirmed) return false;

        const tab = getWorkflowTab(name);
        if (tab?.dirty) {
            const discardConfirmed = await confirmWorkflowDelete({
                title: '删除未保存的工作流',
                message: `工作流「${name}」有未保存修改，仍要删除文件吗？`,
                note: '选择“是”会直接删除文件，并丢失未保存修改；选择“否”会停止删除。',
                noText: '否'
            });
            if (!discardConfirmed) return false;
        }

        if (await deleteWorkflowFile(name)) {
            await applyDeletedWorkflowNames([name]);
            removeWorkflowEntriesFromCache([name]);
            showToast('已删除', 'info');
            renderWorkflowList({ forceReload: false });
            scheduleSave({ dirty: false });
            return true;
        }
        return false;
    }

    async function applyWorkflowData(data, options = {}) {
        data = migrateLegacyWorkflowData(data);
        const { saveSession = true } = options;
        const modelResolution = resolveWorkflowModelReferences(data, state);
        const warningMessage = buildWorkflowModelWarningMessage(modelResolution);
        if (warningMessage && !(await confirmWorkflowAction({
            title: '加载工作流',
            message: `${warningMessage}\n\n是否继续加载工作流？`,
            note: '选择“是”会继续加载并使用自动匹配结果；选择“否”或“取消”会停止加载。',
            noText: '否'
        }))) {
            return false;
        }
        if (modelResolution.remappedModels.length > 0) {
            showToast(`已自动匹配 ${modelResolution.remappedModels.length} 个模型引用`, 'info', 6000);
        }

        beginMediaRestoreBatch();
        try {
            state.connections = [];
            for (const [, node] of state.nodes) {
                cleanupElementResources(node.el);
                node.el.remove();
            }
            state.nodes.clear();
            state.selectedNodes.clear();
            clearUndoStack();

            if (data.canvas) {
                state.canvas.x = data.canvas.x || 0;
                state.canvas.y = data.canvas.y || 0;
                state.canvas.zoom = data.canvas.zoom || 1;
            }

            if (modelResolution.nodes?.length) {
                for (const nodeData of modelResolution.nodes) addNode(nodeData.type, nodeData.x, nodeData.y, nodeData, true);
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
            onConnectionsChanged();
            viewportApi.updateCanvasTransform();
        } finally {
            endMediaRestoreBatch();
        }
        try {
            await finalizeMediaRestoreBatch();
        } catch (error) {
            console.warn('Refresh recoverable media nodes after workflow load failed:', error);
        }
        onWorkflowViewApplied(state.activeWorkflowName || '');
        scheduleOpenWorkflowAssetCleanup({ includeCanvas: true });
        if (saveSession) scheduleSave();
        return true;
    }

    async function openWorkflow(name) {
        if (!name) return false;
        if (state.activeWorkflowName === name) {
            if (clearWorkflowRunResult(name)) {
                refreshWorkflowCardState(name);
                scheduleSave({ dirty: false });
            }
            return true;
        }
        snapshotActiveWorkflow();

        let tab = getWorkflowTab(name);
        let createdTab = false;
        if (!tab) {
            const data = await loadWorkflowFromFile(name);
            if (!data) return false;
            tab = {
                name,
                data: migrateLegacyWorkflowData(data),
                dirty: false,
                colorIndex: (state.workflowTabs || []).length % TAB_COLORS
            };
            state.workflowTabs.push(tab);
            createdTab = true;
        }

        const previousActiveName = state.activeWorkflowName;
        state.activeWorkflowName = name;
        clearWorkflowRunResult(name);
        if (await applyWorkflowData(tab.data, { saveSession: false })) {
            showToast(`已打开工作流: ${name}`, 'success');
            if (createdTab) {
                renderWorkflowList();
            } else {
                refreshWorkflowCardState(previousActiveName);
                refreshWorkflowCardState(name);
            }
            scheduleSave({ dirty: false });
            return true;
        }
        state.activeWorkflowName = previousActiveName;
        if (createdTab) {
            state.workflowTabs = (state.workflowTabs || []).filter((item) => item.name !== name);
        }
        return false;
    }

    async function saveActiveWorkflow() {
        const tab = snapshotActiveWorkflow();
        if (!tab) {
            showToast('请先从工作流管理面板打开或新建一个工作流', 'warning');
            return false;
        }
        if (await saveWorkflowToFile(tab.name, tab.data)) {
            tab.dirty = false;
            showToast(`工作流「${tab.name}」已保存`, 'success');
            renderWorkflowList();
            scheduleSave({ dirty: false });
            return true;
        }
        return false;
    }

    async function saveAllOpenWorkflows() {
        snapshotActiveWorkflow();
        const tabs = Array.isArray(state.workflowTabs) ? state.workflowTabs.slice() : [];
        if (tabs.length === 0) {
            showToast('没有可保存的已打开工作流', 'info');
            return false;
        }

        let savedCount = 0;
        for (const tab of tabs) {
            if (await saveWorkflowToFile(tab.name, tab.data)) {
                tab.dirty = false;
                savedCount += 1;
            } else {
                return false;
            }
        }

        showToast(`已保存 ${savedCount} 个工作流`, 'success');
        renderWorkflowList();
        scheduleSave({ dirty: false });
        return true;
    }

    async function saveWorkflowByName(name) {
        if (!name) return false;
        if (state.activeWorkflowName === name) snapshotActiveWorkflow();
        const tab = getWorkflowTab(name);
        const data = tab ? tab.data : await loadWorkflowFromFile(name);
        if (!data) return false;
        if (await saveWorkflowToFile(name, data)) {
            if (tab) tab.dirty = false;
            showToast(`工作流「${name}」已保存`, 'success');
            renderWorkflowList();
            scheduleSave({ dirty: false });
            return true;
        }
        return false;
    }

    async function closeWorkflowAfterSave(name) {
        const tab = getWorkflowTab(name);
        if (!tab) {
            showToast(`工作流「${name}」未打开，无需关闭`, 'info');
            return true;
        }
        if (tab.running === true) {
            showToast('该工作流正在运行，暂不能关闭', 'warning');
            return false;
        }
        if (state.activeWorkflowName === name) snapshotActiveWorkflow();
        if (!(await saveWorkflowToFile(tab.name, tab.data))) return false;
        tab.dirty = false;
        await removeWorkflowTab(name);
        showToast(`已保存并关闭工作流「${name}」`, 'success');
        return true;
    }

    async function closeWorkflowWithoutSaving(name) {
        const tab = getWorkflowTab(name);
        if (!tab) {
            showToast(`工作流「${name}」未打开，无需关闭`, 'info');
            return true;
        }
        if (tab.running === true) {
            showToast('该工作流正在运行，暂不能关闭', 'warning');
            return false;
        }
        await removeWorkflowTab(name);
        showToast(`已关闭工作流「${name}」`, 'info');
        return true;
    }

    async function reopenWorkflowFromFile(name) {
        if (!name) return false;
        const tab = getWorkflowTab(name);
        if (!tab) return openWorkflow(name);
        if (tab?.running === true) {
            showToast('该工作流正在运行，暂不能重新打开', 'warning');
            return false;
        }

        if (state.activeWorkflowName !== name) snapshotActiveWorkflow();
        const data = await loadWorkflowFromFile(name);
        if (!data) return false;

        const previousActiveName = state.activeWorkflowName;
        const existingTab = getWorkflowTab(name);
        const previousTabData = existingTab ? cloneWorkflowData(existingTab.data) : null;
        const previousDirty = existingTab?.dirty === true;
        const previousRunResult = existingTab?.runResult || '';
        let targetTab = existingTab;
        let createdTab = false;

        if (!targetTab) {
            targetTab = {
                name,
                data: cloneWorkflowData(data),
                dirty: false,
                colorIndex: (state.workflowTabs || []).length % TAB_COLORS
            };
            state.workflowTabs.push(targetTab);
            createdTab = true;
        } else {
            targetTab.data = cloneWorkflowData(data);
            targetTab.dirty = false;
            targetTab.runResult = '';
        }

        state.activeWorkflowName = name;
        if (await applyWorkflowData(targetTab.data, { saveSession: false })) {
            showToast(`已重新打开工作流「${name}」`, 'success');
            renderWorkflowList();
            scheduleSave({ dirty: false });
            return true;
        }

        state.activeWorkflowName = previousActiveName;
        if (createdTab) {
            state.workflowTabs = (state.workflowTabs || []).filter((item) => item.name !== name);
        } else if (targetTab) {
            targetTab.data = previousTabData;
            targetTab.dirty = previousDirty;
            targetTab.runResult = previousRunResult;
        }
        renderWorkflowList();
        return false;
    }

    async function exportWorkflowByName(name) {
        const fileName = `${getSafeWorkflowFileName(name)}.json`;

        try {
            if (typeof windowRef.showSaveFilePicker === 'function') {
                const handle = await windowRef.showSaveFilePicker({
                    suggestedName: fileName,
                    types: [
                        {
                            description: 'CainFlow 工作流 JSON',
                            accept: { 'application/json': ['.json'] }
                        }
                    ]
                });
                const data = await getWorkflowDataForAction(name);
                if (!data) return false;
                const blob = new Blob([JSON.stringify(stripInlineImagesFromWorkflowData(data), null, 2)], { type: 'application/json' });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
            } else {
                const data = await getWorkflowDataForAction(name);
                if (!data) return false;
                downloadWorkflowJson(name, data);
            }
            showToast(`工作流「${name}」已另存为 JSON`, 'success');
            return true;
        } catch (error) {
            if (error?.name !== 'AbortError') {
                showToast(`另存为失败: ${error.message || error}`, 'error');
            }
            return false;
        }
    }

    async function closeWorkflow(name) {
        const tab = getWorkflowTab(name);
        if (!tab) return true;
        if (tab.running === true) {
            showToast('该工作流正在运行，暂不能关闭', 'warning');
            return false;
        }
        if (state.activeWorkflowName === name) snapshotActiveWorkflow();

        if (tab.dirty) {
            const decision = await promptWorkflowCloseDecision({
                title: '关闭当前工作流',
                message: `工作流「${name}」有未保存修改，关闭前是否保存？`,
                note: '选择“是”会先保存当前工作流，再关闭；选择“否”会直接关闭并丢失未保存修改。'
            });
            if (decision === 'cancel') return false;
            if (decision === 'save') {
                if (!(await saveWorkflowToFile(tab.name, tab.data))) return false;
                tab.dirty = false;
            }
        }

        return removeWorkflowTab(name);
    }

    async function closeOtherWorkflows() {
        try {
            const runningInactiveTab = (state.workflowTabs || []).find((tab) => tab.name !== state.activeWorkflowName && tab.running === true);
            if (runningInactiveTab) {
                showToast('有其他工作流正在运行，暂不能关闭其他工作流', 'warning');
                return false;
            }
            snapshotActiveWorkflow();

            const tabs = Array.isArray(state.workflowTabs) ? state.workflowTabs.slice() : [];
            if (!getActiveWorkflowTab()) {
                await ensureActiveWorkflowExists({ inheritCurrentCanvas: true });
                return true;
            }
            const inactiveTabs = tabs.filter((tab) => tab.name !== state.activeWorkflowName);
            if (inactiveTabs.length === 0) {
                showToast('没有其他已打开的工作流', 'info');
                return true;
            }

            const dirtyTabs = inactiveTabs.filter((tab) => tab.dirty === true);
            let shouldSaveDirtyTabs = false;
            if (dirtyTabs.length > 0) {
                const decision = await promptWorkflowCloseDecision({
                    title: '关闭其他工作流',
                    message: `有 ${dirtyTabs.length} 个其他工作流存在未保存修改，关闭前是否全部保存？`,
                    note: '选择“是”会先保存这些工作流，再关闭其他已打开的工作流；选择“否”会直接关闭并丢失未保存修改。'
                });
                if (decision === 'cancel') return false;
                shouldSaveDirtyTabs = decision === 'save';
            }

            if (shouldSaveDirtyTabs) {
                for (const tab of dirtyTabs) {
                    if (!(await saveWorkflowToFile(tab.name, tab.data))) return false;
                    tab.dirty = false;
                }
            }

            state.workflowTabs = tabs.filter((tab) => tab.name === state.activeWorkflowName);
            await renderWorkflowList();
            scheduleSave({ dirty: false });
            showToast(shouldSaveDirtyTabs ? '已保存并关闭其他工作流' : '已关闭其他工作流', 'info');
            return true;
        } catch (error) {
            showToast(`关闭其他工作流失败: ${error.message || error}`, 'error', 6000);
            return false;
        }
    }

    async function reloadAfterWorkflowImport(preferredName = '') {
        normalizeWorkflowTabs();
        const names = await fetchWorkflows();
        const nextName = names.includes(preferredName)
            ? preferredName
            : (names.includes(state.activeWorkflowName) ? state.activeWorkflowName : names[0]);

        state.workflowTabs = [];
        state.activeWorkflowName = '';
        if (nextName) {
            const data = await loadWorkflowFromFile(nextName);
            if (data) {
                state.workflowTabs.push({
                    name: nextName,
                    data,
                    dirty: false,
                    colorIndex: 0
                });
                state.activeWorkflowName = nextName;
                await applyWorkflowData(data, { saveSession: false });
            }
        } else {
            await ensureActiveWorkflowExists({ inheritCurrentCanvas: true });
        }
        await renderWorkflowList();
        scheduleSave({ dirty: false });
    }

    async function createNewWorkflow() {
        const names = await fetchWorkflows();
        const name = findNextUnsavedName(names);
        const shouldInheritCanvas = false;
        const data = getNewWorkflowData({ inheritCurrentCanvas: shouldInheritCanvas });
        if (!(await saveWorkflowToFile(name, data))) return false;
        snapshotActiveWorkflow();
        state.workflowTabs.push({
            name,
            data,
            dirty: false,
            colorIndex: (state.workflowTabs || []).length % TAB_COLORS
        });
        state.activeWorkflowName = name;
        if (!shouldInheritCanvas || !hasCurrentCanvasContent()) {
            await applyWorkflowData(data, { saveSession: false });
        }
        showToast(`已新建工作流「${name}」`, 'success');
        renderWorkflowList();
        scheduleSave({ dirty: false });
        return true;
    }

    async function ensureOpenWorkflow({ useCurrentCanvas = true } = {}) {
        const names = await fetchWorkflows();
        pruneWorkflowStateToNames(names);
        const activeTab = getActiveWorkflowTab();
        if (activeTab) return true;
        const fallbackName = names[0] || '';
        if (fallbackName) {
            return openWorkflow(fallbackName);
        }
        await ensureActiveWorkflowExists({ inheritCurrentCanvas: useCurrentCanvas });
        return true;
    }

    function initWorkflow() {
        const btnToggle = documentRef.getElementById('btn-toggle-workflow');
        const btnClose = documentRef.getElementById('btn-close-workflow');
        const btnSave = documentRef.getElementById('btn-save-workflow');
        const btnDeleteActive = documentRef.getElementById('btn-delete-active-workflow');
        const btnNew = documentRef.getElementById('btn-new-workflow');
        const btnNewFolder = documentRef.getElementById('btn-new-workflow-folder');
        const btnCloseOther = documentRef.getElementById('btn-close-other-workflows');

        if (!btnToggle) return;

        applyWorkflowSidebarWidth();
        bindWorkflowSidebarResize();

        btnToggle.addEventListener('click', () => {
            panelManager.toggle('workflow', () => {
                renderWorkflowList();
            });
        });

        btnClose?.addEventListener('click', () => {
            panelManager.close('workflow');
        });

        btnNew?.addEventListener('click', () => {
            createNewWorkflow();
        });

        btnNewFolder?.addEventListener('click', () => {
            createWorkflowFolder();
        });

        btnCloseOther?.addEventListener('click', () => {
            void closeOtherWorkflows();
        });

        btnSave?.addEventListener('click', async () => {
            await saveAllOpenWorkflows();
        });

        btnDeleteActive?.addEventListener('click', async () => {
            if (workflowSelectionMode) {
                if (selectedWorkflowNames.size === 0) {
                    showToast('请先选择要删除的工作流', 'warning');
                    return;
                }
                await confirmAndDeleteSelectedWorkflows();
                return;
            }
            const name = state.activeWorkflowName || '';
            if (!name) {
                showToast('请先打开一个工作流', 'warning');
                return;
            }
            await confirmAndDeleteWorkflow(name);
        });

        const menu = documentRef.getElementById('workflow-context-menu');
        const folderMenu = documentRef.getElementById('workflow-folder-context-menu');
        const getMenuTargetName = () => menu?.dataset?.targetName || '';
        const getFolderMenuTargetId = () => folderMenu?.dataset?.folderId || '';
        const hideWorkflowMenu = () => menu?.classList.add('hidden');
        const hideWorkflowFolderMenu = () => folderMenu?.classList.add('hidden');
        const hideWorkflowMenus = () => {
            hideWorkflowMenu();
            hideWorkflowFolderMenu();
        };

        documentRef.getElementById('workflow-sidebar')?.addEventListener('contextmenu', (event) => {
            if (event.target.closest('.workflow-item, .workflow-folder, button, .context-menu')) return;
            event.preventDefault();
            event.stopPropagation();
            hideWorkflowMenus();
        });

        documentRef.getElementById('workflow-sidebar')?.addEventListener('dblclick', (event) => {
            if (event.target.closest('.workflow-item, .workflow-folder, button, .context-menu')) return;
            if (!workflowSelectionMode) return;
            event.preventDefault();
            event.stopPropagation();
            setWorkflowSelectionMode(false);
        });

        const bindWorkflowMenuAction = (id, action) => {
            documentRef.getElementById(id)?.addEventListener('click', async (event) => {
                event.stopPropagation();
                const name = getMenuTargetName();
                hideWorkflowMenus();
                if (!name) return;
                await action(name);
            });
        };
        const bindWorkflowFolderMenuAction = (id, action) => {
            documentRef.getElementById(id)?.addEventListener('click', async (event) => {
                event.stopPropagation();
                const folderId = getFolderMenuTargetId();
                hideWorkflowMenus();
                if (!folderId) return;
                await action(folderId);
            });
        };

        bindWorkflowMenuAction('menu-save-workflow', saveWorkflowByName);
        bindWorkflowMenuAction('menu-save-close-workflow', closeWorkflowAfterSave);
        bindWorkflowMenuAction('menu-close-discard-workflow', closeWorkflowWithoutSaving);
        bindWorkflowMenuAction('menu-reopen-workflow', reopenWorkflowFromFile);
        bindWorkflowMenuAction('menu-save-as-workflow', exportWorkflowByName);
        documentRef.getElementById('menu-toggle-workflow-selection')?.addEventListener('click', (event) => {
            event.stopPropagation();
            hideWorkflowMenus();
            setWorkflowSelectionMode(!workflowSelectionMode);
        });

        documentRef.getElementById('menu-rename-workflow')?.addEventListener('click', async (event) => {
            event.stopPropagation();
            const oldName = getMenuTargetName();
            hideWorkflowMenus();
            await promptRenameWorkflow(oldName);
        });

        documentRef.getElementById('menu-delete-workflow')?.addEventListener('click', async (event) => {
            event.stopPropagation();
            const name = getMenuTargetName();
            hideWorkflowMenus();
            await confirmAndDeleteWorkflow(name);
        });

        bindWorkflowFolderMenuAction('menu-rename-workflow-folder', promptRenameWorkflowFolder);
        bindWorkflowFolderMenuAction('menu-delete-workflow-folder', confirmAndDeleteWorkflowFolder);

        windowRef.addEventListener('click', hideWorkflowMenus);
        refreshWorkflowSelectionUi();
    }

    return {
        applyWorkflowData,
        applyWorkflowSidebarWidth,
        initWorkflow,
        loadWorkflowFromFile,
        openWorkflow,
        saveActiveWorkflow,
        saveAllOpenWorkflows,
        markActiveWorkflowDirty,
        snapshotActiveWorkflow,
        getActiveWorkflowName: () => state.activeWorkflowName || '',
        getActiveWorkflowSnapshot: () => {
            const tab = snapshotActiveWorkflow();
            return tab ? cloneWorkflowData(tab.data) : getWorkflowPayload();
        },
        getActiveWorkflowRuntimeData: () => {
            const tab = snapshotActiveWorkflow();
            return tab ? tab.data : getWorkflowPayload();
        },
        getWorkflowTabSnapshot: (name) => {
            const tab = getWorkflowTab(name);
            return tab ? cloneWorkflowData(tab.data) : null;
        },
        updateWorkflowTabData: (name, data, options = {}) => {
            if (!name || !data) return false;
            const shouldApplyToCanvas = state.activeWorkflowName === name && options.applyToCanvas === true;
            const sourceData = state.activeWorkflowName === name && options.mergeWithCanvas === true
                ? getWorkflowPayload()
                : getWorkflowTab(name)?.data;
            const nextData = options.mergeRunResults === true
                ? mergeRunWorkflowData(sourceData, data, {
                    baseNodeIds: options.baseNodeIds,
                    baseConnectionIds: options.baseConnectionIds,
                    mergeNodeIds: options.mergeNodeIds
                })
                : cloneWorkflowData(data);
            let tab = getWorkflowTab(name);
            if (!tab) {
                tab = {
                    name,
                    data: nextData,
                    dirty: options.dirty === true,
                    colorIndex: (state.workflowTabs || []).length % TAB_COLORS,
                    runResult: normalizeWorkflowRunResult(options.runResult)
                };
                state.workflowTabs.push(tab);
            } else {
                tab.data = nextData;
                if (options.dirty === true) tab.dirty = true;
                if (options.runResult !== undefined) tab.runResult = normalizeWorkflowRunResult(options.runResult);
            }
            if (shouldApplyToCanvas) {
                void applyWorkflowData(tab.data, { saveSession: false, keepRunningLock: true });
            }
            refreshWorkflowCardState(name);
            return true;
        },
        setWorkflowRunningState: (name, running = false) => {
            const tab = getWorkflowTab(name);
            if (!tab) return false;
            tab.running = running === true;
            if (tab.running) tab.runResult = '';
            if (state.activeWorkflowName === name) {
                state.nodes.forEach((node) => {
                    node.el?.classList.remove('workflow-running-locked');
                });
            }
            refreshWorkflowCardState(name);
            renderWorkflowList();
            scheduleSave({ dirty: false });
            return true;
        },
        setWorkflowRunResult: (name, result = '') => {
            const tab = getWorkflowTab(name);
            if (!tab) return false;
            tab.runResult = state.activeWorkflowName === name ? '' : normalizeWorkflowRunResult(result);
            refreshWorkflowCardState(name);
            renderWorkflowList();
            scheduleSave({ dirty: false });
            return true;
        },
        syncActiveWorkflowBeforeSessionSave,
        cleanupOpenWorkflowAssets,
        ensureOpenWorkflow,
        closeOtherWorkflows,
        reloadAfterWorkflowImport
    };
}
