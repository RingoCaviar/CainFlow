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
import { createStartupControllerApi } from './js/features/app/startup-controller.js';
import { createSettingsModalApi } from './js/features/settings/settings-modal.js';
import { createSettingsControllerApi } from './js/features/settings/settings-controller.js';
import { createUpdateManager } from './js/features/update/update-manager.js';
import { createHelpPanelApi } from './js/features/help/help-panel.js';
import { createWorkflowManagerApi } from './js/features/workflow/workflow-manager.js';
import { createPromptLibraryApi } from './js/features/prompts/prompt-library.js';

const WORKFLOW_RUNTIME_STATE_KEYS = [
    'autoRetry',
    'maxRetries',
    'concurrentRequestMode',
    'notificationsEnabled',
    'notificationVolume',
    'globalSaveDirHandle',
    'imageSaveUsePromptFilename',
    'imageAutoResizeEnabled',
    'imageMaxPixels',
    'proxy',
    'requestTimeoutEnabled',
    'requestTimeoutSeconds'
];

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
state.abortAllWorkflowRuns = abortAllWorkflowRuns;
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
const workflowRunContexts = new Map();
const workflowRunViewTimers = new Map();
const workflowRunViewNodeIds = new Set();

function syncGlobalRunToolbarState() {
    let activeRunCount = workflowRunContexts.size;
    workflowRunContexts.forEach((context) => {
        if ((context.state?.activeRunCount || 0) > 1) {
            activeRunCount += (context.state.activeRunCount - 1);
        }
    });
    state.activeRunCount = activeRunCount;
    state.isRunning = activeRunCount > 0;
    const runBtn = document.getElementById('btn-run');
    const stopBtn = document.getElementById('btn-stop');
    const hasActiveRuns = (state.activeRunCount || 0) > 0;
    const isRunStarting = state.isRunStarting === true;
    if (runBtn) {
        runBtn.classList.toggle('running', hasActiveRuns || isRunStarting);
        runBtn.disabled = isRunStarting;
    }
    if (stopBtn) {
        stopBtn.classList.toggle('running', hasActiveRuns || isRunStarting);
        stopBtn.disabled = !hasActiveRuns && !isRunStarting;
    }
}

function getWorkflowRunContext(workflowName) {
    return workflowRunContexts.get(workflowName) || null;
}

function clearWorkflowRunViewTimer(nodeId) {
    const timerId = workflowRunViewTimers.get(nodeId);
    if (timerId !== undefined) {
        clearInterval(timerId);
        workflowRunViewTimers.delete(nodeId);
    }
}

function clearWorkflowRunView({ keepLock = false } = {}) {
    workflowRunViewTimers.forEach((timerId) => clearInterval(timerId));
    workflowRunViewTimers.clear();
    workflowRunViewNodeIds.forEach((nodeId) => {
        state.runningNodeIds.delete(nodeId);
        state.runningNodeCancelHandlers.delete(nodeId);
        const node = state.nodes.get(nodeId);
        if (!node?.el) return;
        node.el.classList.remove('running', 'running-locked');
        node.el.querySelector('.node-run-cancel-btn')?.classList.remove('is-holding', 'is-canceling');
        setVisibleNodeControlsLocked(node, false);
    });
    workflowRunViewNodeIds.clear();
    if (!keepLock) {
        state.nodes.forEach((node) => {
            node.el?.classList.remove('workflow-running-locked');
        });
    }
}

function clearVisibleNodeRunState(nodeId) {
    clearWorkflowRunViewTimer(nodeId);
    workflowRunViewNodeIds.delete(nodeId);
    state.runningNodeIds.delete(nodeId);
    state.runningNodeCancelHandlers.delete(nodeId);
    const node = state.nodes.get(nodeId);
    if (!node?.el) return null;
    node.runStartedAt = null;
    node.el.classList.remove('running');
    node.el.querySelector('.node-run-cancel-btn')?.classList.remove('is-holding', 'is-canceling');
    setVisibleNodeControlsLocked(node, false);
    return node;
}

function setVisibleNodeControlsLocked(node, locked) {
    if (!node?.el) return;
    node.el.classList.toggle('running-locked', locked);
    node.el.querySelectorAll('input, select, textarea, button:not(.node-run-cancel-btn)').forEach((control) => {
        if (locked) {
            if (control.dataset.runningLockApplied !== '1') {
                control.dataset.runningLockApplied = '1';
                control.dataset.runningLockPrevDisabled = control.disabled ? '1' : '0';
            }
            control.disabled = true;
            return;
        }
        if (control.dataset.runningLockApplied === '1') {
            control.disabled = control.dataset.runningLockPrevDisabled === '1';
            delete control.dataset.runningLockApplied;
            delete control.dataset.runningLockPrevDisabled;
        }
    });
}

function updateVisibleNodeRunTimer(nodeId, startedAt) {
    const timeBadge = document.getElementById(`${nodeId}-time`);
    const timeContainer = document.getElementById(`${nodeId}-time-container`);
    if (!timeBadge) return;
    if (timeContainer) timeContainer.style.display = 'flex';
    const startTime = Number(startedAt) || Date.now();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    timeBadge.textContent = `${elapsed}s`;
    timeBadge.style.color = elapsed > 60 ? 'var(--accent-red)' : '';
}

function startVisibleNodeRunTimer(nodeId, startedAt) {
    clearWorkflowRunViewTimer(nodeId);
    updateVisibleNodeRunTimer(nodeId, startedAt);
    workflowRunViewTimers.set(nodeId, setInterval(() => {
        updateVisibleNodeRunTimer(nodeId, startedAt);
    }, 100));
}

function applyVisibleNodeRunState(workflowName, payload = {}) {
    if (!workflowName || state.activeWorkflowName !== workflowName) return;
    const nodeId = payload.nodeId;
    if (!nodeId) return;
    const node = state.nodes.get(nodeId);
    if (!node?.el) return;

    if (payload.running === true || payload.status === 'running') {
        const startedAt = Number(payload.startedAt) || Date.now();
        workflowRunViewNodeIds.add(nodeId);
        state.runningNodeIds.add(nodeId);
        state.runningNodeCancelHandlers.set(nodeId, () => {
            const context = getWorkflowRunContext(workflowName);
            return context?.runner?.cancelRunningNode?.(nodeId) || false;
        });
        node.runStartedAt = startedAt;
        node.el.classList.add('running');
        node.el.classList.remove('completed', 'error', 'workflow-running-locked');
        setVisibleNodeControlsLocked(node, true);
        startVisibleNodeRunTimer(nodeId, startedAt);
        updateAllConnections();
        return;
    }

    clearVisibleNodeRunState(nodeId);

    const status = payload.status || 'idle';
    if (status === 'completed') {
        node.el.classList.add('completed');
        node.el.classList.remove('error');
        const timeBadge = document.getElementById(`${nodeId}-time`);
        const timeContainer = document.getElementById(`${nodeId}-time-container`);
        if (timeContainer) timeContainer.style.display = 'flex';
        if (timeBadge && payload.durationSec) {
            timeBadge.textContent = `${payload.durationSec}s`;
            timeBadge.style.color = '';
        }
    } else if (status === 'error') {
        node.el.classList.add('error');
        node.el.classList.remove('completed');
        const timeBadge = document.getElementById(`${nodeId}-time`);
        const timeContainer = document.getElementById(`${nodeId}-time-container`);
        if (timeContainer) timeContainer.style.display = 'flex';
        if (timeBadge) timeBadge.textContent = 'Err';
    }
    updateAllConnections();
}

function refreshVisibleWorkflowRunState(workflowName = state.activeWorkflowName) {
    const context = getWorkflowRunContext(workflowName);
    clearWorkflowRunView({ keepLock: !!context });
    if (!context?.state?.runningNodeIds || context.state.runningNodeIds.size === 0) {
        return;
    }
    context.state.runningNodeIds.forEach((nodeId) => {
        const runtimeNode = context.state.nodes.get(nodeId);
        applyVisibleNodeRunState(workflowName, {
            nodeId,
            status: 'running',
            running: true,
            startedAt: runtimeNode?.runStartedAt || Date.now()
        });
    });
}

function refreshAllCameraControlPreviews() {
    cameraControlNodeApi.refreshAllCameraControlPreviews();
}

function handleNodeGraphChanged() {
    nodeDomBindingsApi?.syncImageMergeNodes?.();
    refreshAllImageResizePreviews();
    refreshAllCameraControlPreviews();
}

function clonePlainValue(value) {
    if (value === undefined) return undefined;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return value;
    }
}

function cloneWorkflowData(data = {}) {
    return {
        canvas: {
            x: Number(data?.canvas?.x) || 0,
            y: Number(data?.canvas?.y) || 0,
            zoom: Number(data?.canvas?.zoom) || 1
        },
        nodes: Array.isArray(data?.nodes) ? clonePlainValue(data.nodes) : [],
        connections: Array.isArray(data?.connections) ? clonePlainValue(data.connections) : [],
        version: data?.version || '1.3'
    };
}

function createDetachedElements(doc) {
    const wrapper = doc.createElement('div');
    wrapper.className = 'workflow-runtime-detached';
    wrapper.style.cssText = 'position:fixed;left:-100000px;top:-100000px;width:1000px;height:800px;overflow:hidden;pointer-events:none;';

    const canvasContainerEl = doc.createElement('div');
    canvasContainerEl.className = 'canvas-container';

    const nodesLayerEl = doc.createElement('div');
    nodesLayerEl.className = 'nodes-layer';

    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const connectionsGroupEl = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    const tempConnectionEl = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    const originAxesEl = doc.createElementNS('http://www.w3.org/2000/svg', 'g');

    svg.appendChild(connectionsGroupEl);
    svg.appendChild(tempConnectionEl);
    svg.appendChild(originAxesEl);
    canvasContainerEl.appendChild(nodesLayerEl);
    canvasContainerEl.appendChild(svg);
    wrapper.appendChild(canvasContainerEl);
    doc.body.appendChild(wrapper);

    return {
        wrapper,
        canvasContainer: canvasContainerEl,
        nodesLayer: nodesLayerEl,
        connectionsGroup: connectionsGroupEl,
        tempConnection: tempConnectionEl,
        originAxes: originAxesEl
    };
}

function readElementControlValue(doc, id, fallback = '') {
    const control = doc.getElementById(id);
    if (!control) return fallback;
    if (control.type === 'checkbox') return control.checked;
    return control.value ?? fallback;
}

function serializeRuntimeNode(node, doc) {
    const serialized = {
        id: node.id,
        type: node.type,
        x: node.x,
        y: node.y,
        width: node.width || null,
        height: node.height || null,
        userResized: node.userResized === true,
        collapsed: node.collapsed === true,
        enabled: node.enabled,
        isSucceeded: node.isSucceeded === true,
        lastDuration: node.lastDuration || null
    };
    if (node.isClone === true && node.cloneSourceId) {
        serialized.isClone = true;
        serialized.cloneSourceId = node.cloneSourceId;
    }
    if (node.customTitle) serialized.customTitle = node.customTitle;
    if (node.data?.imageMemoryReleased === true && node.data?.imageAssetKey) {
        serialized.imageMemoryReleased = true;
        serialized.imageAssetKey = node.data.imageAssetKey;
    }
    const images = Array.isArray(node.data?.images)
        ? node.data.images
        : (Array.isArray(node.imageDataList) ? node.imageDataList : []);
    if ((node.type === 'ImagePreview' || node.type === 'ImageSave') && images.length > 1) {
        serialized.imagePreviewIndex = Math.max(0, parseInt(node.imagePreviewIndex || '0', 10) || 0);
    }

    if (node.type === 'ImageImport') {
        serialized.importMode = readElementControlValue(doc, `${node.id}-import-mode`, node.importMode || 'upload');
        serialized.imageUrl = readElementControlValue(doc, `${node.id}-url-input`, node.imageUrl || '');
        serialized.imageImportAssetKey = node.imageImportAssetKey || node.data?.imageImportAssetKey || '';
    }
    if (node.type === 'ImageResize') {
        serialized.resizeMode = readElementControlValue(doc, `${node.id}-resize-mode`, node.resizeMode || 'scale');
        serialized.scalePercent = parseInt(readElementControlValue(doc, `${node.id}-scale-percent`, node.scalePercent || '100'), 10);
        serialized.targetWidth = readElementControlValue(doc, `${node.id}-target-width`, node.targetWidth || '');
        serialized.targetHeight = readElementControlValue(doc, `${node.id}-target-height`, node.targetHeight || '');
        serialized.keepAspect = readElementControlValue(doc, `${node.id}-keep-aspect`, node.keepAspect !== false) !== false;
        serialized.quality = parseInt(readElementControlValue(doc, `${node.id}-quality`, node.quality || '92'), 10);
        serialized.originalWidth = node.originalWidth || 0;
        serialized.originalHeight = node.originalHeight || 0;
        serialized.outputWidth = node.outputWidth || 0;
        serialized.outputHeight = node.outputHeight || 0;
        serialized.outputFormat = node.outputFormat || '';
        serialized.outputQuality = node.outputQuality || null;
        serialized.estimatedBytes = node.estimatedBytes || null;
    }
    if (node.type === 'ImageGenerate' || node.type === 'VideoGenerate' || node.type === 'TextChat') {
        serialized.referenceImageCount = Math.max(0, parseInt(node.referenceImageCount ?? node.data?.referenceImageCount ?? '5', 10) || 0);
        serialized.apiConfigId = readElementControlValue(doc, `${node.id}-apiconfig`, node.apiConfigId || 'default');
        serialized.providerId = readElementControlValue(doc, `${node.id}-provider`, node.providerId || '');
        serialized.prompt = readElementControlValue(doc, `${node.id}-prompt`, node.data?.prompt || '');
        serialized.generationCount = Math.max(1, parseInt(readElementControlValue(doc, `${node.id}-generation-count`, node.generationCount || node.data?.generationCount || '1'), 10) || 1);
        if (node.type === 'ImageGenerate') {
            serialized.aspect = readElementControlValue(doc, `${node.id}-aspect`, node.aspect || '');
            serialized.resolution = readElementControlValue(doc, `${node.id}-resolution`, node.resolution || '');
            serialized.customWidth = readElementControlValue(doc, `${node.id}-custom-resolution-width`, '');
            serialized.customHeight = readElementControlValue(doc, `${node.id}-custom-resolution-height`, '');
            serialized.customResolution = serialized.customWidth && serialized.customHeight ? `${serialized.customWidth}x${serialized.customHeight}` : '';
            serialized.quality = readElementControlValue(doc, `${node.id}-quality`, 'auto');
            serialized.moderation = readElementControlValue(doc, `${node.id}-moderation`, 'auto');
            serialized.background = readElementControlValue(doc, `${node.id}-background`, 'auto');
            serialized.search = readElementControlValue(doc, `${node.id}-search`, false) === true;
            serialized.imageTaskId = node.data?.imageTaskId || '';
            serialized.imageTaskStatus = node.data?.imageTaskStatus || '';
            serialized.imageTaskStatusText = node.data?.imageTaskStatusText || '';
            serialized.imageTaskUrl = node.data?.imageTaskUrl || '';
            serialized.imageTaskCreateHttpStatus = node.data?.imageTaskCreateHttpStatus || '';
            serialized.imageTaskCreateStatus = node.data?.imageTaskCreateStatus || '';
            serialized.imageTaskProgress = node.data?.imageTaskProgress || '';
        } else if (node.type === 'VideoGenerate') {
            serialized.aspect = readElementControlValue(doc, `${node.id}-aspect`, '16:9');
            serialized.useVideoSizeParam = readElementControlValue(doc, `${node.id}-use-size-param`, false) === true;
            serialized.enhancePrompt = readElementControlValue(doc, `${node.id}-enhance-prompt`, false) === true;
            serialized.enableUpsample = readElementControlValue(doc, `${node.id}-enable-upsample`, false) === true;
            serialized.doubaoResolution = readElementControlValue(doc, `${node.id}-doubao-resolution`, '720p');
            serialized.doubaoDuration = readElementControlValue(doc, `${node.id}-doubao-duration`, '5');
            serialized.doubaoCameraFixed = readElementControlValue(doc, `${node.id}-doubao-camera-fixed`, false) === true;
            serialized.doubaoGenerateAudio = readElementControlValue(doc, `${node.id}-doubao-generate-audio`, false) === true;
            serialized.doubaoWatermark = readElementControlValue(doc, `${node.id}-doubao-watermark`, false) === true;
            serialized.doubaoSeed = readElementControlValue(doc, `${node.id}-doubao-seed`, '');
            serialized.videoId = node.data?.videoId || '';
            serialized.videoUrl = node.data?.videoUrl || '';
            serialized.videoStatus = node.data?.videoStatus || '';
            serialized.videoStatusText = node.data?.videoStatusText || '';
            serialized.videoCreateHttpStatus = node.data?.videoCreateHttpStatus || '';
            serialized.videoCreateStatus = node.data?.videoCreateStatus || '';
            serialized.videoStatusUpdateTime = node.data?.videoStatusUpdateTime || '';
            serialized.videoEnhancedPrompt = node.data?.videoEnhancedPrompt || '';
            if (node.data?.video) serialized.video = clonePlainValue(node.data.video);
        } else {
            serialized.sysprompt = readElementControlValue(doc, `${node.id}-sysprompt`, '');
            serialized.search = readElementControlValue(doc, `${node.id}-search`, false) === true;
            serialized.fixed = readElementControlValue(doc, `${node.id}-fixed`, false) === true;
            serialized.lastResponse = node.lastResponse || '';
            serialized.lastText = node.data?.text || '';
        }
    }
    if (node.type === 'ImageSave') {
        serialized.filename = readElementControlValue(doc, `${node.id}-filename`, 'generated_image');
        if (node.data?.video) serialized.video = clonePlainValue(node.data.video);
    }
    if (node.type === 'ImageMerge' || node.type === 'TextMerge') {
        serialized.inputCount = Math.max(1, parseInt(node.data?.inputCount || '1', 10) || 1);
    }
    if (node.type === 'Text') {
        serialized.text = readElementControlValue(doc, `${node.id}-text`, node.data?.text || '');
        if (Array.isArray(node.data?.texts) && node.data.texts.length > 0) {
            serialized.texts = node.data.texts.slice();
            serialized.textPreviewIndex = Math.max(0, parseInt(node.textPreviewIndex || '0', 10) || 0);
        }
    }
    if (node.type === 'TextSplit') {
        serialized.text = node.data?.text || '';
        serialized.delimiter = readElementControlValue(doc, `${node.id}-delimiter`, node.data?.delimiter || '');
        const mergeOutputEnabled = readElementControlValue(doc, `${node.id}-merge-output-enabled`, node.data?.mergeOutputEnabled === true) === true;
        const parsedOutputCount = parseInt(readElementControlValue(doc, `${node.id}-output-count`, node.data?.outputCount ?? '1'), 10);
        serialized.outputCount = mergeOutputEnabled ? 0 : (Number.isFinite(parsedOutputCount) ? Math.max(0, parsedOutputCount) : 1);
        serialized.removeEmptyLines = readElementControlValue(doc, `${node.id}-remove-empty-lines`, node.data?.removeEmptyLines === true) === true;
        serialized.previewEnabled = readElementControlValue(doc, `${node.id}-preview-enabled`, node.data?.previewEnabled === true) === true;
        serialized.mergeOutputEnabled = mergeOutputEnabled;
        serialized.parts = Array.isArray(node.data?.parts) ? node.data.parts.slice() : [];
    }
    if (node.type === 'CustomParams') {
        serialized.params = Array.isArray(node.data?.params) ? clonePlainValue(node.data.params) : [];
    }
    if (node.type === 'CameraControl') {
        serialized.pitch = Number(node.data?.pitch ?? 12);
        serialized.yaw = Number(node.data?.yaw ?? 28);
        serialized.distance = Number(node.data?.distance ?? 6.5);
        serialized.fov = Number(node.data?.fov ?? 50);
        serialized.roll = Number(node.data?.roll ?? 0);
        serialized.cameraViewMode = node.data?.cameraViewMode === 'thirdPerson' ? 'thirdPerson' : 'firstPerson';
        serialized.text = node.data?.text || node.data?.cameraPrompt || '';
        serialized.cameraPrompt = serialized.text;
        serialized.cameraPreviewImage = node.data?.cameraPreviewImage || '';
    }
    return serialized;
}

function serializeRuntimeWorkflow(runtimeState, doc, workflowVersion = '1.3') {
    return {
        canvas: {
            x: Number(runtimeState.canvas?.x) || 0,
            y: Number(runtimeState.canvas?.y) || 0,
            zoom: Number(runtimeState.canvas?.zoom) || 1
        },
        nodes: Array.from(runtimeState.nodes.values()).map((node) => serializeRuntimeNode(node, doc)),
        connections: runtimeState.connections.map((connection) => ({
            id: connection.id,
            from: { ...connection.from },
            to: { ...connection.to },
            type: connection.type
        })),
        version: workflowVersion
    };
}

function createRuntimeMediaApi(runtimeState, doc) {
    const getRuntimeNode = (nodeId) => runtimeState.nodes.get(nodeId);
    const renderImagePreviewImage = (nodeId, images, emptyMessage = '无输入图片') => {
        const node = getRuntimeNode(nodeId);
        if (!node) return;
        const previewContainer = doc.getElementById(`${nodeId}-preview`);
        if (!previewContainer) return;
        const imageList = Array.isArray(images) ? images.filter(Boolean) : (images ? [images] : []);
        node.imagePreviewIndex = Math.max(0, Math.min(imageList.length - 1, parseInt(node.imagePreviewIndex || '0', 10) || 0));
        if (imageList.length === 0) {
            previewContainer.classList.remove('has-multiple-images');
            previewContainer.innerHTML = `<div class="preview-placeholder">${emptyMessage}</div>`;
            return;
        }
        const image = imageList[node.imagePreviewIndex] || imageList[0];
        previewContainer.classList.toggle('has-multiple-images', imageList.length > 1);
        previewContainer.innerHTML = `<img src="${image}" alt="预览" draggable="false" />`;
    };
    const renderImageSavePreview = (nodeId, images, emptyMessage = '无输入图片') => {
        const node = getRuntimeNode(nodeId);
        if (!node) return;
        const previewContainer = doc.getElementById(`${nodeId}-save-preview`);
        if (!previewContainer) return;
        const imageList = Array.isArray(images) ? images.filter(Boolean) : (images ? [images] : []);
        node.imagePreviewIndex = Math.max(0, Math.min(imageList.length - 1, parseInt(node.imagePreviewIndex || '0', 10) || 0));
        if (imageList.length === 0) {
            previewContainer.classList.remove('has-multiple-images');
            previewContainer.innerHTML = `<div class="save-preview-placeholder">${emptyMessage}</div>`;
            return;
        }
        const image = imageList[node.imagePreviewIndex] || imageList[0];
        previewContainer.classList.toggle('has-multiple-images', imageList.length > 1);
        previewContainer.innerHTML = `<img src="${image}" alt="待保存" draggable="false" />`;
    };
    return {
        restoreImageResizePreview: (nodeId, dataUrl, meta = {}) => {
            const node = getRuntimeNode(nodeId);
            if (!node) return;
            node.resizePreviewData = dataUrl || null;
            node.resizePreviewMeta = meta || null;
            node.imageData = dataUrl || null;
            node.data = node.data || {};
            if (dataUrl) node.data.image = dataUrl;
            const preview = doc.getElementById(`${nodeId}-resize-preview`);
            if (preview && dataUrl) {
                preview.innerHTML = `<img src="${dataUrl}" alt="缩放预览" draggable="false" />`;
            }
        },
        renderImagePreviewImage,
        renderImageSavePreview,
        renderImageComparePreview: (nodeId, imageA = null, imageB = null) => {
            const node = getRuntimeNode(nodeId);
            if (!node) return;
            node.compareImageA = imageA || null;
            node.compareImageB = imageB || null;
            node.data = node.data || {};
            if (imageB) {
                node.imageData = imageB;
                node.data.image = imageB;
            }
            const container = doc.getElementById(`${nodeId}-compare`);
            if (container) {
                container.classList.toggle('has-images', !!imageB);
                container.innerHTML = imageB ? `<img class="image-compare-img image-compare-b" src="${imageB}" alt="B 输入图片" draggable="false" />` : '<div class="image-compare-empty">等待 B 输入</div>';
            }
        },
        syncImagePreviewNode: async (nodeId, imageData) => {
            const node = getRuntimeNode(nodeId);
            if (!node || node.type !== 'ImagePreview') return;
            const imageList = Array.isArray(imageData) ? imageData.filter(Boolean) : (imageData ? [imageData] : []);
            node.previewZoom = 1;
            node.imagePreviewIndex = 0;
            node.imageDataList = imageList.slice();
            node.imageData = imageList[imageList.length - 1] || null;
            node.data = node.data || {};
            if (node.imageData) {
                node.data.image = node.imageData;
                if (imageList.length > 1) node.data.images = imageList.slice();
                else delete node.data.images;
                if (imageList.length > 1) await saveImageAssetList(nodeId, imageList);
                else await saveImageAsset(nodeId, node.imageData);
            } else {
                delete node.data.image;
                delete node.data.images;
                if (deleteImageAsset) await deleteImageAsset(nodeId);
            }
            renderImagePreviewImage(nodeId, imageList);
        },
        syncImageSaveNode: async (nodeId, imageData) => {
            const node = getRuntimeNode(nodeId);
            if (!node || node.type !== 'ImageSave') return;
            const imageList = Array.isArray(imageData?.images ?? imageData)
                ? (imageData?.images ?? imageData).filter(Boolean)
                : ((imageData?.images ?? imageData) ? [imageData?.images ?? imageData] : []);
            const video = imageData?.video && typeof imageData.video === 'object' ? imageData.video : null;
            node.imagePreviewIndex = 0;
            node.imageDataList = imageList.slice();
            node.imageData = imageList[imageList.length - 1] || null;
            node.data = node.data || {};
            if (node.imageData) {
                node.data.image = node.imageData;
                if (imageList.length > 1) node.data.images = imageList.slice();
                else delete node.data.images;
                delete node.data.video;
                if (imageList.length > 1) await saveImageAssetList(nodeId, imageList);
                else await saveImageAsset(nodeId, node.imageData);
                renderImageSavePreview(nodeId, imageList);
            } else if (video?.url) {
                delete node.data.image;
                delete node.data.images;
                node.data.video = {
                    id: video.id || '',
                    url: video.url,
                    status: video.status || '',
                    prompt: video.prompt || ''
                };
                if (deleteImageAsset) await deleteImageAsset(nodeId);
                const preview = doc.getElementById(`${nodeId}-save-preview`);
                if (preview) preview.innerHTML = `<video src="${video.url}" controls preload="metadata" playsinline></video>`;
            } else {
                delete node.data.image;
                delete node.data.images;
                delete node.data.video;
                if (deleteImageAsset) await deleteImageAsset(nodeId);
                renderImageSavePreview(nodeId, []);
            }
        },
        syncImageCompareNode: async (nodeId, imageA, imageB) => {
            const node = getRuntimeNode(nodeId);
            if (!node || node.type !== 'ImageCompare') return;
            node.compareImageA = imageA || null;
            node.compareImageB = imageB || null;
            node.imageData = imageB || null;
            node.data = node.data || {};
            if (imageB) node.data.image = imageB;
            else delete node.data.image;
        }
    };
}

function createWorkflowRuntimeContext(workflowName, workflowData) {
    const runtimeState = createInitialState();
    const runtimeDocument = document.implementation.createHTMLDocument(`CainFlow Runtime - ${workflowName}`);
    WORKFLOW_RUNTIME_STATE_KEYS.forEach((key) => {
        runtimeState[key] = state[key];
    });
    runtimeState.providers = state.providers.map((provider) => ({ ...provider }));
    runtimeState.models = state.models.map((model) => ({ ...model }));
    runtimeState.nodeDefaults = clonePlainValue(state.nodeDefaults);
    runtimeState.activeWorkflowName = workflowName;
    runtimeState.workflowTabs = [];

    const runtimeElements = createDetachedElements(runtimeDocument);
    const runtimeConnectionsApi = createConnectionsApi({
        state: runtimeState,
        canvasContainer: runtimeElements.canvasContainer,
        connectionsGroup: runtimeElements.connectionsGroup,
        tempConnection: runtimeElements.tempConnection,
        originAxes: runtimeElements.originAxes,
        getNodeById: (nodeId) => runtimeState.nodes.get(nodeId),
        createBezierPath: createBezierPathService,
        getConnectionSamplePoints: getConnectionSamplePointsService,
        pushHistory: () => {},
        showToast,
        scheduleSave: () => {},
        onConnectionsChanged: () => {},
        addNode: () => null,
        documentRef: runtimeDocument
    });
    const runtimeMediaApi = createRuntimeMediaApi(runtimeState, runtimeDocument);
    let runtimeRunnerApi = null;
    const runtimeCameraApi = createCameraControlNodeApi({
        state: runtimeState,
        fitNodeToContent: () => {},
        scheduleSave: () => {},
        showToast,
        documentRef: runtimeDocument
    });
    const runtimeNodeBindingsApi = createNodeDomBindingsApi({
        state: runtimeState,
        canvasContainer: runtimeElements.canvasContainer,
        connectionsGroup: runtimeElements.connectionsGroup,
        tempConnection: runtimeElements.tempConnection,
        viewportApi: { updateCanvasTransform: () => {}, screenToCanvas: (x, y) => ({ x, y }) },
        getPortPosition: (nodeId, portName, direction) => runtimeConnectionsApi.getPortPosition(nodeId, portName, direction),
        pushHistory: () => {},
        removeNode: () => {},
        selectNode: () => {},
        toggleNodesEnabled: () => {},
        cancelRunningNode: (nodeId) => runtimeRunnerApi?.cancelRunningNode?.(nodeId),
        finishConnection: () => false,
        resumeVideoGeneration: (nodeId) => runtimeRunnerApi?.resumeVideoNodeBranch?.(nodeId),
        resumeImageGeneration: (nodeId) => runtimeRunnerApi?.resumeImageNodeBranch?.(nodeId),
        setupImageImport: () => {},
        setupImageResize: () => {},
        setupImageSave: () => {},
        setupImagePreview: () => {},
        setupImageCompare: () => {},
        setupCameraControlNode: (id) => runtimeCameraApi.setupCameraControlNode(id, runtimeDocument.getElementById(id)),
        copyToClipboard,
        showToast,
        scheduleSave: () => {},
        debounce,
        fitNodeToContent: () => {},
        enforceNodeContentMinimum: () => {},
        getNodeMinimumSizeFromLifecycle: () => ({ minWidth: 120, minHeight: 80 }),
        updateAllConnections: () => runtimeConnectionsApi.updateAllConnections(),
        updatePortStyles: () => runtimeConnectionsApi.updatePortStyles(),
        onConnectionsChanged: () => {},
        documentRef: runtimeDocument
    });
    const runtimeNodeLifecycleApi = createNodeLifecycleApi({
        state: runtimeState,
        nodeConfigs: NODE_CONFIGS,
        createNodeMarkup,
        nodesLayer: runtimeElements.nodesLayer,
        generateId,
        getImageAsset,
        getImageAssetList,
        saveImageAsset,
        saveImageImportAsset,
        deleteImageImportAsset,
        showResolutionBadge: async () => {},
        restoreImageResizePreview: runtimeMediaApi.restoreImageResizePreview,
        renderImageImportUploadState: () => {},
        renderImagePreviewImage: runtimeMediaApi.renderImagePreviewImage,
        renderImageSavePreview: runtimeMediaApi.renderImageSavePreview,
        renderImageComparePreview: runtimeMediaApi.renderImageComparePreview,
        bindNodeInteractions: ({ id, type, el }) => runtimeNodeBindingsApi.bindNodeInteractions({ id, type, el }),
        serializeOneNode: null,
        pushHistory: () => {},
        scheduleSave: () => {},
        showToast,
        updateAllConnections: () => runtimeConnectionsApi.updateAllConnections(),
        updatePortStyles: () => runtimeConnectionsApi.updatePortStyles(),
        onConnectionsChanged: () => {},
        getCacheSidebarActive: () => false,
        updateCacheUsage: () => {},
        documentRef: runtimeDocument
    });
    const runtimeExecutionCoreApi = createExecutionCoreApi({
        state: runtimeState,
        nodeConfigs: NODE_CONFIGS,
        syncTextSplitNodeData: () => {},
        documentRef: runtimeDocument,
        windowRef: window,
        fetchRef: fetch,
        showToast,
        addLog,
        getProxyHeaders: (url, method = 'POST', extraHeaders = {}) => createProxyHeadersGetter(() => runtimeState)(url, method, extraHeaders),
        classifyProviderError: classifyProviderErrorService,
        logRequestToPanel,
        formatProxyErrorMessage: formatProxyErrorMessageService,
        saveHistoryEntry,
        renderHistoryList,
        showResolutionBadge: async () => {},
        saveImageAsset,
        saveImageAssetList,
        deleteImageAsset,
        dataURLtoBlob,
        blobToDataUrl,
        resizeImageData,
        autoSaveToDir: async () => {},
        restoreImageResizePreview: runtimeMediaApi.restoreImageResizePreview,
        refreshDependentImageResizePreviews: async () => syncRuntimeWorkflowSnapshot(context, { dirty: true }),
        syncImagePreviewNode: runtimeMediaApi.syncImagePreviewNode,
        syncImageSaveNode: runtimeMediaApi.syncImageSaveNode,
        syncImageCompareNode: runtimeMediaApi.syncImageCompareNode,
        syncCameraControlNode: (nodeId, imageValue) => runtimeCameraApi.syncCameraControlFromExecution(nodeId, imageValue),
        fitNodeToContent: () => {},
        scheduleSave: () => syncRuntimeWorkflowSnapshot(context),
        getAbortMessage: getAbortMessageService,
        updateAllConnections: () => runtimeConnectionsApi.updateAllConnections(),
        getImageHistorySidebarActive: () => document.getElementById('history-sidebar')?.classList.contains('active')
    });
    const context = {
        workflowName,
        state: runtimeState,
        elements: runtimeElements,
        dispose() {
            runtimeState.nodes.forEach((node) => cleanupElementResources(node.el));
            runtimeElements.wrapper?.remove();
            workflowRunContexts.delete(workflowName);
        },
        serialize() {
            return serializeRuntimeWorkflow(runtimeState, runtimeDocument, workflowData?.version || '1.3');
        }
    };
    runtimeRunnerApi = createWorkflowRunnerApi({
        state: runtimeState,
        nodeConfigs: NODE_CONFIGS,
        documentRef: runtimeDocument,
        confirmRef: confirm,
        resolveExecutionPlan: (runInput) => runtimeExecutionCoreApi.resolveExecutionPlan(runInput),
        normalizeRunOptions: (runInput) => runtimeExecutionCoreApi.normalizeRunOptions(runInput),
        getCachedOutputValue: (node, portName) => runtimeExecutionCoreApi.getCachedOutputValue(node, portName),
        executeNode: (node, inputs, signal, executionContext) => runtimeExecutionCoreApi.executeNode(node, inputs, signal, executionContext),
        resumeVideoGeneration: (nodeId, signal) => runtimeExecutionCoreApi.resumeVideoGeneration(nodeId, signal),
        resumeAsyncImageGeneration: (nodeId, signal) => runtimeExecutionCoreApi.resumeAsyncImageGeneration(nodeId, signal),
        addNode: (type, x, y, restoreData, silent = true) => runtimeNodeLifecycleApi.addNode(type, x, y, restoreData, silent),
        generateId,
        showToast,
        addLog,
        scheduleSave: () => syncRuntimeWorkflowSnapshot(context),
        updateAllConnections: () => runtimeConnectionsApi.updateAllConnections(),
        updatePortStyles: () => runtimeConnectionsApi.updatePortStyles(),
        getImageAsset,
        getImageAssetList,
        saveImageAsset,
        deleteImageAsset,
        saveImageAssetList,
        refreshDependentImageResizePreviews: async () => syncRuntimeWorkflowSnapshot(context, { dirty: true }),
        getAbortMessage: getAbortMessageService,
        playNotificationSound: () => settingsControllerApi.playNotificationSound(),
        systemNotificationApi: getSystemNotificationApi(),
        onNodeRunStateChange: (payload) => applyVisibleNodeRunState(workflowName, payload)
    });
    context.runner = runtimeRunnerApi;

    const data = cloneWorkflowData(workflowData);
    runtimeState.canvas.x = data.canvas.x;
    runtimeState.canvas.y = data.canvas.y;
    runtimeState.canvas.zoom = data.canvas.zoom;
    data.nodes.forEach((nodeData) => runtimeNodeLifecycleApi.addNode(nodeData.type, nodeData.x, nodeData.y, nodeData, true));
    data.connections.forEach((connection) => {
        if (runtimeState.nodes.has(connection.from.nodeId) && runtimeState.nodes.has(connection.to.nodeId)) {
            runtimeState.connections.push({
                id: connection.id || `c_${generateId()}`,
                from: { ...connection.from },
                to: { ...connection.to },
                type: connection.type
            });
        }
    });
    runtimeConnectionsApi.updateAllConnections();
    runtimeConnectionsApi.updatePortStyles();
    workflowRunContexts.set(workflowName, context);
    return context;
}

function syncRuntimeWorkflowSnapshot(context, options = {}) {
    if (!context?.workflowName) return false;
    const data = context.serialize();
    const applyToCanvas = state.activeWorkflowName === context.workflowName && options.applyToCanvas === true;
    return workflowManagerApi?.updateWorkflowTabData?.(context.workflowName, data, {
        dirty: options.dirty !== false,
        applyToCanvas
    });
}

async function runWorkflowInContext(workflowName, workflowData, runInput = null) {
    const existingContext = workflowRunContexts.get(workflowName);
    if (existingContext?.state?.activeRunCount > 0 || existingContext?.state?.isRunStarting) {
        showToast(`工作流「${workflowName}」正在运行，请等待它完成后再运行`, 'warning');
        return false;
    }

    const context = createWorkflowRuntimeContext(workflowName, workflowData);
    workflowManagerApi.setWorkflowRunningState(workflowName, true);
    syncGlobalRunToolbarState();

    context.promise = (async () => {
        try {
            await context.runner.runWorkflow(runInput);
            syncRuntimeWorkflowSnapshot(context, { dirty: true, applyToCanvas: true });
        } catch (error) {
            addLog('error', `工作流运行异常: ${workflowName}`, error?.message || String(error), {
                workflowName,
                error: error?.stack || error
            });
            syncRuntimeWorkflowSnapshot(context, { dirty: true, applyToCanvas: true });
        } finally {
            workflowManagerApi.setWorkflowRunningState(workflowName, false);
            if (state.activeWorkflowName === workflowName) {
                refreshVisibleWorkflowRunState(workflowName);
            }
            context.dispose();
            syncGlobalRunToolbarState();
            scheduleSave({ dirty: false });
        }
    })();
    return true;
}

function abortAllWorkflowRuns(reason = 'manual') {
    state.abortReason = reason;
    workflowRunContexts.forEach((context) => {
        context.state.abortReason = reason;
        if (context.state.runAbortControllers instanceof Set && context.state.runAbortControllers.size > 0) {
            context.state.runAbortControllers.forEach((controller) => controller.abort());
        } else {
            context.state.abortController?.abort();
        }
    });
}

function hasIncomingImageConnection(nodeId) {
    return state.connections.some((conn) => (
        conn.to.nodeId === nodeId
        && (conn.to.port === 'image' || conn.to.port === 'imageA' || conn.to.port === 'imageB')
    ));
}

function collectRetainedNodeAssetIds() {
    const recoverableDisplayTypes = new Set(['ImagePreview', 'ImageSave', 'ImageCompare']);
    return new Set(Array.from(state.nodes.values())
        .filter((node) => {
            if (!node?.id) return false;
            return !(recoverableDisplayTypes.has(node.type) && hasIncomingImageConnection(node.id));
        })
        .map((node) => node.id));
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

    notices.upsertNotice({
        id: 'workflow-backup',
        priority: 10,
        className: 'workflow-backup-notice',
        icon: '!',
        content: ['及时备份 ', { code: true, text: 'workflows文件夹' }, ' 里的工作流，防止更新后丢失'],
        dismissible: true,
        closeLabel: '关闭工作流备份提醒'
    });

    notices.upsertNotice({
        id: 'refresh-tip',
        elementId: 'refresh-notice',
        priority: 20,
        icon: '💡',
        content: ['本APP更新频繁，建议使用 ', { highlight: true, text: 'Ctrl + F5' }, ' 强制刷新以加载最新版'],
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
    formatProxyErrorMessage: formatProxyErrorMessageService
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

async function runWorkflow(runInput = null) {
    if (state.isRunStarting) return false;
    state.isRunStarting = true;
    syncGlobalRunToolbarState();
    try {
        if (!(await workflowManagerApi.ensureOpenWorkflow())) return false;
        const workflowName = workflowManagerApi.getActiveWorkflowName();
        if (!workflowName) {
            showToast('请先打开或新建一个工作流', 'warning');
            return false;
        }
        const workflowData = workflowManagerApi.getActiveWorkflowSnapshot();
        return runWorkflowInContext(workflowName, workflowData, runInput);
    } finally {
        state.isRunStarting = false;
        syncGlobalRunToolbarState();
    }
}

function cancelRunningNode(nodeId) {
    if (state.runningNodeIds?.has(nodeId)) {
        return getWorkflowRunnerApi().cancelRunningNode(nodeId);
    }
    for (const context of workflowRunContexts.values()) {
        if (context.state.runningNodeIds?.has(nodeId)) {
            return context.runner.cancelRunningNode(nodeId);
        }
    }
    return false;
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
            clearOrphanedNodeAssets
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
            clearImageAssets,
            clearOrphanedNodeAssets,
            cleanupRecoverableNodeAssetCache,
            clearUndoStack: () => {
                state.undoStack = [];
                updateUndoButton();
            },
            updateCacheUsage: () => settingsControllerApi?.updateCacheUsage()
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
            buildNodeRequestPreview: (nodeId) => getExecutionCoreApi().buildNodeRequestPreview(nodeId),
            createNodeFromConnectionCandidate: (source, candidate, x, y) => createNodeFromConnectionCandidate(source, candidate, x, y),
            updateAllConnections,
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
            getProxyHeaders,
            classifyProviderError: classifyProviderErrorService,
            logRequestToPanel,
            formatProxyErrorMessage: formatProxyErrorMessageService,
            saveHistoryEntry,
            renderHistoryList,
            showResolutionBadge,
            saveImageAsset,
            saveImageAssetList,
            deleteImageAsset,
            dataURLtoBlob,
            blobToDataUrl,
            resizeImageData,
            autoSaveToDir,
    restoreImageResizePreview,
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
            refreshDependentImageResizePreviews,
            getAbortMessage: getAbortMessageService,
            playNotificationSound: () => settingsControllerApi.playNotificationSound(),
            systemNotificationApi: getSystemNotificationApi(),
            onNodeRunStateChange: (payload) => {
                if (state.activeWorkflowName) {
                    applyVisibleNodeRunState(state.activeWorkflowName, payload);
                }
            }
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
    onWorkflowViewApplied: (workflowName) => refreshVisibleWorkflowRunState(workflowName)
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
