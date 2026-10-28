/**
 * 管理画布视口的平移、缩放与坐标换算，负责把世界坐标映射到屏幕空间。
 */
export function createViewportApi({
    state,
    elements,
    updateAllConnections,
    scheduleConnectionRefresh = null,
    requestAnimationFrameRef = requestAnimationFrame
}) {
    const DEFAULT_CANVAS_DOT_SPACING = 22;
    let canvasDotSpacing = null;

    function getCanvasDotSpacing() {
        if (canvasDotSpacing !== null) return canvasDotSpacing;
        if (!elements.canvasContainer || typeof getComputedStyle !== 'function') {
            canvasDotSpacing = DEFAULT_CANVAS_DOT_SPACING;
            return canvasDotSpacing;
        }

        const rawSpacing = getComputedStyle(elements.canvasContainer)
            .getPropertyValue('--canvas-dot-spacing')
            .trim();
        const parsedSpacing = Number.parseFloat(rawSpacing);
        canvasDotSpacing = Number.isFinite(parsedSpacing) && parsedSpacing > 0
            ? parsedSpacing
            : DEFAULT_CANVAS_DOT_SPACING;
        return canvasDotSpacing;
    }

    function refreshCanvasThemeMetrics() {
        canvasDotSpacing = null;
    }

    function setCustomStyle(style, name, value) {
        const text = String(value);
        if (style.getPropertyValue?.(name) !== text) style.setProperty(name, text);
    }

    function setTransformAttribute(element, value) {
        if (element && element.getAttribute?.('transform') !== value) element.setAttribute('transform', value);
    }

    function applyCanvasVisualTransform(options = {}) {
        const { x, y, zoom } = state.canvas;
        const transform = `translate(${x}px, ${y}px) scale(${zoom})`;
        if (elements.nodesLayer.style.transform !== transform) elements.nodesLayer.style.transform = transform;
        if (elements.nodesLayer.style.transformOrigin !== '0px 0px') elements.nodesLayer.style.transformOrigin = '0px 0px';
        setCustomStyle(elements.nodesLayer.style, '--canvas-zoom', zoom);
        const svgTransform = `translate(${x}, ${y}) scale(${zoom})`;
        setTransformAttribute(elements.connectionsGroup, svgTransform);
        setTransformAttribute(elements.originAxes, svgTransform);

        const dotSpacing = getCanvasDotSpacing() * zoom;
        setCustomStyle(elements.canvasContainer.style, '--canvas-dot-spacing-scaled', `${dotSpacing}px`);
        setCustomStyle(elements.canvasContainer.style, '--canvas-dot-offset-x', `${x}px`);
        setCustomStyle(elements.canvasContainer.style, '--canvas-dot-offset-y', `${y}px`);
        if (elements.zoomLevel) {
            const label = `${Math.round(zoom * 100)}%`;
            if (elements.zoomLevel.textContent !== label) elements.zoomLevel.textContent = label;
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
            if (typeof scheduleConnectionRefresh === 'function') {
                scheduleConnectionRefresh({
                    force: options.forceConnections === true,
                    immediate: options.immediateConnections === true,
                    settle: options.settleConnections === true,
                    reason: options.connectionRefreshReason || 'canvas-transform'
                });
            } else {
                updateAllConnections();
            }
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
        refreshCanvasThemeMetrics,
        applyCanvasVisualTransform,
        updateCanvasTransform,
        screenToCanvas,
        refreshNodeTextRendering
    };
}
/**
 * 管理画布视口的平移、缩放和坐标转换逻辑。
 */
