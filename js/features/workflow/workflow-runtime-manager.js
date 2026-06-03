import { cleanupElementResources } from '../../core/common-utils.js';
import { createInitialState } from '../../core/state.js';
import { createProxyHeadersGetter } from '../../services/api-client.js';
import { createConnectionsApi } from '../../canvas/connections.js';
import { createCameraControlNodeApi } from '../camera/camera-control-node-proxy.js';
import { createExecutionCoreApi } from '../execution/execution-core.js';
import { createWorkflowRunnerApi } from '../execution/workflow-runner.js';
import {
    normalizeConcurrentRequestStatusPayload,
    removeConcurrentRequestStatusPanel,
    renderConcurrentRequestStatusPanel
} from '../execution/concurrent-request-status-ui.js';
import { createNodeDomBindingsApi } from '../../nodes/node-dom-bindings.js';
import { createNodeLifecycleApi } from '../../nodes/node-lifecycle.js';

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

const IMAGE_RESULT_NODE_TYPES = new Set(['ImageGenerate', 'ImagePreview', 'ImageSave', 'ImageResize', 'ImageCompare', 'ImageMerge']);

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

function getWorkflowConnectionIdentity(connection, index = 0) {
    if (connection?.id) return String(connection.id);
    const from = connection?.from || {};
    const to = connection?.to || {};
    return [
        from.nodeId || '',
        from.port || '',
        to.nodeId || '',
        to.port || '',
        connection?.type || '',
        index
    ].join('::');
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
        isFailed: node.isFailed === true || node.el?.classList?.contains('error') === true,
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
    const images = normalizeRuntimeImageList(
        Array.isArray(node.data?.images)
            ? node.data.images
            : (Array.isArray(node.imageDataList) ? node.imageDataList : [])
    );
    const imageCount = Math.max(images.length, Math.max(0, parseInt(node.data?.imageCount || '0', 10) || 0));
    if (IMAGE_RESULT_NODE_TYPES.has(node.type)) {
        if (images.length > 0) {
            serialized.images = images.slice();
        }
        const imageData = typeof node.data?.image === 'string' && node.data.image.trim()
            ? node.data.image
            : (typeof node.imageData === 'string' && node.imageData.trim() ? node.imageData : images[0]);
        if (imageData) serialized.imageData = imageData;
        if (node.type === 'ImagePreview' || node.type === 'ImageSave') {
            if (node.data?.imageAssetKey) serialized.imageAssetKey = node.data.imageAssetKey;
            if (imageCount > 0) serialized.imageCount = imageCount;
            if (imageCount > 1) {
                serialized.imagePreviewIndex = Math.max(0, parseInt(node.imagePreviewIndex || '0', 10) || 0);
            }
        }
        if (node.type === 'ImageCompare') {
            const compareImageA = typeof node.compareImageA === 'string' && node.compareImageA.trim()
                ? node.compareImageA
                : (typeof node.data?.compareImageA === 'string' ? node.data.compareImageA : '');
            const compareImageB = typeof node.compareImageB === 'string' && node.compareImageB.trim()
                ? node.compareImageB
                : (typeof node.data?.compareImageB === 'string' ? node.data.compareImageB : '');
            if (compareImageA) serialized.compareImageA = compareImageA;
            if (compareImageB) serialized.compareImageB = compareImageB;
            if (compareImageB && !serialized.imageData) serialized.imageData = compareImageB;
        }
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
            serialized.generationCompletedCount = Math.max(0, parseInt(node.generationCompletedCount ?? images.length ?? '0', 10) || 0);
            if (node.data?.concurrentRequestStatus?.total > 0) {
                serialized.concurrentRequestStatus = normalizeConcurrentRequestStatusPayload(node.data.concurrentRequestStatus);
            }
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

function sanitizeRuntimeFilenamePart(value, fallback = 'image') {
    const safe = String(value || '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return safe || fallback;
}

function getRuntimeTimestampText() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function getAvailableRuntimeFileHandle(directoryHandle, baseName, extension = '.png') {
    const safeBaseName = sanitizeRuntimeFilenamePart(baseName, 'image');
    const safeExtension = String(extension || '.png').startsWith('.') ? extension : `.${extension}`;
    for (let index = 0; index < 1000; index += 1) {
        const filename = index === 0
            ? `${safeBaseName}${safeExtension}`
            : `${safeBaseName}_${index + 1}${safeExtension}`;
        try {
            await directoryHandle.getFileHandle(filename, { create: false });
        } catch {
            const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
            return { fileHandle, filename };
        }
    }
    throw new Error('无法创建可用文件名');
}

function normalizeRuntimeImageList(value) {
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim());
    if (typeof value === 'string' && value.trim()) return [value];
    return [];
}

function getRuntimeDisplayImageCount(node) {
    return Math.max(
        normalizeRuntimeImageList(node?.data?.images).length,
        normalizeRuntimeImageList(node?.imageDataList).length,
        Math.max(0, parseInt(node?.data?.imageCount || '0', 10) || 0)
    );
}

export function createWorkflowRuntimeManager({
    state,
    nodeConfigs,
    createNodeMarkup,
    createBezierPath,
    getConnectionSamplePoints,
    generateId,
    showToast,
    addLog,
    scheduleSave,
    updateAllConnections,
    updatePortStyles,
    getWorkflowManagerApi,
    getSettingsControllerApi,
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
    recordNodeRequest = () => {},
    classifyProviderError,
    formatProxyErrorMessage,
    getAbortMessage,
    dataURLtoBlob,
    blobToDataUrl,
    resizeImageData,
    copyToClipboard,
    debounce,
    fitNodeToContent,
    documentRef = document,
    windowRef = window,
    fetchRef = fetch,
    confirmRef = confirm
}) {
    const workflowRunContexts = new Map();
    const workflowRunViewTimers = new Map();
    const workflowRunViewNodeIds = new Set();
    let workflowRunContextSeq = 0;

    function syncGlobalRunToolbarState() {
        let activeRunCount = workflowRunContexts.size;
        workflowRunContexts.forEach((context) => {
            if ((context.state?.activeRunCount || 0) > 1) {
                activeRunCount += (context.state.activeRunCount - 1);
            }
        });
        state.activeRunCount = activeRunCount;
        state.isRunning = activeRunCount > 0;
        const runBtn = documentRef.getElementById('btn-run');
        const stopBtn = documentRef.getElementById('btn-stop');
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

    function getWorkflowRunContexts(workflowName) {
        return Array.from(workflowRunContexts.values())
            .filter((context) => context.workflowName === workflowName);
    }

    function getWorkflowRunContext(workflowName) {
        return getWorkflowRunContexts(workflowName)[0] || null;
    }

    function getWorkflowRunContextForNode(workflowName, nodeId) {
        return getWorkflowRunContexts(workflowName)
            .find((context) => context.state?.runningNodeIds?.has(nodeId)) || null;
    }

    function getActivePlanNodeIds(workflowName) {
        const nodeIds = new Set();
        getWorkflowRunContexts(workflowName).forEach((context) => {
            if (context.activePlanNodeIds instanceof Set) {
                context.activePlanNodeIds.forEach((nodeId) => nodeIds.add(nodeId));
            }
        });
        return nodeIds;
    }

    function getPlanOverlapNodeIds(workflowName, nodeIds = []) {
        const activePlanNodeIds = getActivePlanNodeIds(workflowName);
        return Array.from(nodeIds).filter((nodeId) => activePlanNodeIds.has(nodeId));
    }

    function isWorkflowRunning(workflowName) {
        return getWorkflowRunContexts(workflowName).length > 0;
    }

    function recordRuntimeNodeRunState(context, payload = {}) {
        if (!context) return;
        const status = payload.status || '';
        if (payload.running === true || status === 'running') {
            context.nodeRunStarted = true;
            return;
        }
        if (status === 'error' || status === 'aborted') {
            context.runResult = 'error';
            return;
        }
        if (status === 'completed' && context.runResult !== 'error') {
            context.runResult = 'success';
        }
    }

    function deriveWorkflowRunResult(context, caughtError = null) {
        if (!context) return '';
        if (caughtError || context.runResult === 'error' || context.abortReason) return 'error';

        let hasFailedNode = false;
        let hasCompletedNode = false;
        context.state.nodes.forEach((node) => {
            if (node?.isFailed === true || node?.el?.classList?.contains('error')) {
                hasFailedNode = true;
            }
            if (node?.isSucceeded === true || node?.el?.classList?.contains('completed')) {
                hasCompletedNode = true;
            }
        });

        if (context.nodeRunStarted === true && hasFailedNode) return 'error';
        if (context.nodeRunStarted === true && (context.runResult === 'success' || hasCompletedNode)) return 'success';
        return '';
    }

    function clearWorkflowRunViewTimer(nodeId) {
        const timerId = workflowRunViewTimers.get(nodeId);
        if (timerId !== undefined) {
            windowRef.clearInterval(timerId);
            workflowRunViewTimers.delete(nodeId);
        }
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

    function clearWorkflowRunView({ keepLock = false } = {}) {
        workflowRunViewTimers.forEach((timerId) => windowRef.clearInterval(timerId));
        workflowRunViewTimers.clear();
        workflowRunViewNodeIds.forEach((nodeId) => {
            state.runningNodeIds.delete(nodeId);
            state.runningNodeCancelHandlers.delete(nodeId);
            const node = state.nodes.get(nodeId);
            if (!node?.el) return;
            node.el.classList.remove('running', 'running-locked');
            node.el.querySelector('.node-run-cancel-btn')?.classList.remove('is-holding', 'is-canceling');
            setVisibleNodeControlsLocked(node, false);
            removeConcurrentRequestStatusPanel(node);
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

    function updateVisibleNodeRunTimer(nodeId, startedAt) {
        const timeBadge = documentRef.getElementById(`${nodeId}-time`);
        const timeContainer = documentRef.getElementById(`${nodeId}-time-container`);
        if (!timeBadge) return;
        if (timeContainer) timeContainer.style.display = 'flex';
        const startTime = Number(startedAt) || Date.now();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        timeBadge.textContent = `${elapsed}s`;
        timeBadge.style.color = elapsed > 60 ? 'var(--accent-red)' : '';
    }

    function renderVisibleConcurrentRequestStatus(node, statusPayload = {}) {
        if (!node?.el) return;
        const normalized = normalizeConcurrentRequestStatusPayload(statusPayload);
        node.data = node.data || {};
        if (normalized.total > 0) node.data.concurrentRequestStatus = normalized;
        else delete node.data.concurrentRequestStatus;
        renderConcurrentRequestStatusPanel(node, normalized, { documentRef });
    }

    function startVisibleNodeRunTimer(nodeId, startedAt) {
        clearWorkflowRunViewTimer(nodeId);
        updateVisibleNodeRunTimer(nodeId, startedAt);
        workflowRunViewTimers.set(nodeId, windowRef.setInterval(() => {
            updateVisibleNodeRunTimer(nodeId, startedAt);
        }, 100));
    }

    function applyVisibleNodeRunState(workflowName, payload = {}) {
        if (!workflowName || state.activeWorkflowName !== workflowName) return;
        const nodeId = payload.nodeId;
        if (!nodeId) return;
        const node = state.nodes.get(nodeId);
        if (!node?.el) return;

        if (payload.status === 'concurrent-request-status') {
            renderVisibleConcurrentRequestStatus(node, payload.concurrentRequestStatus);
            return;
        }

        if (payload.running === true || payload.status === 'running') {
            const startedAt = Number(payload.startedAt) || Date.now();
            removeConcurrentRequestStatusPanel(node);
            if (node.data?.concurrentRequestStatus) delete node.data.concurrentRequestStatus;
            workflowRunViewNodeIds.add(nodeId);
            state.runningNodeIds.add(nodeId);
            state.runningNodeCancelHandlers.set(nodeId, () => {
                const context = getWorkflowRunContextForNode(workflowName, nodeId);
                return context?.runner?.cancelRunningNode?.(nodeId) || false;
            });
            node.runStartedAt = startedAt;
            node.isFailed = false;
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
            node.isSucceeded = true;
            node.isFailed = false;
            node.el.classList.add('completed');
            node.el.classList.remove('error');
            const timeBadge = documentRef.getElementById(`${nodeId}-time`);
            const timeContainer = documentRef.getElementById(`${nodeId}-time-container`);
            if (timeContainer) timeContainer.style.display = 'flex';
            if (timeBadge && payload.durationSec) {
                timeBadge.textContent = `${payload.durationSec}s`;
                timeBadge.style.color = '';
            }
        } else if (status === 'error') {
            node.isSucceeded = false;
            node.isFailed = true;
            node.el.classList.add('error');
            node.el.classList.remove('completed');
            const timeBadge = documentRef.getElementById(`${nodeId}-time`);
            const timeContainer = documentRef.getElementById(`${nodeId}-time-container`);
            if (timeContainer) timeContainer.style.display = 'flex';
            if (timeBadge) timeBadge.textContent = 'Err';
        }
        updateAllConnections();
    }

    function refreshVisibleWorkflowRunState(workflowName = state.activeWorkflowName) {
        const contexts = getWorkflowRunContexts(workflowName);
        clearWorkflowRunView({ keepLock: contexts.length > 0 });
        if (contexts.length === 0) {
            return;
        }
        contexts.forEach((context) => {
            context.state.runningNodeIds?.forEach((nodeId) => {
                const runtimeNode = context.state.nodes.get(nodeId);
                applyVisibleNodeRunState(workflowName, {
                    nodeId,
                    status: 'running',
                    running: true,
                    startedAt: runtimeNode?.runStartedAt || Date.now()
                });
                if (runtimeNode?.data?.concurrentRequestStatus?.total > 0) {
                    applyVisibleNodeRunState(workflowName, {
                        nodeId,
                        status: 'concurrent-request-status',
                        concurrentRequestStatus: runtimeNode.data.concurrentRequestStatus
                    });
                }
            });
        });
    }

    function createRuntimeMediaApi(runtimeState, doc) {
        const getRuntimeNode = (nodeId) => runtimeState.nodes.get(nodeId);
        const renderImagePreviewImage = (nodeId, images, emptyMessage = '无输入图片') => {
            const node = getRuntimeNode(nodeId);
            if (!node) return;
            const previewContainer = doc.getElementById(`${nodeId}-preview`);
            if (!previewContainer) return;
            const imageList = Array.isArray(images) ? images.filter(Boolean) : (images ? [images] : []);
            const totalCount = Math.max(imageList.length, getRuntimeDisplayImageCount(node));
            node.imagePreviewIndex = totalCount > 0
                ? Math.max(0, Math.min(totalCount - 1, parseInt(node.imagePreviewIndex || '0', 10) || 0))
                : 0;
            if (imageList.length === 0 && totalCount === 0) {
                previewContainer.classList.remove('has-multiple-images');
                previewContainer.innerHTML = `<div class="preview-placeholder">${emptyMessage}</div>`;
                return;
            }
            const image = imageList.length > 1
                ? (imageList[node.imagePreviewIndex] || imageList[0])
                : (imageList[0] || '');
            previewContainer.classList.toggle('has-multiple-images', totalCount > 1);
            previewContainer.innerHTML = `<img src="${image}" alt="预览" draggable="false" />`;
        };
        const renderImageSavePreview = (nodeId, images, emptyMessage = '无输入图片') => {
            const node = getRuntimeNode(nodeId);
            if (!node) return;
            const previewContainer = doc.getElementById(`${nodeId}-save-preview`);
            if (!previewContainer) return;
            const imageList = Array.isArray(images) ? images.filter(Boolean) : (images ? [images] : []);
            const totalCount = Math.max(imageList.length, getRuntimeDisplayImageCount(node));
            node.imagePreviewIndex = totalCount > 0
                ? Math.max(0, Math.min(totalCount - 1, parseInt(node.imagePreviewIndex || '0', 10) || 0))
                : 0;
            if (imageList.length === 0 && totalCount === 0) {
                previewContainer.classList.remove('has-multiple-images');
                previewContainer.innerHTML = `<div class="save-preview-placeholder">${emptyMessage}</div>`;
                return;
            }
            const image = imageList.length > 1
                ? (imageList[node.imagePreviewIndex] || imageList[0])
                : (imageList[0] || '');
            previewContainer.classList.toggle('has-multiple-images', totalCount > 1);
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
                if (imageA) node.data.compareImageA = imageA;
                else delete node.data.compareImageA;
                if (imageB) node.data.compareImageB = imageB;
                else delete node.data.compareImageB;
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
                node.imageDataList = [];
                node.imageData = imageList[0] || null;
                node.data = node.data || {};
                if (node.imageData) {
                    node.data.image = node.imageData;
                    node.data.imageAssetKey = nodeId;
                    node.data.imageCount = imageList.length;
                    delete node.data.images;
                    if (imageList.length > 1) await saveImageAssetList(nodeId, imageList);
                    else await saveImageAsset(nodeId, node.imageData);
                } else {
                    delete node.data.image;
                    delete node.data.imageAssetKey;
                    delete node.data.imageCount;
                    delete node.data.images;
                    if (deleteImageAsset) await deleteImageAsset(nodeId);
                }
                renderImagePreviewImage(nodeId, node.imageData ? [node.imageData] : []);
            },
            syncImageSaveNode: async (nodeId, imageData) => {
                const node = getRuntimeNode(nodeId);
                if (!node || node.type !== 'ImageSave') return;
                const imageList = Array.isArray(imageData?.images ?? imageData)
                    ? (imageData?.images ?? imageData).filter(Boolean)
                    : ((imageData?.images ?? imageData) ? [imageData?.images ?? imageData] : []);
                const video = imageData?.video && typeof imageData.video === 'object' ? imageData.video : null;
                node.imagePreviewIndex = 0;
                node.imageDataList = [];
                node.imageData = imageList[0] || null;
                node.data = node.data || {};
                if (node.imageData) {
                    node.data.image = node.imageData;
                    node.data.imageAssetKey = nodeId;
                    node.data.imageCount = imageList.length;
                    delete node.data.images;
                    delete node.data.video;
                    if (imageList.length > 1) await saveImageAssetList(nodeId, imageList);
                    else await saveImageAsset(nodeId, node.imageData);
                    renderImageSavePreview(nodeId, [node.imageData]);
                } else if (video?.url) {
                    delete node.data.image;
                    delete node.data.imageAssetKey;
                    delete node.data.imageCount;
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
                    delete node.data.imageAssetKey;
                    delete node.data.imageCount;
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
                if (imageA) node.data.compareImageA = imageA;
                else delete node.data.compareImageA;
                if (imageB) node.data.compareImageB = imageB;
                else delete node.data.compareImageB;
                if (imageB) node.data.image = imageB;
                else delete node.data.image;
            }
        };
    }

    function syncRuntimeWorkflowSnapshot(context, options = {}) {
        if (!context?.workflowName) return false;
        const data = context.serialize();
        const applyToCanvas = state.activeWorkflowName === context.workflowName && options.applyToCanvas === true;
        const mergeRunResults = options.mergeRunResults !== false;
        const mergeNodeIds = options.mergeNodeIds instanceof Set ? options.mergeNodeIds : context.activePlanNodeIds;
        return getWorkflowManagerApi()?.updateWorkflowTabData?.(context.workflowName, data, {
            dirty: options.dirty !== false,
            applyToCanvas,
            mergeRunResults,
            mergeWithCanvas: mergeRunResults && state.activeWorkflowName === context.workflowName,
            baseNodeIds: context.baseNodeIds,
            baseConnectionIds: context.baseConnectionIds,
            mergeNodeIds
        });
    }

    function syncRuntimeNodeSnapshot(context, nodeId, options = {}) {
        if (!context?.workflowName || !nodeId) return false;
        return syncRuntimeWorkflowSnapshot(context, {
            dirty: options.dirty !== false,
            applyToCanvas: options.applyToCanvas !== false,
            mergeRunResults: true,
            mergeNodeIds: new Set([nodeId])
        });
    }

    function createWorkflowRuntimeContext(workflowName, workflowData) {
        const contextId = `${workflowName}::${Date.now()}::${workflowRunContextSeq += 1}`;
        const runtimeState = createInitialState();
        const runtimeDocument = documentRef.implementation.createHTMLDocument(`CainFlow Runtime - ${workflowName}`);
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
            createBezierPath,
            getConnectionSamplePoints,
            pushHistory: () => {},
            showToast,
            scheduleSave: () => {},
            onConnectionsChanged: () => {},
            addNode: () => null,
            documentRef: runtimeDocument
        });
        const runtimeMediaApi = createRuntimeMediaApi(runtimeState, runtimeDocument);
        const runtimeAutoSaveToDir = async (nodeId, payload) => {
            const node = runtimeState.nodes.get(nodeId);
            if (!node) return;
            const images = normalizeRuntimeImageList(payload?.images ?? payload);
            if (images.length === 0) return;
            const handle = runtimeState.globalSaveDirHandle;
            if (!handle) {
                showToast('自动保存提醒：尚未在通用设置中选择全局保存目录，内容仅保存在节点内', 'warning', 5000);
                addLog('warning', '自动保存跳过', '未在通用设置中配置保存路径', { nodeId, workflowName });
                return;
            }
            try {
                const perm = await handle.queryPermission({ mode: 'readwrite' });
                if (perm !== 'granted') {
                    const req = await handle.requestPermission({ mode: 'readwrite' });
                    if (req !== 'granted') {
                        showToast('【自动保存失败】目录访问权限被拒绝', 'error');
                        addLog('error', '自动保存失败', '权限被拒绝', { nodeId, workflowName });
                        return;
                    }
                }

                const prefix = runtimeDocument.getElementById(`${nodeId}-filename`)?.value || 'image';
                const timestamp = getRuntimeTimestampText();
                const savedFilenames = [];
                for (let index = 0; index < images.length; index += 1) {
                    const image = images[index];
                    const blob = dataURLtoBlob(image);
                    if (!blob) throw new Error('图片数据无效，无法写入文件');
                    const baseName = `${prefix}_${timestamp}${images.length > 1 ? `_${index + 1}` : ''}`;
                    const { fileHandle, filename } = await getAvailableRuntimeFileHandle(handle, baseName, '.png');
                    const writable = await fileHandle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    savedFilenames.push(filename);
                }

                showToast(
                    images.length > 1
                        ? `已自动保存 ${images.length} 张图片`
                        : `图片已自动保存: ${savedFilenames[0]}`,
                    'success'
                );
                addLog('success', '自动保存成功', `已保存至: ${handle.name}/${savedFilenames.join(', ')}`, {
                    nodeId,
                    workflowName
                });
            } catch (error) {
                console.error('Runtime auto-save error:', error);
                showToast('自动保存出错: ' + error.message, 'error', 5000);
                addLog('error', '自动保存异常', error.message, {
                    nodeId,
                    workflowName,
                    error: error.stack || error
                });
            }
        };
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
            nodeConfigs,
            createNodeMarkup,
            nodesLayer: runtimeElements.nodesLayer,
            generateId,
            getImageAsset,
            getImageAssetList,
            saveImageAsset,
            saveImageAssetList,
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
        const data = cloneWorkflowData(workflowData);
        const runtimeExecutionCoreApi = createExecutionCoreApi({
            state: runtimeState,
            nodeConfigs,
            syncTextSplitNodeData: () => {},
            documentRef: runtimeDocument,
            windowRef,
            fetchRef,
            showToast,
            addLog,
            recordNodeRequest,
            getProxyHeaders: (url, method = 'POST', extraHeaders = {}) => createProxyHeadersGetter(() => runtimeState)(url, method, extraHeaders),
            classifyProviderError,
            logRequestToPanel,
            formatProxyErrorMessage,
            saveHistoryEntry,
            renderHistoryList,
            showResolutionBadge: async () => {},
            saveImageAsset,
            saveImageAssetList,
            deleteImageAsset,
            dataURLtoBlob,
            blobToDataUrl,
            resizeImageData,
            autoSaveToDir: runtimeAutoSaveToDir,
            restoreImageResizePreview: runtimeMediaApi.restoreImageResizePreview,
            refreshDependentImageResizePreviews: async () => syncRuntimeWorkflowSnapshot(context, { dirty: true }),
            syncImagePreviewNode: runtimeMediaApi.syncImagePreviewNode,
            syncImageSaveNode: runtimeMediaApi.syncImageSaveNode,
            syncImageCompareNode: runtimeMediaApi.syncImageCompareNode,
            syncCameraControlNode: (nodeId, imageValue) => runtimeCameraApi.syncCameraControlFromExecution(nodeId, imageValue),
            fitNodeToContent: () => {},
            scheduleSave: () => syncRuntimeWorkflowSnapshot(context),
            getAbortMessage,
            updateAllConnections: () => runtimeConnectionsApi.updateAllConnections(),
            getImageHistorySidebarActive: () => documentRef.getElementById('history-sidebar')?.classList.contains('active')
        });
        const context = {
            id: contextId,
            workflowName,
            state: runtimeState,
            elements: runtimeElements,
            baseNodeIds: new Set(data.nodes.map((node) => node?.id).filter(Boolean)),
            baseConnectionIds: new Set(data.connections.map((connection, index) => getWorkflowConnectionIdentity(connection, index))),
            activePlanNodeIds: new Set(),
            nodeRunStarted: false,
            runResult: '',
            abortReason: null,
            dispose() {
                runtimeState.nodes.forEach((node) => cleanupElementResources(node.el));
                runtimeElements.wrapper?.remove();
                workflowRunContexts.delete(contextId);
            },
            serialize() {
                return serializeRuntimeWorkflow(runtimeState, runtimeDocument, workflowData?.version || '1.3');
            },
            resolveExecutionPlan(runInput) {
                return runtimeExecutionCoreApi.resolveExecutionPlan(runInput);
            },
            waitForImageRestores() {
                return runtimeNodeLifecycleApi.waitForImageRestores?.() || Promise.resolve();
            }
        };
        runtimeRunnerApi = createWorkflowRunnerApi({
            state: runtimeState,
            nodeConfigs,
            documentRef: runtimeDocument,
            confirmRef,
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
            syncImagePreviewNode: runtimeMediaApi.syncImagePreviewNode,
            syncImageSaveNode: runtimeMediaApi.syncImageSaveNode,
            refreshDependentImageResizePreviews: async () => syncRuntimeWorkflowSnapshot(context, { dirty: true }),
            getAbortMessage,
            playNotificationSound: () => getSettingsControllerApi()?.playNotificationSound?.(),
            systemNotificationApi: getSystemNotificationApi(),
            onAutoSaveNodeInjected: () => {
                syncRuntimeWorkflowSnapshot(context, { dirty: true, applyToCanvas: true });
            },
            onNodeRunStateChange: (payload) => {
                recordRuntimeNodeRunState(context, payload);
                applyVisibleNodeRunState(workflowName, payload);
                if (payload?.status === 'completed' && payload.nodeId) {
                    syncRuntimeNodeSnapshot(context, payload.nodeId, {
                        dirty: true,
                        applyToCanvas: true
                    });
                }
            }
        });
        context.runner = runtimeRunnerApi;

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
        workflowRunContexts.set(contextId, context);
        return context;
    }

    async function runWorkflowInContext(workflowName, workflowData, runInput = null) {
        const context = createWorkflowRuntimeContext(workflowName, workflowData);
        const plan = context.resolveExecutionPlan(runInput);
        if (!plan) {
            context.dispose();
            syncGlobalRunToolbarState();
            return false;
        }
        const runnableNodeIds = (plan.executionOrder || plan.nodeIds || [])
            .filter((nodeId) => context.state.nodes.get(nodeId)?.enabled !== false);
        const overlappingNodeIds = getPlanOverlapNodeIds(workflowName, runnableNodeIds);
        if (overlappingNodeIds.length > 0) {
            context.dispose();
            showToast(`当前运行线路上有 ${overlappingNodeIds.length} 个节点仍在运行，请等待这些节点完成后再运行`, 'warning');
            syncGlobalRunToolbarState();
            return false;
        }

        context.activePlanNodeIds = new Set(runnableNodeIds);
        getWorkflowManagerApi()?.setWorkflowRunningState?.(workflowName, true);
        syncGlobalRunToolbarState();

        context.promise = (async () => {
            let runError = null;
            try {
                await context.waitForImageRestores();
                await context.runner.runWorkflow(runInput);
                syncRuntimeWorkflowSnapshot(context, { dirty: true, applyToCanvas: true, mergeRunResults: true });
            } catch (error) {
                runError = error;
                addLog('error', `工作流运行异常: ${workflowName}`, error?.message || String(error), {
                    workflowName,
                    error: error?.stack || error
                });
                syncRuntimeWorkflowSnapshot(context, { dirty: true, applyToCanvas: true, mergeRunResults: true });
            } finally {
                const runResult = deriveWorkflowRunResult(context, runError);
                context.activePlanNodeIds.clear();
                const stillRunning = getWorkflowRunContexts(workflowName).some((entry) => entry !== context);
                getWorkflowManagerApi()?.setWorkflowRunningState?.(workflowName, stillRunning);
                if (runResult && !stillRunning) {
                    getWorkflowManagerApi()?.setWorkflowRunResult?.(workflowName, runResult);
                }
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

    function getRunConflictInfo(workflowName, workflowData, runInput = null) {
        if (!workflowName || getWorkflowRunContexts(workflowName).length === 0) {
            return { blocked: false, count: 0, nodeIds: [] };
        }
        const context = createWorkflowRuntimeContext(workflowName, workflowData);
        workflowRunContexts.delete(context.id);
        try {
            const plan = context.resolveExecutionPlan(runInput);
            if (!plan) return { blocked: false, count: 0, nodeIds: [] };
            const runnableNodeIds = (plan.executionOrder || plan.nodeIds || [])
                .filter((nodeId) => context.state.nodes.get(nodeId)?.enabled !== false);
            const overlapNodeIds = getPlanOverlapNodeIds(workflowName, runnableNodeIds);
            return {
                blocked: overlapNodeIds.length > 0,
                count: overlapNodeIds.length,
                nodeIds: overlapNodeIds
            };
        } finally {
            context.dispose();
        }
    }

    function abortAllWorkflowRuns(reason = 'manual') {
        state.abortReason = reason;
        workflowRunContexts.forEach((context) => {
            context.runResult = 'error';
            context.abortReason = reason;
            context.state.abortReason = reason;
            if (context.state.runAbortControllers instanceof Set && context.state.runAbortControllers.size > 0) {
                context.state.runAbortControllers.forEach((controller) => controller.abort());
            } else {
                context.state.abortController?.abort();
            }
        });
    }

    function cancelRunningNode(nodeId) {
        const visibleHandler = state.runningNodeCancelHandlers?.get(nodeId);
        if (typeof visibleHandler === 'function') {
            visibleHandler();
            return true;
        }
        for (const context of workflowRunContexts.values()) {
            if (context.state.runningNodeIds?.has(nodeId)) {
                return context.runner.cancelRunningNode(nodeId);
            }
        }
        return false;
    }

    return {
        abortAllWorkflowRuns,
        applyVisibleNodeRunState,
        cancelRunningNode,
        getRunConflictInfo,
        refreshVisibleWorkflowRunState,
        runWorkflowInContext,
        syncGlobalRunToolbarState
    };
}
