/**
 * Shared DOM renderer for image preview/save style display nodes.
 */
import { normalizeImageList } from '../execution/execution-data-utils.js';
import { TRANSPARENT_PREVIEW_PIXEL } from './media-preview-cache.js';

function defaultIsInlineImageData(value) {
    return typeof value === 'string' && /^data:image\//i.test(value);
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
        delete img.dataset.originalSrc;
        if (cursor) img.style.cursor = cursor;
        else img.style.removeProperty('cursor');
        if (shouldUseThumbnail) {
            const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            img.dataset.previewThumbnailToken = token;
            const cachedThumbnail = previewCache.getCachedPreviewThumbnail?.(src) || '';
            const hasCachedThumbnail = Boolean(cachedThumbnail);
            const initialSrc = cachedThumbnail || (preferImmediateSrc ? src : TRANSPARENT_PREVIEW_PIXEL);
            if (img.getAttribute('src') !== initialSrc) {
                img.src = initialSrc;
            }
            const pendingThumbnail = previewCache.createPreviewThumbnail?.(src);
            if (pendingThumbnail && typeof pendingThumbnail.then === 'function') {
                void pendingThumbnail.then((thumbnail) => {
                    if (!img.isConnected) return;
                    if (img.dataset.previewThumbnailToken !== token) return;
                    if (preferImmediateSrc && !hasCachedThumbnail) return;
                    const nextSrc = thumbnail || src;
                    if (nextSrc && img.getAttribute('src') !== nextSrc) {
                        img.src = nextSrc;
                    }
                });
            }
        } else {
            delete img.dataset.previewThumbnailToken;
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
        const image = imageList.length > 1
            ? (imageList[index] || imageList[0])
            : (imageList[0] || '');
        renderReusableMultiImagePreview(container, image, index, safeTotal, {
            altPrefix,
            placeholderClass,
            emptyMessage,
            cursor,
            placeholderWithIcon
        });
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

    return {
        createPreviewNavButton,
        createPreviewPlaceholder,
        ensureElement,
        removeElements,
        renderDisplayImagePreview,
        renderReusableComparePreview,
        renderReusableMultiImagePreview,
        setImageElementSource,
        updatePlaceholderText,
        updatePreviewPlaceholder
    };
}
