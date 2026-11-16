import { getSurfaceCoordinator } from '../features/ui/surface-coordinator.js';
import { createBackdropDismissalGuard } from '../features/settings/backdrop-dismissal.js';

const handleIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 8-4 4 4 4m6-8 4 4-4 4"/></svg>';
const expandIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 5h5v5m0-5-6 6M10 19H5v-5m0 5 6-6"/></svg>';
const closeIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
let dialogSequence = 0;

export function renderProductRetouchComparison() {
    return `<div class="product-retouch-compare-stage" hidden>
        <div class="product-retouch-card-preview" tabindex="0" role="button" aria-label="查看产品精修预览" title="双击查看预览"><img data-retouch-result alt="精修结果" draggable="false"></div>
        <p class="product-retouch-preview-unavailable" data-retouch-result-unavailable hidden>暂时无法预览精修结果</p>
        <img class="product-retouch-compare-original" data-retouch-original alt="本次精修使用的原图" decoding="async" draggable="false" hidden>
        <div class="product-retouch-compare-labels" aria-hidden="true"><span>原图</span><span>精修</span></div>
        <div class="product-retouch-compare-divider" aria-hidden="true"><span>${handleIcon}</span></div>
        <input type="range" min="0" max="100" value="50" aria-label="调整原图与精修的对照分界" data-retouch-compare-slider data-node-read-action hidden>
    </div>`;
}

function setImageSource(image, url) {
    if (!url) image.removeAttribute('src');
    else if (image.getAttribute('src') !== url) image.src = url;
}

function containsRect(outer, inner) {
    return inner.left >= outer.left && inner.right <= outer.right
        && inner.top >= outer.top && inner.bottom <= outer.bottom;
}

function overlapsRect(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

const imageReady = image => image.complete && image.naturalWidth > 0;

function matchingImageFrames(original, result) {
    return imageReady(original) && imageReady(result)
        && Math.abs(original.naturalWidth / original.naturalHeight / (result.naturalWidth / result.naturalHeight) - 1) <= 0.01;
}

function updateSplit(slider, frame) {
    const resultPercent = Number(slider.value);
    frame.style.setProperty('--retouch-original-share', `${100 - resultPercent}%`);
    slider.setAttribute('aria-valuetext', `原图 ${100 - resultPercent}%，精修 ${resultPercent}%`);
}

function openComparisonDialog({ documentRef, originalUrl, resultUrl, splitValue, restoreFocus, openResultPreview }) {
    const dialog = documentRef.createElement('div');
    const headingId = `product-retouch-comparison-${++dialogSequence}`;
    dialog.className = 'modal-overlay product-retouch-compare-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', headingId);
    dialog.innerHTML = `<div class="product-retouch-dialog-panel">
        <header>
            <h2 id="${headingId}">产品精修预览</h2>
            <div class="product-retouch-dialog-switch" role="group" aria-label="预览方式"${originalUrl ? '' : ' hidden'}>
                <button type="button" data-retouch-view="original">原图</button>
                <button type="button" data-retouch-view="split">对照</button>
                <button type="button" data-retouch-view="result">精修</button>
            </div>
            <button type="button" class="product-retouch-dialog-close" data-action="close" aria-label="关闭预览" title="关闭预览">${closeIcon}</button>
        </header>
        <div class="product-retouch-dialog-stage">
            <div class="product-retouch-dialog-frame" data-retouch-dialog-frame hidden>
                <img data-retouch-dialog-image alt="精修结果" draggable="false">
                <img data-retouch-dialog-original alt="本次精修使用的原图" draggable="false">
                <div class="product-retouch-compare-labels" aria-hidden="true"><span>原图</span><span>精修</span></div>
                <div class="product-retouch-compare-divider" aria-hidden="true"><span>${handleIcon}</span></div>
                <input type="range" min="0" max="100" aria-label="调整预览对照分界" data-retouch-dialog-slider>
            </div>
            <p role="status" hidden></p>
        </div>
        <footer>
            <div class="product-retouch-dialog-detail"><span data-retouch-dialog-hint></span><span data-retouch-dialog-size></span></div>
            <button type="button" data-retouch-open-image>${expandIcon}<span>查看大图</span></button>
        </footer>
    </div>`;
    const workspace = dialog.querySelector('.product-retouch-dialog-stage');
    const frame = dialog.querySelector('[data-retouch-dialog-frame]');
    const result = frame.querySelector('[data-retouch-dialog-image]');
    const original = frame.querySelector('[data-retouch-dialog-original]');
    const slider = frame.querySelector('[data-retouch-dialog-slider]');
    const status = dialog.querySelector('[role="status"]');
    const detail = dialog.querySelector('[data-retouch-dialog-hint]');
    const size = dialog.querySelector('[data-retouch-dialog-size]');
    const choices = [...dialog.querySelectorAll('[data-retouch-view]')];
    const splitButton = dialog.querySelector('[data-retouch-view="split"]');
    const openImage = dialog.querySelector('[data-retouch-open-image]');
    const closeButton = dialog.querySelector('[data-action="close"]');
    const backdrop = createBackdropDismissalGuard({ overlay: dialog, panel: dialog.firstElementChild });
    const surfaces = getSurfaceCoordinator(documentRef);
    const windowRef = documentRef.defaultView;
    let preferredView = originalUrl ? 'split' : 'result';
    let currentImage = result;

    function update() {
        const focus = documentRef.activeElement;
        const canSplit = Boolean(originalUrl && matchingImageFrames(original, result));
        const css = windowRef.getComputedStyle(workspace);
        const width = workspace.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
        const height = workspace.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
        const aspect = result.naturalWidth / result.naturalHeight;
        const fits = canSplit && width >= 500 && Math.min(width, height * aspect) >= 210
            && Math.min(height, width / aspect) >= 120;
        const view = preferredView === 'split' && !fits ? 'result' : preferredView;
        const split = view === 'split';
        currentImage = view === 'original' ? original : result;
        const ready = imageReady(currentImage);
        frame.hidden = !ready;
        frame.dataset.comparison = split ? 'split' : 'switch';
        if (ready) frame.style.setProperty('--retouch-preview-aspect', String(currentImage.naturalWidth / currentImage.naturalHeight));
        original.hidden = !ready || !split && view !== 'original';
        result.hidden = !ready || !split && view !== 'result';
        slider.hidden = !split;
        splitButton.disabled = !fits;
        status.hidden = ready;
        openImage.disabled = !ready;
        if (!ready) status.textContent = !currentImage.complete ? '正在读取图片…'
            : view === 'original' ? '无法读取本次精修的原图' : '无法读取精修结果';
        detail.textContent = split ? '拖动分界线查看差异' : view === 'original' ? '原图' : '精修';
        size.textContent = ready ? `${currentImage.naturalWidth} × ${currentImage.naturalHeight} px` : '';
        for (const button of choices) button.setAttribute('aria-pressed', String(button.dataset.retouchView === view));
        if (!fits && (focus === slider || focus === splitButton)) {
            dialog.querySelector('[data-retouch-view="result"]').focus({ preventScroll: true });
        }
    }
    slider.value = splitValue;
    updateSplit(slider, frame);
    slider.addEventListener('input', () => updateSplit(slider, frame));
    for (const image of [original, result]) {
        image.addEventListener('load', update);
        image.addEventListener('error', update);
    }
    for (const button of choices) button.addEventListener('click', () => {
        preferredView = button.dataset.retouchView;
        update();
    });
    const resizeObserver = new windowRef.ResizeObserver(update);
    const close = (returnFocus = true) => {
        if (!dialog.isConnected) return;
        resizeObserver.disconnect();
        releaseEscape?.();
        dialog.remove();
        surfaces?.refresh();
        if (returnFocus) restoreFocus();
    };
    const releaseEscape = surfaces?.registerEscape(dialog, () => close());
    closeButton.addEventListener('click', () => close());
    dialog.addEventListener('pointerdown', backdrop.recordPointerDown);
    dialog.addEventListener('click', event => { if (backdrop.shouldDismiss(event)) close(); });
    openImage.addEventListener('click', () => {
        const url = currentImage.src;
        close(false);
        openResultPreview([url], 0, restoreFocus);
    });
    documentRef.body.append(dialog);
    setImageSource(result, resultUrl);
    setImageSource(original, originalUrl);
    update();
    resizeObserver.observe(workspace);
    closeButton.focus();
    surfaces?.refresh();
    return close;
}

export function createProductRetouchComparison({ card, inspect, hint, documentRef, openResultPreview }) {
    const windowRef = documentRef.defaultView;
    const canvas = documentRef.getElementById('canvas-container');
    const sidebars = ['workflow-sidebar', 'prompt-agent-panel'].map(id => documentRef.getElementById(id)).filter(Boolean);
    const stage = card.querySelector('.product-retouch-compare-stage');
    const preview = stage.querySelector('.product-retouch-card-preview');
    const unavailable = stage.querySelector('[data-retouch-result-unavailable]');
    const result = stage.querySelector('[data-retouch-result]');
    const original = stage.querySelector('[data-retouch-original]');
    const slider = stage.querySelector('[data-retouch-compare-slider]');
    const hintText = hint.querySelector('span');
    const retryOriginalButton = hint.querySelector('[data-retouch-retry-original]');
    const retryResultButton = hint.querySelector('[data-retouch-retry-result]');
    const events = new windowRef.AbortController();
    let resultUrl = '', originalUrl = '';
    let originalFailed = false, resultFailed = false;
    let retryCount = 0;
    let closeDialog = null;
    let matchingFrame = false;
    let frameRequest = null;
    let sliderPointer = null;

    function visibleBounds() {
        const rect = canvas?.getBoundingClientRect();
        return {
            left: Math.max(0, rect?.left ?? 0), right: Math.min(windowRef.innerWidth, rect?.right ?? windowRef.innerWidth),
            top: Math.max(0, rect?.top ?? 0), bottom: Math.min(windowRef.innerHeight, rect?.bottom ?? windowRef.innerHeight)
        };
    }
    const sidebarOpen = sidebar => sidebar.classList.contains('active') && !sidebar.hidden;
    function visibleOnCanvas(rect) {
        return containsRect(visibleBounds(), rect)
            && !sidebars.some(sidebar => sidebarOpen(sidebar) && overlapsRect(sidebar.getBoundingClientRect(), rect));
    }
    function focusVisible(...candidates) {
        for (const candidate of candidates) {
            if (!candidate?.checkVisibility() || candidate.closest('[inert]')) continue;
            if (card.contains(candidate)) {
                const rect = candidate.getBoundingClientRect();
                const canFocusPart = candidate === preview && !inspect.checkVisibility() && !sidebars.some(sidebarOpen);
                if (!(canFocusPart ? overlapsRect(visibleBounds(), rect) : visibleOnCanvas(rect))) continue;
            }
            candidate.focus({ preventScroll: true });
            return;
        }
    }
    function setSplitEnabled(split) {
        const mode = split ? 'split' : 'none';
        if (stage.dataset.comparison === mode) return;
        const returnFocus = !split && documentRef.activeElement === slider;
        stage.dataset.comparison = mode;
        original.hidden = slider.hidden = !split;
        if (returnFocus) focusVisible(preview, inspect, retryResultButton);
    }
    function scheduleLayout() {
        if (!matchingFrame || frameRequest !== null || sliderPointer !== null) return;
        frameRequest = windowRef.requestAnimationFrame(() => {
            frameRequest = null;
            if (!matchingFrame || sliderPointer !== null) return;
            const rect = stage.getBoundingClientRect();
            // Measure the transformed card in the clipped canvas. Window width
            // alone cannot account for the dock or for zooming the node.
            const fits = windowRef.innerWidth > 800 && rect.width >= 180 && rect.height >= 96 && visibleOnCanvas(rect);
            setSplitEnabled(fits);
        });
    }
    const resizeObserver = windowRef.ResizeObserver ? new windowRef.ResizeObserver(scheduleLayout) : null;
    resizeObserver?.observe(stage);
    if (canvas) resizeObserver?.observe(canvas);
    const intersectionObserver = windowRef.IntersectionObserver
        ? new windowRef.IntersectionObserver(scheduleLayout, { root: canvas, threshold: [0, 1] }) : null;
    intersectionObserver?.observe(stage);
    windowRef.addEventListener('resize', scheduleLayout, { signal: events.signal });
    for (const event of ['cainflow:canvas-transform', 'cainflow:canvas-sidebar-changed', 'cainflow:node-drag-ended']) {
        documentRef.addEventListener(event, scheduleLayout, { signal: events.signal });
    }
    documentRef.addEventListener('cainflow:canvas-pan-frame', () => {
        if (sidebars.some(sidebarOpen)) scheduleLayout();
    }, { signal: events.signal });

    function sync() {
        const active = documentRef.activeElement;
        const hasResult = Boolean(resultUrl && imageReady(result) && !resultFailed);
        // Different frames can still be viewed separately in the dialog.
        matchingFrame = Boolean(hasResult && originalUrl && !originalFailed && matchingImageFrames(original, result));
        stage.hidden = !resultUrl;
        preview.hidden = !hasResult;
        unavailable.hidden = !resultUrl || hasResult;
        const previewStatus = resultFailed ? '暂时无法预览精修结果' : '正在读取精修结果…';
        if (unavailable.textContent !== previewStatus) unavailable.textContent = previewStatus;
        inspect.hidden = !resultUrl || resultFailed;
        inspect.setAttribute('aria-disabled', String(!hasResult));
        const label = originalUrl && !originalFailed ? '查看对照' : '查看精修结果';
        if (inspect.textContent !== label) inspect.textContent = label;
        hint.hidden = !resultUrl || (hasResult && Boolean(originalUrl) && !originalFailed);
        const message = !hasResult ? resultFailed ? '精修结果暂时无法读取' : '正在读取精修结果…'
            : '该结果没有可用的对照原图';
        if (hintText.textContent !== message) hintText.textContent = message;
        retryOriginalButton.hidden = resultFailed || !originalFailed || !originalUrl;
        retryResultButton.hidden = !resultFailed || !resultUrl.startsWith('/api/storage/assets/');
        if (matchingFrame) scheduleLayout();
        else setSplitEnabled(false);
        if (resultFailed && (active === inspect || active === preview)) focusVisible(retryResultButton);
    }
    function retryImage(image, source) {
        const url = new URL(source, documentRef.baseURI);
        url.searchParams.set('retry', String(++retryCount));
        setImageSource(image, url.href);
        sync();
    }
    original.addEventListener('load', sync);
    original.addEventListener('error', () => {
        if (!original.complete || original.naturalWidth || !originalUrl) return;
        originalFailed = true;
        sync();
    });
    result.addEventListener('load', sync);
    result.addEventListener('error', () => {
        if (!result.complete || result.naturalWidth || !resultUrl) return;
        resultFailed = true;
        sync();
    });
    retryOriginalButton.addEventListener('click', () => {
        originalFailed = false;
        retryImage(original, originalUrl);
        focusVisible(inspect);
    });
    retryResultButton.addEventListener('click', () => {
        resultFailed = false;
        retryImage(result, resultUrl);
        focusVisible(inspect);
    });
    slider.addEventListener('pointerdown', event => {
        if (event.button === 0 && event.isPrimary) sliderPointer = event.pointerId;
    });
    const endSliderGesture = event => {
        if (sliderPointer === null || event.pointerId !== undefined && event.pointerId !== sliderPointer) return;
        sliderPointer = null;
        scheduleLayout();
    };
    for (const type of ['pointerup', 'pointercancel']) {
        windowRef.addEventListener(type, endSliderGesture, { capture: true, signal: events.signal });
    }
    windowRef.addEventListener('blur', endSliderGesture, { signal: events.signal });
    slider.addEventListener('lostpointercapture', endSliderGesture);
    slider.addEventListener('mousedown', event => event.stopPropagation());
    slider.addEventListener('input', () => updateSplit(slider, stage));
    function inspectResult(trigger) {
        if (inspect.getAttribute('aria-disabled') === 'true') return;
        closeDialog = openComparisonDialog({ documentRef, originalUrl: originalUrl ? original.src : '', resultUrl: result.src,
            splitValue: slider.value, restoreFocus: () => focusVisible(trigger, inspect, preview, retryResultButton), openResultPreview });
    }
    preview.addEventListener('dblclick', event => {
        if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
        event.stopPropagation();
        inspectResult(preview);
    });
    preview.addEventListener('click', event => {
        if (event.detail !== 0) return;
        event.stopPropagation();
        inspectResult(preview);
    });
    preview.addEventListener('keydown', event => {
        if (event.repeat || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        inspectResult(preview);
    });
    inspect.addEventListener('click', () => inspectResult(inspect));
    return {
        update(nextResult, nextOriginal, retouchCompleted) {
            if (nextResult !== resultUrl || nextOriginal !== originalUrl) {
                const resultChanged = nextResult !== resultUrl;
                const originalChanged = nextOriginal !== originalUrl;
                resultUrl = nextResult;
                originalUrl = nextOriginal;
                if (originalChanged) originalFailed = false;
                if (resultChanged) resultFailed = false;
                slider.value = '50';
                updateSplit(slider, stage);
                if (resultChanged) setImageSource(result, resultUrl);
                if (originalChanged) setImageSource(original, originalUrl);
            }
            if (retouchCompleted && originalUrl && originalFailed) {
                originalFailed = false;
                retryImage(original, originalUrl);
            }
            if (retouchCompleted && resultFailed && resultUrl.startsWith('/api/storage/assets/')) {
                resultFailed = false;
                retryImage(result, resultUrl);
            }
            sync();
        },
        destroy() {
            closeDialog?.(false);
            events.abort();
            resizeObserver?.disconnect();
            intersectionObserver?.disconnect();
            if (frameRequest !== null) windowRef.cancelAnimationFrame(frameRequest);
        }
    };
}
