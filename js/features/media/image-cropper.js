/**
 * Fullscreen image cropper helpers for local ImageImport previews.
 */
const CROP_RATIO_PRESETS = [
    { id: 'free', label: '自由比例', ratio: null },
    { id: 'original', label: '原图比例', ratio: 'original' },
    { id: '1:1', label: '1:1 正方形', ratio: 1 },
    { id: '4:3', label: '4:3 横版', ratio: 4 / 3 },
    { id: '3:4', label: '3:4 竖版', ratio: 3 / 4 },
    { id: '16:9', label: '16:9 横屏', ratio: 16 / 9 },
    { id: '9:16', label: '9:16 竖屏', ratio: 9 / 16 },
    { id: '3:2', label: '3:2 照片', ratio: 3 / 2 },
    { id: '2:3', label: '2:3 竖照', ratio: 2 / 3 }
];

function renderCropRatioMenu() {
    const items = CROP_RATIO_PRESETS.map((preset) => `
        <div class="context-menu-item fullscreen-crop-ratio-item" data-crop-ratio="${preset.id}" role="menuitemradio" aria-checked="false">
            <span class="fullscreen-crop-ratio-check" aria-hidden="true"></span>
            <span class="fullscreen-crop-ratio-label">${preset.label}</span>
        </div>`).join('');
    return `
            <div class="context-menu fullscreen-crop-ratio-menu hidden" role="menu" aria-label="裁剪比例">
                <div class="context-menu-header">裁剪比例</div>
                ${items}
            </div>`;
}

export function renderFullscreenCropControls(enabled) {
    if (!enabled) return '';
    return `
            <button type="button" class="fullscreen-crop-btn" title="裁剪图片" aria-label="裁剪图片">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>
            </button>
            <div class="fullscreen-crop-actions hidden" role="toolbar" aria-label="裁剪操作">
                <button type="button" class="fullscreen-crop-action fullscreen-crop-cancel">取消</button>
                <button type="button" class="fullscreen-crop-action fullscreen-crop-apply" disabled>应用裁剪</button>
            </div>
            ${renderCropRatioMenu()}`;
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
    const cropRatioMenu = overlay?.querySelector('.fullscreen-crop-ratio-menu');

    let active = false;
    let selecting = false;
    let interactionMode = null;
    let startPoint = null;
    let dragStartPoint = null;
    let dragStartSelection = null;
    let selection = null;
    let activeRatioPresetId = 'free';
    const resizeHandleSize = 18;

    const isAvailable = () => Boolean(enabled && cropLayer);

    const getRatioPreset = (presetId = activeRatioPresetId) => (
        CROP_RATIO_PRESETS.find((preset) => preset.id === presetId) || CROP_RATIO_PRESETS[0]
    );

    const getActiveRatioValue = () => {
        const preset = getRatioPreset();
        if (preset.ratio === 'original') {
            const width = imageElement?.naturalWidth || 0;
            const height = imageElement?.naturalHeight || 0;
            return width > 0 && height > 0 ? width / height : null;
        }
        return Number.isFinite(preset.ratio) && preset.ratio > 0 ? preset.ratio : null;
    };

    const refreshRatioMenuState = () => {
        cropRatioMenu?.querySelectorAll('[data-crop-ratio]').forEach((item) => {
            const selected = item.dataset.cropRatio === activeRatioPresetId;
            item.classList.toggle('is-active', selected);
            item.setAttribute('aria-checked', selected ? 'true' : 'false');
        });
    };

    const closeRatioMenu = () => {
        cropRatioMenu?.classList.add('hidden');
    };

    const resetSelection = () => {
        selection = null;
        startPoint = null;
        dragStartPoint = null;
        dragStartSelection = null;
        interactionMode = null;
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
        interactionMode = null;
        overlay?.classList.toggle('is-cropping', active);
        cropLayer?.classList.toggle('hidden', !active);
        cropActions?.classList.toggle('hidden', !active);
        if (wrapperElement) wrapperElement.style.cursor = active ? 'crosshair' : 'grab';
        if (cropLayer) cropLayer.style.cursor = active ? 'crosshair' : '';
        closeRatioMenu();
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

    const isValidSelection = () => Boolean(selection && selection.width >= 2 && selection.height >= 2);

    const isPointInsideSelection = (point) => (
        isValidSelection()
        && point.x >= selection.left
        && point.x <= selection.left + selection.width
        && point.y >= selection.top
        && point.y <= selection.top + selection.height
    );

    const isPointOnResizeHandle = (point) => (
        isValidSelection()
        && point.x >= selection.left + selection.width - resizeHandleSize
        && point.x <= selection.left + selection.width + 4
        && point.y >= selection.top + selection.height - resizeHandleSize
        && point.y <= selection.top + selection.height + 4
    );

    const clampSelectionToImage = (nextSelection) => {
        const imageRect = getVisibleImageRect();
        const width = Math.max(0, Math.min(nextSelection.width, imageRect.right - imageRect.left));
        const height = Math.max(0, Math.min(nextSelection.height, imageRect.bottom - imageRect.top));
        return {
            left: Math.max(imageRect.left, Math.min(imageRect.right - width, nextSelection.left)),
            top: Math.max(imageRect.top, Math.min(imageRect.bottom - height, nextSelection.top)),
            width,
            height
        };
    };

    const getConstrainedPoint = (point) => {
        if (!startPoint) return point;
        const ratio = getActiveRatioValue();
        if (!ratio) return point;

        const imageRect = getVisibleImageRect();
        const dx = point.x - startPoint.x;
        const dy = point.y - startPoint.y;
        const directionX = dx < 0 ? -1 : 1;
        const directionY = dy < 0 ? -1 : 1;
        const maxWidth = directionX > 0 ? imageRect.right - startPoint.x : startPoint.x - imageRect.left;
        const maxHeight = directionY > 0 ? imageRect.bottom - startPoint.y : startPoint.y - imageRect.top;
        let width = Math.abs(dx);
        let height = Math.abs(dy);

        if (width <= 0 && height <= 0) {
            return { ...startPoint };
        }
        if (width / Math.max(height, 1) > ratio) {
            height = width / ratio;
        } else {
            width = height * ratio;
        }
        if (width > maxWidth) {
            width = maxWidth;
            height = width / ratio;
        }
        if (height > maxHeight) {
            height = maxHeight;
            width = height * ratio;
        }

        return {
            x: startPoint.x + (Math.max(0, width) * directionX),
            y: startPoint.y + (Math.max(0, height) * directionY)
        };
    };

    const renderSelection = (nextSelection) => {
        if (!cropBox) return;
        selection = clampSelectionToImage(nextSelection);
        const { left, top, width, height } = selection;
        cropBox.style.left = `${left}px`;
        cropBox.style.top = `${top}px`;
        cropBox.style.width = `${width}px`;
        cropBox.style.height = `${height}px`;
        cropBox.classList.toggle('hidden', width < 2 || height < 2);
        if (cropApplyButton) cropApplyButton.disabled = width < 8 || height < 8;
    };

    const updateSelection = (point) => {
        if (!startPoint || !cropBox) return;
        const constrainedPoint = getConstrainedPoint(point);
        renderSelection({
            left: Math.min(startPoint.x, constrainedPoint.x),
            top: Math.min(startPoint.y, constrainedPoint.y),
            width: Math.abs(constrainedPoint.x - startPoint.x),
            height: Math.abs(constrainedPoint.y - startPoint.y)
        });
    };

    const resizeSelectionToActiveRatio = () => {
        const ratio = getActiveRatioValue();
        if (!ratio || !selection || selection.width < 2 || selection.height < 2) return;
        const imageRect = getVisibleImageRect();
        const anchor = {
            x: selection.left,
            y: selection.top
        };
        let width = selection.width;
        let height = width / ratio;
        if (height > selection.height) {
            height = selection.height;
            width = height * ratio;
        }
        if (anchor.x + width > imageRect.right) width = Math.max(0, imageRect.right - anchor.x);
        if (anchor.y + height > imageRect.bottom) height = Math.max(0, imageRect.bottom - anchor.y);
        if (width / Math.max(height, 1) > ratio) width = height * ratio;
        else height = width / ratio;
        renderSelection({
            left: anchor.x,
            top: anchor.y,
            width,
            height
        });
    };

    const moveSelection = (point) => {
        if (!dragStartPoint || !dragStartSelection) return;
        renderSelection({
            left: dragStartSelection.left + point.x - dragStartPoint.x,
            top: dragStartSelection.top + point.y - dragStartPoint.y,
            width: dragStartSelection.width,
            height: dragStartSelection.height
        });
    };

    const resizeSelectionFromHandle = (point) => {
        if (!dragStartSelection) return;
        const imageRect = getVisibleImageRect();
        const ratio = getActiveRatioValue();
        const anchor = {
            x: dragStartSelection.left,
            y: dragStartSelection.top
        };
        let width = Math.max(2, Math.min(point.x, imageRect.right) - anchor.x);
        let height = Math.max(2, Math.min(point.y, imageRect.bottom) - anchor.y);

        if (ratio) {
            if (width / Math.max(height, 1) > ratio) {
                height = width / ratio;
            } else {
                width = height * ratio;
            }
            if (anchor.x + width > imageRect.right) {
                width = imageRect.right - anchor.x;
                height = width / ratio;
            }
            if (anchor.y + height > imageRect.bottom) {
                height = imageRect.bottom - anchor.y;
                width = height * ratio;
            }
        }

        renderSelection({
            left: anchor.x,
            top: anchor.y,
            width,
            height
        });
    };

    const positionRatioMenu = (event) => {
        if (!cropRatioMenu) return;
        const gap = 6;
        cropRatioMenu.style.left = `${event.clientX}px`;
        cropRatioMenu.style.top = `${event.clientY}px`;
        cropRatioMenu.classList.remove('hidden');
        const rect = cropRatioMenu.getBoundingClientRect();
        const maxLeft = Math.max(gap, windowRef.innerWidth - rect.width - gap);
        const maxTop = Math.max(gap, windowRef.innerHeight - rect.height - gap);
        cropRatioMenu.style.left = `${Math.min(Math.max(gap, event.clientX), maxLeft)}px`;
        cropRatioMenu.style.top = `${Math.min(Math.max(gap, event.clientY), maxTop)}px`;
    };

    const openRatioMenu = (event) => {
        if (!cropRatioMenu || !active) return;
        event.preventDefault();
        event.stopPropagation();
        const wrapperRect = wrapperElement.getBoundingClientRect();
        const rawPoint = {
            x: event.clientX - wrapperRect.left,
            y: event.clientY - wrapperRect.top
        };
        if (isValidSelection() ? !isPointInsideSelection(rawPoint) : !isPointInsideVisibleImage(rawPoint)) {
            closeRatioMenu();
            return;
        }
        selecting = false;
        refreshRatioMenuState();
        positionRatioMenu(event);
    };

    const setRatioPreset = (presetId, { closeMenu = true } = {}) => {
        activeRatioPresetId = getRatioPreset(presetId).id;
        refreshRatioMenuState();
        if (closeMenu) closeRatioMenu();
        resizeSelectionToActiveRatio();
    };

    const updateLayerCursor = (point) => {
        if (!active || !cropLayer) return;
        if (selecting) return;
        if (isPointOnResizeHandle(point)) {
            cropLayer.style.cursor = 'nwse-resize';
        } else if (isPointInsideSelection(point)) {
            cropLayer.style.cursor = 'move';
        } else {
            cropLayer.style.cursor = 'crosshair';
        }
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
        closeRatioMenu();
        const wrapperRect = wrapperElement.getBoundingClientRect();
        const rawPoint = {
            x: event.clientX - wrapperRect.left,
            y: event.clientY - wrapperRect.top
        };
        if (!isPointInsideVisibleImage(rawPoint)) return;
        selecting = true;
        const point = getCropPoint(event);
        if (isPointOnResizeHandle(rawPoint)) {
            interactionMode = 'resize';
            dragStartSelection = { ...selection };
            startPoint = {
                x: selection.left,
                y: selection.top
            };
            resizeSelectionFromHandle(point);
        } else if (isPointInsideSelection(rawPoint)) {
            interactionMode = 'move';
            dragStartPoint = point;
            dragStartSelection = { ...selection };
        } else {
            interactionMode = 'draw';
            startPoint = point;
            updateSelection(startPoint);
        }
    };

    const handleMouseMove = (event) => {
        const point = getCropPoint(event);
        if (!selecting) {
            updateLayerCursor(point);
            return;
        }
        if (interactionMode === 'move') {
            moveSelection(point);
        } else if (interactionMode === 'resize') {
            resizeSelectionFromHandle(point);
        } else {
            updateSelection(point);
        }
    };

    const handleMouseUp = () => {
        selecting = false;
        interactionMode = null;
        dragStartPoint = null;
        dragStartSelection = null;
    };

    const handleDocumentPointerDown = (event) => {
        if (!cropRatioMenu || cropRatioMenu.classList.contains('hidden')) return;
        if (cropRatioMenu.contains(event.target)) return;
        closeRatioMenu();
    };

    const handleKeyDown = (event) => {
        if (event.key !== 'Escape' || !cropRatioMenu || cropRatioMenu.classList.contains('hidden')) return;
        event.preventDefault();
        event.stopImmediatePropagation?.();
        closeRatioMenu();
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
    cropLayer?.addEventListener('contextmenu', openRatioMenu);
    cropRatioMenu?.addEventListener('pointerdown', (event) => {
        const item = event.target.closest('[data-crop-ratio]');
        if (!item || !cropRatioMenu.contains(item)) return;
        event.preventDefault();
        event.stopPropagation();
    });
    cropRatioMenu?.addEventListener('pointerup', (event) => {
        const item = event.target.closest('[data-crop-ratio]');
        if (!item || !cropRatioMenu.contains(item)) return;
        event.preventDefault();
        event.stopPropagation();
        setRatioPreset(item.dataset.cropRatio, { closeMenu: false });
        windowRef.setTimeout(closeRatioMenu, 0);
    });
    cropRatioMenu?.addEventListener('click', (event) => {
        const item = event.target.closest('[data-crop-ratio]');
        if (item && cropRatioMenu.contains(item)) {
            setRatioPreset(item.dataset.cropRatio);
        }
        event.preventDefault();
        event.stopPropagation();
    });
    windowRef.addEventListener('mousemove', handleMouseMove);
    windowRef.addEventListener('mouseup', handleMouseUp);
    documentRef.addEventListener('pointerdown', handleDocumentPointerDown);
    documentRef.addEventListener('keydown', handleKeyDown);
    refreshRatioMenuState();

    const cleanup = () => {
        setMode(false);
        cropLayer?.removeEventListener('mousedown', handleLayerMouseDown);
        cropLayer?.removeEventListener('contextmenu', openRatioMenu);
        windowRef.removeEventListener('mousemove', handleMouseMove);
        windowRef.removeEventListener('mouseup', handleMouseUp);
        documentRef.removeEventListener('pointerdown', handleDocumentPointerDown);
        documentRef.removeEventListener('keydown', handleKeyDown);
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
