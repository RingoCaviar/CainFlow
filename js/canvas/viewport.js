/**
 * 管理画布视口的平移、缩放与坐标换算，负责把世界坐标映射到屏幕空间。
 */
export function createViewportApi({
    state,
    elements,
    updateAllConnections,
    requestAnimationFrameRef = requestAnimationFrame
}) {
    const DEFAULT_CANVAS_DOT_SPACING = 22;

    function getCanvasDotSpacing() {
        if (!elements.canvasContainer || typeof getComputedStyle !== 'function') {
            return DEFAULT_CANVAS_DOT_SPACING;
        }

        const rawSpacing = getComputedStyle(elements.canvasContainer)
            .getPropertyValue('--canvas-dot-spacing')
            .trim();
        const parsedSpacing = Number.parseFloat(rawSpacing);
        return Number.isFinite(parsedSpacing) && parsedSpacing > 0
            ? parsedSpacing
            : DEFAULT_CANVAS_DOT_SPACING;
    }

    function applyCanvasVisualTransform(options = {}) {
        const { x, y, zoom } = state.canvas;
        elements.nodesLayer.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
        elements.nodesLayer.style.transformOrigin = '0 0';
        elements.nodesLayer.style.setProperty('--canvas-zoom', zoom);
        elements.connectionsGroup?.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);
        elements.originAxes?.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);

        const dotSpacing = getCanvasDotSpacing() * zoom;
        elements.canvasContainer.style.setProperty('--canvas-dot-spacing-scaled', `${dotSpacing}px`);
        elements.canvasContainer.style.setProperty('--canvas-dot-offset-x', `${x}px`);
        elements.canvasContainer.style.setProperty('--canvas-dot-offset-y', `${y}px`);
        if (elements.zoomLevel) {
            elements.zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
        }
        if (options.dispatchTransformEvent !== false) {
            elements.canvasContainer?.ownerDocument?.dispatchEvent(new CustomEvent('cainflow:canvas-transform', {
                detail: { x, y, zoom }
            }));
        }
    }

    function updateCanvasTransform(options = {}) {
        applyCanvasVisualTransform(options);
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
