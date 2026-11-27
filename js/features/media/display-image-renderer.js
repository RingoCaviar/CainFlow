/**
 * Shared DOM renderer for image preview/save style display nodes.
 */
import { normalizeImageList } from '../execution/execution-data-utils.js';
import { isOriginalFileUrl } from '../workflow/file-import.js';
import { createPreviewPriority, TRANSPARENT_PREVIEW_PIXEL } from './media-preview-cache.js';

function defaultIsInlineImageData(value) {
    return typeof value === 'string' && /^data:image\//i.test(value);
}

function readInlineImageBytes(source, start, offset, count) {
    // Base64 groups encode three bytes. Skip large metadata chunks by seeking to their next header.
    const skip = offset % 3;
    const first = start + Math.floor(offset / 3) * 4;
    const end = first + Math.ceil((skip + count) / 3) * 4;
    return atob(source.slice(first, end)).slice(skip, skip + count);
}

function needsOriginalDisplay(source) {
    const header = /^data:image\/([^;,]+)[^,]*,/i.exec(source.slice(0, 256));
    const type = header?.[1].toLowerCase();
    if (['gif', 'apng', 'avif', 'svg+xml'].includes(type)) return true;
    if (type !== 'png' && type !== 'webp') return false;
    if (!/;base64,$/i.test(header[0])) return true;

    const start = header[0].length;
    try {
        if (type === 'webp') {
            const bytes = readInlineImageBytes(source, start, 0, 21);
            // Extended WebP puts the animation bit in the first byte of VP8X.
            return bytes.startsWith('RIFF') && bytes.slice(8, 16) === 'WEBPVP8X' && (bytes.charCodeAt(20) & 2) !== 0;
        }
        if (readInlineImageBytes(source, start, 0, 8) !== '\x89PNG\r\n\x1a\n') return false;
        // APNG declares its animation before the first IDAT. Keep the original if the bounded scan is inconclusive.
        let offset = 8;
        for (let index = 0; index < 24; index += 1) {
            const chunk = readInlineImageBytes(source, start, offset, 8);
            if (chunk.length < 8) break;
            const name = chunk.slice(4);
            if (name === 'acTL') return true;
            if (name === 'IDAT' || name === 'IEND') return false;
            const length = chunk.charCodeAt(0) * 0x1000000 + chunk.charCodeAt(1) * 0x10000 +
                chunk.charCodeAt(2) * 0x100 + chunk.charCodeAt(3);
            offset += 12 + length;
        }
        return true;
    } catch {
        return true;
    }
}

function clampIndex(value, total) {
    if (total <= 0) return 0;
    return Math.max(0, Math.min(total - 1, parseInt(value, 10) || 0));
}

export function createDisplayImageRenderer({
    documentRef = document,
    previewCache = null,
    isInlineImageData = defaultIsInlineImageData,
    normalizeImages = normalizeImageList
} = {}) {
    const previewsByImage = new WeakMap();
    const watchedOriginalImages = new WeakSet();
    let visibilityObserver = null;

    function observePreviewVisibility(img) {
        const Observer = documentRef.defaultView?.IntersectionObserver;
        if (!Observer) return;
        visibilityObserver ??= new Observer(entries => {
            for (const { target, isIntersecting } of entries) {
                const preview = previewsByImage.get(target);
                preview?.priority?.set(isIntersecting && target.isConnected ? 1 : 0);
            }
        });
        visibilityObserver.observe(img);
    }

    function stopObservingPreview(img, preview) {
        if (!preview?.priority) return;
        visibilityObserver?.unobserve(img);
        preview.priority.set(0);
        preview.priority = null;
    }

    function setInlineImagePreview(img, source, maxEdge, sameOriginal, keepOriginal) {
        const previous = previewsByImage.get(img);
        const displayed = img.getAttribute('src');
        const samePreview = sameOriginal && previous && displayed === (previous.displayed ?? source);
        if (samePreview && previous.maxEdge === maxEdge && previous.keepOriginal === keepOriginal) return;

        stopObservingPreview(img, previous);
        const cached = keepOriginal ? '' : previewCache.getCachedPreviewThumbnail?.(source, maxEdge);
        const canPrepare = typeof (keepOriginal ? previewCache.resolveImageResolution : previewCache.createPreviewThumbnail) === 'function';
        const next = cached || (canPrepare ? ((samePreview && displayed) || TRANSPARENT_PREVIEW_PIXEL) : source);
        // The DOM's original-source attribute is cleared when intermediate image memory is released.
        const preview = { maxEdge, keepOriginal, displayed: next === source ? null : next, priority: null };
        previewsByImage.set(img, preview);
        if (displayed !== next) img.src = next;
        if (cached || !canPrepare) return;

        const alreadyProjected = img.isConnected && img.closest?.('.node')?.dataset?.renderProjection === 'full';
        const priority = createPreviewPriority(alreadyProjected ? 1 : 0);
        preview.priority = priority;
        observePreviewVisibility(img);
        const isCurrent = () => {
            // Cached workflow DOM retains the image's parent while its canvas is detached.
            if (previewsByImage.get(img) !== preview || (!img.isConnected && !img.parentNode)) return false;
            const original = img.dataset.originalSrc;
            return original === source || (!keepOriginal && original === undefined &&
                img.getAttribute('src') === TRANSPARENT_PREVIEW_PIXEL);
        };
        const finish = (thumbnail) => {
            if (previewsByImage.get(img) !== preview) return;
            stopObservingPreview(img, preview);
            const ready = keepOriginal ? source : (thumbnail || source);
            if (!isCurrent() || (ready === source && img.dataset.originalSrc !== source)) {
                previewsByImage.delete(img);
                return;
            }
            preview.displayed = ready === source ? null : ready;
            if (img.getAttribute('src') !== ready) img.src = ready;
        };
        let pending;
        try {
            pending = keepOriginal ? previewCache.resolveImageResolution(source, { priority, isCurrent })
                : previewCache.createPreviewThumbnail(source, maxEdge, { priority, isCurrent });
        } catch {
            pending = source;
        }
        void Promise.resolve(pending).then(finish, () => finish(source));
    }

    function createSvgElement(tagName) {
        return documentRef.createElementNS('http://www.w3.org/2000/svg', tagName);
    }

    function ensureElement(parent, selector, createElement) {
        let element = parent?.querySelector?.(selector) || null;
        if (!element && parent) {
            element = createElement();
            parent.appendChild(element);
        }
        return element;
    }

    function removeElements(parent, selector) {
        parent?.querySelectorAll?.(selector).forEach((element) => element.remove());
    }

    function setImageElementSource(img, src, alt, options = {}) {
        if (!img) return;
        const {
            cursor = '',
            className = '',
            useThumbnail = true,
            thumbnailMaxEdge,
            preferImmediateSrc = false
        } = options;
        const shouldUseThumbnail = Boolean(previewCache)
            && useThumbnail
            && typeof isInlineImageData === 'function'
            && isInlineImageData(src);
        if (className) img.className = className;
        img.draggable = false;
        img.loading = preferImmediateSrc ? 'eager' : 'lazy';
        img.decoding = 'async';
        img.alt = alt;
        if (isOriginalFileUrl(src) && !watchedOriginalImages.has(img)) {
            watchedOriginalImages.add(img);
            img.addEventListener?.('error', () => {
                if (isOriginalFileUrl(img.getAttribute('src'))) img.alt = '无法读取原图。文件变更后请重新运行。';
            });
        }
        if (cursor) img.style.cursor = cursor;
        else img.style.removeProperty('cursor');
        if (shouldUseThumbnail) {
            const sameOriginal = img.dataset.originalSrc === src;
            if (!sameOriginal) img.dataset.originalSrc = src;
            setInlineImagePreview(img, src, thumbnailMaxEdge, sameOriginal, preferImmediateSrc && needsOriginalDisplay(src));
        } else {
            delete img.dataset.originalSrc;
            stopObservingPreview(img, previewsByImage.get(img));
            previewsByImage.delete(img);
            if (img.getAttribute('src') !== src) {
                img.src = src;
            }
        }
    }

    function createPreviewIcon(icon) {
        if (icon === 'cache') {
            const svg = createSvgElement('svg');
            svg.setAttribute('width', '30');
            svg.setAttribute('height', '30');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '1.7');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.dataset.previewPlaceholderIcon = icon;

            const pathTop = createSvgElement('path');
            pathTop.setAttribute('d', 'M4 7c0-1.66 3.58-3 8-3s8 1.34 8 3-3.58 3-8 3-8-1.34-8-3z');
            const pathMid = createSvgElement('path');
            pathMid.setAttribute('d', 'M4 7v5c0 1.66 3.58 3 8 3 1.16 0 2.26-.09 3.25-.27');
            const pathBottom = createSvgElement('path');
            pathBottom.setAttribute('d', 'M4 12v5c0 1.66 3.58 3 8 3 .68 0 1.34-.03 1.97-.1');
            const pathRestore = createSvgElement('path');
            pathRestore.setAttribute('d', 'M18 14v5h-5');
            const pathArrow = createSvgElement('path');
            pathArrow.setAttribute('d', 'M18 19c-1.1-2.02-2.92-3.14-5-3.14');
            svg.append(pathTop, pathMid, pathBottom, pathRestore, pathArrow);
            return svg;
        }

        const svg = createSvgElement('svg');
        svg.setAttribute('width', '32');
        svg.setAttribute('height', '32');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.5');
        svg.dataset.previewPlaceholderIcon = icon;

        const rect = createSvgElement('rect');
        rect.setAttribute('x', '3');
        rect.setAttribute('y', '3');
        rect.setAttribute('width', '18');
        rect.setAttribute('height', '18');
        rect.setAttribute('rx', '2');
        rect.setAttribute('ry', '2');

        const circle = createSvgElement('circle');
        circle.setAttribute('cx', '8.5');
        circle.setAttribute('cy', '8.5');
        circle.setAttribute('r', '1.5');

        const polyline = createSvgElement('polyline');
        polyline.setAttribute('points', '21 15 16 10 5 21');

        svg.append(rect, circle, polyline);
        return svg;
    }

    function createPreviewPlaceholder(className, message, { withIcon = true, icon = 'image', modifierClass = '', detailText = '' } = {}) {
        const placeholder = documentRef.createElement('div');
        placeholder.className = className;
        if (modifierClass) placeholder.classList.add(modifierClass);

        if (withIcon) {
            placeholder.appendChild(createPreviewIcon(icon));
        }

        const text = documentRef.createElement('span');
        text.className = 'preview-placeholder-text';
        text.textContent = message;
        placeholder.appendChild(text);

        if (detailText) {
            const detail = documentRef.createElement('small');
            detail.className = 'preview-placeholder-detail';
            detail.textContent = detailText;
            placeholder.appendChild(detail);
        }
        return placeholder;
    }

    function updatePreviewPlaceholder(placeholder, message, {
        icon = '',
        modifierClass = '',
        detailText = '',
        resetReleasedState = false
    } = {}) {
        if (!placeholder) return;
        if (resetReleasedState) {
            placeholder.classList.remove('preview-placeholder-memory-released');
            const currentIcon = Array.from(placeholder.children).find((child) => child.tagName?.toLowerCase() === 'svg');
            if (currentIcon?.dataset.previewPlaceholderIcon === 'cache') {
                if (placeholder.classList.contains('save-preview-placeholder')) {
                    currentIcon.remove();
                } else {
                    currentIcon.replaceWith(createPreviewIcon('image'));
                }
            }
        }
        if (modifierClass) placeholder.classList.add(modifierClass);
        if (icon) {
            const currentIcon = Array.from(placeholder.children).find((child) => child.tagName?.toLowerCase() === 'svg');
            if (!currentIcon || currentIcon.dataset.previewPlaceholderIcon !== icon) {
                const nextIcon = createPreviewIcon(icon);
                if (currentIcon) currentIcon.replaceWith(nextIcon);
                else placeholder.insertBefore(nextIcon, placeholder.firstChild || null);
            }
        }
        let text = placeholder.querySelector('.preview-placeholder-text');
        if (!text) {
            const textNode = Array.from(placeholder.childNodes).find((node) => node.nodeType === 3);
            text = documentRef.createElement('span');
            text.className = 'preview-placeholder-text';
            if (textNode) {
                placeholder.replaceChild(text, textNode);
            } else {
                placeholder.appendChild(text);
            }
        }
        text.textContent = message;

        let detail = placeholder.querySelector('.preview-placeholder-detail');
        if (detailText) {
            if (!detail) {
                detail = documentRef.createElement('small');
                detail.className = 'preview-placeholder-detail';
                placeholder.appendChild(detail);
            }
            detail.textContent = detailText;
        } else {
            detail?.remove();
        }
    }

    function updatePlaceholderText(placeholder, message) {
        updatePreviewPlaceholder(placeholder, message, { resetReleasedState: true });
    }

    function createPreviewNavButton(direction) {
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.className = `image-save-preview-nav ${direction < 0 ? 'image-save-preview-prev' : 'image-save-preview-next'}`;
        button.dataset.direction = String(direction);
        button.title = direction < 0 ? '上一张' : '下一张';
        button.setAttribute('aria-label', direction < 0 ? '上一张' : '下一张');

        const svg = createSvgElement('svg');
        svg.setAttribute('width', '14');
        svg.setAttribute('height', '14');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2.4');

        const polyline = createSvgElement('polyline');
        polyline.setAttribute('points', direction < 0 ? '15 18 9 12 15 6' : '9 18 15 12 9 6');
        svg.appendChild(polyline);
        button.appendChild(svg);
        return button;
    }

    function renderReusableMultiImagePreview(container, image, index, total, {
        altPrefix,
        placeholderClass,
        emptyMessage,
        cursor = '',
        placeholderWithIcon = true
    }) {
        if (!container) return;

        const hasImage = typeof image === 'string' && image.trim();
        const hasMultiple = total > 1;
        container.classList.toggle('has-multiple-images', hasMultiple);

        if (!hasImage) {
            removeElements(container, 'img, .image-save-preview-nav, .image-save-preview-counter');
            const placeholder = ensureElement(container, `.${placeholderClass}`, () => createPreviewPlaceholder(placeholderClass, emptyMessage, { withIcon: placeholderWithIcon }));
            updatePlaceholderText(placeholder, emptyMessage);
            return;
        }

        removeElements(container, `.${placeholderClass}`);
        const img = ensureElement(container, 'img', () => documentRef.createElement('img'));
        setImageElementSource(img, image, `${altPrefix} ${index + 1}/${total}`, {
            cursor,
            preferImmediateSrc: false
        });

        if (hasMultiple) {
            ensureElement(container, '.image-save-preview-prev', () => createPreviewNavButton(-1));
            ensureElement(container, '.image-save-preview-next', () => createPreviewNavButton(1));
            const counter = ensureElement(container, '.image-save-preview-counter', () => {
                const el = documentRef.createElement('div');
                el.className = 'image-save-preview-counter';
                return el;
            });
            counter.textContent = `${index + 1}/${total}`;
        } else {
            removeElements(container, '.image-save-preview-nav, .image-save-preview-counter');
        }
    }

    function renderDisplayImagePreview(container, node, images, {
        totalCount = 0,
        altPrefix,
        placeholderClass,
        emptyMessage,
        cursor = '',
        placeholderWithIcon = true
    }) {
        const imageList = normalizeImages(images);
        const safeTotal = Math.max(
            imageList.length,
            Math.max(0, parseInt(totalCount || '0', 10) || 0)
        );

        if (imageList.length === 0 && safeTotal === 0) {
            renderReusableMultiImagePreview(container, '', 0, 0, {
                altPrefix,
                placeholderClass,
                emptyMessage,
                cursor,
                placeholderWithIcon
            });
            if (node) node.imagePreviewIndex = 0;
            return { imageList, totalCount: 0, index: 0, image: '' };
        }

        const index = clampIndex(Number.isFinite(node?.imagePreviewIndex) ? node.imagePreviewIndex : 0, safeTotal);
        if (node) {
            node.imagePreviewIndex = index;
            node.data = node.data || {};
        }
        const missingPositions = new Set((node?.data?.mediaIntegrity?.missingItems || [])
            .map((item) => Number(item.position))
            .filter(Number.isInteger));
        const presentIndex = index - Array.from(missingPositions)
            .filter((position) => position < index)
            .length;
        const image = missingPositions.has(index) ? '' : (imageList[presentIndex] || '');
        renderReusableMultiImagePreview(container, image, index, safeTotal, {
            altPrefix,
            placeholderClass,
            emptyMessage,
            cursor,
            placeholderWithIcon
        });
        if (!image && missingPositions.has(index) && safeTotal > 1) {
            ensureElement(container, '.image-save-preview-prev', () => createPreviewNavButton(-1));
            ensureElement(container, '.image-save-preview-next', () => createPreviewNavButton(1));
            const counter = ensureElement(container, '.image-save-preview-counter', () => {
                const element = documentRef.createElement('div');
                element.className = 'image-save-preview-counter';
                return element;
            });
            counter.textContent = `${index + 1}/${safeTotal}`;
        }
        return { imageList, totalCount: safeTotal, index, image };
    }

    function renderReusableComparePreview(container, imageA, imageB) {
        if (!container) return;

        removeElements(container, '.preview-placeholder');
        const imageBEl = ensureElement(container, '.image-compare-b', () => documentRef.createElement('img'));
        setImageElementSource(imageBEl, imageB, 'B 输入图片', {
            className: 'image-compare-img image-compare-b',
            preferImmediateSrc: false
        });

        if (typeof imageA === 'string' && imageA.trim()) {
            const imageAEl = ensureElement(container, '.image-compare-a', () => documentRef.createElement('img'));
            setImageElementSource(imageAEl, imageA, 'A 输入图片', {
                className: 'image-compare-img image-compare-a',
                preferImmediateSrc: false
            });
            ensureElement(container, '.image-compare-divider', () => {
                const divider = documentRef.createElement('div');
                divider.className = 'image-compare-divider';
                divider.setAttribute('aria-hidden', 'true');
                return divider;
            });
        } else {
            removeElements(container, '.image-compare-a, .image-compare-divider');
        }
    }

    function renderColorResetPreview(container, image, { overlayId = '' } = {}) {
        if (!container || typeof image !== 'string' || !image) return { image: null, createdImage: false };
        removeElements(container, '.preview-placeholder');
        const existingImage = container.querySelector('img');
        const imageElement = ensureElement(container, 'img', () => documentRef.createElement('img'));
        // Each interactive adjustment already has a finished frame to display.
        setImageElementSource(imageElement, image, '复位颜色结果预览', { useThumbnail: false, preferImmediateSrc: true });
        const overlay = ensureElement(container, '.color-reset-picker-overlay', () => {
            const element = documentRef.createElement('div');
            element.className = 'color-reset-picker-overlay';
            element.textContent = '点击图片中的白色或灰色区域';
            return element;
        });
        if (overlayId) overlay.id = overlayId;
        return { image: imageElement, createdImage: !existingImage };
    }

    return {
        createPreviewNavButton,
        createPreviewPlaceholder,
        ensureElement,
        removeElements,
        renderDisplayImagePreview,
        renderReusableComparePreview,
        renderColorResetPreview,
        renderReusableMultiImagePreview,
        setImageElementSource,
        updatePlaceholderText,
        updatePreviewPlaceholder
    };
}
