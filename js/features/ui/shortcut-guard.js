/**
 * Central guard for canvas/node shortcuts.
 * Node shortcuts should only run while the canvas itself is the active workspace.
 */
export function isTextEditingTarget(target) {
    if (!target) return false;
    const element = target.nodeType === 1 ? target : target.parentElement;
    if (!element) return false;
    const editable = element.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]');
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
        '.dialog-style-1:not(.hidden)',
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
    requireCanvasFocus = false,
    documentRef = document,
    windowRef = window
} = {}) {
    if (event?.isComposing || event?.keyCode === 229) return false;
    const target = event?.target || documentRef.activeElement;
    if (isTextEditingTarget(target)) return false;
    const element = target?.nodeType === 1 ? target : target?.parentElement;
    if (element?.closest?.('.image-parameter-panel, #prompt-agent-panel, #canvas-run-scope, .theme-menu-shell, .theme-menu-panel')) return false;
    if (isModalOrFullscreenOpen({ documentRef, windowRef })) return false;

    const overCanvas = state?.isMouseOverCanvas === true;
    const focusedInsideCanvas = canvasContainer && target && (
        target === canvasContainer || canvasContainer.contains(target)
    );
    if (requireCanvasFocus) {
        return Boolean(!event?.defaultPrevented && focusedInsideCanvas && target === documentRef.activeElement
            && !element?.closest?.('button, a[href], summary, [role="button"], [role="menuitem"], [role="combobox"], #canvas-navigation'));
    }
    return overCanvas || focusedInsideCanvas;
}
