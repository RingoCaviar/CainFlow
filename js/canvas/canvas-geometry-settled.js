/**
 * Announces that the viewport stopped moving.
 *
 * Node content fits read offsetWidth/offsetHeight, which forces synchronous
 * layout for the whole canvas document. Those reads are deferred while the
 * viewport moves, so every settle path must announce its end here instead of
 * each caller inventing its own signal.
 */
export const CANVAS_GEOMETRY_SETTLED_EVENT = 'cainflow:canvas-geometry-settled';

export function notifyCanvasGeometrySettled(state, documentRef = document) {
    if (!documentRef?.dispatchEvent) return false;
    if (state?.canvas?.isPanning === true || state?.isInteracting === true) return false;
    documentRef.dispatchEvent(new CustomEvent(CANVAS_GEOMETRY_SETTLED_EVENT));
    return true;
}
