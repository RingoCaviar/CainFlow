/**
 * 管理画布视口的平移、缩放与坐标换算，负责把世界坐标映射到屏幕空间。
 */
export function getViewportWorldBounds({ x, y, zoom }, { width, height }, bufferScreens, { scrollLeft = 0, scrollTop = 0 }) {
    if (![x, y, zoom, width, height].every(Number.isFinite) || zoom <= 0) return null;
    const paddingX = width * bufferScreens;
    const paddingY = height * bufferScreens;
    const left = scrollLeft - x;
    const top = scrollTop - y;
    return {
        left: (left - paddingX) / zoom,
        top: (top - paddingY) / zoom,
        right: (left + width + paddingX) / zoom,
        bottom: (top + height + paddingY) / zoom
    };
}

export function createViewportApi({
    state,
    elements,
    updateAllConnections,
    scheduleConnectionRefresh = null,
    requestAnimationFrameRef = requestAnimationFrame
}) {
    const DEFAULT_CANVAS_DOT_SPACING = 22;
    const TEXT_REFRESH_BUFFER_SCREENS = 0.5;
    let canvasDotSpacing = null;
    const canvasGrid = elements.canvasGrid || elements.canvasContainer;
    const refreshingTextNodes = new Set();

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
        setCustomStyle(canvasGrid.style, '--canvas-dot-spacing-scaled', `${dotSpacing}px`);
        setCustomStyle(canvasGrid.style, '--canvas-dot-offset-x', `${x}px`);
        setCustomStyle(canvasGrid.style, '--canvas-dot-offset-y', `${y}px`);
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

    function isOutsideTextRefreshArea(nodeEl, area) {
        if (!area) return false;
        const node = state.nodes?.get(nodeEl.id);
        if (!node || node.el !== nodeEl || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return false;
        if (node.x > area.right || node.y > area.bottom) return true;

        // Treat missing sizes as uncertain and keep a margin around the last observed bounds.
        const width = Math.max(Number(node.width) || 0, Number(node.observedWidth) || 0);
        const height = Math.max(Number(node.height) || 0, Number(node.observedHeight) || 0);
        return (width > 0 && node.x + width < area.left) || (height > 0 && node.y + height < area.top);
    }

    function refreshNodeTextRendering() {
        const nodes = elements.nodesLayer.querySelectorAll('.node');
        if (!nodes.length) return;
        const container = elements.canvasContainer;
        const containerRect = container.getBoundingClientRect();
        const area = getViewportWorldBounds(state.canvas, containerRect, TEXT_REFRESH_BUFFER_SCREENS, container);
        const visibleNodes = Array.from(nodes).filter((nodeEl) => {
            if (refreshingTextNodes.has(nodeEl) || isOutsideTextRefreshArea(nodeEl, area)) return false;
            const rect = nodeEl.getBoundingClientRect();
            return !(
                rect.right < containerRect.left ||
                rect.left > containerRect.right ||
                rect.bottom < containerRect.top ||
                rect.top > containerRect.bottom
            );
        });
        if (!visibleNodes.length) return;

        const needsCleanup = refreshingTextNodes.size === 0;
        for (const nodeEl of visibleNodes) {
            nodeEl.classList.add('render-refresh');
            refreshingTextNodes.add(nodeEl);
        }
        if (needsCleanup) requestAnimationFrameRef(() => {
            for (const nodeEl of refreshingTextNodes) nodeEl.classList.remove('render-refresh');
            refreshingTextNodes.clear();
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
