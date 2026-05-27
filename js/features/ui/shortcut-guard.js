/**
 * Central guard for canvas/node shortcuts.
 * Node shortcuts should only run while the canvas itself is the active workspace.
 */
export function isTextEditingTarget(target) {
    if (!target) return false;
    const element = target.nodeType === 1 ? target : target.parentElement;
    if (!element) return false;
    const editable = element.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
    return Boolean(editable);
}

function isElementVisible(element, windowRef) {
    if (!element || element.classList.contains('hidden')) return false;
    const style = windowRef.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

export function isModalOrFullscreenOpen({ documentRef = document, windowRef = window } = {}) {
    const blockingSelectors = [
        '.modal-overlay:not(.hidden)',
        '.modal.active',
        '.fullscreen-overlay',
        '.history-fullscreen-overlay:not(.hidden)',
        '.painter-overlay',
        '.image-compare-advanced-overlay',
        '.camera-control-editor-overlay',
        '.reference-image-count-dialog:not(.hidden)',
        '.provider-models-dialog:not(.hidden)',
        '.api-settings-help-dialog:not(.hidden)',
        '#prompt-library-modal:not(.hidden)',
        '#prompt-import-dialog:not(.hidden)'
    ];

    return blockingSelectors.some((selector) => (
        Array.from(documentRef.querySelectorAll(selector)).some((element) => isElementVisible(element, windowRef))
    ));
}

export function canUseCanvasShortcuts({
    event = null,
    state = null,
    canvasContainer = null,
    documentRef = document,
    windowRef = window
} = {}) {
    const target = event?.target || documentRef.activeElement;
    if (isTextEditingTarget(target)) return false;
    if (isModalOrFullscreenOpen({ documentRef, windowRef })) return false;

    const overCanvas = state?.isMouseOverCanvas === true;
    const focusedInsideCanvas = canvasContainer && target && (
        target === canvasContainer || canvasContainer.contains(target)
    );
    return overCanvas || focusedInsideCanvas;
}
