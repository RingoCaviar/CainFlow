/**
 * 管理历史记录详情预览，包括图片查看、下载、复制与删除等交互。
 */
export function createHistoryPreviewApi({
    getHistory,
    deleteHistoryEntry,
    openDB,
    storeHistoryName,
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
        currentIndex: -1
    };

    function updatePreviewTransform() {
        const img = documentRef.getElementById('history-preview-img');
        if (img) {
            img.style.transform = `translate(${previewState.x}px, ${previewState.y}px) scale(${previewState.scale})`;
        }
    }

    async function updatePreviewContent(item) {
        if (!item) return;
        const img = documentRef.getElementById('history-preview-img');
        const promptText = documentRef.getElementById('preview-prompt');
        const metaText = documentRef.getElementById('preview-meta');
        const btnDownload = documentRef.getElementById('btn-download-preview');
        const btnCopy = documentRef.getElementById('btn-copy-prompt');
        const btnDelete = documentRef.getElementById('btn-delete-preview');
        const resolution = await getImageResolution(item.image);

        img.src = item.image;
        promptText.textContent = item.prompt;
        metaText.innerHTML = `
        <span>模型: ${item.model}</span>
        <span>分辨率: ${resolution || '未知'}</span>
        <span>时间: ${new Date(item.timestamp).toLocaleString()}</span>
        <span style="margin-left:auto; opacity:0.6; font-family:monospace;">${previewState.currentIndex + 1} / ${previewState.items.length}</span>
    `;

        btnDownload.onclick = (e) => {
            e.stopPropagation();
            downloadImage(item.image, `cainflow_${item.id}.png`);
        };
        btnCopy.onclick = (e) => {
            e.stopPropagation();
            copyToClipboard(item.prompt);
        };
        if (btnDelete) {
            btnDelete.onclick = (e) => {
                e.stopPropagation();
                deleteCurrentPreviewItem();
            };
        }

        const btnPrev = documentRef.getElementById('btn-prev-preview');
        const btnNext = documentRef.getElementById('btn-next-preview');
        if (btnPrev) btnPrev.classList.toggle('disabled', previewState.currentIndex <= 0);
        if (btnNext) btnNext.classList.toggle('disabled', previewState.currentIndex >= previewState.items.length - 1);
    }

    function closeHistoryPreview() {
        const modal = documentRef.getElementById('history-preview-modal');
        if (modal) modal.classList.add('hidden');
        documentRef.removeEventListener('keydown', onPreviewKeyDown);
    }

    async function openHistoryPreview(item) {
        const modal = documentRef.getElementById('history-preview-modal');
        const viewport = documentRef.getElementById('preview-viewport');

        const history = await getHistory();
        previewState.items = history;
        previewState.currentIndex = history.findIndex((entry) => entry.id === item.id);

        await updatePreviewContent(item);
        modal.classList.remove('hidden');

        previewState.scale = 1;
        previewState.x = 0;
        previewState.y = 0;
        previewState.isDragging = false;

        const img = documentRef.getElementById('history-preview-img');
        const fitImage = () => {
            const vw = viewport.clientWidth;
            const vh = viewport.clientHeight;
            const iw = img.naturalWidth || img.width;
            const ih = img.naturalHeight || img.height;

            if (iw && ih) {
                const scale = Math.min((vw - 60) / iw, (vh - 60) / ih, 1);
                previewState.scale = scale;
                previewState.x = 0;
                previewState.y = 0;
                updatePreviewTransform();
            }
        };

        if (img.complete) fitImage();
        else img.onload = fitImage;

        updatePreviewTransform();

        modal.onclick = (e) => {
            if (e.target === modal || e.target === viewport) {
                closeHistoryPreview();
            }
        };

        documentRef.addEventListener('keydown', onPreviewKeyDown);
    }

    async function navigateHistory(direction) {
        const newIndex = previewState.currentIndex + direction;
        if (newIndex < 0 || newIndex >= previewState.items.length) return;

        previewState.currentIndex = newIndex;
        const item = previewState.items[newIndex];
        previewState.scale = 1;
        previewState.x = 0;
        previewState.y = 0;

        await updatePreviewContent(item);

        const img = documentRef.getElementById('history-preview-img');
        const viewport = documentRef.getElementById('preview-viewport');
        const applyFit = () => {
            const scale = Math.min((viewport.clientWidth - 60) / (img.naturalWidth || 100), (viewport.clientHeight - 60) / (img.naturalHeight || 100), 1);
            previewState.scale = scale;
            updatePreviewTransform();
        };

        if (img.complete) setTimeout(applyFit, 50);
        else img.onload = applyFit;
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
        const item = previewState.items[previewState.currentIndex];
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
            const db = await openDB();
            const tx = db.transaction(storeHistoryName, 'readwrite');
            const store = tx.objectStore(storeHistoryName);
            ids.forEach((id) => store.delete(id));
            return new Promise((resolve) => {
                tx.oncomplete = () => resolve(true);
            });
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
