import { createAgentChatModelPreference } from '../features/prompt-agent/prompt-agent-model-preference.js';
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
import { diskStorage } from '../services/storage-documents.js';
import { migrateAutoCompactTokens, readAutoCompactTokens, readCompactionModelId } from '../features/prompt-agent/auto-compact-preference.js';
import {
    createBezierPath as createBezierPathService,
    checkLineIntersection as checkLineIntersectionService,
    getConnectionSamplePoints as getConnectionSamplePointsService
} from '../canvas/geometry.js';
import { createConnectionsApi } from '../canvas/connections.js';
import { createConnectionProjection } from '../canvas/connection-projection.js';
import { createDiagnosticClient } from '../services/diagnostic-client.js';
import { createBatchConnectionModeApi } from '../canvas/batch-connection-mode.js';
import { createSelectionApi } from '../canvas/selection.js';
import { createViewportApi } from '../canvas/viewport.js';
import { createCanvasInteractionsApi } from '../canvas/canvas-interactions.js';
import { createRenderProjectionManager } from '../canvas/render-projection-manager.js';
import { createInteractionPerformanceGuard } from '../canvas/interaction-performance-guard.js';
import { createNodeAutoLayoutApi } from '../canvas/node-auto-layout.js';
import { NODE_CONFIGS } from '../nodes/registry.js';
import { createNodeSerializer } from '../nodes/node-serializer.js';
import { createNodeMarkup } from '../nodes/node-view-factory.js';
import { createNodeDomBindingsApi } from '../nodes/node-dom-bindings.js';
import { createNodeLifecycleApi } from '../nodes/node-lifecycle.js';
import { createMediaControllerApi } from '../features/media/media-controller.js';
import { collectRetainedNodeAssetIds as collectRetainedNodeAssetIdsForWorkflows } from '../features/media/node-asset-retention.js';
import { createMissingMediaBrowserActions } from '../features/media/missing-media-action-browser.js';
import { createImagePainterApi } from '../features/media/image-painter.js';
import { createEditedImageImport } from '../features/media/image-painter-output.js';
import { createCameraControlNodeApi } from '../features/camera/camera-control-node-proxy.js';
import { createExecutionCoreApi } from '../features/execution/execution-core.js';
import { createWorkflowRunnerApi } from '../features/execution/workflow-runner.js';
import { prepareGenerationSaveTargets } from '../features/execution/generation-save-targets.js';
import { findAgentImageNodePosition } from '../features/execution/node-placement.js';
import { createSessionManagerApi } from '../features/persistence/session-manager.js';
import { flushSessionToDisk } from '../features/persistence/flush-session-to-disk.js';
import { installSessionPersistenceOnExit } from '../features/persistence/session-persistence-lifecycle.js';
import { createBrowserUndoMediaProtection } from '../features/persistence/undo-media-protection.js';
import { createDesktopExit } from '../features/persistence/desktop-exit.js';
import { createClipboardControllerApi } from '../features/ui/clipboard-controller.js';
import { createGlobalInteractionsApi } from '../features/ui/global-interactions.js';
import { createContextMenuControllerApi } from '../features/ui/context-menu-controller.js';
import { createErrorModalControllerApi } from '../features/ui/error-modal-controller.js';
import { openDialogStyle1 } from '../features/ui/dialog-style-1.js';
import { createRuntimeControllerApi } from '../features/ui/runtime-controller.js';
import { createThemeControllerApi } from '../features/ui/theme-controller.js';
import { applyGlobalAnimationSetting as applyGlobalAnimationSettingService } from '../features/ui/animation-controller.js';
import { applyCanvasUiSetting as applyCanvasUiSettingService } from '../features/ui/canvas-ui-controller.js';
import { createToolbarControllerApi } from '../features/ui/toolbar-controller.js';
import { createWorkspaceModeController } from '../features/ui/workspace-mode-controller.js';
import { createConversationWorkbenchController } from '../features/conversation/conversation-workbench-controller.js';
import { createConversationToolbarController } from '../features/conversation/conversation-toolbar-controller.js';
import { createConversationExecutionService } from '../features/conversation/conversation-execution-service.js';
import { createConversationImageGenerationService } from '../features/conversation/conversation-image-generation-service.js';
import * as conversationApi from '../services/conversation-api.js';
import { buildCanvasMaterializationPlan, createCanvasMaterializationCommand } from '../features/conversation/conversation-canvas-materialization.js';
import { createChatRequestPlan, requestChatCompletion } from '../features/execution/chat-request-plan.js';
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
import { createPromptAgentController } from '../features/prompt-agent/prompt-agent-controller.js';
import { createPromptAgentCanvasAdapter } from '../features/prompt-agent/prompt-agent-canvas-adapter.js';
import { createPromptAgentReferenceSource } from '../features/prompt-agent/prompt-agent-reference-source.js';
import { createPromptAgentNodeAdapter, getAvailablePromptAgentImageModels } from '../features/prompt-agent/prompt-agent-node-adapter.js';
import { createPromptAgentExecutionAdapter } from '../features/prompt-agent/prompt-agent-execution-adapter.js';
import { createPromptAgentResultPersistence } from '../features/prompt-agent/prompt-agent-result-persistence.js';
import { createPromptAgentResultMediaAdapter } from '../features/prompt-agent/prompt-agent-result-media.js';
import { createPromptAgentModelReply, getAvailablePromptAgentModels } from '../features/prompt-agent/prompt-agent-model.js';
import { createAgentWebImageReader } from '../features/prompt-agent/prompt-agent-web-image.js';
import { createPromptAgentCompaction } from '../features/prompt-agent/prompt-agent-compaction.js';
import { getResolvedProviderForModel } from '../features/execution/provider-request-utils.js';
import { createHistoryFeature } from './bootstrap/history-bootstrap.js';
import { createProjectIoFeature } from './bootstrap/project-io-bootstrap.js';
import { createSettingsFeature } from './bootstrap/settings-bootstrap.js';
import { createUiFeature } from './bootstrap/ui-bootstrap.js';
import { createAppContext } from './create-app-context.js';
import { createAppRegistry } from './create-app-registry.js';
import { createCanvasStressTestBridge } from './dev/canvas-stress-test.js';
import { createCanvasPerformanceMonitor } from './dev/canvas-performance-monitor.js';
import { registerGlobalBridges } from './register-global-bridges.js';

/**
 * index.js 是 CainFlow 前端的总装配入口。
 * 它负责初始化全局状态、缓存核心 DOM、装配画布/节点/连线/执行/持久化/UI 等功能模块，
 * 并承担少量兼容性桥接逻辑，使整个节点式工作流编辑与运行界面可以协同工作。
 *
 * CainFlow - 基于节点的 AI 图像生成工具
 * 包含画布、节点、连线、执行引擎与 localStorage 持久化
 */

export async function initializeCainFlowApp() {
const registry = createAppRegistry();

// ===== 工具函数 =====
function generateId() {
    return generateIdService();
}

function showToast(message, type = 'info', duration = 3000) {
    return getToastControllerApi().showToast(message, type, duration);
}

diskStorage.onError = (error) => showToast(`硬盘数据保存失败：${error.message || error}`, 'error', 8000);

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
    connectionProjectionInteractions.nodeGeometryChanged(
        textarea.closest?.('.node')?.dataset?.id || ''
    );
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

function addLog(type, title, message, details = null, meta = {}) {
    getLogPanelApi().addLog(type, title, message, details, meta);
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
    localStorageRef: diskStorage,
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
const canvasPerformanceMonitor = createCanvasPerformanceMonitor({
    globalRef: globalThis,
    getFixtureSize: () => ({
        nodeCount: state.nodes.size,
        connectionCount: state.connections.length
    }),
    performInteractionStep: (step) => getCanvasInteractionsApi().performSampleInteractionStep(step),
    performProjectionStep: () => registry.connectionProjectionApi?.maintenance.runPerformanceWorkload()
});
const canvasBenchmarkMode = new URLSearchParams(globalThis.location?.search || '').get('benchmark') === '1';

state.abortAllWorkflowRuns = (reason) => getWorkflowRuntimeManagerApi().abortAllWorkflowRuns(reason);
applyGlobalAnimationSettingService({ state, documentRef: document });
applyCanvasUiSettingService({ state, documentRef: document });

function scheduleConnectionRefresh(options = {}) {
    return registry.connectionProjectionApi?.scheduleLegacyRefresh(options) || false;
}

function flushConnectionRefresh(options = {}) {
    if (options.force === true) registry.connectionProjectionApi?.maintenance.connectionGeometryStyleChanged();
    return registry.connectionProjectionApi?.commit() || false;
}

const connectionProjectionInteractions = {
    beginInteraction: (kind, nodeIds) => registry.connectionProjectionApi?.interactions.beginInteraction(kind, nodeIds),
    nodeAppearanceChanged: (nodeIds) => registry.connectionProjectionApi?.interactions.nodeAppearanceChanged(nodeIds),
    nodeGeometryChanged: (nodeIds) => registry.connectionProjectionApi?.interactions.nodeGeometryChanged(nodeIds)
};

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
    saveWorkflowNodeMediaAsset,
    saveWorkflowNodeMediaAssets,
    cancelWorkflowNodeMediaOperation,
    releaseWorkflowNodeMediaAssets,
    releaseWorkflowMediaAssets,
    getStorageSafetyStatus,
    getMediaOwnerReferenceList,
    listMediaOwnerReferenceLists,
    recordMediaWorkflowRevision,
    replaceMediaOwnerReferenceList,
    saveWorkflowImportMediaAsset,
    getImageAsset,
    getImageAssetList,
    mediaAssetExists,
    deleteImageAsset,
    deleteImageImportAsset,
    clearImageImportAssets,
    clearImageAssets,
    clearOrphanedNodeAssets,
    referenceMediaAsset,
    removeMediaReference,
    putMediaAsset,
    clearOrphanedImageImportAssets,
    createThumbnail,
    createVideoThumbnail,
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
const renderProjectionManager = createRenderProjectionManager({
    state,
    canvasContainer,
    nodesLayer,
    documentRef: document,
    windowRef: window,
    performanceMonitor: canvasPerformanceMonitor
});
function focusCanvasNode(nodeId, { avoidAgentPanel = false, selectOnFocus = true } = {}) {
    const node = state.nodes.get(nodeId);
    const rect = canvasContainer?.getBoundingClientRect?.();
    if (!node || !rect) return false;
    const zoom = Number(state.canvas.zoom) || 1;
    const width = Number(node.width) || node.el?.offsetWidth || 220;
    const height = Number(node.height) || node.el?.offsetHeight || 140;
    const panel = avoidAgentPanel ? document.getElementById('prompt-agent-panel') : null;
    const panelRect = panel?.classList.contains('active') ? panel.getBoundingClientRect() : null;
    const visibleWidth = panelRect ? Math.min(rect.width, panelRect.left - rect.left - 12) : rect.width;
    const centerX = visibleWidth > 0 ? visibleWidth / 2 : rect.width / 2;
    state.canvas.x = centerX - (Number(node.x) + width / 2) * zoom;
    state.canvas.y = rect.height / 2 - (Number(node.y) + height / 2) * zoom;
    viewportApi.updateCanvasTransform({ connectionRefreshReason: 'node-failure-focus' });
    renderProjectionManager.focusNode(nodeId);
    if (selectOnFocus) selectNode(nodeId, false);
    return true;
}
function showWorkflowFailureSummary(failures = []) {
    if (failures.length < 2) return;
    const modal = document.getElementById('modal-node-failures');
    const title = document.getElementById('node-failures-title');
    const list = document.getElementById('node-failures-list');
    if (!modal || !list) return;
    if (title) title.textContent = `${failures.length} 个节点执行失败`;
    list.innerHTML = '';
    failures.forEach((failure) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'node-failure-list-item';
        const message = document.createElement('span');
        message.className = 'node-failure-list-item__message';
        message.textContent = `${failure.nodeTitle}：${failure.message}`;
        const action = document.createElement('span');
        action.textContent = '定位';
        button.append(message, action);
        button.addEventListener('click', () => {
            closeModal('modal-node-failures');
            focusCanvasNode(failure.nodeId);
            const log = state.logs?.find((entry) => entry.type === 'error' && entry.nodeId === failure.nodeId);
            if (log) getLogPanelApi().showLogDetail(log.id);
        });
        list.appendChild(button);
    });
    modal.classList.add('active');
}
document.addEventListener('cainflow:node-failure-clicked', (event) => {
    const nodeId = event.detail?.nodeId;
    const log = state.logs?.find((entry) => entry.type === 'error' && entry.nodeId === nodeId);
    if (log) getLogPanelApi().showLogDetail(log.id);
});
const interactionPerformanceGuard = createInteractionPerformanceGuard({
    state,
    canvasContainer,
    connectionsGroup,
    windowRef: window
});
const selectionApi = createSelectionApi({
    state,
    connectionProjection: connectionProjectionInteractions
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
    return collectRetainedNodeAssetIdsForWorkflows({
        nodes: state.nodes,
        workflowTabs: state.workflowTabs,
        activeWorkflowName: workflowManagerApi?.getActiveWorkflowName?.()
    });
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
            localStorageRef: diskStorage,
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
            localStorageRef: diskStorage
        });
    }
    return registry.requestStatisticsApi;
}

function getFloatingNoticesApi() {
    if (!registry.floatingNoticesApi) {
        registry.floatingNoticesApi = createFloatingNoticesController({
            container: elements.floatingNoticesContainer,
            localStorageRef: diskStorage
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

    notices.upsertNotice({
        id: 'workflow-backup',
        priority: 10,
        className: 'workflow-backup-notice',
        icon: '!',
        content: ['更新前请备份 ', { code: true, text: 'workflows 文件夹' }, '。'],
        dismissStorageKey: workflowBackupDismissStorageKey,
        dismissScope: 'session',
        dismissible: true,
        closeText: '本次隐藏',
        closeLabel: '本次不再显示工作流备份提醒'
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
    floatingNoticesApi: getFloatingNoticesApi(),
    localStorageRef: diskStorage
});
const helpPanelApi = createHelpPanelApi({
    canvasContainer,
    nodesLayer,
    panelManager
});
const settingsModal = document.getElementById('settings-modal');
let handleMissingMediaAction = async () => {};
const mediaControllerApi = createMediaControllerApi({
    pushHistory,
    state,
    getNodeById: (nodeId) => state.nodes.get(nodeId),
    getImageAsset,
    getImageAssetList,
    saveWorkflowImportMediaAsset,
    saveWorkflowNodeMediaAsset,
    saveWorkflowNodeMediaAssets,
    deleteImageAsset,
    processImageResolution,
    resizeImageData,
    detectOutputFormat,
    estimateDataUrlSize,
    getImageResolution,
    dataURLtoBlob,
    copyImageToClipboard: uiUtils.copyImageToClipboard,
    showToast,
    addLog,
    scheduleSave,
    onMediaIntegrityChanged: () => workflowManagerApi?.refreshActiveWorkflowIntegrityState?.(),
    onMissingMediaAction: (request) => handleMissingMediaAction(request),
    syncCameraControlNodePreview: (nodeId, imageValue) => cameraControlNodeApi.syncCameraControlFromExecution(nodeId, imageValue),
    syncClonesFromSource: (nodeId) => nodeDomBindingsApi?.syncClonesFromSource(nodeId),
    openImagePainter,
    getHistory,
    getHistoryMetadata,
    getHistoryEntry,
    fitNodeToContent,
    getActiveWorkflowId: () => workflowManagerApi?.getActiveWorkflowId?.() || '',
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
    addNode,
    performanceMonitor: canvasPerformanceMonitor
});
const diagnosticClient = createDiagnosticClient({ localStorageRef: diskStorage });
void diagnosticClient.status().catch(() => {});
let lastDiagnosticWarningAt = '';
async function checkDiagnosticHealth() {
    try {
        const status = await diagnosticClient.status();
        if (status?.degraded && status.lastError?.at && status.lastError.at !== lastDiagnosticWarningAt) {
            lastDiagnosticWarningAt = status.lastError.at;
            showToast('诊断记录写入失败，工作流可继续运行；请在常规设置中检查诊断状态。', 'warning', 7000);
        }
    } catch { /* diagnostic health checks never block the application */ }
}
window.setTimeout?.(checkDiagnosticHealth, 5000);
window.setInterval?.(checkDiagnosticHealth, 60000);
const {
    showResolutionBadge,
    setupImageImport,
    loadImageFile,
    loadImageData,
    waitForPendingImageImports,
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
        if (node?.type === 'ImageSave') {
            return createEditedImageImport({
                sourceNode: node, dataUrl, addNode, loadImageData, removeNode, selectNode
            });
        }
        return false;
    },
    scheduleSave,
    showToast
});
const nodeDomBindingsApi = createNodeDomBindingsApi({
    state,
    selectionApi,
    canvasContainer,
    connectionsGroup,
    tempConnection,
    viewportApi,
    getCachedOutputValue: (node, port) => getExecutionCoreApi().getCachedOutputValue(node, port),
    getPortPosition: (nodeId, portName, direction) => getPortPosition(nodeId, portName, direction),
    pushHistory,
    removeNode: (nodeId, options) => removeNode(nodeId, options),
    selectNode: (nodeId, isMulti) => selectNode(nodeId, isMulti),
    toggleNodesEnabled: (nodeIds, referenceNodeId) => toggleNodesEnabled(nodeIds, referenceNodeId),
    cancelRunningNode: (nodeId) => cancelRunningNode(nodeId),
    handleBatchConnectionNodeMouseDown: (event, nodeId) => getBatchConnectionModeApi().handleNodeMouseDown(event, nodeId),
    finishConnection: (src, tgt) => finishConnection(src, tgt),
    updateConnectionTargetFeedback: (src) => updateConnectionTargetFeedback(src),
    clearConnectionTargetFeedback: () => clearConnectionTargetFeedback(),
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
    connectionProjection: connectionProjectionInteractions,
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
    beginConnectionRestoration,
    updateDirtyConnections,
    detectMisalignedConnections,
    clearConnectionInsertPreview,
    commitConnectionInsertPreview,
    getCompatibleNodeTypeCandidates,
    createNodeFromConnectionCandidate,
    finishConnection,
    getNearestConnectionTarget,
    updateConnectionTargetFeedback,
    clearConnectionTargetFeedback,
    drawTempConnection,
    updatePortStyles
} = connectionsApi;

registry.connectionProjectionApi = createConnectionProjection({
    projectionHandoffAdapter: connectionsApi.projectionHandoffAdapter,
    updateAllConnections,
    refreshNodeProjection: () => renderProjectionManager.refreshNow(),
    beginConnectionRestoration,
    updateDirtyConnections,
    invalidateNodePortCache,
    markConnectionDirty,
    markNodeConnectionsDirty,
    detectMisalignedConnections,
    onAlignmentCorrected: ({ mismatches, reason }) => diagnosticClient.recordCanvasBatch(mismatches.map((mismatch) => ({
        reason,
        connectionId: mismatch.connectionId,
        from: mismatch.from,
        to: mismatch.to,
        expected: mismatch.expected,
        actual: mismatch.actual,
        canvas: mismatch.canvas
    }))),
    onAlignmentRepairFailed: ({ error, reason }) => console.error(
        `Connection alignment repair failed (${reason}):`,
        error
    ),
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
    const result = getNodeLifecycleApi().selectNode(id, isMulti);
    registry.promptAgentController?.refreshActionStates?.();
    return result;
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

async function runWorkflow(runInput = null, { waitForCompletion = false, retainResults, configurationSnapshot, validateBeforeRun } = {}) {
    if (state.canvasPlanApplying) throw new Error('画布方案正在应用，请稍后运行');
    if (state.isRunStarting) return false;
    const requestedWorkflowId = workflowManagerApi.getActiveWorkflowId();
    state.isRunStarting = true;
    getWorkflowRuntimeManagerApi().syncGlobalRunToolbarState();
    try {
        await waitForRunStartFrame();
        if (!(await workflowManagerApi.ensureOpenWorkflow())) return false;
        const effectiveRequestedWorkflowId = requestedWorkflowId || workflowManagerApi.getActiveWorkflowId();
        await waitForPendingImageImports();
        if (workflowManagerApi.getActiveWorkflowId() !== effectiveRequestedWorkflowId) {
            showToast('工作流已切换，请在目标工作流重新运行', 'warning');
            return false;
        }
        const workflowName = workflowManagerApi.getActiveWorkflowName();
        if (!workflowName) {
            showToast('请先打开或新建一个工作流', 'warning');
            return false;
        }
        const preparedWorkflowId = workflowManagerApi.getActiveWorkflowId();
        validateBeforeRun?.();
        runInput = prepareGenerationSaveTargets({
            state, runInput,
            resolveExecutionPlan: (input) => getExecutionCoreApi().resolveExecutionPlan(input),
            normalizeRunOptions: (input) => getExecutionCoreApi().normalizeRunOptions(input),
            addNode, generateId, scheduleSave, addLog,
            isWorkflowCurrent: () => workflowManagerApi.getActiveWorkflowId() === preparedWorkflowId,
            onConnectionsChanged: (changes) => {
                registry.connectionProjectionApi?.interactions.topologyChanged(changes);
                updatePortStyles();
                handleNodeGraphChanged();
            }
        });
        const workflowData = workflowManagerApi.getActiveWorkflowRuntimeData?.()
            || workflowManagerApi.getActiveWorkflowSnapshot();
        const workflowId = workflowManagerApi.getActiveWorkflowId?.() || workflowData?.workflowId || '';
        // Forward the completion promise without holding the launch guard for
        // the full generation; other workflow branches can still be started.
        return getWorkflowRuntimeManagerApi().runWorkflowInContext({ workflowName, workflowId }, workflowData, runInput, { waitForCompletion, retainResults, configurationSnapshot });
    } catch (error) {
        showToast(error?.message || '无法启动工作流', 'warning');
        if (waitForCompletion) throw error;
        return false;
    } finally {
        state.isRunStarting = false;
        getWorkflowRuntimeManagerApi().syncGlobalRunToolbarState();
    }
}

function cancelRunningNode(nodeId) {
    return getWorkflowRuntimeManagerApi().cancelRunningNode({
        workflowName: workflowManagerApi.getActiveWorkflowName(),
        workflowId: workflowManagerApi.getActiveWorkflowId()
    }, nodeId)
        || getWorkflowRunnerApi().cancelRunningNode(nodeId);
}

// ===== 持久化 =====
function scheduleSave(options) {
    return getSessionManagerApi().scheduleSave(options);
}

const promptAgentNodeAdapter = createPromptAgentNodeAdapter({
    state,
    documentRef: document,
    scheduleSave,
    commitReferenceConnections: (connections) => {
        pushHistory();
        state.connections = connections;
        connectionsApi.updateAllConnections();
        connectionsApi.updatePortStyles();
        handleNodeGraphChanged();
    },
    createImageNode: ({ model, provider, prompt }) => {
        const rect = canvasContainer.getBoundingClientRect();
        const panel = document.getElementById('prompt-agent-panel');
        const panelWidth = panel?.classList.contains('active') ? panel.getBoundingClientRect().width : 0;
        const width = NODE_CONFIGS.ImageGenerate.defaultWidth;
        const origin = viewportApi.screenToCanvas(
            rect.left + Math.max(32, (rect.width - panelWidth) / 2), rect.top + 48
        );
        const position = findAgentImageNodePosition({ centerX: origin.x, y: origin.y, width,
            occupiedNodes: [...state.nodes.values()], zoom: state.canvas.zoom });
        const nodeId = addNode('ImageGenerate', position.x, position.y, {
            prompt, apiConfigId: model.id, providerId: provider.id
        });
        if (nodeId) scheduleSave();
        return nodeId;
    },
    getNodeImages: async (node) => (await mediaControllerApi.getNodeFullscreenImageContext(node.id)).images,
    resolveImageSource: async (source) => {
        if (/^data:image\//i.test(source)) return source;
        if (!/^https?:\/\//i.test(source)) throw new Error('图片来源不可用，请重新导入图片。');
        return blobToDataUrl(await getExecutionCoreApi().downloadGeneratedImage(source));
    }
});
const promptAgentExecutionAdapter = createPromptAgentExecutionAdapter({
    state,
    nodeAdapter: promptAgentNodeAdapter,
    runWorkflow: (runInput, options) => runWorkflow(runInput, { ...options, waitForCompletion: true }),
    cancelRunningNode,
    focusNode: (nodeId) => focusCanvasNode(nodeId, { avoidAgentPanel: true, selectOnFocus: false })
});
const promptAgentModelPreference = createAgentChatModelPreference({ storage: diskStorage,
    legacyStorage: { getItem: key => window.localStorage.getItem(key) } });
const getPromptAgentModelId = promptAgentModelPreference.get;
const setPromptAgentModelId = promptAgentModelPreference.set;
migrateAutoCompactTokens(diskStorage, state.models, getPromptAgentModelId());
const promptAgentResultPersistence = createPromptAgentResultPersistence({
    media: createPromptAgentResultMediaAdapter({
        saveWorkflowNodeMediaAssets, releaseWorkflowNodeMediaAssets, cancelWorkflowNodeMediaOperation, getImageAsset
    }),
    mutateConversation: (workflowId, reducer) => workflowManagerApi.mutatePromptAgentByWorkflowId(workflowId, reducer),
    saveConversation: () => flushSessionToDisk(getSessionManagerApi(), diskStorage),
    onChange: workflowId => {
        if (workflowManagerApi.getActiveWorkflowId() === workflowId) registry.promptAgentController?.refreshResults();
    }
});
const readAgentWebImage = createAgentWebImageReader();
const captureAgentRequestConfig = (modelId) => {
    const models = getAvailablePromptAgentModels(state.models || [], state.providers || []);
    return JSON.parse(JSON.stringify({ workflowId: workflowManagerApi.getActiveWorkflowId(), models, model: models.find(item => item.id === modelId), providers: state.providers || [] }));
};
const promptAgentController = createPromptAgentController({
    canvasAdapter: createPromptAgentCanvasAdapter({
        state, documentRef: document, serializeNodes: () => nodeSerializer.serializeNodes(),
        getWorkflowId: () => workflowManagerApi.getActiveWorkflowId(), addNode,
        nodeAdapter: promptAgentNodeAdapter, session: getSessionManagerApi,
        save: () => workflowManagerApi.saveActiveWorkflow({ silent: true }),
        graphChanged: () => { connectionsApi.updateAllConnections(); connectionsApi.updatePortStyles(); handleNodeGraphChanged(); },
        origin: () => {
            const rect = canvasContainer.getBoundingClientRect();
            const panel = document.getElementById('prompt-agent-panel');
            const bounds = panel?.classList.contains('active') ? panel.getBoundingClientRect() : null;
            return { ...viewportApi.screenToCanvas(rect.left + 24, rect.top + 72),
                ...(bounds ? { blockedSpan: { ...viewportApi.screenToCanvas(bounds.left - 16, bounds.top - 16),
                    width: (bounds.width + 32) / state.canvas.zoom, height: (bounds.height + 32) / state.canvas.zoom } } : {}) };
        },
        getImageAsset, runWorkflow: (input, options) => runWorkflow(input, { ...options, waitForCompletion: true }),
        cancelNode: cancelRunningNode, focusNode: (nodeId) => focusCanvasNode(nodeId, { avoidAgentPanel: true, selectOnFocus: false })
    }),
    panelManager,
    getSearchModels: () => state.models.filter(model => !model.taskType || model.taskType === 'chat'),
    getProviders: () => state.providers,
    documentRef: document,
    captureRequestConfig: captureAgentRequestConfig,
    readWebImage: readAgentWebImage,
    referenceSource: createPromptAgentReferenceSource({
        state, nodeAdapter: promptAgentNodeAdapter, getHistoryMetadata, getHistoryEntry, getImageAsset, readWebImage: readAgentWebImage,
        scheduleSave, loadImageData: (id, data) => mediaControllerApi.loadImageData(id, data),
        createImportNode: ({ name, slot }) => {
            const rect = canvasContainer.getBoundingClientRect();
            const panel = document.getElementById('prompt-agent-panel').getBoundingClientRect();
            const width = NODE_CONFIGS.ImageImport.defaultWidth || 300;
            const columns = Math.max(1, Math.floor((panel.left - rect.left - 32) / ((width + 24) * state.canvas.zoom)));
            const origin = viewportApi.screenToCanvas(rect.left + 24, rect.top + 72);
            const height = 320;
            let position;
            for (let offset = 0; offset <= state.nodes.size * columns + columns; offset++) {
                const index = slot + offset;
                position = { x: origin.x + (index % columns) * (width + 24), y: origin.y + Math.floor(index / columns) * (height + 24) };
                if ([...state.nodes.values()].every(node => position.x + width + 12 <= node.x || position.x >= node.x + (node.width || width) + 12
                    || position.y + height + 12 <= node.y || position.y >= node.y + (node.el?.offsetHeight || height) + 12)) break;
            }
            return addNode('ImageImport', position.x, position.y, { customTitle: name });
        }
    }),
    getPanelWidth: () => diskStorage.getItem('cainflow_prompt_agent_panel_width'),
    setPanelWidth: (width) => diskStorage.setItem('cainflow_prompt_agent_panel_width', String(width)),
    getAutoCompactTokenLimit: () => readAutoCompactTokens(diskStorage),
    nodeAdapter: promptAgentNodeAdapter,
    executionAdapter: promptAgentExecutionAdapter,
    getWorkflowId: () => workflowManagerApi.getActiveWorkflowId(),
    mutateWorkflowConversation: (workflowId, reducer) => workflowManagerApi.mutatePromptAgentByWorkflowId(workflowId, reducer),
    resultPersistence: promptAgentResultPersistence,
    loadResultImages: (keys) => Promise.all(keys.map(async (key) => {
        try { return await getImageAsset(key) || null; } catch { return null; }
    })),
    openResultPreview: (images, index, options = {}) => openFullscreenPreview(images[index], null, { images, index, ...options }),
    getChatModels: () => getAvailablePromptAgentModels(state.models || [], state.providers || []),
    getImageModels: () => getAvailablePromptAgentImageModels(state.models || [], state.providers || []),
    openModelSettings: target => settingsControllerApi?.openModelSettings?.(target),
    getSelectedModelId: getPromptAgentModelId,
    setSelectedModelId: setPromptAgentModelId,
    getSelectedCompactionModelId: () => readCompactionModelId(diskStorage),
    createReply: (request) => {
        const { model, models, providers, providerId, workflowId, searchProviders = {} } = request.config || captureAgentRequestConfig(request.modelId);
        return createPromptAgentModelReply({
            ...request,
            model, models, providers, providerId, workflowId,
            searchSettings: { ...request.searchSettings, providerId: searchProviders[request.searchSettings?.modelId] || '' },
            recordRequest: record => getRequestStatisticsApi().recordRequest(record),
            getCanvasImage: getImageAsset,
            getHeaders: (plan) => getProxyHeaders(plan.url, 'POST', plan.model?.protocol === 'openai'
                ? { Authorization: `Bearer ${plan.provider?.apikey || ''}` } : {})
        });
    },
    createCompaction: (request) => {
        const { model, providers, providerId, workflowId } = request.config || captureAgentRequestConfig(request.modelId);
        return createPromptAgentCompaction({
            ...request,
            model,
            providers, providerId, workflowId,
            recordRequest: record => getRequestStatisticsApi().recordRequest(record),
            getHeaders: (plan) => getProxyHeaders(plan.url, 'POST', plan.model?.protocol === 'openai'
                ? { Authorization: `Bearer ${plan.provider?.apikey || ''}` } : {})
        });
    },
    onStateChange: () => {
        workflowManagerApi.markActiveWorkflowDirty();
        scheduleSave({ dirty: false });
        settingsControllerApi?.updateAgentCacheUsage();
    }
});
registry.promptAgentController = promptAgentController;

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

async function redo() {
    return getSessionManagerApi().redo();
}

function getSessionManagerApi() {
    if (!registry.sessionManagerApi) {
        registry.sessionManagerApi = createSessionManagerApi({
            state,
            selectionApi,
            storageKey: STORAGE_KEY,
            localStorageRef: diskStorage,
            nodeSerializer,
            showToast,
            addNode,
            updateAllConnections,
            updatePortStyles,
            onConnectionsChanged: () => handleNodeGraphChanged(),
            persistHistoryTransition: () => workflowManagerApi?.persistActiveHistoryTransition?.(),
            getWorkflowSnapshot: () => workflowManagerApi?.workflowDesk?.snapshot?.()
                || Object.freeze({ active: null, open: Object.freeze([]) }),
            removeMediaReference,
            mediaAssetExists,
            undoMedia: createBrowserUndoMediaProtection(error => showToast(error.message, 'error')),
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
            selectionApi,
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
            selectionApi,
            canvasContainer,
            nodesLayer,
            tempConnection,
            viewportApi,
            getPortPosition,
            drawTempConnection,
            finishConnection,
            getNearestConnectionTarget,
            updateConnectionTargetFeedback,
            clearConnectionTargetFeedback,
            updateAllConnections,
            updateDirtyConnections,
            scheduleConnectionRefresh,
            connectionProjection: connectionProjectionInteractions,
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
            getActiveWorkflowId: () => workflowManagerApi?.getActiveWorkflowId?.() || '',
            saveViewportState: (viewportState) => getSessionManagerApi().saveViewportState(viewportState),
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
            selectionApi,
            canvasContainer,
            viewportApi,
            runWorkflow,
            saveState,
            saveCurrentWorkflow: () => workflowManagerApi.saveActiveWorkflow(),
            undo,
            redo,
            exportWorkflow: (...args) => projectIoFeature.exportWorkflow(...args),
            importWorkflow: (...args) => projectIoFeature.importWorkflow(...args),
            showToast,
            scheduleSave,
            updateAllConnections,
            autoArrangeNodes,
            focusNode: (nodeId) => {
                selectNode(nodeId, false);
                return focusCanvasNode(nodeId);
            },
            saveViewportState: () => getSessionManagerApi().saveViewportState({
                workflowId: workflowManagerApi.getActiveWorkflowId(), canvas: state.canvas
            }),
            cleanupNodeElement: (node) => node?.el && cleanupNodeElement(node),
            clearUndoStack: () => {
                getSessionManagerApi().clearUndoStack();
            },
            clearImageAssets,
            clearWorkflowAssets: (options) => workflowManagerApi.cleanupOpenWorkflowAssets(options),
            updateCacheUsage: () => settingsControllerApi?.updateCacheUsage()
        });
    }
    return registry.toolbarControllerApi;
}

function getWorkspaceModeControllerApi() {
    if (!registry.workspaceModeControllerApi) {
        registry.workspaceModeControllerApi = createWorkspaceModeController({
            state,
            documentRef: document,
            saveState
        });
    }
    return registry.workspaceModeControllerApi;
}

function getConversationWorkbenchControllerApi() {
    if (!registry.conversationWorkbenchControllerApi) {
        registry.conversationWorkbenchControllerApi = createConversationWorkbenchController({
            state,
            documentRef: document,
            showToast,
            executionService: getConversationExecutionServiceApi(),
            imageGenerationService: getConversationImageGenerationServiceApi(),
            openSettings: () => document.getElementById('btn-settings')?.click(),
            getHistoryEntry,
            getHistoryMetadata,
            putMediaAsset,
            removeMediaReference,
            materializeMessage: async ({ message, textNodeType }) => {
                const workflowId = workflowManagerApi.getActiveWorkflowId?.() || '';
                if (!workflowId) throw new Error('请先打开目标工作流');
                const canvasRect = canvasContainer.getBoundingClientRect();
                const zoom = Number(state.canvas.zoom) || 1;
                const origin = {
                    x: (canvasRect.width / 2 - state.canvas.x) / zoom,
                    y: (canvasRect.height / 2 - state.canvas.y) / zoom
                };
                const plan = buildCanvasMaterializationPlan({
                    workflowId,
                    messageId: message.id,
                    textNodeType,
                    text: (message.parts || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('\n'),
                    media: (message.parts || []).filter((part) => part.type === 'media').map((part) => ({
                        assetKey: part.assetKey, mediaType: part.mediaType || 'image', missing: part.missing === true
                    })),
                    origin
                });
                const preview = plan.nodes.map((node) => `${node.type} @ (${Math.round(node.x)}, ${Math.round(node.y)})`).join('\n');
                if (!confirm(`将向当前工作流添加：\n${preview}\n\n资源引用将复用现有 Media asset。是否继续？`)) return { status: 'cancelled', nodeIds: [] };
                const command = createCanvasMaterializationCommand({
                    addNode,
                    removeNode,
                    pushHistory,
                    discardHistory: (token) => getSessionManagerApi().discardLatestHistory(token),
                    selectNode,
                    save: () => workflowManagerApi.saveActiveWorkflow({ silent: true }),
                    switchToCanvas: () => getWorkspaceModeControllerApi().activate('canvas'),
                    focusNode: (nodeId) => renderProjectionManager.focusNode(nodeId)
                });
                return command.apply(plan, { confirmed: true });
            },
            getActiveWorkflow: () => ({
                id: workflowManagerApi.getActiveWorkflowId?.() || '',
                label: workflowManagerApi.getActiveWorkflowName?.() || '',
                revision: workflowManagerApi.getActiveWorkflowSnapshot?.()?.mediaOwnershipRevision
                    ?? workflowManagerApi.getActiveWorkflowSnapshot?.()?.revision ?? 0
            }),
            onToolbarStateChange: (snapshot) => registry.conversationToolbarControllerApi?.sync(snapshot)
        });
    }
    return registry.conversationWorkbenchControllerApi;
}

function getConversationToolbarControllerApi() {
    if (!registry.conversationToolbarControllerApi) {
        registry.conversationToolbarControllerApi = createConversationToolbarController({
            documentRef: document,
            workspaceModeController: getWorkspaceModeControllerApi(),
            conversationWorkbenchController: getConversationWorkbenchControllerApi(),
            showToast
        });
    }
    return registry.conversationToolbarControllerApi;
}

function getConversationExecutionServiceApi() {
    if (!registry.conversationExecutionServiceApi) {
        registry.conversationExecutionServiceApi = createConversationExecutionService({
            api: conversationApi,
            createPlan: createChatRequestPlan,
            executePlan: (plan, options) => requestChatCompletion(plan, {
                ...options,
                fetchRef: fetch,
                headers: getProxyHeaders(plan.url, 'POST', plan.protocol === 'openai'
                    ? { Authorization: `Bearer ${plan.provider.apikey}` }
                    : {})
            }),
            onStateChange: (conversationId, runState) => {
                getConversationWorkbenchControllerApi().projectRunState(conversationId, runState);
            },
            onMessagePersisted: (conversationId, message, metadata) => {
                getConversationWorkbenchControllerApi().projectPersistedMessage(conversationId, message, metadata);
            },
            resolveMediaAsset: async (assetKey) => {
                const value = await getImageAsset(assetKey);
                if (!value) return null;
                return value instanceof Blob ? blobToDataUrl(value) : value;
            }
        });
    }
    return registry.conversationExecutionServiceApi;
}

function getConversationImageGenerationServiceApi() {
    if (!registry.conversationImageGenerationServiceApi) {
        registry.conversationImageGenerationServiceApi = createConversationImageGenerationService({
            ensureWorkflow: () => workflowManagerApi.ensureOpenWorkflow(),
            createImageNode: ({ prompt, model, provider }) => addNode('ImageGenerate', 160, 120, {
                prompt,
                apiConfigId: model.id,
                providerId: provider.id,
                imageResultPersistence: 'transient'
            }),
            executeImageNode: (node, signal) => getExecutionCoreApi().executeNode(node, {}, signal),
            onStateChange: (conversationId, runState) => {
                getConversationWorkbenchControllerApi().projectRunState(conversationId, runState);
            }
        });
    }
    return registry.conversationImageGenerationServiceApi;
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
            copyToClipboard,
            localStorageRef: diskStorage
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
            selectionApi,
            canvasContainer,
            contextMenu,
            connectionCreatePopup,
            viewportApi,
            addNode,
            copySelectedNode,
            copyNodeImageToClipboard: (nodeId, source) => mediaControllerApi.copyNodeImageToClipboard(nodeId, source),
            pasteNode,
            removeNode,
            cloneNode: (nodeId, count, options) => getNodeLifecycleApi().cloneNode(nodeId, count, options),
            detachCloneNode: (nodeId) => getNodeLifecycleApi().detachCloneNode(nodeId),
            renameNode,
            runWorkflow,
            getRunConflictInfo: (runInput) => {
                const workflowName = workflowManagerApi.getActiveWorkflowName();
                if (!workflowName) return { blocked: false, count: 0, nodeIds: [] };
                const workflowData = workflowManagerApi.getActiveWorkflowRuntimeData?.()
                    || workflowManagerApi.getActiveWorkflowSnapshot();
                return getWorkflowRuntimeManagerApi().getRunConflictInfo({
                    workflowName,
                    workflowId: workflowManagerApi.getActiveWorkflowId?.() || workflowData?.workflowId || ''
                }, workflowData, runInput);
            },
            buildNodeRequestPreview: (nodeId) => getExecutionCoreApi().buildNodeRequestPreview(nodeId),
            enterBatchConnectionMode: (nodeId) => getBatchConnectionModeApi().enter(nodeId),
            createNodeFromConnectionCandidate: (source, candidate, x, y) => createNodeFromConnectionCandidate(source, candidate, x, y),
            fitNodeToContent,
            updateAllConnections,
            connectionProjection: connectionProjectionInteractions,
            updatePortStyles,
            pushHistory,
            scheduleSave,
            showToast
        });
    }
    return registry.contextMenuControllerApi;
}

function getErrorModalControllerApi() {
    if (!registry.errorModalControllerApi) {
        registry.errorModalControllerApi = createErrorModalControllerApi({
            documentRef: document,
            onLocateNode: (nodeId) => getWorkflowRunnerApi().focusNode(nodeId)
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
            onThemeApplied: () => {
                viewportApi.refreshCanvasThemeMetrics();
                viewportApi.applyCanvasVisualTransform();
            }
        });
    }
    return registry.themeControllerApi;
}

function getNodeLifecycleApi() {
    if (!registry.nodeLifecycleApi) {
        registry.nodeLifecycleApi = createNodeLifecycleApi({
            state,
            selectionApi,
            nodeConfigs: NODE_CONFIGS,
            createNodeMarkup,
            nodesLayer,
            generateId,
            getImageAsset,
            getImageAssetList,
            saveWorkflowImportMediaAsset,
            deleteImageImportAsset,
            showResolutionBadge,
            restoreImageResizePreview,
            renderImageImportUploadState: (nodeId, imageData) => mediaControllerApi.renderImageImportUploadState(nodeId, imageData),
            renderImagePreviewImage: (nodeId, images, emptyMessage) => mediaControllerApi.renderImagePreviewImage(nodeId, images, emptyMessage),
            renderImageSavePreview: (nodeId, images, emptyMessage) => mediaControllerApi.renderImageSavePreview(nodeId, images, emptyMessage),
            renderImageComparePreview: (nodeId, imageA, imageB) => mediaControllerApi.renderImageComparePreview(nodeId, imageA, imageB),
            bindNodeInteractions: ({ id, type, el }) => nodeDomBindingsApi.bindNodeInteractions({ id, type, el }),
            onNodesRemoved: (ids) => registry.promptAgentController?.removeNodeReferences(ids),
            serializeOneNode,
            pushHistory,
            scheduleSave,
            showToast,
            updateAllConnections,
            updateDirtyConnections,
            scheduleConnectionRefresh,
            connectionProjection: connectionProjectionInteractions,
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
            redo,
            copySelectedNode,
            pasteNode,
            clipboardControllerApi: getClipboardControllerApi(),
            removeNode,
            zoomToFit,
            scheduleSave,
            scheduleConnectionRefresh,
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
            loadState: canvasBenchmarkMode ? async () => false : (...args) => projectIoFeature.loadState(...args),
            showToast,
            syncProxyToServer: () => settingsFeature.syncProxyToServer(),
            checkNetworkConnectivity: (options) => settingsFeature.checkNetworkConnectivity(options),
            checkNetworkProxyMismatch: (force = false) => settingsFeature.checkNetworkProxyMismatch(force),
            ensureOpenWorkflow: canvasBenchmarkMode ? async () => true : () => workflowManagerApi.ensureOpenWorkflow(),
            applyWorkspaceMode: (mode) => getWorkspaceModeControllerApi().activate(mode, { persist: false }),
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
            saveWorkflowNodeMediaAsset,
            saveWorkflowNodeMediaAssets,
            cancelWorkflowNodeMediaOperation,
            releaseWorkflowNodeMediaAssets,
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
            getActiveWorkflowId: () => workflowManagerApi.getActiveWorkflowId?.() || '',
            getAbortMessage: getAbortMessageService,
            connectionProjection: connectionProjectionInteractions,
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
            connectionProjection: connectionProjectionInteractions,
            updatePortStyles,
            getImageAsset,
            getImageAssetList,
            deleteImageAsset,
            saveWorkflowNodeMediaAssets,
            releaseWorkflowNodeMediaAssets,
            getActiveWorkflowId: () => workflowManagerApi.getActiveWorkflowId?.() || '',
            syncImagePreviewNode: (nodeId, imageData) => mediaControllerApi.syncImagePreviewNode(nodeId, imageData),
            syncImageSaveNode: (nodeId, imageData) => mediaControllerApi.syncImageSaveNode(nodeId, imageData),
            refreshDependentImageResizePreviews,
            getAbortMessage: getAbortMessageService,
            playNotificationSound: () => settingsControllerApi.playNotificationSound(),
            systemNotificationApi: getSystemNotificationApi(),
            focusCanvasNode,
            onWorkflowFailures: showWorkflowFailureSummary,
            onNodeRunStateChange: (payload) => {
                if (payload?.nodeId) nodeDomBindingsApi.syncDependentPromptSources(payload.nodeId);
                const activeWorkflow = workflowManagerApi.getActiveWorkflow();
                if (activeWorkflow?.workflowId) {
                    getWorkflowRuntimeManagerApi().applyVisibleNodeRunState({
                        workflowId: activeWorkflow.workflowId,
                        workflowName: activeWorkflow.label || ''
                    }, payload);
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
            connectionProjection: connectionProjectionInteractions,
            updatePortStyles,
            getWorkflowManagerApi: () => workflowManagerApi,
            getWorkflowDesk: () => workflowManagerApi.workflowDesk,
            getSettingsControllerApi: () => settingsControllerApi,
            getSystemNotificationApi,
            getImageAsset,
            getImageAssetList,
            deleteImageImportAsset,
            deleteImageAsset,
            saveWorkflowNodeMediaAsset,
            saveWorkflowNodeMediaAssets,
            releaseWorkflowNodeMediaAssets,
            referenceMediaAsset,
            removeMediaReference,
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
            visibleNodesLayer: nodesLayer,
            bindVisibleNodeInteractions: ({ id, type, el }) => nodeDomBindingsApi.bindNodeInteractions({ id, type, el }),
            visibleConnectionProjectionMaintenance: registry.connectionProjectionApi.maintenance,
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
getWorkspaceModeControllerApi().init();

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
    selectionApi,
    nodeSerializer,
    viewportApi,
    addNode,
    updateAllConnections,
    updatePortStyles,
    onConnectionsChanged: () => handleNodeGraphChanged(),
    scheduleSave,
    saveSession: async () => {
        if (!saveState()) return false;
        await diskStorage.flushPromise;
        return diskStorage.lastError === null;
    },
    showToast,
    panelManager,
    clearImageAssets,
    clearOrphanedNodeAssets,
    referenceMediaAsset,
    removeMediaReference,
    releaseWorkflowMediaAssets,
    getStorageSafetyStatus,
    getMediaOwnerReferenceList,
    listMediaOwnerReferenceLists,
    recordMediaWorkflowRevision,
    replaceMediaOwnerReferenceList,
    putMediaAsset,
    getImageAsset,
    getImageAssetList,
    deleteImageAsset,
    clearUndoStack: () => {
        getSessionManagerApi().clearUndoStack();
    },
    updateCacheUsage: () => settingsControllerApi?.updateCacheUsage(),
    recordWorkflowDiagnostic: (record) => diagnosticClient.recordWorkflow({
        ...record,
        id: record.workflowId || record.duplicatedWorkflowId || '',
        error: record.kind === 'workflow-duplicate-identity-repaired'
            ? 'Duplicate Workflow identity repaired'
            : record.error
    }),
    onWorkflowViewApplied: (workflow) => {
        getWorkflowRuntimeManagerApi().refreshVisibleWorkflowRunState(workflow);
        const tab = (state.workflowTabs || []).find((candidate) => candidate.workflowId === workflow?.workflowId);
        promptAgentController.restoreWorkflow(tab?.data?.promptAgent || null);
        settingsControllerApi?.updateAgentCacheUsage();
    },
    getPromptAgentState: () => promptAgentController.snapshotWorkflow(),
    applyPromptAgentState: (value) => promptAgentController.syncWorkflowState(value),
    refreshRecoverableMediaNodes: () => mediaControllerApi?.refreshAllRecoverableMediaNodes?.({ cascade: true }),
    waitForImageRestores: () => getNodeLifecycleApi().waitForImageRestores(),
    beginMediaRestoreBatch,
    endMediaRestoreBatch,
    finalizeMediaRestoreBatch,
    prepareDetachedEditorView: (workflowName, workflowData) => {
        const workflowId = workflowData?.workflowId || '';
        const storedViewport = getSessionManagerApi().loadViewportState(workflowId);
        const restoredWorkflowData = storedViewport
            ? { ...workflowData, canvas: { ...(workflowData?.canvas || {}), ...storedViewport } }
            : workflowData;
        return getWorkflowRuntimeManagerApi().prepareEditorView({ workflowName, workflowId }, restoredWorkflowData);
    },
    releaseDetachedEditorView: (workflow) => getWorkflowRuntimeManagerApi().releaseEditorView(workflow),
    localStorageRef: diskStorage
});

handleMissingMediaAction = createMissingMediaBrowserActions({
    state,
    workflowManager: workflowManagerApi,
    getMediaOwnerReferenceList,
    getStorageSafetyStatus,
    saveWorkflowNodeMediaAsset,
    downloadRemoteMedia: (url, mediaType, signal) => mediaType === 'video'
        ? getExecutionCoreApi().downloadGeneratedVideo(url, { signal })
        : getExecutionCoreApi().downloadGeneratedImage(url, signal),
    recoverTaskMedia: async (nodeId, mediaType, signal) => {
        return mediaType === 'video'
            ? getExecutionCoreApi().recoverVideoTaskMedia(nodeId, signal)
            : getExecutionCoreApi().recoverAsyncImageTaskMedia(nodeId, signal);
    },
    pushHistory,
    showToast
});

function refreshImageGenerateNodes(protocolId) {
    const nodeIds = [];
    state.nodes.forEach((node, nodeId) => {
        if (node.type === 'ImageGenerate') {
            nodeIds.push(nodeId);
            const nodeEl = node.el;
            if (!nodeEl) return;

            // 触发节点重新渲染以更新协议相关的UI
            nodeDomBindingsApi?.syncNodeProviderOptions?.(nodeId, 'ImageGenerate');
            nodeDomBindingsApi?.syncImageGenerateResolutionOptions?.(nodeId);
        }
    });
    connectionProjectionInteractions.nodeGeometryChanged(nodeIds);
}

function refreshVideoGenerateNodes() {
    const nodeIds = [];
    state.nodes.forEach((node, nodeId) => {
        if (node.type !== 'VideoGenerate') return;
        nodeIds.push(nodeId);
        nodeDomBindingsApi?.syncVideoGenerateProtocolFields?.(nodeId);
        fitNodeToContent(nodeId, { reason: 'protocol-registry-loaded' });
    });
    connectionProjectionInteractions.nodeGeometryChanged(nodeIds);
}

settingsFeature = createSettingsFeature({
    appVersion: APP_VERSION,
    githubRepo: GITHUB_REPO,
    state,
    storeHistoryName: STORE_HISTORY,
    storeAssetsName: STORE_ASSETS,
    openDB,
    saveHandle,
    getHandle,
    deleteHandle,
    showToast,
    saveState: (...args) => {
        const saved = saveState(...args);
        promptAgentController.refreshModels();
        return saved;
    },
    addLog,
    checkUpdate: (isManual) => updateManager.checkUpdate(isManual),
    downloadLatestUpdate: () => updateManager.downloadLatestUpdate(),
    cancelUpdateDownload: () => updateManager.cancelUpdateDownload(),
    updateAllConnections,
    connectionProjection: connectionProjectionInteractions,
    applyGlobalAnimationSetting,
    applyCanvasUiSetting,
    fitNodeToContent,
    getActiveWorkflowId: () => workflowManagerApi.getActiveWorkflowId(),
    getPromptAgentCacheState: () => ({
        workflows: state.workflowTabs || [],
        activeWorkflowId: workflowManagerApi.getActiveWorkflowId(),
        activeConversation: promptAgentController.snapshotWorkflow()
    }),
    floatingNoticesApi: getFloatingNoticesApi(),
    refreshImageGenerateNodes,
    refreshVideoGenerateNodes,
    diagnosticClient,
    localStorageRef: diskStorage,
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
    createVideoThumbnail,
    updateHistoryThumb,
    clearHistory,
    deleteHistoryEntry,
    getImageResolution,
    downloadImage,
    copyToClipboard,
    copyImageToClipboard: uiUtils.copyImageToClipboard,
    showToast
});
historyPreviewApi = historyFeature.historyPreviewApi;
projectIoFeature = createProjectIoFeature({
    registry,
    state,
    selectionApi,
    storageKey: STORAGE_KEY,
    localStorageRef: diskStorage,
    nodeSerializer,
    getHandle,
    addLog,
    addNode,
    applyHistoryGridCols: (...args) => historyFeature.applyHistoryGridCols(...args),
    connectionProjectionMaintenance: registry.connectionProjectionApi.maintenance,
    updatePortStyles,
    onConnectionsChanged: () => handleNodeGraphChanged(),
    viewportApi,
    showToast,
    applyTheme: (themeId) => getThemeControllerApi().applyTheme(themeId),
    applyGlobalAnimationSetting,
    applyCanvasUiSetting,
    applyWorkflowSidebarWidth: (width) => workflowManagerApi.applyWorkflowSidebarWidth(width),
    applyWorkspaceMode: (mode) => getWorkspaceModeControllerApi().activate(mode, { persist: false }),
    activateRestoredWorkflowState: (restoredState) => workflowManagerApi.activateRestoredWorkflowState(restoredState),
    clearImageAssets,
    clearOrphanedNodeAssets,
    clearOrphanedImageImportAssets,
    trimHistoryCache,
    cleanupRecoverableNodeAssetCache,
    clearUndoStack: () => {
        getSessionManagerApi().clearUndoStack();
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
    getIntegrityWorkflows: () => {
        const workflow = workflowManagerApi.getActiveWorkflowSnapshot?.();
        return workflow ? [workflow] : [];
    },
    getActiveWorkflowId: () => workflowManagerApi.getActiveWorkflowId?.() || '',
    getActiveWorkflowName: () => workflowManagerApi.getActiveWorkflowName?.() || '',
    handleMissingMediaAction: (request) => handleMissingMediaAction(request),
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
    documentRef: document,
    localStorageRef: diskStorage
});

function initFeatureModules() {
    initFloatingNotices();
    settingsFeature.initSettingsFeature();
    historyFeature.initHistoryFeature();
    helpPanelApi.initHelpPanel();
    workflowManagerApi.initWorkflow();
    getPromptLibraryApi().initPromptLibrary();
    promptAgentController.init();
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
installSessionPersistenceOnExit({ flushSession: () => getSessionManagerApi().flushSave() });
window.cainflowPrepareExit = createDesktopExit({
    setBlocked: blocked => { document.body.inert = blocked; },
    settle: async () => {
        if (state.canvasPlanApplying || state.isRunStarting) throw new Error('画布正在提交或启动，请稍后重新关闭');
        promptAgentController.cancelRequest({ silent: true });
        await getSessionManagerApi().waitForHistoryTransitions();
        await getWorkflowRuntimeManagerApi().settleForExit();
        await mediaControllerApi.waitForPendingImageImports();
        await getExecutionCoreApi().waitForPendingImageAssetSaves();
    },
    save: async () => {
        let result = await workflowManagerApi.saveAllOpenWorkflows({ dirtyOnly: true });
        const failedIds = result.results.filter(item => item.status !== 'committed').map(item => item.workflowId);
        if (failedIds.length) {
            result = await workflowManagerApi.saveAllOpenWorkflows({ workflowIds: failedIds });
        }
        const failures = result.results.filter(item => item.status !== 'committed');
        if (failures.length) {
            const first = failures[0];
            const label = result.snapshot?.open?.find(item => item.workflowId === first.workflowId)?.label || first.workflowId;
            const suffix = failures.length > 1 ? `等 ${failures.length} 个工作流` : '';
            throw new Error(`工作流「${label}」${suffix}保存失败${first.error?.message ? `：${first.error.message}` : '，请返回软件后重试'}`);
        }
        await flushSessionToDisk(getSessionManagerApi(), diskStorage);
        await diskStorage.flushPromise;
        if (diskStorage.lastError) throw diskStorage.lastError;
    },
    release: () => getSessionManagerApi().endUndoSession(),
    finish: () => window.pywebview.api.finish_close(),
    report: error => showToast(`退出收尾失败：${error.message}`, 'error', 8000),
    confirmDiscard: async error => {
        if (state.canvasPlanApplying || state.isRunStarting) return false;
        const action = await openDialogStyle1({
            id: 'desktop-exit-save-failed',
            title: '关闭前保存失败',
            message: error.message,
            note: '返回软件可检查问题并重试关闭。强制退出会丢失未保存的修改，已保存的数据保留。',
            actions: [
                { id: 'cancel', label: '返回软件', variant: 'secondary', autofocus: true },
                { id: 'discard', label: '放弃修改并退出', variant: 'danger' }
            ]
        });
        return action === 'discard';
    }
});
renderProjectionManager.init();
interactionPerformanceGuard.init();
const startupPromise = getStartupControllerApi().initStartup();

const canvasStressTestBridge = createCanvasStressTestBridge({
    state,
    addNode,
    mediaControllerApi,
    updateAllConnections,
    scheduleSave,
    showToast,
    nodesLayer,
    documentRef: document,
    globalRef: globalThis
});
canvasPerformanceMonitor.mount({
    createFixture: canvasStressTestBridge.createCanvasStressTestNodes,
    clearFixture: canvasStressTestBridge.clearCanvasStressTestNodes
});

registerGlobalBridges({
    windowRef: window,
    closeModal,
    showLogDetail
});

await startupPromise;
await getConversationWorkbenchControllerApi().init().catch((error) => {
    showToast(`加载对话工作台失败：${error.message}`, 'error');
});
getConversationToolbarControllerApi().init();

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
