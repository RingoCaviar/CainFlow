import { getSurfaceCoordinator } from '../features/ui/surface-coordinator.js';
import { createBackdropDismissalGuard } from '../features/settings/backdrop-dismissal.js';

const handleIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 8-4 4 4 4m6-8 4 4-4 4"/></svg>';
let dialogSequence = 0;

export function renderProductRetouchComparison() {
    return `<div class="product-retouch-compare-stage" hidden>
        <button type="button" class="product-retouch-card-preview" aria-label="查看大图" data-node-read-action><img data-retouch-result alt="精修结果" draggable="false"></button>
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
        if (trigger.isConnected && !trigger.closest('[hidden], [inert]')) trigger.focus({ preventScroll: true });
    };
    function show(view) {
        currentView = view;
        current = view === 'original' ? originalUrl : resultUrl;
        image.alt = view === 'original' ? '本次精修使用的原图' : '精修结果';
        image.hidden = false;
        status.hidden = true;
        openImage.disabled = false;
        setImageSource(image, current);
        for (const button of choices) button.setAttribute('aria-pressed', String(button.dataset.retouchView === view));
    }
    image.addEventListener('error', () => {
        if (!image.complete || image.naturalWidth) return;
        image.hidden = true;
        status.hidden = false;
        status.textContent = currentView === 'original' ? '无法读取本次精修的原图' : '无法读取精修结果';
        openImage.disabled = true;
    });
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
    const stage = card.querySelector('.product-retouch-compare-stage');
    const preview = stage.querySelector('.product-retouch-card-preview');
    const result = stage.querySelector('[data-retouch-result]');
    const original = stage.querySelector('[data-retouch-original]');
    const slider = stage.querySelector('[data-retouch-compare-slider]');
    const switcher = card.querySelector('.product-retouch-compare-switch');
    const buttons = [...switcher.querySelectorAll('button')];
    const retry = hint.querySelector('button');
    let resultUrl = '', originalUrl = '';
    let view = 'result';
    let originalFailed = false;
    let retryCount = 0;
    let closeDialog = null;

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
        const hasOriginal = Boolean(originalUrl && original.complete && original.naturalWidth && !originalFailed);
        const ready = Boolean(resultUrl && result.complete && result.naturalWidth && hasOriginal);
        // A provider can return a different frame. Offer full-image switching
        // whenever the two frames cannot be meaningfully overlaid.
        const matchingFrame = ready && Math.abs(original.naturalWidth / original.naturalHeight
            / (result.naturalWidth / result.naturalHeight) - 1) <= 0.01;
        stage.dataset.comparison = ready ? (matchingFrame ? 'split' : 'switch') : 'none';
        stage.hidden = !resultUrl;
        original.hidden = !ready;
        slider.hidden = !matchingFrame;
        switcher.hidden = !ready;
        switcher.dataset.comparison = stage.dataset.comparison;
        inspect.hidden = !resultUrl;
        const label = originalUrl && !originalFailed ? '查看对照' : '查看精修结果';
        if (inspect.textContent !== label) inspect.textContent = label;
        hint.hidden = !resultUrl || (Boolean(originalUrl) && !originalFailed);
        retry.hidden = !originalFailed || !originalUrl;
    }
    function retryOriginal() {
        originalFailed = false;
        const url = new URL(originalUrl, documentRef.baseURI);
        url.searchParams.set('retry', String(++retryCount));
        setImageSource(original, url.href);
        sync();
    }
    original.addEventListener('load', sync);
    original.addEventListener('error', () => {
        if (!original.complete || original.naturalWidth || !originalUrl) return;
        originalFailed = true;
        sync();
    });
    result.addEventListener('load', sync);
    result.addEventListener('error', sync);
    retry.addEventListener('click', () => {
        inspect.focus({ preventScroll: true });
        retryOriginal();
    });
    slider.addEventListener('mousedown', event => event.stopPropagation());
    slider.addEventListener('input', updateSplit);
    for (const button of buttons) button.addEventListener('click', () => show(button.dataset.retouchCardView));
    preview.addEventListener('click', () => {
        const showingOriginal = view === 'original' && switcher.checkVisibility();
        const url = showingOriginal ? original.src : resultUrl;
        if (url) openResultPreview([url], 0, () => preview.focus({ preventScroll: true }));
    });
    inspect.addEventListener('click', () => {
        if (!resultUrl) return;
        if (!originalUrl || originalFailed) {
            openResultPreview([resultUrl], 0, () => inspect.focus({ preventScroll: true }));
            return;
        }
        closeDialog = openComparisonDialog({ documentRef, originalUrl: original.src, resultUrl, trigger: inspect, openResultPreview });
    });
    return {
        update(nextResult, nextOriginal, retouchCompleted) {
            if (nextResult !== resultUrl || nextOriginal !== originalUrl) {
                const originalChanged = nextOriginal !== originalUrl;
                resultUrl = nextResult;
                originalUrl = nextOriginal;
                if (originalChanged) originalFailed = false;
                slider.value = '50';
                updateSplit();
                show('result');
                setImageSource(result, resultUrl);
                if (originalChanged) setImageSource(original, originalUrl);
            }
            if (retouchCompleted && originalUrl && originalFailed) retryOriginal();
            sync();
        },
        destroy() { closeDialog?.(); }
    };
}
