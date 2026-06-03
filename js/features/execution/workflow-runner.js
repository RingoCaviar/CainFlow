import { getResolvedProviderForModel } from './provider-request-utils.js';
import { normalizeImageList, normalizeTextList } from './execution-data-utils.js';
import { removeConcurrentRequestStatusPanel } from './concurrent-request-status-ui.js';
import { escapeHtml } from '../../core/common-utils.js';

/**
 * 负责整条工作流的运行编排，包括前置校验、逐节点执行、重试与状态收尾。
 */
export function createWorkflowRunnerApi({
    state,
    nodeConfigs,
    documentRef = document,
    confirmRef = confirm,
    notificationRef = typeof Notification !== 'undefined' ? Notification : null,
    systemNotificationApi = null,
    audioFactory = () => new Audio(),
    resolveExecutionPlan,
    normalizeRunOptions,
    getCachedOutputValue,
    executeNode,
    resumeVideoGeneration = async () => {},
    resumeAsyncImageGeneration = async () => {},
    addNode,
    generateId,
    showToast,
    addLog,
    scheduleSave,
    updateAllConnections,
    updatePortStyles,
    getImageAsset = async () => null,
    getImageAssetList = async () => [],
    saveImageAsset = async () => false,
    deleteImageAsset = async () => false,
    saveImageAssetList = async () => false,
    syncImagePreviewNode = async () => {},
    syncImageSaveNode = async () => {},
    refreshDependentImageResizePreviews = () => {},
    getAbortMessage,
    playNotificationSound,
    onNodeRunStateChange = () => {},
    onAutoSaveNodeInjected = () => {}
}) {
    const view = documentRef.defaultView || window;
    let runningConnectionRefreshFrame = null;

    function scheduleRunningConnectionRefresh() {
        if (runningConnectionRefreshFrame !== null) return;
        const requestFrame = view.requestAnimationFrame || ((callback) => view.setTimeout(callback, 16));
        runningConnectionRefreshFrame = requestFrame(() => {
            runningConnectionRefreshFrame = null;
            updateAllConnections();
        });
    }

    function isAbortLikeError(err) {
        if (!err) return false;
        if (err.name === 'AbortError') return true;
        if (typeof err.message === 'string' && err.message.toLowerCase().includes('aborted')) return true;
        return false;
    }

    function clearAbortedNodeFeedback(nodeId) {
        const errorEl = documentRef.getElementById(`${nodeId}-error`);
        if (errorEl) {
            errorEl.innerHTML = '';
            errorEl.style.display = 'none';
        }

        const responseArea = documentRef.getElementById(`${nodeId}-response`);
        if (responseArea) {
            responseArea.innerHTML = '<div class="chat-response-placeholder">\u5DF2\u505C\u6B62\u751F\u6210</div>';
        }
    }

    function getRunningNodeIds() {
        if (!(state.runningNodeIds instanceof Set)) {
            state.runningNodeIds = new Set();
        }
        return state.runningNodeIds;
    }

    function getRunAbortControllers() {
        if (!(state.runAbortControllers instanceof Set)) {
            state.runAbortControllers = new Set();
        }
        return state.runAbortControllers;
    }

    function getRunningNodeCancelHandlers() {
        if (!(state.runningNodeCancelHandlers instanceof Map)) {
            state.runningNodeCancelHandlers = new Map();
        }
        return state.runningNodeCancelHandlers;
    }

    function getNodeDisplayTitle(node) {
        if (!node) return '节点';
        return node.customTitle || nodeConfigs[node.type]?.title || node.type;
    }

    function emitNodeRunState(payload) {
        try {
            onNodeRunStateChange(payload);
        } catch (err) {
            console.warn('Node run state callback failed:', err);
        }
    }

    function formatApproxBytes(bytes) {
        const value = Number(bytes || 0);
        if (!Number.isFinite(value) || value <= 0) return '未知大小';
        if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
        if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
        return `${Math.round(value)} B`;
    }

    function estimateDataUrlBytes(value = '') {
        const text = String(value || '');
        const commaIndex = text.indexOf(',');
        const payload = (commaIndex >= 0 ? text.slice(commaIndex + 1) : text).replace(/\s+/g, '');
        if (!payload) return 0;
        const padding = payload.endsWith('==') ? 2 : (payload.endsWith('=') ? 1 : 0);
        return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
    }

    function isDataUrl(value) {
        return typeof value === 'string' && /^data:/i.test(value);
    }

    function estimateImageValueBytes(value) {
        if (isDataUrl(value)) return estimateDataUrlBytes(value);
        return 0;
    }

    function summarizeMediaString(value) {
        if (typeof value !== 'string') return null;
        const dataUrlMatch = value.match(/^data:([^;,]+)?/i);
        if (dataUrlMatch) {
            const mimeType = dataUrlMatch[1] || 'application/octet-stream';
            const label = mimeType.toLowerCase().startsWith('video/') ? '视频' : '图片';
            return {
                kind: label,
                mimeType,
                approxBytes: estimateDataUrlBytes(value),
                summary: `${label}数据（${mimeType}, ${formatApproxBytes(estimateDataUrlBytes(value))}）`
            };
        }
        if (/^https?:\/\//i.test(value.trim())) {
            return {
                kind: '链接',
                url: value.trim()
            };
        }
        return null;
    }

    function summarizeMediaList(values) {
        const items = normalizeImageList(values);
        const totalApproxBytes = items.reduce((sum, item) => sum + estimateDataUrlBytes(item), 0);
        return {
            count: items.length,
            approxBytes: totalApproxBytes,
            approxSize: totalApproxBytes > 0 ? formatApproxBytes(totalApproxBytes) : '',
            items: items.slice(0, 6).map((item, index) => ({
                index: index + 1,
                ...summarizeMediaString(item)
            })),
            omittedItems: Math.max(0, items.length - 6)
        };
    }

    function summarizeValueForCompletionLog(value) {
        if (value === null || value === undefined) return value;
        if (typeof value === 'string') {
            const media = summarizeMediaString(value);
            if (media) return media;
            return value.length > 240 ? `${value.slice(0, 240)}... [文本过长已截断]` : value;
        }
        if (Array.isArray(value)) {
            const imageList = normalizeImageList(value);
            if (imageList.length > 0) return summarizeMediaList(imageList);
            return value.slice(0, 20).map((item) => summarizeValueForCompletionLog(item));
        }
        if (typeof Blob !== 'undefined' && value instanceof Blob) {
            return {
                kind: 'Blob',
                mimeType: value.type || 'application/octet-stream',
                size: formatApproxBytes(value.size || 0)
            };
        }
        if (typeof value === 'object') {
            const output = {};
            Object.entries(value).slice(0, 40).forEach(([key, item]) => {
                output[key] = summarizeValueForCompletionLog(item);
            });
            return output;
        }
        return value;
    }

    function createNodeCompletionLogDetails(node, inputs, extra = {}) {
        const data = node?.data && typeof node.data === 'object' ? node.data : {};
        const details = {
            nodeId: node?.id || '',
            inputs: summarizeValueForCompletionLog(inputs || {}),
            data: {}
        };

        const imageList = normalizeImageList(data.images || node?.imageDataList || node?.generatedImages || data.image || node?.imageData);
        if (imageList.length > 0) {
            details.data.images = summarizeMediaList(imageList);
            details.data.imageAssetKey = node?.id || '';
        }

        if (data.videoUrl || data.video?.url || Array.isArray(data.videos)) {
            details.data.videoId = data.videoId || data.video?.id || '';
            details.data.videoUrl = data.videoUrl || data.video?.url || '';
            details.data.videoStatus = data.videoStatus || data.video?.status || '';
            details.data.videoStatusText = data.videoStatusText || '';
            details.data.videos = Array.isArray(data.videos)
                ? data.videos.map((video) => ({
                    videoId: video?.videoId || video?.id || '',
                    videoUrl: video?.videoUrl || video?.url || '',
                    status: video?.status || '',
                    statusText: video?.statusText || ''
                }))
                : undefined;
        }

        const textValues = normalizeTextList(data.texts || data.text);
        if (textValues.length > 0) {
            details.data.textCount = textValues.length;
            details.data.textPreview = textValues.slice(0, 3).map((text) => summarizeValueForCompletionLog(text));
        }

        [
            'prompt',
            'imageTaskId',
            'imageTaskStatus',
            'imageTaskStatusText',
            'imageTaskUrl',
            'imageTaskCreateHttpStatus',
            'imageTaskCreateStatus',
            'imageTaskProgress',
            'videoCreateHttpStatus',
            'videoCreateStatus',
            'videoStatusUpdateTime',
            'videoEnhancedPrompt'
        ].forEach((key) => {
            if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
                details.data[key] = summarizeValueForCompletionLog(data[key]);
            }
        });

        Object.entries(extra || {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                details[key] = value;
            }
        });

        return details;
    }

    async function sendSystemNotification(title, options = {}) {
        if (!state.notificationsEnabled) return false;
        const notificationApi = systemNotificationApi || {
            isSupported: () => !!notificationRef,
            getPermission: () => notificationRef?.permission || 'unsupported',
            showNotification: async (notificationTitle, notificationOptions) => {
                new notificationRef(notificationTitle, notificationOptions);
                return true;
            }
        };
        if (!notificationApi.isSupported()) {
            addLog('warning', '系统通知不可用', '当前浏览器环境不支持系统通知，已改用页面内提示和声音提醒。');
            return false;
        }
        if (notificationApi.getPermission() !== 'granted') {
            addLog('warning', '系统通知未发送', '通知权限尚未授予，请重新开启运行通知或在浏览器设置中允许此网站发送通知。');
            return false;
        }

        try {
            const sent = await notificationApi.showNotification(title, {
                ...options,
                tag: options.tag || 'cainflow-workflow-run',
                requireInteraction: options.requireInteraction ?? false
            });
            if (!sent) {
                addLog('warning', '系统通知未发送', '浏览器未接受本次系统通知请求。');
            }
            return sent;
        } catch (err) {
            console.warn('System notification failed:', err);
            addLog('warning', '系统通知发送失败', err?.message || String(err));
            return false;
        }
    }

    function dispatchWorkflowCompletionNotice({ toastMessage, toastType, notificationTitle, notificationBody, playSound = false }) {
        showToast(toastMessage, toastType, 6000);

        if (!state.notificationsEnabled) return;

        void sendSystemNotification(notificationTitle, {
            body: notificationBody
        });

        if (playSound && typeof playNotificationSound === 'function') {
            try {
                playNotificationSound();
            } catch (err) {
                console.warn('Notification sound failed:', err);
                addLog('warning', '通知音效播放失败', err?.message || String(err));
            }
        }
    }

    function syncRunToolbarState() {
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

    function setControlRunningLock(control, locked) {
        if (!control) return;
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
    }

    function setNodeRunningLock(node, locked) {
        if (!node?.el) return;
        node.el.classList.toggle('running-locked', locked);
        node.el.querySelectorAll('input, select, textarea, button:not(.node-run-cancel-btn)').forEach((control) => {
            setControlRunningLock(control, locked);
        });
    }

    function markNodeRunning(nodeId, node) {
        const startedAt = node?.runStartedAt || Date.now();
        if (node && !node.runStartedAt) node.runStartedAt = startedAt;
        getRunningNodeIds().add(nodeId);
        if (node?.el) {
            node.el.classList.add('running');
            node.el.classList.remove('completed', 'error');
        }
        setNodeRunningLock(node, true);
        emitNodeRunState({ nodeId, status: 'running', running: true, startedAt });
        scheduleRunningConnectionRefresh();
    }

    function clearNodeRunning(nodeId, node, result = {}) {
        const wasRunning = getRunningNodeIds().delete(nodeId);
        if (node?.el) {
            node.el.classList.remove('running', 'running-locked');
            node.el.querySelector('.node-run-cancel-btn')?.classList.remove('is-holding', 'is-canceling');
        }
        setNodeRunningLock(node, false);
        if (wasRunning || result.status) {
            emitNodeRunState({
                nodeId,
                status: result.status || 'idle',
                running: false,
                durationSec: result.durationSec || node?.lastDuration || null
            });
        }
        scheduleRunningConnectionRefresh();
    }

    function hasRunningNodeInPlan(plan) {
        const runningNodeIds = getRunningNodeIds();
        return (plan.executionOrder || plan.nodeIds || []).filter((nodeId) => runningNodeIds.has(nodeId));
    }

    function shouldResetNodeData(plan, nodeId) {
        if (plan.mode === 'all') return true;
        return plan.scopeNodeSet.has(nodeId);
    }

    function getPreservedNodeDataForReset(node) {
        if (node?.type === 'ImageImport') {
            const data = node.data && typeof node.data === 'object' ? node.data : {};
            const preserved = {};
            if (data.image || node.imageData) preserved.image = data.image || node.imageData;
            if (data.imageImportAssetKey || node.imageImportAssetKey) {
                preserved.imageImportAssetKey = data.imageImportAssetKey || node.imageImportAssetKey;
            }
            return preserved;
        }

        if (!node?.data || typeof node.data !== 'object') return {};

        if (node.type === 'CameraControl') {
            return {
                pitch: node.data.pitch,
                yaw: node.data.yaw,
                distance: node.data.distance,
                fov: node.data.fov,
                roll: node.data.roll,
                text: node.data.text,
                cameraPrompt: node.data.cameraPrompt,
                cameraViewMode: node.data.cameraViewMode,
                cameraPreviewImage: node.data.cameraPreviewImage
            };
        }

        if (node.type === 'ImageGenerate') {
            return {
                referenceImageCount: node.data.referenceImageCount,
                generationCount: node.data.generationCount
            };
        }

        return {};
    }

    function resetNodesForPlan(plan, { preserveFixedCache = true, forceResetNodeIds = null } = {}) {
        const runningNodeIds = getRunningNodeIds();
        for (const [nid, node] of state.nodes) {
            if (!shouldResetNodeData(plan, nid)) continue;
            if (runningNodeIds.has(nid)) continue;

            const fixedToggle = documentRef.getElementById(`${nid}-fixed`);
            const isFixed = fixedToggle ? fixedToggle.checked : false;
            const forceReset = forceResetNodeIds?.has(nid) === true;

            if (!forceReset && preserveFixedCache && isFixed && node.isSucceeded && node.data && Object.keys(node.data).length > 0) {
                node.isFailed = false;
                node.el.classList.add('completed');
                node.el.classList.remove('error', 'running');
                continue;
            }

            node.el.classList.remove('completed', 'error', 'running');
            removeConcurrentRequestStatusPanel(node);
            node.data = getPreservedNodeDataForReset(node);
            node.isSucceeded = false;
            node.isFailed = false;
            if (node.type === 'ImageGenerate') {
                node.imageData = null;
                node.imageDataList = [];
                node.generationCompletedCount = 0;
                node.generatedImages = [];
            }
            if (node.type === 'VideoGenerate') {
                delete node.data.video;
                delete node.data.videoUrl;
                delete node.data.videoStatus;
                delete node.data.videoStatusText;
                delete node.data.videos;
            }
            if (node.type === 'ImageGenerate' || node.type === 'VideoGenerate' || node.type === 'TextChat') {
                delete node.apiGenerationProgress;
            }
        }
    }

    function isPromptProducedDuringPlan(plan, nodeId, connection) {
        const fromNode = state.nodes.get(connection.from.nodeId);
        if (!fromNode || fromNode.enabled === false) return false;
        if (!plan.scopeNodeSet.has(connection.from.nodeId)) return false;

        const order = plan.executionOrder || [];
        const fromIndex = order.indexOf(connection.from.nodeId);
        const toIndex = order.indexOf(nodeId);
        if (fromIndex === -1 || toIndex === -1 || fromIndex >= toIndex) return false;

        if (fromNode.el?.querySelector(`.node-port[data-direction="output"][data-port="${connection.from.port}"][data-type="text"]`)) {
            return true;
        }
        const outputs = nodeConfigs[fromNode.type]?.outputs || [];
        return outputs.some((output) => output.name === connection.from.port && output.type === 'text');
    }

    function getFirstNonEmptyImageList(...values) {
        for (const value of values) {
            const images = normalizeImageList(value);
            if (images.length > 0) return images;
        }
        return [];
    }

    function isDisplayImageNode(node) {
        return node?.type === 'ImagePreview' || node?.type === 'ImageSave';
    }

    function getDisplayNodeImageCount(node) {
        const explicitCount = Math.max(0, parseInt(node?.data?.imageCount || '0', 10) || 0);
        const inMemoryCount = Math.max(
            normalizeImageList(node?.data?.images).length,
            normalizeImageList(node?.imageDataList).length
        );
        const currentCount = normalizeImageList(node?.data?.image || node?.imageData).length;
        return Math.max(explicitCount, inMemoryCount, currentCount);
    }

    function getNodeImageOutputList(node) {
        const images = getFirstNonEmptyImageList(
            node?.data?.images,
            node?.imageDataList,
            node?.generatedImages,
            node?.data?.image,
            node?.imageData,
            node?.resizePreviewData
        );
        return images.length > 0 ? images : null;
    }

    async function restoreDisplayNodeImageOutput(node) {
        if (!isDisplayImageNode(node)) return null;
        const assetKey = typeof node?.data?.imageAssetKey === 'string' && node.data.imageAssetKey
            ? node.data.imageAssetKey
            : '';
        if (!assetKey) return null;

        let restoredImages = [];
        try {
            if (typeof getImageAssetList === 'function') {
                restoredImages = await getImageAssetList(assetKey);
            }
            if (restoredImages.length === 0 && typeof getImageAsset === 'function') {
                const image = await getImageAsset(assetKey);
                if (image) restoredImages = [image];
            }
        } catch (error) {
            addLog('warning', '显示节点图片恢复失败', `节点「${getNodeDisplayTitle(node)}」尝试恢复图片批次失败。`, {
                nodeId: node.id,
                error: error?.message || String(error)
            });
        }

        return restoredImages.length > 0 ? restoredImages : null;
    }

    function isNodeResultFixed(nodeId) {
        const fixedToggle = documentRef.getElementById(`${nodeId}-fixed`);
        return fixedToggle?.checked === true;
    }

    function hasImageOutputPort(node) {
        if (!node) return false;
        return (nodeConfigs[node.type]?.outputs || []).some((output) => output?.type === 'image');
    }

    function hasImageResultInMemory(node) {
        if (!node) return false;
        return normalizeImageList(node?.data?.images || node?.imageDataList || node?.generatedImages || node?.data?.image || node?.imageData || node?.resizePreviewData).length > 0;
    }

    function estimateNodeImageMemoryBytes(node) {
        if (!node) return 0;
        const fields = [
            node.data?.images,
            node.data?.image,
            node.imageDataList,
            node.imageData,
            node.generatedImages,
            node.resizePreviewData,
            node.compareImageA,
            node.compareImageB
        ];
        const seen = new Set();
        let total = 0;
        fields.forEach((field) => {
            normalizeImageList(field).forEach((image) => {
                if (!image || seen.has(image)) return;
                seen.add(image);
                total += estimateImageValueBytes(image);
            });
        });
        return total;
    }

    function getProtectedImageNodeIds(plan, completedNodes = new Set()) {
        const protectedIds = new Set();
        const completed = completedNodes instanceof Set ? completedNodes : new Set(completedNodes || []);

        for (const nodeId of plan.executionOrder || plan.nodeIds || []) {
            const node = state.nodes.get(nodeId);
            if (!node || node.enabled === false) continue;
            if (!completed.has(nodeId) && plan.scopeNodeSet?.has(nodeId)) continue;

            if (node.type === 'ImagePreview' || node.type === 'ImageSave' || node.type === 'ImageCompare') {
                protectedIds.add(nodeId);
            } else if (isNodeResultFixed(nodeId) && hasImageResultInMemory(node)) {
                protectedIds.add(nodeId);
            }
        }

        return protectedIds;
    }

    function clearIntermediateImageResult(node) {
        if (!node) return 0;
        const estimatedBytes = estimateNodeImageMemoryBytes(node);
        if (estimatedBytes <= 0) return 0;

        node.el?.querySelectorAll?.('img[data-original-src]').forEach((img) => {
            if (isDataUrl(img.dataset.originalSrc)) {
                delete img.dataset.originalSrc;
            }
        });
        if (node.data && typeof node.data === 'object') {
            delete node.data.images;
            delete node.data.image;
            delete node.data.imagePromptList;
            delete node.data.compareImageA;
            delete node.data.compareImageB;
        }
        node.imageData = null;
        node.imageDataList = [];
        node.generatedImages = [];
        node.imagePromptList = [];
        node.resizePreviewData = null;
        node.resizePreviewMeta = null;
        node.compareImageA = null;
        node.compareImageB = null;
        return estimatedBytes;
    }

    async function releaseWorkflowIntermediateImageResults(plan, completedNodes = new Set(), options = {}) {
        if (!plan?.executionOrder?.length) return { releasedNodes: 0, releasedBytes: 0 };
        const protectedIds = getProtectedImageNodeIds(plan, completedNodes);
        const released = [];
        let releasedBytes = 0;

        for (const nodeId of plan.executionOrder) {
            if (protectedIds.has(nodeId)) continue;
            if (!completedNodes.has(nodeId)) continue;
            const node = state.nodes.get(nodeId);
            if (!node || node.enabled === false || !hasImageOutputPort(node)) continue;
            if (node.type === 'ImageImport' || node.type === 'ImagePreview' || node.type === 'ImageSave') continue;
            if (isNodeResultFixed(nodeId)) continue;

            const bytes = clearIntermediateImageResult(node);
            if (bytes <= 0) continue;
            node.data = node.data || {};
            node.data.imageAssetKey = nodeId;
            node.data.imageMemoryReleased = true;
            released.push({
                nodeId,
                title: getNodeDisplayTitle(node),
                approxBytes: bytes
            });
            releasedBytes += bytes;
        }

        if (released.length === 0) return { releasedNodes: 0, releasedBytes: 0 };

        if (options.log !== false) {
            addLog('info', '已释放中间图片结果', `清理 ${released.length} 个中间节点，估算释放 ${formatApproxBytes(releasedBytes)}。保存/预览/固定与历史结果已保留。`, {
                releasedNodes: released.map((item) => ({
                    nodeId: item.nodeId,
                    title: item.title,
                    approxSize: formatApproxBytes(item.approxBytes)
                })),
                protectedNodeIds: Array.from(protectedIds)
            });
        }
        scheduleSave();
        return {
            releasedNodes: released.length,
            releasedBytes
        };
    }

    async function restoreReleasedImageOutput(node) {
        if (!node?.data?.imageMemoryReleased || !node.data.imageAssetKey) {
            return null;
        }
        const assetKey = node.data.imageAssetKey;
        let restoredImages = [];
        try {
            if (typeof getImageAssetList === 'function') {
                restoredImages = await getImageAssetList(assetKey);
            }
            if (restoredImages.length === 0 && typeof getImageAsset === 'function') {
                const image = await getImageAsset(assetKey);
                if (image) restoredImages = [image];
            }
        } catch (error) {
            addLog('warning', '中间图片恢复失败', `节点「${getNodeDisplayTitle(node)}」的中间图片已释放，尝试从缓存恢复时失败。`, {
                nodeId: node.id,
                error: error?.message || String(error)
            });
        }

        if (restoredImages.length === 0) return null;

        node.data.images = restoredImages.slice();
        node.data.image = restoredImages[restoredImages.length - 1];
        node.imageDataList = restoredImages.slice();
        node.imageData = node.data.image;
        if (node.type === 'ImageGenerate') {
            node.generatedImages = restoredImages.slice();
            node.generationCompletedCount = restoredImages.length;
        }
        delete node.data.imageMemoryReleased;
        return restoredImages;
    }

    async function restoreImageImportOutput(node) {
        if (!node || node.type !== 'ImageImport') return undefined;

        const cachedValue = getCachedOutputValue(node, 'image');
        if (cachedValue) return cachedValue;
        if (node.importMode === 'url') return undefined;

        const candidateKeys = [
            node.imageImportAssetKey,
            node.data?.imageImportAssetKey,
            node.id ? `image-import:${node.id}` : ''
        ].filter((key, index, arr) => typeof key === 'string' && key && arr.indexOf(key) === index);

        for (const key of candidateKeys) {
            const image = await getImageAsset(key);
            if (!image) continue;

            node.data = node.data || {};
            node.imageData = image;
            node.imageDataList = [image];
            node.data.image = image;
            delete node.data.images;
            node.imageImportAssetKey = key;
            node.data.imageImportAssetKey = key;
            return image;
        }

        return undefined;
    }

    async function getEnabledNodeOutputValue(fromNode, toNode, portName) {
        if (!fromNode || fromNode.enabled === false) return undefined;
        if (portName === 'image') {
            if (fromNode.type === 'ImageImport') {
                const importedImage = await restoreImageImportOutput(fromNode);
                if (importedImage) return importedImage;
            }
            const images = getNodeImageOutputList(fromNode);
            const shouldRestoreDisplayBatch = isDisplayImageNode(fromNode) && getDisplayNodeImageCount(fromNode) > 1;
            if (!shouldRestoreDisplayBatch) {
                if (images?.length > 1) return images;
                if (images?.length === 1) return images[0];
            }
            const restoredDisplayImages = await restoreDisplayNodeImageOutput(fromNode);
            if (restoredDisplayImages?.length > 1) return restoredDisplayImages;
            if (restoredDisplayImages?.length === 1) return restoredDisplayImages[0];
            if (images?.length > 1) return images;
            if (images?.length === 1) return images[0];
            const restoredImages = await restoreReleasedImageOutput(fromNode);
            if (restoredImages?.length > 1) return restoredImages;
            if (restoredImages?.length === 1) return restoredImages[0];
        }
        return getCachedOutputValue(fromNode, portName);
    }

    function isReferenceImageInputPort(node, portName) {
        const normalizedPort = String(portName || '');
        if (node?.type === 'ImageGenerate' || node?.type === 'TextChat') {
            return normalizedPort === 'image' || /^image_\d+$/.test(normalizedPort);
        }
        if (node?.type === 'VideoGenerate') {
            return /^image_\d+$/.test(normalizedPort);
        }
        return false;
    }

    function describeMissingReferenceImageInput(connection) {
        const fromNode = state.nodes.get(connection.from.nodeId);
        return {
            fromNodeId: connection.from.nodeId,
            fromNodeType: fromNode?.type || '',
            fromPort: connection.from.port,
            fromEnabled: fromNode?.enabled !== false,
            toPort: connection.to.port,
            importMode: fromNode?.type === 'ImageImport' ? (fromNode.importMode || 'upload') : undefined,
            hasImageImportAssetKey: fromNode?.type === 'ImageImport'
                ? !!(fromNode.imageImportAssetKey || fromNode.data?.imageImportAssetKey)
                : undefined,
            hasInlineImageInMemory: normalizeImageList(
                fromNode?.data?.image ||
                fromNode?.imageData ||
                fromNode?.data?.images ||
                fromNode?.imageDataList
            ).length > 0
        };
    }

    function assertConnectedReferenceImagesLoaded(plan, node, inputs = {}) {
        if (!node || (node.type !== 'ImageGenerate' && node.type !== 'VideoGenerate' && node.type !== 'TextChat')) return;

        const missingConnections = (plan.inputConnectionsByNode[node.id] || [])
            .filter((connection) => isReferenceImageInputPort(node, connection.to.port))
            .filter((connection) => normalizeImageList(inputs[connection.to.port]).length === 0);

        if (missingConnections.length === 0) return;

        const err = new Error(`已连接 ${missingConnections.length} 个参考图输入，但未读取到图片数据。请确认图片导入节点已加载完成且未被禁用，或重新拖入图片后等待预览出现再运行。`);
        err.serverResponse = {
            nodeId: node.id,
            nodeType: node.type,
            missingReferenceImageInputs: missingConnections.map(describeMissingReferenceImageInput)
        };
        throw err;
    }

    function cloneInputValue(value) {
        if (Array.isArray(value)) {
            return value.slice();
        }
        return value;
    }

    async function captureSelectedOnlyExternalInputs(plan) {
        if (plan?.mode !== 'selected-only') return Object.create(null);

        const externalInputsByNode = Object.create(null);

        for (const nodeId of plan.nodeIds || []) {
            for (const connection of plan.inputConnectionsByNode[nodeId] || []) {
                if (plan.scopeNodeSet.has(connection.from.nodeId)) continue;

                const fromNode = state.nodes.get(connection.from.nodeId);
                const toNode = state.nodes.get(nodeId);
                const outputValue = await getEnabledNodeOutputValue(fromNode, toNode, connection.from.port);
                if (outputValue === undefined) continue;

                if (!externalInputsByNode[nodeId]) {
                    externalInputsByNode[nodeId] = Object.create(null);
                }
                externalInputsByNode[nodeId][connection.to.port] = cloneInputValue(outputValue);
            }
        }

        return externalInputsByNode;
    }

    async function getInputValueForConnection(plan, nodeId, connection) {
        const isSelectedOnlyExternalInput = plan?.mode === 'selected-only' &&
            !plan.scopeNodeSet.has(connection.from.nodeId);
        if (isSelectedOnlyExternalInput) {
            const capturedValue = plan.externalInputsByNode?.[nodeId]?.[connection.to.port];
            if (capturedValue !== undefined) {
                return cloneInputValue(capturedValue);
            }
        }

        const fromNode = state.nodes.get(connection.from.nodeId);
        const toNode = state.nodes.get(nodeId);
        return await getEnabledNodeOutputValue(fromNode, toNode, connection.from.port);
    }

    function hasPromptInputValue(plan, nodeId) {
        for (const connection of plan.inputConnectionsByNode[nodeId] || []) {
            if (connection.to.port !== 'prompt') continue;
            const fromNode = state.nodes.get(connection.from.nodeId);
            const promptValue = getCachedOutputValue(fromNode, connection.from.port);
            if (typeof promptValue === 'string' && promptValue.trim()) return true;
            if (promptValue !== undefined && promptValue !== null && promptValue !== '') return true;
            if (isPromptProducedDuringPlan(plan, nodeId, connection)) return true;
        }
        return false;
    }

    async function collectInputsForNode(plan, nodeId) {
        const inputs = {};

        for (const connection of plan.inputConnectionsByNode[nodeId] || []) {
            const outputValue = await getInputValueForConnection(plan, nodeId, connection);
            if (outputValue !== undefined) {
                inputs[connection.to.port] = outputValue;
            }
        }

        assertConnectedReferenceImagesLoaded(plan, state.nodes.get(nodeId), inputs);
        return inputs;
    }

    function isBatchInputValue(value) {
        return Array.isArray(value) && value.length > 0;
    }

    function isFixedTextChatWithCachedResult(node) {
        if (node?.type !== 'TextChat') return false;
        const fixedToggle = documentRef.getElementById(`${node.id}-fixed`);
        const isFixed = fixedToggle ? fixedToggle.checked : false;
        return isFixed && node.isSucceeded === true && typeof node.data?.text === 'string' && node.data.text.length > 0;
    }

    function shouldRunNodeForEachInput(node, inputs) {
        if (!node) return false;
        if (isFixedTextChatWithCachedResult(node)) return false;
        if (node.type === 'ImageMerge' || node.type === 'TextMerge' || node.type === 'ImagePreview' || node.type === 'ImageSave' || node.type === 'Text') return false;
        return Object.values(inputs || {}).some(isBatchInputValue);
    }

    function buildInputBatches(inputs) {
        const entries = Object.entries(inputs || {});
        if (entries.length === 0) return [{}];

        return entries.reduce((batches, [key, value]) => {
            const values = isBatchInputValue(value) ? value : [value];
            const nextBatches = [];
            batches.forEach((batch) => {
                values.forEach((item) => {
                    nextBatches.push({ ...batch, [key]: item });
                });
            });
            return nextBatches;
        }, [{}]);
    }

    function isConcurrentRequestModeEnabled() {
        return state.concurrentRequestMode === true;
    }

    async function propagateImagesToDownstreamPreview(sourceNodeId, images = []) {
        const imageList = normalizeImageList(images);
        if (!sourceNodeId || imageList.length === 0) return;
        const targetNodeIds = (state.connections || [])
            .filter((conn) => conn.from?.nodeId === sourceNodeId && conn.from?.port === 'image')
            .map((conn) => conn.to?.nodeId)
            .filter((nodeId, index, list) => nodeId && list.indexOf(nodeId) === index);
        for (const targetNodeId of targetNodeIds) {
            const targetNode = state.nodes.get(targetNodeId);
            if (!targetNode) continue;
            if (targetNode.type === 'ImagePreview') {
                await syncImagePreviewNode(targetNodeId, imageList);
            } else if (targetNode.type === 'ImageSave') {
                await syncImageSaveNode(targetNodeId, imageList);
            }
        }
    }

    async function commitConcurrentBatchResults(node, results = []) {
        if (!node) return;
        if (node.type === 'ImageGenerate') {
            const images = results.flatMap((result) => normalizeImageList(result?.images || result?.image));
            node.data = node.data || {};
            if (images.length > 0) {
                node.data.images = images.slice();
                node.data.image = images[images.length - 1];
            } else {
                delete node.data.images;
                delete node.data.image;
            }
            node.imageDataList = images.slice();
            node.imageData = images[images.length - 1] || null;
            node.generatedImages = images.slice();
            node.generationCompletedCount = images.length;
            node.isSucceeded = true;
            if (images.length > 1) await saveImageAssetList(node.id, images);
            else if (images.length === 1) await saveImageAsset(node.id, images[0]);
            else await deleteImageAsset(node.id);
            await propagateImagesToDownstreamPreview(node.id, images);
            await refreshDependentImageResizePreviews(node.id);
            updateAllConnections();
            return;
        }

        if (node.type === 'TextChat') {
            const texts = results
                .map((result) => result?.text)
                .filter((value) => typeof value === 'string');
            node.data = node.data || {};
            if (texts.length > 0) {
                node.data.texts = texts.slice();
                node.data.text = texts[texts.length - 1];
            } else {
                delete node.data.texts;
                delete node.data.text;
            }
            node.lastResponse = results
                .map((result, index) => {
                    const text = result?.lastResponse
                        ? result.lastResponse
                        : (typeof result?.text === 'string' ? escapeHtml(result.text).replace(/\n/g, '<br>') : '');
                    return text ? `<div><strong>第 ${index + 1} 次</strong></div><div>${text}</div>` : '';
                })
                .filter(Boolean)
                .join('<hr />');
            const responseArea = documentRef.getElementById(`${node.id}-response`);
            if (responseArea) responseArea.innerHTML = node.lastResponse;
            node.isSucceeded = true;
            updateAllConnections();
        }
    }

    function getConcurrentRequestRetryLimit() {
        if (state.autoRetry !== true) return 0;
        const retries = parseInt(state.maxRetries, 10);
        return Number.isFinite(retries) && retries > 0 ? retries : 0;
    }

    async function executeConcurrentBatchRequest(node, batch, index, batchCount, signal, requestStatusTracker = null) {
        const requestsPerBatch = node?.type === 'ImageGenerate'
            ? getConfiguredImageGenerationCount(node)
            : 1;
        const requestOffset = index * requestsPerBatch;
        const markRequestRange = (status, options = {}) => {
            requestStatusTracker?.markRange(requestOffset, requestsPerBatch, status, options);
        };
        const executionContext = {
            concurrentExecution: true,
            batchIndex: index,
            batchCount,
            concurrentRequestStatus: createConcurrentRequestStatusContext(
                requestStatusTracker,
                requestOffset,
                requestsPerBatch
            )
        };
        if (node?.type !== 'TextChat') {
            try {
                const result = await executeNode(node, batch, signal, executionContext);
                markRequestRange('success', { onlyRunning: true });
                return result;
            } catch (error) {
                markRequestRange('failed', { onlyRunning: true });
                throw error;
            }
        }

        const maxRetries = getConcurrentRequestRetryLimit();
        let attempt = 0;
        while (true) {
            try {
                const result = await executeNode(node, batch, signal, executionContext);
                markRequestRange('success', { onlyRunning: true });
                return result;
            } catch (error) {
                if (isAbortLikeError(error)) {
                    markRequestRange('failed', { onlyRunning: true, error });
                    throw error;
                }
                const isRetryableRequestError = !!error?.serverResponse ||
                    error?.name === 'TypeError' ||
                    /failed to fetch|networkerror/i.test(String(error?.message || ''));
                if (!isRetryableRequestError) {
                    markRequestRange('failed', { onlyRunning: true, error });
                    throw error;
                }
                if (attempt >= maxRetries) {
                    markRequestRange('failed', { onlyRunning: true, error });
                    throw error;
                }
                attempt += 1;
                addLog('warning', `并发请求重试: ${getNodeDisplayTitle(node)}`, `正在第 ${attempt} 次重试第 ${index + 1}/${batchCount} 个请求。`, {
                    nodeId: node.id,
                    batchIndex: index,
                    attempt,
                    error: error?.message || String(error)
                });
            }
        }
    }

    function getConfiguredImageGenerationCount(node) {
        const input = documentRef.getElementById(`${node.id}-generation-count`);
        return Math.max(1, parseInt(input?.value || node?.generationCount || node?.data?.generationCount || '1', 10) || 1);
    }

    function getApiNodeRunCount(node, batchCount) {
        if (!node) return 0;
        const safeBatchCount = Math.max(1, parseInt(batchCount, 10) || 1);
        if (node.type === 'ImageGenerate' || node.type === 'VideoGenerate') return safeBatchCount * getConfiguredImageGenerationCount(node);
        if (node.type === 'TextChat') return safeBatchCount;
        return 0;
    }

    function emitConcurrentRequestStatus(node, dots = []) {
        if (!node?.id) return;
        const concurrentRequestStatus = {
            total: dots.length,
            requests: dots.map((dot, index) => ({
                index,
                status: dot?.dataset?.status || 'running',
                error: dot?.dataset?.error || ''
            }))
        };
        node.data = node.data || {};
        node.data.concurrentRequestStatus = concurrentRequestStatus;
        emitNodeRunState({
            nodeId: node.id,
            status: 'concurrent-request-status',
            running: getRunningNodeIds().has(node.id),
            concurrentRequestStatus
        });
    }

    function createConcurrentRequestStatusTracker(node, total) {
        const safeTotal = Math.max(1, parseInt(total, 10) || 1);
        removeConcurrentRequestStatusPanel(node);

        if (!node?.el) {
            return {
                total: safeTotal,
                mark: () => {},
                markRange: () => {}
            };
        }

        const panel = documentRef.createElement('div');
        panel.className = 'node-concurrent-status-panel';
        panel.dataset.total = String(safeTotal);
        panel.setAttribute('aria-label', 'Concurrent request status');

        const grid = documentRef.createElement('div');
        grid.className = 'node-concurrent-status-grid';
        panel.appendChild(grid);

        const dots = Array.from({ length: safeTotal }, (_, index) => {
            const dot = documentRef.createElement('span');
            dot.className = 'node-concurrent-status-dot';
            dot.dataset.status = 'running';
            dot.title = `Request ${index + 1}: running`;
            grid.appendChild(dot);
            return dot;
        });

        node.el.appendChild(panel);
        node.el.classList.add('has-concurrent-status');

        const errorPopover = documentRef.createElement('div');
        errorPopover.className = 'node-concurrent-status-error-popover hidden';
        panel.appendChild(errorPopover);

        const formatErrorMessage = (error) => {
            if (!error) return '请求失败，但没有返回具体错误信息。';
            if (typeof error === 'string') return error;
            if (error?.serverResponse?.body) return String(error.serverResponse.body);
            if (error?.message) return String(error.message);
            return String(error);
        };

        const hideErrorPopover = () => {
            errorPopover.classList.add('hidden');
            errorPopover.textContent = '';
        };

        const setDotStatus = (index, status, error = null) => {
            const dot = dots[index];
            if (!dot) return;
            const normalizedStatus = status === 'success' || status === 'failed' ? status : 'running';
            dot.dataset.status = normalizedStatus;
            if (normalizedStatus === 'failed') {
                const errorMessage = formatErrorMessage(error);
                dot.dataset.error = errorMessage;
                dot.title = `Request ${index + 1}: failed\n${errorMessage}`;
                dot.setAttribute('role', 'button');
                dot.tabIndex = 0;
            } else {
                delete dot.dataset.error;
                dot.title = `Request ${index + 1}: ${normalizedStatus}`;
                dot.removeAttribute('role');
                dot.removeAttribute('tabindex');
            }
            emitConcurrentRequestStatus(node, dots);
        };

        grid.addEventListener('click', (event) => {
            const dot = event.target.closest('.node-concurrent-status-dot[data-status="failed"]');
            if (!dot || !grid.contains(dot)) return;
            event.stopPropagation();
            const message = dot.dataset.error || '请求失败，但没有返回具体错误信息。';
            errorPopover.textContent = message;
            errorPopover.classList.remove('hidden');
        });

        grid.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const dot = event.target.closest('.node-concurrent-status-dot[data-status="failed"]');
            if (!dot) return;
            event.preventDefault();
            dot.click();
        });

        panel.addEventListener('mouseleave', hideErrorPopover);
        emitConcurrentRequestStatus(node, dots);

        return {
            total: safeTotal,
            mark(index, status, error = null) {
                setDotStatus(index, status, error);
            },
            markRange(start, count, status, { onlyRunning = false, error = null } = {}) {
                const safeStart = Math.max(0, parseInt(start, 10) || 0);
                const safeCount = Math.max(0, parseInt(count, 10) || 0);
                for (let offset = 0; offset < safeCount; offset += 1) {
                    const index = safeStart + offset;
                    if (onlyRunning && dots[index]?.dataset.status !== 'running') continue;
                    setDotStatus(index, status, error);
                }
            }
        };
    }

    function createConcurrentRequestStatusContext(requestStatusTracker, requestOffset = 0, requestsPerBatch = 1) {
        return {
            requestOffset,
            requestsPerBatch,
            markRequestStatus(relativeIndex, status, error = null) {
                const safeIndex = Math.max(0, parseInt(relativeIndex, 10) || 0);
                requestStatusTracker?.mark(requestOffset + safeIndex, status, error);
            }
        };
    }

    async function executeImageGenerateWithRequestStatus(node, inputs, signal, requestStatusTracker, batchIndex = 0) {
        const requestsPerBatch = getConfiguredImageGenerationCount(node);
        const requestOffset = batchIndex * requestsPerBatch;
        try {
            const result = await executeNode(node, inputs, signal, {
                concurrentRequestStatus: createConcurrentRequestStatusContext(
                    requestStatusTracker,
                    requestOffset,
                    requestsPerBatch
                )
            });
            requestStatusTracker?.markRange(requestOffset, requestsPerBatch, 'success', { onlyRunning: true });
            return result;
        } catch (error) {
            requestStatusTracker?.markRange(requestOffset, requestsPerBatch, 'failed', { onlyRunning: true, error });
            throw error;
        }
    }

    async function executeStandaloneConcurrentImageRequests(node, inputs, signal) {
        const requestCount = getConfiguredImageGenerationCount(node);
        const requestStatusTracker = createConcurrentRequestStatusTracker(node, requestCount);
        return executeImageGenerateWithRequestStatus(node, inputs, signal, requestStatusTracker, 0);
    }

    function shouldTrackStandaloneConcurrentImageRequests(node) {
        return node?.type === 'ImageGenerate' &&
            getConfiguredImageGenerationCount(node) > 1;
    }

    function renderApiNodeGenerationProgress(node, current, total) {
        if (!node?.id) return;
        const progressEl = documentRef.getElementById(`${node.id}-generation-progress`);
        if (!progressEl) return;
        const safeTotal = Math.max(1, parseInt(total, 10) || 1);
        const safeCurrent = Math.max(0, Math.min(safeTotal, parseInt(current, 10) || 0));
        progressEl.textContent = `${safeCurrent}/${safeTotal}`;
        progressEl.dataset.total = String(safeTotal);
        progressEl.classList.remove('hidden');
    }

    function prepareApiNodeGenerationProgress(node, batchCount) {
        const total = getApiNodeRunCount(node, batchCount);
        if (total <= 0) return;
        const existingProgress = node.apiGenerationProgress;
        const shouldPreserveCompleted = existingProgress &&
            Math.max(1, parseInt(existingProgress.total, 10) || 1) === total &&
            node.isSucceeded !== true;
        const completed = shouldPreserveCompleted
            ? Math.max(0, Math.min(total, parseInt(existingProgress.completed, 10) || 0))
            : 0;
        node.apiGenerationProgress = { total, completed };
        renderApiNodeGenerationProgress(node, completed, total);
    }

    function getNodeOutputPortNames(node, dataType) {
        const names = new Set();
        node?.el?.querySelectorAll(`.node-port[data-direction="output"][data-type="${dataType}"]`).forEach((portEl) => {
            if (portEl.dataset.port) names.add(portEl.dataset.port);
        });
        (nodeConfigs[node?.type]?.outputs || []).forEach((output) => {
            if (output.type === dataType && output.name) names.add(output.name);
        });
        return Array.from(names);
    }

    function resetNodeImageOutputsForBatch(node) {
        if (!node) return;
        node.data = node.data || {};
        delete node.data.images;
        delete node.data.image;
        node.imageData = null;
        node.imageDataList = [];
        if (node.type === 'ImageGenerate') {
            node.generatedImages = [];
            node.generationCompletedCount = 0;
        }
    }

    function resetNodeTextOutputsForBatch(node) {
        if (!node) return;
        node.data = node.data || {};
        delete node.data.texts;
        delete node.data.text;
        if (node.type === 'TextChat') {
            node.isSucceeded = false;
            node.lastResponse = '';
        }
    }

    async function executeNodeWithInputBatches(node, inputs, signal) {
        const shouldRunBatches = shouldRunNodeForEachInput(node, inputs);
        const batches = shouldRunBatches ? buildInputBatches(inputs) : [inputs || {}];
        prepareApiNodeGenerationProgress(node, batches.length);

        if (!shouldRunBatches) {
            if (shouldTrackStandaloneConcurrentImageRequests(node)) {
                await executeStandaloneConcurrentImageRequests(node, inputs, signal);
            } else {
                await executeNode(node, inputs, signal);
            }
            return inputs;
        }

        const shouldRunConcurrentBatches = isConcurrentRequestModeEnabled() &&
            (node?.type === 'ImageGenerate' || node?.type === 'VideoGenerate' || node?.type === 'TextChat') &&
            batches.length > 1;
        if (shouldRunConcurrentBatches) {
            if (node.type === 'ImageGenerate') resetNodeImageOutputsForBatch(node);
            if (node.type === 'VideoGenerate') {
                node.data = node.data || {};
                delete node.data.video;
                delete node.data.videoUrl;
                delete node.data.videoStatus;
                delete node.data.videoStatusText;
                delete node.data.videos;
            }
            if (node.type === 'TextChat') resetNodeTextOutputsForBatch(node);
            delete node.apiGenerationProgress;
            prepareApiNodeGenerationProgress(node, batches.length);
            const retryEnabled = state.autoRetry === true && getConcurrentRequestRetryLimit() > 0;
            addLog('info', `并发执行节点: ${getNodeDisplayTitle(node)}`, retryEnabled
                ? `检测到 ${batches.length} 组输入，将并发发起请求，并仅在自动重试开启时重试失败项。`
                : `检测到 ${batches.length} 组输入，将并发发起请求；失败项不会自动重试，成功结果会继续传递到下游。`, {
                nodeId: node.id,
                batchCount: batches.length
            });

            const requestStatusTracker = createConcurrentRequestStatusTracker(
                node,
                getApiNodeRunCount(node, batches.length)
            );
            const settled = await Promise.allSettled(batches.map((batch, index) => (
                executeConcurrentBatchRequest(node, batch, index, batches.length, signal, requestStatusTracker)
            )));
            const rejected = settled.filter((result) => result.status === 'rejected');
            const abortRejection = rejected.find((result) => isAbortLikeError(result.reason));
            if (abortRejection) {
                throw abortRejection.reason;
            }
            const batchResults = settled
                .filter((result) => result.status === 'fulfilled')
                .map((result) => result.value || {});
            if (rejected.length > 0) {
                addLog(batchResults.length > 0 ? 'warning' : 'error', `并发请求部分失败: ${getNodeDisplayTitle(node)}`, `${settled.length} 个请求中 ${rejected.length} 个失败，${batchResults.length} 个成功。${batchResults.length > 0 ? '将仅把成功结果传递到下游。' : '没有可传递的成功结果。'}`, {
                    nodeId: node.id,
                    batchCount: settled.length,
                    successCount: batchResults.length,
                    failedCount: rejected.length,
                    errors: rejected.map((result) => result.reason?.message || String(result.reason))
                });
            }
            if (batchResults.length === 0 && rejected.length > 0) {
                throw rejected[0].reason;
            }
            await commitConcurrentBatchResults(node, batchResults);
            return batches[batches.length - 1] || inputs;
        }

        if (shouldTrackStandaloneConcurrentImageRequests(node) && batches.length === 1) {
            await executeStandaloneConcurrentImageRequests(node, batches[0], signal);
            return batches[0] || inputs;
        }

        const aggregatedImages = [];
        const textOutputPorts = getNodeOutputPortNames(node, 'text');
        const aggregatedTextsByPort = new Map(textOutputPorts.map((portName) => [portName, []]));
        const shouldAggregateImages = getNodeOutputPortNames(node, 'image').length > 0;
        const shouldAggregateTexts = textOutputPorts.length > 0;
        const shouldTrackSequentialImageRequests = shouldTrackStandaloneConcurrentImageRequests(node);
        const sequentialImageRequestStatusTracker = shouldTrackSequentialImageRequests
            ? createConcurrentRequestStatusTracker(node, getApiNodeRunCount(node, batches.length))
            : null;
        addLog('info', `批量执行节点: ${getNodeDisplayTitle(node)}`, `检测到多图输入，将顺序运行 ${batches.length} 次`, {
            nodeId: node.id,
            batchCount: batches.length
        });

        for (let index = 0; index < batches.length; index += 1) {
            if (signal?.aborted) {
                const abortError = new Error('Node run aborted');
                abortError.name = 'AbortError';
                throw abortError;
            }

            if (shouldAggregateImages) resetNodeImageOutputsForBatch(node);
            if (shouldAggregateTexts) resetNodeTextOutputsForBatch(node);
            if (shouldTrackSequentialImageRequests) {
                await executeImageGenerateWithRequestStatus(
                    node,
                    batches[index],
                    signal,
                    sequentialImageRequestStatusTracker,
                    index
                );
            } else {
                await executeNode(node, batches[index], signal);
            }

            if (shouldAggregateImages) {
                const imageOutputs = normalizeImageList(node?.data?.images || node?.imageDataList || node?.data?.image || node?.imageData);
                aggregatedImages.push(...imageOutputs);
            }
            if (shouldAggregateTexts) {
                textOutputPorts.forEach((portName) => {
                    const values = normalizeTextList(getCachedOutputValue(node, portName));
                    if (values.length > 0) {
                        aggregatedTextsByPort.get(portName).push(...values);
                    }
                });
            }
        }

        if (shouldAggregateImages && aggregatedImages.length > 0) {
            node.data = node.data || {};
            node.data.images = aggregatedImages.slice();
            node.data.image = aggregatedImages[aggregatedImages.length - 1];
            delete node.data.imageAssetKey;
            delete node.data.imageMemoryReleased;
            node.imageDataList = aggregatedImages.slice();
            node.imageData = node.data.image;
            if (node.type === 'ImageGenerate') {
                node.generatedImages = aggregatedImages.slice();
                node.generationCompletedCount = aggregatedImages.length;
            }
            await saveImageAssetList(node.id, aggregatedImages);
            await propagateImagesToDownstreamPreview(node.id, aggregatedImages);
            await refreshDependentImageResizePreviews(node.id);
            updateAllConnections();
        }

        if (shouldAggregateTexts) {
            node.data = node.data || {};
            aggregatedTextsByPort.forEach((values, portName) => {
                if (values.length === 0) return;
                node.data[portName] = values.length > 1 ? values.slice() : values[0];
                if (portName === 'text') {
                    node.data.texts = values.slice();
                    node.data.text = values[values.length - 1];
                }
            });
            if (node.type === 'TextChat') {
                const aggregatedTexts = aggregatedTextsByPort.get('text') || [];
                node.lastResponse = aggregatedTexts
                    .map((text, index) => `<div><strong>第 ${index + 1} 次</strong></div><div>${escapeHtml(text).replace(/\n/g, '<br>')}</div>`)
                    .join('<hr />');
                const responseArea = documentRef.getElementById(`${node.id}-response`);
                if (responseArea) responseArea.innerHTML = node.lastResponse;
            }
        }

        return batches[batches.length - 1] || inputs;
    }

    function collectDownstreamNodeIds(plan, sourceNodeId) {
        const downstream = new Set();
        const queue = [sourceNodeId];

        while (queue.length > 0) {
            const currentId = queue.shift();
            if (downstream.has(currentId)) continue;
            downstream.add(currentId);

            state.connections
                .filter((connection) => (
                    connection.from.nodeId === currentId &&
                    plan.scopeNodeSet.has(connection.to.nodeId)
                ))
                .forEach((connection) => {
                    if (!downstream.has(connection.to.nodeId)) {
                        queue.push(connection.to.nodeId);
                    }
                });
        }

        return downstream;
    }

    function createLinkedAbortSignal(signals) {
        const controller = new AbortController();
        const validSignals = signals.filter(Boolean);
        const abort = () => {
            if (!controller.signal.aborted) {
                controller.abort();
            }
        };

        for (const signal of validSignals) {
            if (signal.aborted) {
                abort();
                break;
            }
            signal.addEventListener('abort', abort, { once: true });
        }

        return {
            signal: controller.signal,
            cleanup() {
                validSignals.forEach((signal) => {
                    signal.removeEventListener('abort', abort);
                });
            }
        };
    }

    function unregisterNodeCancelHandler(session, nodeId) {
        getRunningNodeCancelHandlers().delete(nodeId);
        session.nodeAbortControllers?.delete(nodeId);
    }

    function cancelRunningNode(nodeId) {
        const handler = getRunningNodeCancelHandlers().get(nodeId);
        if (typeof handler !== 'function') return false;
        handler();
        return true;
    }

    async function resumeMediaNodeBranch(nodeId, expectedType, resumeTaskFn, taskKind) {
        const node = state.nodes.get(nodeId);
        if (!node || node.type !== expectedType) {
            throw new Error(`未找到可恢复的${taskKind}生成节点`);
        }

        const runOptions = normalizeRunOptions({
            mode: 'target-node',
            targetNodeId: nodeId,
            selectedNodeIds: []
        });
        const plan = resolveExecutionPlan(runOptions);
        if (!plan) {
            throw new Error('无法建立恢复执行计划');
        }

        const alreadyRunningNodeIds = hasRunningNodeInPlan(plan);
        if (alreadyRunningNodeIds.length > 0) {
            throw new Error('当前恢复范围内仍有节点在运行，请等待完成后再试');
        }

        plan.externalInputsByNode = await captureSelectedOnlyExternalInputs(plan);
        const order = (plan.executionOrder || []).filter((nid) => plan.scopeNodeSet.has(nid));
        if (!order.includes(nodeId)) {
            throw new Error('当前恢复节点不在执行计划内');
        }

        const session = {
            controller: new AbortController(),
            nodeAbortControllers: new Map(),
            canceledBranchNodeIds: new Set(),
            stopped: false,
            timeoutId: null,
            finalized: false,
            abortReason: null
        };
        const controllers = getRunAbortControllers();
        controllers.add(session.controller);
        state.activeRunCount = (state.activeRunCount || 0) + 1;
        state.isRunning = true;
        state.abortController = session.controller;
        syncRunToolbarState();

        function finalizeResumeRun() {
            if (session.finalized) return;
            session.finalized = true;
            if (session.timeoutId) {
                clearTimeout(session.timeoutId);
                session.timeoutId = null;
            }
            controllers.delete(session.controller);
            for (const currentNodeId of Array.from(session.nodeAbortControllers.keys())) {
                unregisterNodeCancelHandler(session, currentNodeId);
            }
            state.activeRunCount = Math.max(0, (state.activeRunCount || 0) - 1);
            state.isRunning = state.activeRunCount > 0;
            state.abortController = Array.from(controllers).at(-1) || null;
            if (!state.isRunning) {
                state.abortReason = null;
            }
            syncRunToolbarState();
        }

        const completedNodes = new Set();
        const runningNodes = new Set();
        const downstreamNodes = collectDownstreamNodeIds(plan, nodeId);
        order.forEach((nid) => {
            if (!downstreamNodes.has(nid)) {
                completedNodes.add(nid);
            }
        });
        completedNodes.add(nodeId);

        const executeSingleNodeForResume = async (nid, signal) => {
            const currentNode = state.nodes.get(nid);
            if (!currentNode) {
                completedNodes.add(nid);
                return;
            }
            if (currentNode.enabled === false) {
                completedNodes.add(nid);
                return;
            }

            const nodeTitle = getNodeDisplayTitle(currentNode);
            const nodeController = new AbortController();
            const linkedAbort = createLinkedAbortSignal([
                signal,
                nodeController.signal
            ]);
            session.nodeAbortControllers.set(nid, nodeController);
            getRunningNodeCancelHandlers().set(nid, () => {
                session.canceledBranchNodeIds.add(nid);
                session.controller.abort();
                if (!nodeController.signal.aborted) nodeController.abort();
            });

            runningNodes.add(nid);
            markNodeRunning(nid, currentNode);
            const timeBadge = documentRef.getElementById(`${nid}-time`);
            const timeContainer = documentRef.getElementById(`${nid}-time-container`);
            const startTime = Date.now();
            currentNode.runStartedAt = startTime;
            let timerId = null;
            if (timeBadge) {
                if (timeContainer) timeContainer.style.display = 'flex';
                timerId = setInterval(() => {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    timeBadge.textContent = `${elapsed}s`;
                    if (elapsed > 60) timeBadge.style.color = 'var(--accent-red)';
                    else timeBadge.style.color = '';
                }, 100);
            }

            try {
                const inputs = await collectInputsForNode(plan, nid);
                const loggedInputs = await executeNodeWithInputBatches(currentNode, inputs, linkedAbort.signal);
                if (linkedAbort.signal?.aborted) {
                    const abortError = new Error('Node run aborted');
                    abortError.name = 'AbortError';
                    throw abortError;
                }
                if (timerId) clearInterval(timerId);
                const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
                currentNode.isSucceeded = true;
                currentNode.isFailed = false;
                currentNode.lastDuration = durationSec;
                currentNode.runStartedAt = null;
                clearNodeRunning(nid, currentNode, { status: 'completed', durationSec });
                currentNode.el.classList.add('completed');
                if (timeBadge) {
                    timeBadge.textContent = `${durationSec}s`;
                    timeBadge.style.color = '';
                }
                addLog('success', `节点已完成: ${nodeTitle}`, `耗时 ${durationSec}s`, createNodeCompletionLogDetails(currentNode, loggedInputs, {
                    resumedFromVideoTask: nid === nodeId && expectedType === 'VideoGenerate' ? String(node.data?.videoId || '') : undefined,
                    resumedFromImageTask: nid === nodeId && expectedType === 'ImageGenerate' ? String(node.data?.imageTaskId || '') : undefined
                }));
                scheduleSave();
                completedNodes.add(nid);
            } catch (err) {
                if (isAbortLikeError(err)) {
                    currentNode.runStartedAt = null;
                    clearNodeRunning(nid, currentNode, { status: 'aborted' });
                    clearAbortedNodeFeedback(nid);
                    if (session.abortReason) state.abortReason = session.abortReason;
                    throw err;
                }
                currentNode.runStartedAt = null;
                currentNode.isSucceeded = false;
                currentNode.isFailed = true;
                clearNodeRunning(nid, currentNode, { status: 'error' });
                currentNode.el.classList.add('error');
                const errorMsg = err.message || '未知错误';
                if (timeBadge) timeBadge.textContent = 'Err';
                const errorDetails = err.serverResponse || { nodeId: nid, error: err.stack || err };
                addLog('error', `节点失败: ${nodeTitle}`, errorMsg, errorDetails, {
                    userFacing: err.userFacing || null
                });
                throw err;
            } finally {
                if (timerId) clearInterval(timerId);
                linkedAbort.cleanup();
                clearNodeRunning(nid, currentNode);
                currentNode.runStartedAt = null;
                unregisterNodeCancelHandler(session, nid);
                runningNodes.delete(nid);
            }
        };

        try {
            const nodeTitle = getNodeDisplayTitle(node);
            const taskId = expectedType === 'VideoGenerate'
                ? String(node.data?.videoId || '').trim()
                : String(node.data?.imageTaskId || '').trim();
            addLog('info', `恢复${taskKind}任务`, `开始恢复「${nodeTitle}」并续跑下游节点`, {
                nodeId,
                taskId,
                downstreamNodeCount: Math.max(0, downstreamNodes.size - 1)
            });

            const mediaNodeController = new AbortController();
            const linkedResumeAbort = createLinkedAbortSignal([
                session.controller.signal,
                mediaNodeController.signal
            ]);
            session.nodeAbortControllers.set(nodeId, mediaNodeController);
            getRunningNodeCancelHandlers().set(nodeId, () => {
                session.canceledBranchNodeIds.add(nodeId);
                session.controller.abort();
            });

            runningNodes.add(nodeId);
            markNodeRunning(nodeId, node);
            try {
                await resumeTaskFn(nodeId, linkedResumeAbort.signal);
                node.isSucceeded = true;
                node.isFailed = false;
                node.el.classList.add('completed');
                scheduleSave();
            } finally {
                linkedResumeAbort.cleanup();
                clearNodeRunning(nodeId, node, { status: node.isSucceeded ? 'completed' : 'aborted' });
                runningNodes.delete(nodeId);
                unregisterNodeCancelHandler(session, nodeId);
            }

            for (const nid of order) {
                if (nid === nodeId) continue;
                if (!downstreamNodes.has(nid)) continue;
                if (session.controller.signal.aborted) {
                    const abortError = new Error('Node run aborted');
                    abortError.name = 'AbortError';
                    throw abortError;
                }
                const deps = (plan.incomingConnectionsByNode[nid] || []).map((c) => c.from.nodeId);
                if (!deps.every((depNodeId) => completedNodes.has(depNodeId))) {
                    continue;
                }
                await executeSingleNodeForResume(nid, session.controller.signal);
            }

            await releaseWorkflowIntermediateImageResults(plan, completedNodes);
            updateAllConnections();
            updatePortStyles();
            dispatchWorkflowCompletionNotice({
                toastMessage: `${taskKind}任务恢复完成，后续节点已继续执行`,
                toastType: 'success',
                notificationTitle: 'CainFlow 恢复完成',
                notificationBody: `${taskKind}节点及其下游已继续执行完成`
            });
        } catch (error) {
            if (isAbortLikeError(error)) {
                if (session.abortReason) state.abortReason = session.abortReason;
                addLog('info', '恢复执行已停止', getAbortMessage(state));
                throw error;
            }
            throw error;
        } finally {
            finalizeResumeRun();
        }
    }

    async function resumeVideoNodeBranch(nodeId) {
        return resumeMediaNodeBranch(nodeId, 'VideoGenerate', resumeVideoGeneration, '视频');
    }

    async function resumeImageNodeBranch(nodeId) {
        return resumeMediaNodeBranch(nodeId, 'ImageGenerate', resumeAsyncImageGeneration, '图片');
    }

    async function runWorkflow(runInput = null) {
        if (state.isRunStarting) {
            return { started: false, executed: false, reason: 'starting' };
        }
        state.isRunStarting = true;
        syncRunToolbarState();
        let startSucceeded = false;
        let started = false;
        let executed = false;
        try {
            await new Promise((resolve) => {
                const requestFrame = documentRef.defaultView?.requestAnimationFrame;
                if (typeof requestFrame === 'function') {
                    requestFrame(() => resolve());
                } else {
                    setTimeout(resolve, 16);
                }
            });

            if (state.nodes.size === 0) {
                showToast('当前画布没有任何节点，请先添加节点或加载工作流', 'warning');
                return { started: false, executed: false, reason: 'empty-canvas' };
            }
            let runOptions = normalizeRunOptions(runInput);
            let plan = resolveExecutionPlan(runOptions);
            if (!plan) {
                return { started: false, executed: false, reason: 'no-plan' };
            }
            const runnableNodeIds = (plan.executionOrder || plan.nodeIds || [])
                .filter((nid) => state.nodes.get(nid)?.enabled !== false);
            if (runnableNodeIds.length === 0) {
                showToast('当前运行范围内没有启用的可运行节点', 'warning');
                return { started: false, executed: false, reason: 'no-enabled-nodes' };
            }
            plan.externalInputsByNode = await captureSelectedOnlyExternalInputs(plan);

            const alreadyRunningNodeIds = hasRunningNodeInPlan(plan);
            if (alreadyRunningNodeIds.length > 0) {
                showToast(`当前运行范围内有 ${alreadyRunningNodeIds.length} 个节点仍在运行，请等待这些节点完成后再运行`, 'warning');
                return { started: false, executed: false, reason: 'already-running' };
            }

            const missingKeysProviders = new Set();
            for (const id of plan.nodeIds) {
                const node = state.nodes.get(id);
                if (!node) continue;
                if (node.type === 'ImageGenerate' || node.type === 'VideoGenerate' || node.type === 'TextChat') {
                    const configSelect = documentRef.getElementById(`${id}-apiconfig`);
                    if (configSelect) {
                        const modelCfg = state.models.find((model) => model.id === configSelect.value);
                        if (modelCfg) {
                            const selectedProviderId = documentRef.getElementById(`${id}-provider`)?.value || state.nodes.get(id)?.providerId || '';
                            const apiCfg = getResolvedProviderForModel(modelCfg, state.providers, selectedProviderId);
                            if (apiCfg && !apiCfg.apikey.trim()) {
                                missingKeysProviders.add(apiCfg.name);
                            }
                        }
                    }
                }
            }

            if (missingKeysProviders.size > 0) {
                const names = Array.from(missingKeysProviders).join(', ');
                const msg = `场景中存在未配置 API 密钥的模型（涉及供应商: ${names}），可能会导致执行报错。\n\n您确定要强制继续运行吗？`;
                if (!confirmRef(msg)) {
                    return { started: false, executed: false, reason: 'missing-api-key-confirm-cancelled' };
                }
            }

            const session = {
                controller: new AbortController(),
                timeoutId: null,
                stopped: false,
                abortReason: null,
                finalized: false,
                canceledBranchNodeIds: new Set(),
                nodeAbortControllers: new Map()
            };
            getRunAbortControllers().add(session.controller);
            state.activeRunCount = (state.activeRunCount || 0) + 1;
            state.isRunning = true;
            state.isRunStarting = false;
            state.abortReason = null;
            state.abortController = session.controller;
            syncRunToolbarState();
            startSucceeded = true;
            started = true;
            if (state.requestTimeoutEnabled) {
                const timeoutMs = Math.max(1, parseInt(state.requestTimeoutSeconds, 10) || 60) * 1000;
                session.timeoutId = setTimeout(() => {
                    if (session.finalized || session.controller.signal.aborted) return;
                    session.abortReason = 'timeout';
                    state.abortReason = 'timeout';
                    session.stopped = true;
                    session.controller.abort();
                }, timeoutMs);
            }

            if (state.notificationsEnabled) {
                if (!state.notificationAudio) {
                    state.notificationAudio = audioFactory();
                    state.notificationAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';
                    state.notificationAudio.loop = true;
                }
                state.notificationAudio.muted = false;
                state.notificationAudio.volume = 0.001;
                state.notificationAudio.play().catch((e) => {
                    console.warn('Audio warm-up blocked:', e);
                    addLog('warning', '音频保活受限', '浏览器禁用了后台音频，通知音效可能在非活动状态下失效，请确保已与页面交互。');
                });
            }

            const forceResetNodeIds = new Set();
            if (runOptions.mode === 'target-node' && runOptions.targetNodeId) {
                forceResetNodeIds.add(runOptions.targetNodeId);
            }

            resetNodesForPlan(plan, { forceResetNodeIds });

            let order = plan.executionOrder.slice();

        const emptyImageNodes = [];
        for (const nid of order) {
            const node = state.nodes.get(nid);
            if (node && node.enabled !== false && node.type === 'ImageImport' && !(await restoreImageImportOutput(node))) {
                emptyImageNodes.push(nid);
            }
        }

        if (emptyImageNodes.length > 0) {
            showToast(`执行中止：当前路径中有 ${emptyImageNodes.length} 个图片导入节点未加载图片`, 'error', 5000);
            emptyImageNodes.forEach((nid) => {
                const node = state.nodes.get(nid);
                if (node) {
                    node.isFailed = true;
                    node.el.classList.add('error');
                    addLog('error', '前置检查未通过', `节点「图片导入」(${nid}) 未载入素材图片`);
                }
            });
            finalizeWorkflow();
            return { started: true, executed: false, reason: 'missing-image-input' };
        }

        const emptyPromptNodes = [];
        for (const nid of order) {
            const node = state.nodes.get(nid);
            if (node && node.enabled !== false && (node.type === 'TextChat' || node.type === 'VideoGenerate')) {
                const fixedToggle = documentRef.getElementById(`${nid}-fixed`);
                if (node.type === 'TextChat' && fixedToggle && fixedToggle.checked && node.isSucceeded) continue;

                const textareaValue = documentRef.getElementById(`${nid}-prompt`)?.value || '';
                const hasPromptInput = hasPromptInputValue(plan, nid);
                if (!hasPromptInput && !textareaValue.trim()) {
                    emptyPromptNodes.push(nid);
                }
            }
        }

        if (emptyPromptNodes.length > 0) {
            showToast(`执行中止：当前路径中有 ${emptyPromptNodes.length} 个智能对话节点内容为空`, 'error', 5000);
            emptyPromptNodes.forEach((nid) => {
                const node = state.nodes.get(nid);
                if (node) {
                    node.isFailed = true;
                    node.el.classList.add('error');
                    addLog('error', '前置检查未通过', `节点「智能对话」(${nid}) 提示词内容缺失（连线或文本框均无内容）`);
                }
            });
            finalizeWorkflow();
            return { started: true, executed: false, reason: 'missing-prompt-input' };
        }

        if (state.globalSaveDirHandle) {
            const hasSaveNode = order.some((nid) => state.nodes.get(nid)?.type === 'ImageSave');
            if (hasSaveNode) {
                try {
                    const status = await state.globalSaveDirHandle.queryPermission({ mode: 'readwrite' });
                    if (status !== 'granted') {
                        addLog('info', '目录授权请求', '尝试获取保存目录的写入权限...');
                        const req = await state.globalSaveDirHandle.requestPermission({ mode: 'readwrite' });
                        if (req !== 'granted') {
                            showToast('自动保存未授权：工作流将继续，但图片无法自动落盘', 'warning', 4000);
                            addLog('warning', '目录授权失败', '用户拒绝了目录访问请求，图片将仅保存在节点内');
                        } else {
                            addLog('success', '目录授权成功', '自动保存功能已就绪');
                        }
                    }
                } catch (e) {
                    console.warn('Directory permission verify failed:', e);
                }
            }
        }

        function finalizeWorkflow() {
            if (session.finalized) return;
            session.finalized = true;
            if (session.timeoutId) {
                clearTimeout(session.timeoutId);
                session.timeoutId = null;
            }
            const controllers = getRunAbortControllers();
            controllers.delete(session.controller);
            for (const nodeId of Array.from(session.nodeAbortControllers.keys())) {
                unregisterNodeCancelHandler(session, nodeId);
            }
            state.activeRunCount = Math.max(0, (state.activeRunCount || 0) - 1);
            state.isRunning = state.activeRunCount > 0;
            state.isRunStarting = false;
            state.abortController = Array.from(controllers).at(-1) || null;
            if (!state.isRunning) {
                state.abortReason = null;
            }
            syncRunToolbarState();
        }

        if (plan.mode !== 'selected-only') {
            let injected = false;
            for (const nid of order) {
                const node = state.nodes.get(nid);
                if (node && node.type === 'ImageGenerate') {
                    const hasConnection = state.connections.some((c) => c.from.nodeId === nid && c.from.port === 'image');
                    if (!hasConnection) {
                        const rect = node.el.getBoundingClientRect();
                        const nodeWidth = rect.width || 240;
                        const saveId = addNode('ImageSave', node.x + nodeWidth + 80, node.y);
                        if (saveId) {
                            state.connections.push({
                                id: 'conn_' + generateId(),
                                from: { nodeId: nid, port: 'image', type: 'image' },
                                to: { nodeId: saveId, port: 'image', type: 'image' },
                                type: 'image'
                            });
                            injected = true;
                            addLog('info', '自动注入节点', `为「${getNodeDisplayTitle(node)}」自动添加了保存节点`);
                        }
                    }
                }
                if (node && node.type === 'VideoGenerate') {
                    const hasConnection = state.connections.some((c) => c.from.nodeId === nid && c.from.port === 'video');
                    if (!hasConnection) {
                        const rect = node.el.getBoundingClientRect();
                        const nodeWidth = rect.width || 240;
                        const saveId = addNode('ImageSave', node.x + nodeWidth + 80, node.y);
                        if (saveId) {
                            state.connections.push({
                                id: 'conn_' + generateId(),
                                from: { nodeId: nid, port: 'video', type: 'video' },
                                to: { nodeId: saveId, port: 'video', type: 'video' },
                                type: 'video'
                            });
                            injected = true;
                            addLog('info', '自动注入节点', `为「${getNodeDisplayTitle(node)}」自动添加了保存节点`);
                        }
                    }
                }
            }
            if (injected) {
                updateAllConnections();
                updatePortStyles();
                onAutoSaveNodeInjected();
                runOptions = normalizeRunOptions(runOptions);
                plan = resolveExecutionPlan(runOptions);
                if (!plan) {
                    finalizeWorkflow();
                    return { started: true, executed: false, reason: 'no-plan-after-injection' };
                }
                const runnableNodeIdsAfterInjection = (plan.executionOrder || plan.nodeIds || [])
                    .filter((nid) => state.nodes.get(nid)?.enabled !== false);
                if (runnableNodeIdsAfterInjection.length === 0) {
                    showToast('当前运行范围内没有启用的可运行节点', 'warning');
                    finalizeWorkflow();
                    return { started: true, executed: false, reason: 'no-enabled-nodes-after-injection' };
                }
                order = plan.executionOrder.slice();
                resetNodesForPlan(plan, { forceResetNodeIds });
            }
        }

        const totalWorkflowStartTime = Date.now();
        addLog('info', '并发工作流启动', `开始运行 ${order.length} 个节点...`);
        executed = order.length > 0;

        let retryAttempt = 0;
        const maxRetries = state.maxRetries || 15;
        const completedNodes = new Set();
        const failedNodes = new Set();
        const runningNodes = new Set();
        let terminatedByError = false;
        const isRunActive = () => !session.stopped && !session.controller.signal.aborted;

        const markNodeBranchCanceled = (nodeId) => {
            const nodeController = session.nodeAbortControllers.get(nodeId);
            const isNodeMarkedRunning = runningNodes.has(nodeId) || getRunningNodeIds().has(nodeId);
            if (!isNodeMarkedRunning && !nodeController) return false;

            const branchNodeIds = collectDownstreamNodeIds(plan, nodeId);
            let newlyCanceledCount = 0;
            branchNodeIds.forEach((branchNodeId) => {
                if (!session.canceledBranchNodeIds.has(branchNodeId)) {
                    session.canceledBranchNodeIds.add(branchNodeId);
                    failedNodes.delete(branchNodeId);
                    newlyCanceledCount += 1;
                }
            });

            if (nodeController && !nodeController.signal.aborted) {
                nodeController.abort();
            }

            const node = state.nodes.get(nodeId);
            const nodeTitle = node ? getNodeDisplayTitle(node) : nodeId;
            const downstreamCount = Math.max(0, branchNodeIds.size - 1);
            addLog('warning', `节点已取消: ${nodeTitle}`, downstreamCount > 0
                ? `已取消当前节点，并跳过 ${downstreamCount} 个下游节点`
                : '已取消当前节点');
            showToast(downstreamCount > 0
                ? `已取消当前节点，下游 ${downstreamCount} 个节点不会继续运行`
                : '已取消当前节点运行', 'info', 4000);
            return newlyCanceledCount > 0;
        };

        try {
            while (true) {
                while (true) {
                    if (!isRunActive()) break;

                    const readyNodes = order.filter((nid) => {
                        if (session.canceledBranchNodeIds.has(nid)) return false;
                        if (completedNodes.has(nid) || runningNodes.has(nid) || failedNodes.has(nid)) return false;
                        const node = state.nodes.get(nid);
                        if (!node || node.enabled === false) {
                            completedNodes.add(nid);
                            return false;
                        }

                        const deps = (plan.incomingConnectionsByNode[nid] || []).map((c) => c.from.nodeId);
                        return deps.every((dnid) => completedNodes.has(dnid));
                    });

                    if (readyNodes.length === 0 && runningNodes.size === 0) break;

                    if (readyNodes.length > 0) {
                        readyNodes.forEach((nid) => {
                            if (session.canceledBranchNodeIds.has(nid) || runningNodes.has(nid) || completedNodes.has(nid)) return;
                            runningNodes.add(nid);
                            const node = state.nodes.get(nid);
                            const nodeTitle = getNodeDisplayTitle(node);
                            const nodeController = new AbortController();
                            const linkedAbort = createLinkedAbortSignal([
                                session.controller.signal,
                                nodeController.signal
                            ]);
                            session.nodeAbortControllers.set(nid, nodeController);
                            getRunningNodeCancelHandlers().set(nid, () => markNodeBranchCanceled(nid));

                            (async () => {
                                markNodeRunning(nid, node);
                                const timeBadge = documentRef.getElementById(`${nid}-time`);
                                const timeContainer = documentRef.getElementById(`${nid}-time-container`);
                                const startTime = Date.now();
                                node.runStartedAt = startTime;
                                let timerId = null;
                                if (timeBadge) {
                                    if (timeContainer) timeContainer.style.display = 'flex';
                                    timerId = setInterval(() => {
                                        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                                        timeBadge.textContent = `${elapsed}s`;
                                        if (elapsed > 60) timeBadge.style.color = 'var(--accent-red)';
                                        else timeBadge.style.color = '';
                                    }, 100);
                                }

                                try {
                                    const inputs = await collectInputsForNode(plan, nid);
                                    const loggedInputs = await executeNodeWithInputBatches(node, inputs, linkedAbort.signal);

                                    if (session.canceledBranchNodeIds.has(nid) || nodeController.signal.aborted) {
                                        const abortError = new Error('Node run aborted');
                                        abortError.name = 'AbortError';
                                        throw abortError;
                                    }

                                    if (timerId) clearInterval(timerId);
                                    const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
                                    node.isSucceeded = true;
                                    node.isFailed = false;
                                    node.lastDuration = durationSec;
                                    node.runStartedAt = null;
                                    clearNodeRunning(nid, node, { status: 'completed', durationSec });
                                    node.el.classList.add('completed');
                                    if (timeBadge) {
                                        timeBadge.textContent = `${durationSec}s`;
                                        timeBadge.style.color = '';
                                    }
                                    addLog('success', `节点已完成: ${nodeTitle}`, `耗时 ${durationSec}s`, createNodeCompletionLogDetails(node, loggedInputs));
                                    scheduleSave();
                                    completedNodes.add(nid);
                                } catch (err) {
                                    if (isAbortLikeError(err)) {
                                        node.runStartedAt = null;
                                        clearNodeRunning(nid, node, { status: 'aborted' });
                                        clearAbortedNodeFeedback(nid);
                                        if (session.abortReason) state.abortReason = session.abortReason;
                                        if (!session.canceledBranchNodeIds.has(nid)) {
                                            addLog('warning', `节点已中止: ${nodeTitle}`, getAbortMessage(state));
                                        }
                                        return;
                                    }
                                    node.runStartedAt = null;
                                    node.isSucceeded = false;
                                    node.isFailed = true;
                                    clearNodeRunning(nid, node, { status: 'error' });
                                    node.el.classList.add('error');
                                    const errorMsg = err.message || '未知错误';
                                    if (timeBadge) timeBadge.textContent = 'Err';
                                    const errorDetails = err.serverResponse || { nodeId: nid, error: err.stack || err };
                                    addLog('error', `节点失败: ${nodeTitle}`, errorMsg, errorDetails, {
                                        userFacing: err.userFacing || null
                                    });

                                    failedNodes.add(nid);

                                    if (!state.autoRetry) {
                                        showToast(`「${nodeTitle}」出错: ${errorMsg}`, 'error', 5000);
                                        terminatedByError = true;
                                        session.stopped = true;
                                    }
                                } finally {
                                    if (timerId) clearInterval(timerId);
                                    linkedAbort.cleanup();
                                    clearNodeRunning(nid, node);
                                    unregisterNodeCancelHandler(session, nid);
                                    runningNodes.delete(nid);
                                }
                            })();
                        });
                    }

                    await new Promise((resolve) => setTimeout(resolve, 100));
                    if (!isRunActive()) break;
                }

                if (!isRunActive()) break;

                const actualFailures = order.filter((id) => {
                    if (session.canceledBranchNodeIds.has(id)) return false;
                    const node = state.nodes.get(id);
                    return node && node.enabled !== false && !completedNodes.has(id);
                });

                if (actualFailures.length === 0) {
                    if (retryAttempt > 0) {
                        addLog('success', '工作流并行重试完成', `经过 ${retryAttempt} 次重试后，所有节点已成功执行。`);
                    }
                    break;
                }

                if (!state.autoRetry) break;

                retryAttempt++;
                if (retryAttempt > maxRetries) {
                    showToast(`已达到最大重试次数 (${maxRetries})，停止运行`, 'error');
                    addLog('error', '并行工作流强制终止', `已超过设定的最大自动重试次数 (${maxRetries} 轮)，执行已停止。请检查网络稳定性或节点配置。`);
                    terminatedByError = true;
                    break;
                }

                addLog('warning', `自动重试开始（第 ${retryAttempt} 轮）`, `${actualFailures.length} 个节点未成功，正在准备重新执行相关分支...`);
                showToast(`正在启动第 ${retryAttempt} 轮自动重试（${actualFailures.length} 个节点）...`, 'warning', 4000);
                failedNodes.clear();
                await new Promise((resolve) => setTimeout(resolve, 1500));
                if (!isRunActive()) break;
            }
        } finally {
            if (session.timeoutId) {
                clearTimeout(session.timeoutId);
                session.timeoutId = null;
            }
            const abortReason = session.abortReason || state.abortReason;
            const wasManuallyStopped = abortReason === 'manual';
            const wasTimedOut = abortReason === 'timeout';
            if (!isRunActive()) {
                if (session.abortReason) state.abortReason = session.abortReason;
                if (wasManuallyStopped) {
                    addLog('info', '工作流停止', getAbortMessage({ ...state, abortReason }));
                }
                for (const nid of runningNodes) {
                    const node = state.nodes.get(nid);
                    if (node) clearNodeRunning(nid, node);
                }
            }

            for (const [id, node] of state.nodes) {
                if (node.type === 'ImageSave' && (node.data.image || node.data.video?.url)) {
                    const btnSave = node.el.querySelector(`#${id}-manual-save`);
                    const btnView = node.el.querySelector(`#${id}-view-full`);
                    if (btnSave) btnSave.disabled = false;
                    if (btnView) btnView.disabled = !node.data.image;
                }
            }

            const hasNodeBranchCancellation = session.canceledBranchNodeIds.size > 0;
            const completedRun = !terminatedByError && isRunActive() && !hasNodeBranchCancellation;
            finalizeWorkflow();

            const totalDuration = ((Date.now() - totalWorkflowStartTime) / 1000).toFixed(2);

            if (terminatedByError) {
                dispatchWorkflowCompletionNotice({
                    toastMessage: `工作流运行停止，耗时 ${totalDuration}s`,
                    toastType: 'error',
                    notificationTitle: 'CainFlow 运行出错',
                    notificationBody: `工作流已停止，部分节点执行失败。耗时 ${totalDuration}s`,
                    playSound: true
                });
            } else if (completedRun) {
                await releaseWorkflowIntermediateImageResults(plan, completedNodes);
                dispatchWorkflowCompletionNotice({
                    toastMessage: `工作流运行完成，总耗时 ${totalDuration}s`,
                    toastType: 'success',
                    notificationTitle: 'CainFlow 运行完毕',
                    notificationBody: `所有节点执行成功，总耗时 ${totalDuration}s`,
                    playSound: true
                });
            } else if (hasNodeBranchCancellation && isRunActive()) {
                await releaseWorkflowIntermediateImageResults(plan, completedNodes);
                dispatchWorkflowCompletionNotice({
                    toastMessage: `已跳过被取消节点的下游，其余节点已结束，耗时 ${totalDuration}s`,
                    toastType: 'info',
                    notificationTitle: 'CainFlow 分支已取消',
                    notificationBody: `已跳过被取消节点的下游，其余节点已结束。耗时 ${totalDuration}s`,
                    playSound: true
                });
            } else if (wasTimedOut) {
                dispatchWorkflowCompletionNotice({
                    toastMessage: '请求超时，生成失败',
                    toastType: 'error',
                    notificationTitle: 'CainFlow 请求超时',
                    notificationBody: `工作流因请求超时停止，耗时 ${totalDuration}s`
                });
            } else if (wasManuallyStopped) {
                dispatchWorkflowCompletionNotice({
                    toastMessage: '已手动停止运行',
                    toastType: 'info',
                    notificationTitle: 'CainFlow 已停止',
                    notificationBody: `工作流已手动停止，耗时 ${totalDuration}s`
                });
            }
            return {
                started,
                executed,
                reason: terminatedByError
                    ? 'error'
                    : (completedRun || hasNodeBranchCancellation || wasTimedOut || wasManuallyStopped ? 'finished' : 'no-execution')
            };
        }
        } finally {
            if (!startSucceeded) {
                state.isRunStarting = false;
                syncRunToolbarState();
            }
        }
    }

    return {
        runWorkflow,
        cancelRunningNode,
        resumeVideoNodeBranch,
        resumeImageNodeBranch
    };
}
