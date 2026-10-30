import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';
import { createImagePreviewBatchNavigation } from '../../nodes/image-preview-batch-navigation.js';
import { readImageResizeSettings } from '../../nodes/image-resize-settings.js';
import { readImageSaveFilename } from '../../nodes/image-save-settings.js';
import { projectMissingMediaAssets, renderMissingMediaPlaceholders } from './missing-media-integrity.js';
import { applyImageDisplayResultProjection, applyImageSaveMediaState, resolveImagePreviewInputState } from './image-display-input-state.js';
﻿/**
 * 管理图片导入、预览、保存与自动落盘等媒体节点共用行为。
 */
import {
    createFullscreenImageCropper,
    renderFullscreenCropControls,
    renderFullscreenCropLayer
} from './image-cropper.js';
import {
    createMediaPreviewCache,
    TRANSPARENT_PREVIEW_PIXEL
} from './media-preview-cache.js';
import { createDisplayImageMemoryManager } from './display-image-memory-manager.js';
import { createDisplayImageRenderer } from './display-image-renderer.js';
import {
    clearCanonicalImageOutput,
    getFirstNonEmptyImageList,
    getCanonicalImage,
    getCanonicalImageList,
    normalizeImageList,
    setCanonicalImageOutput
} from '../execution/execution-data-utils.js';
import { mapPreviewPointToImage } from './media-utils.js';
import { getImageDescription, setImageDescription } from '../execution/reference-image-description.js';
import {
    readColorResetConfig as readColorResetNodeConfig,
    resolveWhiteBalanceSampleSelection
} from './color-reset-config.js';
import {
    clearDerivedImagePreview,
    getDerivedImagePreview,
    setDerivedImagePreview
} from '../../nodes/derived-image-preview.js';

// 工具函数模块
import {
    formatBytes,
    formatProgressBytes,
    formatProgressSpeed,
    escapeHtml
} from './utils/format-utils.js';
import {
    isInlineImageData,
    isRemoteImageUrl,
    parseResolutionText
} from './utils/image-validation-utils.js';

export function getVideoPreviewSource(video) {
    const assetKey = String(video?.assetKey || '').trim();
    return assetKey ? `/api/storage/assets/${encodeURIComponent(assetKey)}` : /^\/api\/storage\/assets\//.test(video?.url || '') ? video.url : '';
}

export function getCurrentFullscreenImage(images, currentIndex, fallback = '') {
    return images[currentIndex] || images[0] || fallback;
}
import {
    buildImageSaveFilenameBases,
    buildVideoSaveFilenameBase,
    detectVideoExtensionFromSource
} from './utils/filename-builder.js';
import {
    isNodeRunning as isNodeRunningUtil,
    isTypingIntoField as isTypingIntoFieldUtil,
    hasBlockingImmersiveOverlay as hasBlockingImmersiveOverlayUtil,
    getFocusedNodeId as getFocusedNodeIdUtil,
    isChromeElementExposed as isChromeElementExposedUtil,
    shouldIgnoreChromeOffsetForPreview as shouldIgnoreChromeOffsetForPreviewUtil
} from './utils/ui-state-helpers.js';

// 独立功能模块
import {
    downloadGeneratedVideo as downloadGeneratedVideoUtil,
    blobLooksLikeVideo,
    isLikelyDownloadableVideoUrl as isLikelyDownloadableVideoUrlUtil,
    classifyVideoUrlForLog as classifyVideoUrlForLogUtil,
    buildBackendVideoDownloadUrl
} from './video/video-download.js';
import { createVideoAutoSaveToastManager } from './video/video-auto-save-toast.js';
import { createPreviewIndexManager } from './state/preview-index-manager.js';
import { createThumbnailCacheManager } from './state/thumbnail-cache-manager.js';
import { saveGeneratedMediaToDirectory } from './generated-media-directory-save.js';

export function createMediaControllerApi({
    state,
    pushHistory = () => {},
    getNodeById,
    getImageAsset = async () => null,
    getImageAssetList = async () => [],
    saveImageAsset = async () => false,
    saveWorkflowImportMediaAsset = async () => null,
    saveWorkflowNodeMediaAsset = async () => null,
    saveWorkflowNodeMediaAssets = async () => [],
    getActiveWorkflowId = () => '',
    referenceMediaAsset = async () => false,
    removeMediaReference = async () => false,
    deleteImageAsset,
    processImageResolution,
    resizeImageData,
    processColorResetImage,
    detectOutputFormat,
    estimateDataUrlSize,
    getImageResolution,
    dataURLtoBlob,
    copyImageToClipboard = async () => false,
    showToast,
    addLog,
    scheduleSave,
    onMediaIntegrityChanged = () => {},
    onImageDescriptionChanged = () => {},
    onMissingMediaAction = () => {},
    syncCameraControlNodePreview = () => {},
    syncClonesFromSource = () => {},
    openImagePainter,
    getHistory = async () => [],
    getHistoryMetadata = null,
    getHistoryEntry = null,
    fitNodeToContent = () => {},
    fetchRef = fetch,
    getProxyHeaders = null,
    formatProxyErrorMessage = null,
    documentRef = document,
    windowRef = window,
    canvasContainer = null
}) {
    const PERSISTED_PREVIEW_THUMBNAIL_MAX_LENGTH = 220000;
    const pendingFitNodeIds = new Set();
    const pendingImageImportWrites = new Set();
    let fitRequestFrame = null;
    let imagePreviewBatchNavigation = null;
    const previewSlotReads = new WeakMap();
    const mergePreviewSlots = new WeakMap();

    function queryNodeControl(root, selector) {
        const local = root?.querySelector?.(selector);
        if (local) return local;
        const node = root?.id ? getNodeById(root.id) : null;
        return node && node.el === root ? node.parameterRoot?.querySelector?.(selector) || null : null;
    }

    function queryNodeControls(root, selector) {
        const local = Array.from(root?.querySelectorAll?.(selector) || []);
        const node = root?.id ? getNodeById(root.id) : null;
        const parameters = node && node.el === root ? Array.from(node.parameterRoot?.querySelectorAll?.(selector) || []) : [];
        return [...new Set([...local, ...parameters])];
    }

    function getNodeElement(nodeId, suffix) {
        const root = getNodeById(nodeId)?.el;
        return root ? queryNodeControl(root, `#${nodeId}-${suffix}`) : documentRef.getElementById(`${nodeId}-${suffix}`);
    }

    function getProcessingNodeElement(nodeId, suffix) {
        const node = getNodeById(nodeId);
        if (node?.el) return queryNodeControl(node.el, `#${nodeId}-${suffix}`);
        if (node?.parameterRoot) return node.parameterRoot.querySelector?.(`#${nodeId}-${suffix}`) || null;
        return node ? null : documentRef.getElementById(`${nodeId}-${suffix}`);
    }

    const isBatchPreviewNode = node => node?.type === 'ImagePreview' || node?.type === 'ImageMerge';
    const isSlottedPreviewNode = node => isBatchPreviewNode(node) || node?.type === 'ImageSave';

    function persistProcessingParameters(node, values) {
        node.data = node.data || {};
        Object.assign(node, values);
        Object.assign(node.data, values);
    }

    function canEditProcessingNode(node) {
        return node && getNodeById(node.id) === node && !node.isClone && node.enabled !== false && !isNodeRunning(node.id);
    }

    function markProcessingPreviewStale(node, message) {
        const suffix = node.type === 'ImageResize' ? 'resize-preview' : 'color-preview';
        const preview = getProcessingNodeElement(node.id, suffix);
        const retained = getDerivedImagePreview(node) || node.imageData || node.data?.image
            || node.data?.imagePreviewThumbnail || node.data?.mediaAssetKeys?.length;
        const text = retained ? `${message}，预览未更新` : message;
        if (preview) {
            preview.dataset.processingState = 'stale';
            preview.dataset.processingMessage = text;
        }
        const label = getProcessingNodeElement(node.id, node.type === 'ImageResize' ? 'resize-size-label' : 'white-balance-status');
        if (label) { label.textContent = text; label.dataset.status = 'stale'; }
        if (!retained) {
            if (node.type === 'ImageResize') renderImageResizeEmptyState(node.id, text);
            else renderColorResetEmptyState(node.id, text);
        }
    }

    function getPreviewBatchNavigation() {
        if (!imagePreviewBatchNavigation) imagePreviewBatchNavigation = createImagePreviewBatchNavigation({
            state, documentRef, windowRef, getNodeById, showToast,
            readOriginalAt: async (node, index, assetKey) => {
                if (getNodeById(node.id) !== node) return '';
                if (assetKey.startsWith('media:')) return await getImageAsset(assetKey) || '';
                const missing = (node.data?.mediaIntegrity?.missingItems || []).map(item => Number(item.position));
                if (missing.includes(index)) return '';
                const images = await getStoredImagePreviewListAsync(node);
                if (getNodeById(node.id) !== node) return '';
                const offset = missing.filter(position => position < index).length;
                return images[index - offset] || '';
            },
            createThumbnail: source => previewCache.createDisplayMipmap(source, 96),
            onSelect: async (node, index) => {
                if (getNodeById(node.id) !== node || isNodeRunning(node.id)) return;
                if (node.type === 'ImageMerge' && getNodeMediaAssetKeys(node).length) {
                    await selectMergePreviewSlot(node, index);
                    scheduleSave();
                    return;
                }
                const images = await getStoredImagePreviewListAsync(node);
                if (getNodeById(node.id) !== node || isNodeRunning(node.id)) return;
                node.imagePreviewIndex = Math.max(0, Math.min(Math.max(getStoredImageCount(node), getNodeMediaAssetKeys(node).length) - 1, index));
                node.previewZoom = 1;
                if (node.type === 'ImageSave') renderImageSavePreview(node.id, images);
                else renderImagePreviewImage(node.id, images);
                scheduleSave();
            }
        });
        return imagePreviewBatchNavigation;
    }

    // 初始化预览缓存
    const previewCache = createMediaPreviewCache({
        getImageResolution,
        documentRef,
        windowRef
    });

    // 初始化显示图片渲染器
    const displayImageRenderer = createDisplayImageRenderer({
        documentRef,
        previewCache,
        isInlineImageData,
        normalizeImages: normalizeImageList
    });
    const {
        createPreviewNavButton,
        createPreviewPlaceholder,
        ensureElement,
        removeElements,
        renderDisplayImagePreview,
        renderColorResetPreview,
        renderReusableComparePreview,
        renderReusableMultiImagePreview,
        setImageElementSource,
        updatePlaceholderText,
        updatePreviewPlaceholder
    } = displayImageRenderer;

    // 初始化新的功能模块管理器
    const videoAutoSaveToastManager = createVideoAutoSaveToastManager({
        documentRef,
        windowRef,
        showToast
    });

    const previewIndexManager = createPreviewIndexManager({
        scheduleSave,
        windowRef
    });

    const thumbnailCacheManager = createThumbnailCacheManager({
        previewCache,
        estimateDataUrlSize,
        PERSISTED_PREVIEW_THUMBNAIL_MAX_LENGTH,
        getNodeById,
        scheduleSave
    });

    // 包装工具函数以适配本地调用
    const isNodeRunning = (nodeId) => isNodeRunningUtil(nodeId, state, getNodeById);
    const isTypingIntoField = () => isTypingIntoFieldUtil(documentRef);
    const hasBlockingImmersiveOverlay = () => hasBlockingImmersiveOverlayUtil(documentRef);
    const getFocusedNodeId = () => getFocusedNodeIdUtil(state);
    const isChromeElementExposed = (element) => isChromeElementExposedUtil(element, documentRef, windowRef);
    const shouldIgnoreChromeOffsetForPreview = () => shouldIgnoreChromeOffsetForPreviewUtil(documentRef, windowRef);
    const isLikelyDownloadableVideoUrl = (url) => isLikelyDownloadableVideoUrlUtil(url, windowRef);
    const classifyVideoUrlForLog = (url) => classifyVideoUrlForLogUtil(url, windowRef);

    // 包装文件名生成函数
    const buildImageSaveFilenameBases_local = (nodeId, images, fallbackPrefix, options = {}) =>
        buildImageSaveFilenameBases(nodeId, images, fallbackPrefix, state, getNodeById, options);
    const buildVideoSaveFilenameBase_local = (nodeId, video, fallbackPrefix, options = {}) =>
        buildVideoSaveFilenameBase(nodeId, video, fallbackPrefix, state, options);

    // 包装视频下载函数
    const downloadGeneratedVideo = (videoUrl, options = {}) =>
        downloadGeneratedVideoUtil(videoUrl, options, { fetchRef, formatProxyErrorMessage, addLog, windowRef });

    // 包装预览索引管理器方法
    const getImagePreviewIndex = (node, images) => previewIndexManager.getImagePreviewIndex(node, images);
    const getImageSavePreviewIndex = (node, images) => previewIndexManager.getImageSavePreviewIndex(node, images);
    const schedulePreviewIndexSave = (nodeId) => previewIndexManager.schedulePreviewIndexSave(nodeId);

    // 包装缩略图缓存管理器方法
    const cacheNodePreviewThumbnail = (nodeOrId, source) => thumbnailCacheManager.cacheNodePreviewThumbnail(nodeOrId, source);
    const clearNodePreviewThumbnail = (nodeOrId) => thumbnailCacheManager.clearNodePreviewThumbnail(nodeOrId);
    const choosePersistedPreviewThumbnail = (source, thumbnail) => thumbnailCacheManager.choosePersistedPreviewThumbnail(source, thumbnail);

    // 包装 Toast 管理器方法
    const ensureVideoAutoSaveToast = (nodeId, subtitle) => videoAutoSaveToastManager.ensure(nodeId, subtitle);
    const updateVideoAutoSaveToast = (nodeId, state) => videoAutoSaveToastManager.update(nodeId, state);
    const completeVideoAutoSaveToast = (nodeId, message) => videoAutoSaveToastManager.complete(nodeId, message);
    const failVideoAutoSaveToast = (nodeId, message) => videoAutoSaveToastManager.fail(nodeId, message);
    const getVideoAutoSaveToastRecord = (nodeId) => videoAutoSaveToastManager.get(nodeId);
    const removeVideoAutoSaveToast = (nodeId) => videoAutoSaveToastManager.remove(nodeId);

    const displayImageMemoryManager = createDisplayImageMemoryManager({
        state,
        getNodeById,
        getImageAsset,
        getImageAssetList,
        deleteImageAsset,
        normalizeImageList,
        isInlineImageData,
        getNodeOutputImageListAsync,
        getImagePreviewIndex,
        renderImagePreviewImage,
        renderImageSavePreview,
        renderVideoSavePreview,
        renderImageImportUploadState,
        renderImageResizeResult,
        renderColorResetResult,
        renderImageComparePreview,
        restoreImageMergePreview: async node => {
            const slot = await readCurrentMergePreview(node);
            if (!slot) return false;
            renderImagePreviewImage(node.id, []);
            return true;
        },
        releaseImageMergePreview: node => {
            mergePreviewSlots.delete(node);
            imagePreviewBatchNavigation?.destroy(node);
        },
        showResolutionBadge,
        ensureElement,
        removeElements,
        createPreviewPlaceholder,
        updatePreviewPlaceholder,
        createPreviewNavButton,
        documentRef,
        windowRef,
        canvasContainer,
        getActiveWorkflowId,
        showToast,
        onMediaIntegrityChanged,
        onMissingMediaAction
    });

    function hasIncomingImageConnection(nodeId) {
        return state.connections.some((conn) => (
            conn.to.nodeId === nodeId
            && (conn.to.port === 'image' || conn.to.port === 'imageA' || conn.to.port === 'imageB')
        ));
    }

    async function clearRecoverableDisplayAsset() { return false; }

    function markNodeImageAssetPending(node, assetKey, imageCount = 1) {
        if (!node) return;
        node.data = node.data || {};
        if (assetKey) node.data.imageAssetKey = assetKey;
        node.data.imageCount = Math.max(1, parseInt(imageCount, 10) || 1);
        delete node.data.imageAssetReady;
        delete node.data.imageMemoryReleased;
    }

    function markNodeImageAssetReady(node, assetKey, imageCount = 1) {
        if (!node) return;
        markNodeImageAssetPending(node, assetKey, imageCount);
        node.data.imageAssetReady = true;
        node.data.imageHydratedAt = Date.now();
    }

    function markImageImportAssetReady(node, assetKey, imageCount = 1) {
        if (!node) return;
        node.data = node.data || {};
        node.data.imageCount = Math.max(1, parseInt(imageCount, 10) || 1);
        node.data.imageAssetReady = true;
        node.data.imageHydratedAt = Date.now();
        delete node.data.imageMemoryReleased;
        if (typeof assetKey === 'string' && assetKey) {
            node.imageImportAssetKey = assetKey;
            node.data.imageImportAssetKey = assetKey;
            if (assetKey.startsWith('media:')) node.data.mediaAssetKeys = [assetKey];
            else delete node.data.mediaAssetKeys;
            delete node.data.imageAssetKey;
        }
    }

    function clearStaleImageImportAssetState(node) {
        if (!node) return;
        node.data = node.data || {};
        delete node.imageImportAssetKey;
        delete node.data.imageImportAssetKey;
        delete node.data.mediaAssetKeys;
        delete node.data.imageAssetKey;
        delete node.data.imageAssetReady;
        delete node.data.imageMemoryReleased;
    }

    function persistImageImportData(nodeId, node, imageData) {
        const writeToken = (parseInt(node.imageImportWriteToken || '0', 10) || 0) + 1;
        node.imageImportWriteToken = writeToken;
        clearStaleImageImportAssetState(node);

        const write = (async () => {
            const mediaAsset = await saveWorkflowImportMediaAsset(imageData, getActiveWorkflowId(), nodeId);
            if (state.nodes.get(nodeId) !== node || node.imageImportWriteToken !== writeToken) {
                if (mediaAsset?.mediaTemporaryOwnerId && mediaAsset?.asset_key) {
                    await removeMediaReference('workflow-operation', mediaAsset.mediaTemporaryOwnerId, mediaAsset.asset_key);
                }
                return false;
            }
            rememberWorkflowMediaOperation(node, [mediaAsset]);
            const assetKey = mediaAsset?.asset_key || '';
            if (!assetKey) return false;
            markImageImportAssetReady(node, assetKey, 1);
            await syncImageImportSourceState(nodeId, { refreshDependents: true });
            scheduleDisplayImageMemorySweep({ delayMs: displayImageMemoryManager.releaseGraceMs });
            scheduleSave();
            return true;
        })();

        pendingImageImportWrites.add(write);
        const clearPendingWrite = () => {
            pendingImageImportWrites.delete(write);
        };
        void write.then(clearPendingWrite, clearPendingWrite);
        return write;
    }

    async function waitForPendingImageImports() {
        while (pendingImageImportWrites.size > 0) {
            await Promise.allSettled(Array.from(pendingImageImportWrites));
        }
    }

    function requestNodeFit(nodeId) {
        if (!nodeId) return;
        pendingFitNodeIds.add(nodeId);
        if (fitRequestFrame) return;
        fitRequestFrame = windowRef.requestAnimationFrame(() => {
            fitRequestFrame = null;
            const nodeIds = Array.from(pendingFitNodeIds);
            pendingFitNodeIds.clear();
            nodeIds.forEach((queuedNodeId) => {
                if (state.resizing?.nodeId === queuedNodeId) return;
                fitNodeToContent(queuedNodeId);
            });
        });
    }

    function getNodePreviewSourceData(node) {
        if (!node || node.enabled === false) return null;
        if (node.type === 'ImageImport') {
            return node.importMode === 'url'
                ? (node.imageUrl || null)
                : (node.imageData || null);
        }
        if (node.type === 'ImageCompare') {
            return node.data?.image || node.compareImageB || node.imageData || null;
        }
        return getCanonicalImage(node) || getDerivedImagePreview(node) || null;
    }

    function setNodePreviewThumbnailValue(node, source, thumbnail = '') {
        if (!node?.data) return '';
        const nextThumbnail = choosePersistedPreviewThumbnail(source, thumbnail);
        if (nextThumbnail) {
            node.data.imagePreviewThumbnail = nextThumbnail;
        } else {
            delete node.data.imagePreviewThumbnail;
        }
        return nextThumbnail;
    }



    async function getAvailableFileHandle(directoryHandle, baseName, extension = '.png') {
        let counter = 0;
        while (counter < 1000) {
            const suffix = counter === 0 ? '' : `_${String(counter + 1).padStart(2, '0')}`;
            const filename = `${baseName}${suffix}${extension}`;
            try {
                await directoryHandle.getFileHandle(filename, { create: false });
                counter += 1;
            } catch (error) {
                if (error?.name !== 'NotFoundError') throw error;
                const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
                return { fileHandle, filename };
            }
        }
        throw new Error('无法生成不重复的文件名');
    }

    function getStoredImageCount(node) {
        return displayImageMemoryManager.getStoredImageCount(node);
    }

    async function restoreStoredImageList(node) {
        if (node?.type === 'ImageMerge') {
            const images = getCanonicalImageList(node), assets = getNodeMediaAssetKeys(node);
            if (assets.length > images.length + (node.data?.mediaIntegrity?.missingItems?.length || 0)) {
                const items = await readPreviewSlots(node, assets);
                return items ? items.map(item => item.value).filter(Boolean) : [];
            }
            return images;
        }
        if (node?.type === 'ImageImport' && node.importMode !== 'url') {
            const assetKey = node.imageImportAssetKey || node.data?.imageImportAssetKey || getNodeMediaAssetKeys(node)[0];
            if (assetKey) {
                const image = await getImageAsset(assetKey);
                const currentKey = node.imageImportAssetKey || node.data?.imageImportAssetKey || getNodeMediaAssetKeys(node)[0];
                if (getNodeById(node.id) !== node || node.importMode === 'url' || currentKey !== assetKey) return [];
                return image ? [image] : getFirstNonEmptyImageList(node.imageData, node.imageDataList, node.data?.images, node.data?.image)
                    .filter(value => value !== node.imageUrl);
            }
        }
        return displayImageMemoryManager.restoreStoredImageList(node);
    }

    function isDisplayImageNode(node) {
        return displayImageMemoryManager.isDisplayImageNode(node);
    }

    function isManagedImageNode(node) {
        return displayImageMemoryManager.isManagedImageNode(node);
    }

    function saveDisplayImageAssetSoon(nodeId, images) {
        displayImageMemoryManager.saveAssetSoon(nodeId, images);
    }

    function updateResolutionBadgeSoon(nodeId, dataUrl) {
        displayImageMemoryManager.updateResolutionBadgeSoon(nodeId, dataUrl);
    }

    function clearDisplayImageAssetState(nodeId) {
        displayImageMemoryManager.clearAssetState(nodeId);
    }

    function scheduleDisplayImageMemorySweep(options = {}) {
        displayImageMemoryManager.scheduleSweep(options);
    }

    function scheduleMediaMemorySweep(options = {}) {
        scheduleDisplayImageMemorySweep(options);
    }

    function sweepDisplayImageMemory(options = {}) {
        return displayImageMemoryManager.sweep(options);
    }

    function releaseNodeImageData(nodeId, options = {}) {
        return displayImageMemoryManager.releaseNodeImageData(nodeId, options);
    }

    function getStoredImageSaveList(node) {
        return getCanonicalImageList(node, { includeResizePreview: false });
    }

    function getStoredSaveVideo(node) {
        const videos = getStoredSaveVideos(node);
        const index = Math.max(0, Math.min(videos.length - 1, node?.videoPreviewIndex ?? node?.data?.videoPreviewIndex ?? videos.length - 1));
        return videos[index] || null;
    }

    function getNodeMediaAssetKeys(node) {
        const keys = Array.isArray(node?.data?.mediaAssetKeys)
            ? node.data.mediaAssetKeys
            : [node?.data?.imageAssetKey, node?.imageImportAssetKey, node?.data?.imageImportAssetKey];
        return keys.filter((key) => typeof key === 'string' && key.startsWith('media:'));
    }

    function getForwardedMediaAssetKeys(nodeId, ports = ['image']) {
        return state.connections
            .filter((connection) => connection?.to?.nodeId === nodeId && ports.includes(connection.to.port))
            .flatMap((connection) => getNodeMediaAssetKeys(getNodeById(connection.from?.nodeId)));
    }

    async function syncForwardedMediaAssetKeys(node, keys) {
        const workflowId = getActiveWorkflowId();
        if (!node?.id || !workflowId) return false;
        const previousKeys = getNodeMediaAssetKeys(node);
        if (keys.length === 0) {
            await releaseForwardedMediaAssetKeys(node);
            return false;
        }
        const addedKeys = [...new Set(keys.filter((key) => !previousKeys.includes(key)))];
        for (const key of addedKeys) {
            if (await referenceMediaAsset('workflow-node', `${workflowId}:${node.id}`, key)) continue;
            await Promise.all(addedKeys
                .slice(0, addedKeys.indexOf(key))
                .map((addedKey) => removeMediaReference('workflow-node', `${workflowId}:${node.id}`, addedKey)));
            await releaseForwardedMediaAssetKeys(node);
            return false;
        }
        const removedKeys = [...new Set(previousKeys.filter((key) => !keys.includes(key)))];
        if (removedKeys.length > 0) {
            await Promise.all(removedKeys.map((key) => (
                removeMediaReference('workflow-node', `${workflowId}:${node.id}`, key)
            )));
        }
        node.data = node.data || {};
        node.data.mediaAssetKeys = keys.slice();
        node.data.imageAssetKey = keys[0];
        node.data.imageCount = keys.length;
        node.data.imageAssetReady = true;
        node.data.imageHydratedAt = Date.now();
        return true;
    }

    async function releaseForwardedMediaAssetKeys(node) {
        const workflowId = getActiveWorkflowId();
        const keys = getNodeMediaAssetKeys(node);
        if (!node?.id || !workflowId || keys.length === 0) return;
        await Promise.all(keys.map((key) => (
            removeMediaReference('workflow-node', `${workflowId}:${node.id}`, key)
        )));
        delete node.data.mediaAssetKeys;
    }

    function getStoredSaveVideos(node) {
        const videos = Array.isArray(node?.data?.videos) && node.data.videos.length > 0
            ? node.data.videos
            : [node?.data?.video];
        return videos.filter((video) => video && typeof video === 'object' && (video.assetKey || typeof video.url === 'string' && video.url.trim()));
    }

    function getStoredImagePreviewList(node) {
        return getCanonicalImageList(node, { includeResizePreview: false });
    }

    async function getStoredImageSaveListAsync(node) {
        return restoreStoredImageList(node);
    }

    async function getStoredImagePreviewListAsync(node) {
        return restoreStoredImageList(node);
    }

    function getGeneratedImageList(node) {
        return getCanonicalImageList(node, { includeResizePreview: false });
    }

    function getNodeOutputImageList(node) {
        return getCanonicalImageList(node);
    }

    async function getNodeOutputImageListAsync(node) {
        if (!node) return [];
        if (node.type === 'ImageMerge') return restoreStoredImageList(node);
        if (isManagedImageNode(node)) {
            return restoreStoredImageList(node);
        }
        return getNodeOutputImageList(node);
    }

    function getPreviewLayoutSignature(images, { compareImageA = null, compareImageB = null } = {}) {
        const imageList = normalizeImageList(images);
        return JSON.stringify({
            count: imageList.length,
            multiple: imageList.length > 1,
            hasImage: imageList.length > 0,
            hasCompareA: Boolean(compareImageA),
            hasCompareB: Boolean(compareImageB)
        });
    }

    function shouldRequestFit(node, nextSignature, key = 'previewLayoutSignature') {
        if (!node) return true;
        const prevSignature = node[key] || '';
        node[key] = nextSignature;
        return prevSignature !== nextSignature;
    }

    function setImagePreviewInputState(node, inputState) {
        if (!node || node.type !== 'ImagePreview') return;
        node.previewInputState = inputState;
        if (node.el?.dataset) node.el.dataset.previewInputState = inputState;
        const preview = getNodeElement(node.id, 'preview');
        if (!preview) return;
        let status = node.el?.querySelector?.('.image-preview-input-status');
        if (!status) {
            status = documentRef.createElement('div');
            status.className = 'image-preview-input-status';
            status.setAttribute('role', 'status');
            preview.after(status);
        }
        status.hidden = inputState === 'current';
        status.textContent = inputState === 'stale' ? '未更新 · 当前无输入' : inputState === 'empty' ? '当前无输入' : '';
    }

    async function readPreviewSlots(node, assets) {
        const signature = assets.join('|');
        const isCurrent = () => getNodeById(node.id) === node && getNodeMediaAssetKeys(node).join('|') === signature;
        const shadow = { id: node.id, data: { mediaIntegrity: node.data?.mediaIntegrity } };
        const items = await projectMissingMediaAssets({ workflowId: getActiveWorkflowId(), node: shadow, assetKeys: assets,
            loadAsset: key => getImageAsset(key),
            notify: (...args) => { if (isCurrent()) showToast(...args); } });
        if (!isCurrent()) return null;
        node.data = node.data || {};
        if (JSON.stringify(node.data.mediaIntegrity) !== JSON.stringify(shadow.data.mediaIntegrity)) {
            if (shadow.data.mediaIntegrity) node.data.mediaIntegrity = shadow.data.mediaIntegrity;
            else delete node.data.mediaIntegrity;
            onMediaIntegrityChanged();
        }
        return items;
    }

    async function readCurrentMergePreview(node) {
        const assets = getNodeMediaAssetKeys(node), signature = assets.join('|');
        const index = Math.max(0, Math.min(assets.length - 1, node.imagePreviewIndex || 0));
        const cached = mergePreviewSlots.get(node);
        if (cached?.signature === signature && cached.index === index) return cached.promise;
        if (!assets[index]) return null;
        const workflowId = getActiveWorkflowId();
        const slot = { signature, index, image: '', complete: false };
        mergePreviewSlots.set(node, slot);
        const current = () => mergePreviewSlots.get(node) === slot && getNodeById(node.id) === node
            && getActiveWorkflowId() === workflowId && getNodeMediaAssetKeys(node).join('|') === signature;
        slot.promise = (async () => {
            const image = await getImageAsset(assets[index]);
            if (!current()) return null;
            slot.image = image || ''; slot.complete = true;
            const missing = (node.data?.mediaIntegrity?.missingItems || []).filter(item => Number(item.position) !== index);
            if (!image) missing.push({ position: index, assetKey: assets[index], redactedSource: assets[index].length > 18 ? `${assets[index].slice(0, 12)}…${assets[index].slice(-6)}` : assets[index],
                workflowId, nodeId: node.id, ownerType: 'workflow-node', ownerId: `${workflowId}:${node.id}`, mediaType: 'image' });
            const previous = JSON.stringify(node.data?.mediaIntegrity);
            if (missing.length) node.data.mediaIntegrity = { state: 'missing', mediaType: 'image', ownerType: 'workflow-node', itemCount: assets.length, missingItems: missing.sort((a, b) => a.position - b.position) };
            else delete node.data.mediaIntegrity;
            if (previous !== JSON.stringify(node.data.mediaIntegrity)) onMediaIntegrityChanged();
            return slot;
        })().finally(() => { if (mergePreviewSlots.get(node) === slot && !slot.complete) mergePreviewSlots.delete(node); });
        return slot.promise;
    }

    async function selectMergePreviewSlot(node, index) {
        if (getNodeById(node.id) !== node || isNodeRunning(node.id)) return;
        node.imagePreviewIndex = Math.max(0, Math.min(getNodeMediaAssetKeys(node).length - 1, index));
        node.previewZoom = 1;
        const slot = await readCurrentMergePreview(node);
        if (!slot || getNodeById(node.id) !== node || isNodeRunning(node.id)) return;
        delete node.data.imageMemoryReleased;
        renderImagePreviewImage(node.id, getCanonicalImageList(node));
    }

    function renderImagePreviewImage(nodeId, images, emptyMessage = '无输入图片') {
        const node = getNodeById(nodeId);
        const previewContainer = getNodeElement(nodeId, node?.type === 'ImageMerge' ? 'merge-preview' : 'preview');
        if (node?.type === 'ImageGenerate') return;
        if (!previewContainer) return;
        previewContainer.querySelector('.image-preview-batch-navigation')?.remove();

        const assets = isBatchPreviewNode(node) ? getNodeMediaAssetKeys(node) : [];
        if (node.type === 'ImageMerge' && assets.length > normalizeImageList(images).length + (node.data?.mediaIntegrity?.missingItems?.length || 0)) {
            const index = Math.max(0, Math.min(assets.length - 1, node.imagePreviewIndex || 0));
            node.imagePreviewIndex = index;
            const cached = mergePreviewSlots.get(node);
            const slot = cached?.signature === assets.join('|') && cached.index === index ? cached : null;
            if (!slot && !node.data.imageMemoryReleased) {
                void readCurrentMergePreview(node).then(loaded => { if (loaded) renderImagePreviewImage(nodeId, []); }).catch(error => console.warn('Restore Merge preview failed:', error));
            } else if (!slot) scheduleDisplayImageMemorySweep();
            renderReusableMultiImagePreview(previewContainer, slot?.image || '', index, assets.length, {
                altPrefix: '预览', placeholderClass: 'preview-placeholder', cursor: 'pointer',
                emptyMessage: slot?.complete ? '当前原图缺失，引用位置已保留' : node.data.imageMemoryReleased ? '已释放内存，移入视野或点击恢复预览' : '载入当前预览…'
            });
            for (const direction of [-1, 1]) if (assets.length > 1) ensureElement(previewContainer, direction < 0 ? '.image-save-preview-prev' : '.image-save-preview-next', () => createPreviewNavButton(direction));
            getPreviewBatchNavigation().render(node, previewContainer);
            renderMissingMediaPlaceholders(node, previewContainer, documentRef, onMissingMediaAction);
            setImageMergeInputState(node, node.data.mediaIntegrity?.missingItems?.length ? 'stale' : node.mergeInputState || 'current', node.data.mediaIntegrity?.missingItems?.length ? '来源原图缺失，缺失位置已保留，预览未更新' : node.mergeMessage || '');
            if (slot?.image) void showResolutionBadge(nodeId, slot.image);
            return;
        }
        const hasUnknownPositions = assets.length > normalizeImageList(images).length
            && !node.data?.mediaIntegrity?.missingItems?.length;
        if (hasUnknownPositions && !previewSlotReads.has(node)) {
            const read = readPreviewSlots(node, assets);
            previewSlotReads.set(node, read);
            void read.then(items => {
                if (previewSlotReads.get(node) !== read) return;
                previewSlotReads.delete(node);
                if (!items) return;
                if (node.type === 'ImageMerge' && items.some(item => item.missing)) {
                    setImageMergeInputState(node, 'stale', '来源原图缺失，缺失位置已保留，预览未更新');
                }
                renderImagePreviewImage(nodeId, items.map(item => item.value).filter(Boolean), emptyMessage);
            }).catch(() => { if (previewSlotReads.get(node) === read) previewSlotReads.delete(node); });
        }

        const rendered = renderDisplayImagePreview(previewContainer, node, hasUnknownPositions ? [] : images, {
            totalCount: getStoredImageCount(node),
            altPrefix: '预览',
            placeholderClass: 'preview-placeholder',
            emptyMessage,
            cursor: 'pointer',
            placeholderWithIcon: true
        });
        if (node?.type === 'ImagePreview') {
            const image = previewContainer.querySelector('img');
            if (image) image.style.transform = `scale(${node.previewZoom || 1})`;
        }
        setImagePreviewInputState(node, node?.previewInputState || (normalizeImageList(images).length ? 'current' : 'empty'));
        if (node?.type === 'ImageMerge') setImageMergeInputState(node, node.mergeInputState || (rendered.totalCount ? 'current' : 'empty'), node.mergeMessage || '');
        if (isBatchPreviewNode(node) && node.el) {
            const batchNavigation = getPreviewBatchNavigation();
            batchNavigation.render(node, previewContainer);
            if (!node.imagePreviewBatchCleanupBound) {
                node.imagePreviewBatchCleanupBound = true;
                (node.el._cleanupFns ||= []).push(() => batchNavigation.destroy(node));
            }
        }
        void showResolutionBadge(nodeId, rendered.image);
        if (node?.type === 'ImageGenerate') {
            if (rendered.image) void cacheNodePreviewThumbnail(node, rendered.image);
            else clearNodePreviewThumbnail(node);
        }
    }

    function getSavePreviewElements(nodeId) {
        const node = getNodeById(nodeId), container = getProcessingNodeElement(nodeId, 'save-preview');
        if (!container?.querySelector) return null;
        let image = container.querySelector('.image-save-image-pane'), video = container.querySelector('.image-save-video-pane');
        if (!image || !video) {
            if (!image) { image = documentRef.createElement('div'); image.className = 'image-save-image-pane'; }
            if (!video) { video = documentRef.createElement('div'); video.className = 'image-save-video-pane'; }
            for (const child of Array.from(container.children || [])) {
                if (child === image || child === video || child.classList?.contains('image-save-preview-tools')) continue;
                (child.tagName === 'VIDEO' ? video : image).appendChild(child);
            }
            if (image.parentNode !== container) container.append(image);
            if (video.parentNode !== container) container.append(video);
        }
        let tools = container.querySelector('.image-save-preview-tools') || node?.parameterRoot?.querySelector('.image-save-preview-tools');
        if (!tools) {
            tools = documentRef.createElement('div'); tools.className = 'image-save-preview-tools';
            for (const mode of ['image', 'video']) {
                const button = documentRef.createElement('button'); button.type = 'button'; button.dataset.savePreviewMode = mode;
                button.dataset.nodeReadAction = 'true';
                button.addEventListener('click', event => {
                    event.stopPropagation();
                    if (getNodeById(nodeId) !== node) return;
                    persistProcessingParameters(node, { savePreviewMode: mode });
                    renderImageSavePreview(nodeId, getStoredImageSaveList(node)); scheduleSave();
                });
                tools.append(button);
            }
            const select = documentRef.createElement('select'); select.dataset.saveVideoIndex = ''; select.dataset.nodeReadAction = 'true';
            select.setAttribute('aria-label', '选择保存节点的视频');
            select.addEventListener('change', event => {
                event.stopPropagation();
                if (getNodeById(nodeId) !== node) return;
                persistProcessingParameters(node, { videoPreviewIndex: Number(select.value) });
                renderVideoSavePreview(nodeId, getStoredSaveVideo(node)); scheduleSave();
            });
            tools.addEventListener('mousedown', event => event.stopPropagation());
            tools.addEventListener('click', event => event.stopPropagation());
            tools.append(select); (node?.parameterRoot || container).append(tools);
        }
        return { container, image, video, tools };
    }

    function updateSavePreviewMode(node, elements) {
        if (!elements) return;
        const videos = getStoredSaveVideos(node), imageCount = Math.max(getStoredImageCount(node), getNodeMediaAssetKeys(node).length);
        let mode = node.savePreviewMode ?? node.data?.savePreviewMode ?? (videos.length ? 'video' : 'image');
        if (mode === 'video' && !videos.length) mode = 'image';
        if (mode === 'image' && !imageCount && videos.length) mode = 'video';
        const modeChanged = elements.container.dataset.saveMode !== mode;
        elements.container.dataset.saveMode = mode;
        elements.image.hidden = mode !== 'image'; elements.video.hidden = mode !== 'video';
        if (modeChanged) requestNodeFit(node.id);
        for (const button of elements.tools.querySelectorAll('[data-save-preview-mode]')) {
            const count = button.dataset.savePreviewMode === 'image' ? imageCount : videos.length;
            button.textContent = `${button.dataset.savePreviewMode === 'image' ? '图片' : '视频'} ${count}`;
            button.hidden = !(imageCount > 0 && videos.length > 0);
            button.disabled = !count; button.setAttribute('aria-pressed', String(button.dataset.savePreviewMode === mode));
        }
        elements.tools.hidden = !(imageCount > 0 && videos.length > 0) && !(mode === 'video' && videos.length > 1);
        const select = elements.tools.querySelector('[data-save-video-index]');
        if (select) {
            const signature = JSON.stringify(videos.map(video => [video.id, video.assetKey, video.url]));
            if (select.dataset.signature !== signature) {
                select.replaceChildren();
                videos.forEach((video, index) => { const option = documentRef.createElement('option'); option.value = String(index); option.textContent = `${index + 1}/${videos.length}${video.id ? ` · ${video.id}` : ''}`; select.append(option); });
                select.dataset.signature = signature;
            }
            select.value = String(Math.max(0, Math.min(videos.length - 1, node.videoPreviewIndex ?? node.data?.videoPreviewIndex ?? videos.length - 1)));
            select.hidden = mode !== 'video' || videos.length <= 1;
        }
    }

    function renderImageSavePreview(nodeId, images, emptyMessage = '无输入图片') {
        const node = getNodeById(nodeId), elements = getSavePreviewElements(nodeId);
        if (!node || !elements) return;
        const assets = getNodeMediaAssetKeys(node), unknown = assets.length > normalizeImageList(images).length && !node.data?.mediaIntegrity?.missingItems?.length;
        if (unknown && !previewSlotReads.has(node)) {
            const read = readPreviewSlots(node, assets); previewSlotReads.set(node, read);
            void read.then(items => {
                if (previewSlotReads.get(node) !== read) return;
                previewSlotReads.delete(node);
                if (items) renderImageSavePreview(nodeId, items.map(item => item.value).filter(Boolean), emptyMessage);
            }).catch(() => { if (previewSlotReads.get(node) === read) previewSlotReads.delete(node); });
        }
        const rendered = renderDisplayImagePreview(elements.image, node, unknown ? [] : images, { totalCount: Math.max(getStoredImageCount(node), assets.length), altPrefix: '待保存', placeholderClass: 'save-preview-placeholder', emptyMessage: node.data?.mediaIntegrity?.missingItems?.some(item => item.position === node.imagePreviewIndex) ? '当前原图缺失，引用位置已保留' : emptyMessage, placeholderWithIcon: false });
        getPreviewBatchNavigation().render(node, elements.image);
        renderVideoSavePreview(nodeId, getStoredSaveVideo(node));
        updateSavePreviewMode(node, elements);
        void showResolutionBadge(nodeId, rendered.image);
    }

    function renderVideoSavePreview(nodeId, video, emptyMessage = '本地视频缓存缺失；请确认后从服务器拉取') {
        const node = getNodeById(nodeId), elements = getSavePreviewElements(nodeId);
        if (!node || !elements) return;
        video = getStoredSaveVideo(node) || video;
        const source = getVideoPreviewSource(video), pane = elements.video;
        let player = pane.querySelector('video');
        if (source) {
            if (!player) { player = documentRef.createElement('video'); player.className = 'save-preview-video'; player.controls = true; player.preload = 'metadata'; player.playsInline = true; pane.append(player); }
            if (player.getAttribute('src') !== source) player.src = source;
            player.hidden = false; player.title = video?.status || video?.id || '可保存视频文件';
            pane.querySelector('.save-preview-placeholder')?.remove();
            delete node.data.videoPreviewReleased;
        } else {
            if (player) { if (player.getAttribute('src')) { player.pause?.(); player.removeAttribute('src'); } player.hidden = true; }
            const placeholder = ensureElement(pane, '.save-preview-placeholder', () => createPreviewPlaceholder('save-preview-placeholder', video ? emptyMessage : '无输入视频', { withIcon: false }));
            updatePlaceholderText(placeholder, video ? emptyMessage : '无输入视频');
        }
        updateSavePreviewMode(node, elements);
    }

    function getCurrentImageSavePreviewImage(node) {
        const images = getPreviewSlotImages(node, getStoredImageSaveList(node));
        if (images.length === 0) return null;
        return images[getImageSavePreviewIndex(node, images)] || null;
    }

    function getPreviewSlotImages(node, images) {
        if (!isSlottedPreviewNode(node)) return images;
        const count = Math.max(images.length, getStoredImageCount(node), getNodeMediaAssetKeys(node).length);
        const missing = new Set((node.data?.mediaIntegrity?.missingItems || []).map(item => Number(item.position)));
        if (count <= images.length || !missing.size) return images;
        let present = 0;
        return Array.from({ length: count }, (_, index) => missing.has(index) ? '' : images[present++] || '');
    }

    function getCurrentImagePreviewImage(node) {
        const images = getPreviewSlotImages(node, getStoredImagePreviewList(node));
        if (images.length === 0) return null;
        return images[getImagePreviewIndex(node, images)] || null;
    }

    async function getNodeFullscreenImageContext(nodeId, fallbackSrc = '') {
        const node = getNodeById(nodeId);
        const requestedIndex = node?.imagePreviewIndex;
        const images = await restoreStoredImageList(node);
        const normalizedFallback = typeof fallbackSrc === 'string' ? fallbackSrc.trim() : '';
        let imageList = images.length > 0
            ? getPreviewSlotImages(node, images)
            : (normalizedFallback ? [normalizedFallback] : []);
        const assets = isSlottedPreviewNode(node) ? getNodeMediaAssetKeys(node) : [];
        if (assets.length > images.length && !node.data?.mediaIntegrity?.missingItems?.length) {
            // A compacted list has no reliable position map. Explicit original
            // viewing may resolve the existing local keys, never a substitute.
            const items = await readPreviewSlots(node, assets);
            if (!items) return { node: null, images: [], index: 0, cancelled: true };
            imageList = items.map(item => item.value || '');
        }
        if (isSlottedPreviewNode(node) && Number.isFinite(requestedIndex)) node.imagePreviewIndex = requestedIndex;
        const currentIndex = node?.type === 'ImageSave'
            ? getImageSavePreviewIndex(node, imageList)
            : getImagePreviewIndex(node, imageList);
        return {
            node,
            images: imageList,
            index: imageList.length > 0 ? Math.max(0, Math.min(imageList.length - 1, currentIndex)) : 0
        };
    }

    async function openStoredImageNodeFullscreen(nodeId, fallbackSrc = '') {
        const context = await getNodeFullscreenImageContext(nodeId, fallbackSrc);
        if (!Array.isArray(context.images) || context.images.length === 0) {
            return false;
        }
        if (isBatchPreviewNode(context.node) || context.node?.type === 'ImageGenerate') {
            renderImagePreviewImage(nodeId, context.images);
        } else if (context.node?.type === 'ImageSave') {
            renderImageSavePreview(nodeId, context.images);
        } else if (context.node?.type === 'ImageResize') {
            const image = context.images[context.index] || context.images[0];
            renderImageResizeResult(nodeId, {
                ...(context.node.resizePreviewMeta || {}),
                dataUrl: image,
                outputWidth: context.node.outputWidth || context.node.resizePreviewMeta?.outputWidth || 0,
                outputHeight: context.node.outputHeight || context.node.resizePreviewMeta?.outputHeight || 0,
                outputQuality: context.node.outputQuality || context.node.resizePreviewMeta?.outputQuality || null,
                estimatedBytes: context.node.estimatedBytes || context.node.resizePreviewMeta?.estimatedBytes || estimateDataUrlSize(image)
            });
        } else if (context.node?.type === 'ImageImport') {
            renderImageImportUploadState(nodeId, context.images[0]);
        } else if (context.node?.type === 'ImageCompare') {
            renderImageComparePreview(
                nodeId,
                context.node.compareImageA || context.node.data?.compareImageA || null,
                context.images[context.index] || context.images[0]
            );
        }
        const currentImage = isSlottedPreviewNode(context.node) ? context.images[context.index] : context.images[context.index] || context.images[0];
        if (!currentImage) {
            return false;
        }
        await openFullscreenPreview(currentImage, nodeId);
        return true;
    }

    function bindPreviewKeyboardNavigation(container, getImages, getIndex, onChange, { preserveSlots = false } = {}) {
        if (!container || container.dataset.previewKeyboardBound === '1') return;
        container.dataset.previewKeyboardBound = '1';
        container.tabIndex = 0;

        const handleStep = (delta, event) => {
            event.preventDefault();
            event.stopPropagation();
            Promise.resolve(getImages()).then((value) => {
                const images = preserveSlots && Array.isArray(value) ? value : normalizeImageList(value);
                if (images.length <= 1) return;
                const currentIndex = Math.max(0, Math.min(images.length - 1, getIndex(images)));
                const nextIndex = (currentIndex + delta + images.length) % images.length;
                return onChange(nextIndex, images, event);
            }).catch((error) => {
                console.warn('Preview keyboard navigation failed:', error);
            });
        };

        container.addEventListener('pointerdown', event => {
            if (event.target?.closest?.('video, .image-save-preview-tools')) return;
            container.focus({ preventScroll: true });
        });
        container.addEventListener('keydown', (event) => {
            if (container.dataset.saveMode === 'video' || event.target?.closest?.('video, .image-save-preview-tools')) return;
            if (hasBlockingImmersiveOverlay()) return;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                handleStep(-1, event);
            } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                handleStep(1, event);
            }
        });
    }

    async function stepImagePreviewNodeByDelta(nodeId, delta) {
        const node = getNodeById(nodeId);
        if (node?.type === 'ImageMerge' && getNodeMediaAssetKeys(node).length) {
            const count = getNodeMediaAssetKeys(node).length;
            await selectMergePreviewSlot(node, ((node.imagePreviewIndex || 0) + delta + count) % count);
            schedulePreviewIndexSave(nodeId);
            return count > 1;
        }
        const images = await getStoredImagePreviewListAsync(node);
        const slots = getPreviewSlotImages(node, images);
        if (!node || slots.length <= 1) return false;
        const currentIndex = getImagePreviewIndex(node, slots);
        const nextIndex = (currentIndex + delta + slots.length) % slots.length;
        node.imagePreviewIndex = nextIndex;
        node.previewZoom = 1;
        renderImagePreviewImage(nodeId, images);
        const image = slots[nextIndex];
        if (image) {
            await showResolutionBadge(nodeId, image);
        }
        schedulePreviewIndexSave(nodeId);
        return true;
    }

    async function stepImageSaveNodeByDelta(nodeId, delta) {
        const node = getNodeById(nodeId);
        const images = await getStoredImageSaveListAsync(node);
        const slots = getPreviewSlotImages(node, images);
        if (!node || slots.length <= 1) return false;
        const currentIndex = getImageSavePreviewIndex(node, slots);
        node.imagePreviewIndex = (currentIndex + delta + slots.length) % slots.length;
        renderImageSavePreview(nodeId, images);
        await showResolutionBadge(nodeId, slots[node.imagePreviewIndex]);
        schedulePreviewIndexSave(nodeId);
        return true;
    }

    function bindSelectedNodeKeyboardNavigation() {
        if (documentRef.__cainflowSelectedNodePreviewKeyboardBound === true) return;
        documentRef.__cainflowSelectedNodePreviewKeyboardBound = true;

        documentRef.addEventListener('keydown', (event) => {
            if (event.defaultPrevented) return;
            if (isTypingIntoField()) return;
            if (hasBlockingImmersiveOverlay()) return;
            if (!(event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
            const selectedNodeId = getFocusedNodeId();
            if (!selectedNodeId) return;
            const node = getNodeById(selectedNodeId);
            if (!node || (!isBatchPreviewNode(node) && node.type !== 'ImageGenerate' && node.type !== 'ImageSave')) return;
            if (node.type === 'ImageSave' && (getProcessingNodeElement(node.id, 'save-preview')?.dataset.saveMode === 'video' || event.target?.closest?.('video, .image-save-preview-tools'))) return;

            const delta = event.key === 'ArrowLeft' ? -1 : 1;
            event.preventDefault();
            event.stopPropagation();

            if (isBatchPreviewNode(node) || node.type === 'ImageGenerate') {
                void stepImagePreviewNodeByDelta(selectedNodeId, delta);
            } else {
                void stepImageSaveNodeByDelta(selectedNodeId, delta);
            }
        });
    }


    function renderImageImportUrlPreviewContent(imageUrl, options = {}) {
        const { reloading = false, message = '' } = options;
        if (imageUrl && isRemoteImageUrl(imageUrl)) {
            const src = reloading ? previewCache.getReloadableImageUrl(imageUrl) : imageUrl;
            return `
                <img src="${escapeHtml(src)}" alt="URL 图片预览" draggable="false" style="pointer-events: none;" loading="eager" decoding="async" fetchpriority="high" referrerpolicy="no-referrer" data-original-src="${escapeHtml(imageUrl)}" />
                <button type="button" class="image-import-url-refresh ${reloading ? 'is-loading' : ''}" title="重新加载预览" aria-label="重新加载 URL 图片预览">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
                </button>
            `;
        }
        const placeholderText = message || (imageUrl ? '请输入有效的图片 URL' : '输入 URL 后自动显示预览');
        return `<div class="drop-text">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            ${escapeHtml(placeholderText)}
        </div>`;
    }

    function updateImageImportModeState(nodeId) {
        const node = getNodeById(nodeId);
        const modeInput = getNodeElement(nodeId, 'import-mode');
        const uploadSection = getNodeElement(nodeId, 'upload-section');
        const urlSection = getNodeElement(nodeId, 'url-section');
        const mode = modeInput?.value || 'upload';

        if (uploadSection) uploadSection.classList.toggle('hidden', mode !== 'upload');
        if (urlSection) urlSection.classList.toggle('hidden', mode !== 'url');

        queryNodeControls(node?.el, `[data-image-import-mode]`).forEach(field => {
            field.hidden = field.dataset.imageImportMode !== mode;
            field.classList.toggle('hidden', field.hidden);
        });
        queryNodeControls(node?.el, `.image-import-mode-btn[data-target="${nodeId}"]`).forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        if (mode !== 'url') requestNodeFit(nodeId);
    }

    async function clearImageImportBadge(nodeId) {
        const badge = getNodeElement(nodeId, 'res');
        if (badge) {
            badge.textContent = '';
            badge.style.display = 'none';
        }
    }

    function renderImageImportUrlState(nodeId, imageUrl = '') {
        const urlInput = getNodeElement(nodeId, 'url-input');
        const preview = getNodeElement(nodeId, 'url-preview');
        if (urlInput && imageUrl && urlInput.value !== imageUrl) {
            urlInput.value = imageUrl;
        }
        if (preview) {
            if (imageUrl && isRemoteImageUrl(imageUrl)) {
                preview.classList.add('has-image');
                preview.innerHTML = renderImageImportUrlPreviewContent(imageUrl);
            } else {
                preview.classList.remove('has-image');
                preview.innerHTML = renderImageImportUrlPreviewContent(imageUrl);
            }
        }
        clearImageImportBadge(nodeId);
        bindImageImportUrlPreviewEvents(nodeId);
    }

    function reloadImageImportUrlPreview(nodeId) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImageImport') return;
        const imageUrl = node.imageUrl || documentRef.getElementById(`${nodeId}-url-input`)?.value?.trim() || '';
        if (!isRemoteImageUrl(imageUrl)) {
            renderImageImportUrlState(nodeId, imageUrl);
            showToast('请输入有效的图片 URL', 'warning');
            return;
        }
        const preview = getNodeElement(nodeId, 'url-preview');
        if (!preview) return;
        preview.classList.add('has-image');
        preview.innerHTML = renderImageImportUrlPreviewContent(imageUrl, { reloading: true });
        bindImageImportUrlPreviewEvents(nodeId);
    }

    function bindImageImportUrlPreviewEvents(nodeId) {
        const preview = getNodeElement(nodeId, 'url-preview');
        const img = preview?.querySelector('img');
        if (!preview || !img || img.dataset.urlPreviewEventsBound === '1') return;
        img.dataset.urlPreviewEventsBound = '1';
        img.addEventListener('load', () => {
            preview.querySelector('.image-import-url-refresh')?.classList.remove('is-loading');
        });
        img.addEventListener('error', () => {
            const imageUrl = img.dataset.originalSrc || img.getAttribute('src') || '';
            preview.classList.remove('has-image');
            preview.innerHTML = renderImageImportUrlPreviewContent('', { message: '图片加载失败，请点击刷新或检查图床链接' });
            const retryButton = documentRef.createElement('button');
            retryButton.type = 'button';
            retryButton.className = 'image-import-url-refresh';
            retryButton.title = '重新加载预览';
            retryButton.setAttribute('aria-label', '重新加载 URL 图片预览');
            retryButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';
            retryButton.addEventListener('click', (event) => {
                event.stopPropagation();
                const node = getNodeById(nodeId);
                if (node) node.imageUrl = imageUrl;
                reloadImageImportUrlPreview(nodeId);
            });
            preview.appendChild(retryButton);
        });
    }

    function renderImageImportUploadState(nodeId, imageData = null) {
        const dropZone = getNodeElement(nodeId, 'drop');
        if (!dropZone) return;

        if (imageData) {
            dropZone.classList.add('has-image');
            dropZone.innerHTML = '';
            const img = documentRef.createElement('img');
            img.style.pointerEvents = 'none';
            setImageElementSource(img, imageData, '已导入图片', { preferImmediateSrc: true });
            dropZone.appendChild(img);
            showResolutionBadge(nodeId, imageData);
            void cacheNodePreviewThumbnail(nodeId, imageData);
        } else {
            dropZone.classList.remove('has-image');
            dropZone.innerHTML = `<div class="drop-text">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                拖拽图片到此处
            </div>`;
            clearImageImportBadge(nodeId);
            clearNodePreviewThumbnail(nodeId);
        }

        requestNodeFit(nodeId);
    }

    async function syncImageImportSourceState(nodeId, options = {}) {
        const { refreshDependents = false } = options;
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImageImport') return null;

        node.data = node.data || {};
        node.importMode = node.importMode === 'url' ? 'url' : 'upload';

        const modeInput = getNodeElement(nodeId, 'import-mode');
        if (modeInput) modeInput.value = node.importMode;

        updateImageImportModeState(nodeId);

        if (node.importMode === 'url') {
            if (node.imageUrl) node.data.image = node.imageUrl;
            else delete node.data.image;
            delete node.data.imagePreviewThumbnail;
            renderImageImportUrlState(nodeId, node.imageUrl || '');
        } else {
            const importAssetKey = node.imageImportAssetKey || node.data?.imageImportAssetKey || getNodeMediaAssetKeys(node)[0] || '';
            let imageList = importAssetKey ? await restoreStoredImageList(node) : getFirstNonEmptyImageList(
                node.imageData, node.data?.image, node.imageDataList, node.data?.images
            ).filter(image => image !== node.imageUrl);
            if (getNodeById(nodeId) !== node || node.importMode !== 'upload') return null;
            let imageData = imageList[0] || null;
            if (imageData && importAssetKey) {
                node.imageImportAssetKey = importAssetKey;
                node.data.imageImportAssetKey = importAssetKey;
            }
            const previewThumbnail = typeof node.data?.imagePreviewThumbnail === 'string' && node.data.imagePreviewThumbnail.trim()
                ? node.data.imagePreviewThumbnail
                : '';
            if (imageData) {
                node.imageData = imageData;
                node.imageDataList = imageList;
                node.data.image = imageData;
                node.data.images = imageList.slice();
                void cacheNodePreviewThumbnail(node, imageData);
            } else if (previewThumbnail) {
                node.imageData = null;
                node.imageDataList = [];
                delete node.data.image;
                delete node.data.images;
            } else {
                node.imageData = null;
                node.imageDataList = [];
                delete node.data.image;
                delete node.data.images;
            }
            if (node.imageImportAssetKey) node.data.imageImportAssetKey = node.imageImportAssetKey;
            renderImageImportUploadState(nodeId, imageData || previewThumbnail || null);
        }

        if (refreshDependents) {
            await refreshDependentImageResizePreviews(nodeId);
        }
        syncClonesFromSource(nodeId);

        return node.data.image || null;
    }

    async function showResolutionBadge(nodeId, dataUrl) {
        const badge = getNodeElement(nodeId, 'res');
        if (!badge) return;
        const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        badge.dataset.resolutionToken = token;
        const res = await previewCache.resolveImageResolution(dataUrl);
        if (badge.dataset.resolutionToken !== token) return;
        if (res) {
            badge.textContent = `尺寸 ${res}`;
            badge.style.display = 'block';
        } else {
            badge.textContent = '';
            badge.style.display = 'none';
        }
    }

    function renderImageResizeEmptyState(nodeId, message = '等待上游图片') {
        clearNodePreviewThumbnail(nodeId);
        const preview = getProcessingNodeElement(nodeId, `resize-preview`);
        const sizeLabel = getProcessingNodeElement(nodeId, `resize-size-label`);
        const bytesLabel = getProcessingNodeElement(nodeId, `resize-bytes-label`);
        if (preview) {
            preview.innerHTML = `<div class="preview-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>${message}</div>`;
        }
        if (sizeLabel) sizeLabel.textContent = message;
        if (bytesLabel) bytesLabel.textContent = '';
        requestNodeFit(nodeId);
    }

    function renderImageResizeResult(nodeId, result) {
        const preview = getProcessingNodeElement(nodeId, `resize-preview`);
        const sizeLabel = getProcessingNodeElement(nodeId, `resize-size-label`);
        const bytesLabel = getProcessingNodeElement(nodeId, `resize-bytes-label`);
        const sizeText = result.originalWidth && result.originalHeight && result.outputWidth && result.outputHeight
            ? `${result.originalWidth} × ${result.originalHeight} → ${result.outputWidth} × ${result.outputHeight}`
            : result.outputWidth && result.outputHeight ? `${result.outputWidth} × ${result.outputHeight}` : '结果预览已更新';

        if (preview) {
            delete preview.dataset.processingState;
            delete preview.dataset.processingMessage;
            preview.innerHTML = '';
            const img = documentRef.createElement('img');
            setImageElementSource(img, result.dataUrl, '缩放结果预览', { preferImmediateSrc: false });
            preview.appendChild(img);
        }
        if (result?.dataUrl) {
            void cacheNodePreviewThumbnail(nodeId, result.dataUrl);
        } else {
            clearNodePreviewThumbnail(nodeId);
        }
        if (sizeLabel) {
            sizeLabel.textContent = sizeText;
        }
        if (bytesLabel) {
            const qualityText = result.outputQuality ? ` | 质量 ${Math.round(result.outputQuality * 100)}` : '';
            const format = result.outputFormat ? `${result.outputFormat.replace('image/', '').toUpperCase()} | ` : '';
            bytesLabel.textContent = `${format}${formatBytes(result.estimatedBytes)}${qualityText}`;
        }
        requestNodeFit(nodeId);
    }

    function renderColorResetEmptyState(nodeId, message = '等待上游图片') {
        clearNodePreviewThumbnail(nodeId);
        const preview = getProcessingNodeElement(nodeId, `color-preview`);
        if (preview) preview.innerHTML = `<div class="preview-placeholder">${message}</div>`;
        requestNodeFit(nodeId);
    }

    function renderColorResetResult(nodeId, result) {
        const preview = getProcessingNodeElement(nodeId, `color-preview`);
        if (preview) { delete preview.dataset.processingState; delete preview.dataset.processingMessage; }
        const rendered = renderColorResetPreview(preview, result.dataUrl, { overlayId: `${nodeId}-picker-overlay` });
        if (result?.dataUrl) void cacheNodePreviewThumbnail(nodeId, result.dataUrl);
        if (rendered.createdImage) requestNodeFit(nodeId);
    }

    function readColorResetConfig(nodeId) {
        const node = getNodeById(nodeId);
        return readColorResetNodeConfig(node, documentRef);
    }

    async function refreshColorResetPreview(nodeId, options = {}) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ColorReset') return null;
        const workflowId = getActiveWorkflowId();
        node.data = node.data || {};
        const token = (node.colorResetPreviewToken || 0) + 1;
        node.colorResetPreviewToken = token;
        const config = readColorResetConfig(nodeId);
        if (Object.prototype.hasOwnProperty.call(options, 'sourceImage')) node.cancelWhiteBalancePicking?.();
        const sourceImage = Object.prototype.hasOwnProperty.call(options, 'sourceImage')
            ? getPrimaryProcessingImage(null, Array.isArray(options.sourceImage) ? options.sourceImage : normalizeImageList(options.sourceImage))
            : await getResizeSourceImageAsync(nodeId);
        if (getNodeById(nodeId) !== node || node.colorResetPreviewToken !== token) return null;
        if (!sourceImage) {
            markProcessingPreviewStale(node, '等待上游图片');
            return null;
        }
        if (isRemoteImageUrl(sourceImage)) {
            markProcessingPreviewStale(node, 'URL 图片不支持复位颜色节点');
            return null;
        }
        try {
            const result = await processColorResetImage(sourceImage, config);
            if (getNodeById(nodeId) !== node || node.colorResetPreviewToken !== token) return null;
            node.data = node.data || {};
            node.data.image = result.dataUrl;
            node.imageData = result.dataUrl;
            node.imageDataList = [result.dataUrl];
            setDerivedImagePreview(node, result.dataUrl);
            node.colorResetPreviewMeta = result;
            const selectedMode = config.whiteBalanceMode;
            if (result.whiteBalanceGains && selectedMode === 'auto') {
                node.autoWhiteBalanceGains = result.whiteBalanceGains;
                node.data.autoWhiteBalanceGains = result.whiteBalanceGains;
            } else if (result.whiteBalanceGains && selectedMode === 'custom' && result.whiteBalanceAnalysis?.status === 'applied') {
                node.customWhiteBalanceGains = result.whiteBalanceGains;
                node.whiteBalanceGains = result.whiteBalanceGains;
                node.data.customWhiteBalanceGains = result.whiteBalanceGains;
                node.data.whiteBalanceGains = result.whiteBalanceGains;
            }
            const analysis = result.whiteBalanceAnalysis;
            if (analysis) {
                node.whiteBalanceStatus = analysis.status;
                node.whiteBalanceMessage = analysis.message;
                node.data.whiteBalanceStatus = analysis.status;
                node.data.whiteBalanceMessage = analysis.message;
                if (analysis.samplePoint) {
                    node.whiteBalanceSamplePoint = analysis.samplePoint;
                    node.data.whiteBalanceSamplePoint = analysis.samplePoint;
                }
                const status = getProcessingNodeElement(nodeId, `white-balance-status`);
                if (status) { status.textContent = analysis.message; status.dataset.status = analysis.status; }
            }
            markNodeImageAssetPending(node, workflowId ? null : nodeId, 1);
            renderColorResetResult(nodeId, result);
            if (options.cascade !== false) await refreshDependentImageResizePreviews(nodeId, options);
            const previousWrite = node.colorResetAssetWrite || Promise.resolve();
            node.colorResetAssetWrite = previousWrite
                .catch(() => false)
                .then(async () => {
                    if (getNodeById(nodeId) !== node || node.colorResetPreviewToken !== token) return false;
                    const mediaAsset = workflowId
                        ? await saveWorkflowNodeMediaAsset(result.dataUrl, workflowId, nodeId, node.activeMediaOperationId)
                        : null;
                    if (getNodeById(nodeId) !== node) {
                        if (mediaAsset?.mediaTemporaryOwnerId) await removeMediaReference('workflow-operation', mediaAsset.mediaTemporaryOwnerId, mediaAsset.asset_key);
                        return false;
                    }
                    if (mediaAsset?.asset_key) rememberWorkflowMediaOperation(node, [mediaAsset]);
                    if (node.colorResetPreviewToken !== token) return false;
                    const saved = Boolean(mediaAsset) || await saveImageAsset(nodeId, result.dataUrl);
                    if (getNodeById(nodeId) !== node || node.colorResetPreviewToken !== token) return false;
                    if (mediaAsset?.asset_key) node.data.mediaAssetKeys = [mediaAsset.asset_key];
                    if (saved) markNodeImageAssetReady(node, mediaAsset?.asset_key || nodeId, 1);
                    return saved;
                })
                .catch(() => false);
            return result;
        } catch {
            if (getNodeById(nodeId) !== node || node.colorResetPreviewToken !== token) return null;
            markProcessingPreviewStale(node, '预览生成失败');
            return null;
        }
    }

    function setupColorReset(id, el) {
        const node = getNodeById(id);
        const preview = queryNodeControl(el, `#${id}-color-preview`);
        const picker = queryNodeControl(el, `#${id}-white-balance-picker`);
        const resetWhiteBalanceButton = queryNodeControl(el, `#${id}-reset-white-balance`);
        const resetColorButton = queryNodeControl(el, `#${id}-reset-color`);
        const resetAllButton = queryNodeControl(el, `#${id}-reset-all`);
        const status = queryNodeControl(el, `#${id}-white-balance-status`);
        const mode = queryNodeControl(el, `#${id}-white-balance`);
        const dirtyDot = queryNodeControl(el, `#${id}-color-reset-dirty`);
        const whiteBalanceDirtyBadge = queryNodeControl(el, `#${id}-white-balance-dirty`);
        const colorDirtyBadge = queryNodeControl(el, `#${id}-color-dirty`);
        const persistControls = () => {
            node.colorResetPreviewToken = (node.colorResetPreviewToken || 0) + 1;
            const config = readColorResetConfig(id);
            persistProcessingParameters(node, {
                whiteBalanceMode: config.whiteBalanceMode,
                ...Object.fromEntries(['temperature', 'tint', 'vibrance', 'saturation'].map(name => [name, config[name]]))
            });
            syncClonesFromSource(id);
            scheduleSave();
        };
        let picking = false;
        let pickerGestureUntil = 0;
        const updateRange = (input) => {
            if (!input) return;
            const percent = (Number(input.value) + 100) / 2;
            input.style.setProperty('--range-progress', `${percent}%`);
        };
        let refreshTimer = null;
        const readControl = (name) => Number(queryNodeControl(el, `#${id}-${name}`)?.value) || 0;
        const updateDirtyState = () => {
            const whiteBalanceDirty = mode?.value !== 'original' || readControl('temperature') !== 0 || readControl('tint') !== 0;
            const colorDirty = readControl('vibrance') !== 0 || readControl('saturation') !== 0;
            whiteBalanceDirtyBadge?.classList.toggle('is-visible', whiteBalanceDirty);
            colorDirtyBadge?.classList.toggle('is-visible', colorDirty);
            dirtyDot?.classList.toggle('is-visible', whiteBalanceDirty || colorDirty);
            el.dataset.whiteBalanceDirty = String(whiteBalanceDirty);
            el.dataset.colorDirty = String(colorDirty);
            el.dataset.nodeDirty = String(whiteBalanceDirty || colorDirty);
        };
        const queue = () => {
            if (!canEditProcessingNode(node)) return;
            if (refreshTimer) windowRef.clearTimeout(refreshTimer);
            persistControls();
            updateDirtyState();
            refreshTimer = windowRef.setTimeout(() => {
                if (canEditProcessingNode(node)) void refreshColorResetPreview(id);
            }, 160);
        };
        ['temperature', 'tint', 'vibrance', 'saturation'].forEach((name) => {
            const range = queryNodeControl(el, `#${id}-${name}`);
            const number = queryNodeControl(el, `#${id}-${name}-value`);
            updateRange(range);
            range?.addEventListener('input', () => { if (!canEditProcessingNode(node)) return; if (number) number.value = range.value; updateRange(range); queue(); });
            number?.addEventListener('input', () => { if (!canEditProcessingNode(node)) return; number.value = String(Math.max(-100, Math.min(100, Number(number.value) || 0))); if (range) range.value = number.value; updateRange(range); queue(); });
            const resetScalar = () => { if (!canEditProcessingNode(node)) return; if (range) range.value = '0'; if (number) number.value = '0'; updateRange(range); queue(); };
            range?.addEventListener('dblclick', resetScalar);
            number?.addEventListener('dblclick', resetScalar);
        });
        const stopPicking = () => {
            picking = false; picker?.classList.remove('active'); preview?.classList.remove('is-picking'); picker?.setAttribute('aria-pressed', 'false');
        };
        node.cancelWhiteBalancePicking = stopPicking;
        mode?.addEventListener('change', () => { if (!canEditProcessingNode(node)) return; stopPicking(); persistControls(); updateDirtyState(); void refreshColorResetPreview(id); });
        picker?.addEventListener('click', () => {
            if (!canEditProcessingNode(node)) return;
            picking = !picking;
            picker.classList.toggle('active', picking);
            picker.setAttribute('aria-pressed', String(picking));
            preview?.classList.toggle('is-picking', picking);
            if (status) { status.textContent = picking ? '请在原图预览中点击白色或灰色区域' : (node.whiteBalanceMessage || '原始设置'); status.dataset.status = picking ? 'picking' : (node.whiteBalanceStatus || 'idle'); }
        });
        const resetWhiteBalanceState = () => {
            stopPicking();
            node.whiteBalanceGains = { r: 1, g: 1, b: 1 };
            node.customWhiteBalanceGains = { r: 1, g: 1, b: 1 };
            node.autoWhiteBalanceGains = { r: 1, g: 1, b: 1 };
            node.whiteBalanceSamplePoint = null;
            node.whiteBalanceStatus = 'applied';
            node.whiteBalanceMessage = '原始设置';
            node.data.whiteBalanceGains = node.whiteBalanceGains;
            node.data.customWhiteBalanceGains = node.customWhiteBalanceGains;
            node.data.autoWhiteBalanceGains = node.autoWhiteBalanceGains;
            delete node.data.whiteBalanceSamplePoint;
            node.data.whiteBalanceStatus = 'applied'; node.data.whiteBalanceMessage = '原始设置';
            mode.value = 'original';
            if (status) { status.textContent = '原始设置'; status.dataset.status = 'applied'; }
            ['temperature', 'tint'].forEach((name) => {
                const range = queryNodeControl(el, `#${id}-${name}`); const number = queryNodeControl(el, `#${id}-${name}-value`);
                if (range) { range.value = '0'; updateRange(range); }
                if (number) number.value = '0';
            });
        };
        const resetColorState = () => {
            ['vibrance', 'saturation'].forEach((name) => {
                const range = queryNodeControl(el, `#${id}-${name}`); const number = queryNodeControl(el, `#${id}-${name}-value`);
                if (range) { range.value = '0'; updateRange(range); }
                if (number) number.value = '0';
            });
        };
        const commitReset = async (resetter) => {
            if (!canEditProcessingNode(node)) return;
            if (refreshTimer) { windowRef.clearTimeout(refreshTimer); refreshTimer = null; }
            resetter();
            persistControls();
            updateDirtyState();
            await refreshColorResetPreview(id);
            scheduleSave();
        };
        resetWhiteBalanceButton?.addEventListener('click', () => { void commitReset(resetWhiteBalanceState); });
        resetColorButton?.addEventListener('click', () => { void commitReset(resetColorState); });
        resetAllButton?.addEventListener('click', () => { void commitReset(() => { resetWhiteBalanceState(); resetColorState(); }); });
        const handlePickerEscape = (event) => {
            if (getNodeById(id) !== node) { stopPicking(); documentRef.removeEventListener('keydown', handlePickerEscape); return; }
            if (event.key !== 'Escape' || !picking) return;
            event.preventDefault();
            stopPicking();
            if (status) { status.textContent = node.whiteBalanceMessage || '原始设置'; status.dataset.status = node.whiteBalanceStatus || 'idle'; }
        };
        documentRef.addEventListener('keydown', handlePickerEscape);
        preview?.addEventListener('mousedown', (event) => {
            if (picking) { pickerGestureUntil = Date.now() + 500; event.stopPropagation(); }
        });
        preview?.addEventListener('dblclick', (event) => {
            if (picking || Date.now() < pickerGestureUntil) { event.preventDefault(); event.stopPropagation(); }
        });
        preview?.addEventListener('click', async (event) => {
            if (!picking) {
                if ((!el.classList.contains('image-first-card') || event.detail === 2) && !state.justDragged && Date.now() >= pickerGestureUntil) void openStoredImageNodeFullscreen(id);
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            pickerGestureUntil = Date.now() + 500;
            if (!canEditProcessingNode(node)) { stopPicking(); return; }
            const source = await getResizeSourceImageAsync(id);
            if (!canEditProcessingNode(node) || !picking) return;
            const image = preview.querySelector('img');
            if (!source || !image) return;
            const rect = image.getBoundingClientRect();
            const sourceInfo = await new Promise((resolve) => {
                const img = new windowRef.Image(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = source;
            });
            if (!sourceInfo) return;
            if (!canEditProcessingNode(node) || !picking) return;
            const mapped = mapPreviewPointToImage({ x: event.clientX - rect.left, y: event.clientY - rect.top, boxWidth: rect.width, boxHeight: rect.height, imageWidth: sourceInfo.naturalWidth, imageHeight: sourceInfo.naturalHeight });
            if (!mapped) { if (status) { status.textContent = '请点击图片内容区域'; status.dataset.status = 'invalid-sample'; } return; }
            const candidatePoint = { xRatio: mapped.xRatio, yRatio: mapped.yRatio };
            let candidateResult;
            try {
                candidateResult = await processColorResetImage(source, {
                    ...readColorResetConfig(id),
                    whiteBalanceMode: 'custom',
                    samplePoint: candidatePoint
                });
            } catch {
                candidateResult = { whiteBalanceAnalysis: { status: 'invalid-sample', message: '取样失败，请重新选择' } };
            }
            if (!canEditProcessingNode(node) || !picking) return;
            const selection = resolveWhiteBalanceSampleSelection({
                mode: mode.value,
                samplePoint: node.whiteBalanceSamplePoint || node.data?.whiteBalanceSamplePoint || null
            }, candidatePoint, candidateResult.whiteBalanceAnalysis);
            if (!selection.accepted) {
                if (status) { status.textContent = selection.message; status.dataset.status = 'invalid-sample'; }
                persistProcessingParameters(node, { whiteBalanceStatus: 'invalid-sample', whiteBalanceMessage: selection.message });
                scheduleSave();
                return;
            }
            node.whiteBalanceSamplePoint = selection.samplePoint;
            node.data.whiteBalanceSamplePoint = node.whiteBalanceSamplePoint;
            let custom = mode.querySelector('option[value="custom"]'); custom.hidden = false; mode.value = 'custom';
            if (candidateResult.whiteBalanceGains) {
                persistProcessingParameters(node, { customWhiteBalanceGains: candidateResult.whiteBalanceGains, whiteBalanceGains: candidateResult.whiteBalanceGains });
            }
            stopPicking();
            persistControls();
            updateDirtyState();
            await refreshColorResetPreview(id); scheduleSave();
        });
        updateDirtyState();
        const retainedPreview = node?.imageData || node?.data?.imagePreviewThumbnail;
        if (retainedPreview) {
            renderColorResetResult(id, { dataUrl: retainedPreview });
            if (!hasIncomingImageConnection(id)) markProcessingPreviewStale(node, '等待上游图片');
        } else void refreshColorResetPreview(id);
        requestNodeFit(id);
    }

    function restoreColorResetPreview(nodeId, dataUrl, meta = {}) {
        const node = getNodeById(nodeId);
        if (!node || !dataUrl) return renderColorResetEmptyState(nodeId);
        node.data.image = dataUrl; node.imageData = dataUrl; node.imageDataList = [dataUrl]; setDerivedImagePreview(node, dataUrl); node.colorResetPreviewMeta = meta;
        renderColorResetResult(nodeId, { ...meta, dataUrl });
        const status = getProcessingNodeElement(nodeId, 'white-balance-status');
        if (status) {
            status.textContent = meta.whiteBalanceAnalysis?.message || node.whiteBalanceMessage || node.data.whiteBalanceMessage || '原始设置';
            status.dataset.status = meta.whiteBalanceAnalysis?.status || node.whiteBalanceStatus || node.data.whiteBalanceStatus || 'idle';
        }
    }

    function updateImageResizeModeState(nodeId) {
        const modeInput = getProcessingNodeElement(nodeId, `resize-mode`);
        const scaleSection = getProcessingNodeElement(nodeId, `scale-section`);
        const dimensionsSection = getProcessingNodeElement(nodeId, `dimensions-section`);
        const mode = modeInput?.value || getNodeById(nodeId)?.resizeMode || getNodeById(nodeId)?.data?.resizeMode || 'scale';

        if (scaleSection) scaleSection.classList.toggle('hidden', mode !== 'scale');
        if (dimensionsSection) dimensionsSection.classList.toggle('hidden', mode !== 'dimensions');

        queryNodeControls(getNodeById(nodeId)?.el, `.image-resize-mode-btn[data-target="${nodeId}"]`).forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        requestNodeFit(nodeId);
    }

    function updateImageResizeQualityVisibility(nodeId, sourceImage) {
        const qualityField = getProcessingNodeElement(nodeId, `quality-field`);
        if (!qualityField) return;
        const outputFormat = sourceImage ? detectOutputFormat(sourceImage) : 'image/png';
        qualityField.classList.toggle('hidden', outputFormat === 'image/png');
        requestNodeFit(nodeId);
    }

    function readImageResizeConfig(nodeId) {
        const { resizeMode, ...settings } = readImageResizeSettings(getNodeById(nodeId));
        return { mode: resizeMode, ...settings };
    }

    function getPrimaryProcessingImage(node, images, fallback = null) {
        if (node?.enabled === false || node?.data?.mediaIntegrity?.missingItems?.some(item => Number(item.position) === 0)) return null;
        if (images.length > 0) return typeof images[0] === 'string' && images[0] ? images[0] : null;
        return fallback;
    }

    function getResizeSourceImage(nodeId) {
        const incoming = state.connections.find((conn) => conn.to.nodeId === nodeId && conn.to.port === 'image');
        if (!incoming) return null;
        const sourceNode = getNodeById(incoming.from.nodeId);
        return getPrimaryProcessingImage(sourceNode, getNodeOutputImageList(sourceNode), getNodePreviewSourceData(sourceNode));
    }

    async function getResizeSourceImageAsync(nodeId) {
        const incoming = state.connections.find((conn) => conn.to.nodeId === nodeId && conn.to.port === 'image');
        if (!incoming) return null;
        const sourceNode = getNodeById(incoming.from.nodeId);
        if (!sourceNode || sourceNode.enabled === false) return null;
        const images = await getNodeOutputImageListAsync(sourceNode);
        return getPrimaryProcessingImage(sourceNode, images, getNodePreviewSourceData(sourceNode));
    }

    function beginDisplayImageAssetWrite(node) {
        const writeToken = (parseInt(node?.displayImageAssetWriteToken || '0', 10) || 0) + 1;
        node.displayImageAssetWriteToken = writeToken;
        return writeToken;
    }

    async function persistUnownedDisplayImages(node, imageList, writeToken, failureMessage) {
        const workflowId = getActiveWorkflowId();
        try {
            const assets = imageList.length > 1 && workflowId
                ? await saveWorkflowNodeMediaAssets(imageList, workflowId, node.id)
                : [];
            const asset = imageList.length === 1 && workflowId
                ? await saveWorkflowNodeMediaAsset(imageList[0], workflowId, node.id)
                : null;
            const persistedAssets = asset ? [asset] : assets;
            const assetKeys = persistedAssets.map((item) => item?.asset_key).filter(Boolean);
            if (state.nodes.get(node.id) !== node || node.displayImageAssetWriteToken !== writeToken) {
                await Promise.all(persistedAssets
                    .filter((item) => item?.mediaTemporaryOwnerId && item?.asset_key)
                    .map((item) => removeMediaReference('workflow-operation', item.mediaTemporaryOwnerId, item.asset_key)));
                return false;
            }
            if (assetKeys.length === imageList.length) {
                rememberWorkflowMediaOperation(node, persistedAssets);
                node.data.mediaAssetKeys = assetKeys;
                node.data.imageAssetKey = assetKeys[0];
                node.data.imageCount = imageList.length;
                node.data.imageAssetReady = true;
                scheduleSave();
                return true;
            }
        } catch (error) {
            if (state.nodes.get(node.id) !== node || node.displayImageAssetWriteToken !== writeToken) return false;
        }
        delete node.data.imageAssetReady;
        delete node.data.imageAssetKey;
        showToast(failureMessage, 'warning', 6000);
        return false;
    }

    async function syncImagePreviewNode(nodeId, imageData) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImagePreview') return;

        if (imageData?.resultProjection) {
            if (!applyImageDisplayResultProjection(node, imageData.resultProjection)) return;
            setImagePreviewInputState(node, node.previewInputState);
            renderImagePreviewImage(nodeId, getCanonicalImageList(node));
            const retained = Math.max(getStoredImageCount(node), getNodeMediaAssetKeys(node).length) > 0;
            const controls = getNodeElement(nodeId, 'controls'), badge = getNodeElement(nodeId, 'res');
            if (controls) controls.style.display = retained ? 'flex' : 'none';
            if (!retained && badge) { badge.textContent = ''; badge.style.display = 'none'; }
            scheduleDisplayImageMemorySweep({ delayMs: displayImageMemoryManager.releaseGraceMs });
            return;
        }

        const previewContainer = getNodeElement(nodeId, 'preview');
        const controls = getNodeElement(nodeId, 'controls');
        const resolutionBadge = getNodeElement(nodeId, 'res');
        const imageList = normalizeImageList(imageData);

        const currentImage = imageList[0] || null;

        if (currentImage) {
            const writeToken = beginDisplayImageAssetWrite(node);
            const previousImages = getStoredImagePreviewList(node);
            const unchanged = !getStoredImageCount(node) || (previousImages.length === imageList.length
                && previousImages.every((image, index) => image === imageList[index]));
            const currentIndex = unchanged ? getImagePreviewIndex(node, imageList) : 0;
            if (!unchanged) node.previewZoom = 1;
            setImagePreviewInputState(node, resolveImagePreviewInputState(node, imageList));
            setCanonicalImageOutput(node, imageList, {
                currentIndex,
                assetKey: nodeId,
                trackImageCount: true,
                hydratedAt: Date.now(),
                assetReady: false
            });
            renderImagePreviewImage(nodeId, imageList);
            if (controls) controls.style.display = 'flex';
            const forwardedKeys = getForwardedMediaAssetKeys(nodeId);
            const forwarded = forwardedKeys.length > 0
                ? await syncForwardedMediaAssetKeys(node, forwardedKeys)
                : false;
            if (!forwarded) {
                await persistUnownedDisplayImages(
                    node, imageList, writeToken,
                    '图片预览保存失败；请检查本地存储空间后重试'
                );
            }
            saveDisplayImageAssetSoon(nodeId, imageList);
            updateResolutionBadgeSoon(nodeId, currentImage);
        } else {
            const retainedImages = getStoredImagePreviewList(node);
            const hasRetainedOutput = Math.max(retainedImages.length, getStoredImageCount(node), getNodeMediaAssetKeys(node).length) > 0;
            setImagePreviewInputState(node, resolveImagePreviewInputState(node, []));
            if (retainedImages.length) renderImagePreviewImage(nodeId, retainedImages);
            else if (!hasRetainedOutput) renderImagePreviewImage(nodeId, [], '无输入图片');
            if (controls) controls.style.display = hasRetainedOutput ? 'flex' : 'none';
            if (!hasRetainedOutput && resolutionBadge) {
                resolutionBadge.textContent = '';
                resolutionBadge.style.display = 'none';
            }
        }
        scheduleDisplayImageMemorySweep({ delayMs: displayImageMemoryManager.releaseGraceMs });

        if (shouldRequestFit(node, getPreviewLayoutSignature(currentImage ? imageList : getStoredImagePreviewList(node)))) {
            requestNodeFit(nodeId);
        }
    }

    async function syncImageSaveNode(nodeId, imageData) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImageSave') return;
        const project = imageData?.resultProjection;
        if (project) {
            if (!applyImageDisplayResultProjection(node, project)) return;
            renderImageSaveInputState(node);
            renderImageSavePreview(nodeId, getCanonicalImageList(node));
            return;
        }
        node.data = node.data || {};
        const { input } = applyImageSaveMediaState(node, imageData);
        const suppliedImages = input.images;
        const previousImages = getStoredImageSaveList(node);
        const unchangedImages = node.data.imageAssetReady === true && previousImages.length === suppliedImages.length && suppliedImages.every((image, index) => image === previousImages[index]);
        const writeToken = suppliedImages.length && !unchangedImages ? beginDisplayImageAssetWrite(node) : node.displayImageAssetWriteToken;
        const current = () => getNodeById(nodeId) === node && (!suppliedImages.length || node.displayImageAssetWriteToken === writeToken);
        if (suppliedImages.length && !unchangedImages) {
            const previousIndex = node.imagePreviewIndex || 0;
            setCanonicalImageOutput(node, suppliedImages, { currentIndex: previousIndex, assetKey: node.data.imageAssetKey || nodeId, imageCount: suppliedImages.length, hydratedAt: Date.now(), assetReady: false });
            const keys = getForwardedMediaAssetKeys(nodeId);
            const forwarded = keys.length ? await syncForwardedMediaAssetKeys(node, keys) : false;
            if (!current()) return;
            if (!forwarded) await persistUnownedDisplayImages(node, suppliedImages, writeToken, '保存节点图片持久化失败；请检查本地存储空间后重试');
            if (!current()) return;
        }
        const retainedImages = getStoredImageSaveList(node);
        renderImageSaveInputState(node);
        renderImageSavePreview(nodeId, retainedImages);
        scheduleDisplayImageMemorySweep({ delayMs: displayImageMemoryManager.releaseGraceMs });
        scheduleSave();
        if (shouldRequestFit(node, getPreviewLayoutSignature(retainedImages), 'savePreviewLayoutSignature')) requestNodeFit(nodeId);
    }

    function renderImageSaveInputState(node) {
        const retained = Math.max(getStoredImageCount(node), getNodeMediaAssetKeys(node).length) > 0 || getStoredSaveVideos(node).length > 0;
        const manual = getProcessingNodeElement(node.id, 'manual-save'), full = getProcessingNodeElement(node.id, 'view-full');
        if (manual) manual.disabled = !retained;
        if (full) full.disabled = !retained;
        const preview = getProcessingNodeElement(node.id, 'save-preview');
        if (!preview) return;
        preview.dataset.saveState = node.saveInputState;
        if (node.saveInputMessage) preview.dataset.saveMessage = node.saveInputMessage;
        else delete preview.dataset.saveMessage;
    }

    function setImageMergeInputState(node, inputState, message = '') {
        node.mergeInputState = inputState;
        const count = Math.max(getStoredImageCount(node), getNodeMediaAssetKeys(node).length);
        const text = message || (inputState === 'stale' ? '无有效输入，保留上次结果，未更新' : inputState === 'empty' ? '等待图片输入' : '');
        node.mergeMessage = text;
        const preview = getProcessingNodeElement(node.id, 'merge-preview');
        if (preview) {
            preview.dataset.mergeState = inputState;
            if (text) preview.dataset.mergeMessage = text;
            else delete preview.dataset.mergeMessage;
        }
        const summary = getProcessingNodeElement(node.id, 'merge-summary');
        if (summary) summary.textContent = text || `已合并 ${count} 张图片`;
    }

    function renderImageMergePreview(nodeId, images, emptyMessage = '等待图片输入') {
        renderImagePreviewImage(nodeId, images, emptyMessage);
    }

    async function syncImageMergeNode(nodeId, images) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImageMerge') return;
        node.data = node.data || {};
        const token = (node.mergePreviewToken || 0) + 1;
        node.mergePreviewToken = token;
        const current = () => getNodeById(nodeId) === node && node.mergePreviewToken === token;
        let nextImages = [], keys = [], missingItems = [], count = 0, completeKeys = true, waiting = false;
        const explicit = arguments.length > 1;
        if (explicit) {
            nextImages = normalizeImageList(images);
            missingItems = node.data.mediaIntegrity?.missingItems || [];
            count = missingItems.length ? Math.max(nextImages.length, node.data.mediaAssetKeys?.length || 0, node.data.imageCount || 0) : nextImages.length;
        } else {
            const connections = state.connections.filter(edge => edge.to?.nodeId === nodeId && /^image_\d+$/.test(edge.to.port))
                .sort((a, b) => Number(a.to.port.slice(6)) - Number(b.to.port.slice(6)));
            for (const edge of connections) {
                const source = getNodeById(edge.from?.nodeId);
                if (!source || source.enabled === false) continue;
                let values = await getNodeOutputImageListAsync(source);
                if (!current()) return;
                let missing = source.data?.mediaIntegrity?.missingItems || [];
                const ready = source.data?.imageAssetReady === true || !values.length || missing.length > 0;
                const assets = ready ? getNodeMediaAssetKeys(source) : [];
                const size = Math.max(values.length, assets.length, ready ? Number(source.data?.imageCount) || 0 : 0);
                if (!size) { waiting = true; continue; }
                if (assets.length === size && values.length !== size && !missing.length) {
                    const slots = await readPreviewSlots(source, assets);
                    if (!current()) return;
                    if (!slots) { waiting = true; continue; }
                    values = slots.map(item => item.value).filter(Boolean);
                    missing = source.data?.mediaIntegrity?.missingItems || [];
                }
                if (assets.length !== size) completeKeys = false;
                keys.push(...assets);
                nextImages.push(...values);
                missingItems.push(...missing.map(item => ({ ...item, position: count + Number(item.position), sourceNodeId: source.id, nodeId,
                    ownerId: `${getActiveWorkflowId()}:${nodeId}` })));
                count += size;
            }
        }
        if (!current()) return;
        if (!count || waiting) {
            const retained = Math.max(getStoredImageCount(node), getNodeMediaAssetKeys(node).length) > 0;
            setImageMergeInputState(node, retained ? 'stale' : 'empty', waiting ? '等待来源完整图片，预览未更新' : '');
            if (retained) renderImageMergePreview(nodeId, getCanonicalImageList(node));
            else renderImageMergePreview(nodeId, []);
            node.isSucceeded = false;
            return;
        }
        const previousIndex = Number.isFinite(node.imagePreviewIndex) ? node.imagePreviewIndex : 0;
        const previousKeys = getNodeMediaAssetKeys(node);
        setCanonicalImageOutput(node, nextImages, { currentIndex: previousIndex, assetKey: node.data.imageAssetKey || node.id, imageCount: count });
        node.imagePreviewIndex = Math.max(0, Math.min(count - 1, previousIndex));
        if (missingItems.length) node.data.mediaIntegrity = { state: 'missing', mediaType: 'image', ownerType: 'workflow-node', itemCount: count, missingItems };
        else if (!explicit) delete node.data.mediaIntegrity;
        if (!explicit) {
            if (completeKeys && keys.length === count) {
                const unchanged = previousKeys.length === keys.length && keys.every((key, index) => key === previousKeys[index]);
                if (unchanged || missingItems.length) {
                    node.data.mediaAssetKeys = keys.slice(); node.data.imageAssetKey = keys[0]; node.data.imageCount = count; node.data.imageAssetReady = true;
                } else {
                    const forwarded = await syncForwardedMediaAssetKeys(node, keys);
                    if (!current()) return;
                    if (!forwarded) await persistUnownedDisplayImages(node, nextImages, beginDisplayImageAssetWrite(node), '合并预览已更新，但本地图片保存失败');
                }
            } else if (!missingItems.length) {
                await persistUnownedDisplayImages(node, nextImages, beginDisplayImageAssetWrite(node), '合并预览已更新，但本地图片保存失败');
            }
            if (!current()) return;
        }
        setImageMergeInputState(node, missingItems.length ? 'stale' : 'current', missingItems.length ? '来源原图缺失，缺失位置已保留，预览未更新' : '');
        renderImageMergePreview(nodeId, nextImages);
        if (!explicit) scheduleSave();
    }

    function setupImageMerge(id, el) {
        setupImagePreview(id, el);
        const node = getNodeById(id);
        if (!node) return;
        const retained = getStoredImageCount(node) > 0 || getNodeMediaAssetKeys(node).length > 0;
        const missing = node.data?.mediaIntegrity?.missingItems?.length;
        setImageMergeInputState(node, missing ? 'stale' : retained ? 'current' : 'empty', missing ? '来源原图缺失，缺失位置已保留，预览未更新' : '');
        renderImageMergePreview(id, getCanonicalImageList(node));
        if (!state.connections.some(edge => edge.to?.nodeId === id && /^image_\d+$/.test(edge.to.port))) {
            setImageMergeInputState(node, retained ? 'stale' : 'empty');
        }
    }

    function getConnectedImageInput(nodeId, portName) {
        const incoming = state.connections.find((conn) => conn.to.nodeId === nodeId && conn.to.port === portName);
        if (!incoming) return null;
        const source = getNodeById(incoming.from.nodeId);
        return getPrimaryProcessingImage(source, getNodeOutputImageList(source), getNodePreviewSourceData(source));
    }

    async function getConnectedImageInputAsync(nodeId, portName) {
        const incoming = state.connections.find((conn) => conn.to.nodeId === nodeId && conn.to.port === portName);
        if (!incoming) return null;
        const sourceNode = getNodeById(incoming.from.nodeId);
        if (!sourceNode || sourceNode.enabled === false) return null;
        const images = await getNodeOutputImageListAsync(sourceNode);
        return getPrimaryProcessingImage(sourceNode, images, getNodePreviewSourceData(sourceNode));
    }

    function getComparePosition(node) {
        const value = Number(node?.comparePosition ?? node?.data?.comparePosition ?? 50);
        return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50;
    }

    function setCompareInputState(node, inputState, message = '') {
        node.compareInputState = inputState;
        const container = getProcessingNodeElement(node.id, 'compare');
        if (!container) return;
        container.dataset.compareState = inputState;
        if (message) container.dataset.compareMessage = message;
        else delete container.dataset.compareMessage;
    }

    async function resolveAdvancedCompareInputImages(nodeId, node = getNodeById(nodeId)) {
        const [connectedImageA, connectedImageB] = await Promise.all([
            getConnectedImageInputAsync(nodeId, 'imageA'),
            getConnectedImageInputAsync(nodeId, 'imageB')
        ]);

        return {
            imageA: connectedImageA || node?.compareImageA || node?.data?.compareImageA || null,
            imageB: connectedImageB || node?.compareImageB || node?.data?.compareImageB || node?.data?.image || node?.imageData || null
        };
    }

    function renderImageCompareEmptyState(nodeId, message = '等待 B 输入') {
        const container = getProcessingNodeElement(nodeId, 'compare');
        const badge = getProcessingNodeElement(nodeId, 'res');
        const node = getNodeById(nodeId);
        if (container) {
            container.classList.remove('has-images', 'has-a-image', 'is-comparing');
            container.style.setProperty('--compare-x', `${getComparePosition(node)}%`);
            removeElements(container, '.image-compare-img, .image-compare-divider');
            const placeholder = ensureElement(container, '.preview-placeholder', () => createPreviewPlaceholder('preview-placeholder', message));
            updatePlaceholderText(placeholder, message);
        }
        if (badge) {
            badge.textContent = '';
            badge.style.display = 'none';
        }
        if (shouldRequestFit(node, getPreviewLayoutSignature([], { compareImageA: null, compareImageB: null }), 'comparePreviewLayoutSignature')) {
            requestNodeFit(nodeId);
        }
    }

    function renderImageComparePreview(nodeId, imageA = null, imageB = null) {
        const container = getProcessingNodeElement(nodeId, 'compare');
        if (!container) return;
        if (!imageB) {
            renderImageCompareEmptyState(nodeId, imageA ? '等待 B 输入' : '等待 A / B 输入');
            clearNodePreviewThumbnail(nodeId);
            return;
        }
        container.classList.add('has-images');
        container.classList.toggle('has-a-image', Boolean(imageA));
        container.classList.remove('is-comparing');
        container.style.setProperty('--compare-x', `${getComparePosition(getNodeById(nodeId))}%`);
        renderReusableComparePreview(container, imageA, imageB);
        const divider = container.querySelector('.image-compare-divider');
        if (divider) {
            divider.tabIndex = 0;
            divider.setAttribute('role', 'slider');
            divider.setAttribute('aria-label', 'A/B 对比分界位置');
            divider.setAttribute('aria-valuemin', '0');
            divider.setAttribute('aria-valuemax', '100');
            divider.setAttribute('aria-valuenow', String(getComparePosition(getNodeById(nodeId))));
        }
        void cacheNodePreviewThumbnail(nodeId, imageB);
    }

    async function syncImageCompareNode(nodeId, imageA = null, imageB = null) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImageCompare') return;
        const token = (node.comparePreviewToken || 0) + 1;
        node.comparePreviewToken = token;
        const current = () => getNodeById(nodeId) === node && node.comparePreviewToken === token;
        const primary = value => Array.isArray(value) ? (typeof value[0] === 'string' ? value[0] || null : null) : value;

        const nextImageA = Object.prototype.hasOwnProperty.call(arguments, 1)
            ? primary(imageA)
            : await getConnectedImageInputAsync(nodeId, 'imageA');
        const nextImageB = Object.prototype.hasOwnProperty.call(arguments, 2)
            ? primary(imageB)
            : await getConnectedImageInputAsync(nodeId, 'imageB');
        if (!current()) return;
        node.data = node.data || {};

        if (!nextImageB) {
            const retained = node.compareImageB || node.data.compareImageB || node.data.image || node.imageData || node.data.imagePreviewThumbnail;
            if (retained) {
                if (!getProcessingNodeElement(nodeId, 'compare')?.querySelector('.image-compare-b')) {
                    renderImageComparePreview(nodeId, node.compareImageA || node.data.compareImageA || null, retained);
                }
                setCompareInputState(node, 'stale', 'B 输入未连接有效原图，预览未更新');
            } else {
                renderImageCompareEmptyState(nodeId, nextImageA ? '等待 B 输入' : '等待 A / B 输入');
                setCompareInputState(node, 'empty', 'B 输入未连接有效原图');
            }
            node.isSucceeded = false;
            return;
        }

        node.compareImageA = nextImageA || null;
        node.compareImageB = nextImageB;
        if (nextImageA) node.data.compareImageA = nextImageA;
        else delete node.data.compareImageA;
        node.data.compareImageB = nextImageB;
        delete node.data.imageList;
        delete node.data.images;
        node.data.image = nextImageB;
        node.imageData = isInlineImageData(nextImageB) ? nextImageB : null;
        node.imageDataList = [nextImageB];
        node.generatedImages = [];
        renderImageComparePreview(nodeId, nextImageA, nextImageB);
        setCompareInputState(node, 'current');

        const bConnection = state.connections.find(connection => connection.to?.nodeId === nodeId && connection.to?.port === 'imageB');
        const bSource = getNodeById(bConnection?.from?.nodeId);
        const keys = bSource?.data?.imageAssetReady === true ? getForwardedMediaAssetKeys(nodeId, ['imageB']).slice(0, 1) : [];
        const forwarded = keys.length ? await syncForwardedMediaAssetKeys(node, keys) : false;
        if (!current()) return;
        if (!forwarded && node.imageData) {
            await persistUnownedDisplayImages(node, [nextImageB], beginDisplayImageAssetWrite(node), '对比预览已更新，但本地图片保存失败');
            if (!current()) return;
        }

        await showResolutionBadge(nodeId, nextImageB);
        if (!current()) return;
        if (shouldRequestFit(node, getPreviewLayoutSignature([nextImageB], { compareImageA: nextImageA, compareImageB: nextImageB }), 'comparePreviewLayoutSignature')) {
            requestNodeFit(nodeId);
        }
    }

    async function refreshDependentImageResizePreviews(sourceNodeId, options = {}, visited = new Set()) {
        if (visited.has(sourceNodeId)) return;
        visited.add(sourceNodeId);

        const dependents = state.connections
            .filter((conn) => (
                conn.from.nodeId === sourceNodeId
                && (conn.to.port === 'image' || conn.to.port === 'imageA' || conn.to.port === 'imageB' || /^image_\d+$/.test(conn.to.port))
            ))
            .map((conn) => conn.to.nodeId)
            .filter((nodeId, index, list) => list.indexOf(nodeId) === index);
        if (!dependents.length) return;

        const sourceNode = getNodeById(sourceNodeId);
        const sourceImageList = Object.prototype.hasOwnProperty.call(options, 'sourceImage')
            ? normalizeImageList(options.sourceImage)
            : await getNodeOutputImageListAsync(sourceNode);
        const sourceImage = Object.prototype.hasOwnProperty.call(options, 'sourceImage')
            ? options.sourceImage
            : getNodePreviewSourceData(sourceNode);
        const processingSourceImage = getPrimaryProcessingImage(sourceNode,
            Object.prototype.hasOwnProperty.call(options, 'sourceImage') && Array.isArray(options.sourceImage)
                ? options.sourceImage : sourceImageList,
            sourceImage);

        for (const nodeId of dependents) {
            const node = getNodeById(nodeId);
            if (!node) continue;
            if (node.enabled === false) {
                await refreshDependentImageResizePreviews(nodeId, { ...options, sourceImage: null }, visited);
                continue;
            }

            if (node.type === 'ImageResize') {
                await refreshImageResizePreview(nodeId, { ...options, sourceImage: processingSourceImage, cascade: false });
                await refreshDependentImageResizePreviews(nodeId, options, visited);
                continue;
            }
            if (node.type === 'ColorReset') {
                await refreshColorResetPreview(nodeId, { ...options, sourceImage: processingSourceImage, cascade: false });
                await refreshDependentImageResizePreviews(nodeId, options, visited);
                continue;
            }

            if (node.type === 'ImagePreview') {
                const imagePreviewSource = sourceImageList.length > 0 ? sourceImageList : sourceImage;
                await syncImagePreviewNode(nodeId, imagePreviewSource);
                await refreshDependentImageResizePreviews(nodeId, options, visited);
                continue;
            }

            if (node.type === 'ImageSave') {
                const imageSaveSource = sourceImageList.length > 0 ? sourceImageList : sourceImage;
                await syncImageSaveNode(nodeId, imageSaveSource);
                await refreshDependentImageResizePreviews(nodeId, options, visited);
                continue;
            }

            if (node.type === 'ImageCompare') {
                await syncImageCompareNode(nodeId);
                await refreshDependentImageResizePreviews(nodeId, {
                    ...options,
                    sourceImage: getNodePreviewSourceData(node)
                }, visited);
                continue;
            }
            if (node.type === 'ImageMerge') {
                await syncImageMergeNode(nodeId);
                await refreshDependentImageResizePreviews(nodeId, options, visited);
                continue;
            }

            if (node.type === 'CameraControl') {
                await syncCameraControlNodePreview(nodeId, processingSourceImage || '');
            }
        }
    }

    async function refreshAllImageResizePreviews(options = {}) {
        const processingTypes = ['ImageResize', 'ColorReset', 'ImageCompare', 'ImageMerge'];
        const imageResizeNodes = Array.from(state.nodes.values()).filter(node => processingTypes.includes(node.type));
        const refresh = async nodeId => {
            const type = getNodeById(nodeId)?.type;
            if (type === 'ImageCompare' || type === 'ImageMerge') {
                if (type === 'ImageMerge') await syncImageMergeNode(nodeId);
                else await syncImageCompareNode(nodeId);
                await refreshDependentImageResizePreviews(nodeId, options);
            } else if (type === 'ColorReset') await refreshColorResetPreview(nodeId, options);
            else await refreshImageResizePreview(nodeId, options);
        };
        const roots = [];
        const rest = [];

        imageResizeNodes.forEach((node) => {
            const incoming = state.connections.find((conn) => conn.to.nodeId === node.id && (['image', 'imageA', 'imageB'].includes(conn.to.port) || /^image_\d+$/.test(conn.to.port)));
            const upstream = incoming ? getNodeById(incoming.from.nodeId) : null;
            if (!incoming || !upstream || !processingTypes.includes(upstream.type)) roots.push(node.id);
            else rest.push(node.id);
        });

        const refreshed = new Set();
        for (const nodeId of roots) {
            await refresh(nodeId);
            refreshed.add(nodeId);
        }
        for (const nodeId of rest) {
            if (!refreshed.has(nodeId)) await refresh(nodeId);
        }
        for (const node of state.nodes.values()) {
            if (node.type !== 'ImagePreview') continue;
            const incoming = state.connections.find(connection => connection.to?.nodeId === node.id && connection.to.port === 'image');
            const source = incoming ? getNodeById(incoming.from?.nodeId) : null;
            if (!source || source.enabled === false || (!getNodeOutputImageList(source).length && getStoredImageCount(source) === 0)) {
                await syncImagePreviewNode(node.id, []);
            }
        }
    }

    async function refreshAllRecoverableMediaNodes(options = {}) {
        for (const node of state.nodes.values()) {
            if (node?.enabled === false || node.type !== 'ImageSave') continue;
            const incomingImage = state.connections.find(edge => edge.to?.nodeId === node.id && edge.to.port === 'image');
            const incomingVideo = state.connections.find(edge => edge.to?.nodeId === node.id && edge.to.port === 'video');
            const imageSource = getNodeById(incomingImage?.from?.nodeId), videoSource = getNodeById(incomingVideo?.from?.nodeId);
            const images = imageSource?.enabled !== false && imageSource ? await getNodeOutputImageListAsync(imageSource) : [];
            if (getNodeById(node.id) !== node) continue;
            const videos = videoSource?.enabled !== false && videoSource ? getStoredSaveVideos(videoSource) : [];
            await syncImageSaveNode(node.id, { images, videos });
        }

        const sourceNodeIds = Array.from(state.nodes.values())
            .filter((node) => (
                node?.enabled !== false
                && ['ImageImport', 'ImageGenerate', 'ImageResize', 'ColorReset', 'ImagePreview', 'ImageSave', 'ImageCompare'].includes(node.type)
                && getNodeOutputImageList(node).length > 0
            ))
            .map((node) => node.id);

        for (const nodeId of sourceNodeIds) {
            await refreshDependentImageResizePreviews(nodeId, options);
        }
        scheduleDisplayImageMemorySweep({ restoreLimit: displayImageMemoryManager.maxRestorePerSweep });
    }

    async function refreshImageResizePreview(nodeId, options = {}) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImageResize') return null;
        node.data = node.data || {};
        const workflowId = getActiveWorkflowId();
        const token = (node.resizePreviewToken || 0) + 1;
        node.resizePreviewToken = token;
        const config = readImageResizeConfig(nodeId);

        const sourceImage = Object.prototype.hasOwnProperty.call(options, 'sourceImage')
            ? getPrimaryProcessingImage(null, Array.isArray(options.sourceImage) ? options.sourceImage : normalizeImageList(options.sourceImage))
            : await getResizeSourceImageAsync(nodeId);
        if (getNodeById(nodeId) !== node || node.resizePreviewToken !== token) return null;
        updateImageResizeModeState(nodeId);
        updateImageResizeQualityVisibility(nodeId, sourceImage);

        if (!sourceImage) {
            markProcessingPreviewStale(node, '等待上游图片');
            return null;
        }

        if (isRemoteImageUrl(sourceImage)) {
            markProcessingPreviewStale(node, 'URL 图片不支持缩放节点');
            return null;
        }

        const sizeLabel = getProcessingNodeElement(nodeId, `resize-size-label`);
        const bytesLabel = getProcessingNodeElement(nodeId, `resize-bytes-label`);
        if (sizeLabel) sizeLabel.textContent = '正在计算预览...';
        if (bytesLabel) bytesLabel.textContent = '';

        try {
            const result = await resizeImageData(sourceImage, {
                mode: config.mode,
                scalePercent: config.scalePercent,
                targetWidth: config.targetWidth,
                targetHeight: config.targetHeight,
                keepAspect: config.keepAspect,
                quality: config.quality,
                format: detectOutputFormat(sourceImage)
            });

            if (getNodeById(nodeId) !== node || node.resizePreviewToken !== token) return null;

            setDerivedImagePreview(node, result.dataUrl);
            node.resizePreviewMeta = result;
            node.data.image = result.dataUrl;
            node.imageData = result.dataUrl;
            node.imageDataList = [result.dataUrl];
            persistProcessingParameters(node, Object.fromEntries(
                ['originalWidth', 'originalHeight', 'outputWidth', 'outputHeight', 'outputFormat', 'outputQuality', 'estimatedBytes']
                    .filter(name => result[name] !== undefined).map(name => [name, result[name]])
            ));
            const asset = await saveWorkflowNodeMediaAsset(
                result.dataUrl, workflowId, nodeId, node.activeMediaOperationId
            );
            if (asset?.mediaTemporaryOwnerId && state.nodes.get(nodeId) !== node) {
                await removeMediaReference('workflow-operation', asset.mediaTemporaryOwnerId, asset.asset_key);
                return;
            }
            if (asset?.asset_key && getNodeById(nodeId) === node) rememberWorkflowMediaOperation(node, [asset]);
            if (getNodeById(nodeId) !== node || node.resizePreviewToken !== token) return null;
            if (asset?.asset_key) {
                node.data.mediaAssetKeys = [asset.asset_key];
                node.data.imageAssetKey = asset.asset_key;
                markNodeImageAssetReady(node, asset.asset_key, 1);
            } else delete node.data.imageAssetReady;
            renderImageResizeResult(nodeId, result);
            scheduleDisplayImageMemorySweep({ delayMs: displayImageMemoryManager.releaseGraceMs });

            if (options.cascade !== false) {
                await refreshDependentImageResizePreviews(nodeId, options);
            }
            return result;
        } catch (error) {
            if (getNodeById(nodeId) !== node || node.resizePreviewToken !== token) return null;
            markProcessingPreviewStale(node, '预览生成失败');
            return null;
        }
    }

    async function syncAspectLinkedDimension(nodeId, changedField, isCurrent = () => true) {
        const node = getNodeById(nodeId);
        if (!node) return;
        const keepAspect = getProcessingNodeElement(nodeId, `keep-aspect`)?.checked;
        if (!keepAspect) return;

        const incoming = state.connections.find(conn => conn.to.nodeId === nodeId && conn.to.port === 'image');
        const sourceNode = getNodeById(incoming?.from?.nodeId);
        if (!incoming || !sourceNode || sourceNode.enabled === false) return;
        const sourceId = incoming.from.nodeId, sourcePort = incoming.from.port;
        const assetKey = () => getNodeMediaAssetKeys(sourceNode)[0] || sourceNode.data?.imageAssetKey
            || sourceNode.imageImportAssetKey || sourceNode.data?.imageImportAssetKey || '';
        const sourceAsset = assetKey(), sourceMode = sourceNode.importMode ?? sourceNode.data?.importMode;
        let sourcePreview = getResizeSourceImage(nodeId);
        // Check the effective input through metadata and already loaded pixels;
        // validating this edit must never load a second original.
        const inputIsCurrent = () => getNodeById(nodeId) === node && isCurrent()
            && state.connections.find(conn => conn.to.nodeId === nodeId && conn.to.port === 'image') === incoming
            && incoming.from.nodeId === sourceId && incoming.from.port === sourcePort
            && getNodeById(sourceId) === sourceNode && sourceNode.enabled !== false
            && assetKey() === sourceAsset && (sourceNode.importMode ?? sourceNode.data?.importMode) === sourceMode
            && (!sourcePreview || getResizeSourceImage(nodeId) === sourcePreview);

        const sourceImage = await getResizeSourceImageAsync(nodeId);
        if (!inputIsCurrent()) return false;
        if (!sourceImage) return;
        sourcePreview = getResizeSourceImage(nodeId) || sourceImage;

        const res = parseResolutionText(await getImageResolution(sourceImage));
        if (!inputIsCurrent()) return false;
        if (!res?.width || !res?.height) return;

        const widthInput = getProcessingNodeElement(nodeId, `target-width`);
        const heightInput = getProcessingNodeElement(nodeId, `target-height`);
        if (!widthInput || !heightInput) return;

        if (changedField === 'width') {
            const width = parseInt(widthInput.value || '0', 10);
            if (width > 0) heightInput.value = String(Math.max(1, Math.round(width * res.height / res.width)));
        } else if (changedField === 'height') {
            const height = parseInt(heightInput.value || '0', 10);
            if (height > 0) widthInput.value = String(Math.max(1, Math.round(height * res.width / res.height)));
        }
        persistProcessingParameters(node, { targetWidth: widthInput.value, targetHeight: heightInput.value });
    }

    function setupImageImport(id, el) {
        const fileInput = queryNodeControl(el, `#${id}-file`);
        const dropZone = queryNodeControl(el, `#${id}-drop`);
        const selectBtn = queryNodeControl(el, `#${id}-select-btn`);
        const urlInput = queryNodeControl(el, `#${id}-url-input`);
        const urlPreview = queryNodeControl(el, `#${id}-url-preview`);
        const modeInput = queryNodeControl(el, `#${id}-import-mode`);
        const openImagePicker = () => {
            if (!fileInput) return;
            fileInput.value = '';
            fileInput.click();
        };

        void syncImageImportSourceState(id);

        queryNodeControls(el, `.image-import-mode-btn[data-target="${id}"]`).forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!modeInput) return;
                const previous = getNodeById(id);
                if (previous?.imageImportAssetKey || previous?.data?.mediaAssetKeys?.length) pushHistory();
                modeInput.value = btn.dataset.mode || 'upload';
                urlPreviewScheduler.cancel();
                const node = getNodeById(id);
                if (node) node.importMode = modeInput.value;
                await syncImageImportSourceState(id, { refreshDependents: true });
                scheduleSave();
            });
        });

        selectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openImagePicker();
        });
        fileInput.addEventListener('change', (e) => {
            if (e.target.files[0]) loadImageFile(id, e.target.files[0]);
        });
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--accent-purple)';
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.style.borderColor = '';
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = '';
            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith('image/')) loadImageFile(id, file);
        });

        dropZone.addEventListener('click', event => {
            const node = getNodeById(id);
            if (node?.parameterRoot) event.stopPropagation();
            if (state.justDragged || node?.imageFirstMediaDragged) return;
            if (node?.parameterRoot && event.detail === 1) {
                event.stopPropagation(); node.onImageFirstSelect?.(); return;
            }
            if (node && node.importMode === 'upload') {
                void openStoredImageNodeFullscreen(id).then((opened) => {
                    if (!opened && !(node.parameterRoot && event.detail >= 2)) openImagePicker();
                });
                return;
            }
            openImagePicker();
        });

        const urlPreviewScheduler = (() => {
            let timerId = null;
            return {
                schedule(value) {
                    if (timerId) windowRef.clearTimeout(timerId);
                    timerId = windowRef.setTimeout(() => {
                        timerId = null;
                        loadImageUrl(id, value, { silentInvalid: true });
                    }, 220);
                },
                flush(value) {
                    if (timerId) {
                        windowRef.clearTimeout(timerId);
                        timerId = null;
                    }
                    loadImageUrl(id, value || '', { silentInvalid: true });
                },
                cancel() {
                    if (timerId) {
                        windowRef.clearTimeout(timerId);
                        timerId = null;
                    }
                }
            };
        })();

        urlInput?.addEventListener('input', (e) => {
            urlPreviewScheduler.schedule(e.target.value || '');
        });
        urlInput?.addEventListener('change', (e) => {
            urlPreviewScheduler.flush(e.target.value);
        });
        urlInput?.addEventListener('blur', (e) => {
            urlPreviewScheduler.flush(e.target.value);
        });
        urlInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                urlPreviewScheduler.flush(urlInput.value);
            }
        });
        urlPreview?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target.closest('.image-import-url-refresh')) {
                reloadImageImportUrlPreview(id);
                return;
            }
            const node = getNodeById(id);
            if (state.justDragged || node?.imageFirstMediaDragged) return;
            if (node?.parameterRoot && e.detail === 1) { node.onImageFirstSelect?.(); return; }
            if (node?.importMode === 'url' && node.imageUrl) {
                openFullscreenPreview(node.imageUrl, id);
            }
        });
    }

    function loadImageFile(nodeId, file) {
        if (isNodeRunning(nodeId)) {
            showToast('节点正在运行，暂不能修改图片', 'warning');
            return;
        }
        const reader = new FileReader();
        reader.onload = async (e) => {
            const node = getNodeById(nodeId);
            if (!node) return;

            const rawData = e.target.result;
            const autoResizeEnabled = state.imageAutoResizeEnabled !== false;
            const result = autoResizeEnabled
                ? await processImageResolution(rawData)
                : { data: rawData, resized: false };
            const data = result.data;

            if (autoResizeEnabled && result.resized) {
                showToast(`图片尺寸较大 (${result.originalRes})，已自动缩小到阈值范围 (${result.newRes})`, 'warning', 5000);
                addLog('info', '图片自动缩小', `原始分辨率 ${result.originalRes} -> 目标分辨率 ${result.newRes}`);
            }

            if (getNodeById(nodeId) !== node || isNodeRunning(nodeId)) return;
            if (node.imageImportAssetKey || node.data?.imageImportAssetKey || node.mediaAssetKeys?.length || node.data?.mediaAssetKeys?.length) pushHistory();
            node.importMode = 'upload';
            node.imageUrl = '';
            node.imageData = data;
            node.data = node.data || {};
            node.data.image = data;
            await persistImageImportData(nodeId, node, data);
        };
        reader.readAsDataURL(file);
    }

    async function loadImageData(nodeId, imageData) {
        const node = getNodeById(nodeId);
        if (isNodeRunning(nodeId)) {
            showToast('节点正在运行，暂不能修改图片', 'warning');
            return false;
        }
        if (!node || node.type !== 'ImageImport' || !isInlineImageData(imageData)) return false;
        if (node.imageImportAssetKey || node.data?.imageImportAssetKey || node.mediaAssetKeys?.length || node.data?.mediaAssetKeys?.length) pushHistory();
        node.importMode = 'upload';
        node.imageUrl = '';
        node.imageData = imageData;
        node.data = node.data || {};
        node.data.image = imageData;
        return persistImageImportData(nodeId, node, imageData);
    }

    async function loadImageUrl(nodeId, rawUrl, options = {}) {
        const node = getNodeById(nodeId);
        if (isNodeRunning(nodeId)) {
            showToast('节点正在运行，暂不能修改图片', 'warning');
            return;
        }
        if (!node) return;

        const imageUrl = String(rawUrl || '').trim();
        if (node.imageImportAssetKey || node.data?.imageImportAssetKey || node.mediaAssetKeys?.length || node.data?.mediaAssetKeys?.length) pushHistory();
        if (!imageUrl) {
            node.importMode = 'url';
            node.imageUrl = '';
            node.imageData = null;
            delete node.data.image;
            await syncImageImportSourceState(nodeId, { refreshDependents: true });
            scheduleSave();
            return;
        }
        if (!isRemoteImageUrl(imageUrl)) {
            node.importMode = 'url';
            node.imageUrl = '';
            node.imageData = null;
            delete node.data.image;
            await syncImageImportSourceState(nodeId, { refreshDependents: true });
            renderImageImportUrlState(nodeId, imageUrl);
            scheduleSave();
            if (!options.silentInvalid) {
                showToast('URL 模式仅支持 http 或 https 图片链接', 'warning');
            }
            return;
        }

        node.importMode = 'url';
        node.imageUrl = imageUrl;
        node.imageData = null;
        node.data.image = imageUrl;
        await syncImageImportSourceState(nodeId, { refreshDependents: true });
        scheduleSave();
    }

    function setupImageResize(id, el) {
        const previewContainer = queryNodeControl(el, `#${id}-resize-preview`);
        const modeInput = queryNodeControl(el, `#${id}-resize-mode`);
        const scaleInput = queryNodeControl(el, `#${id}-scale-percent`);
        const scaleValue = queryNodeControl(el, `#${id}-scale-value`);
        const qualityInput = queryNodeControl(el, `#${id}-quality`);
        const qualityValue = queryNodeControl(el, `#${id}-quality-value`);
        const widthInput = queryNodeControl(el, `#${id}-target-width`);
        const heightInput = queryNodeControl(el, `#${id}-target-height`);
        const keepAspectInput = queryNodeControl(el, `#${id}-keep-aspect`);

        const node = getNodeById(id);
        let dimensionEditSequence = 0;

        const persistControls = () => {
            node.resizePreviewToken = (node.resizePreviewToken || 0) + 1;
            const { mode, ...config } = readImageResizeConfig(id);
            persistProcessingParameters(node, { resizeMode: mode, ...config });
            syncClonesFromSource(id);
            scheduleSave();
        };

        const updateRangeProgress = (input) => {
            if (!input) return;
            const min = Number(input.min || 0);
            const max = Number(input.max || 100);
            const value = Number(input.value || min);
            const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
            input.style.setProperty('--range-progress', `${percent}%`);
        };

        const queuePreviewRefresh = (delay = 180) => {
            if (!canEditProcessingNode(node)) return;
            if (node.resizePreviewTimer) windowRef.clearTimeout(node.resizePreviewTimer);
            node.resizePreviewTimer = windowRef.setTimeout(() => {
                if (canEditProcessingNode(node)) void refreshImageResizePreview(id);
            }, delay);
        };

        updateImageResizeModeState(id);
        updateImageResizeQualityVisibility(id, getResizeSourceImage(id) || getNodePreviewSourceData(getNodeById(id)));

        queryNodeControls(el, `.image-resize-mode-btn[data-target="${id}"]`).forEach((btn) => {
            btn.addEventListener('click', () => {
                if (!canEditProcessingNode(node)) return;
                modeInput.value = btn.dataset.mode;
                persistControls();
                updateImageResizeModeState(id);
                refreshImageResizePreview(id);
                scheduleSave();
            });
        });

        scaleInput?.addEventListener('input', () => {
            if (!canEditProcessingNode(node)) return;
            if (scaleValue) scaleValue.textContent = `${scaleInput.value}%`;
            updateRangeProgress(scaleInput);
            persistControls();
            queuePreviewRefresh();
        });
        scaleInput?.addEventListener('change', () => {
            if (canEditProcessingNode(node)) void refreshImageResizePreview(id);
        });

        qualityInput?.addEventListener('input', () => {
            if (!canEditProcessingNode(node)) return;
            if (qualityValue) qualityValue.textContent = `${qualityInput.value}%`;
            updateRangeProgress(qualityInput);
            persistControls();
            queuePreviewRefresh();
        });
        qualityInput?.addEventListener('change', () => {
            if (canEditProcessingNode(node)) void refreshImageResizePreview(id);
        });

        updateRangeProgress(scaleInput);
        updateRangeProgress(qualityInput);

        widthInput?.addEventListener('input', async () => {
            if (!canEditProcessingNode(node)) return;
            const editSequence = ++dimensionEditSequence;
            const isCurrent = () => canEditProcessingNode(node) && editSequence === dimensionEditSequence;
            persistControls();
            const synced = await syncAspectLinkedDimension(id, 'width', isCurrent);
            if (synced === false || !isCurrent()) return;
            persistControls();
            queuePreviewRefresh();
        });
        heightInput?.addEventListener('input', async () => {
            if (!canEditProcessingNode(node)) return;
            const editSequence = ++dimensionEditSequence;
            const isCurrent = () => canEditProcessingNode(node) && editSequence === dimensionEditSequence;
            persistControls();
            const synced = await syncAspectLinkedDimension(id, 'height', isCurrent);
            if (synced === false || !isCurrent()) return;
            persistControls();
            queuePreviewRefresh();
        });
        keepAspectInput?.addEventListener('change', async () => {
            if (!canEditProcessingNode(node)) return;
            const editSequence = ++dimensionEditSequence;
            const isCurrent = () => canEditProcessingNode(node) && editSequence === dimensionEditSequence;
            persistControls();
            if (keepAspectInput.checked && widthInput?.value) {
                if (await syncAspectLinkedDimension(id, 'width', isCurrent) === false) return;
            }
            if (!isCurrent()) return;
            persistControls();
            void refreshImageResizePreview(id);
        });

        previewContainer?.addEventListener('click', (e) => {
            if (el.classList.contains('image-first-card') && e.detail !== 2) return;
            e.stopPropagation();
            if (state.justDragged) return;
            void openStoredImageNodeFullscreen(id);
        });

        const persistedPreviewThumbnail = typeof node?.data?.imagePreviewThumbnail === 'string'
            ? node.data.imagePreviewThumbnail.trim()
            : '';

        if (node?.imageData) {
            renderImageResizeResult(id, {
                dataUrl: node.imageData,
                originalWidth: node.originalWidth || 0,
                originalHeight: node.originalHeight || 0,
                outputWidth: node.outputWidth || 0,
                outputHeight: node.outputHeight || 0,
                outputFormat: node.outputFormat || '',
                outputQuality: node.outputQuality || null,
                estimatedBytes: node.estimatedBytes || estimateDataUrlSize(node.imageData)
            });
        } else if (persistedPreviewThumbnail) {
            renderImageResizeResult(id, {
                dataUrl: persistedPreviewThumbnail,
                originalWidth: node?.originalWidth || 0,
                originalHeight: node?.originalHeight || 0,
                outputWidth: node?.outputWidth || 0,
                outputHeight: node?.outputHeight || 0,
                outputFormat: node?.outputFormat || '',
                outputQuality: node?.outputQuality || null,
                estimatedBytes: node?.estimatedBytes || null
            });
        } else {
            queuePreviewRefresh(0);
        }

        requestNodeFit(id);
    }

    function restoreImageResizePreview(nodeId, dataUrl, meta = {}) {
        const node = getNodeById(nodeId);
        if (!node || !dataUrl) {
            renderImageResizeEmptyState(nodeId);
            return;
        }

        const result = {
            dataUrl,
            originalWidth: meta.originalWidth || node.originalWidth || 0,
            originalHeight: meta.originalHeight || node.originalHeight || 0,
            outputWidth: meta.outputWidth || 0,
            outputHeight: meta.outputHeight || 0,
            outputFormat: meta.outputFormat || node.outputFormat || '',
            outputQuality: meta.outputQuality || null,
            estimatedBytes: meta.estimatedBytes || estimateDataUrlSize(dataUrl)
        };
        setDerivedImagePreview(node, dataUrl);
        node.resizePreviewMeta = result;
        node.data = node.data || {};
        node.data.image = dataUrl;
        node.imageData = dataUrl;
        node.imageDataList = [dataUrl];
        renderImageResizeResult(nodeId, result);
    }

    function setupImageSave(id, el) {
        const previewContainer = queryNodeControl(el, `#${id}-save-preview`);
        const manualSaveBtn = queryNodeControl(el, `#${id}-manual-save`);
        if (!previewContainer) return;
        const boundNode = getNodeById(id);

        const stepPreview = (delta, event) => {
            event?.stopPropagation();
            void stepImageSaveNodeByDelta(id, delta);
        };

        const openSaveImagePreview = async () => {
            const node = getNodeById(id);
            const video = getStoredSaveVideo(node);
            if (getProcessingNodeElement(id, 'save-preview')?.dataset.saveMode === 'video' || (!getStoredImageCount(node) && video)) {
                const source = getVideoPreviewSource(video);
                if (source) windowRef.open(source, '_blank', 'noopener,noreferrer');
                else showToast('本地视频原文件缺失，请恢复后再查看', 'warning');
                return;
            }
            const index = node?.imagePreviewIndex || 0, assets = getNodeMediaAssetKeys(node);
            if (node.data?.mediaIntegrity?.missingItems?.some(item => item.position === index)) return showToast('当前原图缺失，请恢复后再查看', 'warning');
            const image = assets[index] ? await getImageAsset(assets[index]) : getCurrentImageSavePreviewImage(node);
            if (getNodeById(id) !== node) return;
            if (assets[index] && !image) return showToast('当前原图缺失，请恢复后再查看', 'warning');
            if (image) {
                await openFullscreenPreview(image, id);
                return;
            }
            await openStoredImageNodeFullscreen(id);
        };

        bindPreviewKeyboardNavigation(
            previewContainer,
            async () => {
                if (getNodeById(id) !== boundNode) return [];
                const images = await getStoredImageSaveListAsync(boundNode);
                return getNodeById(id) === boundNode ? getPreviewSlotImages(boundNode, images) : [];
            },
            (images) => getImageSavePreviewIndex(boundNode, images),
            (nextIndex, images, event) => {
                event?.stopPropagation();
                const node = getNodeById(id);
                if (!node || node !== boundNode) return;
                node.imagePreviewIndex = nextIndex;
                renderImageSavePreview(id, images);
                void showResolutionBadge(id, images[nextIndex]);
                scheduleSave();
            },
            { preserveSlots: true }
        );

        previewContainer.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.image-save-preview-nav, video, .image-save-preview-tools')) {
                e.stopPropagation();
            }
        });
        previewContainer.addEventListener('mousedown', e => { if (e.target.closest('video, .image-save-preview-tools')) e.stopPropagation(); });

        previewContainer.addEventListener('click', (e) => {
            const navButton = e.target.closest('.image-save-preview-nav');
            if (!navButton) return;
            stepPreview(parseInt(navButton.dataset.direction || '0', 10) || 0, e);
        });

        manualSaveBtn?.addEventListener('click', async () => {
            const node = getNodeById(id);
            if (!node) return;
            try {
                const images = await getStoredImageSaveListAsync(node), videos = getStoredSaveVideos(node);
                if (getNodeById(id) !== node) return;
                if (!images.length && !videos.length) return showToast('没有可保存的内容', 'warning');
                if (node.data?.mediaIntegrity?.missingItems?.length) return showToast('完整原图存在缺失，请恢复原图后再保存；引用位置已保留', 'warning');
                const filename = readImageSaveFilename(node, '') || 'image';
                const desktop = windowRef.__cainflowDesktop?.saveFile ? windowRef.__cainflowDesktop : null;
                const imageBases = buildImageSaveFilenameBases_local(id, images, filename);
                let savedImages = 0, savedVideos = 0;
                for (const [index, image] of images.entries()) {
                    if (desktop) { if (await desktop.saveFile(`${imageBases[index]}.png`, 'image/png', image)) savedImages++; continue; }
                    const blob = dataURLtoBlob(image), url = URL.createObjectURL(new Blob([blob], { type: 'image/png' }));
                    const link = documentRef.createElement('a'); link.href = url; link.download = `${imageBases[index]}.png`;
                    documentRef.body.appendChild(link); link.click(); savedImages++;
                    windowRef.setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 100);
                }
                for (const [index, video] of videos.entries()) {
                    const source = getVideoPreviewSource(video) || video.url;
                    if (!source) throw new Error('本地视频缺失，请恢复后再保存');
                    const blob = await downloadGeneratedVideo(source);
                    const base = buildVideoSaveFilenameBase_local(id, video, filename || 'video');
                    const name = `${base}${videos.length > 1 ? `_${index + 1}` : ''}${detectVideoExtensionFromSource(video, blob)}`;
                    if (desktop) { if (await desktop.saveFile(name, blob.type || 'video/mp4', blob)) savedVideos++; continue; }
                    const url = URL.createObjectURL(blob);
                    const link = documentRef.createElement('a'); link.href = url; link.download = name; link.rel = 'noopener noreferrer';
                    documentRef.body.appendChild(link); link.click(); savedVideos++;
                    windowRef.setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 100);
                    addLog('info', '视频手动下载已发起', '浏览器已直接发起视频下载请求。', { sourceVideoUrl: source, filenameBase: base });
                }
                if (savedImages || savedVideos) showToast(`已${desktop ? '保存' : '发起保存'} ${savedImages} 张图片和 ${savedVideos} 个视频`, 'success');
            } catch (error) { showToast('保存失败: ' + (error?.message || String(error)), 'error'); }
        });

        previewContainer.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.justDragged) return;
            if (e.target.closest('.image-save-preview-nav')) return;
            if (e.target.closest('video, .image-save-preview-tools, .image-preview-batch-navigation')) return;
            const node = getNodeById(id);
            if (node?.imageFirstMediaDragged) return;
            if (node?.parameterRoot && e.detail < 2) { node.onImageFirstSelect?.(); return; }
            void openSaveImagePreview();
        });

        queryNodeControl(el, `#${id}-view-full`)?.addEventListener('click', (e) => {
            e.stopPropagation();
            void openSaveImagePreview();
        });
        const node = getNodeById(id);
        if (node?.el === el && previewContainer.querySelector) {
            renderImageSavePreview(id, getStoredImageSaveList(node));
            const rerender = () => { if (getNodeById(id) === node) renderImageSavePreview(id, getStoredImageSaveList(node)); };
            node.onImageSaveRendered = rerender;
            (el._cleanupFns ||= []).push(() => { if (node.onImageSaveRendered === rerender) delete node.onImageSaveRendered; imagePreviewBatchNavigation?.destroy(node); });
        }
    }

    async function autoSaveToDir(nodeId, dataUrl) {
        const node = getNodeById(nodeId);
        if (!node) return;
        const images = normalizeImageList(dataUrl?.images ?? dataUrl);
        const videos = (Array.isArray(dataUrl?.videos) ? dataUrl.videos : [dataUrl?.video])
            .filter((video) => video && typeof video === 'object' && (video.url || video.assetKey))
            .map(video => ({ ...video, url: getVideoPreviewSource(video) || video.url }));
        const video = videos[videos.length - 1] || null;
        try {
            const prefix = node.type === 'ImageSave' ? readImageSaveFilename(node, '') || (video?.url ? 'video' : 'image')
                : documentRef.getElementById(`${nodeId}-filename`)?.value || (video?.url ? 'video' : 'image');
            const result = await saveGeneratedMediaToDirectory({
                payload: videos.length ? { images, videos, video } : dataUrl, directoryHandle: state.globalSaveDirHandle, filenamePrefix: prefix,
                dataURLtoBlob, downloadVideo: downloadGeneratedVideo,
                buildImageFilenameBases: (items, name) => buildImageSaveFilenameBases_local(nodeId, items, name, { includeTimestamp: true }),
                buildVideoFilenameBase: (currentVideo, name) => buildVideoSaveFilenameBase_local(nodeId, currentVideo, name, { includeTimestamp: true }),
                detectVideoExtension: detectVideoExtensionFromSource, getAvailableFileHandle,
                onVideoProgress: ({ index, videoCount, stage, loaded = 0, total: contentLength = 0, speedBytesPerSecond = 0, filename }) => {
                    if (stage === 'complete') return completeVideoAutoSaveToast(nodeId, videoCount > 1 ? `已自动保存 ${index + 1}/${videoCount}：${filename}` : `视频已自动保存：${filename}`);
                    updateVideoAutoSaveToast(nodeId, { subtitle: videoCount > 1 ? `正在保存视频 ${index + 1}/${videoCount}...` : '正在通过后端下载视频并保存到目录...', stage: stage === 'writing' ? '写入目录中' : '后端下载中', loaded, total: contentLength, status: stage === 'writing' ? '写入中' : '下载中', speedBytesPerSecond });
                }
            });
            if (result.status === 'empty') return;
            if (result.status === 'missing-directory') {
                showToast('自动保存提醒：尚未在通用设置中选择全局保存目录，内容仅保存在节点内', 'warning', 5000);
                addLog('warning', '自动保存跳过', '未在通用设置中配置保存路径', { nodeId });
                return;
            }
            if (result.status === 'permission-denied') {
                showToast('【自动保存失败】目录访问权限被拒绝', 'error');
                addLog('error', '自动保存失败', '权限被拒绝', { nodeId });
                return;
            }
            const savedFilenames = result.filenames;
            showToast(
                images.length > 0 && videos.length > 0
                    ? `已自动保存 ${images.length} 张图片和 ${videos.length} 个视频`
                    : (images.length > 1
                        ? `已自动保存 ${images.length} 张图片`
                        : (images.length === 1
                            ? `图片已自动保存: ${savedFilenames[0]}`
                            : (videos.length > 1 ? `已自动保存 ${videos.length} 个视频` : `视频已自动保存: ${savedFilenames[0]}`))),
                'success'
            );
            addLog('success', '自动保存成功', `已保存至: ${state.globalSaveDirHandle.name}/${savedFilenames.join(', ')}`);
        } catch (err) {
            if (video?.url) failVideoAutoSaveToast(nodeId, `视频自动保存失败：${err.message}`);
            console.error('Auto-save error:', err);
            showToast('自动保存出错: ' + err.message, 'error', 5000);
            addLog('error', '自动保存异常', err.message, { nodeId, error: err.stack || err });
        }
    }

    function setupImagePreview(id, el) {
        const nodeType = getNodeById(id)?.type;
        const previewContainer = queryNodeControl(el, `#${id}-${nodeType === 'ImageMerge' ? 'merge-preview' : 'preview'}`);
        const zoomInBtn = queryNodeControl(el, `#${id}-zoom-in`);
        const zoomOutBtn = queryNodeControl(el, `#${id}-zoom-out`);
        const zoomResetBtn = queryNodeControl(el, `#${id}-zoom-reset`);
        const fullscreenBtn = queryNodeControl(el, `#${id}-fullscreen`);
        if (!previewContainer) return;

        const stepPreview = async (delta, event) => {
            event?.stopPropagation();
            await stepImagePreviewNodeByDelta(id, delta);
        };

        const openPreviewImage = async () => {
            const node = getNodeById(id);
            const missing = (node?.data?.mediaIntegrity?.missingItems || []).some(item => Number(item.position) === node.imagePreviewIndex);
            if (missing) { showToast('当前原图缺失，请恢复后再查看。', 'warning'); return; }
            const assets = getNodeMediaAssetKeys(node);
            const assetKey = assets[node?.imagePreviewIndex || 0];
            const image = assetKey ? await getImageAsset(assetKey) : getCurrentImagePreviewImage(node);
            if (getNodeById(id) !== node) return;
            if (assetKey && !image) { showToast('当前原图缺失，请恢复后再查看。', 'warning'); return; }
            if (image) {
                await openFullscreenPreview(image, id);
                return;
            }
            await openStoredImageNodeFullscreen(id);
        };

        bindPreviewKeyboardNavigation(
            previewContainer,
            async () => {
                const node = getNodeById(id);
                if (node?.type === 'ImageMerge' && getNodeMediaAssetKeys(node).length) return Array(getNodeMediaAssetKeys(node).length).fill('');
                const images = await getStoredImagePreviewListAsync(node);
                return getNodeById(id) === node ? getPreviewSlotImages(node, images) : [];
            },
            (images) => getImagePreviewIndex(getNodeById(id), images),
            (nextIndex, images, event) => {
                event?.stopPropagation();
                const node = getNodeById(id);
                if (!node) return;
                if (node.type === 'ImageMerge' && getNodeMediaAssetKeys(node).length) {
                    void selectMergePreviewSlot(node, nextIndex); scheduleSave(); return;
                }
                node.imagePreviewIndex = nextIndex;
                node.previewZoom = 1;
                renderImagePreviewImage(id, images);
                const image = images[nextIndex];
                if (image) {
                    const syncPreview = async () => {
                        await showResolutionBadge(id, image);
                    };
                    void syncPreview();
                }
                scheduleSave();
            },
            { preserveSlots: true }
        );

        previewContainer.addEventListener('click', event => {
            const counter = event.target.closest('.image-save-preview-counter');
            const node = getNodeById(id);
            if (!counter || counter.tagName === 'BUTTON' || !node?.parameterRoot) return;
            event.preventDefault(); event.stopImmediatePropagation();
            getPreviewBatchNavigation().render(node, previewContainer);
            previewContainer.querySelector('.image-save-preview-counter')?.click();
        }, true);

        previewContainer.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.image-save-preview-nav')) {
                e.stopPropagation();
            }
        });

        previewContainer.addEventListener('click', (e) => {
            const navButton = e.target.closest('.image-save-preview-nav');
            if (!navButton) return;
            void stepPreview(parseInt(navButton.dataset.direction || '0', 10) || 0, e);
        });

        zoomInBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            adjustPreviewZoom(id, 1.25);
        });
        zoomOutBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            adjustPreviewZoom(id, 0.8);
        });
        zoomResetBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            const node = getNodeById(id);
            if (node) node.previewZoom = 1;
            const img = previewContainer.querySelector(':scope > img');
            if (img) img.style.transform = 'scale(1)';
            scheduleSave();
        });
        previewContainer.addEventListener('click', (e) => {
            e.stopPropagation();
            const node = getNodeById(id);
            if (state.justDragged || node?.imageFirstMediaDragged) return;
            if (e.target.closest('.image-save-preview-nav')) return;
            if (node?.parameterRoot && e.detail < 2) { node.onImageFirstSelect?.(); return; }
            void openPreviewImage();
        });
        fullscreenBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            void openPreviewImage();
        });
        const node = getNodeById(id);
        if (node?.el === el) {
            const refreshPresentation = () => {
                if (getNodeById(id) === node) renderImagePreviewImage(id, getStoredImagePreviewList(node));
            };
            node.onImagePreviewRendered = refreshPresentation;
            (el._cleanupFns ||= []).push(() => {
                if (node.onImagePreviewRendered === refreshPresentation) delete node.onImagePreviewRendered;
                imagePreviewBatchNavigation?.destroy(node);
                mergePreviewSlots.delete(node);
            });
            if (getStoredImageCount(node) > 0) refreshPresentation();
        }
    }

    function getAdvancedCompareSourceLabel(node) {
        if (!node) return '图片';
        if (node.type === 'ImageImport') return '用户输入';
        if (node.type === 'ImageGenerate') return '生成结果';
        if (node.type === 'ImageResize') return '缩放结果';
        if (node.type === 'ImagePreview') return '预览图片';
        if (node.type === 'ImageSave') return '保存节点';
        if (node.type === 'ImageCompare') return '对比输出';
        return '节点图片';
    }

    async function collectAdvancedCompareImages(nodeId, compareInputs = null) {
        const node = getNodeById(nodeId);
        const resolvedInputs = compareInputs || await resolveAdvancedCompareInputImages(nodeId, node);
        const items = [];
        const seen = new Set();
        const sceneNodes = state.nodes instanceof Map
            ? Array.from(state.nodes.values())
            : Array.from(state.nodes || []);
        const addItem = ({ image, thumb = null, label, source = '', historyId = null, role = '', group = 'input' }) => {
            const key = typeof image === 'string' && image.trim()
                ? image.trim()
                : (historyId !== null && historyId !== undefined ? `history:${historyId}` : '');
            if (!key) return;
            if (seen.has(key)) return;
            seen.add(key);
            items.push({
                image: typeof image === 'string' ? image.trim() : '',
                thumb: thumb || image || '',
                label: label || '图片',
                source,
                historyId,
                role,
                group
            });
        };

        addItem({ image: resolvedInputs.imageA, label: '当前 A', source: '图片对比节点', role: 'A', group: 'input' });
        addItem({ image: resolvedInputs.imageB, label: '当前 B', source: '图片对比节点', role: 'B', group: 'input' });

        try {
            const nodeImageGroups = await Promise.all(sceneNodes.map(async (entry) => {
                try {
                    const imageList = normalizeImageList(await getStoredImagePreviewListAsync(entry));
                    return { entry, imageList };
                } catch (error) {
                    console.warn('Load cached compare input images failed:', error);
                    return { entry, imageList: [] };
                }
            }));

            nodeImageGroups.forEach(({ entry, imageList }) => {
                if (!imageList.length) return;
                const baseLabel = getAdvancedCompareSourceLabel(entry);
                const sourceLabel = entry.id === nodeId ? '当前节点缓存' : `节点 ${entry.id} 缓存`;
                const persistedThumb = typeof entry?.data?.imagePreviewThumbnail === 'string'
                    ? entry.data.imagePreviewThumbnail.trim()
                    : '';

                imageList.forEach((image, index) => {
                    addItem({
                        image,
                        thumb: imageList.length === 1 && persistedThumb ? persistedThumb : image,
                        label: imageList.length > 1 ? `${baseLabel} ${index + 1}/${imageList.length}` : baseLabel,
                        source: sourceLabel,
                        group: 'input'
                    });
                });
            });
        } catch (error) {
            console.warn('Collect scene compare input images failed:', error);
        }

        try {
            const historyItems = typeof getHistoryMetadata === 'function'
                ? await getHistoryMetadata({ limit: 160 })
                : [];
            historyItems.forEach((item, index) => {
                if (item.mediaType === 'video' || item.hasVideo) return;
                addItem({
                    image: '',
                    thumb: item.thumb || '',
                    label: '历史记录',
                    source: item.timestamp ? new Date(item.timestamp).toLocaleString() : `第 ${index + 1} 张`,
                    historyId: item.id ?? null,
                    group: 'history'
                });
            });
        } catch (error) {
            console.warn('Load compare history failed:', error);
            showToast('读取历史图片失败', 'error', 3000);
        }

        return items;
    }

    function openAdvancedImageCompare(nodeId) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImageCompare') return;
        const persistedPreviewThumbnail = typeof node?.data?.imagePreviewThumbnail === 'string'
            ? node.data.imagePreviewThumbnail.trim()
            : '';

        const overlay = documentRef.createElement('div');
        overlay.className = 'image-compare-advanced-overlay';
        overlay.innerHTML = `
            <button type="button" class="image-compare-advanced-close" title="关闭 (Esc)">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <div class="image-compare-advanced-shell">
                <div class="image-compare-advanced-stage" style="--compare-x: 50%;">
                    <div class="image-compare-advanced-empty">正在加载图片...</div>
                </div>
                <div class="image-compare-advanced-picker">
                    <div class="image-compare-advanced-actions">
                        <div class="image-compare-advanced-status">选择一张缩略图</div>
                        <div class="image-compare-advanced-buttons">
                            <button type="button" class="image-compare-expand-btn" title="展开图片选择">展开选择</button>
                            <button type="button" class="image-compare-set-btn" data-role="A" disabled>设置为 A</button>
                            <button type="button" class="image-compare-set-btn" data-role="B" disabled>设置为 B</button>
                        </div>
                    </div>
                    <div class="image-compare-advanced-thumbs"></div>
                </div>
            </div>
            <div class="image-compare-thumb-context-menu" role="menu" aria-hidden="true">
                <button type="button" role="menuitem" data-role="A">设置为 A</button>
                <button type="button" role="menuitem" data-role="B">设置为 B</button>
            </div>
        `;
        documentRef.body.appendChild(overlay);
        documentRef.body?.classList.add('image-compare-advanced-active');

        const shell = overlay.querySelector('.image-compare-advanced-shell');
        const stage = overlay.querySelector('.image-compare-advanced-stage');
        const status = overlay.querySelector('.image-compare-advanced-status');
        const thumbs = overlay.querySelector('.image-compare-advanced-thumbs');
        const expandButton = overlay.querySelector('.image-compare-expand-btn');
        const setButtons = Array.from(overlay.querySelectorAll('.image-compare-set-btn'));
        const thumbContextMenu = overlay.querySelector('.image-compare-thumb-context-menu');
        let compareA = node.compareImageA || node.data?.compareImageA || getConnectedImageInput(nodeId, 'imageA') || null;
        let compareB = node.compareImageB
            || node.data?.compareImageB
            || node.data?.image
            || node.imageData
            || persistedPreviewThumbnail
            || getConnectedImageInput(nodeId, 'imageB')
            || null;
        let selectedIndex = -1;
        let items = [];
        let isPickerExpanded = false;
        let compareZoom = 1;
        let compareOffsetX = 0;
        let compareOffsetY = 0;
        let isPanning = false;
        let panStart = { x: 0, y: 0 };

        const applyStageTransform = () => {
            stage.style.setProperty('--compare-zoom', compareZoom.toFixed(4));
            stage.style.setProperty('--compare-pan-x', `${compareOffsetX.toFixed(2)}px`);
            stage.style.setProperty('--compare-pan-y', `${compareOffsetY.toFixed(2)}px`);
        };

        const closeThumbContextMenu = () => {
            if (!thumbContextMenu) return;
            thumbContextMenu.classList.remove('active');
            thumbContextMenu.setAttribute('aria-hidden', 'true');
        };

        const openThumbContextMenu = (event) => {
            if (!thumbContextMenu) return;
            const menuWidth = 148;
            const menuHeight = 84;
            const edgeGap = 8;
            const viewportWidth = windowRef.innerWidth || documentRef.documentElement?.clientWidth || menuWidth;
            const viewportHeight = windowRef.innerHeight || documentRef.documentElement?.clientHeight || menuHeight;
            const left = Math.max(edgeGap, Math.min(event.clientX, viewportWidth - menuWidth - edgeGap));
            const top = Math.max(edgeGap, Math.min(event.clientY, viewportHeight - menuHeight - edgeGap));
            thumbContextMenu.style.left = `${left}px`;
            thumbContextMenu.style.top = `${top}px`;
            thumbContextMenu.classList.add('active');
            thumbContextMenu.setAttribute('aria-hidden', 'false');
        };

        const createThumbButton = (item, index) => {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.className = `image-compare-thumb${index === selectedIndex ? ' selected' : ''}`;
            button.title = `${item.label}${item.source ? ` - ${item.source}` : ''}`;
            button.addEventListener('click', () => {
                closeThumbContextMenu();
                selectedIndex = index;
                renderThumbs();
            });
            button.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                selectedIndex = index;
                renderThumbs();
                openThumbContextMenu(event);
            });

            const img = documentRef.createElement('img');
            img.src = item.thumb || TRANSPARENT_PREVIEW_PIXEL;
            img.alt = item.label;
            img.loading = 'lazy';
            img.decoding = 'async';
            button.appendChild(img);

            const roleBadges = [];
            if (item.image && compareA && item.image === compareA) roleBadges.push('A');
            if (item.image && compareB && item.image === compareB) roleBadges.push('B');
            if (roleBadges.length) {
                const badgeWrap = documentRef.createElement('div');
                badgeWrap.className = 'image-compare-thumb-badges';
                roleBadges.forEach((roleBadge) => {
                    const badge = documentRef.createElement('span');
                    badge.className = `image-compare-thumb-badge image-compare-thumb-badge-${roleBadge.toLowerCase()}`;
                    const badgeText = documentRef.createElement('span');
                    badgeText.className = 'image-compare-thumb-badge-text';
                    badgeText.textContent = roleBadge;
                    badge.appendChild(badgeText);
                    badgeWrap.appendChild(badge);
                });
                button.appendChild(badgeWrap);
            }

            const label = documentRef.createElement('span');
            label.innerHTML = escapeHtml(item.label);
            button.appendChild(label);
            return button;
        };

        const updateStagePosition = (event) => {
            if (!compareA || !compareB) return;
            const rect = stage.getBoundingClientRect();
            const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
            const percent = Math.max(0, Math.min(100, ratio * 100));
            stage.style.setProperty('--compare-x', `${percent}%`);
            stage.classList.add('is-comparing');
        };

        const renderStage = () => {
            stage.classList.toggle('has-a-image', Boolean(compareA && compareB));
            stage.classList.toggle('is-single-image', Boolean((compareA || compareB) && !(compareA && compareB)));
            stage.classList.remove('is-comparing');
            stage.style.setProperty('--compare-x', '50%');
            stage.innerHTML = '';
            applyStageTransform();

            if (!compareA && !compareB) {
                stage.innerHTML = '<div class="image-compare-advanced-empty">从下方选择图片并设置为 A 或 B</div>';
                return;
            }

            const appendCompareImage = (className, src, alt) => {
                const layer = documentRef.createElement('div');
                layer.className = `image-compare-advanced-layer ${className}`;
                const img = documentRef.createElement('img');
                img.className = 'image-compare-advanced-img';
                img.src = src;
                img.alt = alt;
                img.draggable = false;
                layer.appendChild(img);
                stage.appendChild(layer);
            };

            const baseImage = compareB || compareA;
            appendCompareImage('image-compare-advanced-b-layer', baseImage, compareB ? 'B 对比图' : '对比图');

            if (compareA && compareB) {
                appendCompareImage('image-compare-advanced-a-layer', compareA, 'A 对比图');

                const divider = documentRef.createElement('div');
                divider.className = 'image-compare-advanced-divider';
                divider.setAttribute('aria-hidden', 'true');
                stage.appendChild(divider);
            }
        };

        const renderThumbs = () => {
            thumbs.innerHTML = '';
            if (!items.length) {
                thumbs.innerHTML = '<div class="image-compare-advanced-empty-thumb">暂无可选择图片</div>';
                setButtons.forEach((button) => { button.disabled = true; });
                status.textContent = '没有找到图片';
                return;
            }

            setButtons.forEach((button) => { button.disabled = selectedIndex < 0; });
            const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : null;
            status.textContent = selectedItem
                ? `${selectedItem.label}`
                : `共 ${items.length} 张图片`;

            if (!isPickerExpanded) {
                items.forEach((item, index) => {
                    thumbs.appendChild(createThumbButton(item, index));
                });
                return;
            }

            [
                { key: 'input', title: '输入' },
                { key: 'history', title: '历史记录' }
            ].forEach((groupConfig) => {
                const groupEntries = items
                    .map((item, index) => ({ item, index }))
                    .filter(({ item }) => item.group === groupConfig.key);
                if (!groupEntries.length) return;

                const section = documentRef.createElement('section');
                section.className = 'image-compare-advanced-group';
                section.dataset.group = groupConfig.key;

                const heading = documentRef.createElement('div');
                heading.className = 'image-compare-advanced-group-title';
                heading.textContent = groupConfig.title;
                section.appendChild(heading);

                const list = documentRef.createElement('div');
                list.className = 'image-compare-advanced-group-list';
                groupEntries.forEach(({ item, index }) => {
                    list.appendChild(createThumbButton(item, index));
                });
                section.appendChild(list);
                thumbs.appendChild(section);
            });
        };

        const resolveSelectedImage = async () => {
            const selected = items[selectedIndex];
            if (!selected) return '';
            if (selected.image) return selected.image;
            if (selected.historyId === null || selected.historyId === undefined || typeof getHistoryEntry !== 'function') {
                return '';
            }
            const entry = await getHistoryEntry(selected.historyId);
            const image = entry?.image || '';
            if (image) selected.image = image;
            return image;
        };

        const setSelectedImage = async (role) => {
            const image = await resolveSelectedImage();
            if (!image) {
                showToast('读取原图失败', 'error', 3000);
                return;
            }
            if (role === 'A') compareA = image;
            if (role === 'B') compareB = image;
            renderStage();
            renderThumbs();
        };

        setButtons.forEach((button) => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                void setSelectedImage(button.dataset.role);
            });
        });
        thumbContextMenu?.addEventListener('click', (event) => {
            const menuItem = event.target.closest('button[data-role]');
            if (!menuItem) return;
            event.stopPropagation();
            closeThumbContextMenu();
            void setSelectedImage(menuItem.dataset.role);
        });
        overlay.addEventListener('pointerdown', (event) => {
            if (!thumbContextMenu?.classList.contains('active')) return;
            if (thumbContextMenu.contains(event.target)) return;
            closeThumbContextMenu();
        });
        expandButton?.addEventListener('click', (event) => {
            event.stopPropagation();
            isPickerExpanded = !isPickerExpanded;
            overlay.classList.toggle('is-picker-expanded', isPickerExpanded);
            if (shell) shell.classList.toggle('is-picker-expanded', isPickerExpanded);
            expandButton.textContent = isPickerExpanded ? '收起选择' : '展开选择';
            expandButton.title = isPickerExpanded ? '收起图片选择' : '展开图片选择';
            renderThumbs();
        });
        thumbs.addEventListener('wheel', (event) => {
            if (isPickerExpanded) return;
            if (thumbs.scrollWidth <= thumbs.clientWidth + 1) return;

            const primaryDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
                ? event.deltaX
                : event.deltaY;
            if (!primaryDelta) return;

            const maxScrollLeft = Math.max(0, thumbs.scrollWidth - thumbs.clientWidth);
            const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, thumbs.scrollLeft + primaryDelta));
            if (Math.abs(nextScrollLeft - thumbs.scrollLeft) < 0.5) return;

            event.preventDefault();
            thumbs.scrollLeft = nextScrollLeft;
        }, { passive: false });

        stage.addEventListener('mousemove', updateStagePosition);
        stage.addEventListener('mouseenter', () => {
            if (compareA && compareB) stage.classList.add('is-comparing');
        });
        stage.addEventListener('mouseleave', () => {
            stage.classList.remove('is-comparing');
        });
        stage.addEventListener('wheel', (event) => {
            if (!compareA && !compareB) return;
            event.preventDefault();
            const nextZoom = Math.max(0.2, Math.min(12, compareZoom * (event.deltaY > 0 ? 0.9 : 1.1)));
            if (nextZoom === compareZoom) return;
            const rect = stage.getBoundingClientRect();
            const cursorX = event.clientX - rect.left - rect.width / 2;
            const cursorY = event.clientY - rect.top - rect.height / 2;
            const zoomRatio = nextZoom / compareZoom;
            compareOffsetX = cursorX - (cursorX - compareOffsetX) * zoomRatio;
            compareOffsetY = cursorY - (cursorY - compareOffsetY) * zoomRatio;
            compareZoom = nextZoom;
            applyStageTransform();
        }, { passive: false });
        stage.addEventListener('mousedown', (event) => {
            if (event.button !== 0 || (!compareA && !compareB)) return;
            event.preventDefault();
            isPanning = true;
            panStart = {
                x: event.clientX - compareOffsetX,
                y: event.clientY - compareOffsetY
            };
            stage.classList.add('is-panning');
        });
        const onPanMove = (event) => {
            if (!isPanning) return;
            compareOffsetX = event.clientX - panStart.x;
            compareOffsetY = event.clientY - panStart.y;
            applyStageTransform();
            updateStagePosition(event);
        };
        const stopPanning = () => {
            isPanning = false;
            stage.classList.remove('is-panning');
        };
        windowRef.addEventListener('mousemove', onPanMove);
        windowRef.addEventListener('mouseup', stopPanning);

        const cleanup = () => {
            overlay.remove();
            if (!documentRef.querySelector('.image-compare-advanced-overlay')) {
                documentRef.body?.classList.remove('image-compare-advanced-active');
            }
            documentRef.removeEventListener('keydown', onKeyDown);
            windowRef.removeEventListener('mousemove', onPanMove);
            windowRef.removeEventListener('mouseup', stopPanning);
        };
        const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            if (thumbContextMenu?.classList.contains('active')) {
                closeThumbContextMenu();
                return;
            }
            cleanup();
        };
        overlay.querySelector('.image-compare-advanced-close').addEventListener('click', cleanup);
        documentRef.addEventListener('keydown', onKeyDown);
        getSurfaceCoordinator(documentRef)?.registerEscape(overlay, onKeyDown);

        requestAnimationFrame(() => overlay.classList.add('active'));
        applyStageTransform();
        renderStage();
        const compareInputsPromise = resolveAdvancedCompareInputImages(nodeId, node);
        const compareItemsPromise = compareInputsPromise.then((resolvedInputs) => collectAdvancedCompareImages(nodeId, resolvedInputs));

        compareInputsPromise.then((resolvedInputs) => {
            compareA = resolvedInputs.imageA || compareA || null;
            compareB = resolvedInputs.imageB || compareB || null;
            renderStage();
        }).catch((error) => {
            console.warn('Resolve advanced compare inputs failed:', error);
        });

        compareItemsPromise.then((nextItems) => {
            items = nextItems;

            const currentAItem = items.find((item) => item.role === 'A' && item.image);
            const currentBItem = items.find((item) => item.role === 'B' && item.image);
            if (!compareA && currentAItem?.image) compareA = currentAItem.image;
            if (!compareB && currentBItem?.image) compareB = currentBItem.image;
            if (!compareA && !compareB) {
                const firstImageItem = items.find((item) => item.image);
                if (firstImageItem?.image) compareB = firstImageItem.image;
            }

            selectedIndex = items.length ? 0 : -1;
            renderStage();
            renderThumbs();
        }).catch((error) => {
            console.warn('Load advanced compare images failed:', error);
            if (!items.length) selectedIndex = -1;
            renderThumbs();
        });
    }

    function setupImageCompare(id, el) {
        const node = getNodeById(id);
        const container = queryNodeControl(el, `#${id}-compare`);
        if (!container) return;
        const advancedBtn = queryNodeControl(el, `#${id}-advanced-compare`);
        const restoredPosition = getComparePosition(node);
        persistProcessingParameters(node, { comparePosition: restoredPosition });
        container.style.setProperty('--compare-x', `${restoredPosition}%`);
        let dividerDragging = false;
        let dividerGestureUntil = 0;
        const updateDivider = percent => {
            container.style.setProperty('--compare-x', `${percent}%`);
            container.classList.add('is-comparing');
            container.querySelector('.image-compare-divider')?.setAttribute('aria-valuenow', String(percent));
            persistProcessingParameters(node, { comparePosition: percent });
            scheduleSave();
        };
        container.addEventListener('mousedown', event => {
            if (!event.target?.closest?.('.image-compare-divider')) return;
            dividerDragging = true;
            dividerGestureUntil = Date.now() + 500;
            event.preventDefault(); event.stopPropagation();
        });
        container.addEventListener('mouseup', () => { dividerDragging = false; });
        container.addEventListener('keydown', event => {
            if (!event.target?.closest?.('.image-compare-divider') || getNodeById(id) !== node) return;
            const position = getComparePosition(node);
            const next = { ArrowLeft: position - 1, ArrowRight: position + 1, ArrowDown: position - 10, ArrowUp: position + 10, Home: 0, End: 100 }[event.key];
            if (next === undefined) return;
            event.preventDefault(); event.stopPropagation();
            updateDivider(Math.max(0, Math.min(100, next)));
        });

        container.addEventListener('mouseenter', () => {
            if (!container.classList.contains('has-a-image')) return;
            container.classList.add('is-comparing');
        });
        container.addEventListener('mousemove', (e) => {
            if (getNodeById(id) !== node || (state.dragging && !dividerDragging)) return;
            if (!container.classList.contains('has-a-image')) return;
            const rect = container.getBoundingClientRect();
            const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
            const percent = Math.max(0, Math.min(100, ratio * 100));
            if (dividerDragging) dividerGestureUntil = Date.now() + 500;
            updateDivider(percent);
        });
        container.addEventListener('mouseleave', () => {
            dividerDragging = false;
            container.classList.remove('is-comparing');
        });
        container.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.justDragged || Date.now() < dividerGestureUntil) return;
            if (e.detail >= 2 || !node?.onImageFirstSelect) void openStoredImageNodeFullscreen(id);
            else node.onImageFirstSelect();
        });
        advancedBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.justDragged) return;
            openAdvancedImageCompare(id);
        });

        const persistedPreviewThumbnail = typeof node?.data?.imagePreviewThumbnail === 'string'
            ? node.data.imagePreviewThumbnail.trim()
            : '';
        if (node?.compareImageB || node?.data?.compareImageB || node?.data?.image || persistedPreviewThumbnail) {
            const imageA = node.compareImageA || node.data?.compareImageA || null;
            const imageB = node.compareImageB || node.data?.compareImageB || node.data?.image || node.imageData || persistedPreviewThumbnail || null;
            node.compareImageA = imageA || null;
            if (node.compareImageB || node.data?.compareImageB || node.data?.image || node.imageData) {
                node.compareImageB = imageB || null;
            }
            renderImageComparePreview(id, imageA, imageB);
            if (!state.connections.some(connection => connection.to?.nodeId === id && connection.to?.port === 'imageB')) {
                setCompareInputState(node, 'stale', 'B 输入未连接有效原图，预览未更新');
            } else setCompareInputState(node, 'current');
            if (imageB) void showResolutionBadge(id, imageB);
            if (!imageA && persistedPreviewThumbnail && state.connections.some((conn) => conn.to?.nodeId === id && conn.to?.port === 'imageA')) {
                void getConnectedImageInputAsync(id, 'imageA').then((resolvedA) => {
                    const latestNode = getNodeById(id);
                    if (latestNode !== node) return;
                    const latestPreviewThumbnail = typeof latestNode.data?.imagePreviewThumbnail === 'string'
                        ? latestNode.data.imagePreviewThumbnail.trim()
                        : '';
                    const latestImageB = latestNode.compareImageB || latestNode.data?.compareImageB || latestNode.data?.image || latestNode.imageData || latestPreviewThumbnail || null;
                    if (!latestImageB) return;
                    latestNode.compareImageA = resolvedA || null;
                    if (resolvedA) latestNode.data.compareImageA = resolvedA;
                    else delete latestNode.data.compareImageA;
                    renderImageComparePreview(id, resolvedA || null, latestImageB);
                }).catch(() => {});
            }
        } else {
            void syncImageCompareNode(id);
        }
    }

    function adjustPreviewZoom(nodeId, factor) {
        const node = getNodeById(nodeId);
        if (!node) return;
        const img = getNodeElement(nodeId, 'preview')?.querySelector(':scope > img');
        if (!img) return;
        node.previewZoom = Math.max(0.2, Math.min(10, (node.previewZoom || 1) * factor));
        img.style.transform = `scale(${node.previewZoom})`;
        scheduleSave();
        img.style.transformOrigin = 'center center';
    }

    async function openFullscreenPreview(src, nodeId = null, options = {}) {
        const independentImages = Array.isArray(options.images) ? normalizeImageList(options.images) : null;
        // A retained Agent batch is immutable and may outlive its source node.
        // Supplying a batch must not resolve or edit that node's current output.
        if (independentImages) nodeId = null;
        displayImageMemoryManager.beginFullscreenPreview(nodeId);
        const overlay = documentRef.createElement('div');
        overlay.className = 'fullscreen-overlay fullscreen-ignore-chrome';
        overlay.tabIndex = -1;
        documentRef.body?.classList.add('preview-active');
        const context = nodeId ? await getNodeFullscreenImageContext(nodeId, src) : {
            node: null,
            images: independentImages || normalizeImageList(src),
            index: 0
        };
        if (context.cancelled) {
            displayImageMemoryManager.endFullscreenPreview(nodeId);
            if (!documentRef.querySelector('.fullscreen-overlay')) documentRef.body?.classList.remove('preview-active');
            return;
        }
        const images = context.images;
        let currentIndex = independentImages && Number.isInteger(options.index)
            ? Math.max(0, Math.min(images.length - 1, options.index))
            : images.findIndex((image) => image === src);
        if (currentIndex < 0) currentIndex = context.index;
        if (currentIndex < 0) currentIndex = 0;
        const canCropImageImport = Boolean(
            context.node?.type === 'ImageImport'
            && context.node.importMode !== 'url'
        );
        const canDescribe = Boolean(context.node || typeof options.onDescriptionChange === 'function');
        overlay.classList.toggle('has-paint-action', Boolean(nodeId));
        overlay.classList.toggle('has-crop-action', canCropImageImport);
        overlay.innerHTML = `
            <div class="preview-action-dock fullscreen-action-dock">
                <div class="preview-action-list" role="toolbar" aria-label="预览操作">
            <div class="fullscreen-close" title="关闭 (Esc)">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </div>
            <button type="button" class="fullscreen-copy-btn" title="复制图片到剪贴板" aria-label="复制图片到剪贴板">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            ${canDescribe ? '<button type="button" class="fullscreen-description-btn" title="添加图片介绍" aria-label="添加图片介绍">介绍</button>' : ''}
            ${nodeId ? `<div class="fullscreen-paint-btn" title="绘制/编辑">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </div>` : ''}
                </div>
                <button class="preview-action-reveal" type="button" aria-label="展开预览操作" aria-expanded="false" title="预览操作"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></button>
            </div>
            ${canDescribe ? `<div class="fullscreen-description-dialog hidden" role="dialog" aria-modal="true" aria-label="添加图片介绍">
                <label for="fullscreen-description-input">图片介绍</label>
                <textarea id="fullscreen-description-input" maxlength="2000" placeholder="描述图片中的主体、风格或用途"></textarea>
                <div class="fullscreen-description-actions">
                    <button type="button" class="fullscreen-description-cancel">取消</button>
                    <button type="button" class="fullscreen-description-confirm">确认</button>
                </div>
            </div>` : ''}
            <div class="fullscreen-image-context-menu hidden">
                <button type="button" class="fullscreen-image-copy-menu-item">复制图片</button>
            </div>
            ${renderFullscreenCropControls(canCropImageImport)}
            <div class="preview-zoom-controls" role="toolbar" aria-label="预览缩放">
                <button type="button" class="preview-zoom-out" title="缩小" aria-label="缩小"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg></button>
                <button type="button" class="preview-zoom-in" title="放大" aria-label="放大"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg></button>
                <button type="button" class="preview-zoom-fit" title="适应屏幕" aria-label="适应屏幕">适应</button>
            </div>
            <div class="fullscreen-stage">
                <div class="fullscreen-img-wrapper">
                    <img src="${images[currentIndex] || src}" alt="全屏预览" draggable="false" />
                    ${renderFullscreenCropLayer(canCropImageImport)}
                </div>
                ${images.length > 1 ? `
                <aside class="fullscreen-thumb-rail" aria-label="图片列表">
                    <div class="fullscreen-thumb-track"></div>
                </aside>` : ''}
            </div>`;
        documentRef.body.appendChild(overlay);
        overlay.querySelector('.preview-action-reveal').addEventListener('click', event => {
            const expanded = overlay.querySelector('.preview-action-dock').classList.toggle('is-expanded');
            event.currentTarget.setAttribute('aria-expanded', String(expanded));
        });
        const cropButton = overlay.querySelector('.fullscreen-crop-btn');
        if (cropButton) overlay.querySelector('.preview-action-list').appendChild(cropButton);
        const img = overlay.querySelector('img');
        const iw = overlay.querySelector('.fullscreen-img-wrapper');
        const imageContextMenu = overlay.querySelector('.fullscreen-image-context-menu');
        const descriptionButton = overlay.querySelector('.fullscreen-description-btn');
        const descriptionDialog = overlay.querySelector('.fullscreen-description-dialog');
        const descriptionInput = overlay.querySelector('#fullscreen-description-input');
        const thumbTrack = overlay.querySelector('.fullscreen-thumb-track');
        const thumbButtons = [];
        let fsZoom = 1;
        let fsX = 0;
        let fsY = 0;
        let isDragging = false;
        let dragStart = { x: 0, y: 0 };
        let previewIndexDirty = false;
        let cropper = null;
        const updateFsT = () => {
            img.style.transform = `translate(${fsX}px, ${fsY}px) scale(${fsZoom})`;
        };
        const resetTransform = () => {
            fsZoom = 1;
            fsX = 0;
            fsY = 0;
            updateFsT();
        };
        const changeZoom = factor => {
            if (cropper?.isActive()) return;
            fsZoom = Math.max(0.1, Math.min(20, fsZoom * factor));
            updateFsT();
        };
        overlay.querySelector('.preview-zoom-out').addEventListener('click', () => changeZoom(0.8));
        overlay.querySelector('.preview-zoom-in').addEventListener('click', () => changeZoom(1.25));
        overlay.querySelector('.preview-zoom-fit').addEventListener('click', resetTransform);
        const syncNodePreviewIndex = () => {
            if (!nodeId || !context.node) return;
            context.node.imagePreviewIndex = currentIndex;
            previewIndexDirty = true;
        };
        const flushNodePreviewState = () => {
            if (!nodeId || !context.node || !previewIndexDirty) return;
            context.node.imagePreviewIndex = currentIndex;
            if (isBatchPreviewNode(context.node) || context.node.type === 'ImageGenerate') {
                context.node.previewZoom = 1;
                renderImagePreviewImage(nodeId, images);
            } else if (context.node.type === 'ImageSave') {
                renderImageSavePreview(nodeId, images);
            }
            scheduleSave();
            previewIndexDirty = false;
        };
        const getCurrentCropSource = () => {
            if (!context.node || context.node.type !== 'ImageImport' || context.node.importMode === 'url') return '';
            const currentImage = images[currentIndex] || src || '';
            const candidates = normalizeImageList([
                currentImage,
                context.node.imageData,
                context.node.data?.image,
                context.node.imageDataList,
                context.node.data?.images
            ]);
            return candidates.find((candidate) => isInlineImageData(candidate)) || '';
        };
        cropper = createFullscreenImageCropper({
            overlay,
            imageElement: img,
            wrapperElement: iw,
            enabled: canCropImageImport,
            getSource: getCurrentCropSource,
            onApply: async (croppedData) => loadImageData(nodeId, croppedData),
            onApplied: (croppedData) => {
                images[currentIndex] = croppedData;
            },
            resetTransform,
            showToast,
            detectOutputFormat,
            isInlineImageData,
            documentRef,
            windowRef
        });
        cropper.updateAvailability();
        const centerActiveThumbnail = () => {
            if (!thumbTrack) return;
            const active = thumbTrack.querySelector('.fullscreen-thumb-item.is-active');
            if (!active) return;
            const trackRect = thumbTrack.getBoundingClientRect();
            const activeRect = active.getBoundingClientRect();
            const delta = activeRect.top - trackRect.top - (trackRect.height / 2) + (activeRect.height / 2);
            thumbTrack.scrollBy({ top: delta, behavior: 'smooth' });
        };
        const updateThumbnailRail = () => {
            if (!thumbTrack) return;
            if (thumbButtons.length === 0) {
                thumbTrack.innerHTML = '';
                images.forEach((imageSrc, index) => {
                    const button = documentRef.createElement('button');
                    button.type = 'button';
                    button.className = `fullscreen-thumb-item${index === currentIndex ? ' is-active' : ''}`;
                    button.title = `第 ${index + 1} 张`;
                    button.setAttribute('aria-label', `查看第 ${index + 1} 张图片`);
                    if (isSlottedPreviewNode(context.node) && !imageSrc) {
                        button.disabled = true; button.title += ' · 原图缺失';
                    }
                    button.addEventListener('click', (event) => {
                        event.stopPropagation();
                        if (index === currentIndex) return;
                        currentIndex = index;
                        renderCurrentImage();
                    });

                    const thumbImage = documentRef.createElement('img');
                    setImageElementSource(thumbImage, imageSrc, `缩略图 ${index + 1}`);
                    thumbImage.alt = `缩略图 ${index + 1}`;
                    button.appendChild(thumbImage);

                    const label = documentRef.createElement('span');
                    label.className = 'fullscreen-thumb-label';
                    label.textContent = `${index + 1}/${images.length}${button.disabled ? ' · 原图缺失' : ''}`;
                    button.appendChild(label);
                    thumbTrack.appendChild(button);
                    thumbButtons.push(button);
                });
            }

            thumbButtons.forEach((button, index) => {
                button.classList.toggle('is-active', index === currentIndex);
            });
            windowRef.requestAnimationFrame(centerActiveThumbnail);
        };
        const renderCurrentImage = () => {
            const nextSrc = images[currentIndex] || src;
            if (img.getAttribute('src') !== nextSrc) {
                img.src = nextSrc;
            }
            resetTransform();
            cropper?.setMode(false);
            cropper?.updateAvailability();
            syncNodePreviewIndex();
            updateThumbnailRail();
        };
        const stepFullscreenImage = (delta) => {
            if (images.length <= 1) return;
            let next = currentIndex;
            for (let offset = 0; offset < images.length; offset++) {
                next = (next + delta + images.length) % images.length;
                if (!isSlottedPreviewNode(context.node) || images[next]) break;
            }
            currentIndex = next;
            renderCurrentImage();
        };

        updateThumbnailRail();

        overlay.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (cropper?.isActive()) return;
            const nz = Math.max(0.1, Math.min(20, fsZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
            const rect = overlay.getBoundingClientRect();
            const cx = e.clientX - rect.left - rect.width / 2;
            const cy = e.clientY - rect.top - rect.height / 2;
            fsX = cx - (cx - fsX) * (nz / fsZoom);
            fsY = cy - (cy - fsY) * (nz / fsZoom);
            fsZoom = nz;
            updateFsT();
        }, { passive: false });
        let previewPress = null;
        let suppressBlankClick = false;
        overlay.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            previewPress = { x: e.clientX, y: e.clientY };
            suppressBlankClick = false;
        }, true);
        const trackPreviewDrag = (e) => {
            if (previewPress && Math.hypot(e.clientX - previewPress.x, e.clientY - previewPress.y) > 5) {
                // Latch the gesture even when the pointer returns to its starting point.
                suppressBlankClick = true;
            }
        };
        const stopPreviewDrag = () => {
            previewPress = null;
            isDragging = false;
            iw.style.cursor = 'grab';
        };
        const onBlur = () => {
            stopPreviewDrag();
            suppressBlankClick = false;
        };
        iw.addEventListener('mousedown', (e) => {
            if (cropper?.isActive()) return;
            if (e.button !== 0) return;
            e.preventDefault();
            isDragging = true;
            dragStart = { x: e.clientX - fsX, y: e.clientY - fsY };
            iw.style.cursor = 'grabbing';
        });
        const onMove = (e) => {
            // A release outside the window may not deliver mouseup to this window.
            if ((e.buttons & 1) === 0) {
                stopPreviewDrag();
                return;
            }
            trackPreviewDrag(e);
            if (!isDragging) return;
            fsX = e.clientX - dragStart.x;
            fsY = e.clientY - dragStart.y;
            updateFsT();
        };
        const onUp = (e) => {
            if (e.button !== 0) return;
            trackPreviewDrag(e);
            stopPreviewDrag();
        };
        windowRef.addEventListener('mousemove', onMove);
        windowRef.addEventListener('mouseup', onUp);
        windowRef.addEventListener('blur', onBlur);
        const cleanup = () => {
            if (nodeId) {
                displayImageMemoryManager.endFullscreenPreview(nodeId);
            }
            flushNodePreviewState();
            cropper?.cleanup();
            overlay.remove();
            if (!documentRef.querySelector('.fullscreen-overlay') && documentRef.getElementById('history-preview-modal')?.classList.contains('hidden') !== false) {
                documentRef.body?.classList.remove('preview-active');
            }
            windowRef.removeEventListener('mousemove', onMove);
            windowRef.removeEventListener('mouseup', onUp);
            windowRef.removeEventListener('blur', onBlur);
            documentRef.removeEventListener('keydown', onEsc);
            if (typeof options.onClose === 'function') queueMicrotask(options.onClose);
        };
        overlay.querySelector('.fullscreen-close').addEventListener('click', cleanup);
        if (descriptionButton) {
            const readDescription = () => context.node ? getImageDescription(context.node, currentIndex) : String(options.description || '');
            const closeDescription = () => {
                descriptionDialog.classList.add('hidden');
                descriptionButton.focus();
            };
            descriptionButton.addEventListener('click', (event) => {
                event.stopPropagation();
                descriptionInput.value = readDescription();
                descriptionDialog.classList.remove('hidden');
                descriptionInput.focus();
            });
            descriptionDialog.addEventListener('click', event => event.stopPropagation());
            descriptionDialog.querySelector('.fullscreen-description-cancel').addEventListener('click', closeDescription);
            descriptionDialog.querySelector('.fullscreen-description-confirm').addEventListener('click', () => {
                const value = descriptionInput.value.trim();
                if (context.node) {
                    if (getImageDescription(context.node, currentIndex) !== value) {
                        pushHistory();
                        setImageDescription(context.node, value, currentIndex);
                        onImageDescriptionChanged(context.node);
                        scheduleSave();
                    }
                } else {
                    options.description = value;
                }
                options.onDescriptionChange?.(value);
                closeDescription();
            });
        }
        overlay.querySelector('.fullscreen-copy-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            void copyImageToClipboard(getCurrentFullscreenImage(images, currentIndex, src));
        });
        imageContextMenu.querySelector('.fullscreen-image-copy-menu-item').addEventListener('click', (event) => {
            event.stopPropagation();
            imageContextMenu.classList.add('hidden');
            void copyImageToClipboard(getCurrentFullscreenImage(images, currentIndex, src));
        });
        overlay.addEventListener('contextmenu', (event) => {
            if (event.target !== img) return;
            event.preventDefault();
            event.stopPropagation();
            imageContextMenu.style.left = `${event.clientX}px`;
            imageContextMenu.style.top = `${event.clientY}px`;
            imageContextMenu.classList.remove('hidden');
        });
        if (nodeId) {
            overlay.querySelector('.fullscreen-paint-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                cleanup();
                openImagePainter(images[currentIndex] || src, nodeId);
            });
        }
        overlay.addEventListener('click', (e) => {
            const wasDrag = suppressBlankClick;
            suppressBlankClick = false;
            if (!wasDrag && (e.target === overlay || e.target === iw)) cleanup();
        });
        const onEsc = (e) => {
            const top = getSurfaceCoordinator(documentRef)?.topModal();
            if (top && top !== overlay) return;
            if (e.key === 'Escape') {
                if (descriptionDialog && !descriptionDialog.classList.contains('hidden')) {
                    e.preventDefault();
                    descriptionDialog.classList.add('hidden');
                    descriptionButton.focus();
                    return;
                }
                if (cropper?.dismissMenu?.()) return;
                if (!imageContextMenu.classList.contains('hidden')) { imageContextMenu.classList.add('hidden'); return; }
                if (cropper?.isActive()) {
                    e.preventDefault();
                    cropper.setMode(false);
                    return;
                }
                cleanup();
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                if (cropper?.isActive()) return;
                e.preventDefault();
                stepFullscreenImage(-1);
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                if (cropper?.isActive()) return;
                e.preventDefault();
                stepFullscreenImage(1);
            }
        };
        documentRef.addEventListener('keydown', onEsc);
        getSurfaceCoordinator(documentRef)?.registerEscape(overlay, onEsc);
        requestAnimationFrame(() => overlay.classList.add('active'));
        overlay.focus({ preventScroll: true });
    }

    async function copyNodeImageToClipboard(nodeId, visibleSource = '') {
        if (visibleSource) return copyImageToClipboard(visibleSource);
        const context = await getNodeFullscreenImageContext(nodeId);
        const image = context.images[context.index] || context.images[0] || '';
        if (!image) {
            showToast('该节点没有可复制的图片', 'warning');
            return false;
        }
        return copyImageToClipboard(image);
    }

    bindSelectedNodeKeyboardNavigation();

    return {
        showResolutionBadge,
        setupImageImport,
        renderImageImportUploadState,
        loadImageFile,
        loadImageData,
        waitForPendingImageImports,
        setupImageResize,
        setupColorReset,
        getResizeSourceImage,
        refreshImageResizePreview,
        refreshDependentImageResizePreviews,
        refreshAllImageResizePreviews,
        refreshAllRecoverableMediaNodes,
        restoreImageResizePreview,
        restoreColorResetPreview,
        refreshColorResetPreview,
        renderImagePreviewImage,
        renderImageSavePreview,
        renderImageComparePreview,
        getNodeFullscreenImageContext,
        createReferenceThumbnail: source => previewCache.createDisplayMipmap(source, 96),
        createResultThumbnail: source => previewCache.createDisplayMipmap(source, 480),
        rememberResultThumbnail: (nodeId, source, thumbnail) => {
            const node = getNodeById(nodeId);
            if (!node) return;
            const previous = node.data?.imagePreviewThumbnail;
            setNodePreviewThumbnailValue(node, source, thumbnail);
            if (node.data?.imagePreviewThumbnail !== previous) scheduleSave();
        },
        releaseNodeImageData,
        clearPreviewThumbnailCache: () => previewCache.clearPreviewThumbnailCache(),
        scheduleDisplayImageMemorySweep,
        scheduleMediaMemorySweep,
        sweepDisplayImageMemory,
        syncImagePreviewNode,
        syncImageSaveNode,
        setupImageSave,
        autoSaveToDir,
        setupImagePreview,
        setupImageMerge,
        syncImageMergeNode,
        renderImageMergePreview,
        setupImageCompare,
        syncImageCompareNode,
        adjustPreviewZoom,
        copyNodeImageToClipboard,
        openFullscreenPreview
    };
}
import { rememberWorkflowMediaOperation } from './workflow-media-operation.js';
