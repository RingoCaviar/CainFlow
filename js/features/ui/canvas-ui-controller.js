/**
 * Applies canvas presentation preferences without changing the workflow model.
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
    const canvasClasses = documentRef.getElementById?.('canvas-container')?.classList;
    const gpuDisabled = state.canvasGpuAccelerationEnabled === false;
    if (canvasClasses && canvasClasses.contains('canvas-gpu-disabled') !== gpuDisabled) {
        canvasClasses.toggle('canvas-gpu-disabled', gpuDisabled);
    }
    body.classList.toggle('toolbar-pinned', toolbarPinned);
    body.classList.remove('sidebar-pinned', 'sidebar-peek-active');
    return { toolbarPinned };
}
