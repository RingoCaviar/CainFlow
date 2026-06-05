/**
 * CainFlow 前端总装配入口，负责组合全局状态、核心服务、画布、节点、执行链路与各类 UI 控制器。
 */
import {
    APP_VERSION,
    AUTO_UPDATE_CHECK_DISABLED,
    DB_NAME,
    GITHUB_REPO,
    LOG_STORAGE_KEY,
    STORAGE_KEY,
    STORE_ASSETS,
    STORE_HANDLES,
    STORE_HISTORY
} from './js/core/constants.js';
import {
    cleanupElementResources,
    generateId as generateIdService,
    debounce as debounceService
} from './js/core/common-utils.js';
import { createElements } from './js/core/elements.js';
import { createInitialState } from './js/core/state.js';
import {
    classifyProviderError as classifyProviderErrorService,
    createProxyHeadersGetter,
    formatProxyErrorMessage as formatProxyErrorMessageService,
    getProxyRequestInfo,
    getAbortMessage as getAbortMessageService
} from './js/services/api-client.js';
import { createSystemNotificationService } from './js/services/system-notification-service.js';
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
import { createHistoryFullscreenApi } from './js/features/history/history-fullscreen.js';
import { createMediaControllerApi } from './js/features/media/media-controller.js';
import { createImagePainterApi } from './js/features/media/image-painter.js';
import { createMediaUtils } from './js/features/media/media-utils.js';
import { createCameraControlNodeApi } from './js/features/camera/camera-control-node-proxy.js';
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
import { applyCanvasUiSetting as applyCanvasUiSettingService } from './js/features/ui/canvas-ui-controller.js';
import { createToolbarControllerApi } from './js/features/ui/toolbar-controller.js';
import { createToastControllerApi } from './js/features/ui/toast-controller.js';
import { createFloatingNoticesController } from './js/features/ui/floating-notices-controller.js';
import { createLogPanelApi } from './js/features/logs/log-panel.js';
import { createRequestStatisticsApi } from './js/features/statistics/request-statistics.js';
import { createStartupControllerApi } from './js/features/app/startup-controller.js';
import { createSettingsModalApi } from './js/features/settings/settings-modal.js';
import { createSettingsControllerApi } from './js/features/settings/settings-controller.js';
import { createUpdateManager } from './js/features/update/update-manager.js';
import { createHelpPanelApi } from './js/features/help/help-panel.js';
import { createWorkflowManagerApi } from './js/features/workflow/workflow-manager.js';
import { createWorkflowRuntimeManager } from './js/features/workflow/workflow-runtime-manager.js';
import { createPromptLibraryApi } from './js/features/prompts/prompt-library.js';

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
    getLogPanelApi().logRequestToPanel(title, url, requestBody, {
        proxy: getProxyRequestInfo(state),
        ...extra
    });
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

function applyCanvasUiSetting() {
    return applyCanvasUiSettingService({ state, documentRef: document });
}

async function renderHistoryList() {
    await getHistoryPanelApi().renderHistoryList();
    if (historyFullscreenApi?.isOpen()) {
        await historyFullscreenApi.refresh();
    }
}

// 集中缓存常用 DOM 元素
const elements = createElements(document);

const { canvasContainer, nodesLayer, connectionsGroup, tempConnection, originAxes, contextMenu } = elements;
const connectionCreatePopup = elements.connectionCreatePopup;
const panelManager = createPanelManager(document, canvasContainer);

// ===== 应用状态 =====
const state = createInitialState();
state.abortAllWorkflowRuns = (reason) => getWorkflowRuntimeManagerApi().abortAllWorkflowRuns(reason);
applyGlobalAnimationSettingService({ state, documentRef: document });
applyCanvasUiSettingService({ state, documentRef: document });

// Save 节点使用的目录句柄（不可序列化）
const dirHandles = new Map();

const proxyHeadersGetter = createProxyHeadersGetter(() => state);
const indexedDbApi = createIndexedDbApi(() => state);
const {
    openDB,
    saveHandle,
    getHandle,
    deleteHandle,
    saveImageAsset,
    getImageAsset,
    saveImageAssetList,
    getImageAssetList,
    saveImageImportAsset,
    deleteImageAsset,
    deleteImageImportAsset,
    clearImageImportAssets,
    clearImageAssets,
    clearOrphanedNodeAssets,
    clearOrphanedImageImportAssets,
    createThumbnail,
    saveHistoryEntry,
    getHistory,
    getHistoryMetadata,
    getHistoryCount,
    getHistoryEntry,
    getHistoryImageBlob,
    updateHistoryThumb,
    clearHistory,
    clearOrphanedHistoryAssets,
    trimHistoryCache,
    deleteHistoryEntry
} = indexedDbApi;
const mediaUtils = createMediaUtils({
    getImageMaxPixels: () => state.imageMaxPixels,
    documentRef: document
});
const cameraControlNodeApi = createCameraControlNodeApi({
    state,
    fitNodeToContent: (nodeId) => fitNodeToContent(nodeId),
    scheduleSave: () => scheduleSave(),
    showToast,
    documentRef: document
});
const viewportApi = createViewportApi({ state, elements, updateAllConnections: () => updateAllConnections() });
const selectionApi = createSelectionApi({ state, updateAllConnections: () => updateAllConnections() });
const nodeSerializer = createNodeSerializer({
    state,
    documentRef: document
});
let logPanelApi = null;
let requestStatisticsApi = null;
let historyPanelApi = null;
let settingsControllerApi = null;
let historyPreviewApi = null;
let historyFullscreenApi = null;
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
let floatingNoticesApi = null;
let systemNotificationApi = null;
let themeControllerApi = null;
let promptLibraryApi = null;
let workflowRuntimeManagerApi = null;

function refreshAllCameraControlPreviews() {
    cameraControlNodeApi.refreshAllCameraControlPreviews();
}

function beginMediaRestoreBatch() {
    state.mediaRestoreBatchDepth = Math.max(0, parseInt(state.mediaRestoreBatchDepth || '0', 10) || 0) + 1;
}

function endMediaRestoreBatch() {
    state.mediaRestoreBatchDepth = Math.max(0, (parseInt(state.mediaRestoreBatchDepth || '0', 10) || 0) - 1);
}

function isMediaRestoreBatchActive() {
    return (parseInt(state.mediaRestoreBatchDepth || '0', 10) || 0) > 0;
}

async function finalizeMediaRestoreBatch() {
    try {
        await getNodeLifecycleApi().waitForImageRestores();
        await mediaControllerApi?.refreshAllRecoverableMediaNodes?.({ cascade: true });
    } finally {
        handleNodeGraphChanged({ force: true });
    }
}

async function runWithMediaRestoreBatch(task) {
    beginMediaRestoreBatch();
    try {
        return await task();
    } finally {
        endMediaRestoreBatch();
    }
}

function handleNodeGraphChanged(options = {}) {
    const { force = false } = options;
    getNodeLifecycleApi().refreshNodeRelationCache?.();
    nodeDomBindingsApi?.syncImageMergeNodes?.();
    if (!force && isMediaRestoreBatchActive()) {
        return;
    }
    refreshAllImageResizePreviews();
    refreshAllCameraControlPreviews();
}

function hasIncomingImageConnection(nodeId) {
    return state.connections.some((conn) => (
        conn.to.nodeId === nodeId
        && (conn.to.port === 'image' || conn.to.port === 'imageA' || conn.to.port === 'imageB')
    ));
}

function hasIncomingImageConnectionInWorkflow(nodeId, connections = []) {
    return Array.isArray(connections) && connections.some((conn) => (
        conn?.to?.nodeId === nodeId
        && (conn.to.port === 'image' || conn.to.port === 'imageA' || conn.to.port === 'imageB')
    ));
}

function collectRetainedNodeAssetIds() {
    const recoverableDisplayTypes = new Set(['ImageGenerate', 'ImagePreview', 'ImageSave', 'ImageResize', 'ImageCompare']);
    const ids = new Set(Array.from(state.nodes.values())
        .filter((node) => {
            if (!node?.id) return false;
            return !(recoverableDisplayTypes.has(node.type) && hasIncomingImageConnection(node.id));
        })
        .map((node) => node.id));

    Array.from(state.nodes.values()).forEach((node) => {
        if (typeof node?.data?.imageAssetKey === 'string' && node.data.imageAssetKey) {
            ids.add(node.data.imageAssetKey);
        }
        const importAssetKey = typeof node?.imageImportAssetKey === 'string' && node.imageImportAssetKey
            ? node.imageImportAssetKey
            : (typeof node?.data?.imageImportAssetKey === 'string' ? node.data.imageImportAssetKey : '');
        if (importAssetKey) {
            ids.add(importAssetKey);
        }
    });

    (state.workflowTabs || []).forEach((tab) => {
        const workflowNodes = Array.isArray(tab?.data?.nodes) ? tab.data.nodes : [];
        const workflowConnections = Array.isArray(tab?.data?.connections) ? tab.data.connections : [];
        workflowNodes.forEach((node) => {
            if (!node?.id) return;
            if (!(recoverableDisplayTypes.has(node.type) && hasIncomingImageConnectionInWorkflow(node.id, workflowConnections))) {
                ids.add(node.id);
            }
            if (typeof node.imageAssetKey === 'string' && node.imageAssetKey) {
                ids.add(node.imageAssetKey);
            }
            const importAssetKey = typeof node.imageImportAssetKey === 'string' && node.imageImportAssetKey
                ? node.imageImportAssetKey
                : (typeof node.data?.imageImportAssetKey === 'string' ? node.data.imageImportAssetKey : '');
            if (importAssetKey) {
                ids.add(importAssetKey);
            }
        });
    });

    return ids;
}

async function cleanupRecoverableNodeAssetCache({ refresh = true } = {}) {
    if (refresh) {
        await mediaControllerApi?.refreshAllRecoverableMediaNodes?.({ cascade: true });
    }
    return clearOrphanedNodeAssets(collectRetainedNodeAssetIds());
}

function cleanupNodeElement(node) {
    if (!node?.el) return;
    cleanupElementResources(node.el);
    node.el.remove();
}

function getLogPanelApi() {
    if (!logPanelApi) {
        logPanelApi = createLogPanelApi({
            state,
            elements,
            renderErrorModal: showErrorModal,
            saveState,
            localStorageRef: localStorage,
            storageKey: LOG_STORAGE_KEY
        });
    }
    return logPanelApi;
}

function getRequestStatisticsApi() {
    if (!requestStatisticsApi) {
        requestStatisticsApi = createRequestStatisticsApi({
            state,
            documentRef: document,
            localStorageRef: localStorage
        });
    }
    return requestStatisticsApi;
}

function getHistoryPanelApi() {
    if (!historyPanelApi) {
        historyPanelApi = createHistoryPanelApi({
            state,
            getHistory,
            getHistoryMetadata,
            getHistoryCount,
            getHistoryEntry,
            createThumbnail,
            updateHistoryThumb,
            openHistoryPreview: (item) => historyPreviewApi.openHistoryPreview(item),
            deleteHistoryEntry
        });
    }
    return historyPanelApi;
}

function getHistoryFullscreenApi() {
    if (!historyFullscreenApi) {
        historyFullscreenApi = createHistoryFullscreenApi({
            state,
            getHistory,
            getHistoryMetadata,
            getHistoryEntry,
            clearHistory,
            deleteHistoryEntry,
            deleteHistoryItems: (ids) => historyPreviewApi.deleteHistoryItems(ids),
            openHistoryPreview: (item) => historyPreviewApi.openHistoryPreview(item),
            downloadImage,
            createThumbnail,
            updateHistoryThumb,
            showToast
        });
    }
    return historyFullscreenApi;
}

function getFloatingNoticesApi() {
    if (!floatingNoticesApi) {
        floatingNoticesApi = createFloatingNoticesController({
            container: elements.floatingNoticesContainer
        });
    }
    return floatingNoticesApi;
}

function getSystemNotificationApi() {
    if (!systemNotificationApi) {
        systemNotificationApi = createSystemNotificationService();
    }
    return systemNotificationApi;
}

function initFloatingNotices() {
    const notices = getFloatingNoticesApi();
    const workflowBackupDismissStorageKey = 'cainflow_workflow_backup_notice_dismissed';
    const refreshTipDismissStorageKey = 'cainflow_refresh_notice_dismissed';

    notices.upsertNotice({
        id: 'workflow-backup',
        priority: 10,
        className: 'workflow-backup-notice',
        icon: '!',
        content: ['及时备份 ', { code: true, text: 'workflows文件夹' }, ' 里的工作流，防止更新后丢失'],
        dismissStorageKey: workflowBackupDismissStorageKey,
        dismissible: true,
        closeLabel: '关闭工作流备份提醒'
    });

    notices.upsertNotice({
        id: 'refresh-tip',
        elementId: 'refresh-notice',
        priority: 20,
        icon: '💡',
        content: ['本APP更新频繁，建议使用 ', { highlight: true, text: 'Ctrl + F5' }, ' 强制刷新以加载最新版'],
        dismissStorageKey: refreshTipDismissStorageKey,
        dismissible: true,
        closeLabel: '关闭刷新提示'
    });
}

const updateManager = createUpdateManager({
    appVersion: APP_VERSION,
    githubRepo: GITHUB_REPO,
    autoUpdateCheckDisabled: () => AUTO_UPDATE_CHECK_DISABLED || state.autoCheckUpdatesOnLoad === false,
    getProxyHeaders,
    showToast,
    renderGeneralSettings: () => settingsControllerApi?.renderGeneralSettings(),
    exportWorkflow: () => exportWorkflow(),
    floatingNoticesApi: getFloatingNoticesApi()
});
const helpPanelApi = createHelpPanelApi({
    canvasContainer,
    nodesLayer,
    panelManager
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
    getImageAsset,
    getImageAssetList,
    saveImageAsset,
    saveImageAssetList,
    saveImageImportAsset,
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
    syncCameraControlNodePreview: (nodeId, imageValue) => cameraControlNodeApi.syncCameraControlFromExecution(nodeId, imageValue),
    syncClonesFromSource: (nodeId) => nodeDomBindingsApi?.syncClonesFromSource(nodeId),
    openImagePainter,
    getHistory,
    getHistoryMetadata,
    getHistoryEntry,
    fitNodeToContent,
    fetchRef: fetch,
    getProxyHeaders,
    formatProxyErrorMessage: formatProxyErrorMessageService,
    canvasContainer
});
const connectionsApi = createConnectionsApi({
    state,
    canvasContainer,
    connectionsGroup,
    tempConnection,
    originAxes,
    getNodeById: (nodeId) => state.nodes.get(nodeId),
    createBezierPath: createBezierPathService,
    getConnectionSamplePoints: getConnectionSamplePointsService,
    pushHistory: () => pushHistory(),
    showToast,
    scheduleSave,
    onConnectionsChanged: () => handleNodeGraphChanged(),
    addNode
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
    applyEditedImage: async ({ nodeId, dataUrl, node }) => {
        if (node?.type === 'ImageImport') {
            return loadImageData(nodeId, dataUrl);
        }
        return false;
    },
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
    removeNode: (nodeId, options) => removeNode(nodeId, options),
    selectNode: (nodeId, isMulti) => selectNode(nodeId, isMulti),
    toggleNodesEnabled: (nodeIds, referenceNodeId) => toggleNodesEnabled(nodeIds, referenceNodeId),
    cancelRunningNode: (nodeId) => cancelRunningNode(nodeId),
    finishConnection: (src, tgt) => finishConnection(src, tgt),
    resumeVideoGeneration: (nodeId) => getWorkflowRunnerApi().resumeVideoNodeBranch(nodeId),
    resumeImageGeneration: (nodeId) => getWorkflowRunnerApi().resumeImageNodeBranch(nodeId),
    setupImageImport,
    setupImageResize,
    setupImageSave,
    setupImagePreview,
    setupImageCompare,
    setupCameraControlNode: (id, el) => cameraControlNodeApi.setupCameraControlNode(id, el),
    copyToClipboard,
    showToast,
    scheduleSave,
    debounce,
    fitNodeToContent,
    enforceNodeContentMinimum: (nodeId, options) => getNodeLifecycleApi().enforceNodeContentMinimum(nodeId, options),
    getNodeMinimumSizeFromLifecycle: (nodeOrId) => getNodeLifecycleApi().getNodeMinimumSize(nodeOrId),
    updateAllConnections: () => updateAllConnections(),
    updatePortStyles: () => updatePortStyles(),
    onConnectionsChanged: () => handleNodeGraphChanged()
});
const {
    getPortPosition,
    updateAllConnections,
    updateDraggingConnections,
    clearConnectionInsertPreview,
    commitConnectionInsertPreview,
    getCompatibleNodeTypeCandidates,
    createNodeFromConnectionCandidate,
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

function removeNode(id, options) {
    return getNodeLifecycleApi().removeNode(id, options);
}

function selectNode(id, isMulti) {
    return getNodeLifecycleApi().selectNode(id, isMulti);
}

function toggleNodesEnabled(nodeIds, referenceNodeId = null) {
    return getNodeLifecycleApi().toggleNodesEnabled(nodeIds, referenceNodeId);
}

function renameNode(nodeId, nextTitle) {
    return getNodeLifecycleApi().renameNode(nodeId, nextTitle);
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

function waitForRunStartFrame() {
    return new Promise((resolve) => {
        const view = document.defaultView || window;
        const requestFrame = view?.requestAnimationFrame;
        if (typeof requestFrame === 'function') {
            requestFrame(() => resolve());
        } else {
            setTimeout(resolve, 16);
        }
    });
}

async function runWorkflow(runInput = null) {
    if (state.isRunStarting) return false;
    state.isRunStarting = true;
    getWorkflowRuntimeManagerApi().syncGlobalRunToolbarState();
    try {
        await waitForRunStartFrame();
        if (!(await workflowManagerApi.ensureOpenWorkflow())) return false;
        const workflowName = workflowManagerApi.getActiveWorkflowName();
        if (!workflowName) {
            showToast('请先打开或新建一个工作流', 'warning');
            return false;
        }
        const workflowData = workflowManagerApi.getActiveWorkflowRuntimeData?.()
            || workflowManagerApi.getActiveWorkflowSnapshot();
        return getWorkflowRuntimeManagerApi().runWorkflowInContext(workflowName, workflowData, runInput);
    } finally {
        state.isRunStarting = false;
        getWorkflowRuntimeManagerApi().syncGlobalRunToolbarState();
    }
}

function cancelRunningNode(nodeId) {
    return getWorkflowRuntimeManagerApi().cancelRunningNode(nodeId)
        || getWorkflowRunnerApi().cancelRunningNode(nodeId);
}

// ===== 持久化 =====
function scheduleSave(options) {
    return getSessionManagerApi().scheduleSave(options);
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
            onConnectionsChanged: () => handleNodeGraphChanged(),
            clearOrphanedNodeAssets,
            beginMediaRestoreBatch,
            endMediaRestoreBatch,
            finalizeMediaRestoreBatch
        });
        sessionManagerApi.setBeforeSave((options) => {
            workflowManagerApi?.syncActiveWorkflowBeforeSessionSave?.(options);
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
            onConnectionsChanged: () => handleNodeGraphChanged(),
            viewportApi,
            showToast,
            applyTheme: (themeId) => getThemeControllerApi().applyTheme(themeId),
            applyGlobalAnimationSetting,
            applyCanvasUiSetting,
            applyWorkflowSidebarWidth: (width) => workflowManagerApi.applyWorkflowSidebarWidth(width),
            clearImageAssets,
            clearOrphanedNodeAssets,
            clearOrphanedImageImportAssets,
            trimHistoryCache,
            cleanupRecoverableNodeAssetCache,
            clearUndoStack: () => {
                state.undoStack = [];
                updateUndoButton();
            },
            updateCacheUsage: () => settingsControllerApi?.updateCacheUsage(),
            beginMediaRestoreBatch,
            endMediaRestoreBatch,
            finalizeMediaRestoreBatch
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
            clearImageAssets,
            clearImageImportAssets,
            clearOrphanedHistoryAssets,
            clearOrphanedNodeAssets,
            collectRetainedNodeAssetIds,
            refreshRecoverableMediaNodes: () => mediaControllerApi?.refreshAllRecoverableMediaNodes?.({ cascade: true }),
            getHistory,
            getHistoryMetadata,
            getHistoryEntry,
            renderHistoryList,
            renderLogs,
            historyPreviewApi,
            historyFullscreenApi: getHistoryFullscreenApi(),
            settingsControllerApi,
            logPanelApi: getLogPanelApi(),
            requestStatisticsApi: getRequestStatisticsApi(),
            applyHistoryGridCols,
            applyTheme: (themeId) => getThemeControllerApi().applyTheme(themeId),
            applyGlobalAnimationSetting,
            applyCanvasUiSetting,
            updateAllConnections,
            saveState,
            showToast,
            copyToClipboard,
            downloadImage,
            initFeatureModules,
            syncOpenWorkflowsBeforeConfigExport: () => workflowManagerApi.snapshotActiveWorkflow(),
            onConfigWorkflowsImported: (workflows) => workflowManagerApi.reloadAfterWorkflowImport(workflows?.[0]?.name || ''),
            applyWorkflowSidebarWidth: (width) => workflowManagerApi.applyWorkflowSidebarWidth(width),
            systemNotificationApi: getSystemNotificationApi()
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
            onConnectionsChanged: () => handleNodeGraphChanged(),
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
            clearConnectionInsertPreview,
            commitConnectionInsertPreview,
            detachNodesFromConnections: (nodeIds, options) => getNodeLifecycleApi().detachNodesFromConnections(nodeIds, options),
            updatePortStyles,
            onConnectionsChanged: () => handleNodeGraphChanged(),
            getConnectionCreateCandidates: (source) => getCompatibleNodeTypeCandidates(source),
            openConnectionCreatePopup: (popupState) => getContextMenuControllerApi().openConnectionCreatePopup(popupState),
            scheduleSave,
            serializeOneNode,
            addNode,
            getNodeMinimumSize: (nodeOrId, options) => getNodeLifecycleApi().getNodeMinimumSize(nodeOrId, options),
            enforceNodeContentMinimum: (nodeId, options) => getNodeLifecycleApi().enforceNodeContentMinimum(nodeId, options),
            checkLineIntersection: checkLineIntersectionService,
            getConnectionSamplePoints: getConnectionSamplePointsService,
            onViewportSettled: () => mediaControllerApi.scheduleDisplayImageMemorySweep?.()
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
            saveCurrentWorkflow: () => workflowManagerApi.saveActiveWorkflow(),
            undo,
            exportWorkflow,
            importWorkflow,
            showToast,
            scheduleSave,
            updateAllConnections,
            autoArrangeNodes,
            zoomToFitTarget: () => zoomToFit(),
            cleanupNodeElement: (node) => node?.el && cleanupNodeElement(node),
            clearUndoStack: () => {
                state.undoStack = [];
                updateUndoButton();
            },
            clearImageAssets,
            clearWorkflowAssets: (options) => workflowManagerApi.cleanupOpenWorkflowAssets(options),
            updateCacheUsage: () => settingsControllerApi?.updateCacheUsage()
        });
    }
    return toolbarControllerApi;
}

function getPromptLibraryApi() {
    if (!promptLibraryApi) {
        promptLibraryApi = createPromptLibraryApi({
            state,
            canvasContainer,
            viewportApi,
            addNode,
            saveState,
            showToast,
            copyToClipboard
        });
    }
    return promptLibraryApi;
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
            connectionCreatePopup,
            viewportApi,
            addNode,
            cloneNode: (nodeId) => getNodeLifecycleApi().cloneNode(nodeId),
            detachCloneNode: (nodeId) => getNodeLifecycleApi().detachCloneNode(nodeId),
            renameNode,
            runWorkflow,
            getRunConflictInfo: (runInput) => {
                const workflowName = workflowManagerApi.getActiveWorkflowName();
                if (!workflowName) return { blocked: false, count: 0, nodeIds: [] };
                const workflowData = workflowManagerApi.getActiveWorkflowRuntimeData?.()
                    || workflowManagerApi.getActiveWorkflowSnapshot();
                return getWorkflowRuntimeManagerApi().getRunConflictInfo(workflowName, workflowData, runInput);
            },
            buildNodeRequestPreview: (nodeId) => getExecutionCoreApi().buildNodeRequestPreview(nodeId),
            createNodeFromConnectionCandidate: (source, candidate, x, y) => createNodeFromConnectionCandidate(source, candidate, x, y),
            fitNodeToContent,
            updateAllConnections,
            updatePortStyles,
            scheduleSave,
            showToast
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
            saveState,
            onThemeApplied: () => viewportApi.applyCanvasVisualTransform()
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
            getImageAssetList,
            saveImageAsset,
            saveImageAssetList,
            saveImageImportAsset,
            deleteImageImportAsset,
            showResolutionBadge,
            restoreImageResizePreview,
            renderImageImportUploadState: (nodeId, imageData) => mediaControllerApi.renderImageImportUploadState(nodeId, imageData),
            renderImagePreviewImage: (nodeId, images, emptyMessage) => mediaControllerApi.renderImagePreviewImage(nodeId, images, emptyMessage),
            renderImageSavePreview: (nodeId, images, emptyMessage) => mediaControllerApi.renderImageSavePreview(nodeId, images, emptyMessage),
            renderImageComparePreview: (nodeId, imageA, imageB) => mediaControllerApi.renderImageComparePreview(nodeId, imageA, imageB),
            bindNodeInteractions: ({ id, type, el }) => nodeDomBindingsApi.bindNodeInteractions({ id, type, el }),
            serializeOneNode,
            pushHistory,
            scheduleSave,
            showToast,
            updateAllConnections,
            updatePortStyles,
            onConnectionsChanged: () => handleNodeGraphChanged(),
            getCacheSidebarActive: () => document.getElementById('cache-sidebar')?.classList.contains('active'),
            updateCacheUsage: () => settingsControllerApi?.updateCacheUsage(),
            canvasContainer
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
            saveCurrentWorkflow: () => workflowManagerApi.saveActiveWorkflow(),
            showToast,
            exportWorkflow,
            undo,
            copySelectedNode,
            pasteNode,
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
            initLogs: () => getLogPanelApi().initializeLogs(),
            loadState,
            showToast,
            syncProxyToServer: () => settingsControllerApi.syncProxyToServer(),
            checkNetworkConnectivity: (options) => settingsControllerApi.checkNetworkConnectivity(options),
            checkNetworkProxyMismatch: (force = false) => settingsControllerApi.checkNetworkProxyMismatch(force),
            ensureOpenWorkflow: () => workflowManagerApi.ensureOpenWorkflow(),
            updateCanvasTransform: () => viewportApi.updateCanvasTransform(),
            scheduleAutoUpdateCheck: () => updateManager.scheduleAutoUpdateCheck({ delayMs: 5000, force: true, showModal: false, showCanvasNotification: true }),
            checkRefreshNotice: () => updateManager.checkRefreshNotice(),
            systemNotificationApi: getSystemNotificationApi()
        });
    }
    return startupControllerApi;
}

function getExecutionCoreApi() {
    if (!executionCoreApi) {
        executionCoreApi = createExecutionCoreApi({
            state,
            nodeConfigs: NODE_CONFIGS,
            syncTextSplitNodeData: (nodeId) => nodeDomBindingsApi.syncTextSplitNodeData(nodeId),
            showToast,
            addLog,
            recordNodeRequest: (...args) => getRequestStatisticsApi().recordNodeRequest(...args),
            getProxyHeaders,
            classifyProviderError: classifyProviderErrorService,
            logRequestToPanel,
            formatProxyErrorMessage: formatProxyErrorMessageService,
            saveHistoryEntry,
            renderHistoryList,
            showResolutionBadge,
            getImageAsset,
            saveImageAsset,
            saveImageAssetList,
            deleteImageAsset,
            dataURLtoBlob,
            blobToDataUrl,
            resizeImageData,
            autoSaveToDir,
            restoreImageResizePreview,
            renderImagePreviewImage: (nodeId, images, emptyMessage) => mediaControllerApi.renderImagePreviewImage(nodeId, images, emptyMessage),
            releaseNodeImageData: (nodeId) => mediaControllerApi.releaseNodeImageData(nodeId),
            refreshDependentImageResizePreviews,
            syncImagePreviewNode: (nodeId, imageValue) => mediaControllerApi.syncImagePreviewNode(nodeId, imageValue),
            syncImageSaveNode: (nodeId, imageValue) => mediaControllerApi.syncImageSaveNode(nodeId, imageValue),
            syncImageCompareNode,
            syncCameraControlNode: (nodeId, imageValue) => cameraControlNodeApi.syncCameraControlFromExecution(nodeId, imageValue),
            fitNodeToContent,
            scheduleSave,
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
            executeNode: (node, inputs, signal, executionContext) => getExecutionCoreApi().executeNode(node, inputs, signal, executionContext),
            resumeVideoGeneration: (nodeId, signal) => getExecutionCoreApi().resumeVideoGeneration(nodeId, signal),
            resumeAsyncImageGeneration: (nodeId, signal) => getExecutionCoreApi().resumeAsyncImageGeneration(nodeId, signal),
            addNode,
            generateId,
            showToast,
            addLog,
            scheduleSave,
            updateAllConnections,
            updatePortStyles,
            getImageAsset,
            getImageAssetList,
            saveImageAsset,
            deleteImageAsset,
            saveImageAssetList,
            syncImagePreviewNode: (nodeId, imageData) => mediaControllerApi.syncImagePreviewNode(nodeId, imageData),
            syncImageSaveNode: (nodeId, imageData) => mediaControllerApi.syncImageSaveNode(nodeId, imageData),
            refreshDependentImageResizePreviews,
            getAbortMessage: getAbortMessageService,
            playNotificationSound: () => settingsControllerApi.playNotificationSound(),
            systemNotificationApi: getSystemNotificationApi(),
            onAutoSaveNodeInjected: () => {
                handleNodeGraphChanged();
                scheduleSave();
            },
            onNodeRunStateChange: (payload) => {
                if (state.activeWorkflowName) {
                    getWorkflowRuntimeManagerApi().applyVisibleNodeRunState(state.activeWorkflowName, payload);
                }
                if (payload?.status === 'completed' && payload.nodeId) {
                    mediaControllerApi?.scheduleDisplayImageMemorySweep?.({ delayMs: 4200 });
                }
            }
        });
    }
    return workflowRunnerApi;
}

function getWorkflowRuntimeManagerApi() {
    if (!workflowRuntimeManagerApi) {
        workflowRuntimeManagerApi = createWorkflowRuntimeManager({
            state,
            nodeConfigs: NODE_CONFIGS,
            createNodeMarkup,
            createBezierPath: createBezierPathService,
            getConnectionSamplePoints: getConnectionSamplePointsService,
            generateId,
            showToast,
            addLog,
            scheduleSave,
            updateAllConnections,
            updatePortStyles,
            getWorkflowManagerApi: () => workflowManagerApi,
            getSettingsControllerApi: () => settingsControllerApi,
            getSystemNotificationApi,
            getImageAsset,
            getImageAssetList,
            saveImageAsset,
            saveImageImportAsset,
            deleteImageImportAsset,
            deleteImageAsset,
            saveImageAssetList,
            saveHistoryEntry,
            renderHistoryList,
            logRequestToPanel,
            recordNodeRequest: (...args) => getRequestStatisticsApi().recordNodeRequest(...args),
            classifyProviderError: classifyProviderErrorService,
            formatProxyErrorMessage: formatProxyErrorMessageService,
            getAbortMessage: getAbortMessageService,
            dataURLtoBlob,
            blobToDataUrl,
            resizeImageData,
            copyToClipboard,
            debounce,
            fitNodeToContent,
            documentRef: document,
            windowRef: window,
            fetchRef: fetch,
            confirmRef: confirm
        });
    }
    return workflowRuntimeManagerApi;
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

function pasteNode(options) {
    return getClipboardControllerApi().pasteNode(options);
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
    onConnectionsChanged: () => handleNodeGraphChanged(),
    scheduleSave,
    showToast,
    panelManager,
    clearImageAssets,
    clearOrphanedNodeAssets,
    clearUndoStack: () => {
        state.undoStack = [];
        updateUndoButton();
    },
    updateCacheUsage: () => settingsControllerApi?.updateCacheUsage(),
    onWorkflowViewApplied: (workflowName) => getWorkflowRuntimeManagerApi().refreshVisibleWorkflowRunState(workflowName),
    refreshRecoverableMediaNodes: () => mediaControllerApi?.refreshAllRecoverableMediaNodes?.({ cascade: true }),
    waitForImageRestores: () => getNodeLifecycleApi().waitForImageRestores(),
    beginMediaRestoreBatch,
    endMediaRestoreBatch,
    finalizeMediaRestoreBatch
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
    deleteHandle,
    showToast,
    saveState,
    addLog,
    checkUpdate: (isManual) => updateManager.checkUpdate(isManual),
    downloadLatestUpdate: () => updateManager.downloadLatestUpdate(),
    cancelUpdateDownload: () => updateManager.cancelUpdateDownload(),
    updateAllConnections,
    applyGlobalAnimationSetting,
    applyCanvasUiSetting,
    fitNodeToContent,
    floatingNoticesApi: getFloatingNoticesApi()
});
historyPreviewApi = createHistoryPreviewApi({
    getHistory,
    getHistoryMetadata,
    getHistoryEntry,
    getHistoryImageBlob,
    deleteHistoryEntry,
    getImageResolution,
    downloadImage,
    copyToClipboard,
    renderHistoryList: () => renderHistoryList(),
    showToast
});

function initFeatureModules() {
    initFloatingNotices();
    settingsControllerApi.initSettingsUI({ settingsModalApi });
    historyPreviewApi.initHistoryPreview();
    getHistoryFullscreenApi().initHistoryFullscreen();
    helpPanelApi.initHelpPanel();
    workflowManagerApi.initWorkflow();
    getPromptLibraryApi().initPromptLibrary();
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
