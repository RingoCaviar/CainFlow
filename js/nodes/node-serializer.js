/**
 * 负责节点与连接的序列化和反序列化，为保存、导入、撤销和工作流复制提供数据结构转换。
 */
import { normalizeConcurrentRequestStatusPayload } from '../features/execution/concurrent-request-status-ui.js';
import {
    getCanonicalImageList
} from '../features/execution/execution-data-utils.js';

const CANONICAL_IMAGE_NODE_TYPES = new Set(['ImageGenerate', 'ImageMerge', 'ImagePreview', 'ImageSave']);

export function createNodeSerializer({ state, documentRef }) {
    function getOrderedNodes() {
        const nodesLayer = documentRef.getElementById('nodes-layer');
        if (!nodesLayer) return Array.from(state.nodes.entries());

        const orderedEntries = [];
        const seenIds = new Set();

        Array.from(nodesLayer.children).forEach((child) => {
            const nodeId = child?.id;
            if (!nodeId || !state.nodes.has(nodeId)) return;
            orderedEntries.push([nodeId, state.nodes.get(nodeId)]);
            seenIds.add(nodeId);
        });

        for (const entry of state.nodes.entries()) {
            if (!seenIds.has(entry[0])) {
                orderedEntries.push(entry);
            }
        }

        return orderedEntries;
    }

    function getNodeTextareaHeights(id) {
        const heights = {};
        documentRef.querySelectorAll(`#${id} textarea[id^="${id}-"]`).forEach((textarea) => {
            const key = textarea.id.slice(`${id}-`.length);
            const height = textarea.offsetHeight || parseFloat(textarea.style.height || '0');
            if (key && Number.isFinite(height) && height > 0) {
                heights[key] = Math.round(height);
            }
        });
        const responseArea = documentRef.getElementById(`${id}-response`);
        if (responseArea) {
            const responseHeight = responseArea.offsetHeight || parseFloat(responseArea.style.height || '0');
            if (Number.isFinite(responseHeight) && responseHeight > 0) {
                heights.response = Math.round(responseHeight);
            }
        }
        return Object.keys(heights).length > 0 ? heights : null;
    }

    function readNodeProtocolParams(id, node) {
        const params = { ...(node?.data?.protocolParams || {}) };
        documentRef.querySelectorAll(`#${id}-protocol-params [id^="${id}-param-"]`).forEach((element) => {
            const rawParamId = element.id.slice(`${id}-param-`.length);
            if (!rawParamId || rawParamId.endsWith('-custom')) return;
            if (element.type === 'checkbox') {
                params[rawParamId] = element.checked === true;
                return;
            }
            if (element.tagName === 'SELECT' && element.value === 'custom') {
                params[rawParamId] = documentRef.getElementById(`${id}-param-${rawParamId}-custom`)?.value || '';
                return;
            }
            params[rawParamId] = element.value;
        });
        return params;
    }

    function serializeNodes() {
        const nodes = [];
        for (const [id, node] of getOrderedNodes()) {
            const serialized = {
                id,
                type: node.type,
                x: node.x,
                y: node.y,
                width: node.width || null,
                height: node.height || null,
                userResized: node.userResized === true,
                collapsed: node.collapsed === true,
                enabled: node.enabled,
                isFailed: node.isFailed === true || node.el?.classList?.contains('error') === true,
                lastDuration: node.lastDuration || null
            };
            if (node.collapsed === true && Number.isFinite(node.collapsedExpandedHeight) && node.collapsedExpandedHeight > 0) {
                serialized.collapsedExpandedHeight = Math.round(node.collapsedExpandedHeight);
            }
            if (node.isClone === true && typeof node.cloneSourceId === 'string' && node.cloneSourceId) {
                serialized.isClone = true;
                serialized.cloneSourceId = node.cloneSourceId;
            }
            if (typeof node.customTitle === 'string' && node.customTitle.trim()) {
                serialized.customTitle = node.customTitle.trim();
            }
            const textareaHeights = getNodeTextareaHeights(id);
            if (textareaHeights) serialized.textareaHeights = textareaHeights;

            const usesCanonicalImages = CANONICAL_IMAGE_NODE_TYPES.has(node.type);
            const images = getCanonicalImageList(node, { includeResizePreview: false });
            const imageCount = Math.max(
                images.length,
                Math.max(0, parseInt(node.data?.imageCount || '0', 10) || 0)
            );
            const imageAssetKey = typeof node.data?.imageAssetKey === 'string' && node.data.imageAssetKey
                ? node.data.imageAssetKey
                : '';
            const imageImportAssetKey = typeof node.imageImportAssetKey === 'string' && node.imageImportAssetKey
                ? node.imageImportAssetKey
                : (typeof node.data?.imageImportAssetKey === 'string' ? node.data.imageImportAssetKey : '');
            const hasRecoverableImageAsset = Boolean(imageAssetKey || imageImportAssetKey);
            if (usesCanonicalImages) {
                if (imageAssetKey) serialized.imageAssetKey = imageAssetKey;
                if (imageCount > 0) serialized.imageCount = imageCount;
                if (imageCount > 1) {
                    serialized.imagePreviewIndex = Math.max(0, parseInt(node.imagePreviewIndex || '0', 10) || 0);
                }
            }
            if (hasRecoverableImageAsset) {
                if (!usesCanonicalImages && imageAssetKey) serialized.imageAssetKey = imageAssetKey;
                if (imageCount > 0 && !usesCanonicalImages) serialized.imageCount = imageCount;
                if (imageCount > 1 && !usesCanonicalImages) {
                    serialized.imagePreviewIndex = Math.max(0, parseInt(node.imagePreviewIndex || '0', 10) || 0);
                }
                if (node.data?.imageAssetReady === true) serialized.imageAssetReady = true;
                if (node.data?.imageHydratedAt) serialized.imageHydratedAt = node.data.imageHydratedAt;
            }
            if (node.data?.imageMemoryReleased === true && hasRecoverableImageAsset) {
                serialized.imageMemoryReleased = true;
                if (imageAssetKey) serialized.imageAssetKey = imageAssetKey;
            }
            if (node.type === 'ImageImport') {
                serialized.importMode = documentRef.getElementById(`${id}-import-mode`)?.value || node.importMode || 'upload';
                serialized.imageUrl = documentRef.getElementById(`${id}-url-input`)?.value || node.imageUrl || '';
                if (serialized.importMode !== 'url') {
                    serialized.imageImportAssetKey = imageImportAssetKey;
                }
            }

            if (node.type === 'ImageResize') {
                serialized.resizeMode = documentRef.getElementById(`${id}-resize-mode`)?.value || 'scale';
                serialized.scalePercent = parseInt(documentRef.getElementById(`${id}-scale-percent`)?.value || '100', 10);
                serialized.targetWidth = documentRef.getElementById(`${id}-target-width`)?.value || '';
                serialized.targetHeight = documentRef.getElementById(`${id}-target-height`)?.value || '';
                serialized.keepAspect = documentRef.getElementById(`${id}-keep-aspect`)?.checked !== false;
                serialized.quality = parseInt(documentRef.getElementById(`${id}-quality`)?.value || '92', 10);
                serialized.originalWidth = node.originalWidth || node.resizePreviewMeta?.originalWidth || 0;
                serialized.originalHeight = node.originalHeight || node.resizePreviewMeta?.originalHeight || 0;
                serialized.outputWidth = node.outputWidth || node.resizePreviewMeta?.outputWidth || 0;
                serialized.outputHeight = node.outputHeight || node.resizePreviewMeta?.outputHeight || 0;
                serialized.outputFormat = node.outputFormat || node.resizePreviewMeta?.outputFormat || '';
                serialized.outputQuality = node.outputQuality || node.resizePreviewMeta?.outputQuality || null;
                serialized.estimatedBytes = node.estimatedBytes || node.resizePreviewMeta?.estimatedBytes || null;
            }

            if (node.type === 'ImageGenerate' || node.type === 'VideoGenerate' || node.type === 'TextChat') {
                serialized.referenceImageCount = Math.max(0, parseInt(node.referenceImageCount ?? node.data?.referenceImageCount ?? '5', 10) || 0);
                serialized.apiConfigId = documentRef.getElementById(`${id}-apiconfig`)?.value || 'default';
                serialized.providerId = documentRef.getElementById(`${id}-provider`)?.value || node.providerId || '';
                serialized.prompt = documentRef.getElementById(`${id}-prompt`)?.value || '';
                if (node.type === 'ImageGenerate') {
                    serialized.aspect = documentRef.getElementById(`${id}-aspect`)?.value || '';
                    serialized.resolution = documentRef.getElementById(`${id}-resolution`)?.value || '';
                    serialized.customWidth = documentRef.getElementById(`${id}-custom-resolution-width`)?.value || '';
                    serialized.customHeight = documentRef.getElementById(`${id}-custom-resolution-height`)?.value || '';
                    serialized.customResolution = serialized.customWidth && serialized.customHeight
                        ? `${serialized.customWidth}x${serialized.customHeight}`
                        : '';
                    serialized.quality = documentRef.getElementById(`${id}-quality`)?.value || 'auto';
                    serialized.moderation = documentRef.getElementById(`${id}-moderation`)?.value || 'auto';
                    serialized.background = documentRef.getElementById(`${id}-background`)?.value || 'auto';
                    serialized.search = documentRef.getElementById(`${id}-search`)?.checked || false;
                    serialized.protocolParams = readNodeProtocolParams(id, node);
                    serialized.generationCount = Math.max(1, parseInt(documentRef.getElementById(`${id}-generation-count`)?.value || '1', 10) || 1);
                    serialized.imageTaskId = node.data?.imageTaskId || '';
                    serialized.imageTaskStatus = node.data?.imageTaskStatus || '';
                    serialized.imageTaskStatusText = node.data?.imageTaskStatusText || '';
                    serialized.imageTaskUrl = node.data?.imageTaskUrl || '';
                    serialized.imageTaskCreateHttpStatus = node.data?.imageTaskCreateHttpStatus || '';
                    serialized.imageTaskCreateStatus = node.data?.imageTaskCreateStatus || '';
                    serialized.imageTaskProgress = node.data?.imageTaskProgress || '';
                    if (node.data?.concurrentRequestStatus?.total > 0) {
                        serialized.concurrentRequestStatus = normalizeConcurrentRequestStatusPayload(node.data.concurrentRequestStatus);
                    }
                } else if (node.type === 'VideoGenerate') {
                    serialized.aspect = documentRef.getElementById(`${id}-aspect`)?.value || '16:9';
                    serialized.useVideoSizeParam = documentRef.getElementById(`${id}-use-size-param`)?.checked === true;
                    serialized.enhancePrompt = documentRef.getElementById(`${id}-enhance-prompt`)?.checked === true;
                    serialized.enableUpsample = documentRef.getElementById(`${id}-enable-upsample`)?.checked === true;
                    serialized.doubaoResolution = documentRef.getElementById(`${id}-doubao-resolution`)?.value || '720p';
                    serialized.doubaoDuration = documentRef.getElementById(`${id}-doubao-duration`)?.value || '5';
                    serialized.doubaoCameraFixed = documentRef.getElementById(`${id}-doubao-camera-fixed`)?.checked === true;
                    serialized.doubaoGenerateAudio = documentRef.getElementById(`${id}-doubao-generate-audio`)?.checked === true;
                    serialized.doubaoWatermark = documentRef.getElementById(`${id}-doubao-watermark`)?.checked === true;
                    serialized.doubaoSeed = documentRef.getElementById(`${id}-doubao-seed`)?.value || '';
                    serialized.protocolParams = readNodeProtocolParams(id, node);
                    serialized.generationCount = Math.max(1, parseInt(documentRef.getElementById(`${id}-generation-count`)?.value || '1', 10) || 1);
                    serialized.videoId = node.data?.videoId || '';
                    serialized.videoUrl = node.data?.videoUrl || '';
                    serialized.videoStatus = node.data?.videoStatus || '';
                    serialized.videoStatusText = node.data?.videoStatusText || '';
                    serialized.videoCreateHttpStatus = node.data?.videoCreateHttpStatus || '';
                    serialized.videoCreateStatus = node.data?.videoCreateStatus || '';
                    serialized.videoStatusUpdateTime = node.data?.videoStatusUpdateTime || '';
                    serialized.videoEnhancedPrompt = node.data?.videoEnhancedPrompt || '';
                } else {
                    serialized.sysprompt = documentRef.getElementById(`${id}-sysprompt`)?.value || '';
                    serialized.search = documentRef.getElementById(`${id}-search`)?.checked || false;
                    serialized.fixed = documentRef.getElementById(`${id}-fixed`)?.checked || false;
                    serialized.lastResponse = node.lastResponse || '';
                    serialized.lastText = node.data?.text || '';
                    serialized.isSucceeded = node.isSucceeded || false;
                }
            }

            if (node.type === 'ImageSave') {
                serialized.filename = documentRef.getElementById(`${id}-filename`)?.value || 'generated_image';
                if (node.data?.video && typeof node.data.video === 'object') {
                    serialized.video = {
                        id: node.data.video.id || '',
                        url: node.data.video.url || '',
                        status: node.data.video.status || '',
                        prompt: node.data.video.prompt || ''
                    };
                }
            }
            if (node.type === 'ImageMerge') {
                serialized.inputCount = Math.max(1, parseInt(node.data?.inputCount || '1', 10) || 1);
            }
            if (node.type === 'TextMerge') {
                serialized.inputCount = Math.max(1, parseInt(node.data?.inputCount || '1', 10) || 1);
            }
            if (node.type === 'Text') {
                serialized.text = documentRef.getElementById(`${id}-text`)?.value || '';
                if (Array.isArray(node.data?.texts) && node.data.texts.length > 0) {
                    serialized.texts = node.data.texts.slice();
                    serialized.textPreviewIndex = Math.max(0, parseInt(node.textPreviewIndex || '0', 10) || 0);
                }
            }
            if (node.type === 'TextSplit') {
                serialized.text = node.data?.text || '';
                serialized.delimiter = documentRef.getElementById(`${id}-delimiter`)?.value || '';
                const mergeOutputEnabled = documentRef.getElementById(`${id}-merge-output-enabled`)?.checked === true;
                const parsedOutputCount = parseInt(documentRef.getElementById(`${id}-output-count`)?.value ?? node.data?.outputCount ?? '0', 10);
                serialized.outputCount = mergeOutputEnabled
                    ? 0
                    : (Number.isFinite(parsedOutputCount) ? Math.max(0, parsedOutputCount) : 0);
                serialized.removeEmptyLines = documentRef.getElementById(`${id}-remove-empty-lines`)?.checked === true;
                serialized.previewEnabled = documentRef.getElementById(`${id}-preview-enabled`)?.checked !== false;
                serialized.mergeOutputEnabled = mergeOutputEnabled;
                serialized.parts = Array.isArray(node.data?.parts) ? node.data.parts.slice() : [];
            }
            if (node.type === 'CustomParams') {
                serialized.params = Array.from(documentRef.querySelectorAll(`#${id}-params-list [data-param-row]`))
                    .map((row) => ({
                        key: row.querySelector('.custom-param-key')?.value?.trim() || '',
                        value: row.querySelector('.custom-param-value')?.value || ''
                    }))
                    .filter((row) => row.key);
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

            nodes.push(serialized);
        }
        return nodes;
    }

    function buildStatePayload() {
        return {
            canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom },
            nodes: serializeNodes(),
            connections: state.connections.map((connection) => ({
                id: connection.id,
                from: connection.from,
                to: connection.to,
                type: connection.type
            })),
            providers: state.providers,
            models: state.models,
            nodeDefaults: state.nodeDefaults,
            themeId: state.themeId,
            notificationsEnabled: state.notificationsEnabled,
            notificationVolume: state.notificationVolume,
            autoRetry: state.autoRetry,
            maxRetries: state.maxRetries,
            concurrentRequestMode: state.concurrentRequestMode,
            imageAutoResizeEnabled: state.imageAutoResizeEnabled,
            imageSaveUsePromptFilename: state.imageSaveUsePromptFilename === true,
            imageMaxPixels: state.imageMaxPixels,
            connectionLineType: state.connectionLineType,
            toolbarPinned: state.toolbarPinned === true,
            sidebarPinned: state.sidebarPinned === true,
            globalAnimationEnabled: state.globalAnimationEnabled,
            connectionFlowAnimationEnabled: state.globalAnimationEnabled,
            proxy: state.proxy,
            requestTimeoutEnabled: state.requestTimeoutEnabled,
            requestTimeoutSeconds: state.requestTimeoutSeconds,
            autoCheckUpdatesOnLoad: state.autoCheckUpdatesOnLoad !== false,
            historyGridCols: state.historyGridCols
        };
    }

    function buildWorkflowExport(version = '1.3') {
        return {
            canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom },
            nodes: serializeNodes(),
            connections: state.connections.map((connection) => ({
                id: connection.id,
                from: connection.from,
                to: connection.to,
                type: connection.type
            })),
            version
        };
    }

    return {
        serializeNodes,
        buildStatePayload,
        buildWorkflowExport
    };
}
/**
 * 负责节点与连线状态的序列化、反序列化和导出结构拼装。
 */
