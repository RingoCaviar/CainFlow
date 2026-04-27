/**
 * CainFlow 前端总装配入口，负责组合全局状态、核心服务、画布、节点、执行链路与各类 UI 控制器。
 */
import {
    APP_VERSION,
    DB_NAME,
    GITHUB_REPO,
    STORAGE_KEY,
    STORE_ASSETS,
    STORE_HANDLES,
    STORE_HISTORY
} from './js/core/constants.js';
import { generateId as generateIdService, debounce as debounceService } from './js/core/common-utils.js';
import { createElements } from './js/core/elements.js';
import { createInitialState } from './js/core/state.js';
import {
    classifyProviderError as classifyProviderErrorService,
    createProxyHeadersGetter,
    formatProxyErrorMessage as formatProxyErrorMessageService,
    getAbortMessage as getAbortMessageService,
    sanitizeDetails as sanitizeDetailsService,
    sanitizeRequestPayload as sanitizeRequestPayloadService,
    sanitizeRequestUrl as sanitizeRequestUrlService
} from './js/services/api-client.js';
import { createIndexedDbApi } from './js/services/storage-idb.js';
import {
    createBezierPath as createBezierPathService,
    checkLineIntersection as checkLineIntersectionService,
    getConnectionSamplePoints as getConnectionSamplePointsService
} from './js/canvas/geometry.js';
import { createConnectionsApi } from './js/canvas/connections.js';
import { createSelectionApi } from './js/canvas/selection.js';
import { createViewportApi } from './js/canvas/viewport.js';
import { createCanvasInteractionsApi } from './js/canvas/canvas-interactions.js';
import { createNodeAutoLayoutApi } from './js/canvas/node-auto-layout.js';
import { NODE_CONFIGS } from './js/nodes/registry.js';
import { createNodeSerializer } from './js/nodes/node-serializer.js';
import { createNodeMarkup } from './js/nodes/node-view-factory.js';
import { createNodeDomBindingsApi } from './js/nodes/node-dom-bindings.js';
import { createNodeLifecycleApi } from './js/nodes/node-lifecycle.js';
import { createHistoryPanelApi } from './js/features/history/history-panel.js';
import { createHistoryPreviewApi } from './js/features/history/history-preview.js';
import { createMediaControllerApi } from './js/features/media/media-controller.js';
import { createImagePainterApi } from './js/features/media/image-painter.js';
import { createMediaUtils } from './js/features/media/media-utils.js';
import { createExecutionCoreApi } from './js/features/execution/execution-core.js';
import { createWorkflowRunnerApi } from './js/features/execution/workflow-runner.js';
import { createSessionManagerApi } from './js/features/persistence/session-manager.js';
import { createProjectIoApi } from './js/features/persistence/project-io.js';
import { createPanelManager } from './js/features/ui/panel-manager.js';
import { createUiUtils } from './js/features/ui/ui-utils.js';
import { createUiControllerApi } from './js/features/ui/ui-controller.js';
import { createClipboardControllerApi } from './js/features/ui/clipboard-controller.js';
import { createGlobalInteractionsApi } from './js/features/ui/global-interactions.js';
import { createContextMenuControllerApi } from './js/features/ui/context-menu-controller.js';
import { createErrorModalControllerApi } from './js/features/ui/error-modal-controller.js';
import { createRuntimeControllerApi } from './js/features/ui/runtime-controller.js';
import { createThemeControllerApi } from './js/features/ui/theme-controller.js';
import { applyGlobalAnimationSetting as applyGlobalAnimationSettingService } from './js/features/ui/animation-controller.js';
import { createToolbarControllerApi } from './js/features/ui/toolbar-controller.js';
import { createToastControllerApi } from './js/features/ui/toast-controller.js';
import { createLogPanelApi } from './js/features/logs/log-panel.js';
import { createStartupControllerApi } from './js/features/app/startup-controller.js';
import { createSettingsModalApi } from './js/features/settings/settings-modal.js';
import { createSettingsControllerApi } from './js/features/settings/settings-controller.js';
import { createUpdateManager } from './js/features/update/update-manager.js';
import { createHelpPanelApi } from './js/features/help/help-panel.js';
import { createWorkflowManagerApi } from './js/features/workflow/workflow-manager.js';

/**
 * index.js 是 CainFlow 前端的总装配入口。
 * 它负责初始化全局状态、缓存核心 DOM、装配画布/节点/连线/执行/持久化/UI 等功能模块，
 * 并承担少量兼容性桥接逻辑，使整个节点式工作流编辑与运行界面可以协同工作。
 *
 * CainFlow - 基于节点的 AI 图像生成工具
 * 包含画布、节点、连线、执行引擎与 localStorage 持久化
 */

// ===== 工具函数 =====
function generateId() {
    return generateIdService();
}

function showToast(message, type = 'info', duration = 3000) {
    return getToastControllerApi().showToast(message, type, duration);
}

function debounce(fn, ms) {
    return debounceService(fn, ms);
}

function getProxyHeaders(url, method = 'POST', extraHeaders = {}) {
    return proxyHeadersGetter(url, method, extraHeaders);
}

function adjustTextareaHeight(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    const height = textarea.scrollHeight;
    textarea.style.height = (height + 2) + 'px';

    // 如果 textarea 位于节点内部，节点高度可能已经变化，
    // 需要同步刷新连线位置。
    if (typeof updateAllConnections === 'function') {
        updateAllConnections();
    }
}

// 从 data URL 读取分辨率文本
function getImageResolution(dataUrl) {
    return mediaUtils.getImageResolution(dataUrl);
}

/**
 * 当图片总像素超过 maxTotalPixels 时自动缩放
 * 并保持原始宽高比。
 */
function processImageResolution(dataUrl, maxTotalPixels = null) {
    return mediaUtils.processImageResolution(dataUrl, maxTotalPixels);
}

function resizeImageData(dataUrl, options = {}) {
    return mediaUtils.resizeImageData(dataUrl, options);
}

function detectOutputFormat(dataUrl) {
    return mediaUtils.detectOutputFormat(dataUrl);
}

function estimateDataUrlSize(dataUrl) {
    return mediaUtils.estimateDataUrlSize(dataUrl);
}

// 正确地将 dataURL 转换为 Blob
function dataURLtoBlob(dataUrl) {
    return mediaUtils.dataURLtoBlob(dataUrl);
}

function blobToDataUrl(blob) {
    return mediaUtils.blobToDataUrl(blob);
}

function logRequestToPanel(title, url, requestBody, extra = {}) {
    getLogPanelApi().logRequestToPanel(title, url, requestBody, extra);
}

function addLog(type, title, message, details = null) {
    getLogPanelApi().addLog(type, title, message, details);
}

function renderLogs() {
    getLogPanelApi().renderLogs();
}

function showLogDetail(id) {
    getLogPanelApi().showLogDetail(id);
}

function showErrorModal(title, msg, detail, modalTitle = '执行错误', log = null) {
    return getErrorModalControllerApi().showErrorModal(title, msg, detail, modalTitle, log);
}

function closeModal(id) {
    return getErrorModalControllerApi().closeModal(id);
}

window.closeModal = closeModal;
window.showLogDetail = showLogDetail;

const uiUtils = createUiUtils({
    showToast
});

function applyHistoryGridCols(cols) {
    getHistoryPanelApi().applyHistoryGridCols(cols);
}

function applyGlobalAnimationSetting() {
    return applyGlobalAnimationSettingService({ state, documentRef: document });
}

async function renderHistoryList() {
    await getHistoryPanelApi().renderHistoryList();
}

// 集中缓存常用 DOM 元素
const elements = createElements(document);

const { canvasContainer, nodesLayer, connectionsGroup, tempConnection, originAxes, contextMenu } = elements;
const panelManager = createPanelManager(document);

// ===== 应用状态 =====
const state = createInitialState();
applyGlobalAnimationSettingService({ state, documentRef: document });

// Save 节点使用的目录句柄（不可序列化）
const dirHandles = new Map();

const proxyHeadersGetter = createProxyHeadersGetter(() => state);
const indexedDbApi = createIndexedDbApi(() => state);
const { openDB, saveHandle, getHandle, saveImageAsset, getImageAsset, deleteImageAsset, createThumbnail, saveHistoryEntry, getHistory, clearHistory, deleteHistoryEntry } = indexedDbApi;
const mediaUtils = createMediaUtils({
    getImageMaxPixels: () => state.imageMaxPixels,
    documentRef: document
});
const viewportApi = createViewportApi({ state, elements, updateAllConnections: () => updateAllConnections() });
const selectionApi = createSelectionApi({ state, updateAllConnections: () => updateAllConnections() });
const nodeSerializer = createNodeSerializer({
    state,
    documentRef: document,
    getSafeProviders: () => getSafeProviders()
});
let logPanelApi = null;
let historyPanelApi = null;
let settingsControllerApi = null;
let historyPreviewApi = null;
let sessionManagerApi = null;
let projectIoApi = null;
let executionCoreApi = null;
let workflowRunnerApi = null;
let uiControllerApi = null;
let clipboardControllerApi = null;
let globalInteractionsApi = null;
let toolbarControllerApi = null;
let canvasInteractionsApi = null;
let nodeAutoLayoutApi = null;
let nodeLifecycleApi = null;
let contextMenuControllerApi = null;
let runtimeControllerApi = null;
let startupControllerApi = null;
let errorModalControllerApi = null;
let toastControllerApi = null;
let themeControllerApi = null;

function getLogPanelApi() {
    if (!logPanelApi) {
        logPanelApi = createLogPanelApi({
            state,
            elements,
            renderErrorModal: showErrorModal
        });
    }
    return logPanelApi;
}

function getHistoryPanelApi() {
    if (!historyPanelApi) {
        historyPanelApi = createHistoryPanelApi({
            state,
            getHistory,
            createThumbnail,
            openDB,
            openHistoryPreview: (item) => historyPreviewApi.openHistoryPreview(item),
            deleteHistoryEntry,
            storeHistoryName: STORE_HISTORY
        });
    }
    return historyPanelApi;
}

const updateManager = createUpdateManager({
    appVersion: APP_VERSION,
    githubRepo: GITHUB_REPO,
    getProxyHeaders,
    showToast,
    renderGeneralSettings: () => settingsControllerApi?.renderGeneralSettings(),
    exportWorkflow: () => exportWorkflow()
});
const helpPanelApi = createHelpPanelApi({
    canvasContainer,
    nodesLayer
});
const settingsModal = document.getElementById('settings-modal');
const providersList = document.getElementById('providers-list');
const modelsList = document.getElementById('models-list');
const settingsModalApi = createSettingsModalApi({
    settingsModal,
    onOpen: () => {
        settingsControllerApi.collapseAllConfigCards();
        settingsControllerApi.renderProviders();
        settingsControllerApi.renderModels();
        settingsControllerApi.renderGeneralSettings();
        settingsControllerApi.initProxyPanel();
    }
});
const mediaControllerApi = createMediaControllerApi({
    state,
    getNodeById: (nodeId) => state.nodes.get(nodeId),
    saveImageAsset,
    deleteImageAsset,
    processImageResolution,
    resizeImageData,
    detectOutputFormat,
    estimateDataUrlSize,
    getImageResolution,
    dataURLtoBlob,
    showToast,
    addLog,
    scheduleSave,
    openImagePainter,
    fitNodeToContent
});
const connectionsApi = createConnectionsApi({
    state,
    canvasContainer,
    connectionsGroup,
    tempConnection,
    originAxes,
    getNodeById: (nodeId) => state.nodes.get(nodeId),
    createBezierPath: createBezierPathService,
    pushHistory: () => pushHistory(),
    showToast,
    scheduleSave,
    onConnectionsChanged: () => refreshAllImageResizePreviews()
});
const {
    showResolutionBadge,
    setupImageImport,
    loadImageFile,
    loadImageData,
    setupImageResize,
    getResizeSourceImage,
    refreshImageResizePreview,
    refreshDependentImageResizePreviews,
    refreshAllImageResizePreviews,
    restoreImageResizePreview,
    setupImageSave,
    autoSaveToDir,
    setupImagePreview,
    setupImageCompare,
    syncImageCompareNode,
    adjustPreviewZoom,
    openFullscreenPreview
} = mediaControllerApi;

const imagePainterApi = createImagePainterApi({
    state,
    dirHandles,
    autoSaveToDir,
    scheduleSave,
    showToast
});
const nodeDomBindingsApi = createNodeDomBindingsApi({
    state,
    canvasContainer,
    connectionsGroup,
    tempConnection,
    viewportApi,
    getPortPosition: (nodeId, portName, direction) => getPortPosition(nodeId, portName, direction),
    pushHistory,
    removeNode: (nodeId) => removeNode(nodeId),
    selectNode: (nodeId, isMulti) => selectNode(nodeId, isMulti),
    toggleNodesEnabled: (nodeIds, referenceNodeId) => toggleNodesEnabled(nodeIds, referenceNodeId),
    finishConnection: (src, tgt) => finishConnection(src, tgt),
    setupImageImport,
    setupImageResize,
    setupImageSave,
    setupImagePreview,
    setupImageCompare,
    copyToClipboard,
    showToast,
    scheduleSave,
    debounce,
    adjustTextareaHeight,
    fitNodeToContent
});
const {
    getPortPosition,
    updateAllConnections,
    updateDraggingConnections,
    finishConnection,
    drawTempConnection,
    updatePortStyles
} = connectionsApi;

// ===== 平移、选择与焦点管理 =====
getCanvasInteractionsApi().initCanvasInteractions();

getContextMenuControllerApi().initContextMenu();

// ===== 节点配置 =====
/**
 * 自动调整节点高度，使内部内容完整显示且不发生重叠。
 * 当错误信息、AI 回复等动态内容加入节点时会调用此函数。
 */
function fitNodeToContent(nodeId, options) {
    return getNodeLifecycleApi().fitNodeToContent(nodeId, options);
}

// ===== 节点创建 =====
function addNode(type, x, y, restoreData, silent = false) {
    return getNodeLifecycleApi().addNode(type, x, y, restoreData, silent);
}

function removeNode(id) {
    return getNodeLifecycleApi().removeNode(id);
}

function selectNode(id, isMulti) {
    return getNodeLifecycleApi().selectNode(id, isMulti);
}

function toggleNodesEnabled(nodeIds, referenceNodeId = null) {
    return getNodeLifecycleApi().toggleNodesEnabled(nodeIds, referenceNodeId);
}

function autoArrangeNodes() {
    return getNodeAutoLayoutApi().autoArrangeNodes();
}

// ===== 图片绘制编辑器 =====
function openImagePainter(src, nodeId) {
    return imagePainterApi.openImagePainter(src, nodeId);
}

// ===== 执行引擎 =====
function topologicalSort(runInput = null) {
    return getExecutionCoreApi().topologicalSort(runInput);
}

async function runWorkflow(runInput = null) {
    return getWorkflowRunnerApi().runWorkflow(runInput);
}

// ===== 持久化 =====
function scheduleSave() {
    return getSessionManagerApi().scheduleSave();
}

function saveState() {
    return getSessionManagerApi().saveState();
}

// ===== 撤销系统 =====
function pushHistory() {
    return getSessionManagerApi().pushHistory();
}

function updateUndoButton() {
    return getSessionManagerApi().updateUndoButton();
}

async function undo() {
    return getSessionManagerApi().undo();
}

function getSafeProviders() {
    // 返回已去除 apikey 的 providers 副本，用于安全导出
    return state.providers.map(p => {
        const { apikey, ...rest } = p;
        return { ...rest, apikey: '' };
    });
}

function getSessionManagerApi() {
    if (!sessionManagerApi) {
        sessionManagerApi = createSessionManagerApi({
            state,
            storageKey: STORAGE_KEY,
            nodeSerializer,
            showToast,
            addNode,
            updateAllConnections,
            updatePortStyles,
            onConnectionsChanged: () => refreshAllImageResizePreviews()
        });
    }
    return sessionManagerApi;
}

function getProjectIoApi() {
    if (!projectIoApi) {
        projectIoApi = createProjectIoApi({
            state,
            storageKey: STORAGE_KEY,
            nodeSerializer,
            getHandle,
            addLog,
            addNode,
            applyHistoryGridCols,
            updateAllConnections,
            updatePortStyles,
            onConnectionsChanged: () => refreshAllImageResizePreviews(),
            viewportApi,
            showToast,
            applyTheme: (mode) => getThemeControllerApi().applyTheme(mode),
            applyGlobalAnimationSetting
        });
    }
    return projectIoApi;
}

function getUiControllerApi() {
    if (!uiControllerApi) {
        uiControllerApi = createUiControllerApi({
            state,
            panelManager,
            settingsModal,
            dbName: DB_NAME,
            openDB,
            storeHistoryName: STORE_HISTORY,
            storeAssetsName: STORE_ASSETS,
            clearHistory,
            getHistory,
            renderHistoryList,
            renderLogs,
            historyPreviewApi,
            settingsControllerApi,
            applyHistoryGridCols,
            applyTheme: (mode) => getThemeControllerApi().applyTheme(mode),
            applyGlobalAnimationSetting,
            updateAllConnections,
            saveState,
            showToast,
            copyToClipboard,
            downloadImage,
            initFeatureModules
        });
    }
    return uiControllerApi;
}

function getClipboardControllerApi() {
    if (!clipboardControllerApi) {
        clipboardControllerApi = createClipboardControllerApi({
            state,
            showToast,
            addNode,
            updateAllConnections,
            updatePortStyles,
            onConnectionsChanged: () => refreshAllImageResizePreviews(),
            scheduleSave
        });
    }
    return clipboardControllerApi;
}

function getGlobalInteractionsApi() {
    if (!globalInteractionsApi) {
        globalInteractionsApi = createGlobalInteractionsApi({
            state,
            settingsModal,
            canvasContainer,
            viewportApi,
            loadImageFile,
            loadImageData,
            addNode,
            pasteNode,
            toggleNodesEnabled,
            showToast,
            scheduleSave
        });
    }
    return globalInteractionsApi;
}

function getCanvasInteractionsApi() {
    if (!canvasInteractionsApi) {
        canvasInteractionsApi = createCanvasInteractionsApi({
            state,
            canvasContainer,
            nodesLayer,
            tempConnection,
            viewportApi,
            getPortPosition,
            drawTempConnection,
            updateAllConnections,
            updateDraggingConnections,
            updatePortStyles,
            onConnectionsChanged: () => refreshAllImageResizePreviews(),
            scheduleSave,
            serializeOneNode,
            addNode,
            checkLineIntersection: checkLineIntersectionService,
            getConnectionSamplePoints: getConnectionSamplePointsService
        });
    }
    return canvasInteractionsApi;
}

function getToolbarControllerApi() {
    if (!toolbarControllerApi) {
        toolbarControllerApi = createToolbarControllerApi({
            state,
            canvasContainer,
            viewportApi,
            runWorkflow,
            saveState,
            undo,
            exportWorkflow,
            importWorkflow,
            showToast,
            scheduleSave,
            updateAllConnections,
            autoArrangeNodes,
            zoomToFitTarget: () => zoomToFit()
        });
    }
    return toolbarControllerApi;
}

function getNodeAutoLayoutApi() {
    if (!nodeAutoLayoutApi) {
        nodeAutoLayoutApi = createNodeAutoLayoutApi({
            state,
            pushHistory,
            updateAllConnections,
            scheduleSave,
            showToast
        });
    }
    return nodeAutoLayoutApi;
}

function getContextMenuControllerApi() {
    if (!contextMenuControllerApi) {
        contextMenuControllerApi = createContextMenuControllerApi({
            state,
            canvasContainer,
            contextMenu,
            viewportApi,
            addNode,
            runWorkflow,
            updateAllConnections
        });
    }
    return contextMenuControllerApi;
}

function getErrorModalControllerApi() {
    if (!errorModalControllerApi) {
        errorModalControllerApi = createErrorModalControllerApi({
            documentRef: document
        });
    }
    return errorModalControllerApi;
}

function getToastControllerApi() {
    if (!toastControllerApi) {
        toastControllerApi = createToastControllerApi({
            container: elements.toastContainer,
            documentRef: document
        });
    }
    return toastControllerApi;
}

function getThemeControllerApi() {
    if (!themeControllerApi) {
        themeControllerApi = createThemeControllerApi({
            state,
            documentRef: document,
            saveState
        });
    }
    return themeControllerApi;
}

function getNodeLifecycleApi() {
    if (!nodeLifecycleApi) {
        nodeLifecycleApi = createNodeLifecycleApi({
            state,
            nodeConfigs: NODE_CONFIGS,
            createNodeMarkup,
            nodesLayer,
            generateId,
            getImageAsset,
            saveImageAsset,
            deleteImageAsset,
            showResolutionBadge,
            restoreImageResizePreview,
            bindNodeInteractions: ({ id, type, el }) => nodeDomBindingsApi.bindNodeInteractions({ id, type, el }),
            pushHistory,
            scheduleSave,
            showToast,
            updateAllConnections,
            updatePortStyles,
            onConnectionsChanged: () => refreshAllImageResizePreviews(),
            getCacheSidebarActive: () => document.getElementById('cache-sidebar')?.classList.contains('active'),
            updateCacheUsage: () => settingsControllerApi?.updateCacheUsage()
        });
    }
    return nodeLifecycleApi;
}

function getRuntimeControllerApi() {
    if (!runtimeControllerApi) {
        runtimeControllerApi = createRuntimeControllerApi({
            state,
            canvasContainer,
            contextMenu,
            selectionApi,
            runWorkflow,
            saveState,
            showToast,
            exportWorkflow,
            undo,
            copySelectedNode,
            removeNode,
            zoomToFit,
            scheduleSave,
            closeModal
        });
    }
    return runtimeControllerApi;
}

function getStartupControllerApi() {
    if (!startupControllerApi) {
        startupControllerApi = createStartupControllerApi({
            state,
            initUI,
            loadState,
            showToast,
            syncProxyToServer: () => settingsControllerApi.syncProxyToServer(),
            loadDefaultWorkflow: () => workflowManagerApi.loadWorkflowFromFile('Default'),
            applyDefaultWorkflow: (defaultData) => workflowManagerApi.applyWorkflowData(defaultData),
            updateCanvasTransform: () => viewportApi.updateCanvasTransform(),
            checkUpdate: () => updateManager.checkUpdate(false, { force: true, showModal: false, showCanvasNotification: true }),
            checkRefreshNotice: () => updateManager.checkRefreshNotice()
        });
    }
    return startupControllerApi;
}

function getExecutionCoreApi() {
    if (!executionCoreApi) {
        executionCoreApi = createExecutionCoreApi({
            state,
            nodeConfigs: NODE_CONFIGS,
            showToast,
            addLog,
            getProxyHeaders,
            classifyProviderError: classifyProviderErrorService,
            logRequestToPanel,
            formatProxyErrorMessage: formatProxyErrorMessageService,
            saveHistoryEntry,
            renderHistoryList,
            showResolutionBadge,
            saveImageAsset,
            deleteImageAsset,
            dataURLtoBlob,
            blobToDataUrl,
            resizeImageData,
            autoSaveToDir,
            restoreImageResizePreview,
            refreshDependentImageResizePreviews,
            syncImageCompareNode,
            fitNodeToContent,
            getAbortMessage: getAbortMessageService,
            updateAllConnections,
            getImageHistorySidebarActive: () => document.getElementById('history-sidebar')?.classList.contains('active')
        });
    }
    return executionCoreApi;
}

function getWorkflowRunnerApi() {
    if (!workflowRunnerApi) {
        workflowRunnerApi = createWorkflowRunnerApi({
            state,
            nodeConfigs: NODE_CONFIGS,
            resolveExecutionPlan: (runInput) => getExecutionCoreApi().resolveExecutionPlan(runInput),
            normalizeRunOptions: (runInput) => getExecutionCoreApi().normalizeRunOptions(runInput),
            getCachedOutputValue: (node, portName) => getExecutionCoreApi().getCachedOutputValue(node, portName),
            executeNode: (node, inputs, signal) => getExecutionCoreApi().executeNode(node, inputs, signal),
            addNode,
            generateId,
            showToast,
            addLog,
            scheduleSave,
            updateAllConnections,
            updatePortStyles,
            getAbortMessage: getAbortMessageService,
            playNotificationSound: () => settingsControllerApi.playNotificationSound()
        });
    }
    return workflowRunnerApi;
}

function exportWorkflow() {
    return getProjectIoApi().exportWorkflow();
}

function importWorkflow(file) {
    return getProjectIoApi().importWorkflow(file);
}

async function loadState() {
    return getProjectIoApi().loadState();
}

// ===== 主题 =====
getThemeControllerApi().initTheme();

// ===== 工具栏 =====
getToolbarControllerApi().initToolbarControls();

function zoomToFit(targetNodes = null) {
    return getToolbarControllerApi().zoomToFit(targetNodes);
}

// ===== 节点复制 / 克隆 =====
function serializeOneNode(nodeId) {
    return getClipboardControllerApi().serializeOneNode(nodeId);
}

function copySelectedNode() {
    return getClipboardControllerApi().copySelectedNode();
}

function pasteNode() {
    return getClipboardControllerApi().pasteNode();
}

// ===== 快捷键 =====
// ===== 日志抽屉 =====

const workflowManagerApi = createWorkflowManagerApi({
    state,
    nodeSerializer,
    viewportApi,
    addNode,
    updateAllConnections,
    updatePortStyles,
    onConnectionsChanged: () => refreshAllImageResizePreviews(),
    scheduleSave,
    showToast,
    panelManager
});
settingsControllerApi = createSettingsControllerApi({
    appVersion: APP_VERSION,
    githubRepo: GITHUB_REPO,
    state,
    settingsModal,
    providersList,
    modelsList,
    storeHistoryName: STORE_HISTORY,
    storeAssetsName: STORE_ASSETS,
    openDB,
    saveHandle,
    showToast,
    saveState,
    addLog,
    checkUpdate: (isManual) => updateManager.checkUpdate(isManual),
    updateAllConnections,
    applyGlobalAnimationSetting,
    fitNodeToContent
});
historyPreviewApi = createHistoryPreviewApi({
    getHistory,
    deleteHistoryEntry,
    openDB,
    storeHistoryName: STORE_HISTORY,
    getImageResolution,
    downloadImage,
    copyToClipboard,
    renderHistoryList: () => renderHistoryList(),
    showToast
});

function initFeatureModules() {
    settingsControllerApi.initSettingsUI({ settingsModalApi });
    historyPreviewApi.initHistoryPreview();
    helpPanelApi.initHelpPanel();
    updateManager.initRefreshNotice();
    workflowManagerApi.initWorkflow();
    initCache();
}

function initUI() {
    return getUiControllerApi().initUI();
}

function initCache() {
    return getUiControllerApi().initCache();
}

// ===== 通用工具 =====
function downloadImage(dataUrl, filename) {
    return uiUtils.downloadImage(dataUrl, filename);
}

function copyToClipboard(text) {
    return uiUtils.copyToClipboard(text);
}

getGlobalInteractionsApi().initGlobalInteractions();
getRuntimeControllerApi().initRuntimeBindings();
getStartupControllerApi().initStartup();
