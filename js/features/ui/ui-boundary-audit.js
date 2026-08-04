const DEFAULT_SELECTORS = [
    '#toolbar',
    '#side-bar',
    '#floating-notices-container',
    '#toast-container',
    '.drawer.active',
    '.help-panel.active',
    '.context-menu:not(.hidden)',
    '.theme-menu-panel:not(.hidden)',
    '.modal.active',
    '.modal-overlay:not(.hidden)',
    '.fullscreen-overlay.active',
    '.history-fullscreen-overlay:not(.hidden)',
    '.painter-overlay.active'
];

function isRendered(element, windowRef) {
    const style = windowRef.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
}

function toRect(element) {
    const rect = element.getBoundingClientRect();
    return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height
    };
}

function intersectionArea(a, b) {
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return width * height;
}

function identifies(element) {
    if (element.id) return `#${element.id}`;
    return `.${Array.from(element.classList).slice(0, 3).join('.')}`;
}

function isIntentionalOverlay(a, b) {
    const overlaySelector = '.modal, .modal-overlay, .fullscreen-overlay, .history-fullscreen-overlay, .painter-overlay';
    return a.matches(overlaySelector) || b.matches(overlaySelector) || a.contains(b) || b.contains(a);
}

export function auditUiBoundaries({
    documentRef = document,
    windowRef = window,
    selectors = DEFAULT_SELECTORS
} = {}) {
    const elements = Array.from(documentRef.querySelectorAll(selectors.join(',')))
        .filter((element) => isRendered(element, windowRef));
    const bounds = elements.map((element) => ({ element, name: identifies(element), rect: toRect(element) }));
    const viewport = {
        width: windowRef.innerWidth || documentRef.documentElement.clientWidth,
        height: windowRef.innerHeight || documentRef.documentElement.clientHeight
    };
    const outsideViewport = bounds
        .filter(({ rect }) => rect.left < -0.5 || rect.top < -0.5 || rect.right > viewport.width + 0.5 || rect.bottom > viewport.height + 0.5)
        .map(({ name, rect }) => ({ name, rect }));
    const overlaps = [];

    for (let index = 0; index < bounds.length; index += 1) {
        for (let peerIndex = index + 1; peerIndex < bounds.length; peerIndex += 1) {
            const first = bounds[index];
            const second = bounds[peerIndex];
            const area = intersectionArea(first.rect, second.rect);
            if (area > 1 && !isIntentionalOverlay(first.element, second.element)) {
                overlaps.push({ first: first.name, second: second.name, area });
            }
        }
    }

    return { viewport, outsideViewport, overlaps };
}

export function installUiBoundaryAudit({ documentRef = document, windowRef = window } = {}) {
    if (!new URLSearchParams(windowRef.location.search).has('ui-audit')) return;
    windowRef.__CAINFLOW_AUDIT_UI__ = () => auditUiBoundaries({ documentRef, windowRef });
}
