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
    documentRef = document,
    windowRef = window
}) {
    const WORKFLOW_VERSION = '1.3';
    const TAB_COLORS = 6;

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

    function getWorkflowPayload() {
        return {
            canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom },
            nodes: nodeSerializer.serializeNodes(),
            connections: state.connections.map((conn) => ({ id: conn.id, from: conn.from, to: conn.to, type: conn.type })),
            version: WORKFLOW_VERSION
        };
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
        item.classList.toggle('is-open', isOpen);
        item.classList.toggle('is-active', isActive);
        item.classList.toggle('is-dirty', tab?.dirty === true);
        const stateLabel = item.querySelector('.workflow-item-state');
        if (stateLabel) stateLabel.textContent = isActive ? '当前' : (isOpen ? '已打开' : '');
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
                colorIndex: Number.isInteger(tab.colorIndex) ? tab.colorIndex : index
            }));
        if (state.activeWorkflowName && !getWorkflowTab(state.activeWorkflowName)) {
            state.activeWorkflowName = state.workflowTabs[0]?.name || '';
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

    async function activateFallbackWorkflow() {
        const nextTab = state.workflowTabs[0] || null;
        state.activeWorkflowName = nextTab?.name || '';
        if (nextTab) {
            await applyWorkflowData(nextTab.data, { saveSession: false });
        } else {
            await applyWorkflowData(getEmptyWorkflowData(), { saveSession: false });
        }
    }

    async function promptRenameWorkflow(oldName) {
        if (!oldName) return;
        const input = windowRef.prompt('重命名工作流:', oldName);
        if (input === null) return;

        const newName = input.trim();
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
            showToast(`工作流「${oldName}」已重命名为「${newName}」`, 'success');
            renderWorkflowList();
            scheduleSave({ dirty: false });
        }
    }

    async function renderWorkflowList() {
        const list = documentRef.getElementById('workflow-list');
        const names = await fetchWorkflows();
        if (!list) return;
        normalizeWorkflowTabs();

        if (names.length === 0) {
            renderWorkflowEmpty(list);
            return;
        }

        list.innerHTML = names.map((name) => {
            const tab = getWorkflowTab(name);
            const isOpen = !!tab;
            const isActive = state.activeWorkflowName === name;
            const dirty = tab?.dirty === true;
            const colorIndex = Number.isInteger(tab?.colorIndex) ? tab.colorIndex % TAB_COLORS : 0;
            return `
        <div class="workflow-item ${isOpen ? 'is-open' : ''} ${isActive ? 'is-active' : ''} ${dirty ? 'is-dirty' : ''}"
             data-name="${escapeHtml(name)}"
             data-tab-color="${colorIndex}">
            <span class="workflow-dirty-dot" aria-hidden="true"></span>
            <span class="workflow-item-name">${escapeHtml(name)}</span>
            <span class="workflow-item-state">${isActive ? '当前' : (isOpen ? '已打开' : '')}</span>
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
                if (windowRef.confirm(`确定要删除工作流「${name}」吗？`)) {
                    const tab = getWorkflowTab(name);
                    if (tab?.dirty && !windowRef.confirm(`工作流「${name}」有未保存修改，仍要删除文件吗？`)) {
                        return;
                    }
                    if (await deleteWorkflowFile(name)) {
                        const wasActive = state.activeWorkflowName === name;
                        state.workflowTabs = (state.workflowTabs || []).filter((item) => item.name !== name);
                        if (wasActive) {
                            if (state.workflowTabs.length > 0) {
                                await activateFallbackWorkflow();
                            } else {
                                state.activeWorkflowName = '';
                                await ensureOpenWorkflow({ useCurrentCanvas: false });
                            }
                        }
                        showToast('已删除', 'info');
                        renderWorkflowList();
                        scheduleSave({ dirty: false });
                    }
                }
            };
        });
    }

    async function applyWorkflowData(data, options = {}) {
        const { saveSession = true } = options;
        if (state.runningNodeIds?.size > 0) {
            showToast('有节点正在运行，暂不能加载其他工作流', 'warning');
            return false;
        }
        const modelResolution = resolveWorkflowModelReferences(data, state);
        const warningMessage = buildWorkflowModelWarningMessage(modelResolution);
        if (warningMessage && !windowRef.confirm(`${warningMessage}\n\n是否继续加载工作流？`)) {
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
            for (const nodeData of modelResolution.nodes) addNode(nodeData.type, nodeData.x, nodeData.y, nodeData);
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
        if (saveSession) scheduleSave();
        return true;
    }

    async function openWorkflow(name) {
        if (!name) return false;
        if (state.activeWorkflowName === name) return true;
        if (state.runningNodeIds?.size > 0) {
            showToast('有节点正在运行，暂不能切换工作流', 'warning');
            return false;
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

    async function closeWorkflow(name) {
        const tab = getWorkflowTab(name);
        if (!tab) return true;
        if (state.runningNodeIds?.size > 0 && state.activeWorkflowName === name) {
            showToast('有节点正在运行，暂不能关闭当前工作流', 'warning');
            return false;
        }
        if (state.activeWorkflowName === name) snapshotActiveWorkflow();

        if (tab.dirty && windowRef.confirm(`工作流「${name}」有未保存修改，关闭前是否保存？`)) {
            if (!(await saveWorkflowToFile(tab.name, tab.data))) return false;
            tab.dirty = false;
        }

        const wasActive = state.activeWorkflowName === name;
        state.workflowTabs = (state.workflowTabs || []).filter((item) => item.name !== name);
        if (wasActive) {
            if (state.workflowTabs.length > 0) {
                await activateFallbackWorkflow();
            } else {
                state.activeWorkflowName = '';
                await ensureOpenWorkflow({ useCurrentCanvas: false });
            }
        }
        renderWorkflowList();
        scheduleSave({ dirty: false });
        return true;
    }

    async function createNewWorkflow() {
        const names = await fetchWorkflows();
        const name = findNextUnsavedName(names);
        const data = getEmptyWorkflowData();
        if (!(await saveWorkflowToFile(name, data))) return false;
        snapshotActiveWorkflow();
        state.workflowTabs.push({
            name,
            data,
            dirty: false,
            colorIndex: (state.workflowTabs || []).length % TAB_COLORS
        });
        state.activeWorkflowName = name;
        await applyWorkflowData(data, { saveSession: false });
        showToast(`已新建工作流「${name}」`, 'success');
        renderWorkflowList();
        scheduleSave({ dirty: false });
        return true;
    }

    async function ensureOpenWorkflow({ useCurrentCanvas = true } = {}) {
        normalizeWorkflowTabs();
        if (getActiveWorkflowTab()) return true;

        if (state.workflowTabs.length > 0) {
            const tab = state.workflowTabs[0];
            state.activeWorkflowName = tab.name;
            await applyWorkflowData(tab.data, { saveSession: false });
            renderWorkflowList();
            scheduleSave({ dirty: false });
            return true;
        }

        const names = await fetchWorkflows();
        const name = findNextUnsavedName(names);
        const hasCanvasContent = useCurrentCanvas && (state.nodes.size > 0 || state.connections.length > 0);
        const data = hasCanvasContent ? getWorkflowPayload() : getEmptyWorkflowData();
        if (!(await saveWorkflowToFile(name, data))) return false;

        state.workflowTabs.push({
            name,
            data,
            dirty: false,
            colorIndex: 0
        });
        state.activeWorkflowName = name;

        if (!hasCanvasContent) {
            await applyWorkflowData(data, { saveSession: false });
        }

        renderWorkflowList();
        scheduleSave({ dirty: false });
        showToast(`已自动新建工作流「${name}」`, 'info');
        return true;
    }

    async function ensureDefaultWorkflow() {
        const names = await fetchWorkflows();
        if (!names.includes('Default')) {
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
            await saveWorkflowToFile('Default', defaultData);
        }
    }

    function initWorkflow() {
        const btnToggle = documentRef.getElementById('btn-toggle-workflow');
        const btnClose = documentRef.getElementById('btn-close-workflow');
        const btnSave = documentRef.getElementById('btn-save-workflow');
        const btnNew = documentRef.getElementById('btn-new-workflow');

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

        btnSave?.addEventListener('click', async () => {
            await saveActiveWorkflow();
        });

        const menu = documentRef.getElementById('workflow-context-menu');
        documentRef.getElementById('menu-rename-workflow')?.addEventListener('click', async () => {
            const oldName = menu.dataset.targetName;
            await promptRenameWorkflow(oldName);
            menu.classList.add('hidden');
        });

        documentRef.getElementById('menu-delete-workflow')?.addEventListener('click', async () => {
            const name = menu.dataset.targetName;
            if (windowRef.confirm(`确定要删除工作流「${name}」吗？`)) {
                const tab = getWorkflowTab(name);
                if (tab?.dirty && !windowRef.confirm(`工作流「${name}」有未保存修改，仍要删除文件吗？`)) {
                    menu.classList.add('hidden');
                    return;
                }
                if (await deleteWorkflowFile(name)) {
                    const wasActive = state.activeWorkflowName === name;
                    state.workflowTabs = (state.workflowTabs || []).filter((item) => item.name !== name);
                    if (wasActive) {
                        if (state.workflowTabs.length > 0) {
                            await activateFallbackWorkflow();
                        } else {
                            state.activeWorkflowName = '';
                            await ensureOpenWorkflow({ useCurrentCanvas: false });
                        }
                    }
                    showToast('已删除', 'info');
                    renderWorkflowList();
                    scheduleSave({ dirty: false });
                }
            }
            menu.classList.add('hidden');
        });

        windowRef.addEventListener('click', () => menu?.classList.add('hidden'));
        ensureDefaultWorkflow();
    }

    return {
        applyWorkflowData,
        initWorkflow,
        loadWorkflowFromFile,
        openWorkflow,
        saveActiveWorkflow,
        markActiveWorkflowDirty,
        snapshotActiveWorkflow,
        syncActiveWorkflowBeforeSessionSave,
        cleanupOpenWorkflowAssets,
        ensureOpenWorkflow
    };
}
