/**
 * Applies the unified canvas toolbar visibility preference.
 */
export function applyCanvasUiSetting({
    state,
    documentRef = document
}) {
    const body = documentRef.body;
    if (!body) {
        return {
            toolbarPinned: state.toolbarPinned === true
        };
    }

    const toolbarPinned = state.toolbarPinned === true;
    body.classList.toggle('toolbar-pinned', toolbarPinned);
    body.classList.remove('sidebar-pinned', 'sidebar-peek-active');
    return { toolbarPinned };
}
