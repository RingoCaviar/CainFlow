/**
 * 负责工作流项目的导入导出与恢复加载，是前端项目 IO 的统一入口。
 */
import { getModelProviderIds, normalizeModelConfig, normalizeProviderType } from '../execution/provider-request-utils.js';
import { normalizeNodeDefaults } from '../../core/state.js';
import { API_PROVIDERS_LOCKED, DEFAULT_PROVIDERS } from '../../core/constants.js';
import { cleanupElementResources } from '../../core/common-utils.js';
import {
    buildWorkflowModelWarningMessage,
    resolveWorkflowModelReferences
} from './workflow-model-resolver.js';
import { migrateLegacyWorkflowData } from './legacy-node-migration.js';

export function createProjectIoApi({
    state,
    storageKey,
    nodeSerializer,
    localStorageRef = localStorage,
    documentRef = document,
    windowRef = window,
    getHandle,
    addLog,
    addNode,
    applyHistoryGridCols,
    updateAllConnections,
    updatePortStyles,
    onConnectionsChanged = () => {},
    viewportApi,
    showToast,
    applyTheme = () => {},
    applyGlobalAnimationSetting = () => {},
    applyCanvasUiSetting = () => {},
    applyWorkflowSidebarWidth = () => {},
    clearImageAssets = null,
    clearOrphanedNodeAssets = async () => true,
    clearOrphanedImageImportAssets = async () => true,
    trimHistoryCache = async () => true,
    cleanupRecoverableNodeAssetCache = null,
    clearUndoStack = () => {},
    updateCacheUsage = () => {},
    beginMediaRestoreBatch = () => {},
    endMediaRestoreBatch = () => {},
    finalizeMediaRestoreBatch = async () => {}
}) {
    function isImageImportAssetKey(key) {
        return typeof key === 'string' && key.startsWith('image-import:');
    }

    function getImageImportAssetKeyFromNode(node) {
        const key = node?.imageImportAssetKey || node?.data?.imageImportAssetKey || '';
        if (isImageImportAssetKey(key)) return key;
        return '';
    }

    function collectWorkflowImageImportAssetKeys(workflowData) {
        const keys = new Set();
        if (!Array.isArray(workflowData?.nodes)) return keys;
        workflowData.nodes.forEach((node) => {
            const key = getImageImportAssetKeyFromNode(node);
            if (key) keys.add(key);
        });
        return keys;
    }

    function collectActiveImageImportAssetKeys(data = null) {
        const keys = new Set();
        state.nodes.forEach((node) => {
            const key = getImageImportAssetKeyFromNode(node);
            if (key) keys.add(key);
        });

        const addWorkflowKeys = (workflowData) => {
            collectWorkflowImageImportAssetKeys(workflowData).forEach((key) => keys.add(key));
        };

        if (data) addWorkflowKeys(data);
        (state.workflowTabs || []).forEach((tab) => addWorkflowKeys(tab?.data));
        return keys;
    }

    function scheduleIdleTask(callback, { delayMs = 0, timeoutMs = 5000 } = {}) {
        const run = () => {
            if (typeof windowRef.requestIdleCallback === 'function') {
                windowRef.requestIdleCallback(callback, { timeout: timeoutMs });
                return;
            }
            windowRef.setTimeout(callback, 0);
        };
        windowRef.setTimeout(run, delayMs);
    }

    function scheduleStartupCacheCleanup(data) {
        scheduleIdleTask(() => {
            const cleanup = typeof cleanupRecoverableNodeAssetCache === 'function'
                ? cleanupRecoverableNodeAssetCache
                : () => clearOrphanedNodeAssets(new Set(state.nodes.keys()));
            cleanup({ refresh: true }).catch((error) => {
                console.warn('Clear stale node assets after load failed:', error);
            }).finally(() => {
                updateCacheUsage();
            });
        }, { delayMs: 1000, timeoutMs: 6000 });

        scheduleIdleTask(() => {
            clearOrphanedImageImportAssets(collectActiveImageImportAssetKeys(data)).catch((error) => {
                console.warn('Clear stale image import assets after load failed:', error);
            }).finally(() => {
                updateCacheUsage();
            });
        }, { delayMs: 2500, timeoutMs: 10000 });

        scheduleIdleTask(() => {
            trimHistoryCache().catch((error) => {
                console.warn('Trim stale history cache after load failed:', error);
            }).finally(() => {
                updateCacheUsage();
            });
        }, { delayMs: 3500, timeoutMs: 10000 });
    }

    function normalizeStoredProvider(provider, index) {
        return {
            ...provider,
            id: String(provider?.id || `prov_import_${index + 1}`),
            name: typeof provider?.name === 'string' && provider.name.trim() ? provider.name.trim() : `导入供应商 ${index + 1}`,
            type: normalizeProviderType(provider?.type, provider),
            apikey: typeof provider?.apikey === 'string' ? provider.apikey : '',
            endpoint: typeof provider?.endpoint === 'string' ? provider.endpoint : '',
            autoComplete: provider?.autoComplete !== false
        };
    }

    function getLockedProviders(storedProviders = []) {
        const storedById = new Map((storedProviders || [])
            .map((provider, index) => normalizeStoredProvider(provider, index))
            .map((provider) => [provider.id, provider]));
        const defaultProviderIds = new Set(DEFAULT_PROVIDERS.map((provider) => provider.id));
        const lockedDefaults = DEFAULT_PROVIDERS.map((provider) => {
            const stored = storedById.get(provider.id);
            return {
                ...provider,
                name: stored?.name || provider.name,
                apikey: stored?.apikey || provider.apikey
            };
        });
        const hiddenProviders = Array.from(storedById.values())
            .filter((provider) => !defaultProviderIds.has(provider.id));
        return [...lockedDefaults, ...hiddenProviders];
    }

    function bindModelToAvailableProviders(model, providers) {
        const providerIds = getModelProviderIds(model);
        const fallbackProviderId = providers?.[0]?.id || '';
        const nextProviderIds = providerIds.length > 0
            ? providerIds
            : (fallbackProviderId ? [fallbackProviderId] : []);
        return {
            ...model,
            providerIds: nextProviderIds,
            providerId: nextProviderIds[0] || ''
        };
    }

    function normalizeStoredModels(models = [], providers = []) {
        const providersById = new Map(providers.map((provider) => [provider.id, provider]));
        return models
            .map((model, index) => normalizeModelConfig(model, index, providersById))
            .map((model) => API_PROVIDERS_LOCKED ? bindModelToAvailableProviders(model, providers) : model);
    }

    function exportWorkflow() {
        try {
            const data = nodeSerializer.buildWorkflowExport('1.3');
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = documentRef.createElement('a');
            a.href = url;
            const time = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            a.download = `CainFlow_Project_${time}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('工作流已导出，API 供应商、模型配置与图片原始数据不会写入文件', 'success');
        } catch (e) {
            showToast('导出失败: ' + e.message, 'error');
        }
    }

    function importWorkflow(file) {
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const importedData = migrateLegacyWorkflowData(JSON.parse(event.target.result));
                if (!importedData.nodes || !Array.isArray(importedData.nodes)) {
                    throw new Error('无效的 CainFlow 项目文件格式');
                }

                if (!windowRef.confirm('导入将覆盖当前画布节点和连线，当前 API 供应商与模型配置会保留，确定继续吗？')) {
                    return;
                }

                const currentState = JSON.parse(localStorageRef.getItem(storageKey) || '{}');
                const modelResolution = resolveWorkflowModelReferences(importedData, state);
                const warningMessage = buildWorkflowModelWarningMessage(modelResolution);
                if (warningMessage && !windowRef.confirm(`${warningMessage}\n\n是否继续导入工作流？`)) {
                    return;
                }

                const mergedData = {
                    canvas: importedData.canvas || currentState.canvas || { x: 0, y: 0, zoom: 1 },
                    nodes: modelResolution.nodes || [],
                    connections: importedData.connections || [],
                    providers: state.providers,
                    models: state.models,
                    nodeDefaults: normalizeNodeDefaults(currentState.nodeDefaults || state.nodeDefaults),
                    themeId: currentState.themeId !== undefined
                        ? currentState.themeId
                        : (currentState.themeMode !== undefined ? currentState.themeMode : state.themeId),
                    notificationsEnabled: currentState.notificationsEnabled !== undefined ? currentState.notificationsEnabled : state.notificationsEnabled,
                    notificationVolume: currentState.notificationVolume !== undefined ? currentState.notificationVolume : state.notificationVolume,
                    autoRetry: currentState.autoRetry !== undefined ? currentState.autoRetry : state.autoRetry,
                    maxRetries: currentState.maxRetries !== undefined ? currentState.maxRetries : state.maxRetries,
                    concurrentRequestMode: currentState.concurrentRequestMode !== undefined ? currentState.concurrentRequestMode : state.concurrentRequestMode,
                    imageAutoResizeEnabled: currentState.imageAutoResizeEnabled !== undefined ? currentState.imageAutoResizeEnabled : state.imageAutoResizeEnabled,
                    imageSaveUsePromptFilename: currentState.imageSaveUsePromptFilename !== undefined ? currentState.imageSaveUsePromptFilename : state.imageSaveUsePromptFilename,
                    imageMaxPixels: currentState.imageMaxPixels !== undefined ? currentState.imageMaxPixels : state.imageMaxPixels,
                    connectionLineType: currentState.connectionLineType !== undefined ? currentState.connectionLineType : state.connectionLineType,
                    toolbarPinned: currentState.toolbarPinned !== undefined ? currentState.toolbarPinned : state.toolbarPinned,
                    sidebarPinned: currentState.sidebarPinned !== undefined ? currentState.sidebarPinned : state.sidebarPinned,
                    globalAnimationEnabled: currentState.globalAnimationEnabled !== undefined
                        ? currentState.globalAnimationEnabled
                        : (currentState.connectionFlowAnimationEnabled !== undefined ? currentState.connectionFlowAnimationEnabled : state.globalAnimationEnabled),
                    connectionFlowAnimationEnabled: currentState.globalAnimationEnabled !== undefined
                        ? currentState.globalAnimationEnabled
                        : (currentState.connectionFlowAnimationEnabled !== undefined ? currentState.connectionFlowAnimationEnabled : state.globalAnimationEnabled),
                    proxy: currentState.proxy !== undefined ? currentState.proxy : state.proxy,
                    requestTimeoutEnabled: currentState.requestTimeoutEnabled !== undefined ? currentState.requestTimeoutEnabled : state.requestTimeoutEnabled,
                    requestTimeoutSeconds: currentState.requestTimeoutSeconds !== undefined ? currentState.requestTimeoutSeconds : state.requestTimeoutSeconds,
                    autoCheckUpdatesOnLoad: currentState.autoCheckUpdatesOnLoad !== undefined ? currentState.autoCheckUpdatesOnLoad : state.autoCheckUpdatesOnLoad,
                    historyGridCols: currentState.historyGridCols !== undefined ? currentState.historyGridCols : state.historyGridCols,
                    workflowSidebarWidth: currentState.workflowSidebarWidth !== undefined ? currentState.workflowSidebarWidth : state.workflowSidebarWidth
                };

                localStorageRef.setItem(storageKey, JSON.stringify(mergedData));

                clearUndoStack();
                if (clearImageAssets) {
                    await clearImageAssets({ preserveHistory: true });
                    updateCacheUsage();
                }
                state.connections = [];
                for (const [, node] of state.nodes) {
                    cleanupElementResources(node.el);
                    node.el.remove();
                }
                state.nodes.clear();
                state.selectedNodes.clear();

                const remapText = modelResolution.remappedModels.length > 0
                    ? `，已自动匹配 ${modelResolution.remappedModels.length} 个模型引用`
                    : '';
                showToast(`导入成功，当前 API 设置已保留${remapText}，正在重新加载...`, 'success');
                setTimeout(() => windowRef.location.reload(), 800);
            } catch (err) {
                showToast('导入失败: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
    }

    async function restoreHandles() {
        try {
            const globalHandle = await getHandle('GLOBAL_SAVE_DIR');
            if (!globalHandle) return null;
            state.globalSaveDirHandle = globalHandle;
            return globalHandle;
        } catch (error) {
            console.warn('Restore global save dir handle failed:', error);
            return null;
        }
    }

    async function loadState() {
        try {
            const raw = localStorageRef.getItem(storageKey);
            if (!raw) {
                scheduleStartupCacheCleanup(null);
                return false;
            }
            const data = migrateLegacyWorkflowData(JSON.parse(raw));
                if (data.apiConfigs && Array.isArray(data.apiConfigs)) {
                    const newProviders = [];
                    const newModels = [];
                    data.apiConfigs.forEach((cfg) => {
                        const provId = 'prov_' + Math.random().toString(36).substr(2, 9);
                        newProviders.push({
                            id: provId,
                            name: cfg.name + ' (授权配置)',
                            type: normalizeProviderType(cfg.type, { endpoint: cfg.endpoint }),
                            apikey: cfg.apikey || '',
                            endpoint: cfg.endpoint || ''
                        });
                        newModels.push(normalizeModelConfig({
                            id: cfg.id,
                            name: cfg.name,
                            modelId: cfg.model || '',
                            providerIds: [provId],
                            providerId: provId,
                            protocol: cfg.protocol || cfg.type
                        }, newModels.length, newProviders));
                    });
                    state.providers = API_PROVIDERS_LOCKED ? getLockedProviders(newProviders) : newProviders;
                    state.models = API_PROVIDERS_LOCKED
                        ? normalizeStoredModels(newModels, state.providers)
                        : newModels;
                } else {
                    if (data.providers) {
                        const normalizedProviders = data.providers.map((provider, index) => normalizeStoredProvider(provider, index));
                        state.providers = API_PROVIDERS_LOCKED
                            ? getLockedProviders(normalizedProviders)
                            : normalizedProviders;
                    }
                    if (data.models) {
                        state.models = normalizeStoredModels(data.models, state.providers);
                    }
                }
            state.nodeDefaults = normalizeNodeDefaults(data.nodeDefaults);
            if (data.themeId !== undefined || data.themeMode !== undefined) {
                applyTheme(data.themeId !== undefined ? data.themeId : data.themeMode);
            } else {
                applyTheme(state.themeId);
            }
            if (data.notificationsEnabled !== undefined) {
                state.notificationsEnabled = data.notificationsEnabled;
                const toggle = documentRef.getElementById('toggle-notifications');
                if (toggle) toggle.checked = state.notificationsEnabled;
            }
            if (data.notificationVolume !== undefined) {
                state.notificationVolume = data.notificationVolume;
            }
            if (data.autoRetry !== undefined) {
                state.autoRetry = data.autoRetry;
                const toggle = documentRef.getElementById('toggle-retry');
                if (toggle) toggle.checked = state.autoRetry;
            }
            if (data.maxRetries !== undefined) {
                state.maxRetries = data.maxRetries;
            }
            if (data.concurrentRequestMode !== undefined) {
                state.concurrentRequestMode = !!data.concurrentRequestMode;
            }
            if (data.imageAutoResizeEnabled !== undefined) {
                state.imageAutoResizeEnabled = !!data.imageAutoResizeEnabled;
            }
            if (data.imageSaveUsePromptFilename !== undefined) {
                state.imageSaveUsePromptFilename = data.imageSaveUsePromptFilename === true;
            }
            if (data.imageMaxPixels !== undefined) {
                state.imageMaxPixels = data.imageMaxPixels;
            }
            if (data.connectionLineType !== undefined) {
                state.connectionLineType = data.connectionLineType === 'orthogonal' ? 'orthogonal' : 'bezier';
            }
            if (data.toolbarPinned !== undefined) {
                state.toolbarPinned = data.toolbarPinned === true;
            }
            if (data.sidebarPinned !== undefined) {
                state.sidebarPinned = data.sidebarPinned === true;
            }
            applyCanvasUiSetting();
            if (data.globalAnimationEnabled !== undefined || data.connectionFlowAnimationEnabled !== undefined) {
                state.globalAnimationEnabled = data.globalAnimationEnabled !== undefined
                    ? data.globalAnimationEnabled !== false
                    : data.connectionFlowAnimationEnabled !== false;
                state.connectionFlowAnimationEnabled = state.globalAnimationEnabled;
                applyGlobalAnimationSetting();
            }
            if (data.proxy !== undefined) {
                state.proxy = data.proxy;
            }
            if (data.requestTimeoutEnabled !== undefined) {
                state.requestTimeoutEnabled = !!data.requestTimeoutEnabled;
            }
            if (data.requestTimeoutSeconds !== undefined) {
                const timeoutSeconds = parseInt(data.requestTimeoutSeconds, 10);
                if (!Number.isNaN(timeoutSeconds) && timeoutSeconds >= 1) {
                    state.requestTimeoutSeconds = timeoutSeconds;
                }
            }
            if (data.autoCheckUpdatesOnLoad !== undefined) {
                state.autoCheckUpdatesOnLoad = data.autoCheckUpdatesOnLoad !== false;
            }
            if (data.historyGridCols !== undefined) {
                applyHistoryGridCols(data.historyGridCols);
            }
            state.workflowTabs = Array.isArray(data.workflowTabs)
                ? data.workflowTabs
                    .filter((tab) => tab?.name && tab?.data)
                    .map((tab, index) => ({
                        name: String(tab.name),
                        data: tab.data,
                        dirty: tab.dirty === true,
                        colorIndex: Number.isInteger(tab.colorIndex) ? tab.colorIndex : index,
                        running: false,
                        runResult: tab.runResult === 'success' || tab.runResult === 'error' ? tab.runResult : ''
                    }))
                : [];
            state.activeWorkflowName = typeof data.activeWorkflowName === 'string' ? data.activeWorkflowName : '';
            state.workflowOrder = Array.isArray(data.workflowOrder)
                ? data.workflowOrder.filter((name) => typeof name === 'string' && name)
                : [];
            state.workflowFolders = Array.isArray(data.workflowFolders)
                ? data.workflowFolders
                    .map((folder) => ({
                        id: typeof folder?.id === 'string' ? folder.id : '',
                        name: typeof folder?.name === 'string' ? folder.name : '',
                        collapsed: folder?.collapsed === true,
                        items: Array.isArray(folder?.items) ? folder.items.filter((name) => typeof name === 'string' && name) : []
                    }))
                    .filter((folder) => folder.id && folder.name)
                : [];
            if (data.workflowSidebarWidth !== undefined) {
                const workflowSidebarWidth = Number(data.workflowSidebarWidth);
                if (Number.isFinite(workflowSidebarWidth) && workflowSidebarWidth > 0) {
                    state.workflowSidebarWidth = Math.round(workflowSidebarWidth);
                    applyWorkflowSidebarWidth(state.workflowSidebarWidth);
                }
            }
            if (data.canvas) {
                state.canvas.x = data.canvas.x || 0;
                state.canvas.y = data.canvas.y || 0;
                state.canvas.zoom = data.canvas.zoom || 1;
            }

            await restoreHandles();
            beginMediaRestoreBatch();
            try {
                if (data.nodes?.length) {
                    for (const nd of data.nodes) addNode(nd.type, nd.x, nd.y, nd, true);
                }
                if (data.connections?.length) {
                    for (const conn of data.connections) {
                        if (state.nodes.has(conn.from.nodeId) && state.nodes.has(conn.to.nodeId)) {
                            if (!conn.id) conn.id = 'c_' + Math.random().toString(36).substr(2, 9);
                            state.connections.push(conn);
                        }
                    }
                }
                if (data.connections?.length) {
                    updateAllConnections();
                    updatePortStyles();
                    onConnectionsChanged();
                }
            } finally {
                endMediaRestoreBatch();
            }
            viewportApi.updateCanvasTransform();
            try {
                await finalizeMediaRestoreBatch();
            } catch (error) {
                console.warn('Finalize media restore after session load failed:', error);
            }
            scheduleStartupCacheCleanup(data);
            return data.nodes?.length > 0;
        } catch (e) {
            console.warn('Load failed:', e);
            scheduleStartupCacheCleanup(null);
            return false;
        }
    }

    return {
        exportWorkflow,
        importWorkflow,
        loadState,
        restoreHandles
    };
}
