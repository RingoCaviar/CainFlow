/**
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

export function createMediaControllerApi({
    state,
    getNodeById,
    getImageAsset = async () => null,
    getImageAssetList = async () => [],
    saveImageAsset,
    saveImageAssetList = async () => false,
    saveImageImportAsset = async () => '',
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
    let fitRequestFrame = null;
    const videoAutoSaveToasts = new Map();
    const pendingPreviewIndexSaveNodeIds = new Set();
    let previewIndexSaveTimer = null;
    const previewCache = createMediaPreviewCache({
        getImageResolution,
        documentRef,
        windowRef
    });
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
        renderReusableComparePreview,
        setImageElementSource,
        updatePlaceholderText,
        updatePreviewPlaceholder
    } = displayImageRenderer;

    const displayImageMemoryManager = createDisplayImageMemoryManager({
        state,
        getNodeById,
        getImageAsset,
        getImageAssetList,
        saveImageAsset,
        saveImageAssetList,
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
        renderImageComparePreview,
        showResolutionBadge,
        ensureElement,
        removeElements,
        createPreviewPlaceholder,
        updatePreviewPlaceholder,
        createPreviewNavButton,
        documentRef,
        windowRef,
        canvasContainer
    });

    function schedulePreviewIndexSave(nodeId) {
        if (nodeId) pendingPreviewIndexSaveNodeIds.add(nodeId);
        if (previewIndexSaveTimer) windowRef.clearTimeout(previewIndexSaveTimer);
        previewIndexSaveTimer = windowRef.setTimeout(() => {
            previewIndexSaveTimer = null;
            pendingPreviewIndexSaveNodeIds.clear();
            scheduleSave();
        }, 800);
    }

    function hasIncomingImageConnection(nodeId) {
        return state.connections.some((conn) => (
            conn.to.nodeId === nodeId
            && (conn.to.port === 'image' || conn.to.port === 'imageA' || conn.to.port === 'imageB')
        ));
    }

    async function clearRecoverableDisplayAsset(nodeId) {
        if (deleteImageAsset && hasIncomingImageConnection(nodeId)) {
            await deleteImageAsset(nodeId);
            return true;
        }
        return false;
    }

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
            if (assetKey.startsWith('image-import:')) {
                node.imageImportAssetKey = assetKey;
                node.data.imageImportAssetKey = assetKey;
                delete node.data.imageAssetKey;
            } else {
                node.data.imageAssetKey = assetKey;
            }
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

    function isNodeRunning(nodeId) {
        return state.runningNodeIds?.has(nodeId) || getNodeById(nodeId)?.el?.classList.contains('running');
    }

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '';
        if (bytes >= 1024 * 1024) return `预计 ${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        if (bytes >= 1024) return `预计 ${(bytes / 1024).toFixed(1)} KB`;
        return `预计 ${bytes} B`;
    }

    function parseResolutionText(resolutionText) {
        if (!resolutionText) return null;
        const numbers = String(resolutionText).match(/\d+/g);
        if (!numbers || numbers.length < 2) return null;
        return {
            width: parseInt(numbers[0], 10),
            height: parseInt(numbers[1], 10)
        };
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
        return getCanonicalImage(node) || node.resizePreviewData || null;
    }

    function isInlineImageData(value) {
        return typeof value === 'string' && /^data:image\//i.test(value);
    }

    function isRemoteImageUrl(value) {
        return typeof value === 'string' && /^https?:\/\//i.test(value);
    }

    function choosePersistedPreviewThumbnail(source, thumbnail) {
        const normalizedSource = typeof source === 'string' ? source.trim() : '';
        const normalizedThumbnail = typeof thumbnail === 'string' ? thumbnail.trim() : '';
        if (normalizedThumbnail && normalizedThumbnail !== normalizedSource) {
            return normalizedThumbnail;
        }
        if (normalizedSource && normalizedSource.length <= PERSISTED_PREVIEW_THUMBNAIL_MAX_LENGTH) {
            return normalizedSource;
        }
        return '';
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

    function clearNodePreviewThumbnail(nodeOrId) {
        const node = typeof nodeOrId === 'string' ? getNodeById(nodeOrId) : nodeOrId;
        if (!node?.data?.imagePreviewThumbnail) return false;
        delete node.data.imagePreviewThumbnail;
        return true;
    }

    function cacheNodePreviewThumbnail(nodeOrId, source) {
        const node = typeof nodeOrId === 'string' ? getNodeById(nodeOrId) : nodeOrId;
        const normalizedSource = typeof source === 'string' ? source.trim() : '';
        if (!node?.data) return Promise.resolve('');
        if (!isInlineImageData(normalizedSource)) {
            clearNodePreviewThumbnail(node);
            return Promise.resolve('');
        }
        const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        node.previewThumbnailToken = token;
        const previousThumbnail = typeof node.data?.imagePreviewThumbnail === 'string' ? node.data.imagePreviewThumbnail : '';
        return Promise.resolve(previewCache.createPreviewThumbnail(normalizedSource))
            .then((thumbnail) => {
                const latestNode = getNodeById(node.id);
                if (!latestNode || latestNode !== node || latestNode.previewThumbnailToken !== token) {
                    return '';
                }
                const nextThumbnail = setNodePreviewThumbnailValue(latestNode, normalizedSource, thumbnail);
                if (nextThumbnail !== previousThumbnail) {
                    scheduleSave();
                }
                return nextThumbnail;
            })
            .catch(() => {
                const latestNode = getNodeById(node.id);
                if (!latestNode || latestNode !== node || latestNode.previewThumbnailToken !== token) {
                    return '';
                }
                const nextThumbnail = setNodePreviewThumbnailValue(latestNode, normalizedSource, '');
                if (nextThumbnail !== previousThumbnail) scheduleSave();
                return nextThumbnail;
            });
    }

    function sanitizeFilenamePart(value, fallback = 'image') {
        const cleaned = String(value || '')
            .replace(/[\\/:*?"<>|]/g, ' ')
            .replace(/[\u0000-\u001f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/[. ]+$/g, '');
        const limited = cleaned.slice(0, 80).trim();
        return limited || fallback;
    }

    function formatFilenameTimestamp(date = new Date()) {
        const pad = (value) => String(value).padStart(2, '0');
        return [
            date.getFullYear(),
            pad(date.getMonth() + 1),
            pad(date.getDate())
        ].join('-') + '_' + [
            pad(date.getHours()),
            pad(date.getMinutes()),
            pad(date.getSeconds())
        ].join('-');
    }

    function getImagePromptsFromNode(node, images) {
        const imageList = getCanonicalImageList(node);
        const promptList = Array.isArray(node?.data?.imagePromptList)
            ? node.data.imagePromptList
            : (Array.isArray(node?.imagePromptList) ? node.imagePromptList : []);
        const promptByImage = new Map();
        imageList.forEach((image, index) => {
            const prompt = promptList[index];
            if (image && typeof prompt === 'string' && prompt.trim()) promptByImage.set(image, prompt.trim());
        });
        return images.map((image, index) => {
            if (promptByImage.has(image)) return promptByImage.get(image);
            const prompt = promptList[index] || promptList[0] || node?.data?.prompt || node?.prompt || '';
            return typeof prompt === 'string' ? prompt.trim() : '';
        });
    }

    function getImagePromptsForNode(nodeId, images, visited = new Set()) {
        if (!nodeId || visited.has(nodeId) || !Array.isArray(state.connections)) return images.map(() => '');
        visited.add(nodeId);
        const node = getNodeById(nodeId);
        const directPrompts = getImagePromptsFromNode(node, images);
        if (directPrompts.some((prompt) => prompt)) return directPrompts;
        const incomingImageConnections = state.connections.filter((connection) =>
            connection?.to?.nodeId === nodeId && connection?.to?.port === 'image'
        );
        for (const connection of incomingImageConnections) {
            const prompts = getImagePromptsForNode(connection?.from?.nodeId, images, visited);
            if (prompts.some((prompt) => prompt)) return prompts;
        }
        return images.map(() => '');
    }

    function getImageSavePrompts(nodeId, images) {
        const node = getNodeById(nodeId);
        if (!node || !Array.isArray(state.connections)) return images.map(() => '');
        const incomingImageConnections = state.connections.filter((connection) =>
            connection?.to?.nodeId === nodeId && connection?.to?.port === 'image'
        );
        for (const connection of incomingImageConnections) {
            const prompts = getImagePromptsForNode(connection?.from?.nodeId, images);
            if (prompts.some((prompt) => prompt)) return prompts;
        }
        return images.map(() => '');
    }

    function buildImageSaveFilenameBases(nodeId, images, fallbackPrefix, options = {}) {
        const usePromptFilename = state.imageSaveUsePromptFilename === true;
        const timestamp = formatFilenameTimestamp();
        if (!usePromptFilename) {
            return images.map((_, index) => {
                const suffix = images.length > 1 ? `_${String(index + 1).padStart(2, '0')}` : '';
                const prefix = sanitizeFilenamePart(fallbackPrefix);
                return options.includeTimestamp ? `${prefix}_${timestamp}${suffix}` : `${prefix}${suffix}`;
            });
        }

        const prompts = getImageSavePrompts(nodeId, images);
        const promptCounts = new Map();
        return images.map((_, index) => {
            const promptBase = sanitizeFilenamePart(prompts[index], sanitizeFilenamePart(fallbackPrefix));
            const key = promptBase.toLowerCase();
            const count = (promptCounts.get(key) || 0) + 1;
            promptCounts.set(key, count);
            const duplicateSuffix = count > 1 ? `_${String(count).padStart(2, '0')}` : '';
            return `${promptBase}_${timestamp}${duplicateSuffix}`;
        });
    }

    function detectVideoExtensionFromSource(video = {}, blob = null) {
        const blobType = String(blob?.type || '').toLowerCase();
        if (blobType.includes('webm')) return '.webm';
        if (blobType.includes('mov') || blobType.includes('quicktime')) return '.mov';
        if (blobType.includes('avi')) return '.avi';
        if (blobType.includes('mkv')) return '.mkv';
        if (blobType.includes('mp4')) return '.mp4';

        const videoUrl = String(video?.url || '').trim().toLowerCase();
        const cleanUrl = videoUrl.split('?')[0].split('#')[0];
        if (cleanUrl.endsWith('.webm')) return '.webm';
        if (cleanUrl.endsWith('.mov')) return '.mov';
        if (cleanUrl.endsWith('.avi')) return '.avi';
        if (cleanUrl.endsWith('.mkv')) return '.mkv';
        return '.mp4';
    }

    function buildVideoSaveFilenameBase(nodeId, video, fallbackPrefix, options = {}) {
        const usePromptFilename = state.imageSaveUsePromptFilename === true;
        const timestamp = formatFilenameTimestamp();
        const fallbackBase = sanitizeFilenamePart(fallbackPrefix || 'video', 'video');
        const prompt = typeof video?.prompt === 'string' ? video.prompt.trim() : '';
        const base = usePromptFilename
            ? sanitizeFilenamePart(prompt, fallbackBase)
            : fallbackBase;
        return options.includeTimestamp ? `${base}_${timestamp}` : base;
    }

    function buildBackendVideoDownloadUrl(videoUrl, filenameBase) {
        const params = new URLSearchParams();
        params.set('url', String(videoUrl || '').trim());
        if (filenameBase) params.set('filename', filenameBase);
        return `/api/media/download?${params.toString()}`;
    }

    function formatProgressBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${Math.round(bytes)} B`;
    }

    function formatProgressSpeed(bytesPerSecond) {
        const speed = Number(bytesPerSecond) || 0;
        return speed > 0 ? `${formatProgressBytes(speed)}/s` : '等待数据';
    }

    async function blobLooksLikeVideo(blob) {
        if (!blob || typeof blob.slice !== 'function') return false;
        const headerBlob = blob.slice(0, 64);
        const buffer = await headerBlob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        if (bytes.length >= 8 &&
            bytes[4] === 0x66 &&
            bytes[5] === 0x74 &&
            bytes[6] === 0x79 &&
            bytes[7] === 0x70) {
            return true;
        }
        if (bytes.length >= 4 &&
            bytes[0] === 0x1a &&
            bytes[1] === 0x45 &&
            bytes[2] === 0xdf &&
            bytes[3] === 0xa3) {
            return true;
        }
        if (bytes.length >= 12 &&
            bytes[0] === 0x52 &&
            bytes[1] === 0x49 &&
            bytes[2] === 0x46 &&
            bytes[3] === 0x46 &&
            bytes[8] === 0x41 &&
            bytes[9] === 0x56 &&
            bytes[10] === 0x49 &&
            bytes[11] === 0x20) {
            return true;
        }
        return false;
    }

    function isLikelyDownloadableVideoUrl(videoUrl = '') {
        const value = String(videoUrl || '').trim();
        if (!value) return false;
        try {
            const parsed = new URL(value, windowRef.location?.href || 'http://localhost');
            const pathname = String(parsed.pathname || '').toLowerCase();
            if (['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'].some((ext) => pathname.endsWith(ext))) {
                return true;
            }
            const query = String(parsed.search || '');
            if (query.includes('Signature=') || query.includes('Expires=') || query.includes('response-content-disposition=')) {
                return true;
            }
            const host = String(parsed.hostname || '').toLowerCase();
            if (host.includes('flow-content.google') || host.includes('storage.googleapis.com')) {
                return true;
            }
        } catch (_) {
            return false;
        }
        return false;
    }

    function classifyVideoUrlForLog(videoUrl = '') {
        const value = String(videoUrl || '').trim();
        if (!value) return { kind: 'empty', label: '空链接' };
        return isLikelyDownloadableVideoUrl(value)
            ? { kind: 'signed-video-direct', label: '签名视频直链' }
            : { kind: 'normal-video-url', label: '普通视频链接' };
    }

    function getVideoAutoSaveToastRecord(nodeId) {
        return videoAutoSaveToasts.get(nodeId) || null;
    }

    function removeVideoAutoSaveToast(nodeId) {
        const record = getVideoAutoSaveToastRecord(nodeId);
        if (!record) return;
        record.toastHandle?.dismiss?.(0);
        videoAutoSaveToasts.delete(nodeId);
    }

    function ensureVideoAutoSaveToast(nodeId, subtitleText = '正在自动保存视频...') {
        const existing = getVideoAutoSaveToastRecord(nodeId);
        if (existing?.toastHandle?.element?.isConnected) return existing;

        const toastHandle = showToast('正在自动保存视频...', 'info', 0);
        const toastEl = toastHandle?.element;
        if (!toastEl) return null;

        toastHandle.clearTimer?.();
        toastEl.className = 'toast info update-download-toast';
        toastEl.setAttribute('role', 'status');
        toastEl.setAttribute('aria-live', 'polite');
        toastEl.innerHTML = '';

        const header = documentRef.createElement('div');
        header.className = 'update-download-toast__header';

        const titleWrap = documentRef.createElement('div');
        titleWrap.className = 'update-download-toast__title-wrap';

        const title = documentRef.createElement('div');
        title.className = 'update-download-toast__title';
        title.textContent = '视频自动保存';
        titleWrap.appendChild(title);

        const subtitle = documentRef.createElement('div');
        subtitle.className = 'update-download-toast__subtitle';
        subtitle.textContent = subtitleText;
        titleWrap.appendChild(subtitle);
        header.appendChild(titleWrap);
        toastEl.appendChild(header);

        const progress = documentRef.createElement('div');
        progress.className = 'update-download-progress update-download-progress--toast';

        const row = documentRef.createElement('div');
        row.className = 'update-download-progress__row';

        const rowTitle = documentRef.createElement('span');
        rowTitle.className = 'update-download-progress__title';
        rowTitle.textContent = '后端下载中';
        row.appendChild(rowTitle);

        const percentText = documentRef.createElement('span');
        percentText.className = 'update-download-progress__percent';
        percentText.textContent = '计算中';
        row.appendChild(percentText);
        progress.appendChild(row);

        const track = documentRef.createElement('div');
        track.className = 'update-download-progress__track is-indeterminate';

        const bar = documentRef.createElement('div');
        bar.className = 'update-download-progress__bar';
        track.appendChild(bar);
        progress.appendChild(track);

        const detail = documentRef.createElement('div');
        detail.className = 'update-download-progress__detail';

        const sizeText = documentRef.createElement('span');
        sizeText.textContent = '等待服务器返回大小...';
        detail.appendChild(sizeText);

        const statusText = documentRef.createElement('span');
        statusText.textContent = '准备中';
        detail.appendChild(statusText);

        const speedText = documentRef.createElement('span');
        speedText.textContent = '速度：等待数据';
        detail.appendChild(speedText);
        progress.appendChild(detail);

        toastEl.appendChild(progress);

        const record = {
            toastHandle,
            toastEl,
            subtitle,
            rowTitle,
            percentText,
            track,
            bar,
            sizeText,
            statusText,
            speedText
        };
        videoAutoSaveToasts.set(nodeId, record);
        return record;
    }

    function updateVideoAutoSaveToast(nodeId, {
        subtitle = '正在自动保存视频...',
        stage = '后端下载中',
        loaded = 0,
        total = 0,
        status = '下载中',
        speedBytesPerSecond = 0
    } = {}) {
        const record = ensureVideoAutoSaveToast(nodeId, subtitle);
        if (!record) return;

        const hasTotal = Number.isFinite(total) && total > 0;
        const safeLoaded = Math.max(0, Number(loaded) || 0);
        const percent = hasTotal ? Math.max(0, Math.min(100, (safeLoaded / total) * 100)) : null;

        record.subtitle.textContent = subtitle;
        record.rowTitle.textContent = stage;
        record.percentText.textContent = percent === null
            ? '计算中'
            : `${percent.toFixed(percent >= 10 || percent === 0 ? 0 : 1)}%`;
        record.track.classList.toggle('is-indeterminate', percent === null);
        record.bar.style.width = percent === null ? '' : `${percent}%`;
        record.sizeText.textContent = hasTotal
            ? `${formatProgressBytes(safeLoaded)} / ${formatProgressBytes(total)}`
            : `${formatProgressBytes(safeLoaded)} / 未知大小`;
        record.statusText.textContent = status;
        record.speedText.textContent = status === '已完成'
            ? '速度：完成'
            : `速度：${formatProgressSpeed(speedBytesPerSecond)}`;
    }

    function completeVideoAutoSaveToast(nodeId, message = '视频已自动保存到目录') {
        const record = ensureVideoAutoSaveToast(nodeId, message);
        if (!record) return;
        record.toastEl.className = 'toast success update-download-toast is-completed';
        record.subtitle.textContent = message;
        record.rowTitle.textContent = '保存完成';
        record.percentText.textContent = '100%';
        record.track.classList.remove('is-indeterminate');
        record.bar.style.width = '100%';
        record.statusText.textContent = '已完成';
        record.speedText.textContent = '速度：完成';
        windowRef.setTimeout(() => removeVideoAutoSaveToast(nodeId), 2600);
    }

    function failVideoAutoSaveToast(nodeId, message = '视频自动保存失败') {
        const record = ensureVideoAutoSaveToast(nodeId, message);
        if (!record) return;
        record.toastEl.className = 'toast error update-download-toast';
        record.subtitle.textContent = message;
        record.rowTitle.textContent = '保存失败';
        record.statusText.textContent = '失败';
        record.speedText.textContent = '速度：失败';
        windowRef.setTimeout(() => removeVideoAutoSaveToast(nodeId), 4000);
    }

    async function downloadGeneratedVideo(videoUrl, options = {}) {
        const {
            filenameBase = '',
            onProgress = null,
            signal = null
        } = options;
        const backendUrl = buildBackendVideoDownloadUrl(videoUrl, filenameBase);
        const videoUrlMeta = classifyVideoUrlForLog(videoUrl);
        let response = null;
        let postErrorMessage = '';

        try {
            response = await fetchRef('/api/media/download', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'video/*,application/octet-stream'
                },
                signal,
                body: JSON.stringify({
                    url: String(videoUrl || '').trim(),
                    filename: filenameBase || ''
                })
            });
            if (!response.ok) {
                const bodyText = await response.text();
                postErrorMessage = typeof formatProxyErrorMessage === 'function'
                    ? formatProxyErrorMessage(response.status, bodyText, '后端视频下载失败')
                    : `后端视频下载失败 (${response.status})`;
                addLog('warning', '后端视频下载失败', postErrorMessage, {
                    method: 'POST',
                    url: '/api/media/download',
                    sourceVideoUrl: videoUrl,
                    videoUrlType: videoUrlMeta.kind,
                    videoUrlLabel: videoUrlMeta.label,
                    filenameBase
                });
                response = null;
            }
        } catch (error) {
            postErrorMessage = error?.message || String(error);
            addLog('warning', '后端视频下载异常', postErrorMessage, {
                method: 'POST',
                url: '/api/media/download',
                sourceVideoUrl: videoUrl,
                videoUrlType: videoUrlMeta.kind,
                videoUrlLabel: videoUrlMeta.label,
                filenameBase
            });
            response = null;
        }

        if (!response) {
            response = await fetchRef(backendUrl, {
                method: 'GET',
                headers: {
                    Accept: 'video/*,application/octet-stream'
                },
                signal
            });
            if (!response.ok) {
                const bodyText = await response.text();
                const getErrorMessage = typeof formatProxyErrorMessage === 'function'
                    ? formatProxyErrorMessage(response.status, bodyText, '后端视频下载失败')
                    : `后端视频下载失败 (${response.status})`;
                addLog('warning', '后端视频下载回退失败', getErrorMessage, {
                    method: 'GET',
                    url: backendUrl,
                    sourceVideoUrl: videoUrl,
                    videoUrlType: videoUrlMeta.kind,
                    videoUrlLabel: videoUrlMeta.label,
                    previousError: postErrorMessage
                });
                throw new Error(postErrorMessage
                    ? `${postErrorMessage}；GET 回退也失败：${getErrorMessage}`
                    : getErrorMessage);
            }
        }

        const responseContentType = String(response.headers.get('Content-Type') || '').toLowerCase();
        const allowNonStandardVideoContentType = isLikelyDownloadableVideoUrl(videoUrl);
        if (!responseContentType.startsWith('video/') && !allowNonStandardVideoContentType) {
            const invalidBody = await response.text();
            addLog('warning', '后端视频下载返回了非视频内容', '后端返回的不是视频文件，已阻止写入保存目录。', {
                sourceVideoUrl: videoUrl,
                videoUrlType: videoUrlMeta.kind,
                videoUrlLabel: videoUrlMeta.label,
                contentType: responseContentType || 'unknown',
                body: invalidBody
            });
            throw new Error(`后端返回的不是视频文件 (${responseContentType || 'unknown'})`);
        }

        const total = Number(response.headers.get('Content-Length') || 0);
        const downloadStartedAt = Date.now();
        const getAverageSpeed = (loadedBytes) => {
            const elapsedSeconds = Math.max(0.001, (Date.now() - downloadStartedAt) / 1000);
            return Math.round((Number(loadedBytes) || 0) / elapsedSeconds);
        };
        if (!response.body || typeof response.body.getReader !== 'function') {
            const blob = await response.blob();
            if (!String(blob.type || '').toLowerCase().startsWith('video/') && !allowNonStandardVideoContentType) {
                throw new Error(`下载结果不是视频文件 (${blob.type || 'unknown'})`);
            }
            if (blob.size < 1024) {
                throw new Error(`下载结果大小异常 (${blob.size} B)，已阻止保存`);
            }
            if (!(await blobLooksLikeVideo(blob))) {
                throw new Error('下载结果文件头不是有效视频，已阻止保存');
            }
            if (typeof onProgress === 'function') {
                onProgress({
                    loaded: blob.size || total || 0,
                    total: total || blob.size || 0,
                    speedBytesPerSecond: getAverageSpeed(blob.size || total || 0),
                    done: true
                });
            }
            return blob;
        }

        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                chunks.push(value);
                loaded += value.byteLength || value.length || 0;
                if (typeof onProgress === 'function') {
                    onProgress({
                        loaded,
                        total,
                        speedBytesPerSecond: getAverageSpeed(loaded),
                        done: false
                    });
                }
            }
        }
        if (typeof onProgress === 'function') {
            onProgress({
                loaded,
                total: total || loaded,
                speedBytesPerSecond: getAverageSpeed(loaded),
                done: true
            });
        }
        const blob = new Blob(chunks, {
            type: response.headers.get('Content-Type') || 'application/octet-stream'
        });
        if (!String(blob.type || '').toLowerCase().startsWith('video/') && !allowNonStandardVideoContentType) {
            throw new Error(`下载结果不是视频文件 (${blob.type || 'unknown'})`);
        }
        if (blob.size < 1024) {
            throw new Error(`下载结果大小异常 (${blob.size} B)，已阻止保存`);
        }
        if (!(await blobLooksLikeVideo(blob))) {
            throw new Error('下载结果文件头不是有效视频，已阻止保存');
        }
        return blob;
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
        const video = node?.data?.video;
        return video && typeof video === 'object' && typeof video.url === 'string' && video.url.trim()
            ? video
            : null;
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
        if (isManagedImageNode(node)) {
            return restoreStoredImageList(node);
        }
        return getNodeOutputImageList(node);
    }

    function getImageSavePreviewIndex(node, images) {
        if (!images.length) return 0;
        const rawIndex = Number.isFinite(node?.imagePreviewIndex) ? node.imagePreviewIndex : 0;
        return Math.max(0, Math.min(images.length - 1, rawIndex));
    }

    function getImagePreviewIndex(node, images) {
        if (!images.length) return 0;
        const rawIndex = Number.isFinite(node?.imagePreviewIndex) ? node.imagePreviewIndex : 0;
        return Math.max(0, Math.min(images.length - 1, rawIndex));
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

    function renderImagePreviewImage(nodeId, images, emptyMessage = '无输入图片') {
        const previewContainer = documentRef.getElementById(`${nodeId}-preview`);
        const node = getNodeById(nodeId);
        if (node?.type === 'ImageGenerate') return;
        if (!previewContainer) return;

        const rendered = renderDisplayImagePreview(previewContainer, node, images, {
            totalCount: getStoredImageCount(node),
            altPrefix: '预览',
            placeholderClass: 'preview-placeholder',
            emptyMessage,
            cursor: 'pointer',
            placeholderWithIcon: true
        });
        if (node?.type === 'ImageGenerate') {
            if (rendered.image) void cacheNodePreviewThumbnail(node, rendered.image);
            else clearNodePreviewThumbnail(node);
        }
    }

    function renderImageSavePreview(nodeId, images, emptyMessage = '无输入图片') {
        const previewContainer = documentRef.getElementById(`${nodeId}-save-preview`);
        const node = getNodeById(nodeId);
        if (!previewContainer) return;

        renderDisplayImagePreview(previewContainer, node, images, {
            totalCount: getStoredImageCount(node),
            altPrefix: '待保存',
            placeholderClass: 'save-preview-placeholder',
            emptyMessage,
            placeholderWithIcon: false
        });
    }

    function renderVideoSavePreview(nodeId, video, emptyMessage = '无输入视频') {
        const previewContainer = documentRef.getElementById(`${nodeId}-save-preview`);
        const node = getNodeById(nodeId);
        if (!previewContainer) return;

        previewContainer.classList.remove('has-multiple-images');
        previewContainer.dataset.saveMode = video?.url ? 'video' : 'image';
        if (node) {
            clearCanonicalImageOutput(node);
            delete node.data.videoPreviewReleased;
        }

        if (!video?.url) {
            previewContainer.innerHTML = `<div class="save-preview-placeholder">${emptyMessage}</div>`;
            return;
        }

        previewContainer.innerHTML = `
            <video
                src="${escapeHtml(video.url)}"
                controls
                preload="metadata"
                playsinline
                style="width:100%;height:100%;object-fit:contain;border-radius:12px;background:rgba(0,0,0,0.08);"
                title="${escapeHtml(video.status || video.id || '可保存视频文件')}"
            ></video>
        `;
    }

    function getCurrentImageSavePreviewImage(node) {
        const images = getStoredImageSaveList(node);
        if (images.length === 0) return null;
        return images[getImageSavePreviewIndex(node, images)] || images[0];
    }

    function getCurrentImagePreviewImage(node) {
        const images = getStoredImagePreviewList(node);
        if (images.length === 0) return null;
        return images[getImagePreviewIndex(node, images)] || images[0];
    }

    async function getNodeFullscreenImageContext(nodeId, fallbackSrc = '') {
        const node = getNodeById(nodeId);
        const images = await restoreStoredImageList(node);
        const normalizedFallback = typeof fallbackSrc === 'string' ? fallbackSrc.trim() : '';
        const imageList = images.length > 0
            ? images
            : (normalizedFallback ? [normalizedFallback] : []);
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
        if (context.node?.type === 'ImagePreview' || context.node?.type === 'ImageGenerate') {
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
        const currentImage = context.images[context.index] || context.images[0];
        if (!currentImage) {
            return false;
        }
        await openFullscreenPreview(currentImage, nodeId);
        return true;
    }

    function bindPreviewKeyboardNavigation(container, getImages, getIndex, onChange) {
        if (!container || container.dataset.previewKeyboardBound === '1') return;
        container.dataset.previewKeyboardBound = '1';
        container.tabIndex = 0;

        const handleStep = (delta, event) => {
            event.preventDefault();
            event.stopPropagation();
            Promise.resolve(getImages()).then((value) => {
                const images = normalizeImageList(value);
                if (images.length <= 1) return;
                const currentIndex = Math.max(0, Math.min(images.length - 1, getIndex(images)));
                const nextIndex = (currentIndex + delta + images.length) % images.length;
                return onChange(nextIndex, images, event);
            }).catch((error) => {
                console.warn('Preview keyboard navigation failed:', error);
            });
        };

        container.addEventListener('pointerdown', () => {
            container.focus({ preventScroll: true });
        });
        container.addEventListener('keydown', (event) => {
            if (hasBlockingImmersiveOverlay()) return;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                handleStep(-1, event);
            } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                handleStep(1, event);
            }
        });
    }

    function isTypingIntoField() {
        const activeElement = documentRef.activeElement;
        return Boolean(activeElement && (
            activeElement.tagName === 'INPUT'
            || activeElement.tagName === 'TEXTAREA'
            || activeElement.tagName === 'SELECT'
            || activeElement.isContentEditable
        ));
    }

    function hasBlockingImmersiveOverlay() {
        if (documentRef.querySelector('.fullscreen-overlay')) return true;
        const historyPreview = documentRef.getElementById('history-preview-modal');
        return Boolean(historyPreview && !historyPreview.classList.contains('hidden'));
    }

    async function stepImagePreviewNodeByDelta(nodeId, delta) {
        const node = getNodeById(nodeId);
        const images = await getStoredImagePreviewListAsync(node);
        if (!node || images.length <= 1) return false;
        const currentIndex = getImagePreviewIndex(node, images);
        const nextIndex = (currentIndex + delta + images.length) % images.length;
        node.imagePreviewIndex = nextIndex;
        node.previewZoom = 1;
        renderImagePreviewImage(nodeId, images);
        const image = images[nextIndex];
        if (image) {
            await showResolutionBadge(nodeId, image);
        }
        schedulePreviewIndexSave(nodeId);
        return true;
    }

    async function stepImageSaveNodeByDelta(nodeId, delta) {
        const node = getNodeById(nodeId);
        const images = await getStoredImageSaveListAsync(node);
        if (!node || images.length <= 1) return false;
        const currentIndex = getImageSavePreviewIndex(node, images);
        node.imagePreviewIndex = (currentIndex + delta + images.length) % images.length;
        renderImageSavePreview(nodeId, images);
        await showResolutionBadge(nodeId, images[node.imagePreviewIndex]);
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
            if (!node || (node.type !== 'ImagePreview' && node.type !== 'ImageGenerate' && node.type !== 'ImageSave')) return;

            const delta = event.key === 'ArrowLeft' ? -1 : 1;
            event.preventDefault();
            event.stopPropagation();

            if (node.type === 'ImagePreview' || node.type === 'ImageGenerate') {
                void stepImagePreviewNodeByDelta(selectedNodeId, delta);
            } else {
                void stepImageSaveNodeByDelta(selectedNodeId, delta);
            }
        });
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
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
        const modeInput = documentRef.getElementById(`${nodeId}-import-mode`);
        const uploadSection = documentRef.getElementById(`${nodeId}-upload-section`);
        const urlSection = documentRef.getElementById(`${nodeId}-url-section`);
        const mode = modeInput?.value || 'upload';

        if (uploadSection) uploadSection.classList.toggle('hidden', mode !== 'upload');
        if (urlSection) urlSection.classList.toggle('hidden', mode !== 'url');

        documentRef.querySelectorAll(`.image-import-mode-btn[data-target="${nodeId}"]`).forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        if (mode !== 'url') requestNodeFit(nodeId);
    }

    async function clearImageImportBadge(nodeId) {
        const badge = documentRef.getElementById(`${nodeId}-res`);
        if (badge) {
            badge.textContent = '';
            badge.style.display = 'none';
        }
    }

    function renderImageImportUrlState(nodeId, imageUrl = '') {
        const urlInput = documentRef.getElementById(`${nodeId}-url-input`);
        const preview = documentRef.getElementById(`${nodeId}-url-preview`);
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
        const preview = documentRef.getElementById(`${nodeId}-url-preview`);
        if (!preview) return;
        preview.classList.add('has-image');
        preview.innerHTML = renderImageImportUrlPreviewContent(imageUrl, { reloading: true });
        bindImageImportUrlPreviewEvents(nodeId);
    }

    function bindImageImportUrlPreviewEvents(nodeId) {
        const preview = documentRef.getElementById(`${nodeId}-url-preview`);
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
        const dropZone = documentRef.getElementById(`${nodeId}-drop`);
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

        const modeInput = documentRef.getElementById(`${nodeId}-import-mode`);
        if (modeInput) modeInput.value = node.importMode;

        updateImageImportModeState(nodeId);

        if (node.importMode === 'url') {
            if (node.imageUrl) node.data.image = node.imageUrl;
            else delete node.data.image;
            delete node.data.imagePreviewThumbnail;
            renderImageImportUrlState(nodeId, node.imageUrl || '');
        } else {
            let imageList = getFirstNonEmptyImageList(
                node.imageData,
                node.data?.image,
                node.imageDataList,
                node.data?.images
            );
            let imageData = imageList[0] || null;
            const importAssetKey = node.imageImportAssetKey || node.data?.imageImportAssetKey || '';
            if (!imageData && importAssetKey) {
                const restoredImage = await getImageAsset(importAssetKey);
                if (restoredImage) {
                    imageData = restoredImage;
                    imageList = [restoredImage];
                    node.imageImportAssetKey = importAssetKey;
                    node.data.imageImportAssetKey = importAssetKey;
                }
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
        const badge = documentRef.getElementById(`${nodeId}-res`);
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
        const preview = documentRef.getElementById(`${nodeId}-resize-preview`);
        const sizeLabel = documentRef.getElementById(`${nodeId}-resize-size-label`);
        const bytesLabel = documentRef.getElementById(`${nodeId}-resize-bytes-label`);
        if (preview) {
            preview.innerHTML = `<div class="preview-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>${message}</div>`;
        }
        if (sizeLabel) sizeLabel.textContent = message;
        if (bytesLabel) bytesLabel.textContent = '';
        requestNodeFit(nodeId);
    }

    function renderImageResizeResult(nodeId, result) {
        const preview = documentRef.getElementById(`${nodeId}-resize-preview`);
        const sizeLabel = documentRef.getElementById(`${nodeId}-resize-size-label`);
        const bytesLabel = documentRef.getElementById(`${nodeId}-resize-bytes-label`);
        const sizeText = result.originalWidth && result.originalHeight && result.outputWidth && result.outputHeight
            ? `${result.originalWidth} × ${result.originalHeight} → ${result.outputWidth} × ${result.outputHeight}`
            : '结果预览已更新';

        if (preview) {
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
            bytesLabel.textContent = `${formatBytes(result.estimatedBytes)}${qualityText}`;
        }
        requestNodeFit(nodeId);
    }

    function updateImageResizeModeState(nodeId) {
        const modeInput = documentRef.getElementById(`${nodeId}-resize-mode`);
        const scaleSection = documentRef.getElementById(`${nodeId}-scale-section`);
        const dimensionsSection = documentRef.getElementById(`${nodeId}-dimensions-section`);
        const mode = modeInput?.value || 'scale';

        if (scaleSection) scaleSection.classList.toggle('hidden', mode !== 'scale');
        if (dimensionsSection) dimensionsSection.classList.toggle('hidden', mode !== 'dimensions');

        documentRef.querySelectorAll(`.image-resize-mode-btn[data-target="${nodeId}"]`).forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });

        requestNodeFit(nodeId);
    }

    function updateImageResizeQualityVisibility(nodeId, sourceImage) {
        const qualityField = documentRef.getElementById(`${nodeId}-quality-field`);
        if (!qualityField) return;
        const outputFormat = sourceImage ? detectOutputFormat(sourceImage) : 'image/png';
        qualityField.classList.toggle('hidden', outputFormat === 'image/png');
        requestNodeFit(nodeId);
    }

    function readImageResizeConfig(nodeId) {
        return {
            mode: documentRef.getElementById(`${nodeId}-resize-mode`)?.value || 'scale',
            scalePercent: Math.max(1, Math.min(100, parseInt(documentRef.getElementById(`${nodeId}-scale-percent`)?.value || '100', 10) || 100)),
            targetWidth: documentRef.getElementById(`${nodeId}-target-width`)?.value || '',
            targetHeight: documentRef.getElementById(`${nodeId}-target-height`)?.value || '',
            keepAspect: documentRef.getElementById(`${nodeId}-keep-aspect`)?.checked !== false,
            quality: parseInt(documentRef.getElementById(`${nodeId}-quality`)?.value || '92', 10)
        };
    }

    function getResizeSourceImage(nodeId) {
        const incoming = state.connections.find((conn) => conn.to.nodeId === nodeId && conn.to.port === 'image');
        if (!incoming) return null;
        const sourceNode = getNodeById(incoming.from.nodeId);
        return getNodePreviewSourceData(sourceNode);
    }

    async function getResizeSourceImageAsync(nodeId) {
        const incoming = state.connections.find((conn) => conn.to.nodeId === nodeId && conn.to.port === 'image');
        if (!incoming) return null;
        const sourceNode = getNodeById(incoming.from.nodeId);
        const images = await getNodeOutputImageListAsync(sourceNode);
        return images[0] || getNodePreviewSourceData(sourceNode);
    }

    async function syncImagePreviewNode(nodeId, imageData) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImagePreview') return;

        const previewContainer = documentRef.getElementById(`${nodeId}-preview`);
        const controls = documentRef.getElementById(`${nodeId}-controls`);
        const resolutionBadge = documentRef.getElementById(`${nodeId}-res`);
        const imageList = normalizeImageList(imageData);

        node.previewZoom = 1;
        const currentImage = imageList[0] || null;

        if (currentImage) {
            setCanonicalImageOutput(node, imageList, {
                currentIndex: 0,
                assetKey: nodeId,
                trackImageCount: true,
                hydratedAt: Date.now(),
                assetReady: false
            });
            renderImagePreviewImage(nodeId, imageList);
            if (controls) controls.style.display = 'flex';
            saveDisplayImageAssetSoon(nodeId, imageList);
            updateResolutionBadgeSoon(nodeId, currentImage);
        } else {
            clearCanonicalImageOutput(node);
            clearDisplayImageAssetState(nodeId);
            if (previewContainer) {
                previewContainer.classList.remove('has-multiple-images');
                previewContainer.innerHTML = `<div class="preview-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>无输入图片</div>`;
            }
            if (controls) controls.style.display = 'none';
            if (deleteImageAsset) await deleteImageAsset(nodeId);
            if (resolutionBadge) {
                resolutionBadge.textContent = '';
                resolutionBadge.style.display = 'none';
            }
        }
        scheduleDisplayImageMemorySweep({ delayMs: displayImageMemoryManager.releaseGraceMs });

        if (shouldRequestFit(node, getPreviewLayoutSignature(imageList))) {
            requestNodeFit(nodeId);
        }
    }

    async function syncImageSaveNode(nodeId, imageData) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImageSave') return;

        const manualSaveBtn = documentRef.getElementById(`${nodeId}-manual-save`);
        const viewFullBtn = documentRef.getElementById(`${nodeId}-view-full`);
        const resolutionBadge = documentRef.getElementById(`${nodeId}-res`);

        const imageList = normalizeImageList(imageData?.images ?? imageData);
        const videoData = imageData?.video && typeof imageData.video === 'object' ? imageData.video : null;
        const currentImage = imageList.length > 0 ? imageList[0] : null;

        node.data = node.data || {};
        if (videoData?.url) {
            node.data.video = {
                id: videoData.id || '',
                url: videoData.url,
                status: videoData.status || '',
                prompt: videoData.prompt || ''
            };
        } else {
            delete node.data.video;
        }

        if (imageList.some((image) => isRemoteImageUrl(image))) {
            clearCanonicalImageOutput(node);
            delete node.data.video;
            clearDisplayImageAssetState(nodeId);
            renderImageSavePreview(nodeId, [], 'URL 图片不支持保存节点');
            if (manualSaveBtn) manualSaveBtn.disabled = true;
            if (viewFullBtn) viewFullBtn.disabled = true;
            if (deleteImageAsset) await deleteImageAsset(nodeId);
            if (resolutionBadge) {
                resolutionBadge.textContent = '';
                resolutionBadge.style.display = 'none';
            }
            if (shouldRequestFit(node, getPreviewLayoutSignature([]), 'savePreviewLayoutSignature')) {
                requestNodeFit(nodeId);
            }
            return;
        }

        if (currentImage) {
            delete node.data.video;
            setCanonicalImageOutput(node, imageList, {
                currentIndex: 0,
                assetKey: nodeId,
                trackImageCount: true,
                hydratedAt: Date.now(),
                assetReady: false
            });
            renderImageSavePreview(nodeId, imageList);
            if (manualSaveBtn) manualSaveBtn.disabled = false;
            if (viewFullBtn) viewFullBtn.disabled = false;
            saveDisplayImageAssetSoon(nodeId, imageList);
            updateResolutionBadgeSoon(nodeId, currentImage);
        } else if (videoData?.url) {
            clearCanonicalImageOutput(node);
            renderVideoSavePreview(nodeId, videoData);
            if (manualSaveBtn) manualSaveBtn.disabled = false;
            if (viewFullBtn) viewFullBtn.disabled = true;
            if (deleteImageAsset) await deleteImageAsset(nodeId);
            clearDisplayImageAssetState(nodeId);
            if (resolutionBadge) {
                resolutionBadge.textContent = '';
                resolutionBadge.style.display = 'none';
            }
        } else {
            clearCanonicalImageOutput(node);
            delete node.data.video;
            clearDisplayImageAssetState(nodeId);
            renderImageSavePreview(nodeId, [], '无输入图片或视频');
            if (manualSaveBtn) manualSaveBtn.disabled = true;
            if (viewFullBtn) viewFullBtn.disabled = true;
            if (deleteImageAsset) await deleteImageAsset(nodeId);
            if (resolutionBadge) {
                resolutionBadge.textContent = '';
                resolutionBadge.style.display = 'none';
            }
        }
        scheduleDisplayImageMemorySweep({ delayMs: displayImageMemoryManager.releaseGraceMs });

        if (shouldRequestFit(node, getPreviewLayoutSignature(imageList), 'savePreviewLayoutSignature')) {
            requestNodeFit(nodeId);
        }
    }

    function getConnectedImageInput(nodeId, portName) {
        const incoming = state.connections.find((conn) => conn.to.nodeId === nodeId && conn.to.port === portName);
        if (!incoming) return null;
        return getNodePreviewSourceData(getNodeById(incoming.from.nodeId));
    }

    async function getConnectedImageInputAsync(nodeId, portName) {
        const incoming = state.connections.find((conn) => conn.to.nodeId === nodeId && conn.to.port === portName);
        if (!incoming) return null;
        const sourceNode = getNodeById(incoming.from.nodeId);
        const images = await getNodeOutputImageListAsync(sourceNode);
        return images[0] || getNodePreviewSourceData(sourceNode);
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
        const container = documentRef.getElementById(`${nodeId}-compare`);
        const badge = documentRef.getElementById(`${nodeId}-res`);
        const node = getNodeById(nodeId);
        if (container) {
            container.classList.remove('has-images', 'has-a-image', 'is-comparing');
            container.style.setProperty('--compare-x', '50%');
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
        const container = documentRef.getElementById(`${nodeId}-compare`);
        if (!container) return;
        if (!imageB) {
            renderImageCompareEmptyState(nodeId, imageA ? '等待 B 输入' : '等待 A / B 输入');
            clearNodePreviewThumbnail(nodeId);
            return;
        }
        container.classList.add('has-images');
        container.classList.toggle('has-a-image', Boolean(imageA));
        container.classList.remove('is-comparing');
        container.style.setProperty('--compare-x', '50%');
        renderReusableComparePreview(container, imageA, imageB);
        void cacheNodePreviewThumbnail(nodeId, imageB);
    }

    async function syncImageCompareNode(nodeId, imageA = null, imageB = null) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImageCompare') return;

        const nextImageA = Object.prototype.hasOwnProperty.call(arguments, 1)
            ? imageA
            : await getConnectedImageInputAsync(nodeId, 'imageA');
        const nextImageB = Object.prototype.hasOwnProperty.call(arguments, 2)
            ? imageB
            : await getConnectedImageInputAsync(nodeId, 'imageB');

        node.compareImageA = nextImageA || null;
        node.compareImageB = nextImageB || null;
        node.data = node.data || {};
        if (nextImageA) node.data.compareImageA = nextImageA;
        else delete node.data.compareImageA;
        if (nextImageB) node.data.compareImageB = nextImageB;
        else delete node.data.compareImageB;

        if (!nextImageB) {
            node.imageData = null;
            delete node.data.image;
            delete node.data.imageAssetKey;
            delete node.data.imageCount;
            delete node.data.imageAssetReady;
            delete node.data.imageMemoryReleased;
            if (deleteImageAsset) await deleteImageAsset(nodeId);
            clearDisplayImageAssetState(nodeId);
            renderImageCompareEmptyState(nodeId, nextImageA ? '等待 B 输入' : '等待 A / B 输入');
            return;
        }

        node.data.image = nextImageB;
        node.imageData = isInlineImageData(nextImageB) ? nextImageB : null;
        if (node.imageData) {
            markNodeImageAssetPending(node, nodeId, 1);
            const ok = await saveImageAsset(nodeId, node.imageData);
            if (ok) markNodeImageAssetReady(node, nodeId, 1);
        } else {
            delete node.data.imageAssetKey;
            delete node.data.imageCount;
            delete node.data.imageAssetReady;
            delete node.data.imageMemoryReleased;
            if (deleteImageAsset) await deleteImageAsset(nodeId);
            clearDisplayImageAssetState(nodeId);
        }

        renderImageComparePreview(nodeId, nextImageA, nextImageB);

        await showResolutionBadge(nodeId, nextImageB);
        if (shouldRequestFit(node, getPreviewLayoutSignature([nextImageB], { compareImageA: nextImageA, compareImageB: nextImageB }), 'comparePreviewLayoutSignature')) {
            requestNodeFit(nodeId);
        }
    }

    async function refreshDependentImageResizePreviews(sourceNodeId, options = {}, visited = new Set()) {
        if (visited.has(sourceNodeId)) return;
        visited.add(sourceNodeId);

        const sourceNode = getNodeById(sourceNodeId);
        const sourceImageList = Object.prototype.hasOwnProperty.call(options, 'sourceImage')
            ? normalizeImageList(options.sourceImage)
            : await getNodeOutputImageListAsync(sourceNode);
        const sourceImage = Object.prototype.hasOwnProperty.call(options, 'sourceImage')
            ? options.sourceImage
            : getNodePreviewSourceData(sourceNode);

        const dependents = state.connections
            .filter((conn) => (
                conn.from.nodeId === sourceNodeId
                && (conn.to.port === 'image' || conn.to.port === 'imageA' || conn.to.port === 'imageB')
            ))
            .map((conn) => conn.to.nodeId)
            .filter((nodeId, index, list) => list.indexOf(nodeId) === index);

        for (const nodeId of dependents) {
            const node = getNodeById(nodeId);
            if (!node) continue;
            if (node.enabled === false) {
                await refreshDependentImageResizePreviews(nodeId, { ...options, sourceImage: null }, visited);
                continue;
            }

            if (node.type === 'ImageResize') {
                await refreshImageResizePreview(nodeId, { ...options, sourceImage, cascade: false });
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

            if (node.type === 'CameraControl') {
                await syncCameraControlNodePreview(nodeId, sourceImage);
            }
        }
    }

    async function refreshAllImageResizePreviews(options = {}) {
        const imageResizeNodes = Array.from(state.nodes.values()).filter((node) => node.type === 'ImageResize');
        const roots = [];
        const rest = [];

        imageResizeNodes.forEach((node) => {
            const incoming = state.connections.find((conn) => conn.to.nodeId === node.id && conn.to.port === 'image');
            const upstream = incoming ? getNodeById(incoming.from.nodeId) : null;
            if (!incoming || !upstream || upstream.type !== 'ImageResize') roots.push(node.id);
            else rest.push(node.id);
        });

        const refreshed = new Set();
        for (const nodeId of roots) {
            await refreshImageResizePreview(nodeId, options);
            refreshed.add(nodeId);
        }
        for (const nodeId of rest) {
            if (!refreshed.has(nodeId)) await refreshImageResizePreview(nodeId, options);
        }
    }

    async function refreshAllRecoverableMediaNodes(options = {}) {
        const sourceNodeIds = Array.from(state.nodes.values())
            .filter((node) => (
                node?.enabled !== false
                && ['ImageImport', 'ImageGenerate', 'ImageResize', 'ImagePreview', 'ImageSave', 'ImageCompare'].includes(node.type)
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

        const sourceImage = options.sourceImage || await getResizeSourceImageAsync(nodeId);
        updateImageResizeModeState(nodeId);
        updateImageResizeQualityVisibility(nodeId, sourceImage);

        if (!sourceImage) {
            node.resizePreviewData = null;
            node.resizePreviewMeta = null;
            delete node.data.image;
            delete node.data.imageAssetKey;
            delete node.data.imageCount;
            delete node.data.imageAssetReady;
            delete node.data.imageMemoryReleased;
            clearDisplayImageAssetState(nodeId);
            renderImageResizeEmptyState(nodeId, '等待上游图片');
            if (options.cascade !== false) await refreshDependentImageResizePreviews(nodeId, options);
            return null;
        }

        if (isRemoteImageUrl(sourceImage)) {
            node.resizePreviewData = null;
            node.resizePreviewMeta = null;
            delete node.data.image;
            delete node.data.imageAssetKey;
            delete node.data.imageCount;
            delete node.data.imageAssetReady;
            delete node.data.imageMemoryReleased;
            clearDisplayImageAssetState(nodeId);
            renderImageResizeEmptyState(nodeId, 'URL 图片不支持缩放节点');
            if (options.cascade !== false) await refreshDependentImageResizePreviews(nodeId, options);
            return null;
        }

        const token = (node.resizePreviewToken || 0) + 1;
        node.resizePreviewToken = token;

        const sizeLabel = documentRef.getElementById(`${nodeId}-resize-size-label`);
        const bytesLabel = documentRef.getElementById(`${nodeId}-resize-bytes-label`);
        if (sizeLabel) sizeLabel.textContent = '正在计算预览...';
        if (bytesLabel) bytesLabel.textContent = '';

        try {
            const config = readImageResizeConfig(nodeId);
            const result = await resizeImageData(sourceImage, {
                mode: config.mode,
                scalePercent: config.scalePercent,
                targetWidth: config.targetWidth,
                targetHeight: config.targetHeight,
                keepAspect: config.keepAspect,
                quality: config.quality,
                format: detectOutputFormat(sourceImage)
            });

            if (!state.nodes.has(nodeId) || node.resizePreviewToken !== token) return null;

            node.resizePreviewData = result.dataUrl;
            node.resizePreviewMeta = result;
            node.data.image = result.dataUrl;
            node.imageData = result.dataUrl;
            node.imageDataList = [result.dataUrl];
            markNodeImageAssetPending(node, nodeId, 1);
            const saved = await saveImageAsset(nodeId, result.dataUrl);
            if (saved) markNodeImageAssetReady(node, nodeId, 1);
            renderImageResizeResult(nodeId, result);
            scheduleDisplayImageMemorySweep({ delayMs: displayImageMemoryManager.releaseGraceMs });

            if (options.cascade !== false) {
                await refreshDependentImageResizePreviews(nodeId, options);
            }
            return result;
        } catch (error) {
            if (!state.nodes.has(nodeId) || node.resizePreviewToken !== token) return null;
            renderImageResizeEmptyState(nodeId, '预览生成失败');
            return null;
        }
    }

    async function syncAspectLinkedDimension(nodeId, changedField) {
        const node = getNodeById(nodeId);
        if (!node) return;
        const keepAspect = documentRef.getElementById(`${nodeId}-keep-aspect`)?.checked;
        if (!keepAspect) return;

        const sourceImage = await getResizeSourceImageAsync(nodeId);
        if (!sourceImage) return;

        const res = parseResolutionText(await getImageResolution(sourceImage));
        if (!res?.width || !res?.height) return;

        const widthInput = documentRef.getElementById(`${nodeId}-target-width`);
        const heightInput = documentRef.getElementById(`${nodeId}-target-height`);
        if (!widthInput || !heightInput) return;

        if (changedField === 'width') {
            const width = parseInt(widthInput.value || '0', 10);
            if (width > 0) heightInput.value = String(Math.max(1, Math.round(width * res.height / res.width)));
        } else if (changedField === 'height') {
            const height = parseInt(heightInput.value || '0', 10);
            if (height > 0) widthInput.value = String(Math.max(1, Math.round(height * res.width / res.height)));
        }
    }

    function setupImageImport(id, el) {
        const fileInput = el.querySelector(`#${id}-file`);
        const dropZone = el.querySelector(`#${id}-drop`);
        const selectBtn = el.querySelector(`#${id}-select-btn`);
        const urlInput = el.querySelector(`#${id}-url-input`);
        const urlPreview = el.querySelector(`#${id}-url-preview`);
        const modeInput = el.querySelector(`#${id}-import-mode`);
        const openImagePicker = () => {
            if (!fileInput) return;
            fileInput.value = '';
            fileInput.click();
        };

        void syncImageImportSourceState(id);

        el.querySelectorAll(`.image-import-mode-btn[data-target="${id}"]`).forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!modeInput) return;
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

        dropZone.addEventListener('click', () => {
            if (state.justDragged) return;
            const node = getNodeById(id);
            if (node && node.importMode === 'upload') {
                void openStoredImageNodeFullscreen(id).then((opened) => {
                    if (!opened) openImagePicker();
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
            if (state.justDragged) return;
            const node = getNodeById(id);
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

            node.importMode = 'upload';
            node.imageUrl = '';
            node.imageData = data;
            node.data = node.data || {};
            node.data.image = data;
            const assetKey = await saveImageImportAsset(nodeId, data, node.imageImportAssetKey);
            if (assetKey) {
                node.imageImportAssetKey = assetKey;
                node.data.imageImportAssetKey = assetKey;
                markImageImportAssetReady(node, assetKey, 1);
            } else {
                const saved = await saveImageAsset(nodeId, data);
                if (saved) markImageImportAssetReady(node, nodeId, 1);
            }
            await syncImageImportSourceState(nodeId, { refreshDependents: true });
            scheduleDisplayImageMemorySweep({ delayMs: displayImageMemoryManager.releaseGraceMs });
            scheduleSave();
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

        node.importMode = 'upload';
        node.imageUrl = '';
        node.imageData = imageData;
        node.data = node.data || {};
        node.data.image = imageData;
        const assetKey = await saveImageImportAsset(nodeId, imageData, node.imageImportAssetKey);
        if (assetKey) {
            node.imageImportAssetKey = assetKey;
            node.data.imageImportAssetKey = assetKey;
            markImageImportAssetReady(node, assetKey, 1);
        } else {
            const saved = await saveImageAsset(nodeId, imageData);
            if (saved) markImageImportAssetReady(node, nodeId, 1);
        }
        await syncImageImportSourceState(nodeId, { refreshDependents: true });
        scheduleDisplayImageMemorySweep({ delayMs: displayImageMemoryManager.releaseGraceMs });
        scheduleSave();
        return true;
    }

    async function loadImageUrl(nodeId, rawUrl, options = {}) {
        const node = getNodeById(nodeId);
        if (isNodeRunning(nodeId)) {
            showToast('节点正在运行，暂不能修改图片', 'warning');
            return;
        }
        if (!node) return;

        const imageUrl = String(rawUrl || '').trim();
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
        if (deleteImageAsset) await deleteImageAsset(nodeId);
        await syncImageImportSourceState(nodeId, { refreshDependents: true });
        scheduleSave();
    }

    function setupImageResize(id, el) {
        const previewContainer = el.querySelector(`#${id}-resize-preview`);
        const modeInput = el.querySelector(`#${id}-resize-mode`);
        const scaleInput = el.querySelector(`#${id}-scale-percent`);
        const scaleValue = el.querySelector(`#${id}-scale-value`);
        const qualityInput = el.querySelector(`#${id}-quality`);
        const qualityValue = el.querySelector(`#${id}-quality-value`);
        const widthInput = el.querySelector(`#${id}-target-width`);
        const heightInput = el.querySelector(`#${id}-target-height`);
        const keepAspectInput = el.querySelector(`#${id}-keep-aspect`);

        const node = getNodeById(id);

        const updateRangeProgress = (input) => {
            if (!input) return;
            const min = Number(input.min || 0);
            const max = Number(input.max || 100);
            const value = Number(input.value || min);
            const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
            input.style.setProperty('--range-progress', `${percent}%`);
        };

        const queuePreviewRefresh = (delay = 180) => {
            const node = getNodeById(id);
            if (!node) return;
            if (node.resizePreviewTimer) windowRef.clearTimeout(node.resizePreviewTimer);
            node.resizePreviewTimer = windowRef.setTimeout(() => {
                refreshImageResizePreview(id);
            }, delay);
        };

        updateImageResizeModeState(id);
        updateImageResizeQualityVisibility(id, getResizeSourceImage(id) || getNodePreviewSourceData(getNodeById(id)));

        el.querySelectorAll(`.image-resize-mode-btn[data-target="${id}"]`).forEach((btn) => {
            btn.addEventListener('click', () => {
                modeInput.value = btn.dataset.mode;
                updateImageResizeModeState(id);
                refreshImageResizePreview(id);
                scheduleSave();
            });
        });

        scaleInput?.addEventListener('input', () => {
            if (scaleValue) scaleValue.textContent = `${scaleInput.value}%`;
            updateRangeProgress(scaleInput);
        });
        scaleInput?.addEventListener('change', () => {
            refreshImageResizePreview(id);
        });

        qualityInput?.addEventListener('input', () => {
            if (qualityValue) qualityValue.textContent = `${qualityInput.value}%`;
            updateRangeProgress(qualityInput);
        });
        qualityInput?.addEventListener('change', () => {
            refreshImageResizePreview(id);
        });

        updateRangeProgress(scaleInput);
        updateRangeProgress(qualityInput);

        widthInput?.addEventListener('input', async () => {
            await syncAspectLinkedDimension(id, 'width');
            queuePreviewRefresh();
        });
        heightInput?.addEventListener('input', async () => {
            await syncAspectLinkedDimension(id, 'height');
            queuePreviewRefresh();
        });
        keepAspectInput?.addEventListener('change', async () => {
            if (keepAspectInput.checked && widthInput?.value) {
                await syncAspectLinkedDimension(id, 'width');
            }
            refreshImageResizePreview(id);
        });

        previewContainer?.addEventListener('click', (e) => {
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
                outputWidth: node.outputWidth || 0,
                outputHeight: node.outputHeight || 0,
                outputQuality: node.outputQuality || null,
                estimatedBytes: node.estimatedBytes || estimateDataUrlSize(node.imageData)
            });
        } else if (persistedPreviewThumbnail) {
            renderImageResizeResult(id, {
                dataUrl: persistedPreviewThumbnail,
                outputWidth: node?.outputWidth || 0,
                outputHeight: node?.outputHeight || 0,
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
            outputWidth: meta.outputWidth || 0,
            outputHeight: meta.outputHeight || 0,
            outputQuality: meta.outputQuality || null,
            estimatedBytes: meta.estimatedBytes || estimateDataUrlSize(dataUrl)
        };
        node.resizePreviewData = dataUrl;
        node.resizePreviewMeta = result;
        node.data = node.data || {};
        node.data.image = dataUrl;
        node.imageData = dataUrl;
        node.imageDataList = [dataUrl];
        renderImageResizeResult(nodeId, result);
    }

    function setupImageSave(id, el) {
        const previewContainer = el.querySelector(`#${id}-save-preview`);
        const manualSaveBtn = el.querySelector(`#${id}-manual-save`);

        const stepPreview = (delta, event) => {
            event?.stopPropagation();
            void stepImageSaveNodeByDelta(id, delta);
        };

        const openSaveImagePreview = async () => {
            const node = getNodeById(id);
            const video = getStoredSaveVideo(node);
            if (video?.url) {
                windowRef.open(video.url, '_blank', 'noopener,noreferrer');
                return;
            }
            const image = getCurrentImageSavePreviewImage(node);
            if (image) {
                await openFullscreenPreview(image, id);
                return;
            }
            await openStoredImageNodeFullscreen(id);
        };

        bindPreviewKeyboardNavigation(
            previewContainer,
            () => getStoredImageSaveListAsync(getNodeById(id)),
            (images) => getImageSavePreviewIndex(getNodeById(id), images),
            (nextIndex, images, event) => {
                event?.stopPropagation();
                const node = getNodeById(id);
                if (!node) return;
                node.imagePreviewIndex = nextIndex;
                renderImageSavePreview(id, images);
                void showResolutionBadge(id, images[nextIndex]);
            }
        );

        previewContainer.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.image-save-preview-nav')) {
                e.stopPropagation();
            }
        });

        previewContainer.addEventListener('click', (e) => {
            const navButton = e.target.closest('.image-save-preview-nav');
            if (!navButton) return;
            stepPreview(parseInt(navButton.dataset.direction || '0', 10) || 0, e);
        });

        manualSaveBtn.addEventListener('click', async () => {
            const node = getNodeById(id);
            const images = await getStoredImageSaveListAsync(node);
            const video = getStoredSaveVideo(node);
            if (!node || (images.length === 0 && !video?.url)) return showToast('没有可保存的内容', 'warning');
            const filename = el.querySelector(`#${id}-filename`).value || 'image';
            if (images.length === 0 && video?.url) {
                try {
                    const filenameBase = buildVideoSaveFilenameBase(id, video, filename || 'video');
                    const link = documentRef.createElement('a');
                    link.href = video.url;
                    link.download = `${filenameBase}${detectVideoExtensionFromSource(video)}`;
                    link.rel = 'noopener noreferrer';
                    link.target = '_blank';
                    documentRef.body.appendChild(link);
                    link.click();
                    setTimeout(() => {
                        if (link.parentNode) documentRef.body.removeChild(link);
                    }, 100);
                    addLog('info', '视频手动下载已发起', '浏览器已直接发起视频下载请求。', {
                        sourceVideoUrl: video.url,
                        filenameBase
                    });
                    showToast('已发起视频下载', 'success');
                } catch (err) {
                    console.error('Manual save video error:', err);
                    showToast('保存失败: ' + (err?.message || String(err)), 'error');
                }
                return;
            }
            const filenameBases = buildImageSaveFilenameBases(id, images, filename);
            try {
                images.forEach((image, index) => {
                    const blob = dataURLtoBlob(image);
                    const pngBlob = new Blob([blob], { type: 'image/png' });
                    const url = URL.createObjectURL(pngBlob);
                    const link = documentRef.createElement('a');
                    link.href = url;
                    link.download = `${filenameBases[index]}.png`;
                    documentRef.body.appendChild(link);
                    link.click();
                    setTimeout(() => {
                        documentRef.body.removeChild(link);
                        URL.revokeObjectURL(url);
                    }, 100);
                });
                showToast(images.length > 1 ? `已手动保存 ${images.length} 张图片为 PNG` : '图片已手动保存为 PNG', 'success');
            } catch (err) {
                console.error('Manual save error:', err);
                showToast('保存失败: ' + err.message, 'error');
            }
        });

        previewContainer.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.justDragged) return;
            if (e.target.closest('.image-save-preview-nav')) return;
            if (e.target.closest('video')) return;
            void openSaveImagePreview();
        });

        el.querySelector(`#${id}-view-full`).addEventListener('click', (e) => {
            e.stopPropagation();
            void openSaveImagePreview();
        });
    }

    function getFocusedNodeId() {
        if (state.selectedNodes?.size === 1) {
            const selectedNodeId = Array.from(state.selectedNodes)[0];
            if (state.nodes?.has(selectedNodeId)) return selectedNodeId;
        }
        return state.activeNodeId && state.nodes?.has(state.activeNodeId)
            ? state.activeNodeId
            : null;
    }

    async function autoSaveToDir(nodeId, dataUrl) {
        const node = getNodeById(nodeId);
        if (!node) return;
        const images = normalizeImageList(dataUrl?.images ?? dataUrl);
        const video = dataUrl?.video && typeof dataUrl.video === 'object' ? dataUrl.video : null;
        if (images.length === 0 && !video?.url) return;
        const handle = state.globalSaveDirHandle;
        if (!handle) {
            showToast('自动保存提醒：尚未在通用设置中选择全局保存目录，内容仅保存在节点内', 'warning', 5000);
            addLog('warning', '自动保存跳过', '未在通用设置中配置保存路径', { nodeId });
            return;
        }
        try {
            const perm = await handle.queryPermission({ mode: 'readwrite' });
            if (perm !== 'granted') {
                try {
                    const req = await handle.requestPermission({ mode: 'readwrite' });
                    if (req !== 'granted') {
                        showToast('【自动保存失败】目录访问权限被拒绝', 'error');
                        addLog('error', '自动保存失败', '权限被拒绝', { nodeId });
                        return;
                    }
                } catch (e) {
                    showToast('自动保存失败：无法请求目录权限，请手动点击选择目录重新激活', 'error', 6000);
                    addLog('error', '自动保存失败', '无法请求权限: ' + e.message, { nodeId });
                    return;
                }
            }
            const prefix = documentRef.getElementById(`${nodeId}-filename`)?.value || (video?.url ? 'video' : 'image');
            const savedFilenames = [];
            if (images.length > 0) {
                const filenameBases = buildImageSaveFilenameBases(nodeId, images, prefix, { includeTimestamp: true });
                for (let index = 0; index < images.length; index += 1) {
                    const blob = dataURLtoBlob(images[index]);
                    const { fileHandle, filename } = await getAvailableFileHandle(handle, filenameBases[index]);
                    if (!fileHandle) throw new Error('无法创建文件');
                    const writable = await fileHandle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    savedFilenames.push(filename);
                }
            } else if (video?.url) {
                const filenameBase = buildVideoSaveFilenameBase(nodeId, video, prefix, { includeTimestamp: true });
                updateVideoAutoSaveToast(nodeId, {
                    subtitle: '正在通过后端下载视频并保存到目录...',
                    stage: '后端下载中',
                    loaded: 0,
                    total: 0,
                    status: '准备中',
                    speedBytesPerSecond: 0
                });
                const blob = await downloadGeneratedVideo(video.url, {
                    filenameBase,
                    onProgress: ({ loaded, total, speedBytesPerSecond, done }) => {
                        updateVideoAutoSaveToast(nodeId, {
                            subtitle: '正在通过后端下载视频并保存到目录...',
                            stage: done ? '正在写入目录' : '后端下载中',
                            loaded,
                            total,
                            status: done ? '即将写入文件' : '下载中',
                            speedBytesPerSecond
                        });
                    }
                });
                const extension = detectVideoExtensionFromSource(video, blob);
                const { fileHandle, filename } = await getAvailableFileHandle(
                    handle,
                    filenameBase,
                    extension
                );
                if (!fileHandle) throw new Error('无法创建文件');
                updateVideoAutoSaveToast(nodeId, {
                    subtitle: '正在把视频写入你设置的目录...',
                    stage: '写入目录中',
                    loaded: blob.size || 0,
                    total: blob.size || 0,
                    status: '写入中',
                    speedBytesPerSecond: 0
                });
                const writable = await fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();
                savedFilenames.push(filename);
                completeVideoAutoSaveToast(nodeId, `视频已自动保存：${filename}`);
            }
            showToast(
                images.length > 1
                    ? `已自动保存 ${images.length} 张图片`
                    : (images.length === 1 ? `图片已自动保存: ${savedFilenames[0]}` : `视频已自动保存: ${savedFilenames[0]}`),
                'success'
            );
            addLog('success', '自动保存成功', `已保存至: ${handle.name}/${savedFilenames.join(', ')}`);
        } catch (err) {
            if (video?.url) failVideoAutoSaveToast(nodeId, `视频自动保存失败：${err.message}`);
            console.error('Auto-save error:', err);
            showToast('自动保存出错: ' + err.message, 'error', 5000);
            addLog('error', '自动保存异常', err.message, { nodeId, error: err.stack || err });
        }
    }

    function setupImagePreview(id, el) {
        const previewContainer = el.querySelector(`#${id}-preview`);
        const zoomInBtn = el.querySelector(`#${id}-zoom-in`);
        const zoomOutBtn = el.querySelector(`#${id}-zoom-out`);
        const zoomResetBtn = el.querySelector(`#${id}-zoom-reset`);
        const fullscreenBtn = el.querySelector(`#${id}-fullscreen`);
        if (!previewContainer) return;

        const stepPreview = async (delta, event) => {
            event?.stopPropagation();
            await stepImagePreviewNodeByDelta(id, delta);
        };

        const openPreviewImage = async () => {
            const image = getCurrentImagePreviewImage(getNodeById(id));
            if (image) {
                await openFullscreenPreview(image, id);
                return;
            }
            await openStoredImageNodeFullscreen(id);
        };

        bindPreviewKeyboardNavigation(
            previewContainer,
            () => getStoredImagePreviewListAsync(getNodeById(id)),
            (images) => getImagePreviewIndex(getNodeById(id), images),
            (nextIndex, images, event) => {
                event?.stopPropagation();
                const node = getNodeById(id);
                if (!node) return;
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
            }
        );

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
            const img = previewContainer.querySelector('img');
            if (img) img.style.transform = 'scale(1)';
        });
        previewContainer.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.justDragged) return;
            if (e.target.closest('.image-save-preview-nav')) return;
            void openPreviewImage();
        });
        fullscreenBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            void openPreviewImage();
        });
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
        `;
        documentRef.body.appendChild(overlay);
        documentRef.body?.classList.add('image-compare-advanced-active');

        const shell = overlay.querySelector('.image-compare-advanced-shell');
        const stage = overlay.querySelector('.image-compare-advanced-stage');
        const status = overlay.querySelector('.image-compare-advanced-status');
        const thumbs = overlay.querySelector('.image-compare-advanced-thumbs');
        const expandButton = overlay.querySelector('.image-compare-expand-btn');
        const setButtons = Array.from(overlay.querySelectorAll('.image-compare-set-btn'));
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

        const createThumbButton = (item, index) => {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.className = `image-compare-thumb${index === selectedIndex ? ' selected' : ''}`;
            button.title = `${item.label}${item.source ? ` - ${item.source}` : ''}`;
            button.addEventListener('click', () => {
                selectedIndex = index;
                renderThumbs();
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
            if (event.key === 'Escape') cleanup();
        };
        overlay.querySelector('.image-compare-advanced-close').addEventListener('click', cleanup);
        documentRef.addEventListener('keydown', onKeyDown);

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
        const container = el.querySelector(`#${id}-compare`);
        if (!container) return;
        const advancedBtn = el.querySelector(`#${id}-advanced-compare`);

        container.addEventListener('mouseenter', () => {
            if (!container.classList.contains('has-a-image')) return;
            container.classList.add('is-comparing');
        });
        container.addEventListener('mousemove', (e) => {
            if (!container.classList.contains('has-a-image')) return;
            const rect = container.getBoundingClientRect();
            const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
            const percent = Math.max(0, Math.min(100, ratio * 100));
            container.style.setProperty('--compare-x', `${percent}%`);
            container.classList.add('is-comparing');
        });
        container.addEventListener('mouseleave', () => {
            container.classList.remove('is-comparing');
        });
        container.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.justDragged) return;
            void openStoredImageNodeFullscreen(id);
        });
        advancedBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.justDragged) return;
            openAdvancedImageCompare(id);
        });

        const node = getNodeById(id);
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
            if (imageB) void showResolutionBadge(id, imageB);
            if (!imageA && persistedPreviewThumbnail && state.connections.some((conn) => conn.to?.nodeId === id && conn.to?.port === 'imageA')) {
                void getConnectedImageInputAsync(id, 'imageA').then((resolvedA) => {
                    const latestNode = getNodeById(id);
                    if (!latestNode || latestNode.type !== 'ImageCompare') return;
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
        const img = node.el.querySelector(`#${nodeId}-preview img`);
        if (!img) return;
        node.previewZoom = Math.max(0.2, Math.min(10, (node.previewZoom || 1) * factor));
        img.style.transform = `scale(${node.previewZoom})`;
        img.style.transformOrigin = 'center center';
    }

    function isChromeElementExposed(element) {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;

        const x = Math.min(windowRef.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
        const y = Math.min(windowRef.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
        const topElement = documentRef.elementFromPoint(x, y);
        return topElement === element || element.contains(topElement);
    }

    function shouldIgnoreChromeOffsetForPreview() {
        const body = documentRef.body;
        if (!body) return false;

        const toolbarCovered = body.classList.contains('toolbar-pinned')
            && !isChromeElementExposed(documentRef.getElementById('toolbar'));
        const sidebarCovered = body.classList.contains('sidebar-pinned')
            && !isChromeElementExposed(documentRef.getElementById('side-bar'));

        return toolbarCovered || sidebarCovered;
    }

    async function openFullscreenPreview(src, nodeId = null) {
        displayImageMemoryManager.beginFullscreenPreview(nodeId);
        const overlay = documentRef.createElement('div');
        overlay.className = 'fullscreen-overlay fullscreen-ignore-chrome';
        overlay.tabIndex = -1;
        documentRef.body?.classList.add('preview-active');
        const context = nodeId ? await getNodeFullscreenImageContext(nodeId, src) : {
            node: null,
            images: normalizeImageList(src),
            index: 0
        };
        const images = context.images;
        let currentIndex = images.findIndex((image) => image === src);
        if (currentIndex < 0) currentIndex = context.index;
        if (currentIndex < 0) currentIndex = 0;
        const canCropImageImport = Boolean(
            context.node?.type === 'ImageImport'
            && context.node.importMode !== 'url'
        );
        overlay.classList.toggle('has-crop-action', canCropImageImport);
        overlay.innerHTML = `
            <div class="fullscreen-close" title="关闭 (Esc)">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </div>
            ${renderFullscreenCropControls(canCropImageImport)}
            ${nodeId ? `
            <div class="fullscreen-paint-btn" title="绘制/编辑">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </div>` : ''}
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
        const img = overlay.querySelector('img');
        const iw = overlay.querySelector('.fullscreen-img-wrapper');
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
        const syncNodePreviewIndex = () => {
            if (!nodeId || !context.node) return;
            context.node.imagePreviewIndex = currentIndex;
            previewIndexDirty = true;
        };
        const flushNodePreviewState = () => {
            if (!nodeId || !context.node || !previewIndexDirty) return;
            context.node.imagePreviewIndex = currentIndex;
            if (context.node.type === 'ImagePreview' || context.node.type === 'ImageGenerate') {
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
                    label.textContent = `${index + 1}/${images.length}`;
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
            currentIndex = (currentIndex + delta + images.length) % images.length;
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
        iw.addEventListener('mousedown', (e) => {
            if (cropper?.isActive()) return;
            if (e.button !== 0) return;
            e.preventDefault();
            isDragging = true;
            dragStart = { x: e.clientX - fsX, y: e.clientY - fsY };
            iw.style.cursor = 'grabbing';
        });
        const onMove = (e) => {
            if (!isDragging) return;
            fsX = e.clientX - dragStart.x;
            fsY = e.clientY - dragStart.y;
            updateFsT();
        };
        const onUp = () => {
            isDragging = false;
            iw.style.cursor = 'grab';
        };
        windowRef.addEventListener('mousemove', onMove);
        windowRef.addEventListener('mouseup', onUp);
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
            documentRef.removeEventListener('keydown', onEsc);
        };
        overlay.querySelector('.fullscreen-close').addEventListener('click', cleanup);
        if (nodeId) {
            overlay.querySelector('.fullscreen-paint-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                cleanup();
                openImagePainter(images[currentIndex] || src, nodeId);
            });
        }
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target === iw) cleanup();
        });
        const onEsc = (e) => {
            if (e.key === 'Escape') {
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
        requestAnimationFrame(() => overlay.classList.add('active'));
        overlay.focus({ preventScroll: true });
    }

    bindSelectedNodeKeyboardNavigation();

    return {
        showResolutionBadge,
        setupImageImport,
        renderImageImportUploadState,
        loadImageFile,
        loadImageData,
        setupImageResize,
        getResizeSourceImage,
        refreshImageResizePreview,
        refreshDependentImageResizePreviews,
        refreshAllImageResizePreviews,
        refreshAllRecoverableMediaNodes,
        restoreImageResizePreview,
        renderImagePreviewImage,
        renderImageSavePreview,
        renderImageComparePreview,
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
        setupImageCompare,
        syncImageCompareNode,
        adjustPreviewZoom,
        openFullscreenPreview
    };
}
