/**
 * 负责工作流项目的导入导出与恢复加载，是前端项目 IO 的统一入口。
 */
import { normalizeModelConfig, normalizeProviderType } from '../execution/provider-request-utils.js';

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
    applyTheme = () => {}
}) {
    function exportWorkflow() {
        try {
            const data = nodeSerializer.buildWorkflowExport('1.2');
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = documentRef.createElement('a');
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

    function importWorkflow(file) {
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const importedData = JSON.parse(event.target.result);
                if (!importedData.nodes || !Array.isArray(importedData.nodes)) {
                    throw new Error('无效的 CainFlow 项目文件格式');
                }

                if (!windowRef.confirm('导入将覆盖当前所有画布节点、API 及模型配置、连线，确定继续吗？')) {
                    return;
                }

                const currentState = JSON.parse(localStorageRef.getItem(storageKey) || '{}');
                const currentProviders = state.providers;
                const existingProvidersMap = new Map(currentProviders.map((provider) => [provider.id, provider]));

                const mergedProviders = Array.isArray(importedData.providers)
                    ? importedData.providers.map((importedProvider) => {
                        const existingProvider = existingProvidersMap.get(importedProvider.id);
                        if (existingProvider) {
                            return {
                                ...importedProvider,
                                apikey: existingProvider.apikey || importedProvider.apikey || '',
                                endpoint: existingProvider.endpoint || importedProvider.endpoint || ''
                            };
                        }
                        return {
                            ...importedProvider,
                            apikey: importedProvider.apikey || ''
                        };
                    })
                    : currentProviders;

                const mergedData = {
                    canvas: importedData.canvas || currentState.canvas || { x: 0, y: 0, zoom: 1 },
                    nodes: importedData.nodes || [],
                    connections: importedData.connections || [],
                    providers: mergedProviders,
                    models: importedData.models || currentState.models || state.models,
                    themeMode: currentState.themeMode !== undefined ? currentState.themeMode : state.themeMode,
                    notificationsEnabled: currentState.notificationsEnabled !== undefined ? currentState.notificationsEnabled : state.notificationsEnabled,
                    notificationVolume: currentState.notificationVolume !== undefined ? currentState.notificationVolume : state.notificationVolume,
                    autoRetry: currentState.autoRetry !== undefined ? currentState.autoRetry : state.autoRetry,
                    maxRetries: currentState.maxRetries !== undefined ? currentState.maxRetries : state.maxRetries,
                    imageAutoResizeEnabled: currentState.imageAutoResizeEnabled !== undefined ? currentState.imageAutoResizeEnabled : state.imageAutoResizeEnabled,
                    imageMaxPixels: currentState.imageMaxPixels !== undefined ? currentState.imageMaxPixels : state.imageMaxPixels,
                    connectionLineType: currentState.connectionLineType !== undefined ? currentState.connectionLineType : state.connectionLineType,
                    connectionFlowAnimationEnabled: currentState.connectionFlowAnimationEnabled !== undefined ? currentState.connectionFlowAnimationEnabled : state.connectionFlowAnimationEnabled,
                    proxy: currentState.proxy !== undefined ? currentState.proxy : state.proxy,
                    requestTimeoutEnabled: currentState.requestTimeoutEnabled !== undefined ? currentState.requestTimeoutEnabled : state.requestTimeoutEnabled,
                    requestTimeoutSeconds: currentState.requestTimeoutSeconds !== undefined ? currentState.requestTimeoutSeconds : state.requestTimeoutSeconds,
                    historyGridCols: currentState.historyGridCols !== undefined ? currentState.historyGridCols : state.historyGridCols
                };

                localStorageRef.setItem(storageKey, JSON.stringify(mergedData));
                showToast('导入成功，现有 API 密钥、地址和全局设置已保留，正在重新加载...', 'success');
                setTimeout(() => windowRef.location.reload(), 800);
            } catch (err) {
                showToast('导入失败: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
    }

    async function restoreHandles() {
        // We only restore global handle now, which is handled in loadState
    }

    async function loadState() {
        try {
            const raw = localStorageRef.getItem(storageKey);
            if (!raw) return false;
            const data = JSON.parse(raw);
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
                            providerId: provId,
                            protocol: cfg.protocol || cfg.type
                        }, newModels.length, newProviders));
                    });
                    state.providers = newProviders;
                    state.models = newModels;
                } else {
                    if (data.providers) {
                        state.providers = data.providers.map((provider, index) => ({
                            ...provider,
                            id: String(provider?.id || `prov_import_${index + 1}`),
                            name: typeof provider?.name === 'string' && provider.name.trim() ? provider.name.trim() : `导入供应商 ${index + 1}`,
                            type: normalizeProviderType(provider?.type, provider),
                            apikey: typeof provider?.apikey === 'string' ? provider.apikey : '',
                            endpoint: typeof provider?.endpoint === 'string' ? provider.endpoint : '',
                            autoComplete: provider?.autoComplete !== false
                        }));
                    }
                    if (data.models) {
                        const providersById = new Map(state.providers.map((provider) => [provider.id, provider]));
                        state.models = data.models.map((model, index) => normalizeModelConfig(model, index, providersById));
                    }
                }
            if (data.themeMode !== undefined) {
                applyTheme(data.themeMode);
            } else {
                applyTheme(state.themeMode);
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
            if (data.imageAutoResizeEnabled !== undefined) {
                state.imageAutoResizeEnabled = !!data.imageAutoResizeEnabled;
            }
            if (data.imageMaxPixels !== undefined) {
                state.imageMaxPixels = data.imageMaxPixels;
            }
            if (data.connectionLineType !== undefined) {
                state.connectionLineType = data.connectionLineType === 'orthogonal' ? 'orthogonal' : 'bezier';
            }
            if (data.connectionFlowAnimationEnabled !== undefined) {
                state.connectionFlowAnimationEnabled = data.connectionFlowAnimationEnabled !== false;
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
            if (data.historyGridCols !== undefined) {
                applyHistoryGridCols(data.historyGridCols);
            }
            if (data.canvas) {
                state.canvas.x = data.canvas.x || 0;
                state.canvas.y = data.canvas.y || 0;
                state.canvas.zoom = data.canvas.zoom || 1;
            }

            const globalHandle = await getHandle('GLOBAL_SAVE_DIR');
            if (globalHandle) {
                state.globalSaveDirHandle = globalHandle;
                addLog('info', '全局保存目录已恢复', `已恢复目录: ${globalHandle.name}`);
            }

            if (data.nodes?.length) {
                for (const nd of data.nodes) addNode(nd.type, nd.x, nd.y, nd);
                await restoreHandles();
            }
            if (data.connections?.length) {
                for (const conn of data.connections) {
                    if (state.nodes.has(conn.from.nodeId) && state.nodes.has(conn.to.nodeId)) {
                        if (!conn.id) conn.id = 'c_' + Math.random().toString(36).substr(2, 9);
                        state.connections.push(conn);
                    }
                }
                updateAllConnections();
                updatePortStyles();
                onConnectionsChanged();
            }
            viewportApi.updateCanvasTransform();
            return data.nodes?.length > 0;
        } catch (e) {
            console.warn('Load failed:', e);
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
