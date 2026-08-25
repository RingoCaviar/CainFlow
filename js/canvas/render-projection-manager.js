/**
 * Keeps Canvas rendering cheap without making rendering state authoritative.
 * Node DOM and the workflow model remain intact; this module only assigns
 * reversible CSS projections to existing node shells.
 */
export function createRenderProjectionManager({
    state,
    canvasContainer,
    nodesLayer,
    documentRef = document,
    windowRef = window,
    requestAnimationFrameRef = requestAnimationFrame,
    performanceMonitor = null
} = {}) {
    const VIEWPORT_BUFFER_SCREENS = 0.5;
    const COMPACT_ENTER_ZOOM = 0.2;
    const COMPACT_EXIT_ZOOM = 0.27;
    const DENSE_ENTER_NODE_COUNT = 80;
    const DENSE_EXIT_NODE_COUNT = 64;
    let frame = null;
    let compact = false;
    let dense = false;
    let observer = null;
    const focusedNodeIds = new Set();

    function getViewport() {
        const rect = canvasContainer?.getBoundingClientRect?.();
        const zoom = Number(state?.canvas?.zoom) || 1;
        if (!rect || zoom <= 0) return null;
        const x = Number(state.canvas.x) || 0;
        const y = Number(state.canvas.y) || 0;
        const padX = rect.width * VIEWPORT_BUFFER_SCREENS / zoom;
        const padY = rect.height * VIEWPORT_BUFFER_SCREENS / zoom;
        return {
            left: -x / zoom - padX,
            top: -y / zoom - padY,
            right: (rect.width - x) / zoom + padX,
            bottom: (rect.height - y) / zoom + padY
        };
    }

    function isOutsideViewport(node, viewport) {
        if (!node || !viewport) return false;
        const width = Math.max(1, Number(node.width) || node.el?.offsetWidth || 180);
        const height = Math.max(1, Number(node.height) || node.el?.offsetHeight || 120);
        const left = Number(node.x) || 0;
        const top = Number(node.y) || 0;
        return left + width < viewport.left || left > viewport.right || top + height < viewport.top || top > viewport.bottom;
    }

    function updateModes() {
        const zoom = Number(state?.canvas?.zoom) || 1;
        compact = compact ? zoom < COMPACT_EXIT_ZOOM : zoom <= COMPACT_ENTER_ZOOM;
        const override = state?.canvasRender?.denseModeOverride || 'auto';
        const nodeCount = state?.nodes?.size || 0;
        dense = override === 'on' || (override !== 'off' && (dense ? nodeCount > DENSE_EXIT_NODE_COUNT : nodeCount >= DENSE_ENTER_NODE_COUNT));
        canvasContainer?.classList.toggle('canvas-dense-mode', dense);
    }

    function refreshNow() {
        return performanceMonitor?.measure?.('render-projection', refreshNowImpl) ?? refreshNowImpl();
    }

    function refreshNowImpl() {
        frame = null;
        if (!state?.nodes) return;
        updateModes();
        const viewport = getViewport();
        state.nodes.forEach((node, nodeId) => {
            const el = node?.el;
            if (!el) return;
            const hasFocusedControl = el.contains?.(documentRef.activeElement) === true;
            const forceFull = focusedNodeIds.has(nodeId) || hasFocusedControl || state.runningNodeIds?.has(nodeId);
            const virtualized = !forceFull && isOutsideViewport(node, viewport);
            el.classList.toggle('is-virtualized', virtualized);
            el.classList.toggle('is-compact-lod', !virtualized && compact && !forceFull);
            el.setAttribute('data-render-projection', virtualized ? 'shell' : (compact && !forceFull ? 'compact' : 'full'));
        });
    }

    function scheduleRefresh() {
        if (frame !== null) return;
        frame = requestAnimationFrameRef(refreshNow);
    }

    function focusNode(nodeId) {
        if (!nodeId) return;
        focusedNodeIds.clear();
        focusedNodeIds.add(nodeId);
        scheduleRefresh();
    }

    function releaseFocusedNode(nodeId) {
        focusedNodeIds.delete(nodeId);
        scheduleRefresh();
    }

    function init() {
        documentRef.addEventListener('cainflow:canvas-transform', scheduleRefresh);
        nodesLayer?.addEventListener('dblclick', (event) => {
            const nodeEl = event.target.closest?.('.node.is-compact-lod');
            if (nodeEl) focusNode(nodeEl.id);
        });
        canvasContainer?.addEventListener('click', (event) => {
            if (event.target === canvasContainer && focusedNodeIds.size > 0) {
                focusedNodeIds.clear();
                scheduleRefresh();
            }
        });
        if (windowRef.MutationObserver && nodesLayer) {
            observer = new windowRef.MutationObserver(scheduleRefresh);
            observer.observe(nodesLayer, { childList: true });
        }
        scheduleRefresh();
    }

    function destroy() {
        if (frame !== null) windowRef.cancelAnimationFrame?.(frame);
        observer?.disconnect();
        documentRef.removeEventListener('cainflow:canvas-transform', scheduleRefresh);
    }

    return { init, destroy, refreshNow, scheduleRefresh, focusNode, releaseFocusedNode };
}
