/**
 * 管理画布视口的平移、缩放与坐标换算，负责把世界坐标映射到屏幕空间。
 */
export function createViewportApi({
    state,
    elements,
    updateAllConnections,
    requestAnimationFrameRef = requestAnimationFrame
}) {
    function applyCanvasVisualTransform() {
        const { x, y, zoom } = state.canvas;
        elements.nodesLayer.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
        elements.nodesLayer.style.transformOrigin = '0 0';
        elements.nodesLayer.style.setProperty('--canvas-zoom', zoom);
        elements.connectionsGroup?.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);
        elements.originAxes?.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);

        const gridSize = 20 * zoom;
        elements.canvasContainer.style.backgroundSize = `${gridSize}px ${gridSize}px`;
        elements.canvasContainer.style.backgroundPosition = `${x}px ${y}px`;
        if (elements.zoomLevel) {
            elements.zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
        }
    }

    function updateCanvasTransform(options = {}) {
        applyCanvasVisualTransform();
        if (options.updateConnections !== false) {
            updateAllConnections();
        }
    }

    function screenToCanvas(sx, sy) {
        const rect = elements.canvasContainer.getBoundingClientRect();
        const { x, y, zoom } = state.canvas;
        return { x: (sx - rect.left - x) / zoom, y: (sy - rect.top - y) / zoom };
    }

    function refreshNodeTextRendering() {
        const nodes = elements.nodesLayer.querySelectorAll('.node');
        if (!nodes.length) return;
        const containerRect = elements.canvasContainer.getBoundingClientRect();
        const visibleNodes = Array.from(nodes).filter((nodeEl) => {
            const rect = nodeEl.getBoundingClientRect();
            return !(
                rect.right < containerRect.left ||
                rect.left > containerRect.right ||
                rect.bottom < containerRect.top ||
                rect.top > containerRect.bottom
            );
        });
        if (!visibleNodes.length) return;

        visibleNodes.forEach((nodeEl) => nodeEl.classList.add('render-refresh'));
        requestAnimationFrameRef(() => {
            visibleNodes.forEach((nodeEl) => nodeEl.classList.remove('render-refresh'));
        });
    }

    return {
        applyCanvasVisualTransform,
        updateCanvasTransform,
        screenToCanvas,
        refreshNodeTextRendering
    };
}
/**
 * 管理画布视口的平移、缩放和坐标转换逻辑。
 */
