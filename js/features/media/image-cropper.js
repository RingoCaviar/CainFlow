/**
 * Fullscreen image cropper helpers for local ImageImport previews.
 */
export function renderFullscreenCropControls(enabled) {
    if (!enabled) return '';
    return `
            <button type="button" class="fullscreen-crop-btn" title="裁剪图片" aria-label="裁剪图片">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>
            </button>
            <div class="fullscreen-crop-actions hidden" role="toolbar" aria-label="裁剪操作">
                <button type="button" class="fullscreen-crop-action fullscreen-crop-cancel">取消</button>
                <button type="button" class="fullscreen-crop-action fullscreen-crop-apply" disabled>应用裁剪</button>
            </div>`;
}

export function renderFullscreenCropLayer(enabled) {
    if (!enabled) return '';
    return `
                    <div class="fullscreen-crop-layer hidden" aria-label="拖拽框选裁剪区域">
                        <div class="fullscreen-crop-hint">拖拽框选裁剪区域</div>
                        <div class="fullscreen-crop-box hidden"></div>
                    </div>`;
}

export function cropImageDataUrl(source, cropRect, {
    detectOutputFormat,
    isInlineImageData,
    documentRef = document,
    imageCtor = null
} = {}) {
    return new Promise((resolve, reject) => {
        if (typeof isInlineImageData === 'function' && !isInlineImageData(source)) {
            reject(new Error('仅支持裁剪本地导入图片'));
            return;
        }
        const ImageCtor = imageCtor || documentRef.defaultView?.Image;
        if (!ImageCtor) {
            reject(new Error('当前环境不支持图片裁剪'));
            return;
        }
        const image = new ImageCtor();
        image.onload = () => {
            const canvas = documentRef.createElement('canvas');
            canvas.width = cropRect.width;
            canvas.height = cropRect.height;
            const ctx = canvas.getContext('2d', { alpha: true });
            if (!ctx) {
                reject(new Error('无法创建裁剪画布'));
                return;
            }
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(
                image,
                cropRect.x,
                cropRect.y,
                cropRect.width,
                cropRect.height,
                0,
                0,
                cropRect.width,
                cropRect.height
            );
            const format = typeof detectOutputFormat === 'function'
                ? detectOutputFormat(source)
                : 'image/png';
            const result = format === 'image/jpeg' || format === 'image/webp'
                ? canvas.toDataURL(format, 0.92)
                : canvas.toDataURL(format);
            canvas.width = 0;
            canvas.height = 0;
            resolve(result);
        };
        image.onerror = () => reject(new Error('图片加载失败，无法裁剪'));
        image.src = source;
    });
}

export function createFullscreenImageCropper({
    overlay,
    imageElement,
    wrapperElement,
    enabled = false,
    getSource = () => '',
    onApply = async () => false,
    onApplied = () => {},
    resetTransform = () => {},
    showToast = () => {},
    detectOutputFormat,
    isInlineImageData,
    documentRef = document,
    windowRef = window
} = {}) {
    const cropButton = overlay?.querySelector('.fullscreen-crop-btn');
    const cropLayer = overlay?.querySelector('.fullscreen-crop-layer');
    const cropBox = overlay?.querySelector('.fullscreen-crop-box');
    const cropActions = overlay?.querySelector('.fullscreen-crop-actions');
    const cropApplyButton = overlay?.querySelector('.fullscreen-crop-apply');
    const cropCancelButton = overlay?.querySelector('.fullscreen-crop-cancel');

    let active = false;
    let selecting = false;
    let startPoint = null;
    let selection = null;

    const isAvailable = () => Boolean(enabled && cropLayer);

    const resetSelection = () => {
        selection = null;
        startPoint = null;
        if (cropBox) {
            cropBox.classList.add('hidden');
            cropBox.style.left = '0px';
            cropBox.style.top = '0px';
            cropBox.style.width = '0px';
            cropBox.style.height = '0px';
        }
        if (cropApplyButton) cropApplyButton.disabled = true;
    };

    const setMode = (nextActive) => {
        let enabledMode = Boolean(nextActive && enabled && cropLayer);
        if (enabledMode && !getSource()) {
            showToast('当前图片暂不支持裁剪，请重新选择本地图片', 'warning');
            enabledMode = false;
        }
        active = enabledMode;
        selecting = false;
        overlay?.classList.toggle('is-cropping', active);
        cropLayer?.classList.toggle('hidden', !active);
        cropActions?.classList.toggle('hidden', !active);
        if (wrapperElement) wrapperElement.style.cursor = active ? 'crosshair' : 'grab';
        resetSelection();
    };

    const getVisibleImageRect = () => {
        const wrapperRect = wrapperElement.getBoundingClientRect();
        const imageRect = imageElement.getBoundingClientRect();
        return {
            left: Math.max(0, imageRect.left - wrapperRect.left),
            top: Math.max(0, imageRect.top - wrapperRect.top),
            right: Math.min(wrapperRect.width, imageRect.right - wrapperRect.left),
            bottom: Math.min(wrapperRect.height, imageRect.bottom - wrapperRect.top)
        };
    };

    const getCropPoint = (event) => {
        const wrapperRect = wrapperElement.getBoundingClientRect();
        const imageRect = getVisibleImageRect();
        return {
            x: Math.max(imageRect.left, Math.min(imageRect.right, event.clientX - wrapperRect.left)),
            y: Math.max(imageRect.top, Math.min(imageRect.bottom, event.clientY - wrapperRect.top))
        };
    };

    const isPointInsideVisibleImage = (point) => {
        const imageRect = getVisibleImageRect();
        return point.x >= imageRect.left
            && point.x <= imageRect.right
            && point.y >= imageRect.top
            && point.y <= imageRect.bottom;
    };

    const updateSelection = (point) => {
        if (!startPoint || !cropBox) return;
        const left = Math.min(startPoint.x, point.x);
        const top = Math.min(startPoint.y, point.y);
        const width = Math.abs(point.x - startPoint.x);
        const height = Math.abs(point.y - startPoint.y);
        selection = { left, top, width, height };
        cropBox.style.left = `${left}px`;
        cropBox.style.top = `${top}px`;
        cropBox.style.width = `${width}px`;
        cropBox.style.height = `${height}px`;
        cropBox.classList.toggle('hidden', width < 2 || height < 2);
        if (cropApplyButton) cropApplyButton.disabled = width < 8 || height < 8;
    };

    const applySelection = async () => {
        if (!selection || selection.width < 8 || selection.height < 8) {
            showToast('请先框选裁剪区域', 'warning');
            return;
        }
        const imageRect = imageElement.getBoundingClientRect();
        const wrapperRect = wrapperElement.getBoundingClientRect();
        const selectionRect = {
            left: wrapperRect.left + selection.left,
            top: wrapperRect.top + selection.top,
            right: wrapperRect.left + selection.left + selection.width,
            bottom: wrapperRect.top + selection.top + selection.height
        };
        const left = Math.max(selectionRect.left, imageRect.left);
        const top = Math.max(selectionRect.top, imageRect.top);
        const right = Math.min(selectionRect.right, imageRect.right);
        const bottom = Math.min(selectionRect.bottom, imageRect.bottom);
        if (right - left < 2 || bottom - top < 2 || !imageElement.naturalWidth || !imageElement.naturalHeight) {
            showToast('裁剪区域太小', 'warning');
            return;
        }

        const sourceImage = getSource();
        if (!sourceImage) {
            showToast('未找到可裁剪的本地原图', 'warning');
            return;
        }
        const cropRect = {
            x: Math.max(0, Math.floor((left - imageRect.left) / imageRect.width * imageElement.naturalWidth)),
            y: Math.max(0, Math.floor((top - imageRect.top) / imageRect.height * imageElement.naturalHeight)),
            width: Math.max(1, Math.round((right - left) / imageRect.width * imageElement.naturalWidth)),
            height: Math.max(1, Math.round((bottom - top) / imageRect.height * imageElement.naturalHeight))
        };
        cropRect.width = Math.min(cropRect.width, imageElement.naturalWidth - cropRect.x);
        cropRect.height = Math.min(cropRect.height, imageElement.naturalHeight - cropRect.y);

        try {
            if (cropApplyButton) cropApplyButton.disabled = true;
            const croppedData = await cropImageDataUrl(sourceImage, cropRect, {
                detectOutputFormat,
                isInlineImageData,
                documentRef,
                imageCtor: windowRef.Image || documentRef.defaultView?.Image
            });
            const saved = await onApply(croppedData);
            if (!saved) {
                showToast('裁剪结果保存失败', 'error');
                return;
            }
            imageElement.src = croppedData;
            resetTransform();
            setMode(false);
            onApplied(croppedData);
            showToast('图片已裁剪', 'success');
        } catch (error) {
            console.error('Crop image failed:', error);
            showToast('裁剪失败: ' + (error?.message || String(error)), 'error');
        } finally {
            if (cropApplyButton) cropApplyButton.disabled = !selection || selection.width < 8 || selection.height < 8;
        }
    };

    const handleLayerMouseDown = (event) => {
        if (event.button !== 0 || !active) return;
        event.preventDefault();
        event.stopPropagation();
        const wrapperRect = wrapperElement.getBoundingClientRect();
        const rawPoint = {
            x: event.clientX - wrapperRect.left,
            y: event.clientY - wrapperRect.top
        };
        if (!isPointInsideVisibleImage(rawPoint)) return;
        selecting = true;
        startPoint = getCropPoint(event);
        updateSelection(startPoint);
    };

    const handleMouseMove = (event) => {
        if (!selecting) return;
        updateSelection(getCropPoint(event));
    };

    const handleMouseUp = () => {
        selecting = false;
    };

    cropButton?.addEventListener('click', (event) => {
        event.stopPropagation();
        setMode(!active);
    });
    cropCancelButton?.addEventListener('click', (event) => {
        event.stopPropagation();
        setMode(false);
    });
    cropApplyButton?.addEventListener('click', (event) => {
        event.stopPropagation();
        void applySelection();
    });
    cropLayer?.addEventListener('mousedown', handleLayerMouseDown);
    windowRef.addEventListener('mousemove', handleMouseMove);
    windowRef.addEventListener('mouseup', handleMouseUp);

    const cleanup = () => {
        setMode(false);
        cropLayer?.removeEventListener('mousedown', handleLayerMouseDown);
        windowRef.removeEventListener('mousemove', handleMouseMove);
        windowRef.removeEventListener('mouseup', handleMouseUp);
    };

    return {
        cleanup,
        isActive: () => active,
        isSelecting: () => selecting,
        setMode,
        updateAvailability() {
            cropButton?.classList.toggle('hidden', !isAvailable());
            if (!isAvailable()) setMode(false);
        }
    };
}
