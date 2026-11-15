import { getSurfaceCoordinator } from '../features/ui/surface-coordinator.js';
import { createBackdropDismissalGuard } from '../features/settings/backdrop-dismissal.js';

const handleIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 8-4 4 4 4m6-8 4 4-4 4"/></svg>';
let dialogSequence = 0;

export function renderProductRetouchComparison() {
    return `<div class="product-retouch-compare-stage" hidden>
        <button type="button" class="product-retouch-card-preview" aria-label="查看大图" data-node-read-action><img data-retouch-result alt="精修结果" draggable="false"></button>
        <p class="product-retouch-preview-unavailable" data-retouch-result-unavailable hidden>暂时无法预览精修结果</p>
        <img class="product-retouch-compare-original" data-retouch-original alt="本次精修使用的原图" decoding="async" draggable="false">
        <div class="product-retouch-compare-labels" aria-hidden="true"><span>原图</span><span>上次精修</span></div>
        <div class="product-retouch-compare-divider" aria-hidden="true"><span>${handleIcon}</span></div>
        <input type="range" min="0" max="100" value="50" aria-label="调整原图与精修的对照分界" data-retouch-compare-slider data-node-read-action>
    </div>
    <div class="product-retouch-compare-switch" role="group" aria-label="切换对照图片" hidden>
        <button type="button" data-retouch-card-view="original" data-node-read-action aria-pressed="false">原图</button>
        <button type="button" data-retouch-card-view="result" data-node-read-action aria-pressed="true">精修</button>
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

function openComparisonDialog({ documentRef, originalUrl, resultUrl, trigger, openResultPreview }) {
    const dialog = documentRef.createElement('div');
    const headingId = `product-retouch-comparison-${++dialogSequence}`;
    dialog.className = 'modal-overlay product-retouch-compare-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', headingId);
    dialog.innerHTML = `<div class="product-retouch-dialog-panel">
        <header><h2 id="${headingId}">原图与精修对照</h2><button type="button" data-action="close">关闭</button></header>
        <div class="product-retouch-dialog-stage"><img data-retouch-dialog-image><p role="status" hidden></p></div>
        <footer><div class="product-retouch-dialog-switch" role="group" aria-label="切换对照图片">
            <button type="button" data-retouch-view="original">原图</button>
            <button type="button" data-retouch-view="result">精修</button>
        </div>
        <button type="button" data-retouch-open-image>查看大图</button></footer>
    </div>`;
    const image = dialog.querySelector('img');
    const status = dialog.querySelector('[role="status"]');
    const choices = [...dialog.querySelectorAll('[data-retouch-view]')];
    const openImage = dialog.querySelector('[data-retouch-open-image]');
    const closeButton = dialog.querySelector('[data-action="close"]');
    const backdrop = createBackdropDismissalGuard({ overlay: dialog, panel: dialog.firstElementChild });
    const surfaces = getSurfaceCoordinator(documentRef);
    let current = '';
    let currentView = 'result';
    let openFullscreen = false;
    const focusTrigger = () => {
        if (trigger.isConnected && trigger.checkVisibility() && !trigger.closest('[inert]')) trigger.focus({ preventScroll: true });
    };
    function updateImageState() {
        const ready = image.complete && image.naturalWidth > 0;
        image.hidden = !ready;
        status.hidden = ready;
        openImage.disabled = !ready;
        if (!ready) {
            status.textContent = !image.complete ? '正在读取图片…'
                : currentView === 'original' ? '无法读取本次精修的原图' : '无法读取精修结果';
        }
    }
    function show(view) {
        currentView = view;
        current = view === 'original' ? originalUrl : resultUrl;
        image.alt = view === 'original' ? '本次精修使用的原图' : '精修结果';
        setImageSource(image, current);
        updateImageState();
        for (const button of choices) button.setAttribute('aria-pressed', String(button.dataset.retouchView === view));
    }
    image.addEventListener('load', updateImageState);
    image.addEventListener('error', updateImageState);
    for (const button of choices) button.addEventListener('click', () => show(button.dataset.retouchView));
    const close = () => {
        if (!dialog.isConnected) return;
        releaseEscape?.();
        dialog.remove();
        surfaces?.refresh();
        if (!openFullscreen) focusTrigger();
    };
    const releaseEscape = surfaces?.registerEscape(dialog, close);
    closeButton.addEventListener('click', close);
    dialog.addEventListener('pointerdown', backdrop.recordPointerDown);
    dialog.addEventListener('click', event => { if (backdrop.shouldDismiss(event)) close(); });
    openImage.addEventListener('click', () => {
        openFullscreen = true;
        close();
        openResultPreview([current], 0, focusTrigger);
    });
    documentRef.body.append(dialog);
    show('result');
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
    const switcher = card.querySelector('.product-retouch-compare-switch');
    const buttons = [...switcher.querySelectorAll('button')];
    const hintText = hint.querySelector('span');
    const retryOriginalButton = hint.querySelector('[data-retouch-retry-original]');
    const retryResultButton = hint.querySelector('[data-retouch-retry-result]');
    const events = new windowRef.AbortController();
    let resultUrl = '', originalUrl = '';
    let view = 'result';
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
            if (card.contains(candidate) && !visibleOnCanvas(candidate.getBoundingClientRect())) continue;
            candidate.focus({ preventScroll: true });
            return;
        }
    }
    function setMode(mode) {
        if (stage.dataset.comparison === mode) return;
        const active = documentRef.activeElement;
        stage.dataset.comparison = mode;
        slider.hidden = mode !== 'split';
        switcher.hidden = mode !== 'switch';
        if (active === slider && slider.hidden || buttons.includes(active) && switcher.hidden) {
            const replacement = mode === 'split' ? slider
                : mode === 'switch' ? buttons.find(button => button.dataset.retouchCardView === view) : preview;
            focusVisible(replacement, inspect, retryResultButton);
        }
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
            setMode(fits ? 'split' : 'switch');
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

    function updateSplit() {
        const resultPercent = Number(slider.value);
        stage.style.setProperty('--retouch-original-share', `${100 - resultPercent}%`);
        slider.setAttribute('aria-valuetext', `原图 ${100 - resultPercent}%，精修 ${resultPercent}%`);
    }
    function show(next) {
        view = next;
        stage.dataset.retouchView = view;
        for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.retouchCardView === view));
    }
    function sync() {
        const active = documentRef.activeElement;
        const hasResult = Boolean(resultUrl && result.complete && result.naturalWidth && !resultFailed);
        const ready = Boolean(hasResult && originalUrl && original.complete && original.naturalWidth && !originalFailed);
        // A provider can return a different frame. Offer full-image switching
        // whenever the two frames cannot be meaningfully overlaid.
        matchingFrame = ready && Math.abs(original.naturalWidth / original.naturalHeight
            / (result.naturalWidth / result.naturalHeight) - 1) <= 0.01;
        stage.hidden = !resultUrl;
        preview.hidden = !hasResult;
        unavailable.hidden = !resultUrl || hasResult;
        const previewStatus = resultFailed ? '暂时无法预览精修结果' : '正在读取精修结果…';
        if (unavailable.textContent !== previewStatus) unavailable.textContent = previewStatus;
        original.hidden = !ready;
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
        else setMode(ready ? 'switch' : 'none');
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
    slider.addEventListener('input', updateSplit);
    for (const button of buttons) button.addEventListener('click', () => show(button.dataset.retouchCardView));
    preview.addEventListener('click', () => {
        const showingOriginal = view === 'original' && stage.dataset.comparison === 'switch';
        const url = showingOriginal ? original.src : result.src;
        if (url) openResultPreview([url], 0, () => focusVisible(preview, inspect, retryResultButton));
    });
    inspect.addEventListener('click', () => {
        if (inspect.getAttribute('aria-disabled') === 'true') return;
        if (!originalUrl || originalFailed) {
            openResultPreview([result.src], 0, () => focusVisible(inspect, retryResultButton));
            return;
        }
        closeDialog = openComparisonDialog({ documentRef, originalUrl: original.src, resultUrl: result.src, trigger: inspect, openResultPreview });
    });
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
                updateSplit();
                show('result');
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
            closeDialog?.();
            events.abort();
            resizeObserver?.disconnect();
            intersectionObserver?.disconnect();
            if (frameRequest !== null) windowRef.cancelAnimationFrame(frameRequest);
        }
    };
}
