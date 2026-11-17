import { confirmAction } from '../features/ui/app-dialogs.js';
import { createRetiredSaveNodeCleanup } from '../features/persistence/retired-save-nodes.js';
import { createImageFirstCanvas } from '../features/ui/image-first-canvas.js';
import { createReferenceImageCatalog } from '../features/media/reference-image-catalog.js';
import { createImageGenerationRevisionApi } from '../nodes/image-generation-revision.js';
import { getImageOutputAssets, readPrimaryImageOutput } from '../nodes/image-output-projection.js';
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
import { migrateAutoCompactTokens, readAutoCompactTokens, readCompactionModelId, readCompactionProviderId, readDiscardOverLimitContext } from '../features/prompt-agent/auto-compact-preference.js';
import {
    createBezierPath as createBezierPathService,
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
import { createImageResultActions } from '../features/media/image-result-actions.js';
import { startHistoryDownload } from '../features/history/history-download.js';
import { createNodeLifecycleApi } from '../nodes/node-lifecycle.js';
import { createMediaControllerApi } from '../features/media/media-controller.js';
import { collectRetainedNodeAssetIds as collectRetainedNodeAssetIdsForWorkflows } from '../features/media/node-asset-retention.js';
import { createMissingMediaBrowserActions } from '../features/media/missing-media-action-browser.js';
import { createImagePainterApi } from '../features/media/image-painter.js';
import { createEditedImageImport } from '../features/media/image-painter-output.js';
import { createCameraControlNodeApi } from '../features/camera/camera-control-node-proxy.js';
import { createExecutionCoreApi } from '../features/execution/execution-core.js';
import { createWorkflowRunnerApi } from '../features/execution/workflow-runner.js';
import { getCanonicalImageList } from '../features/execution/execution-data-utils.js';
import { prepareGenerationSaveTargets } from '../features/execution/generation-save-targets.js';
import { getNodeModelConfigurationIssue } from '../features/execution/model-configuration-readiness.js';
import { findViewportNodePosition, nodeBounds, setNodePosition } from '../features/execution/node-placement.js';
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
import { createCanvasRunScopeMenu, projectCanvasRunScope } from '../features/ui/canvas-run-scope.js';
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
import { createCanvasMcpActions } from '../features/canvas-mcp/canvas-mcp-actions.js';
import { canvasRevisionFingerprint, createCainflowAppActions } from '../features/canvas-mcp/cainflow-app-actions.js';
import { createHistoryCanvasImporter } from '../features/canvas-mcp/canvas-history-import.js';
import { createPrepareApplyPrompt } from '../features/prompt-agent/prompt-agent-apply-library-prompt.js';
import { startCanvasMcpEditor } from '../features/canvas-mcp/canvas-mcp-editor.js';
import { createPromptAgentReferenceSource } from '../features/prompt-agent/prompt-agent-reference-source.js';
import { createPromptAgentNodeAdapter, getAvailablePromptAgentImageModels } from '../features/prompt-agent/prompt-agent-node-adapter.js';
import { createPromptAgentExecutionAdapter } from '../features/prompt-agent/prompt-agent-execution-adapter.js';
import { createPromptAgentResultPersistence } from '../features/prompt-agent/prompt-agent-result-persistence.js';
import { createPromptAgentResultMediaAdapter } from '../features/prompt-agent/prompt-agent-result-media.js';
import { createPromptAgentModelReply, getAvailablePromptAgentModels, imageParameterCapabilities } from '../features/prompt-agent/prompt-agent-model.js';
import { createAgentWebImageReader } from '../features/prompt-agent/prompt-agent-web-image.js';
import { createPromptAgentCompaction } from '../features/prompt-agent/prompt-agent-compaction.js';
import { getEffectiveProtocol, getModelProviders, getResolvedProviderForModel } from '../features/execution/provider-request-utils.js';
import { getImageAspectOptionsForProtocol, getImageResolutionOptionsForProtocol } from '../features/execution/image-generation-size.js';
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
let sessionRestorationComplete = false;
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

function processColorResetImage(dataUrl, options = {}) {
    return mediaUtils.processColorResetImage(dataUrl, options);
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
    return getLogPanelApi().logRequestToPanel(title, url, requestBody, {
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
const commercePanelRuns = new Set();

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
    nodeGeometryChanged: (nodeIds) => registry.connectionProjectionApi?.interactions.nodeGeometryChanged(nodeIds),
    nodeResizeApplied: (nodeId) => registry.connectionProjectionApi?.interactions.nodeResizeApplied(nodeId),
    topologyChanged: (change) => registry.connectionProjectionApi?.interactions.topologyChanged(change),
    nodeGeometrySettled: (nodeId, change) => registry.connectionProjectionApi?.interactions.nodeGeometrySettled(nodeId, change)
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
    listHistoryImages,
    annotateHistoryImage,
    getHistoryCount,
    getHistoryPage,
    getHistoryEntry,
    getHistoryImageBlob,
    updateHistoryThumb,
    clearHistory,
    clearOrphanedHistoryAssets,
    trimHistoryCache,
    deleteHistoryEntry
} = indexedDbApi;
const referenceImageCatalog = createReferenceImageCatalog({
    state, getHistoryMetadata, getHistoryEntry, getImageAsset, getImageAssetList,
    createThumbnail: source => mediaControllerApi.createReferenceThumbnail(source)
});
const cameraControlNodeApi = createCameraControlNodeApi({
    state,
    getImageAsset,
    getImageAssetList,
    getActiveWorkflowId: () => workflowManagerApi.getActiveWorkflowId?.() || state.activeWorkflowId || '',
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
function activeAgentPanelBounds() {
    const panel = document.getElementById('prompt-agent-panel');
    return panel?.classList.contains('active') ? panel.getBoundingClientRect() : null;
}

function visibleCanvasWidth(rect, panelBounds) {
    const width = panelBounds ? Math.min(rect.right, panelBounds.left - 12) - rect.left : rect.width;
    return width > 0 ? width : rect.width;
}

function agentCanvasViewport() {
    const rect = canvasContainer.getBoundingClientRect();
    const panel = activeAgentPanelBounds();
    const { zoom } = state.canvas;
    return {
        ...viewportApi.screenToCanvas(rect.left, rect.top),
        width: visibleCanvasWidth(rect, panel) / zoom,
        height: rect.height / zoom,
        ...(panel ? { blockedSpan: { ...viewportApi.screenToCanvas(panel.left - 16, panel.top - 16),
            width: (panel.width + 32) / zoom, height: (panel.height + 32) / zoom } } : {})
    };
}

function addAgentNode(type, data, silent = false) {
    const viewport = agentCanvasViewport();
    const { zoom } = state.canvas;
    const id = addNode(type, viewport.x, viewport.y, data, silent);
    if (id) {
        const node = state.nodes.get(id);
        const { width, height } = nodeBounds(node, zoom);
        const occupied = [...state.nodes.values()].filter(item => item !== node).map(item => nodeBounds(item, zoom));
        setNodePosition(node, findViewportNodePosition({ viewport, width, height, occupied }));
    }
    return id;
}

function focusCanvasNode(nodeId, { avoidAgentPanel = false, selectOnFocus = true } = {}) {
    const node = state.nodes.get(nodeId);
    const rect = canvasContainer?.getBoundingClientRect?.();
    if (!node || !rect) return false;
    const zoom = Number(state.canvas.zoom) || 1;
    const width = Number(node.width) || node.el?.offsetWidth || 220;
    const height = Number(node.height) || node.el?.offsetHeight || 140;
    const centerX = visibleCanvasWidth(rect, avoidAgentPanel ? activeAgentPanelBounds() : null) / 2;
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
function openNodeFailureLog(nodeId) {
    const log = state.logs?.find((entry) => entry.type === 'error' && entry.nodeId === nodeId);
    if (!log) return false;
    getLogPanelApi().showLogDetail(log.id);
    return true;
}
document.addEventListener('cainflow:node-failure-clicked', (event) => openNodeFailureLog(event.detail?.nodeId));
const interactionPerformanceGuard = createInteractionPerformanceGuard({
    state,
    canvasContainer,
    connectionsGroup,
    windowRef: window
});
const selectionApi = createSelectionApi({
    state,
    connectionProjection: connectionProjectionInteractions,
    onChange: () => {
        registry.imageFirstCanvasApi?.selectionChanged();
        registry.promptAgentController?.refreshPreparedNodeContext?.();
        registry.canvasRunScopeMenu?.refresh();
    }
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
    promptAgentController?.refreshPreparedNodeContext?.();
    if (!isMediaRestoreBatchActive()) registry.imageGenerationRevisionApi?.observeAll();
    registry.imageFirstCanvasApi?.refresh();
    registry.canvasRunScopeMenu?.refresh();
    if (!force && isMediaRestoreBatchActive()) {
        return;
    }
    refreshAllImageResizePreviews();
    refreshAllCameraControlPreviews();
}

function handleNodesRemoved(ids) {
    registry.imageFirstCanvasApi.selectionChanged();
    registry.promptAgentController?.removeNodeReferences(ids);
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
    processColorResetImage,
    detectOutputFormat,
    estimateDataUrlSize,
    getImageResolution,
    dataURLtoBlob,
    copyImageToClipboard: uiUtils.copyImageToClipboard,
    showToast,
    addLog,
    scheduleSave,
    onMediaIntegrityChanged: () => workflowManagerApi?.refreshActiveWorkflowIntegrityState?.(),
    onImageDescriptionChanged: node => {
        if (state.nodes.get(node.id) !== node) return;
        registry.imageGenerationRevisionApi?.observeAll();
        nodeDomBindingsApi?.refreshDependentReferenceSources(node.id);
    },
    onMissingMediaAction: (request) => handleMissingMediaAction(request),
    syncCameraControlNodePreview: (nodeId, imageValue) => cameraControlNodeApi.syncCameraControlFromExecution(nodeId, imageValue),
    syncClonesFromSource: (nodeId) => {
        nodeDomBindingsApi?.syncClonesFromSource(nodeId);
        nodeDomBindingsApi?.refreshDependentReferenceSources(nodeId);
        registry.imageGenerationRevisionApi?.observeAll();
        registry.imageFirstCanvasApi?.refreshSource(nodeId);
    },
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
    onNodeGeometryChanged: nodeId => connectionProjectionInteractions.nodeGeometryChanged(nodeId),
    onTopologyChanged: change => connectionProjectionInteractions.topologyChanged(change),
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
    prepareHistoryEdit: () => getSessionManagerApi().prepareHistoryEdit(),
    discardCreatedNode: id => removeNode(id, { onlyId: true, skipHistory: true, showToast: false }),
    selectCreatedNode: id => { if (state.nodes.get(id)?.parameterRoot) selectionApi.setSelection([id]); },
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
    restoreColorResetPreview,
    setupImageSave,
    autoSaveToDir,
    setupImagePreview,
    setupImageCompare,
    syncImageCompareNode,
    setupImageMerge,
    syncImageMergeNode,
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
function buildImageResultActions(source, options = {}) {
    return createImageResultActions({ documentRef: document, source, getWorkflowId: () => workflowManagerApi.getActiveWorkflowId?.() || '',
        openPreview: (image, onClose) => openFullscreenPreview(image, null, { images: [image], index: 0, onClose }),
        prepareReference: (reference, intent) => promptAgentController.prepareImageContext(reference, intent),
        downloadImage: (image, item) => startHistoryDownload({ id: String(item.historyId || item.name || 'result').replace(/[^\p{L}\p{N}._-]/gu, '_'), image }, { downloadImage, documentRef: document, windowRef: window }),
        copyImage: uiUtils.copyImageToClipboard, showToast, ...options });
}
registry.imageGenerationRevisionApi = createImageGenerationRevisionApi({
    state, documentRef: document,
    getActiveWorkflowId: () => workflowManagerApi.getActiveWorkflowId?.() || '',
    getCachedOutputValue: (node, port) => getExecutionCoreApi().getCachedOutputValue(node, port),
    onChanged: node => { if (state.nodes.get(node.id) === node) registry.imageFirstCanvasApi?.refreshNode(node.id); }
});
const observeNodeInputRevision = event => {
    if (event.target.closest?.('.node') && !isMediaRestoreBatchActive()) registry.imageGenerationRevisionApi.observeAll();
};
document.addEventListener('input', observeNodeInputRevision);
document.addEventListener('change', observeNodeInputRevision);
registry.imageFirstCanvasApi = createImageFirstCanvas({
    state, selectionApi, documentRef: document, windowRef: window, storage: diskStorage,
    onNativeClipboardWrite: () => getClipboardControllerApi().markNativeClipboardWrite(),
    bindReferencePrompt: (node, input) => nodeDomBindingsApi.bindReferencePrompt(node, input),
    panelManager,
    uploadRetouchReference: async (target, file) => {
        const dataUrl = await blobToDataUrl(file);
        const image = new Image();
        image.src = dataUrl;
        try { await image.decode(); }
        catch { throw new Error('无法读取这张图片，请选择有效的图片文件'); }
        if (state.nodes.get(target.id) !== target || state.runningNodeIds.has(target.id)) {
            throw new Error('节点已变化，请重新选择参考图');
        }
        const edge = state.connections.find(item => item.to.nodeId === target.id && item.to.port === 'image');
        let sourceId = edge?.from.nodeId;
        if (sourceId) {
            const source = state.nodes.get(sourceId);
            if (source?.type !== 'ImageImport' || source.enabled === false || source.isClone || state.runningNodeIds.has(sourceId)
                || getImageOutputAssets(source).length || getCanonicalImageList(source).length) {
                throw new Error('参考图连接已变化，请在连接明细中调整');
            }
        } else {
            const edit = getSessionManagerApi().prepareHistoryEdit();
            const width = NODE_CONFIGS.ImageImport.defaultWidth;
            try {
                sourceId = addNode('ImageImport', target.x - width - 72, target.y,
                    { customTitle: file.name || '商品参考图' }, true);
                const connected = sourceId && connectionsApi.finishConnection(
                    { nodeId: sourceId, portName: 'image', dataType: 'image', isOutput: true, historyPushed: true },
                    { nodeId: target.id, port: 'image', type: 'image', dir: 'input' }
                );
                if (!connected) throw new Error('无法连接商品参考图');
                edit.commit();
            } catch (error) {
                if (sourceId) removeNode(sourceId, { onlyId: true, skipHistory: true, showToast: false });
                edit.cancel();
                throw error;
            }
        }
        if (!await loadImageData(sourceId, dataUrl, { publishAfterSave: true, filename: file.name })) {
            throw new Error('参考图保存失败，请重新上传');
        }
    },
    openResultPreview: (images, index, onClose) => openFullscreenPreview(images[index], null, { images, index, onClose }),
    openShotError: (label, reason) => showErrorModal('', reason, null, `「${label}」生成失败`),
    openNodeRunError: (label, reason) => showErrorModal('', reason, null, `「${label}」执行失败`),
    openNodeFailureLog,
    openReferencePreview: async (edge, onClose) => {
        const source = state.nodes.get(edge.from.nodeId);
        const isCurrent = () => source && state.nodes.get(edge.from.nodeId) === source && state.connections.includes(edge);
        if (!isCurrent()) return;
        const images = getCanonicalImageList(source);
        const asset = getImageOutputAssets(source)[0];
        try {
            const image = await readPrimaryImageOutput(source, images, async key =>
                key.startsWith('media:') ? getImageAsset(key) : (await getImageAssetList(key))?.[0] || '');
            if (!isCurrent() || document.querySelector('.fullscreen-overlay') || asset !== getImageOutputAssets(source)[0]
                || images[0] !== getCanonicalImageList(source)[0]) return;
            if (!image || source.enabled === false || source.data?.mediaIntegrity?.missingItems?.some(item => item.position === 0)) {
                showToast('参考图原图不可用', 'warning');
                return;
            }
            return openFullscreenPreview(image, null, { images: [image], index: 0, onClose });
        } catch {
            if (isCurrent()) showToast('参考图原图不可用', 'warning');
        }
    },
    openAgent: () => promptAgentController.open(),
    openModelSettings: target => settingsControllerApi.openModelSettings(target),
    runCurrentNode: (nodeId, { commerceAction, commerceShotId, imageRetryIndex, imageRetryBatchId } = {}) => commerceAction
        ? runCommerceImageSetAction(nodeId, commerceAction, commerceShotId)
        : runWorkflow({
            mode: 'selected-only', selectedNodeIds: [nodeId],
            ...(Number.isInteger(imageRetryIndex) ? { imageRetryNodeId: nodeId, imageRetryIndex, imageRetryBatchId } : {})
        }, { waitForCompletion: Number.isInteger(imageRetryIndex) }),
    cancelCommerceImageSet,
    waitForNodeRun: nodeId => {
        const workflowId = workflowManagerApi.getActiveWorkflowId();
        return !workflowId || getWorkflowRuntimeManagerApi().waitForNodeRun({ workflowId }, nodeId);
    },
    fitNode: (id, options) => fitNodeToContent(id, options),
    bindPorts: container => nodeDomBindingsApi.bindNodePorts(container),
    updateInputConnection: (id, change) => connectionsApi.updateInputConnection(id, change),
    swapInputConnections: id => connectionsApi.swapInputConnections(id),
    moveMergeInputConnection: (id, direction) => connectionsApi.moveMergeInputConnection(id, direction),
    onSettingsChanged: (id, change) => {
        const node = state.nodes.get(id);
        const workflowId = workflowManagerApi.getActiveWorkflowId();
        if (node?.type === 'ECommerceImageSet' && workflowId && change?.commerceShotId) {
            getWorkflowRuntimeManagerApi().updateCommerceShotDraft(
                { workflowId }, node, change.commerceShotId, change.commerceShotField
            );
        }
        if (node?.type === 'ProductRetouch' && !node.isClone) {
            nodeDomBindingsApi.syncClonesFromSource(id, registry.imageFirstCanvasApi.refreshNode);
        }
        if (['ECommerceImageSet', 'ProductRetouch'].includes(node?.type)) scheduleSave();
        nodeDomBindingsApi.syncDependentPromptSources(id);
        registry.imageGenerationRevisionApi.onSettingsChanged(id);
        registry.imageGenerationRevisionApi.observeAll();
    }
});
const nodeDomBindingsApi = createNodeDomBindingsApi({
    onNodeBound: id => { registry.imageFirstCanvasApi.install(id); registry.imageGenerationRevisionApi.initializeNode(id); },
    state,
    referenceImageCatalog,
    selectionApi,
    canvasContainer,
    connectionsGroup,
    tempConnection,
    viewportApi,
    getCachedOutputValue: (node, port) => getExecutionCoreApi().getCachedOutputValue(node, port),
    createReferenceThumbnail: source => mediaControllerApi.createReferenceThumbnail(source),
    readReferenceSourceImages: async nodeId => (await mediaControllerApi.getNodeFullscreenImageContext(nodeId)).images,
    openReferencePreview: (images, index, onClose) => openFullscreenPreview(images[index], null, { images, index, onClose }),
    focusReferenceSource: nodeId => focusCanvasNode(nodeId),
    getWorkflowId: () => workflowManagerApi.getActiveWorkflowId?.() || '',
    moveReferenceSource: (nodeId, connectionId, targetConnectionId) => connectionsApi.moveImageReferenceConnection(nodeId, connectionId, targetConnectionId),
    disconnectReferenceSource: (nodeId, connectionId) => connectionsApi.disconnectImageReferenceConnection(nodeId, connectionId),
    prepareNodeContext: reference => promptAgentController.prepareNodeContext(reference),
    createImageResultActions: buildImageResultActions,
    runToNode: nodeId => runWorkflow({ mode: 'target-node', targetNodeId: nodeId }),
    openNodeLog: nodeId => {
        const log = state.logs?.find(entry => entry.nodeId === nodeId);
        if (log) getLogPanelApi().showLogDetail(log.id);
        else panelManager.toggle('logs');
    },
    readResultAsset: key => getImageAsset(key),
    createResultThumbnail: (source, options) => mediaControllerApi.createResultThumbnail(source, options),
    rememberResultThumbnail: (nodeId, source, thumbnail) => mediaControllerApi.rememberResultThumbnail(nodeId, source, thumbnail),
    getPortPosition: (nodeId, portName, direction) => getPortPosition(nodeId, portName, direction),
    pushHistory,
    pushNodeMoveHistory: ids => getSessionManagerApi().pushNodeMoveHistory(ids),
    removeNode: (nodeId, options) => removeNode(nodeId, options),
    selectNode: (nodeId, isMulti) => selectNode(nodeId, isMulti),
    toggleNodesEnabled: (nodeIds, referenceNodeId) => toggleNodesEnabled(nodeIds, referenceNodeId),
    cancelRunningNode: (nodeId) => cancelRunningNode(nodeId),
    handleBatchConnectionNodeMouseDown: (event, nodeId) => getBatchConnectionModeApi().handleNodeMouseDown(event, nodeId),
    finishConnection: (src, tgt) => finishConnection(src, tgt),
    updateConnectionTargetFeedback: (src) => updateConnectionTargetFeedback(src),
    clearConnectionTargetFeedback: () => clearConnectionTargetFeedback(),
    openKeyboardConnection: connectionsApi.openKeyboardConnection,
    resumeVideoGeneration: resumeWorkflowNode,
    resumeImageGeneration: resumeWorkflowNode,
    setupImageImport,
    setupImageResize,
    setupColorReset: (id, el) => mediaControllerApi.setupColorReset(id, el),
    setupImageSave,
    setupImagePreview,
    setupImageCompare,
    setupImageMerge,
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
    findConnectionsCrossingSegments,
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
            connectPorts: (source, target) => connectionsApi.finishConnection(source, target),
            validateConnection: (source, target) => connectionsApi.getConnectionTargetError(source, target),
            getBatchConnectionSources: connectionsApi.getBatchConnectionSources,
            connectBatchToNode: connectionsApi.connectBatchToNode,
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
    const result = getNodeLifecycleApi().fitNodeToContent(nodeId, options);
    registry.imageFirstCanvasApi?.refreshNode(nodeId);
    return result;
}

// ===== 节点创建 =====
function addNode(type, x, y, restoreData, silent = false) {
    const id = getNodeLifecycleApi().addNode(type, x, y, restoreData, silent);
    if (id && !restoreData && !silent && state.nodes.get(id)?.parameterRoot) selectionApi.setSelection([id]);
    return id;
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

function resumeWorkflowNode(nodeId) {
    return runWorkflow({ mode: 'target-node', targetNodeId: nodeId }, { waitForCompletion: true, resumeNodeId: nodeId });
}

function runCommerceImageSetAction(nodeId, commerceAction, commerceShotId) {
    const node = state.nodes.get(nodeId);
    if (node?.type !== 'ECommerceImageSet' || node.enabled === false || node.isClone) return false;
    const controller = new AbortController();
    const run = { workflowId: workflowManagerApi.getActiveWorkflowId() || '', node, shotId: commerceShotId, controller };
    commercePanelRuns.add(run);
    getWorkflowRuntimeManagerApi().syncGlobalRunToolbarState();
    run.promise = runWorkflow({
        mode: 'selected-only', selectedNodeIds: [nodeId],
        commerceNodeId: nodeId, commerceAction, commerceShotId
    }, { waitForCompletion: true, commercePanelRun: run }).finally(() => {
        commercePanelRuns.delete(run);
        getWorkflowRuntimeManagerApi().syncGlobalRunToolbarState();
    });
    return run.promise;
}

function cancelCommerceImageSet(nodeId, shotId) {
    const workflowId = workflowManagerApi.getActiveWorkflowId();
    if (!workflowId) return false;
    let canceled = getWorkflowRuntimeManagerApi().cancelCommerceImageSet({ workflowId }, nodeId, shotId);
    for (const run of commercePanelRuns) {
        if (run.dispatched || run.workflowId !== workflowId || run.node.id !== nodeId || (shotId && shotId !== run.shotId)
            || run.controller.signal.aborted) continue;
        run.controller.abort('manual');
        canceled = true;
    }
    if (canceled) getWorkflowRuntimeManagerApi().syncGlobalRunToolbarState();
    return canceled;
}

function getCanvasRunScopePreview(runInput) {
    const execution = getExecutionCoreApi();
    let message = '';
    let plan = null;
    const resolveExecutionPlan = input => {
        plan = execution.resolveExecutionPlan(input, { notify: reason => { message = reason; } });
        return plan;
    };

    try {
        const prepared = prepareGenerationSaveTargets({ state, runInput, resolveExecutionPlan, normalizeRunOptions: execution.normalizeRunOptions });
        if (plan && prepared.includedAutoSaveNodeIds.length) resolveExecutionPlan(prepared);
        if (plan) {
            const workflowId = workflowManagerApi.getActiveWorkflowId();
            const runnableIds = plan.executionOrder.filter(id => state.nodes.get(id)?.enabled !== false);
            const overlap = getWorkflowRuntimeManagerApi().getPlanOverlapNodeIds({ workflowId }, runnableIds);
            if (overlap.length) message = `此范围内有 ${overlap.length} 个节点仍在运行。`;
        }
    } catch (error) {
        message = error.message;
    }
    if (!plan) return { runIds: new Set(), reusedIds: new Set(), routes: new Map(), message };
    const preview = projectCanvasRunScope({ state, plan, isFixedTextChatWithCachedResult: execution.isFixedTextChatWithCachedResult });
    message ||= preview.commerce?.find(row => row.issue)?.issue.message || '';
    if (!message) {
        for (const id of preview.runIds) {
            const node = state.nodes.get(id);
            const issue = getNodeModelConfigurationIssue({ state, node, documentRef: document });
            if (issue) {
                message = `${node.customTitle || NODE_CONFIGS[node.type]?.title || node.type} · ${issue.message}`;
                break;
            }
        }
    }
    return { ...preview, message: message || (!preview.runIds.size ? '此范围内没有需要执行的节点。' : '') };
}

async function runWorkflow(runInput = null, {
    waitForCompletion = false, retainResults, configurationSnapshot, validateBeforeRun, resumeNodeId = null,
    captureTextResults = false, commercePanelRun, validateExecutionPlan
} = {}) {
    if (state.canvasPlanApplying || state.historyTransitionInProgress) {
        const message = state.canvasPlanApplying ? '画布方案正在应用，请稍后运行' : '画布正在撤销或重做，请稍后运行';
        if (!validateExecutionPlan && (waitForCompletion || validateBeforeRun)) throw new Error(message);
        showToast(message, 'warning');
        return false;
    }
    const commercePanelSignal = commercePanelRun?.controller.signal;
    const stopped = commercePanelSignal ? { started: false, executed: false, outcome: 'stopped' } : false;
    if (state.isRunStarting && !commercePanelSignal) return false;
    const requestedWorkflowId = workflowManagerApi.getActiveWorkflowId();
    const runStartController = commercePanelSignal ? null : new AbortController();
    const startSignal = commercePanelSignal || runStartController.signal;
    if (runStartController) {
        state.isRunStarting = true;
        state.runStartController = runStartController;
        state.runStartingWorkflowId = requestedWorkflowId;
        getWorkflowRuntimeManagerApi().syncGlobalRunToolbarState();
    }
    try {
        await waitForRunStartFrame();
        if (startSignal.aborted) return stopped;
        const workflowOptions = validateBeforeRun ? { expectedWorkflowId: requestedWorkflowId || '' } : undefined;
        if (!(await workflowManagerApi.ensureOpenWorkflow(workflowOptions))) {
            if (validateBeforeRun) throw new Error('当前工作流不可用，请重新打开后运行。');
            return false;
        }
        if (startSignal.aborted) return stopped;
        const effectiveRequestedWorkflowId = requestedWorkflowId || workflowManagerApi.getActiveWorkflowId();
        if (runStartController) state.runStartingWorkflowId = effectiveRequestedWorkflowId;
        if (commercePanelRun) commercePanelRun.workflowId = effectiveRequestedWorkflowId;
        await waitForPendingImageImports();
        if (startSignal.aborted) return stopped;
        if (workflowManagerApi.getActiveWorkflowId() !== effectiveRequestedWorkflowId) {
            showToast('工作流已切换，请在目标工作流重新运行', 'warning');
            return false;
        }
        if (commercePanelRun) {
            const { node } = commercePanelRun;
            const workflow = { workflowId: effectiveRequestedWorkflowId };
            const runtime = getWorkflowRuntimeManagerApi();
            while (true) {
                if (startSignal.aborted || workflowManagerApi.getActiveWorkflowId() !== workflow.workflowId
                    || state.nodes.get(node.id) !== node || node.enabled === false) return stopped;
                // A finished row can become actionable before its owning runtime has finished saving.
                const settling = runtime.waitForSettlingCommerceRun(workflow, node.id, startSignal);
                if (!settling) break;
                if (!await settling) return stopped;
            }
        }
        const workflowName = workflowManagerApi.getActiveWorkflowName();
        if (!workflowName) {
            showToast('请先打开或新建一个工作流', 'warning');
            return false;
        }
        const preparedWorkflowId = workflowManagerApi.getActiveWorkflowId();
        if (commercePanelRun && state.canvasPlanApplying) throw new Error('画布方案正在应用，请稍后运行');
        if (state.historyTransitionInProgress) throw new Error('画布正在撤销或重做，请稍后运行');
        validateBeforeRun?.();
        if (!commercePanelSignal) {
            runInput = prepareGenerationSaveTargets({
                state, runInput,
                resolveExecutionPlan: (input) => getExecutionCoreApi().resolveExecutionPlan(input),
                normalizeRunOptions: (input) => getExecutionCoreApi().normalizeRunOptions(input),
                isWorkflowCurrent: () => workflowManagerApi.getActiveWorkflowId() === preparedWorkflowId
            });
        }
        const workflowData = workflowManagerApi.getActiveWorkflowRuntimeData?.()
            || workflowManagerApi.getActiveWorkflowSnapshot();
        const workflowId = workflowManagerApi.getActiveWorkflowId?.() || workflowData?.workflowId || '';
        if (commercePanelRun) commercePanelRun.dispatched = true;
        // Forward the completion promise without holding the launch guard for
        // the full generation; other workflow branches can still be started.
        const execution = getWorkflowRuntimeManagerApi().runWorkflowInContext({ workflowName, workflowId }, workflowData, runInput, {
            waitForCompletion, retainResults, configurationSnapshot, resumeNodeId, captureTextResults, commercePanelSignal, validateExecutionPlan
        });
        return validateExecutionPlan ? await execution : execution;
    } catch (error) {
        showToast(error?.message || '无法启动工作流', 'warning');
        if (waitForCompletion || validateBeforeRun) throw error;
        return false;
    } finally {
        if (runStartController) {
            state.isRunStarting = false;
            state.runStartController = null;
            state.runStartingWorkflowId = null;
            getWorkflowRuntimeManagerApi().syncGlobalRunToolbarState();
        }
    }
}

function cancelRunningNode(nodeId) {
    return getWorkflowRuntimeManagerApi().cancelRunningNode({
        workflowName: workflowManagerApi.getActiveWorkflowName(),
        workflowId: workflowManagerApi.getActiveWorkflowId()
    }, nodeId)
        || getWorkflowRunnerApi().cancelRunningNode(nodeId);
}

function stopCurrentWorkflow() {
    const workflowId = workflowManagerApi.getActiveWorkflowId();
    if (!workflowId) return 0;
    return getWorkflowRuntimeManagerApi().abortWorkflowRuns({ workflowId, workflowName: workflowManagerApi.getActiveWorkflowName() });
}

// ===== 持久化 =====
function scheduleSave(options) {
    return getSessionManagerApi().scheduleSave(options);
}

const promptAgentNodeAdapter = createPromptAgentNodeAdapter({
    state,
    documentRef: document,
    getCachedOutputValue: (node, port) => getExecutionCoreApi().getCachedOutputValue(node, port),
    scheduleSave: () => { registry.imageGenerationRevisionApi?.observeAll(); scheduleSave(); },
    commitReferenceConnections: (connections) => {
        pushHistory();
        state.connections = connections;
        connectionsApi.updateAllConnections();
        connectionsApi.updatePortStyles();
        handleNodeGraphChanged();
    },
    createImageNode: ({ model, provider, prompt }) => {
        const nodeId = addAgentNode('ImageGenerate', {
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
window.addEventListener('cainflow:storage-error', event => showToast(event.detail?.message || '媒体文件操作失败', 'error'));
window.addEventListener('cainflow:media-directory-changed', () => {
    renderHistoryList();
    document.dispatchEvent(new Event('cainflow:history-changed'));
});
let retiredSaveCleanupReady = false;
const cleanupRetiredSaveNodes = createRetiredSaveNodeCleanup({
    state, getWorkflowId: () => workflowManagerApi.getActiveWorkflowId(), session: getSessionManagerApi,
    serializeNodes: () => nodeSerializer.serializeNodes(), removeNode, onNodesRemoved: handleNodesRemoved,
    graphChanged: () => { connectionsApi.updateAllConnections(); connectionsApi.updatePortStyles(); handleNodeGraphChanged(); },
    save: () => workflowManagerApi.saveActiveWorkflow({ silent: true }),
    confirm: options => confirmAction({ ...options, confirmLabel: '清理旧节点', danger: true }), showToast
});
const offerRetiredSaveNodeCleanup = options => retiredSaveCleanupReady ? cleanupRetiredSaveNodes(options) : Promise.resolve();
new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 && node.matches?.('.node-save')))) {
        setTimeout(() => offerRetiredSaveNodeCleanup(), 0);
    }
}).observe(document.getElementById('nodes-layer'), { childList: true });
const promptAgentCanvasAdapter = createPromptAgentCanvasAdapter({
    state, documentRef: document, serializeNodes: () => nodeSerializer.serializeNodes(),
    getWorkflowId: () => workflowManagerApi.getActiveWorkflowId(), addNode, removeNode, onNodesRemoved: handleNodesRemoved,
    renameNode: (id, title) => getNodeLifecycleApi().renameNode(id, title, { inBatch: true }),
    setNodesEnabled: (ids, enabled) => getNodeLifecycleApi().setNodesEnabled(ids, enabled, { inBatch: true }),
    nodeAdapter: promptAgentNodeAdapter, session: getSessionManagerApi,
    save: () => workflowManagerApi.saveActiveWorkflow({ silent: true }),
    persistInPlace: () => workflowManagerApi.persistActiveHistoryTransition({ strictRevision: true }),
    graphChanged: () => { connectionsApi.updateAllConnections(); connectionsApi.updatePortStyles(); handleNodeGraphChanged(); },
    origin: agentCanvasViewport,
    getImageAsset, runWorkflow: (input, options) => runWorkflow(input, { ...options, waitForCompletion: true }),
    cancelNode: cancelRunningNode, focusNode: (nodeId) => focusCanvasNode(nodeId, { avoidAgentPanel: true, selectOnFocus: false })
});
const cainflowAppActions = createCainflowAppActions({
    createEmptyWorkflow: options => workflowManagerApi.createEmptyWorkflow(options),
    listHistoryImages: options => listHistoryImages(options),
    annotateHistoryImage: (args, scope) => annotateHistoryImage(args, scope),
    onHistoryNote: result => historyFeature.refreshHistoryAfterNote(result),
    promptLibrary: getPromptLibraryApi,
    importHistory: createHistoryCanvasImporter({
        canvasAdapter: promptAgentCanvasAdapter, listHistoryImages, getHistoryImageBlob,
        saveWorkflowNodeMediaAsset, cancelWorkflowNodeMediaOperation,
        persist: () => workflowManagerApi.persistActiveHistoryTransition({ strictRevision: true })
    }),
    prepareApplyPrompt: createPrepareApplyPrompt({ promptLibrary: getPromptLibraryApi }),
    runCanvas: (input, { context, isCurrent }) => {
        const fingerprint = canvasRevisionFingerprint(context);
        return runWorkflow(input, {
            validateBeforeRun: () => {
                if (!isCurrent() || canvasRevisionFingerprint(promptAgentCanvasAdapter.context()) !== fingerprint) {
                    throw new Error('画布已变化，请重新发起运行。');
                }
            }
        });
    },
    stopCanvas: (nodeIds, { context }) => {
        const workflowId = workflowManagerApi.getActiveWorkflowId();
        if (workflowId !== context.workflowId) throw new Error('工作流已切换，请重新发起停止。');
        if (!nodeIds) return stopCurrentWorkflow();
        const workflow = { workflowId, workflowName: workflowManagerApi.getActiveWorkflowName() };
        return nodeIds.filter(id => getWorkflowRuntimeManagerApi().cancelRunningNode(workflow, id)).length;
    },
    changeCanvasHistory: (method, { isCurrent }) => getSessionManagerApi()[method]({ strictRevision: true, isCurrent }),
    applyCanvasPlan: async (plan, isCurrent) => {
        try { return await promptAgentCanvasAdapter.apply(plan, '', undefined, isCurrent); }
        finally { promptAgentCanvasAdapter.discardExecutionConfig(plan); }
    }
});

const promptAgentController = createPromptAgentController({
    appActions: cainflowAppActions,
    notifyAppAction: message => showToast(message, 'success'),
    onNativeClipboardWrite: () => getClipboardControllerApi().markNativeClipboardWrite(),
    onDraftChange: () => workflowManagerApi.markActiveWorkflowDirty({ capture: false }),
    canvasAdapter: promptAgentCanvasAdapter,
    referenceImageCatalog,
    createMentionThumbnail: source => mediaControllerApi.createReferenceThumbnail(source),
    panelManager,
    getSearchModels: () => state.models.filter(model => !model.taskType || model.taskType === 'chat'),
    getProviders: () => state.providers,
    documentRef: document,
    captureRequestConfig: captureAgentRequestConfig,
    readWebImage: readAgentWebImage,
    referenceSource: createPromptAgentReferenceSource({
        state, nodeAdapter: promptAgentNodeAdapter, getHistoryMetadata, getHistoryEntry, getImageAsset, readWebImage: readAgentWebImage,
        getWorkflowId: () => workflowManagerApi.getActiveWorkflowId(),
        discardImportNode: id => removeNode(id, { onlyId: true, skipHistory: true, showToast: false, notifyReferences: false }),
        scheduleSave, loadImageData: (id, data) => mediaControllerApi.loadImageData(id, data),
        createImportNode: ({ name, provisional }) => addAgentNode('ImageImport', { customTitle: name }, provisional)
    }),
    getPanelWidth: () => diskStorage.getItem('cainflow_prompt_agent_panel_width'),
    setPanelWidth: (width) => diskStorage.setItem('cainflow_prompt_agent_panel_width', String(width)),
    getAutoCompactTokenLimit: () => readAutoCompactTokens(diskStorage),
    getDiscardOverLimitContext: () => readDiscardOverLimitContext(diskStorage),
    nodeAdapter: promptAgentNodeAdapter,
    executionAdapter: promptAgentExecutionAdapter,
    getWorkflowId: () => workflowManagerApi.getActiveWorkflowId(),
    mutateWorkflowConversation: (workflowId, reducer) => workflowManagerApi.mutatePromptAgentByWorkflowId(workflowId, reducer),
    resultPersistence: promptAgentResultPersistence,
    loadResultImages: (keys) => Promise.all(keys.map(async (key) => {
        try { return await getImageAsset(key) || null; } catch { return null; }
    })),
    openResultPreview: (images, index, options = {}) => openFullscreenPreview(images[index], null, { images, index, ...options }),
    createImageResultActions: buildImageResultActions,
    getChatModels: () => getAvailablePromptAgentModels(state.models || [], state.providers || []),
    getImageModels: () => getAvailablePromptAgentImageModels(state.models || [], state.providers || []),
    openModelSettings: target => settingsControllerApi?.openModelSettings?.(target),
    getSelectedModelId: getPromptAgentModelId,
    setSelectedModelId: setPromptAgentModelId,
    getSelectedCompactionModelId: () => readCompactionModelId(diskStorage),
    getSelectedCompactionProviderId: modelId => readCompactionProviderId(diskStorage, modelId),
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

function getRuntimeSnapshotMediaProtection() {
    registry.runtimeSnapshotMediaProtection ||= createBrowserUndoMediaProtection(error => showToast(error.message, 'error'));
    return registry.runtimeSnapshotMediaProtection;
}

function getSessionManagerApi() {
    if (!registry.sessionManagerApi) {
        registry.sessionManagerApi = createSessionManagerApi({
            canSaveSession: () => sessionRestorationComplete,
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
            persistHistoryTransition: options => workflowManagerApi?.persistActiveHistoryTransition?.(options),
            getWorkflowSnapshot: () => workflowManagerApi?.workflowDesk?.snapshot?.()
                || Object.freeze({ active: null, open: Object.freeze([]) }),
            removeMediaReference,
            mediaAssetExists,
            undoMedia: getRuntimeSnapshotMediaProtection(),
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
            pushHistory,
            getWorkflowId: () => workflowManagerApi.getActiveWorkflowId(),
            mediaProtection: getRuntimeSnapshotMediaProtection(),
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
            showToast,
            pushHistory,
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
            findConnectionsCrossingSegments,
            pickConnectionAt: connectionsApi.pickConnectionAt,
            inspectConnection: connectionsApi.inspectConnection,
            clearConnectionInspection: connectionsApi.clearConnectionInspection,
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
            stopCurrentWorkflow,
            saveState,
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
                if (!await confirmAction({ title: '添加到画布', message: `将向当前工作流添加：\n${preview}`, note: '资源引用将复用现有媒体。', confirmLabel: '添加节点' })) return { status: 'cancelled', nodeIds: [] };
                if (workflowManagerApi.getActiveWorkflowId() !== workflowId) return { status: 'cancelled', nodeIds: [] };
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
            enterBatchConnectionMode: (selection) => getBatchConnectionModeApi().enter(selection),
            getBatchConnectionSources: connectionsApi.getBatchConnectionSources,
            inspectConnectionsFromNode: (nodeId, direction, x, y) => connectionsApi.inspectConnectionsFromNode(nodeId, direction, x, y),
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
            getActiveWorkflowId: () => workflowManagerApi.getActiveWorkflowId(),
            selectionApi,
            nodeConfigs: NODE_CONFIGS,
            createNodeMarkup,
            nodesLayer,
            generateId,
            getImageAsset,
            getImageAssetList,
            persistInlineImageImport: (id, data) => loadImageData(id, data),
            saveWorkflowImportMediaAsset,
            deleteImageImportAsset,
            showResolutionBadge,
            restoreImageResizePreview,
            restoreColorResetPreview,
            renderImageImportUploadState: (nodeId, imageData) => mediaControllerApi.renderImageImportUploadState(nodeId, imageData),
            renderImagePreviewImage: (nodeId, images, emptyMessage) => mediaControllerApi.renderImagePreviewImage(nodeId, images, emptyMessage),
            renderImageSavePreview: (nodeId, images, emptyMessage) => mediaControllerApi.renderImageSavePreview(nodeId, images, emptyMessage),
            renderImageComparePreview: (nodeId, imageA, imageB) => mediaControllerApi.renderImageComparePreview(nodeId, imageA, imageB),
            renderImageMergePreview: (nodeId, images) => mediaControllerApi.renderImageMergePreview(nodeId, images),
            bindNodeInteractions: ({ id, type, el }) => nodeDomBindingsApi.bindNodeInteractions({ id, type, el }),
            onNodesRemoved: handleNodesRemoved,
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
            flushWorkflows: async () => {
                const result = await workflowManagerApi.flushAutosave();
                return result.results.every(item => item.status === 'committed');
            },
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
            referenceImageCatalog,
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
            processColorResetImage,
            autoSaveToDir,
            restoreImageResizePreview,
            restoreColorResetPreview,
            renderImagePreviewImage: (nodeId, images, emptyMessage) => mediaControllerApi.renderImagePreviewImage(nodeId, images, emptyMessage),
            releaseNodeImageData: (nodeId, options) => mediaControllerApi.releaseNodeImageData(nodeId, options),
            refreshDependentImageResizePreviews,
            syncImagePreviewNode: (nodeId, imageValue) => mediaControllerApi.syncImagePreviewNode(nodeId, imageValue),
            syncImageSaveNode: (nodeId, imageValue) => mediaControllerApi.syncImageSaveNode(nodeId, imageValue),
            syncImageCompareNode,
            syncImageMergeNode,
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
            generationRevisionApi: registry.imageGenerationRevisionApi,
            waitForPendingImageAssetSaves: options => getExecutionCoreApi().waitForPendingImageAssetSaves(options),
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
                if (payload?.nodeId) nodeDomBindingsApi.refreshDependentReferenceSources(payload.nodeId);
                registry.imageGenerationRevisionApi?.observeAll();
                if (payload?.nodeId) registry.imageFirstCanvasApi?.refreshSource(payload.nodeId);
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
            commercePanelRuns,
            referenceImageCatalog,
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
            displayPreviewCache: mediaControllerApi.displayPreviewCache,
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
            processColorResetImage,
            copyToClipboard,
            debounce,
            fitNodeToContent,
            syncImagePreviewNode: (nodeId, imageData) => mediaControllerApi.syncImagePreviewNode(nodeId, imageData),
            syncImageSaveNode: (nodeId, imageData) => mediaControllerApi.syncImageSaveNode(nodeId, imageData),
            syncImageCompareNode: (nodeId, imageA, imageB) => mediaControllerApi.syncImageCompareNode(nodeId, imageA, imageB),
            syncImageMergeNode: (nodeId, images) => mediaControllerApi.syncImageMergeNode(nodeId, images),
            renderImageMergePreview: (nodeId, images) => mediaControllerApi.renderImageMergePreview(nodeId, images),
            syncCameraControlNode: (nodeId, imageValue) => cameraControlNodeApi.syncCameraControlFromExecution(nodeId, imageValue),
            refreshDependentImageResizePreviews,
            restoreImageResizePreview,
            restoreColorResetPreview,
            showResolutionBadge,
            visibleNodesLayer: nodesLayer,
            bindVisibleNodeInteractions: ({ id, type, el }) => nodeDomBindingsApi.bindNodeInteractions({ id, type, el }),
            onVisibleNodeChanged: nodeId => {
                nodeDomBindingsApi.syncDependentPromptSources(nodeId);
                nodeDomBindingsApi.refreshDependentReferenceSources(nodeId);
                registry.imageGenerationRevisionApi?.observeAll();
                registry.imageFirstCanvasApi?.refreshSource(nodeId);
            },
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
    mediaAssetExists,
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
    onRetouchComparisonRemoved: nodeId => registry.imageFirstCanvasApi?.refreshNode(nodeId),
    onWorkflowViewApplied: (workflow) => {
        const batchMode = registry.batchConnectionModeApi;
        if (batchMode?.isActive()) batchMode.exit();
        getWorkflowRuntimeManagerApi().refreshVisibleWorkflowRunState(workflow);
        registry.imageGenerationRevisionApi?.observeAll({ initialize: true });
        const tab = (state.workflowTabs || []).find((candidate) => candidate.workflowId === workflow?.workflowId);
        promptAgentController.restoreWorkflow(tab?.data?.promptAgent || null);
        settingsControllerApi?.updateAgentCacheUsage();
        setTimeout(() => offerRetiredSaveNodeCleanup({ reset: true }), 0);
    },
    getPromptAgentState: () => promptAgentController.snapshotWorkflow(),
    onWorkflowReleased: workflowId => promptAgentController.cancelWorkflowRequest(workflowId),
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
    if (window.__cainflowAppReady) registry.imageGenerationRevisionApi?.observeAll();
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
    onNativeClipboardWrite: () => getClipboardControllerApi().markNativeClipboardWrite(),
    saveState: (...args) => {
        registry.imageGenerationRevisionApi?.observeAll();
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
    annotateHistoryImage,
    getHistoryCount,
    getHistoryPage,
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
    createImageResultActions: buildImageResultActions,
    localStorageRef: diskStorage,
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
    initFeatureModules,
    syncOpenWorkflowsBeforeConfigExport: () => workflowManagerApi.snapshotActiveWorkflow(),
    onConfigWorkflowsImported: (workflows) => workflowManagerApi.reloadAfterWorkflowImport(workflows?.[0]?.name || ''),
    applyWorkflowSidebarWidth: (width) => workflowManagerApi.applyWorkflowSidebarWidth(width),
    getSystemNotificationApi: () => getSystemNotificationApi(),
    documentRef: document,
    localStorageRef: diskStorage
});

function initFeatureModules() {
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
registry.canvasRunScopeMenu = createCanvasRunScopeMenu({
    state, documentRef: document,
    getWorkflowId: () => workflowManagerApi.getActiveWorkflowId(),
    getPreview: getCanvasRunScopePreview,
    openNodeSettings: (nodeId, action) => registry.imageFirstCanvasApi?.openNodeSettings(nodeId, action),
    runWorkflow
});
installSessionPersistenceOnExit({
    flushSession: () => getSessionManagerApi().flushSave(),
    flushWorkflows: () => workflowManagerApi.flushAutosave(),
    hasPendingWorkflows: () => workflowManagerApi.hasPendingAutosave()
});
window.cainflowPrepareExit = createDesktopExit({
    hasRunningTasks: () => state.isRunning || state.isRunStarting || state.activeRunCount > 0
        || commercePanelRuns.size > 0
        || state.runningNodeIds.size > 0 || state.canvasPlanApplying || promptAgentController.hasRunningTasks()
        || registry.conversationExecutionServiceApi?.hasRunningTasks()
        || registry.conversationImageGenerationServiceApi?.hasRunningTasks(),
    setBlocked: blocked => { document.body.inert = blocked; },
    settle: async ({ restart } = {}) => {
        if (state.canvasPlanApplying || state.isRunStarting) throw new Error('画布正在提交或启动，请稍后重新关闭');
        if (!restart) promptAgentController.cancelAllRequests();
        await getSessionManagerApi().waitForHistoryTransitions();
        if (!restart) await getWorkflowRuntimeManagerApi().settleForExit();
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
    finishRestart: jobId => window.__cainflowDesktop.restartAfterUpdate(jobId),
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
sessionRestorationComplete = true;
retiredSaveCleanupReady = true;
await offerRetiredSaveNodeCleanup({ reset: true });
await getConversationWorkbenchControllerApi().init().catch((error) => {
    showToast(`加载对话工作台失败：${error.message}`, 'error');
});
getConversationToolbarControllerApi().init();
const canvasMcpActions = createCanvasMcpActions({
    appActions: cainflowAppActions,
    canvasAdapter: promptAgentCanvasAdapter,
    getImageModels: () => getAvailablePromptAgentImageModels(state.models, state.providers)
        .map(model => ({
            id: model.id, name: model.name, modelId: model.modelId,
            providers: getModelProviders(model, state.providers)
                .filter(provider => String(provider.endpoint || '').trim() && String(provider.apikey || '').trim())
                .map(provider => {
                    const protocol = getEffectiveProtocol(model, provider);
                    const { parameters: { count, ...parameters }, maxReferences } = imageParameterCapabilities(model, provider);
                    return { id: provider.id, name: provider.name, maxReferences, parameters: {
                        ...parameters, generationCount: count,
                        aspect: { type: 'string', enum: getImageAspectOptionsForProtocol(protocol, model.modelId).map(option => option.value) },
                        resolution: { type: 'string', enum: getImageResolutionOptionsForProtocol(protocol, model.modelId).map(option => option.value) }
                    } };
                })
        })).filter(model => model.providers.length),
    getImageDefaults: () => {
        const { imageModelId, providerSettings } = promptAgentController.snapshotWorkflow();
        const models = getAvailablePromptAgentImageModels(state.models, state.providers);
        const preferred = models.find(model => model.id === imageModelId) || models[0];
        const providerIds = { ...providerSettings?.image };
        if (preferred && !providerIds[preferred.id]) {
            const boundProviders = getModelProviders(preferred, state.providers);
            if (boundProviders.length === 1) providerIds[preferred.id] = boundProviders[0].id;
        }
        return { modelId: preferred?.id, providerIds };
    },
    runWorkflow
});
startCanvasMcpEditor({ dispatch: canvasMcpActions.dispatch });

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
