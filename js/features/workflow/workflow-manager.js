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
import { createWorkflowActivation } from './workflow-activation.js';
import {
    attachWorkflowDeskStateProjection,
    createWorkflowDesk
} from './workflow-desk.js';
import {
    createWorkflowSessionActivator,
    createWorkflowTargetActivator
} from './workflow-activation-coordinator.js';
import { ensureUniqueWorkflowIdentities } from './workflow-identity.js';
import {
    replaceWorkflowTabData,
    retainActiveWorkflowTabDuringRefresh
} from './workflow-tab-revision.js';
import { removeWorkflowTabsTransaction } from './workflow-tab-close.js';
import {
    getWorkflowMoveEligibility,
    hasRunningWorkflowInFolder,
    listWorkflowNamesInFolder,
    moveFolderWorkflowsToRoot,
    persistEligibleWorkflowMoves,
    persistWorkflowRenameIfEligible
} from './workflow-folder-policy.js';

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
    recordWorkflowDiagnostic = async () => {},
    onWorkflowViewApplied = () => {},
    refreshRecoverableMediaNodes = async () => {},
    waitForImageRestores = async () => {},
    beginMediaRestoreBatch = () => {},
    endMediaRestoreBatch = () => {},
    finalizeMediaRestoreBatch = async () => {},
    prepareDetachedEditorView = null,
    releaseDetachedEditorView = () => false,
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
    const WORKFLOW_LIST_DEFERRED_RENDER_THRESHOLD = 200;
    const WORKFLOW_LIST_RENDER_CHUNK_SIZE = 80;
    let workflowSelectionMode = false;
    let draggingWorkflowName = '';
    let pendingAssetCleanupIncludeCanvas = false;
    let assetCleanupRunning = false;
    let assetCleanupQueued = false;
    let cachedWorkflowEntries = { workflows: [], folders: [] };
    let hasCachedWorkflowEntries = false;
    let workflowListRenderSequence = 0;
    const selectedWorkflowNames = new Set();
    const workflowDesk = createWorkflowDesk({
        resolveSelection: async (selection) => selection?.resolve?.() || selection,
        prepareEditorView: async (target) => target.editorView,
        commitSafeEmpty: async () => applySafeEmptyWorkflow({ publishActiveState: false }),
        createWorkflowId,
        recordDiagnostic: recordWorkflowDiagnostic,
        mutateWorkflow: (operation) => mutateWorkflowThroughDesk(operation)
    });
    attachWorkflowDeskStateProjection(state, workflowDesk);
    const activeState = workflowDesk.migration;
    const workflowActivation = createWorkflowActivation({
        onError: (error, context = {}) => {
            console.error('Workflow activation failed:', error);
            showToast(context.rollbackResult?.safeEmpty
                ? '切换失败且原工作流无法恢复，已进入安全空画布'
                : '切换失败，已恢复原工作流', 'error');
        }
    });
    const workflowSessionActivator = createWorkflowSessionActivator({
        state,
        activeState,
        workflowDesk,
        workflowActivation,
        createWorkflowId,
        prepareEditorView: prepareDetachedEditorView,
        applyViewport: () => viewportApi.updateCanvasTransform({ updateConnections: false }),
        onViewApplied: onWorkflowViewApplied
    });
    const workflowTargetActivator = createWorkflowTargetActivator({
        state,
        activeState,
        workflowDesk,
        workflowActivation,
        createWorkflowId,
        getWorkflowTab,
        ensureWorkflowIdentity,
        loadWorkflowFromFile,
        prepareWorkflowView,
        prepareEditorView: prepareDetachedEditorView,
        snapshotActiveWorkflow,
        cloneWorkflowData,
        getEmptyWorkflowData,
        resolveWorkflowModelReferences,
        clearUndoStack,
        updatePortStyles,
        applyViewport: () => viewportApi.updateCanvasTransform(),
        onViewApplied: onWorkflowViewApplied,
        onConnectionsChanged,
        scheduleAssetCleanup: scheduleOpenWorkflowAssetCleanup,
        showToast,
        renderWorkflowList,
        scheduleSave,
        releaseEditorView: releaseDetachedEditorView,
        releaseWorkflowTabMemory,
        enterSafeEmpty: applySafeEmptyWorkflow,
        tabColorCount: TAB_COLORS
    });

    function applySafeEmptyWorkflow({ publishActiveState = true } = {}) {
        for (const [, node] of state.nodes) {
            try { cleanupElementResources(node.el); } catch {}
            try { node.el?.remove?.(); } catch {}
        }
        state.nodes.clear();
        state.connections = [];
        state.selectedNodes.clear();
        if (publishActiveState) activeState.clearActive();
        workflowActivation.resetActive();
        clearUndoStack();
        const centered = getCenteredCanvasState();
        state.canvas.x = centered.x;
        state.canvas.y = centered.y;
        state.canvas.zoom = centered.zoom;
        try { viewportApi.updateCanvasTransform(); } catch {}
        try { onWorkflowViewApplied({ workflowName: '', workflowId: '' }); } catch {}
    }

    function createWorkflowId() {
        if (typeof windowRef?.crypto?.randomUUID === 'function') return windowRef.crypto.randomUUID();
        return `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
    }

    async function mutateWorkflowThroughDesk(operation) {
        const tab = (state.workflowTabs || []).find((candidate) => (
            candidate?.workflowId === operation.workflowId
            || candidate?.data?.workflowId === operation.workflowId
        ));
        if (!tab) return { ok: false, kind: 'closed-workflow-handle' };
        if (operation.kind === 'save') {
            const ok = await saveWorkflowToFile(tab.name, tab.data);
            if (ok) tab.dirty = false;
            return { ok };
        }
        if (operation.kind === 'rename' || operation.kind === 'move') {
            const previousName = tab.name;
            const ok = await renameWorkflowFile(previousName, operation.label);
            if (ok) replaceWorkflowNameInState(previousName, operation.label, { publishActiveState: false });
            return { ok };
        }
        if (operation.kind === 'reload') {
            const ok = await workflowTargetActivator.activate(tab.name, { reloadFromFile: true });
            return { ok, handled: ok };
        }
        if (operation.kind === 'close') {
            const ok = await removeWorkflowTab(tab.name, { closeToken: operation.closeToken });
            return { ok, handled: ok };
        }
        if (operation.kind === 'copy' || operation.kind === 'save-as') {
            const data = cloneWorkflowData(tab.data);
            data.workflowId = operation.newWorkflowId;
            const ok = typeof operation.persist === 'function'
                ? await operation.persist({
                    workflowId: operation.newWorkflowId,
                    label: operation.label,
                    data
                })
                : await saveWorkflowToFile(operation.label, data);
            if (ok && operation.registerOpen !== false) {
                state.workflowTabs.push({
                    workflowId: operation.newWorkflowId,
                    name: operation.label,
                    data,
                    dirty: false,
                    colorIndex: state.workflowTabs.length % TAB_COLORS,
                    running: false,
                    runResult: ''
                });
            }
            return { ok };
        }
        return { ok: false, kind: 'unsupported-workflow-mutation' };
    }

    function ensureWorkflowIdentity(tab, data = tab?.data) {
        if (!tab) return '';
        const workflowId = tab.workflowId || data?.workflowId || createWorkflowId();
        tab.workflowId = workflowId;
        if (data && typeof data === 'object') data.workflowId = workflowId;
        return workflowId;
    }

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
        const savedTab = getWorkflowTab(name);
        if (savedTab?.workflowId) {
            savedTab.identityPendingSave = false;
            activeState.markSaved(savedTab.workflowId);
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
        cancelText = '取消',
        signal = null
    } = {}) {
        return openDialogStyle1({
            id: 'workflow-confirm-dialog',
            title,
            message,
            note,
            cancelActionId: 'cancel',
            documentRef,
            signal,
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
            connections: state.connections.map(serializeConnection),
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
        const workflowId = ensureWorkflowIdentity(tab);
        replaceWorkflowTabData(tab, getWorkflowPayload());
        tab.data.workflowId = workflowId;
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

    function replaceWorkflowNameInState(oldName, newName, { publishActiveState = true } = {}) {
        const tab = getWorkflowTab(oldName);
        if (tab) tab.name = newName;
        if (publishActiveState && state.activeWorkflowName === oldName) {
            activeState.relabelActive(state.activeWorkflowId, newName);
        }
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

    function canMoveWorkflows(names) {
        const eligibility = getWorkflowMoveEligibility(names, { tabs: state.workflowTabs });
        if (eligibility.allowed) return true;
        showToast('运行中的工作流暂不能移动', 'warning');
        return false;
    }

    async function moveWorkflowsToFolder(names, folderId) {
        const folder = getWorkflowFolderById(folderId);
        if (!folder || !Array.isArray(names) || names.length === 0) return false;
        if (!canMoveWorkflows(names)) return false;
        const moves = names.filter(Boolean).map((name) => ({
            name,
            nextName: `${folder.id}/${getWorkflowBaseName(name)}`
        })).filter(({ name, nextName }) => nextName !== name);
        const result = await persistEligibleWorkflowMoves(moves, {
            tabs: state.workflowTabs,
            persist: ({ name, nextName }) => {
                const tab = getWorkflowTab(name);
                return tab ? workflowDesk.workflow(ensureWorkflowIdentity(tab)).move(nextName) : false;
            },
            onMoved: () => {}
        });
        folder.collapsed = false;
        if (result.blocked.length > 0) showToast('运行中的工作流暂不能移动', 'warning');
        if (result.failed.length > 0) showToast(`${result.failed.length} 个工作流移动失败`, 'warning');
        return result.moved.length > 0;
    }

    async function moveWorkflowsToRoot(names) {
        if (!Array.isArray(names) || names.length === 0) return false;
        if (!canMoveWorkflows(names)) return false;
        const moves = names.filter(Boolean).map((name) => ({
            name,
            nextName: getWorkflowBaseName(name)
        })).filter(({ name, nextName }) => nextName !== name);
        const result = await persistEligibleWorkflowMoves(moves, {
            tabs: state.workflowTabs,
            persist: ({ name, nextName }) => {
                const tab = getWorkflowTab(name);
                return tab ? workflowDesk.workflow(ensureWorkflowIdentity(tab)).move(nextName) : false;
            },
            onMoved: () => {}
        });
        if (result.blocked.length > 0) showToast('运行中的工作流暂不能移动', 'warning');
        if (result.failed.length > 0) showToast(`${result.failed.length} 个工作流移动失败`, 'warning');
        return result.moved.length > 0;
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

    async function promptRenameWorkflowFolder(folderId) {
        const runningInFolder = hasRunningWorkflowInFolder(folderId, {
            folders: state.workflowFolders,
            tabs: state.workflowTabs
        });
        if (runningInFolder) {
            showToast('文件夹中有工作流正在运行，暂不能重命名', 'warning');
            return;
        }
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

        const folderRename = await persistWorkflowRenameIfEligible(
            listWorkflowNamesInFolder(folderId, state.workflowFolders),
            {
                tabs: state.workflowTabs,
                persist: () => renameWorkflowFolderOnDisk(folderId, newFolderId)
            }
        );
        if (!folderRename.allowed) {
            showToast('文件夹中有工作流正在运行，暂不能重命名', 'warning');
            return false;
        }
        const payload = folderRename.result;
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
        const workflowNames = listWorkflowNamesInFolder(folderId, state.workflowFolders);
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

        let payload = null;
        let removedNames = [];
        if (deleteContents) {
            const removal = await removeWorkflowTabs(workflowNames, {
                persistRemoval: async () => {
                    payload = await deleteWorkflowFolderOnDisk(folderId, { deleteContents: true });
                    return payload?.deleted || [];
                }
            });
            removedNames = removal.removedNames;
        } else {
            const moveResult = await moveFolderWorkflowsToRoot(folderId, {
                folders: state.workflowFolders,
                tabs: state.workflowTabs,
                persistMove: () => deleteWorkflowFolderOnDisk(folderId, { deleteContents: false })
            });
            if (!moveResult.allowed) {
                showToast('文件夹中有工作流正在运行，暂不能移动', 'warning');
                return false;
            }
            payload = moveResult.payload;
        }
        if (!payload) return false;
        if (deleteContents) {
            removeDeletedWorkflowMetadata(removedNames);
            showToast(`已删除文件夹${removedNames.length ? `和 ${removedNames.length} 个工作流` : ''}`, 'info');
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
            .map((tab, index) => {
                const normalized = {
                    workflowId: tab.workflowId || tab.data?.workflowId || '',
                    name: String(tab.name),
                    data: tab.data,
                    dataRevision: Number.isSafeInteger(tab.dataRevision) ? tab.dataRevision : 0,
                    dirty: tab.dirty === true,
                    colorIndex: Number.isInteger(tab.colorIndex) ? tab.colorIndex : index,
                    running: tab.running === true,
                    runResult: normalizeWorkflowRunResult(tab.runResult)
                };
                return normalized;
            });
        ensureUniqueWorkflowIdentities(state.workflowTabs, createWorkflowId);
        if (state.activeWorkflowName) {
            const activeTab = getWorkflowTab(state.activeWorkflowName);
            if (activeTab) {
                ensureWorkflowIdentity(activeTab);
                workflowSessionActivator.reconcileActiveTab(activeTab);
            }
        }
    }

    function releaseWorkflowTabMemory(tab) {
        if (!tab || typeof tab !== 'object') return;
        releaseDetachedEditorView({
            workflowName: tab.name || '',
            workflowId: tab.workflowId || tab.data?.workflowId || ''
        });
        replaceWorkflowTabData(tab, null);
        tab.runResult = '';
        tab.running = false;
    }

    function pruneWorkflowStateToNames(names = []) {
        normalizeWorkflowTabs();
        const validNames = new Set(names.filter((name) => typeof name === 'string' && name));
        const previousTabs = state.workflowTabs || [];
        const retainedTabs = retainActiveWorkflowTabDuringRefresh(
            state.workflowTabs,
            validNames,
            { workflowId: state.activeWorkflowId, workflowName: state.activeWorkflowName }
        );
        const retained = new Set(retainedTabs);
        previousTabs.forEach((tab) => {
            if (!retained.has(tab)) releaseWorkflowTabMemory(tab);
        });
        state.workflowTabs = retainedTabs;
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

        const tab = {
            name,
            data,
            dirty: false,
            colorIndex: (state.workflowTabs || []).length % TAB_COLORS
        };
        ensureWorkflowIdentity(tab);
        state.workflowTabs.push(tab);
        if (applyToCanvas || !state.activeWorkflowName) await openWorkflow(name);
        if (centerEmptyCanvas && !inheritCurrentCanvas) {
            centerEmptyWorkflowCanvas();
            data.canvas = { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom };
            const tab = getWorkflowTab(name);
            if (tab) replaceWorkflowTabData(tab, data);
        }
        scheduleSave({ dirty: false });

        const saved = await saveWorkflowToFile(name, data);
        renderWorkflowList();
        if (showNotice) {
            showToast(saved ? `已自动新建工作流「${name}」` : `已创建工作流「${name}」，但保存文件失败`, saved ? 'info' : 'warning');
        }
        return true;
    }

    async function removeWorkflowTabs(names, { persistRemoval, closeToken = null } = {}) {
        const removingNames = new Set(names);
        const removesActiveWorkflow = removingNames.has(state.activeWorkflowName);
        const previousActiveWorkflowId = state.activeWorkflowId;
        const previousActiveWorkflowName = state.activeWorkflowName;
        let fallbackTab = null;
        let createdFallback = false;
        let fallbackCleaned = false;

        if (removesActiveWorkflow) {
            fallbackTab = (state.workflowTabs || []).find((tab) => !removingNames.has(tab.name)) || null;
            if (!fallbackTab) {
                const persistedNames = await fetchWorkflows();
                const openNames = (state.workflowTabs || []).map((tab) => tab.name);
                const fallbackName = findNextUnsavedName([...persistedNames, ...openNames]);
                fallbackTab = {
                    name: fallbackName,
                    data: getNewWorkflowData({ inheritCurrentCanvas: false }),
                    dirty: false,
                    colorIndex: (state.workflowTabs || []).length % TAB_COLORS
                };
                ensureWorkflowIdentity(fallbackTab);
                state.workflowTabs.push(fallbackTab);
                createdFallback = true;
            }
        }

        const result = await removeWorkflowTabsTransaction({
            tabs: state.workflowTabs || [],
            names,
            activeWorkflowName: state.activeWorkflowName,
            activateFallback: () => openWorkflow(fallbackTab.name, { closeToken }),
            rollbackFallback: async () => {
                const previousTab = (state.workflowTabs || []).find((tab) => (
                    previousActiveWorkflowId && tab.workflowId === previousActiveWorkflowId
                )) || getWorkflowTab(previousActiveWorkflowName);
                if (!previousTab || !(await openWorkflow(previousTab.name))) return false;
                if (createdFallback) {
                    state.workflowTabs = (state.workflowTabs || []).filter((tab) => tab !== fallbackTab);
                    releaseWorkflowTabMemory(fallbackTab);
                    fallbackCleaned = true;
                }
                return true;
            },
            persistRemoval,
            releaseTab: releaseWorkflowTabMemory
        });
        if (!result.removed) {
            if (createdFallback && !result.activated && !fallbackCleaned) {
                state.workflowTabs = (state.workflowTabs || []).filter((tab) => tab !== fallbackTab);
                releaseWorkflowTabMemory(fallbackTab);
            }
            renderWorkflowList();
            return result;
        }

        state.workflowTabs = result.tabs;
        if (createdFallback) await saveWorkflowToFile(fallbackTab.name, fallbackTab.data);
        renderWorkflowList();
        scheduleSave({ dirty: false });
        return result;
    }

    async function removeWorkflowTab(name, options = {}) {
        return (await removeWorkflowTabs([name], options)).complete;
    }

    async function promptRenameWorkflow(oldName) {
        if (!oldName) return;
        if (getWorkflowTab(oldName)?.running === true) {
            showToast('运行中的工作流暂不能重命名', 'warning');
            return;
        }
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
        const workflowRename = await persistWorkflowRenameIfEligible([oldName], {
            tabs: state.workflowTabs,
            persist: () => {
                const tab = getWorkflowTab(oldName);
                return tab ? workflowDesk.workflow(ensureWorkflowIdentity(tab)).rename(newName) : false;
            }
        });
        if (!workflowRename.allowed) {
            showToast('运行中的工作流暂不能重命名', 'warning');
            return;
        }
        if (workflowRename.result) {
            showToast(`工作流「${oldName}」已重命名为「${newName}」`, 'success');
            renderWorkflowList();
            scheduleSave({ dirty: false });
        }
    }

    function bindWorkflowListEvents(list) {
        if (!list || list.dataset.workflowEventsBound === '1') return;
        list.dataset.workflowEventsBound = '1';

        const getEventWorkflowItem = (event) => {
            const item = event.target?.closest?.('.workflow-item');
            return item && list.contains(item) ? item : null;
        };
        const getEventWorkflowFolder = (event) => {
            const folderEl = event.target?.closest?.('.workflow-folder');
            return folderEl && list.contains(folderEl) ? folderEl : null;
        };
        const getEventWorkflowFolderChildren = (event) => {
            const childrenEl = event.target?.closest?.('.workflow-folder-children');
            return childrenEl && list.contains(childrenEl) ? childrenEl : null;
        };
        const getDragSourceName = (event) => draggingWorkflowName || event.dataTransfer?.getData('text/plain') || '';
        const findWorkflowItemByName = (name) => Array.from(list.querySelectorAll('.workflow-item'))
            .find((candidate) => candidate.dataset.name === name) || null;
        const toggleFolder = (folderId) => {
            const folder = getWorkflowFolderById(folderId);
            if (!folder) return;
            folder.collapsed = !folder.collapsed;
            renderWorkflowList();
            scheduleSave({ dirty: false });
        };

        list.addEventListener('click', async (event) => {
            const item = getEventWorkflowItem(event);
            if (item) {
                const name = item.dataset.name || '';
                if (!name) return;
                if (workflowSelectionMode) {
                    toggleWorkflowSelection(name);
                    return;
                }
                await openWorkflow(name);
                return;
            }

            const folderEl = getEventWorkflowFolder(event);
            if (!folderEl) return;
            if (event.target?.closest?.('.workflow-folder-toggle')) event.preventDefault();
            toggleFolder(folderEl.dataset.folderId || '');
        });

        list.addEventListener('contextmenu', (event) => {
            const item = getEventWorkflowItem(event);
            if (item) {
                const name = item.dataset.name || '';
                if (!name) return;
                event.preventDefault();
                event.stopPropagation();
                const menu = documentRef.getElementById('workflow-context-menu');
                if (!menu) return;
                documentRef.getElementById('workflow-folder-context-menu')?.classList.add('hidden');
                menu.dataset.targetName = name;
                menu.style.left = `${event.clientX}px`;
                menu.style.top = `${event.clientY}px`;
                menu.classList.remove('hidden');
                refreshWorkflowSelectionUi();
                return;
            }

            const folderEl = getEventWorkflowFolder(event);
            if (!folderEl) return;
            event.preventDefault();
            event.stopPropagation();
            const menu = documentRef.getElementById('workflow-folder-context-menu');
            documentRef.getElementById('workflow-context-menu')?.classList.add('hidden');
            if (!menu) return;
            menu.dataset.folderId = folderEl.dataset.folderId || '';
            menu.style.left = `${event.clientX}px`;
            menu.style.top = `${event.clientY}px`;
            menu.classList.remove('hidden');
        });

        list.addEventListener('dragstart', (event) => {
            const item = getEventWorkflowItem(event);
            if (!item) return;
            const name = item.dataset.name || '';
            if (!name) return;
            draggingWorkflowName = name;
            item.classList.add('is-dragging');
            list.classList.add('workflow-list-dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', name);
        });

        list.addEventListener('dragover', (event) => {
            const sourceName = getDragSourceName(event);
            if (!sourceName) return;

            const item = getEventWorkflowItem(event);
            if (item) {
                const name = item.dataset.name || '';
                const draggedNames = getDraggedWorkflowNames(sourceName);
                if (!name || draggedNames.includes(name)) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                clearWorkflowRootDropTargets(list);
                const rect = item.getBoundingClientRect();
                const placement = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
                const sourceItem = findWorkflowItemByName(sourceName);
                const sameContainer = sourceItem?.parentElement === item.parentElement;
                const sourceItems = sameContainer
                    ? getDraggedWorkflowItemsInContainer(sourceName, item.parentElement)
                    : [];
                const moved = sourceItems.length > 1
                    ? moveWorkflowItemGroupElements(sourceItems, item, placement)
                    : sameContainer && moveWorkflowItemElement(sourceItem, item, placement);
                if (moved) syncWorkflowLayoutFromDom();
                return;
            }

            const folderEl = getEventWorkflowFolder(event);
            if (folderEl) {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                if (canDropDraggedWorkflowsToRoot(sourceName) && isFolderTopRootDropZone(event, folderEl)) {
                    folderEl.classList.remove('is-drop-target');
                    markWorkflowRootDropTarget(folderEl, list);
                    return;
                }
                clearWorkflowRootDropTargets(list);
                const folderId = folderEl.dataset.folderId || '';
                const folder = getWorkflowFolderById(folderId);
                if (folder?.collapsed === true) {
                    folder.collapsed = false;
                    folderEl.classList.remove('is-collapsed');
                    const childrenEl = list.querySelector(`.workflow-folder-children[data-folder-id="${folderId}"]`);
                    childrenEl?.classList.remove('hidden');
                }
                folderEl.classList.add('is-drop-target');
                return;
            }

            const childrenEl = getEventWorkflowFolderChildren(event);
            if (childrenEl) {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                const folderId = childrenEl.dataset.folderId || '';
                if (isFolderChildrenRootDropZone(event, childrenEl, sourceName, folderId)) {
                    childrenEl.classList.remove('is-drop-target');
                    markWorkflowRootDropTarget(getWorkflowFolderElement(folderId, list), list);
                    return;
                }
                clearWorkflowRootDropTargets(list);
                childrenEl.classList.add('is-drop-target');
                return;
            }

            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            markWorkflowRootDropTarget(
                canDropDraggedWorkflowsToRoot(sourceName) ? getFolderRootGapTarget(event, list) : null,
                list
            );
        });

        list.addEventListener('dragleave', (event) => {
            const folderEl = getEventWorkflowFolder(event);
            if (folderEl) {
                folderEl.classList.remove('is-drop-target');
                folderEl.classList.remove('is-root-drop-target');
            }
            const childrenEl = getEventWorkflowFolderChildren(event);
            if (childrenEl) {
                childrenEl.classList.remove('is-drop-target');
                clearWorkflowRootDropTargets(list);
            }
        });

        list.addEventListener('drop', async (event) => {
            const sourceName = getDragSourceName(event);
            if (!sourceName) return;

            const item = getEventWorkflowItem(event);
            if (item) {
                const name = item.dataset.name || '';
                if (!name || getDraggedWorkflowNames(sourceName).includes(name)) return;
                event.preventDefault();
                event.stopPropagation();
                const sourceItem = findWorkflowItemByName(sourceName);
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
                if (syncWorkflowLayoutFromDom()) scheduleSave({ dirty: false });
                return;
            }

            const folderEl = getEventWorkflowFolder(event);
            if (folderEl) {
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
                if (await moveWorkflowsToFolder(getDraggedWorkflowNames(sourceName), folderEl.dataset.folderId || '')) {
                    clearWorkflowDragState(list);
                    renderWorkflowList();
                    scheduleSave({ dirty: false });
                }
                return;
            }

            const childrenEl = getEventWorkflowFolderChildren(event);
            if (childrenEl) {
                event.preventDefault();
                event.stopPropagation();
                childrenEl.classList.remove('is-drop-target');
                const folderId = childrenEl.dataset.folderId || '';
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
                return;
            }

            event.preventDefault();
            clearWorkflowRootDropTargets(list);
            if (await moveWorkflowsToRoot(getDraggedWorkflowNames(sourceName))) {
                clearWorkflowDragState(list);
                renderWorkflowList();
                scheduleSave({ dirty: false });
            }
        });

        list.addEventListener('dragend', () => {
            clearWorkflowDragState(list);
            if (syncWorkflowLayoutFromDom()) scheduleSave({ dirty: false });
        });
    }

    function waitForWorkflowListRenderFrame() {
        return new Promise((resolve) => {
            const requestFrame = windowRef.requestAnimationFrame || ((callback) => windowRef.setTimeout(callback, 16));
            requestFrame(() => resolve());
        });
    }

    async function renderWorkflowList({ forceReload = true } = {}) {
        const list = documentRef.getElementById('workflow-list');
        const workflowEntries = await getWorkflowEntriesForRender({ forceReload });
        if (!list) return;
        bindWorkflowListEvents(list);
        const renderSequence = ++workflowListRenderSequence;
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

        const renderFolderStart = (folder) => {
            const itemCount = Array.isArray(folder.items) ? folder.items.length : 0;
            const collapsed = folder.collapsed === true;
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
    `;
        };

        const renderFolder = (folder) => {
            const children = folder.items.map((name) => renderWorkflowItem(name, folder.id)).join('');
            return `${renderFolderStart(folder)}
            ${children}
        </div>
    `;
        };

        const renderEntry = (entry) => {
            if (entry.startsWith('folder:')) {
                const folder = getWorkflowFolderById(entry.slice('folder:'.length));
                return folder ? renderFolder(folder) : '';
            }
            return workflowNames.includes(entry) ? renderWorkflowItem(entry) : '';
        };

        if (workflowNames.length <= WORKFLOW_LIST_DEFERRED_RENDER_THRESHOLD) {
            list.innerHTML = rootEntries.map((entry) => renderEntry(entry)).join('');
            refreshWorkflowSelectionUi();
            return;
        }

        const workflowNameSet = new Set(workflowNames);
        const segments = [];
        rootEntries.forEach((entry) => {
            if (entry.startsWith('folder:')) {
                const folder = getWorkflowFolderById(entry.slice('folder:'.length));
                if (!folder) return;
                segments.push(() => renderFolderStart(folder));
                (Array.isArray(folder.items) ? folder.items : []).forEach((name) => {
                    segments.push(() => renderWorkflowItem(name, folder.id));
                });
                segments.push(() => '</div>');
                return;
            }
            if (workflowNameSet.has(entry)) {
                segments.push(() => renderWorkflowItem(entry));
            }
        });

        const htmlParts = [];
        for (let index = 0; index < segments.length; index += 1) {
            if (renderSequence !== workflowListRenderSequence) return;
            if (index > 0 && index % WORKFLOW_LIST_RENDER_CHUNK_SIZE === 0) {
                await waitForWorkflowListRenderFrame();
                if (renderSequence !== workflowListRenderSequence) return;
            }
            htmlParts.push(segments[index]());
        }
        if (renderSequence !== workflowListRenderSequence) return;
        list.innerHTML = htmlParts.join('');

        refreshWorkflowSelectionUi();
    }

    function removeDeletedWorkflowMetadata(deletedNames) {
        if (!Array.isArray(deletedNames) || deletedNames.length === 0) return;
        const deletedSet = new Set(deletedNames);
        deletedNames.forEach((name) => selectedWorkflowNames.delete(name));
        state.workflowOrder = (state.workflowOrder || []).filter((entry) => !deletedSet.has(entry));
        (state.workflowFolders || []).forEach((folder) => {
            folder.items = Array.isArray(folder.items) ? folder.items.filter((name) => !deletedSet.has(name)) : [];
        });
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

        const removal = await removeWorkflowTabs(names, {
            persistRemoval: async (targetNames) => {
                const deletedNames = [];
                for (const name of targetNames) {
                    if (await deleteWorkflowFile(name)) deletedNames.push(name);
                }
                return deletedNames;
            }
        });
        const deletedNames = removal.removedNames;
        if (deletedNames.length === 0) return false;
        removeDeletedWorkflowMetadata(deletedNames);
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

        const removal = await removeWorkflowTabs([name], {
            persistRemoval: async () => (await deleteWorkflowFile(name)) ? [name] : []
        });
        if (removal.complete) {
            removeDeletedWorkflowMetadata(removal.removedNames);
            removeWorkflowEntriesFromCache([name]);
            showToast('已删除', 'info');
            renderWorkflowList({ forceReload: false });
            scheduleSave({ dirty: false });
            return true;
        }
        return false;
    }

    async function prepareWorkflowView(data, { signal = null, isCurrent = () => true } = {}) {
        data = migrateLegacyWorkflowData(data);
        if (signal?.aborted || !isCurrent()) return false;
        const modelResolution = resolveWorkflowModelReferences(data, state);
        const warningMessage = buildWorkflowModelWarningMessage(modelResolution);
        if (warningMessage && !(await confirmWorkflowAction({
            title: '加载工作流',
            message: `${warningMessage}\n\n是否继续加载工作流？`,
            note: '选择“是”会继续加载并使用自动匹配结果；选择“否”或“取消”会停止加载。',
            noText: '否',
            signal
        }))) {
            return false;
        }
        if (signal?.aborted || !isCurrent()) return false;
        return { data, modelResolution };
    }

    async function applyWorkflowData(data, options = {}) {
        const { saveSession = true, signal = null, isCurrent = () => true, restoreMode = false } = options;
        const preparedView = options.preparedView || await prepareWorkflowView(data, { signal, isCurrent });
        if (!preparedView) return false;
        data = preparedView.data;
        const { modelResolution } = preparedView;
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
        if (signal?.aborted || !isCurrent()) return false;
        if (!restoreMode && modelResolution.remappedModels.length > 0) {
            showToast(`已自动匹配 ${modelResolution.remappedModels.length} 个模型引用`, 'info', 6000);
        }
        onWorkflowViewApplied({
            workflowName: state.activeWorkflowName || '',
            workflowId: state.activeWorkflowId || ''
        });
        if (!restoreMode) scheduleOpenWorkflowAssetCleanup({ includeCanvas: true });
        if (saveSession) scheduleSave();
        return true;
    }

    async function openWorkflow(name, { reloadFromFile = false } = {}) {
        return workflowTargetActivator.activate(name, { reloadFromFile });
    }

    async function saveActiveWorkflow() {
        const tab = snapshotActiveWorkflow();
        if (!tab) {
            showToast('请先从工作流管理面板打开或新建一个工作流', 'warning');
            return false;
        }
        if ((await workflowDesk.workflow(ensureWorkflowIdentity(tab)).save()).status === 'committed') {
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
            if ((await workflowDesk.workflow(ensureWorkflowIdentity(tab)).save()).status === 'committed') {
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
        const saved = tab
            ? (await workflowDesk.workflow(ensureWorkflowIdentity(tab)).save()).status === 'committed'
            : await saveWorkflowToFile(name, data);
        if (saved) {
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
        if ((await workflowDesk.workflow(ensureWorkflowIdentity(tab)).save()).status !== 'committed') return false;
        tab.dirty = false;
        if ((await workflowDesk.workflow(ensureWorkflowIdentity(tab)).close()).status !== 'committed') return false;
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
        if ((await workflowDesk.workflow(ensureWorkflowIdentity(tab)).close()).status !== 'committed') return false;
        showToast(`已关闭工作流「${name}」`, 'info');
        return true;
    }

    async function reopenWorkflowFromFile(name) {
        if (!name) return false;
        const tab = getWorkflowTab(name);
        if (!tab) return openWorkflow(name, { reloadFromFile: true });
        if (tab?.running === true) {
            showToast('该工作流正在运行，暂不能重新打开', 'warning');
            return false;
        }

        return (await workflowDesk.workflow(ensureWorkflowIdentity(tab)).reload()).status === 'committed';
    }

    async function exportWorkflowByName(name) {
        const fileName = `${getSafeWorkflowFileName(name)}.json`;

        try {
            const tab = getWorkflowTab(name);
            if (!tab) {
                showToast('请先打开工作流再执行另存为', 'warning');
                return false;
            }
            const persistExport = async ({ data }) => {
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
                const blob = new Blob([JSON.stringify(stripInlineImagesFromWorkflowData(data), null, 2)], { type: 'application/json' });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
            } else {
                downloadWorkflowJson(name, data);
            }
                return true;
            };
            const result = await workflowDesk.workflow(ensureWorkflowIdentity(tab)).saveAs(name, {
                persist: persistExport,
                registerOpen: false
            });
            if (!result) return false;
            showToast(`工作流「${name}」已另存为 JSON`, 'success');
            return true;
        } catch (error) {
            if (error?.name !== 'AbortError') {
                showToast(`另存为失败: ${error.message || error}`, 'error');
            }
            return false;
        }
    }

    async function copyWorkflowById(workflowId, label) {
        const result = await workflowDesk.workflow(workflowId).copy(label);
        if (!result) return false;
        renderWorkflowList();
        scheduleSave({ dirty: false });
        return result;
    }

    async function saveWorkflowAsById(workflowId, label) {
        const result = await workflowDesk.workflow(workflowId).saveAs(label);
        if (!result) return false;
        renderWorkflowList();
        scheduleSave({ dirty: false });
        return result;
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
                if ((await workflowDesk.workflow(ensureWorkflowIdentity(tab)).save()).status !== 'committed') return false;
                tab.dirty = false;
            }
        }

        return (await workflowDesk.workflow(ensureWorkflowIdentity(tab)).close()).status === 'committed';
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

            const activeName = state.activeWorkflowName;
            inactiveTabs.forEach((tab) => releaseWorkflowTabMemory(tab));
            state.workflowTabs = tabs.filter((tab) => tab.name === activeName);
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

        if (nextName) {
            let tab = getWorkflowTab(nextName);
            let addedTab = false;
            if (!tab) {
                const data = await loadWorkflowFromFile(nextName);
                if (!data) return false;
                const tab = {
                    name: nextName,
                    data,
                    dirty: false,
                    colorIndex: 0
                };
                ensureWorkflowIdentity(tab);
                state.workflowTabs.push(tab);
                addedTab = true;
            }
            const activated = await openWorkflow(nextName, { reloadFromFile: !addedTab });
            if (!activated) {
                if (addedTab) state.workflowTabs = state.workflowTabs.filter((item) => item.name !== nextName);
                return false;
            }
            const activeTab = getWorkflowTab(nextName);
            state.workflowTabs.forEach((item) => {
                if (item !== activeTab) releaseWorkflowTabMemory(item);
            });
            state.workflowTabs = activeTab ? [activeTab] : [];
        } else {
            if (!(await createNewWorkflow())) return false;
        }
        await renderWorkflowList();
        scheduleSave({ dirty: false });
        return true;
    }

    async function createNewWorkflow() {
        const names = await fetchWorkflows();
        const name = findNextUnsavedName(names);
        const shouldInheritCanvas = false;
        const data = getNewWorkflowData({ inheritCurrentCanvas: shouldInheritCanvas });
        const tab = {
            name,
            data,
            dirty: false,
            colorIndex: (state.workflowTabs || []).length % TAB_COLORS
        };
        ensureWorkflowIdentity(tab);
        if (!(await saveWorkflowToFile(name, data))) return false;
        state.workflowTabs.push(tab);
        await openWorkflow(name);
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

    function updateWorkflowTabDataByName(name, data, options = {}) {
        if (!name || !data) return false;
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
            releaseDetachedEditorView({
                workflowName: tab.name || '',
                workflowId: tab.workflowId || tab.data?.workflowId || ''
            });
            replaceWorkflowTabData(tab, nextData);
            if (options.dirty === true) tab.dirty = true;
            if (options.runResult !== undefined) tab.runResult = normalizeWorkflowRunResult(options.runResult);
        }
        refreshWorkflowCardState(name);
        return true;
    }

    function setWorkflowRunningStateById(workflowId, running = false) {
        const tab = (state.workflowTabs || []).find((candidate) => candidate.workflowId === workflowId);
        if (!tab) return false;
        tab.running = running === true;
        activeState.setRunning(workflowId, tab.running);
        if (tab.running) tab.runResult = '';
        if (state.activeWorkflowId === workflowId) {
            state.nodes.forEach((node) => node.el?.classList.remove('workflow-running-locked'));
        }
        refreshWorkflowCardState(tab.name);
        renderWorkflowList();
        scheduleSave({ dirty: false });
        return true;
    }

    function setWorkflowRunResultById(workflowId, result = '') {
        const tab = (state.workflowTabs || []).find((candidate) => candidate.workflowId === workflowId);
        if (!tab) return false;
        tab.runResult = state.activeWorkflowId === workflowId ? '' : normalizeWorkflowRunResult(result);
        refreshWorkflowCardState(tab.name);
        renderWorkflowList();
        scheduleSave({ dirty: false });
        return true;
    }

    return {
        applyWorkflowSidebarWidth,
        activateRestoredWorkflowState: workflowSessionActivator.activate,
        initWorkflow,
        loadWorkflowFromFile,
        openWorkflow,
        saveActiveWorkflow,
        saveAllOpenWorkflows,
        markActiveWorkflowDirty,
        snapshotActiveWorkflow,
        getActiveWorkflowName: () => state.activeWorkflowName || '',
        getActiveWorkflowId: () => state.activeWorkflowId || '',
        getWorkflowNameById: (workflowId) => (state.workflowTabs || [])
            .find((tab) => tab.workflowId === workflowId)?.name || '',
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
        updateWorkflowTabDataById: (workflowId, data, options = {}) => {
            const tab = (state.workflowTabs || []).find((candidate) => candidate.workflowId === workflowId);
            if (!tab) return false;
            return updateWorkflowTabDataByName(tab.name, data, options);
        },
        setWorkflowRunningStateById,
        setWorkflowRunResultById,
        syncActiveWorkflowBeforeSessionSave,
        cleanupOpenWorkflowAssets,
        ensureOpenWorkflow,
        copyWorkflowById,
        saveWorkflowAsById,
        closeOtherWorkflows,
        reloadAfterWorkflowImport
    };
}
import { serializeConnection } from '../../canvas/connection-snapshot.js';
