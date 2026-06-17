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
    STORE_HISTORY
} from '../core/constants.js';
import {
    cleanupElementResources,
    generateId as generateIdService,
    debounce as debounceService
} from '../core/common-utils.js';
import {
    classifyProviderError as classifyProviderErrorService,
    formatProxyErrorMessage as formatProxyErrorMessageService,
    getProxyRequestInfo,
    getAbortMessage as getAbortMessageService
} from '../services/api-client.js';
import { createSystemNotificationService } from '../services/system-notification-service.js';
import {
    createBezierPath as createBezierPathService,
    checkLineIntersection as checkLineIntersectionService,
    getConnectionSamplePoints as getConnectionSamplePointsService
} from '../canvas/geometry.js';
import { createConnectionsApi } from '../canvas/connections.js';
import { createConnectionRefreshScheduler } from '../canvas/connection-refresh-scheduler.js';
import { createBatchConnectionModeApi } from '../canvas/batch-connection-mode.js';
import { createSelectionApi } from '../canvas/selection.js';
import { createViewportApi } from '../canvas/viewport.js';
import { createCanvasInteractionsApi } from '../canvas/canvas-interactions.js';
import { createNodeAutoLayoutApi } from '../canvas/node-auto-layout.js';
import { NODE_CONFIGS } from '../nodes/registry.js';
import { createNodeSerializer } from '../nodes/node-serializer.js';
import { createNodeMarkup } from '../nodes/node-view-factory.js';
import { createNodeDomBindingsApi } from '../nodes/node-dom-bindings.js';
import { createNodeLifecycleApi } from '../nodes/node-lifecycle.js';
import { createMediaControllerApi } from '../features/media/media-controller.js';
import { createImagePainterApi } from '../features/media/image-painter.js';
import { createCameraControlNodeApi } from '../features/camera/camera-control-node-proxy.js';
import { createExecutionCoreApi } from '../features/execution/execution-core.js';
import { createWorkflowRunnerApi } from '../features/execution/workflow-runner.js';
import { createSessionManagerApi } from '../features/persistence/session-manager.js';
import { createClipboardControllerApi } from '../features/ui/clipboard-controller.js';
import { createGlobalInteractionsApi } from '../features/ui/global-interactions.js';
import { createContextMenuControllerApi } from '../features/ui/context-menu-controller.js';
import { createErrorModalControllerApi } from '../features/ui/error-modal-controller.js';
import { createRuntimeControllerApi } from '../features/ui/runtime-controller.js';
import { createThemeControllerApi } from '../features/ui/theme-controller.js';
import { applyGlobalAnimationSetting as applyGlobalAnimationSettingService } from '../features/ui/animation-controller.js';
import { applyCanvasUiSetting as applyCanvasUiSettingService } from '../features/ui/canvas-ui-controller.js';
import { createToolbarControllerApi } from '../features/ui/toolbar-controller.js';
import { createToastControllerApi } from '../features/ui/toast-controller.js';
import { createFloatingNoticesController } from '../features/ui/floating-notices-controller.js';
import { createLogPanelApi } from '../features/logs/log-panel.js';
import { createRequestStatisticsApi } from '../features/statistics/request-statistics.js';
import { createStartupControllerApi } from '../features/app/startup-controller.js';
import { createUpdateManager } from '../features/update/update-manager.js';
import { createHelpPanelApi } from '../features/help/help-panel.js';
import { createWorkflowManagerApi } from '../features/workflow/workflow-manager.js';
import { createWorkflowRuntimeManager } from '../features/workflow/workflow-runtime-manager.js';
import { createPromptLibraryApi } from '../features/prompts/prompt-library.js';
import { createHistoryFeature } from './bootstrap/history-bootstrap.js';
import { createProjectIoFeature } from './bootstrap/project-io-bootstrap.js';
import { createSettingsFeature } from './bootstrap/settings-bootstrap.js';
import { createUiFeature } from './bootstrap/ui-bootstrap.js';
import { createAppContext } from './create-app-context.js';
import { createAppRegistry } from './create-app-registry.js';
import { createCanvasStressTestBridge } from './dev/canvas-stress-test.js';
import { registerGlobalBridges } from './register-global-bridges.js';

/**
 * index.js 是 CainFlow 前端的总装配入口。
 * 它负责初始化全局状态、缓存核心 DOM、装配画布/节点/连线/执行/持久化/UI 等功能模块，
 * 并承担少量兼容性桥接逻辑，使整个节点式工作流编辑与运行界面可以协同工作。
 *
 * CainFlow - 基于节点的 AI 图像生成工具
 * 包含画布、节点、连线、执行引擎与 localStorage 持久化
 */

export function initializeCainFlowApp() {
const registry = createAppRegistry();

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
    scheduleConnectionRefresh({
        nodeIds: textarea.closest?.('.node')?.dataset?.id || '',
        reason: 'textarea-height'
    });
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

const appContext = createAppContext({
    documentRef: document,
    showToast: (...args) => showToast(...args),
    onNativeClipboardWrite: () => getClipboardControllerApi().markNativeClipboardWrite()
});
const {
    elements,
    panelManager,
    state,
    dirHandles,
    proxyHeadersGetter,
    indexedDbApi,
    mediaUtils,
    uiUtils
} = appContext;

const { canvasContainer, nodesLayer, connectionsGroup, tempConnection, originAxes, contextMenu } = elements;
const connectionCreatePopup = elements.connectionCreatePopup;

state.abortAllWorkflowRuns = (reason) => getWorkflowRuntimeManagerApi().abortAllWorkflowRuns(reason);
applyGlobalAnimationSettingService({ state, documentRef: document });
applyCanvasUiSettingService({ state, documentRef: document });

function scheduleConnectionRefresh(options = {}) {
    return registry.connectionRefreshSchedulerApi?.scheduleConnectionRefresh(options) || false;
}

function flushConnectionRefresh(options = {}) {
    return registry.connectionRefreshSchedulerApi?.flushConnectionRefresh(options) || false;
}

function applyGlobalAnimationSetting() {
    return applyGlobalAnimationSettingService({ state, documentRef: document });
}

function applyCanvasUiSetting() {
    return applyCanvasUiSettingService({ state, documentRef: document });
}

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
const cameraControlNodeApi = createCameraControlNodeApi({
    state,
    fitNodeToContent: (nodeId) => fitNodeToContent(nodeId),
    scheduleSave: () => scheduleSave(),
    showToast,
    documentRef: document
});
const viewportApi = createViewportApi({
    state,
    elements,
    updateAllConnections: () => updateAllConnections(),
    scheduleConnectionRefresh
});
const selectionApi = createSelectionApi({
    state,
    updateAllConnections: () => updateAllConnections(),
    scheduleConnectionRefresh
});
const nodeSerializer = createNodeSerializer({
    state,
    documentRef: document
});
let settingsControllerApi = null;
let settingsFeature = null;
let historyFeature = null;
let historyPreviewApi = null;
let projectIoFeature = null;
let uiFeature = null;

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
    nodeDomBindingsApi?.syncAllConnectedInputFieldVisibility?.();
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
    const shouldRetainNodeAsset = (node, connections = state.connections) => {
        if (!node?.id) return false;
        return !(recoverableDisplayTypes.has(node.type) && hasIncomingImageConnectionInWorkflow(node.id, connections));
    };
    const ids = new Set(Array.from(state.nodes.values())
        .filter((node) => {
            return shouldRetainNodeAsset(node, state.connections);
        })
        .map((node) => node.id));

    Array.from(state.nodes.values()).forEach((node) => {
        if (shouldRetainNodeAsset(node, state.connections) && typeof node?.data?.imageAssetKey === 'string' && node.data.imageAssetKey) {
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
        if (tab?.name === state.activeWorkflowName) return;
        const workflowNodes = Array.isArray(tab?.data?.nodes) ? tab.data.nodes : [];
        const workflowConnections = Array.isArray(tab?.data?.connections) ? tab.data.connections : [];
        workflowNodes.forEach((node) => {
            if (!node?.id) return;
            const retainNodeAsset = shouldRetainNodeAsset(node, workflowConnections);
            if (retainNodeAsset) {
                ids.add(node.id);
            }
            if (retainNodeAsset && typeof node.imageAssetKey === 'string' && node.imageAssetKey) {
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
    if (!registry.logPanelApi) {
        registry.logPanelApi = createLogPanelApi({
            state,
            elements,
            renderErrorModal: showErrorModal,
            saveState,
            localStorageRef: localStorage,
            storageKey: LOG_STORAGE_KEY
        });
    }
    return registry.logPanelApi;
}

function getRequestStatisticsApi() {
    if (!registry.requestStatisticsApi) {
        registry.requestStatisticsApi = createRequestStatisticsApi({
            state,
            documentRef: document,
            localStorageRef: localStorage
        });
    }
    return registry.requestStatisticsApi;
}

function getFloatingNoticesApi() {
    if (!registry.floatingNoticesApi) {
        registry.floatingNoticesApi = createFloatingNoticesController({
            container: elements.floatingNoticesContainer
        });
    }
    return registry.floatingNoticesApi;
}

function getSystemNotificationApi() {
    if (!registry.systemNotificationApi) {
        registry.systemNotificationApi = createSystemNotificationService();
    }
    return registry.systemNotificationApi;
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
    exportWorkflow: (...args) => projectIoFeature.exportWorkflow(...args),
    floatingNoticesApi: getFloatingNoticesApi()
});
const helpPanelApi = createHelpPanelApi({
    canvasContainer,
    nodesLayer,
    panelManager
});
const settingsModal = document.getElementById('settings-modal');
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
    handleBatchConnectionNodeMouseDown: (event, nodeId) => getBatchConnectionModeApi().handleNodeMouseDown(event, nodeId),
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
    updateDirtyConnections: () => updateDirtyConnections(),
    scheduleConnectionRefresh,
    invalidateNodePortCache: (nodeId) => invalidateNodePortCache(nodeId),
    markNodeConnectionsDirty: (nodeId) => markNodeConnectionsDirty(nodeId),
    updatePortStyles: () => updatePortStyles(),
    onConnectionsChanged: () => handleNodeGraphChanged()
});
const {
    getPortPosition,
    invalidateNodePortCache,
    markConnectionDirty,
    markNodeConnectionsDirty,
    updateAllConnections,
    updateDirtyConnections,
    updateDraggingConnections,
    clearConnectionInsertPreview,
    commitConnectionInsertPreview,
    getCompatibleNodeTypeCandidates,
    createNodeFromConnectionCandidate,
    finishConnection,
    drawTempConnection,
    updatePortStyles
} = connectionsApi;

registry.connectionRefreshSchedulerApi = createConnectionRefreshScheduler({
    updateAllConnections,
    updateDirtyConnections,
    invalidateNodePortCache,
    markConnectionDirty,
    markNodeConnectionsDirty,
    requestAnimationFrameRef: requestAnimationFrame,
    cancelAnimationFrameRef: cancelAnimationFrame
});

function getBatchConnectionModeApi() {
    if (!registry.batchConnectionModeApi) {
        registry.batchConnectionModeApi = createBatchConnectionModeApi({
            state,
            canvasContainer,
            pushHistory,
            updateAllConnections,
            updatePortStyles,
            enforceNodeContentMinimum: (nodeId, options) => getNodeLifecycleApi().enforceNodeContentMinimum(nodeId, options),
            scheduleSave,
            showToast,
            floatingNoticesApi: getFloatingNoticesApi(),
            onConnectionsChanged: () => handleNodeGraphChanged()
        });
    }
    return registry.batchConnectionModeApi;
}

// ===== 平移、选择与焦点管理 =====
getCanvasInteractionsApi().initCanvasInteractions();

getContextMenuControllerApi().initContextMenu();
getBatchConnectionModeApi().initBatchConnectionMode();

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
    if (!registry.sessionManagerApi) {
        registry.sessionManagerApi = createSessionManagerApi({
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
        registry.sessionManagerApi.setBeforeSave((options) => {
            workflowManagerApi?.syncActiveWorkflowBeforeSessionSave?.(options);
        });
    }
    return registry.sessionManagerApi;
}

function getClipboardControllerApi() {
    if (!registry.clipboardControllerApi) {
        registry.clipboardControllerApi = createClipboardControllerApi({
            state,
            showToast,
            addNode,
            updateAllConnections,
            updatePortStyles,
            onConnectionsChanged: () => handleNodeGraphChanged(),
            scheduleSave
        });
    }
    return registry.clipboardControllerApi;
}

function getGlobalInteractionsApi() {
    if (!registry.globalInteractionsApi) {
        registry.globalInteractionsApi = createGlobalInteractionsApi({
            state,
            settingsModal,
            canvasContainer,
            viewportApi,
            loadImageFile,
            loadImageData,
            addNode,
            pasteNode,
            clipboardControllerApi: getClipboardControllerApi(),
            toggleNodesEnabled,
            showToast,
            scheduleSave
        });
    }
    return registry.globalInteractionsApi;
}

function getCanvasInteractionsApi() {
    if (!registry.canvasInteractionsApi) {
        registry.canvasInteractionsApi = createCanvasInteractionsApi({
            state,
            canvasContainer,
            nodesLayer,
            tempConnection,
            viewportApi,
            getPortPosition,
            drawTempConnection,
            updateAllConnections,
            updateDirtyConnections,
            updateDraggingConnections,
            scheduleConnectionRefresh,
            invalidateNodePortCache,
            markNodeConnectionsDirty,
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
            onViewportSettled: () => mediaControllerApi.scheduleMediaMemorySweep?.({ reason: 'viewport-settled' })
        });
    }
    return registry.canvasInteractionsApi;
}

function getToolbarControllerApi() {
    if (!registry.toolbarControllerApi) {
        registry.toolbarControllerApi = createToolbarControllerApi({
            state,
            canvasContainer,
            viewportApi,
            runWorkflow,
            saveState,
            saveCurrentWorkflow: () => workflowManagerApi.saveActiveWorkflow(),
            undo,
            exportWorkflow: (...args) => projectIoFeature.exportWorkflow(...args),
            importWorkflow: (...args) => projectIoFeature.importWorkflow(...args),
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
    return registry.toolbarControllerApi;
}

function getPromptLibraryApi() {
    if (!registry.promptLibraryApi) {
        registry.promptLibraryApi = createPromptLibraryApi({
            state,
            canvasContainer,
            viewportApi,
            addNode,
            saveState,
            showToast,
            copyToClipboard
        });
    }
    return registry.promptLibraryApi;
}

function getNodeAutoLayoutApi() {
    if (!registry.nodeAutoLayoutApi) {
        registry.nodeAutoLayoutApi = createNodeAutoLayoutApi({
            state,
            pushHistory,
            updateAllConnections,
            scheduleSave,
            showToast
        });
    }
    return registry.nodeAutoLayoutApi;
}

function getContextMenuControllerApi() {
    if (!registry.contextMenuControllerApi) {
        registry.contextMenuControllerApi = createContextMenuControllerApi({
            state,
            canvasContainer,
            contextMenu,
            connectionCreatePopup,
            viewportApi,
            addNode,
            cloneNode: (nodeId, count, options) => getNodeLifecycleApi().cloneNode(nodeId, count, options),
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
            enterBatchConnectionMode: (nodeId) => getBatchConnectionModeApi().enter(nodeId),
            createNodeFromConnectionCandidate: (source, candidate, x, y) => createNodeFromConnectionCandidate(source, candidate, x, y),
            fitNodeToContent,
            updateAllConnections,
            updatePortStyles,
            scheduleSave,
            showToast
        });
    }
    return registry.contextMenuControllerApi;
}

function getErrorModalControllerApi() {
    if (!registry.errorModalControllerApi) {
        registry.errorModalControllerApi = createErrorModalControllerApi({
            documentRef: document
        });
    }
    return registry.errorModalControllerApi;
}

function getToastControllerApi() {
    if (!registry.toastControllerApi) {
        registry.toastControllerApi = createToastControllerApi({
            container: elements.toastContainer,
            documentRef: document
        });
    }
    return registry.toastControllerApi;
}

function getThemeControllerApi() {
    if (!registry.themeControllerApi) {
        registry.themeControllerApi = createThemeControllerApi({
            state,
            documentRef: document,
            saveState,
            onThemeApplied: () => viewportApi.applyCanvasVisualTransform()
        });
    }
    return registry.themeControllerApi;
}

function getNodeLifecycleApi() {
    if (!registry.nodeLifecycleApi) {
        registry.nodeLifecycleApi = createNodeLifecycleApi({
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
            updateDirtyConnections,
            scheduleConnectionRefresh,
            invalidateNodePortCache,
            markNodeConnectionsDirty,
            updatePortStyles,
            onConnectionsChanged: () => handleNodeGraphChanged(),
            getCacheSidebarActive: () => document.getElementById('cache-sidebar')?.classList.contains('active'),
            updateCacheUsage: () => settingsControllerApi?.updateCacheUsage(),
            canvasContainer
        });
    }
    return registry.nodeLifecycleApi;
}

function getRuntimeControllerApi() {
    if (!registry.runtimeControllerApi) {
        registry.runtimeControllerApi = createRuntimeControllerApi({
            state,
            canvasContainer,
            contextMenu,
            selectionApi,
            runWorkflow,
            saveState,
            saveCurrentWorkflow: () => workflowManagerApi.saveActiveWorkflow(),
            showToast,
            exportWorkflow: (...args) => projectIoFeature.exportWorkflow(...args),
            undo,
            copySelectedNode,
            pasteNode,
            clipboardControllerApi: getClipboardControllerApi(),
            removeNode,
            zoomToFit,
            scheduleSave,
            closeModal
        });
    }
    return registry.runtimeControllerApi;
}

function getStartupControllerApi() {
    if (!registry.startupControllerApi) {
        registry.startupControllerApi = createStartupControllerApi({
            state,
            initUI: () => uiFeature.initUI(),
            initLogs: () => getLogPanelApi().initializeLogs(),
            loadState: (...args) => projectIoFeature.loadState(...args),
            showToast,
            syncProxyToServer: () => settingsFeature.syncProxyToServer(),
            checkNetworkConnectivity: (options) => settingsFeature.checkNetworkConnectivity(options),
            checkNetworkProxyMismatch: (force = false) => settingsFeature.checkNetworkProxyMismatch(force),
            ensureOpenWorkflow: () => workflowManagerApi.ensureOpenWorkflow(),
            updateCanvasTransform: () => viewportApi.updateCanvasTransform(),
            scheduleAutoUpdateCheck: () => updateManager.scheduleAutoUpdateCheck({ delayMs: 5000, force: true, showModal: false, showCanvasNotification: true }),
            checkRefreshNotice: () => updateManager.checkRefreshNotice(),
            systemNotificationApi: getSystemNotificationApi()
        });
    }
    return registry.startupControllerApi;
}

function getExecutionCoreApi() {
    if (!registry.executionCoreApi) {
        registry.executionCoreApi = createExecutionCoreApi({
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
            renderHistoryList: (...args) => historyFeature.renderHistoryList(...args),
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
            releaseNodeImageData: (nodeId, options) => mediaControllerApi.releaseNodeImageData(nodeId, options),
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
    return registry.executionCoreApi;
}

function getWorkflowRunnerApi() {
    if (!registry.workflowRunnerApi) {
        registry.workflowRunnerApi = createWorkflowRunnerApi({
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
                    mediaControllerApi?.scheduleMediaMemorySweep?.({ delayMs: 4200, reason: 'node-run-completed' });
                }
            }
        });
    }
    return registry.workflowRunnerApi;
}

function getWorkflowRuntimeManagerApi() {
    if (!registry.workflowRuntimeManagerApi) {
        registry.workflowRuntimeManagerApi = createWorkflowRuntimeManager({
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
            renderHistoryList: (...args) => historyFeature.renderHistoryList(...args),
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
            syncImagePreviewNode: (nodeId, imageData) => mediaControllerApi.syncImagePreviewNode(nodeId, imageData),
            syncImageSaveNode: (nodeId, imageData) => mediaControllerApi.syncImageSaveNode(nodeId, imageData),
            syncImageCompareNode: (nodeId, imageA, imageB) => mediaControllerApi.syncImageCompareNode(nodeId, imageA, imageB),
            syncCameraControlNode: (nodeId, imageValue) => cameraControlNodeApi.syncCameraControlFromExecution(nodeId, imageValue),
            refreshDependentImageResizePreviews,
            restoreImageResizePreview,
            showResolutionBadge,
            documentRef: document,
            windowRef: window,
            fetchRef: fetch,
            confirmRef: confirm
        });
    }
    return registry.workflowRuntimeManagerApi;
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
    releaseNodeImageData: (nodeId, options) => mediaControllerApi?.releaseNodeImageData?.(nodeId, options),
    refreshRecoverableMediaNodes: () => mediaControllerApi?.refreshAllRecoverableMediaNodes?.({ cascade: true }),
    waitForImageRestores: () => getNodeLifecycleApi().waitForImageRestores(),
    beginMediaRestoreBatch,
    endMediaRestoreBatch,
    finalizeMediaRestoreBatch
});

function refreshImageGenerateNodes(protocolId) {
    state.nodes.forEach((node, nodeId) => {
        if (node.type === 'ImageGenerate') {
            const nodeEl = node.el;
            if (!nodeEl) return;

            // 触发节点重新渲染以更新协议相关的UI
            nodeDomBindingsApi?.syncNodeProviderOptions?.(nodeId, 'ImageGenerate');
            nodeDomBindingsApi?.syncImageGenerateResolutionOptions?.(nodeId);
        }
    });
    updateAllConnections();
}

settingsFeature = createSettingsFeature({
    appVersion: APP_VERSION,
    githubRepo: GITHUB_REPO,
    state,
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
    floatingNoticesApi: getFloatingNoticesApi(),
    refreshImageGenerateNodes,
    documentRef: document
});
settingsControllerApi = settingsFeature.settingsControllerApi;
historyFeature = createHistoryFeature({
    registry,
    state,
    getHistory,
    getHistoryMetadata,
    getHistoryCount,
    getHistoryEntry,
    getHistoryImageBlob,
    createThumbnail,
    updateHistoryThumb,
    clearHistory,
    deleteHistoryEntry,
    getImageResolution,
    downloadImage,
    copyToClipboard,
    showToast
});
historyPreviewApi = historyFeature.historyPreviewApi;
projectIoFeature = createProjectIoFeature({
    registry,
    state,
    storageKey: STORAGE_KEY,
    nodeSerializer,
    getHandle,
    addLog,
    addNode,
    applyHistoryGridCols: (...args) => historyFeature.applyHistoryGridCols(...args),
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
uiFeature = createUiFeature({
    registry,
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
    renderHistoryList: (...args) => historyFeature.renderHistoryList(...args),
    renderLogs,
    historyPreviewApi,
    getHistoryFullscreenApi: () => historyFeature.getHistoryFullscreenApi(),
    settingsControllerApi,
    getLogPanelApi: () => getLogPanelApi(),
    getRequestStatisticsApi: () => getRequestStatisticsApi(),
    applyHistoryGridCols: (...args) => historyFeature.applyHistoryGridCols(...args),
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
    getSystemNotificationApi: () => getSystemNotificationApi(),
    documentRef: document
});

function initFeatureModules() {
    initFloatingNotices();
    settingsFeature.initSettingsFeature();
    historyFeature.initHistoryFeature();
    helpPanelApi.initHelpPanel();
    workflowManagerApi.initWorkflow();
    getPromptLibraryApi().initPromptLibrary();
    uiFeature.initCache();
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

const canvasStressTestBridge = createCanvasStressTestBridge({
    state,
    addNode,
    mediaControllerApi,
    updateAllConnections,
    scheduleSave,
    showToast,
    documentRef: document,
    localStorageRef: localStorage,
    globalRef: globalThis
});

registerGlobalBridges({
    windowRef: window,
    closeModal,
    showLogDetail,
    createCanvasStressTestNodes: canvasStressTestBridge.createCanvasStressTestNodes,
    enableCanvasStressTest: canvasStressTestBridge.enabled
});

return {
    state,
    elements,
    registry,
    settingsControllerApi,
    historyPreviewApi,
    mediaControllerApi,
    workflowManagerApi
};
}
