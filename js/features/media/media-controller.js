/**
 * 管理图片导入、预览、保存与自动落盘等媒体节点共用行为。
 */
export function createMediaControllerApi({
    state,
    getNodeById,
    saveImageAsset,
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
    openImagePainter,
    fitNodeToContent = () => {},
    documentRef = document,
    windowRef = window
}) {
    function requestNodeFit(nodeId) {
        windowRef.requestAnimationFrame(() => {
            fitNodeToContent(nodeId, { allowShrink: true });
        });
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
        if (!node) return null;
        if (node.type === 'ImageImport') {
            return node.importMode === 'url'
                ? (node.imageUrl || null)
                : (node.imageData || null);
        }
        return node.resizePreviewData || node.data?.image || node.imageData || null;
    }

    function isInlineImageData(value) {
        return typeof value === 'string' && /^data:image\//i.test(value);
    }

    function isRemoteImageUrl(value) {
        return typeof value === 'string' && /^https?:\/\//i.test(value);
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

        requestNodeFit(nodeId);
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
                preview.innerHTML = `<img src="${imageUrl}" alt="URL 图片预览" draggable="false" style="pointer-events: none;" />`;
            } else {
                preview.classList.remove('has-image');
                preview.innerHTML = `<div class="drop-text">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                    ${imageUrl ? '请输入有效的图片 URL' : '输入 URL 后自动显示预览'}
                </div>`;
            }
        }
        clearImageImportBadge(nodeId);
        requestNodeFit(nodeId);
    }

    function renderImageImportUploadState(nodeId, imageData = null) {
        const dropZone = documentRef.getElementById(`${nodeId}-drop`);
        if (!dropZone) return;

        if (imageData) {
            dropZone.classList.add('has-image');
            dropZone.innerHTML = `<img src="${imageData}" alt="已导入图片" draggable="false" style="pointer-events: none;" />`;
            showResolutionBadge(nodeId, imageData);
        } else {
            dropZone.classList.remove('has-image');
            dropZone.innerHTML = `<div class="drop-text">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                拖拽图片到此处
            </div>`;
            clearImageImportBadge(nodeId);
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
            renderImageImportUrlState(nodeId, node.imageUrl || '');
        } else {
            if (node.imageData) node.data.image = node.imageData;
            else delete node.data.image;
            renderImageImportUploadState(nodeId, node.imageData || null);
        }

        if (refreshDependents) {
            await refreshDependentImageResizePreviews(nodeId);
        }

        return node.data.image || null;
    }

    async function showResolutionBadge(nodeId, dataUrl) {
        const badge = documentRef.getElementById(`${nodeId}-res`);
        if (!badge) return;
        const res = await getImageResolution(dataUrl);
        if (res) {
            badge.textContent = `尺寸 ${res}`;
            badge.style.display = 'block';
        } else {
            badge.textContent = '';
            badge.style.display = 'none';
        }
    }

    function renderImageResizeEmptyState(nodeId, message = '等待上游图片') {
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
            preview.innerHTML = `<img src="${result.dataUrl}" alt="缩放结果预览" draggable="false" />`;
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

    async function syncImagePreviewNode(nodeId, imageData) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImagePreview') return;

        const previewContainer = documentRef.getElementById(`${nodeId}-preview`);
        const controls = documentRef.getElementById(`${nodeId}-controls`);
        const resolutionBadge = documentRef.getElementById(`${nodeId}-res`);

        node.previewZoom = 1;
        node.imageData = imageData || null;
        node.data = node.data || {};

        if (isRemoteImageUrl(imageData)) {
            node.data.image = imageData;
            if (previewContainer) {
                previewContainer.innerHTML = `<img src="${imageData}" alt="预览" style="cursor:pointer" draggable="false" />`;
            }
            if (controls) controls.style.display = 'flex';
            if (deleteImageAsset) await deleteImageAsset(nodeId);
            await showResolutionBadge(nodeId, imageData);
            requestNodeFit(nodeId);
            return;
        }

        if (imageData) {
            node.data.image = imageData;
            if (previewContainer) {
                previewContainer.innerHTML = `<img src="${imageData}" alt="预览" style="cursor:pointer" draggable="false" />`;
            }
            if (controls) controls.style.display = 'flex';
            await saveImageAsset(nodeId, imageData);
            await showResolutionBadge(nodeId, imageData);
        } else {
            delete node.data.image;
            if (previewContainer) {
                previewContainer.innerHTML = `<div class="preview-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>无输入图片</div>`;
            }
            if (controls) controls.style.display = 'none';
            if (deleteImageAsset) await deleteImageAsset(nodeId);
            if (resolutionBadge) {
                resolutionBadge.textContent = '';
                resolutionBadge.style.display = 'none';
            }
        }

        requestNodeFit(nodeId);
    }

    async function syncImageSaveNode(nodeId, imageData) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImageSave') return;

        const previewContainer = documentRef.getElementById(`${nodeId}-save-preview`);
        const manualSaveBtn = documentRef.getElementById(`${nodeId}-manual-save`);
        const viewFullBtn = documentRef.getElementById(`${nodeId}-view-full`);
        const resolutionBadge = documentRef.getElementById(`${nodeId}-res`);

        node.imageData = imageData || null;
        node.data = node.data || {};

        if (isRemoteImageUrl(imageData)) {
            node.imageData = null;
            delete node.data.image;
            if (previewContainer) {
                previewContainer.innerHTML = '<div class="save-preview-placeholder">URL 图片不支持保存节点</div>';
            }
            if (manualSaveBtn) manualSaveBtn.disabled = true;
            if (viewFullBtn) viewFullBtn.disabled = true;
            if (deleteImageAsset) await deleteImageAsset(nodeId);
            if (resolutionBadge) {
                resolutionBadge.textContent = '';
                resolutionBadge.style.display = 'none';
            }
            requestNodeFit(nodeId);
            return;
        }

        if (imageData) {
            node.data.image = imageData;
            if (previewContainer) {
                previewContainer.innerHTML = `<img src="${imageData}" alt="待保存" draggable="false" />`;
            }
            if (manualSaveBtn) manualSaveBtn.disabled = false;
            if (viewFullBtn) viewFullBtn.disabled = false;
            await saveImageAsset(nodeId, imageData);
            await showResolutionBadge(nodeId, imageData);
        } else {
            delete node.data.image;
            if (previewContainer) {
                previewContainer.innerHTML = '<div class="save-preview-placeholder">无输入图片</div>';
            }
            if (manualSaveBtn) manualSaveBtn.disabled = true;
            if (viewFullBtn) viewFullBtn.disabled = true;
            if (deleteImageAsset) await deleteImageAsset(nodeId);
            if (resolutionBadge) {
                resolutionBadge.textContent = '';
                resolutionBadge.style.display = 'none';
            }
        }

        requestNodeFit(nodeId);
    }

    async function refreshDependentImageResizePreviews(sourceNodeId, options = {}, visited = new Set()) {
        if (visited.has(sourceNodeId)) return;
        visited.add(sourceNodeId);

        const sourceNode = getNodeById(sourceNodeId);
        const sourceImage = Object.prototype.hasOwnProperty.call(options, 'sourceImage')
            ? options.sourceImage
            : getNodePreviewSourceData(sourceNode);

        const dependents = state.connections
            .filter((conn) => conn.from.nodeId === sourceNodeId && conn.to.port === 'image')
            .map((conn) => conn.to.nodeId)
            .filter((nodeId, index, list) => list.indexOf(nodeId) === index);

        for (const nodeId of dependents) {
            const node = getNodeById(nodeId);
            if (!node) continue;

            if (node.type === 'ImageResize') {
                await refreshImageResizePreview(nodeId, { ...options, sourceImage, cascade: false });
                await refreshDependentImageResizePreviews(nodeId, options, visited);
                continue;
            }

            if (node.type === 'ImagePreview') {
                await syncImagePreviewNode(nodeId, sourceImage);
                await refreshDependentImageResizePreviews(nodeId, options, visited);
                continue;
            }

            if (node.type === 'ImageSave') {
                await syncImageSaveNode(nodeId, sourceImage);
                await refreshDependentImageResizePreviews(nodeId, options, visited);
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

    async function refreshImageResizePreview(nodeId, options = {}) {
        const node = getNodeById(nodeId);
        if (!node || node.type !== 'ImageResize') return null;

        const sourceImage = options.sourceImage || getResizeSourceImage(nodeId);
        updateImageResizeModeState(nodeId);
        updateImageResizeQualityVisibility(nodeId, sourceImage);

        if (!sourceImage) {
            node.resizePreviewData = null;
            node.resizePreviewMeta = null;
            renderImageResizeEmptyState(nodeId, '等待上游图片');
            if (options.cascade !== false) await refreshDependentImageResizePreviews(nodeId, options);
            return null;
        }

        if (isRemoteImageUrl(sourceImage)) {
            node.resizePreviewData = null;
            node.resizePreviewMeta = null;
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
            renderImageResizeResult(nodeId, result);

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

        const sourceImage = getResizeSourceImage(nodeId);
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
            if (node && node.importMode === 'upload' && node.imageData) {
                openFullscreenPreview(node.imageData, id);
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
            if (state.justDragged) return;
            const node = getNodeById(id);
            if (node?.importMode === 'url' && node.imageUrl) {
                openFullscreenPreview(node.imageUrl, id);
            }
        });
    }

    function loadImageFile(nodeId, file) {
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
            node.data.image = data;
            await saveImageAsset(nodeId, data);
            await syncImageImportSourceState(nodeId, { refreshDependents: true });
            scheduleSave();
        };
        reader.readAsDataURL(file);
    }

    async function loadImageUrl(nodeId, rawUrl, options = {}) {
        const node = getNodeById(nodeId);
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
            const img = previewContainer.querySelector('img');
            if (img) openFullscreenPreview(img.src, id);
        });

        if (node?.imageData) {
            renderImageResizeResult(id, {
                dataUrl: node.imageData,
                outputWidth: node.outputWidth || 0,
                outputHeight: node.outputHeight || 0,
                outputQuality: node.outputQuality || null,
                estimatedBytes: node.estimatedBytes || estimateDataUrlSize(node.imageData)
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
        renderImageResizeResult(nodeId, result);
    }

    function setupImageSave(id, el) {
        const previewContainer = el.querySelector(`#${id}-save-preview`);
        const manualSaveBtn = el.querySelector(`#${id}-manual-save`);

        manualSaveBtn.addEventListener('click', () => {
            const node = getNodeById(id);
            if (!node || !node.data.image) return showToast('没有可保存的图片', 'warning');
            const filename = el.querySelector(`#${id}-filename`).value || 'image';
            try {
                const blob = dataURLtoBlob(node.data.image);
                const pngBlob = new Blob([blob], { type: 'image/png' });
                const url = URL.createObjectURL(pngBlob);
                const link = documentRef.createElement('a');
                link.href = url;
                link.download = filename + '.png';
                documentRef.body.appendChild(link);
                link.click();
                setTimeout(() => {
                    documentRef.body.removeChild(link);
                    URL.revokeObjectURL(url);
                }, 100);
                showToast('图片已手动保存为 PNG', 'success');
            } catch (err) {
                console.error('Manual save error:', err);
                showToast('保存失败: ' + err.message, 'error');
            }
        });

        previewContainer.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.justDragged) return;
            const node = getNodeById(id);
            if (node && node.data.image) openFullscreenPreview(node.data.image, id);
        });

        el.querySelector(`#${id}-view-full`).addEventListener('click', (e) => {
            e.stopPropagation();
            const node = getNodeById(id);
            if (node && node.data.image) openFullscreenPreview(node.data.image, id);
        });
    }

    async function autoSaveToDir(nodeId, dataUrl) {
        const node = getNodeById(nodeId);
        if (!node) return;
        const handle = state.globalSaveDirHandle;
        if (!handle) {
            showToast('自动保存提醒：尚未在通用设置中选择全局保存目录，图片仅保存在节点内', 'warning', 5000);
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
            const prefix = documentRef.getElementById(`${nodeId}-filename`)?.value || 'image';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filename = `${prefix}_${timestamp}.png`;
            const blob = dataURLtoBlob(dataUrl);
            const fileHandle = await handle.getFileHandle(filename, { create: true });
            if (!fileHandle) throw new Error('无法创建文件');
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            showToast(`图片已自动保存: ${filename}`, 'success');
            addLog('success', '自动保存成功', `已保存至: ${handle.name}/${filename}`);
        } catch (err) {
            console.error('Auto-save error:', err);
            showToast('自动保存出错: ' + err.message, 'error', 5000);
            addLog('error', '自动保存异常', err.message, { nodeId, error: err.stack || err });
        }
    }

    function setupImagePreview(id, el) {
        const previewContainer = el.querySelector(`#${id}-preview`);
        el.querySelector(`#${id}-zoom-in`).addEventListener('click', (e) => {
            e.stopPropagation();
            adjustPreviewZoom(id, 1.25);
        });
        el.querySelector(`#${id}-zoom-out`).addEventListener('click', (e) => {
            e.stopPropagation();
            adjustPreviewZoom(id, 0.8);
        });
        el.querySelector(`#${id}-zoom-reset`).addEventListener('click', (e) => {
            e.stopPropagation();
            const node = getNodeById(id);
            if (node) node.previewZoom = 1;
            const img = previewContainer.querySelector('img');
            if (img) img.style.transform = 'scale(1)';
        });
        previewContainer.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.justDragged) return;
            const img = previewContainer.querySelector('img');
            if (img) openFullscreenPreview(img.src, id);
        });
        el.querySelector(`#${id}-fullscreen`).addEventListener('click', (e) => {
            e.stopPropagation();
            const img = previewContainer.querySelector('img');
            if (img) openFullscreenPreview(img.src, id);
        });
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

    function openFullscreenPreview(src, nodeId = null) {
        const overlay = documentRef.createElement('div');
        overlay.className = 'fullscreen-overlay';
        overlay.innerHTML = `
        <div class="fullscreen-close" title="关闭 (Esc)">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </div>
        ${nodeId ? `
        <div class="fullscreen-paint-btn" title="绘制/编辑">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </div>` : ''}
        <div class="fullscreen-img-wrapper">
            <img src="${src}" alt="全屏预览" draggable="false" />
        </div>`;
        documentRef.body.appendChild(overlay);
        const img = overlay.querySelector('img');
        let fsZoom = 1;
        let fsX = 0;
        let fsY = 0;
        let isDragging = false;
        let dragStart = { x: 0, y: 0 };
        const updateFsT = () => {
            img.style.transform = `translate(${fsX}px, ${fsY}px) scale(${fsZoom})`;
        };
        overlay.addEventListener('wheel', (e) => {
            e.preventDefault();
            const nz = Math.max(0.1, Math.min(20, fsZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
            const rect = overlay.getBoundingClientRect();
            const cx = e.clientX - rect.left - rect.width / 2;
            const cy = e.clientY - rect.top - rect.height / 2;
            fsX = cx - (cx - fsX) * (nz / fsZoom);
            fsY = cy - (cy - fsY) * (nz / fsZoom);
            fsZoom = nz;
            updateFsT();
        }, { passive: false });
        const iw = overlay.querySelector('.fullscreen-img-wrapper');
        iw.addEventListener('mousedown', (e) => {
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
            overlay.remove();
            windowRef.removeEventListener('mousemove', onMove);
            windowRef.removeEventListener('mouseup', onUp);
            documentRef.removeEventListener('keydown', onEsc);
        };
        overlay.querySelector('.fullscreen-close').addEventListener('click', cleanup);
        if (nodeId) {
            overlay.querySelector('.fullscreen-paint-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                cleanup();
                openImagePainter(src, nodeId);
            });
        }
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target === iw) cleanup();
        });
        const onEsc = (e) => {
            if (e.key === 'Escape') cleanup();
        };
        documentRef.addEventListener('keydown', onEsc);
        requestAnimationFrame(() => overlay.classList.add('active'));
    }

    return {
        showResolutionBadge,
        setupImageImport,
        loadImageFile,
        setupImageResize,
        getResizeSourceImage,
        refreshImageResizePreview,
        refreshDependentImageResizePreviews,
        refreshAllImageResizePreviews,
        restoreImageResizePreview,
        setupImageSave,
        autoSaveToDir,
        setupImagePreview,
        adjustPreviewZoom,
        openFullscreenPreview
    };
}
