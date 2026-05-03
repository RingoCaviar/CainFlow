/**
 * 负责工作流项目的导入导出与恢复加载，是前端项目 IO 的统一入口。
 */
import { normalizeModelConfig, normalizeProviderType } from '../execution/provider-request-utils.js';
import { normalizeNodeDefaults } from '../../core/state.js';
import {
    buildWorkflowModelWarningMessage,
    resolveWorkflowModelReferences
} from './workflow-model-resolver.js';

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
    applyGlobalAnimationSetting = () => {}
}) {
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
            showToast('工作流已导出，API 供应商与模型配置不会写入文件', 'success');
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
                    themeMode: currentState.themeMode !== undefined ? currentState.themeMode : state.themeMode,
                    notificationsEnabled: currentState.notificationsEnabled !== undefined ? currentState.notificationsEnabled : state.notificationsEnabled,
                    notificationVolume: currentState.notificationVolume !== undefined ? currentState.notificationVolume : state.notificationVolume,
                    autoRetry: currentState.autoRetry !== undefined ? currentState.autoRetry : state.autoRetry,
                    maxRetries: currentState.maxRetries !== undefined ? currentState.maxRetries : state.maxRetries,
                    imageAutoResizeEnabled: currentState.imageAutoResizeEnabled !== undefined ? currentState.imageAutoResizeEnabled : state.imageAutoResizeEnabled,
                    imageMaxPixels: currentState.imageMaxPixels !== undefined ? currentState.imageMaxPixels : state.imageMaxPixels,
                    connectionLineType: currentState.connectionLineType !== undefined ? currentState.connectionLineType : state.connectionLineType,
                    globalAnimationEnabled: currentState.globalAnimationEnabled !== undefined
                        ? currentState.globalAnimationEnabled
                        : (currentState.connectionFlowAnimationEnabled !== undefined ? currentState.connectionFlowAnimationEnabled : state.globalAnimationEnabled),
                    connectionFlowAnimationEnabled: currentState.globalAnimationEnabled !== undefined
                        ? currentState.globalAnimationEnabled
                        : (currentState.connectionFlowAnimationEnabled !== undefined ? currentState.connectionFlowAnimationEnabled : state.globalAnimationEnabled),
                    proxy: currentState.proxy !== undefined ? currentState.proxy : state.proxy,
                    requestTimeoutEnabled: currentState.requestTimeoutEnabled !== undefined ? currentState.requestTimeoutEnabled : state.requestTimeoutEnabled,
                    requestTimeoutSeconds: currentState.requestTimeoutSeconds !== undefined ? currentState.requestTimeoutSeconds : state.requestTimeoutSeconds,
                    historyGridCols: currentState.historyGridCols !== undefined ? currentState.historyGridCols : state.historyGridCols
                };

                localStorageRef.setItem(storageKey, JSON.stringify(mergedData));
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
                            providerIds: [provId],
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
            state.nodeDefaults = normalizeNodeDefaults(data.nodeDefaults);
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
