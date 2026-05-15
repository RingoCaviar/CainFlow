/**
 * 管理历史记录详情预览，包括图片查看、下载、复制与删除等交互。
 */
export function createHistoryPreviewApi({
    getHistory,
    getHistoryMetadata = getHistory,
    getHistoryEntry = async (id) => (await getHistory()).find((entry) => entry.id === id) || null,
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
        startX: 0,
        startY: 0,
        items: [],
        currentIndex: -1,
        currentItem: null,
        loadToken: 0
    };

    function updatePreviewTransform() {
        const img = documentRef.getElementById('history-preview-img');
        if (img) {
            img.style.transform = `translate(${previewState.x}px, ${previewState.y}px) scale(${previewState.scale})`;
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
        metaText.innerHTML = `
            <span>模型: ${item.model}</span>
            <span>分辨率: ${resolution || '未知'}</span>
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
        if (item?.image) return item;
        const entry = await getHistoryEntry(item.id);
        return entry || item;
    }

    async function updatePreviewContent(item) {
        if (!item) return;
        const token = ++previewState.loadToken;
        const img = documentRef.getElementById('history-preview-img');
        const promptText = documentRef.getElementById('preview-prompt');
        const metaText = documentRef.getElementById('preview-meta');
        const btnDownload = documentRef.getElementById('btn-download-preview');
        const btnCopy = documentRef.getElementById('btn-copy-prompt');
        const btnDelete = documentRef.getElementById('btn-delete-preview');

        previewState.currentItem = item;
        resetPreviewTransform();

        if (img) {
            img.onload = null;
            img.classList.add('history-preview-img-loading');
            if (item.thumb) {
                img.src = item.thumb;
                windowRef.requestAnimationFrame(fitPreviewImage);
            } else if (!img.src) {
                img.removeAttribute('src');
            }
        }

        promptText.textContent = item.prompt || '';
        metaText.innerHTML = `
        <span>模型: ${item.model}</span>
        <span>分辨率: 读取中...</span>
        <span>时间: ${new Date(item.timestamp).toLocaleString()}</span>
        <span style="margin-left:auto; opacity:0.6; font-family:monospace;">${previewState.currentIndex + 1} / ${previewState.items.length}</span>
    `;

        btnDownload.onclick = async (e) => {
            e.stopPropagation();
            const fullItem = await getFullHistoryItem(previewState.currentItem || item);
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

        const fullItem = await getFullHistoryItem(item);
        if (token !== previewState.loadToken) return;
        previewState.currentItem = fullItem;

        if (fullItem?.image) {
            const resolution = await setPreviewImageSource(fullItem.image, token);
            if (token !== previewState.loadToken) return;
            updatePreviewMeta(fullItem, resolution);
        } else {
            updatePreviewMeta(item, '');
        }
    }

    function closeHistoryPreview() {
        const modal = documentRef.getElementById('history-preview-modal');
        if (modal) modal.classList.add('hidden');
        previewState.loadToken += 1;
        documentRef.removeEventListener('keydown', onPreviewKeyDown);
    }

    async function openHistoryPreview(item) {
        const modal = documentRef.getElementById('history-preview-modal');
        const viewport = documentRef.getElementById('preview-viewport');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.onclick = (e) => {
            if (e.target === modal || e.target === viewport) {
                closeHistoryPreview();
            }
        };
        documentRef.removeEventListener('keydown', onPreviewKeyDown);
        documentRef.addEventListener('keydown', onPreviewKeyDown);

        previewState.items = [item];
        previewState.currentIndex = 0;
        const contentPromise = updatePreviewContent(item);
        const history = await getHistoryMetadata();
        previewState.items = history.length ? history : [item];
        previewState.currentIndex = history.findIndex((entry) => entry.id === item.id);
        if (previewState.currentIndex < 0) previewState.currentIndex = 0;
        syncPreviewNavState();
        await contentPromise;

        fitPreviewImage();
        previewState.isDragging = false;
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

        if (windowRef.confirm('确定要从历史记录中删除这张图片吗？\n此操作无法撤销。')) {
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
                previewState.isDragging = true;
                previewState.startX = e.clientX - previewState.x;
                previewState.startY = e.clientY - previewState.y;
            });

            windowRef.addEventListener('mousemove', (e) => {
                if (!previewState.isDragging) return;
                previewState.x = e.clientX - previewState.startX;
                previewState.y = e.clientY - previewState.startY;
                updatePreviewTransform();
            });

            windowRef.addEventListener('mouseup', () => {
                previewState.isDragging = false;
            });
        }

        windowRef.addEventListener('resize', () => {
            const modal = documentRef.getElementById('history-preview-modal');
            if (!modal || modal.classList.contains('hidden')) return;
            fitPreviewImage();
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
