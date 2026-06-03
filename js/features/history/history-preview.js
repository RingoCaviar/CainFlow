/**
 * 管理历史记录详情预览，包括图片查看、下载、复制与删除等交互。
 */
import { escapeHistoryHtml, formatHistoryGenerationDuration, formatHistoryVideoSize } from './history-utils.js';

export function createHistoryPreviewApi({
    getHistory,
    getHistoryMetadata = async () => [],
    getHistoryEntry = async (id) => (await getHistory()).find((entry) => entry.id === id) || null,
    getHistoryImageBlob = async () => null,
    deleteHistoryEntry,
    getImageResolution,
    downloadImage,
    copyToClipboard,
    renderHistoryList,
    showToast,
    documentRef = document,
    windowRef = window
}) {
    const previewState = {
        scale: 1,
        x: 0,
        y: 0,
        isDragging: false,
        dragMoved: false,
        suppressNextBackdropClick: false,
        startX: 0,
        startY: 0,
        pointerStartClientX: 0,
        pointerStartClientY: 0,
        items: [],
        currentIndex: -1,
        currentItem: null,
        loadToken: 0,
        imageObjectUrl: '',
        videoObjectUrl: ''
    };

    function isVideoHistoryItem(item) {
        return item?.mediaType === 'video' || item?.hasVideo || item?.videoBlob instanceof Blob;
    }

    function getPreviewVideoElement() {
        let video = documentRef.getElementById('history-preview-video');
        if (video) return video;
        const viewport = documentRef.getElementById('preview-viewport');
        if (!viewport) return null;
        video = documentRef.createElement('video');
        video.id = 'history-preview-video';
        video.className = 'history-preview-video hidden';
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.draggable = false;
        viewport.appendChild(video);
        return video;
    }

    function revokePreviewVideoUrl() {
        if (!previewState.videoObjectUrl) return;
        URL.revokeObjectURL(previewState.videoObjectUrl);
        previewState.videoObjectUrl = '';
    }

    function revokePreviewImageUrl() {
        if (!previewState.imageObjectUrl) return;
        URL.revokeObjectURL(previewState.imageObjectUrl);
        previewState.imageObjectUrl = '';
    }

    function setPreviewMode(mode) {
        const img = documentRef.getElementById('history-preview-img');
        const video = getPreviewVideoElement();
        if (img) img.classList.toggle('hidden', mode === 'video');
        if (video) video.classList.toggle('hidden', mode !== 'video');
    }

    function updatePreviewTransform() {
        const img = documentRef.getElementById('history-preview-img');
        if (img) {
            img.style.transform = `translate(${previewState.x}px, ${previewState.y}px) scale(${previewState.scale})`;
        }
        const video = documentRef.getElementById('history-preview-video');
        if (video && !video.classList.contains('hidden')) {
            video.style.transform = `translate(${previewState.x}px, ${previewState.y}px) scale(${previewState.scale})`;
        }
    }

    function resetPreviewTransform() {
        previewState.scale = 1;
        previewState.x = 0;
        previewState.y = 0;
    }

    function fitPreviewImage() {
        const img = documentRef.getElementById('history-preview-img');
        const viewport = documentRef.getElementById('preview-viewport');
        if (!img || !viewport) return;

        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;

        if (iw && ih) {
            const safeWidth = Math.max(vw - 60, 80);
            const safeHeight = Math.max(vh - 60, 80);
            const scale = Math.min(safeWidth / iw, safeHeight / ih, 1);
            previewState.scale = scale;
            previewState.x = 0;
            previewState.y = 0;
            updatePreviewTransform();
        }
    }

    function fitPreviewVideo() {
        const video = documentRef.getElementById('history-preview-video');
        const viewport = documentRef.getElementById('preview-viewport');
        if (!video || !viewport) return;
        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        const iw = video.videoWidth || video.clientWidth || 1280;
        const ih = video.videoHeight || video.clientHeight || 720;
        const safeWidth = Math.max(vw - 60, 80);
        const safeHeight = Math.max(vh - 60, 80);
        const scale = Math.min(safeWidth / iw, safeHeight / ih, 1);
        previewState.scale = scale;
        previewState.x = 0;
        previewState.y = 0;
        updatePreviewTransform();
    }

    function fitCurrentPreviewMedia() {
        const item = previewState.currentItem || previewState.items[previewState.currentIndex];
        if (isVideoHistoryItem(item)) fitPreviewVideo();
        else fitPreviewImage();
    }

    function setPreviewImageSource(src, token) {
        const img = documentRef.getElementById('history-preview-img');
        if (!img || !src || token !== previewState.loadToken) return Promise.resolve('');

        return new Promise((resolve) => {
            const loader = new Image();
            loader.decoding = 'async';
            loader.onload = () => {
                if (token !== previewState.loadToken) {
                    resolve('');
                    return;
                }
                const resolution = loader.naturalWidth && loader.naturalHeight
                    ? `${loader.naturalWidth} × ${loader.naturalHeight}`
                    : '';
                img.onload = () => {
                    if (token !== previewState.loadToken) return;
                    img.classList.remove('history-preview-img-loading');
                    fitPreviewImage();
                };
                img.src = src;
                if (img.complete) {
                    img.classList.remove('history-preview-img-loading');
                    windowRef.requestAnimationFrame(fitPreviewImage);
                }
                resolve(resolution);
            };
            loader.onerror = async () => {
                if (token !== previewState.loadToken) {
                    resolve('');
                    return;
                }
                img.classList.remove('history-preview-img-loading');
                resolve(getImageResolution ? await getImageResolution(src) : '');
            };
            loader.src = src;
        });
    }

    function updatePreviewMeta(item, resolution) {
        const metaText = documentRef.getElementById('preview-meta');
        if (!metaText) return;
        const duration = formatHistoryGenerationDuration(item.generationDurationSeconds ?? item.generationDuration);
        const isVideo = isVideoHistoryItem(item);
        const videoSize = formatHistoryVideoSize(item.videoSizeBytes || item.videoBlob?.size || 0);
        metaText.innerHTML = `
            <span>模型: ${escapeHistoryHtml(item.model)}</span>
            <span>${isVideo ? '视频尺寸' : '分辨率'}: ${resolution || '未知'}</span>
            ${isVideo && videoSize ? `<span>大小: ${escapeHistoryHtml(videoSize)}</span>` : ''}
            ${duration ? `<span>耗时: ${escapeHistoryHtml(duration)}</span>` : ''}
            <span>时间: ${new Date(item.timestamp).toLocaleString()}</span>
            <span style="margin-left:auto; opacity:0.6; font-family:monospace;">${previewState.currentIndex + 1} / ${previewState.items.length}</span>
        `;
    }

    function syncPreviewNavState() {
        const btnPrev = documentRef.getElementById('btn-prev-preview');
        const btnNext = documentRef.getElementById('btn-next-preview');
        if (btnPrev) btnPrev.classList.toggle('disabled', previewState.currentIndex <= 0);
        if (btnNext) btnNext.classList.toggle('disabled', previewState.currentIndex >= previewState.items.length - 1);
    }

    async function getFullHistoryItem(item) {
        if (item?.image || item?.imageBlob || item?.videoBlob) return item;
        const entry = await getHistoryEntry(item.id);
        return entry || item;
    }

    async function getPreviewImageSource(item) {
        if (!item) return { src: '', objectUrl: '' };
        if (item.imageBlob instanceof Blob) {
            const objectUrl = URL.createObjectURL(item.imageBlob);
            return { src: objectUrl, objectUrl };
        }
        if (typeof getHistoryImageBlob === 'function' && item.id !== undefined) {
            const blob = await getHistoryImageBlob(item.id);
            if (blob instanceof Blob) {
                const objectUrl = URL.createObjectURL(blob);
                return { src: objectUrl, objectUrl };
            }
        }
        return { src: item.image || '', objectUrl: '' };
    }

    function downloadBlob(blob, filename) {
        if (!(blob instanceof Blob)) return false;
        const url = URL.createObjectURL(blob);
        const link = documentRef.createElement('a');
        link.href = url;
        link.download = filename;
        documentRef.body.appendChild(link);
        link.click();
        documentRef.body.removeChild(link);
        windowRef.setTimeout(() => URL.revokeObjectURL(url), 1000);
        return true;
    }

    function getVideoExtension(item) {
        const mime = String(item?.videoMimeType || item?.videoBlob?.type || '').toLowerCase();
        if (mime.includes('webm')) return '.webm';
        if (mime.includes('quicktime') || mime.includes('mov')) return '.mov';
        if (mime.includes('x-matroska') || mime.includes('mkv')) return '.mkv';
        return '.mp4';
    }

    function setPreviewVideoSource(item, token) {
        const video = getPreviewVideoElement();
        if (!video || token !== previewState.loadToken) return '';
        revokePreviewVideoUrl();
        const blob = item.videoBlob instanceof Blob ? item.videoBlob : item.video instanceof Blob ? item.video : null;
        const src = blob ? URL.createObjectURL(blob) : String(item.videoUrl || '');
        if (blob) previewState.videoObjectUrl = src;
        video.onloadedmetadata = () => {
            if (token !== previewState.loadToken) return;
            fitPreviewVideo();
            updatePreviewMeta(item, video.videoWidth && video.videoHeight ? `${video.videoWidth} × ${video.videoHeight}` : '');
        };
        video.src = src;
        video.load();
        return item.videoWidth && item.videoHeight ? `${item.videoWidth} × ${item.videoHeight}` : '';
    }

    async function updatePreviewContent(item) {
        if (!item) return;
        const token = ++previewState.loadToken;
        const img = documentRef.getElementById('history-preview-img');
        const video = getPreviewVideoElement();
        const promptText = documentRef.getElementById('preview-prompt');
        const metaText = documentRef.getElementById('preview-meta');
        const btnDownload = documentRef.getElementById('btn-download-preview');
        const btnCopy = documentRef.getElementById('btn-copy-prompt');
        const btnDelete = documentRef.getElementById('btn-delete-preview');

        previewState.currentItem = item;
        resetPreviewTransform();
        revokePreviewImageUrl();
        revokePreviewVideoUrl();
        const isVideo = isVideoHistoryItem(item);
        setPreviewMode(isVideo ? 'video' : 'image');

        if (img) {
            img.onload = null;
            img.classList.add('history-preview-img-loading');
            if (!isVideo && item.thumb) {
                img.src = item.thumb;
                windowRef.requestAnimationFrame(fitPreviewImage);
            } else if (!isVideo && !img.src) {
                img.removeAttribute('src');
            }
        }
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        }

        promptText.textContent = item.prompt || '';
        const duration = formatHistoryGenerationDuration(item.generationDurationSeconds ?? item.generationDuration);
        const videoSize = formatHistoryVideoSize(item.videoSizeBytes || 0);
        metaText.innerHTML = `
            <span>模型: ${escapeHistoryHtml(item.model)}</span>
            <span>${isVideo ? '视频尺寸' : '分辨率'}: 读取中...</span>
            ${isVideo && videoSize ? `<span>大小: ${escapeHistoryHtml(videoSize)}</span>` : ''}
            ${duration ? `<span>耗时: ${escapeHistoryHtml(duration)}</span>` : ''}
            <span>时间: ${new Date(item.timestamp).toLocaleString()}</span>
            <span style="margin-left:auto; opacity:0.6; font-family:monospace;">${previewState.currentIndex + 1} / ${previewState.items.length}</span>
        `;

        btnDownload.onclick = async (e) => {
            e.stopPropagation();
            const fullItem = await getFullHistoryItem(previewState.currentItem || item);
            if (isVideoHistoryItem(fullItem)) {
                if (downloadBlob(fullItem.videoBlob || fullItem.video, `cainflow_${fullItem.id}${getVideoExtension(fullItem)}`)) return;
                if (fullItem.videoUrl) windowRef.open(fullItem.videoUrl, '_blank', 'noopener,noreferrer');
                return;
            }
            if (fullItem?.image) downloadImage(fullItem.image, `cainflow_${fullItem.id}.png`);
        };
        btnCopy.onclick = (e) => {
            e.stopPropagation();
            copyToClipboard(item.prompt || '');
        };
        if (btnDelete) {
            btnDelete.onclick = (e) => {
                e.stopPropagation();
                deleteCurrentPreviewItem();
            };
        }

        syncPreviewNavState();

        const fullItem = isVideo ? await getFullHistoryItem(item) : item;
        if (token !== previewState.loadToken) return;
        previewState.currentItem = fullItem;

        if (isVideoHistoryItem(fullItem)) {
            const resolution = setPreviewVideoSource(fullItem, token);
            updatePreviewMeta(fullItem, resolution);
        } else {
            const { src, objectUrl } = await getPreviewImageSource(fullItem);
            if (token !== previewState.loadToken) {
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                return;
            }
            if (!src) {
                if (img) img.classList.remove('history-preview-img-loading');
                updatePreviewMeta(fullItem, '');
                return;
            }
            previewState.imageObjectUrl = objectUrl;
            const resolution = await setPreviewImageSource(src, token);
            if (token !== previewState.loadToken) return;
            updatePreviewMeta(fullItem, resolution);
        }
    }

    function closeHistoryPreview() {
        const modal = documentRef.getElementById('history-preview-modal');
        const img = documentRef.getElementById('history-preview-img');
        const video = documentRef.getElementById('history-preview-video');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('history-preview-from-fullscreen', 'history-preview-ignore-chrome');
        }
        if (img) {
            img.onload = null;
            img.removeAttribute('src');
        }
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
        revokePreviewImageUrl();
        revokePreviewVideoUrl();
        previewState.loadToken += 1;
        previewState.items = [];
        previewState.currentIndex = -1;
        previewState.currentItem = null;
        documentRef.removeEventListener('keydown', onPreviewKeyDown);
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

    async function openHistoryPreview(item, options = {}) {
        const modal = documentRef.getElementById('history-preview-modal');
        const viewport = documentRef.getElementById('preview-viewport');
        if (!modal) return;
        modal.classList.toggle('history-preview-from-fullscreen', options.fromFullscreen === true);
        modal.classList.toggle('history-preview-ignore-chrome', options.fromFullscreen !== true && shouldIgnoreChromeOffsetForPreview());
        modal.classList.remove('hidden');
        modal.onclick = (e) => {
            if (e.target === modal || e.target === viewport) {
                if (previewState.suppressNextBackdropClick) {
                    previewState.suppressNextBackdropClick = false;
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                closeHistoryPreview();
            }
        };
        documentRef.removeEventListener('keydown', onPreviewKeyDown);
        documentRef.addEventListener('keydown', onPreviewKeyDown);

        previewState.items = [item];
        previewState.currentIndex = 0;
        const contentPromise = updatePreviewContent(item);
        const history = await getHistoryMetadata({ includeThumbs: false });
        previewState.items = history.length ? history : [item];
        previewState.currentIndex = history.findIndex((entry) => entry.id === item.id);
        if (previewState.currentIndex < 0) previewState.currentIndex = 0;
        syncPreviewNavState();
        await contentPromise;

        fitCurrentPreviewMedia();
        previewState.isDragging = false;
        previewState.dragMoved = false;
        previewState.suppressNextBackdropClick = false;
    }

    async function navigateHistory(direction) {
        const newIndex = previewState.currentIndex + direction;
        if (newIndex < 0 || newIndex >= previewState.items.length) return;

        previewState.currentIndex = newIndex;
        const item = previewState.items[newIndex];
        resetPreviewTransform();

        await updatePreviewContent(item);
    }

    function onPreviewKeyDown(e) {
        if (e.key === 'Escape') {
            closeHistoryPreview();
        } else if (e.key === 'ArrowLeft') {
            navigateHistory(-1);
        } else if (e.key === 'ArrowRight') {
            navigateHistory(1);
        } else if (e.key === 'Delete') {
            deleteCurrentPreviewItem();
        }
    }

    async function deleteCurrentPreviewItem() {
        const item = previewState.currentItem || previewState.items[previewState.currentIndex];
        if (!item) return;

        const isVideo = isVideoHistoryItem(item);
        if (windowRef.confirm(`确定要从历史记录中删除这${isVideo ? '个视频' : '张图片'}吗？\n此操作无法撤销。`)) {
            await deleteHistoryEntry(item.id);
            showToast('已从历史记录中删除', 'info');

            previewState.items.splice(previewState.currentIndex, 1);

            if (previewState.items.length === 0) {
                closeHistoryPreview();
            } else {
                if (previewState.currentIndex >= previewState.items.length) {
                    previewState.currentIndex = previewState.items.length - 1;
                }
                updatePreviewContent(previewState.items[previewState.currentIndex]);
            }

            renderHistoryList();
        }
    }

    async function deleteHistoryItems(ids) {
        if (!ids || ids.length === 0) return;
        try {
            await Promise.all(ids.map((id) => deleteHistoryEntry(Number(id))));
            return true;
        } catch (e) {
            console.error('Delete history items failed:', e);
        }
    }

    function initHistoryPreview() {
        const previewViewport = documentRef.getElementById('preview-viewport');
        if (previewViewport) {
            previewViewport.addEventListener('wheel', (e) => {
                e.preventDefault();
                const delta = e.deltaY > 0 ? 0.9 : 1.1;
                previewState.scale = Math.max(0.1, Math.min(20, previewState.scale * delta));
                updatePreviewTransform();
            }, { passive: false });

            previewViewport.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                if (e.target.closest?.('video')) return;
                previewState.isDragging = true;
                previewState.dragMoved = false;
                previewState.startX = e.clientX - previewState.x;
                previewState.startY = e.clientY - previewState.y;
                previewState.pointerStartClientX = e.clientX;
                previewState.pointerStartClientY = e.clientY;
            });

            windowRef.addEventListener('mousemove', (e) => {
                if (!previewState.isDragging) return;
                const dx = e.clientX - previewState.pointerStartClientX;
                const dy = e.clientY - previewState.pointerStartClientY;
                if ((dx * dx) + (dy * dy) > 16) {
                    previewState.dragMoved = true;
                }
                previewState.x = e.clientX - previewState.startX;
                previewState.y = e.clientY - previewState.startY;
                updatePreviewTransform();
            });

            windowRef.addEventListener('mouseup', () => {
                if (previewState.isDragging && previewState.dragMoved) {
                    previewState.suppressNextBackdropClick = true;
                    windowRef.setTimeout(() => {
                        previewState.suppressNextBackdropClick = false;
                    }, 120);
                }
                previewState.isDragging = false;
            });
        }

        windowRef.addEventListener('resize', () => {
            const modal = documentRef.getElementById('history-preview-modal');
            if (!modal || modal.classList.contains('hidden')) return;
            fitCurrentPreviewMedia();
        });

        documentRef.getElementById('btn-close-preview')?.addEventListener('click', closeHistoryPreview);
        documentRef.getElementById('btn-prev-preview')?.addEventListener('click', (e) => {
            e.stopPropagation();
            navigateHistory(-1);
        });
        documentRef.getElementById('btn-next-preview')?.addEventListener('click', (e) => {
            e.stopPropagation();
            navigateHistory(1);
        });
    }

    return {
        openHistoryPreview,
        deleteHistoryItems,
        initHistoryPreview
    };
}
