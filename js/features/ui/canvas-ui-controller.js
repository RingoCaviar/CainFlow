/**
 * Applies canvas chrome visibility preferences shared by toolbar/sidebar UI.
 */
export function applyCanvasUiSetting({
    state,
    documentRef = document
}) {
    const body = documentRef.body;
    if (!body) {
        return {
            toolbarPinned: state.toolbarPinned === true,
            sidebarPinned: state.sidebarPinned === true
        };
    }

    const toolbarPinned = state.toolbarPinned === true;
    const sidebarPinned = state.sidebarPinned === true;
    body.classList.toggle('toolbar-pinned', toolbarPinned);
    body.classList.toggle('sidebar-pinned', sidebarPinned);
    return { toolbarPinned, sidebarPinned };
}
