/**
 * 负责工作流文件管理与默认工作流应用，包括列表渲染、保存、加载、删除与校验提示。
 */
import {
    deleteWorkflowFile as deleteWorkflowFileService,
    fetchWorkflows as fetchWorkflowsService,
    loadWorkflowFromFile as loadWorkflowFromFileService,
    renameWorkflowFile as renameWorkflowFileService,
    saveWorkflowToFile as saveWorkflowToFileService
} from '../../services/workflow-api.js';
import {
    buildWorkflowModelWarningMessage,
    resolveWorkflowModelReferences
} from '../persistence/workflow-model-resolver.js';
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
    documentRef = document,
    windowRef = window,
    localStorageRef = localStorage
}) {
    const WORKFLOW_VERSION = '1.3';
    const TAB_COLORS = 6;
    const RUN_RESULT_SUCCESS = 'success';
    const RUN_RESULT_ERROR = 'error';
    const DEFAULT_WORKFLOW_SEED_KEY = 'cainflow_default_workflow_seeded';
    let workflowSelectionMode = false;
    const selectedWorkflowNames = new Set();

    function getDefaultWorkflowSeeded() {
        try {
            return localStorageRef.getItem(DEFAULT_WORKFLOW_SEED_KEY) === '1';
        } catch {
            return false;
        }
    }

    function setDefaultWorkflowSeeded() {
        try {
            localStorageRef.setItem(DEFAULT_WORKFLOW_SEED_KEY, '1');
        } catch {
            // Ignore storage failures; the workflow list still works without the seed flag.
        }
    }

    function normalizeWorkflowRunResult(value) {
        return value === RUN_RESULT_SUCCESS || value === RUN_RESULT_ERROR ? value : '';
    }

    async function fetchWorkflows() {
        return fetchWorkflowsService();
    }

    async function saveWorkflowToFile(name, data) {
        const result = await saveWorkflowToFileService(name, data);
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
        const mergedNodeIds = new Set();
        const runtimeNodeById = new Map(runtimeNodes.map((node) => [node?.id, node]).filter(([id]) => id));
        const mergedNodes = [];

        (Array.isArray(current.nodes) ? current.nodes : []).forEach((node) => {
            if (!node?.id) return;
            const runtimeNode = runtimeNodeById.get(node.id);
            mergedNodes.push(runtimeNode ? cloneWorkflowItem(runtimeNode) : node);
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
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
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

    function findNextUnsavedName(names) {
        const existing = new Set(names);
        if (!existing.has('Unsaved')) return 'Unsaved';
        let index = 1;
        while (existing.has(`Unsaved ${index}`)) index += 1;
        return `Unsaved ${index}`;
    }

    function renderWorkflowEmpty(list, text = '暂无保存的工作流') {
        list.innerHTML = `<div class="workflow-empty">${escapeHtml(text)}</div>`;
    }

    function getEmptyWorkflowData() {
        return {
            canvas: { x: 0, y: 0, zoom: 1 },
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
        const canvasContainer = documentRef.getElementById('canvas-container');
        state.canvas.x = (canvasContainer?.clientWidth || windowRef.innerWidth || 0) / 2;
        state.canvas.y = (canvasContainer?.clientHeight || windowRef.innerHeight || 0) / 2;
        state.canvas.zoom = 1;
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
                value: oldName,
                maxLength: 120,
                rejectPattern: /[\\/:*?"<>|]/
            },
            actions: [
                { id: 'cancel', label: '取消', variant: 'secondary' },
                { id: 'confirm', label: '确定', variant: 'primary' }
            ]
        });
        if (result?.actionId !== 'confirm') return;

        const newName = result.value.trim();
        if (!newName) {
            showToast('请输入新的工作流名称', 'warning');
            return;
        }
        if (newName === oldName) {
            showToast('工作流名称未改变', 'info');
            return;
        }
        if (/[\\/:*?"<>|]/.test(newName)) {
            showToast('工作流名称不能包含 \\ / : * ? " < > |', 'warning');
            return;
        }
        const names = await fetchWorkflows();
        if (names.includes(newName)) {
            showToast(`已存在名为「${newName}」的工作流`, 'warning');
            return;
        }
        if (await renameWorkflowFile(oldName, newName)) {
            const tab = getWorkflowTab(oldName);
            if (tab) tab.name = newName;
            if (state.activeWorkflowName === oldName) state.activeWorkflowName = newName;
            if (selectedWorkflowNames.has(oldName)) {
                selectedWorkflowNames.delete(oldName);
                selectedWorkflowNames.add(newName);
            }
            showToast(`工作流「${oldName}」已重命名为「${newName}」`, 'success');
            renderWorkflowList();
            scheduleSave({ dirty: false });
        }
    }

    async function renderWorkflowList() {
        const list = documentRef.getElementById('workflow-list');
        const savedNames = await fetchWorkflows();
        if (!list) return;
        normalizeWorkflowTabs();
        const names = Array.from(new Set([
            ...savedNames,
            ...(state.workflowTabs || []).map((tab) => tab.name).filter(Boolean)
        ]));
        pruneWorkflowSelection(names);

        if (names.length === 0) {
            selectedWorkflowNames.clear();
            renderWorkflowEmpty(list);
            refreshWorkflowSelectionUi();
            return;
        }

        list.innerHTML = names.map((name) => {
            const tab = getWorkflowTab(name);
            const isOpen = !!tab;
            const isActive = state.activeWorkflowName === name;
            const dirty = tab?.dirty === true;
            const running = tab?.running === true;
            const runResult = !isActive ? normalizeWorkflowRunResult(tab?.runResult) : '';
            const runResultClass = runResult ? `has-run-result is-run-${runResult}` : '';
            const selectedClass = selectedWorkflowNames.has(name) ? 'is-selected' : '';
            const colorIndex = Number.isInteger(tab?.colorIndex) ? tab.colorIndex % TAB_COLORS : 0;
            return `
        <div class="workflow-item ${isOpen ? 'is-open' : ''} ${isActive ? 'is-active' : ''} ${dirty ? 'is-dirty' : ''} ${running ? 'is-running' : ''} ${runResultClass} ${selectedClass}"
             data-name="${escapeHtml(name)}"
             data-tab-color="${colorIndex}">
            <span class="workflow-select-check" aria-hidden="true"></span>
            <span class="workflow-item-name" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <span class="workflow-item-state">${getWorkflowCardStateLabel({ isActive, isOpen, running, runResult })}</span>
            <span class="workflow-dirty-dot" aria-hidden="true"></span>
            <div class="workflow-item-actions">
                ${isOpen ? `
                <button class="workflow-action-btn close-tab-btn" title="关闭">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>` : ''}
                <button class="workflow-action-btn rename-btn" title="重命名">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                </button>
                <button class="workflow-action-btn delete delete-btn" title="删除">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </div>
        </div>
    `;
        }).join('');

        list.querySelectorAll('.workflow-item').forEach((item) => {
            const name = item.dataset.name;
            item.addEventListener('click', async (e) => {
                if (e.target.closest('.workflow-action-btn')) return;
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
                menu.dataset.targetName = name;
                menu.style.left = e.clientX + 'px';
                menu.style.top = e.clientY + 'px';
                menu.classList.remove('hidden');
                refreshWorkflowSelectionUi();
            });

            item.querySelector('.close-tab-btn')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                await closeWorkflow(name);
            });

            item.querySelector('.rename-btn').onclick = async (e) => {
                e.stopPropagation();
                await promptRenameWorkflow(name);
            };

            item.querySelector('.delete-btn').onclick = async (e) => {
                e.stopPropagation();
                if (workflowSelectionMode && selectedWorkflowNames.size > 0) {
                    await confirmAndDeleteSelectedWorkflows();
                    return;
                }
                await confirmAndDeleteWorkflow(name);
            };
        });
        refreshWorkflowSelectionUi();
    }

    async function applyDeletedWorkflowNames(deletedNames) {
        if (!Array.isArray(deletedNames) || deletedNames.length === 0) return;
        const deletedSet = new Set(deletedNames);
        deletedNames.forEach((name) => selectedWorkflowNames.delete(name));
        const wasActive = deletedSet.has(state.activeWorkflowName);
        state.workflowTabs = (state.workflowTabs || []).filter((item) => !deletedSet.has(item.name));
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
                if (name === 'Default') setDefaultWorkflowSeeded();
                deletedNames.push(name);
            }
        }

        if (deletedNames.length === 0) return false;
        await applyDeletedWorkflowNames(deletedNames);
        if (deletedNames.length === names.length) {
            showToast(`已删除 ${deletedNames.length} 个工作流`, 'info');
        } else {
            showToast(`已删除 ${deletedNames.length} 个工作流，${names.length - deletedNames.length} 个删除失败`, 'warning');
        }
        renderWorkflowList();
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
            if (name === 'Default') setDefaultWorkflowSeeded();
            await applyDeletedWorkflowNames([name]);
            showToast('已删除', 'info');
            renderWorkflowList();
            scheduleSave({ dirty: false });
            return true;
        }
        return false;
    }

    async function applyWorkflowData(data, options = {}) {
        const { saveSession = true, keepRunningLock = false } = options;
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

        if (keepRunningLock || getActiveWorkflowTab()?.running === true) {
            state.nodes.forEach((node) => {
                node.el?.classList.add('workflow-running-locked');
            });
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
        await cleanupOpenWorkflowAssets({ includeCanvas: true });
        onWorkflowViewApplied(state.activeWorkflowName || '');
        if (saveSession) scheduleSave();
        return true;
    }

    async function openWorkflow(name) {
        if (!name) return false;
        if (state.activeWorkflowName === name) {
            if (clearWorkflowRunResult(name)) {
                renderWorkflowList();
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
                data,
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
            renderWorkflowList();
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
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
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
        const shouldInheritCanvas = !getActiveWorkflowTab();
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
        normalizeWorkflowTabs();
        const activeTab = getActiveWorkflowTab();
        if (activeTab) return true;
        await ensureActiveWorkflowExists({ inheritCurrentCanvas: useCurrentCanvas });
        return true;
    }

    async function ensureDefaultWorkflow() {
        const names = await fetchWorkflows();
        if (names.includes('Default')) {
            setDefaultWorkflowSeeded();
            return;
        }

        if (names.length > 0 || getDefaultWorkflowSeeded()) {
            return;
        }

        const defaultImageModel = state.models.find((model) => model.taskType === 'image');
        const defaultData = {
            canvas: { x: 0, y: 0, zoom: 1 },
            nodes: [
                { id: 'n_prompt', type: 'Text', x: 100, y: 150, width: 240, height: 160, text: 'A futuristic city at sunset, cinematic lighting, 8k resolution' },
                { id: 'n_gen', type: 'ImageGenerate', x: 450, y: 100, width: 260, height: 520, apiConfigId: defaultImageModel?.id || 'default', generationCount: 1 },
                { id: 'n_prev', type: 'ImagePreview', x: 800, y: 150, width: 300, height: 350 }
            ],
            connections: [
                { id: 'c_p_g', from: { nodeId: 'n_prompt', port: 'text' }, to: { nodeId: 'n_gen', port: 'prompt' }, type: 'text' },
                { id: 'c_g_p', from: { nodeId: 'n_gen', port: 'image' }, to: { nodeId: 'n_prev', port: 'image' }, type: 'image' }
            ],
            version: '1.3'
        };
        const saved = await saveWorkflowToFile('Default', defaultData);
        if (saved) {
            setDefaultWorkflowSeeded();
        }
    }

    function initWorkflow() {
        const btnToggle = documentRef.getElementById('btn-toggle-workflow');
        const btnClose = documentRef.getElementById('btn-close-workflow');
        const btnSave = documentRef.getElementById('btn-save-workflow');
        const btnDeleteActive = documentRef.getElementById('btn-delete-active-workflow');
        const btnNew = documentRef.getElementById('btn-new-workflow');
        const btnCloseOther = documentRef.getElementById('btn-close-other-workflows');

        if (!btnToggle) return;

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
        const getMenuTargetName = () => menu?.dataset?.targetName || '';
        const hideWorkflowMenu = () => menu?.classList.add('hidden');
        const bindWorkflowMenuAction = (id, action) => {
            documentRef.getElementById(id)?.addEventListener('click', async (event) => {
                event.stopPropagation();
                const name = getMenuTargetName();
                hideWorkflowMenu();
                if (!name) return;
                await action(name);
            });
        };

        bindWorkflowMenuAction('menu-save-workflow', saveWorkflowByName);
        bindWorkflowMenuAction('menu-save-close-workflow', closeWorkflowAfterSave);
        bindWorkflowMenuAction('menu-close-discard-workflow', closeWorkflowWithoutSaving);
        bindWorkflowMenuAction('menu-reopen-workflow', reopenWorkflowFromFile);
        bindWorkflowMenuAction('menu-save-as-workflow', exportWorkflowByName);
        documentRef.getElementById('menu-toggle-workflow-selection')?.addEventListener('click', (event) => {
            event.stopPropagation();
            hideWorkflowMenu();
            setWorkflowSelectionMode(!workflowSelectionMode);
        });

        documentRef.getElementById('menu-rename-workflow')?.addEventListener('click', async (event) => {
            event.stopPropagation();
            const oldName = getMenuTargetName();
            hideWorkflowMenu();
            await promptRenameWorkflow(oldName);
        });

        documentRef.getElementById('menu-delete-workflow')?.addEventListener('click', async (event) => {
            event.stopPropagation();
            const name = getMenuTargetName();
            hideWorkflowMenu();
            await confirmAndDeleteWorkflow(name);
        });

        windowRef.addEventListener('click', hideWorkflowMenu);
        refreshWorkflowSelectionUi();
        ensureDefaultWorkflow();
    }

    return {
        applyWorkflowData,
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
                    baseConnectionIds: options.baseConnectionIds
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
