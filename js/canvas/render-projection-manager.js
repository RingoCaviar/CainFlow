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
    const DENSE_ENTER_NODE_COUNT = 80;
    const DENSE_EXIT_NODE_COUNT = 64;
    let frame = null;
    let dense = false;
    let observer = null;
    const focusedNodeIds = new Set();
    const projectionByElement = new WeakMap();

    function setClass(el, name, enabled) {
        if (el?.classList.contains(name) !== enabled) el?.classList.toggle(name, enabled);
    }

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
        if (!viewport) return false;
        const left = Number(node.x) || 0;
        const top = Number(node.y) || 0;
        if (left > viewport.right || top > viewport.bottom) return true;
        // Only measure an edge if the node might overlap the viewport from that side.
        if (left < viewport.left) {
            const width = Math.max(1, Number(node.width) || node.el.offsetWidth || 180);
            if (left + width < viewport.left) return true;
        }
        if (top < viewport.top) {
            const height = Math.max(1, Number(node.height) || node.el.offsetHeight || 120);
            if (top + height < viewport.top) return true;
        }
        return false;
    }

    function updateDenseMode() {
        const override = state?.canvasRender?.denseModeOverride || 'auto';
        const nodeCount = state?.nodes?.size || 0;
        dense = override === 'on' || (override !== 'off' && (dense ? nodeCount > DENSE_EXIT_NODE_COUNT : nodeCount >= DENSE_ENTER_NODE_COUNT));
        setClass(canvasContainer, 'canvas-dense-mode', dense);
    }

    function refreshNow() {
        if (performanceMonitor?.measure) {
            return performanceMonitor.measure('render-projection', refreshNowImpl);
        }
        return refreshNowImpl();
    }

    function refreshNowImpl() {
        frame = null;
        if (!state?.nodes) return;
        updateDenseMode();
        const viewport = getViewport();
        const activeElement = documentRef.activeElement;
        const changes = [];
        state.nodes.forEach((node, nodeId) => {
            const el = node?.el;
            if (!el) return;
            const hasFocusedControl = el.contains?.(activeElement) === true;
            const forceFull = focusedNodeIds.has(nodeId) || hasFocusedControl || state.runningNodeIds?.has(nodeId);
            const virtualized = !forceFull && isOutsideViewport(node, viewport);
            const projection = virtualized ? 'shell' : 'full';
            if (projectionByElement.get(el) !== projection) {
                changes.push({ el, projection });
            }
        });
        // Projection classes can change layout. Finish all geometry reads first.
        for (const { el, projection } of changes) {
            setClass(el, 'is-virtualized', projection === 'shell');
            el.setAttribute('data-render-projection', projection);
            projectionByElement.set(el, projection);
        }
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
