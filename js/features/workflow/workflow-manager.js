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
import { normalizeModelConfig, normalizeProviderType } from '../execution/provider-request-utils.js';

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
    documentRef = document,
    windowRef = window
}) {
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

    async function renderWorkflowList() {
        const list = documentRef.getElementById('workflow-list');
        const names = await fetchWorkflows();
        if (!list) return;

        if (names.length === 0) {
            list.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding: 20px; font-size:12px;">暂无保存的工作流</div>';
            return;
        }

        list.innerHTML = names.map((name) => `
        <div class="workflow-item" data-name="${name}">
            <span class="workflow-item-name">${name}</span>
            <div class="workflow-item-actions">
                <button class="workflow-action-btn load-btn" title="加载">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
                </button>
                <button class="workflow-action-btn delete delete-btn" title="删除">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </div>
        </div>
    `).join('');

        list.querySelectorAll('.workflow-item').forEach((item) => {
            const name = item.dataset.name;
            item.addEventListener('click', async (e) => {
                if (e.target.closest('.workflow-action-btn')) return;
                const data = await loadWorkflowFromFile(name);
                if (data && windowRef.confirm(`确定要加载工作流「${name}」吗？这将覆盖当前画布。`)) {
                    applyWorkflowData(data);
                    showToast('已加载工作流: ' + name, 'success');
                }
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

            item.querySelector('.load-btn').onclick = (e) => {
                e.stopPropagation();
                item.click();
            };

            item.querySelector('.delete-btn').onclick = async (e) => {
                e.stopPropagation();
                if (windowRef.confirm(`确定要删除工作流「${name}」吗？`)) {
                    if (await deleteWorkflowFile(name)) {
                        showToast('已删除', 'info');
                        renderWorkflowList();
                    }
                }
            };
        });
    }

    function applyWorkflowData(data) {
        state.connections = [];
        for (const [, node] of state.nodes) node.el.remove();
        state.nodes.clear();
        state.selectedNodes.clear();

        if (data.providers) {
            let missingKeys = 0;
            const existingProviders = new Map(state.providers.map((provider) => [provider.id, provider]));

            data.providers.forEach((newProvider) => {
                if (existingProviders.has(newProvider.id)) {
                    const oldProvider = existingProviders.get(newProvider.id);
                    const mergedProvider = {
                        ...newProvider,
                        name: oldProvider.name || newProvider.name,
                        type: normalizeProviderType(oldProvider.type || newProvider.type, {
                            endpoint: oldProvider.endpoint || newProvider.endpoint
                        }),
                        endpoint: oldProvider.endpoint || newProvider.endpoint,
                        apikey: oldProvider.apikey || newProvider.apikey || ''
                    };
                    existingProviders.set(newProvider.id, mergedProvider);
                    if (!mergedProvider.apikey) missingKeys++;
                } else {
                    existingProviders.set(newProvider.id, {
                        ...newProvider,
                        type: normalizeProviderType(newProvider.type, newProvider),
                        apikey: newProvider.apikey || ''
                    });
                    if (!newProvider.apikey) missingKeys++;
                }
            });
            state.providers = Array.from(existingProviders.values());

            if (missingKeys > 0) {
                showToast(`检测到 ${missingKeys} 个 API 供应商缺少密钥，请在设置中配置以正常运行`, 'warning', 8000);
            }
        }

        if (data.models) {
            const existingModels = new Map(state.models.map((model) => [model.id, model]));
            const providersById = new Map(state.providers.map((provider) => [provider.id, provider]));
            data.models.forEach((newModel) => {
                existingModels.set(newModel.id, normalizeModelConfig(newModel, 0, providersById));
            });
            state.models = Array.from(existingModels.values());
        }

        if (data.canvas) {
            state.canvas.x = data.canvas.x || 0;
            state.canvas.y = data.canvas.y || 0;
            state.canvas.zoom = data.canvas.zoom || 1;
        }

        if (data.nodes?.length) {
            for (const nodeData of data.nodes) addNode(nodeData.type, nodeData.x, nodeData.y, nodeData);
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
        scheduleSave();
    }

    async function ensureDefaultWorkflow() {
        const names = await fetchWorkflows();
        if (!names.includes('Default')) {
            const safeProviders = state.providers.map((provider) => {
                const { apikey, ...rest } = provider;
                return rest;
            });
            const defaultData = {
                canvas: { x: 0, y: 0, zoom: 1 },
                nodes: [
                    { id: 'n_prompt', type: 'Text', x: 100, y: 150, width: 240, height: 160, text: 'A futuristic city at sunset, cinematic lighting, 8k resolution' },
                    { id: 'n_gen', type: 'ImageGenerate', x: 450, y: 100, width: 260, height: 520, apiConfigId: state.models[0]?.id || 'default', generationCount: 1 },
                    { id: 'n_prev', type: 'ImagePreview', x: 800, y: 150, width: 300, height: 350 }
                ],
                connections: [
                    { id: 'c_p_g', from: { nodeId: 'n_prompt', port: 'text' }, to: { nodeId: 'n_gen', port: 'prompt' }, type: 'text' },
                    { id: 'c_g_p', from: { nodeId: 'n_gen', port: 'image' }, to: { nodeId: 'n_prev', port: 'image' }, type: 'image' }
                ],
                providers: safeProviders,
                models: state.models,
                version: '1.2'
            };
            await saveWorkflowToFile('Default', defaultData);
        }
    }

    function initWorkflow() {
        const btnToggle = documentRef.getElementById('btn-toggle-workflow');
        const btnClose = documentRef.getElementById('btn-close-workflow');
        const btnSave = documentRef.getElementById('btn-save-workflow');
        const inputName = documentRef.getElementById('input-workflow-name');

        if (!btnToggle) return;

        btnToggle.addEventListener('click', () => {
            panelManager.toggle('workflow', () => {
                renderWorkflowList();
            });
        });

        btnClose?.addEventListener('click', () => {
            panelManager.close('workflow');
        });

        btnSave?.addEventListener('click', async () => {
            const name = inputName.value.trim();
            if (!name) return showToast('请输入工作流名称', 'warning');

            const safeProviders = state.providers.map((provider) => {
                const { apikey, ...rest } = provider;
                return rest;
            });

            const data = {
                canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom },
                nodes: nodeSerializer.serializeNodes(),
                connections: state.connections.map((conn) => ({ id: conn.id, from: conn.from, to: conn.to, type: conn.type })),
                providers: safeProviders,
                models: state.models,
                version: '1.2'
            };

            if (await saveWorkflowToFile(name, data)) {
                showToast(`工作流「${name}」已保存`, 'success');
                inputName.value = '';
                renderWorkflowList();
            }
        });

        const menu = documentRef.getElementById('workflow-context-menu');
        documentRef.getElementById('menu-rename-workflow')?.addEventListener('click', async () => {
            const oldName = menu.dataset.targetName;
            const newName = windowRef.prompt('重命名工作流:', oldName);
            if (newName && newName !== oldName) {
                if (await renameWorkflowFile(oldName, newName.trim())) {
                    showToast('已重命名', 'success');
                    renderWorkflowList();
                }
            }
            menu.classList.add('hidden');
        });

        documentRef.getElementById('menu-delete-workflow')?.addEventListener('click', async () => {
            const name = menu.dataset.targetName;
            if (windowRef.confirm(`确定要删除工作流「${name}」吗？`)) {
                if (await deleteWorkflowFile(name)) {
                    showToast('已删除', 'info');
                    renderWorkflowList();
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
        loadWorkflowFromFile
    };
}
