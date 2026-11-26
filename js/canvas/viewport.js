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
    reportConnectionViewportFrame = null,
    requestAnimationFrameRef = requestAnimationFrame
}) {
    const DEFAULT_CANVAS_DOT_SPACING = 22;
    const TEXT_REFRESH_BUFFER_SCREENS = 0.5;
    // Re-anchoring rewrites the wire group's transform, which repaints every
    // visible path. At 192px that happens 15+ times per drag on a normal
    // viewport and each re-anchor costs 50-60ms in the compositor, which reads
    // as stutter. The margin now scales with the viewport so a typical drag
    // re-anchors at most once, and the extra layer area only costs one raster
    // pass that the tile manager already limits to what is visible.
    const MIN_WIRE_PAN_MARGIN = 192;
    const MAX_WIRE_PAN_MARGIN = 1024;
    const WIRE_PAN_MARGIN_RATIO = 0.55;
    let canvasDotSpacing = null;
    let wirePanMargin = MIN_WIRE_PAN_MARGIN;
    const canvasGrid = elements.canvasGrid || elements.canvasContainer;
    const wireLayer = elements.connectionsGroup?.ownerSVGElement;
    const [horizontalAxis, verticalAxis] = elements.originAxes?.querySelectorAll?.('line') || [];
    let wireAnchor = null;
    let originAxisBounds = null;
    let canvasViewportSize = null;
    let originAxisScrollLeft = 0;
    let originAxisScrollTop = 0;
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

    function resolveWirePanMargin() {
        const container = elements.canvasContainer;
        // A first pan frame has already changed canvas styles. Reuse the
        // observed size so reading the margin does not flush layout here.
        const width = canvasViewportSize?.width ?? (Number(container?.clientWidth) || 0);
        const height = canvasViewportSize?.height ?? (Number(container?.clientHeight) || 0);
        const size = Math.max(width, height);
        if (!size) return MIN_WIRE_PAN_MARGIN;
        return Math.min(MAX_WIRE_PAN_MARGIN,
            Math.max(MIN_WIRE_PAN_MARGIN, Math.round(size * WIRE_PAN_MARGIN_RATIO)));
    }

    function applyWireTransform(x, y, zoom) {
        if (wireLayer && state.canvas.isPanning && !state.connecting && state.canvasGpuAccelerationEnabled !== false) {
            // Rasterize a margin around the viewport so small pans can move
            // the same clipped wire layer without repainting hundreds of paths.
            if (!wireAnchor) wirePanMargin = resolveWirePanMargin();
            if (!wireAnchor || wireAnchor.zoom !== zoom ||
                Math.abs(x - wireAnchor.x) >= wirePanMargin || Math.abs(y - wireAnchor.y) >= wirePanMargin) {
                wireAnchor = { x, y, zoom };
                setCustomStyle(wireLayer.style, '--pan-margin', `${wirePanMargin}px`);
                setCustomStyle(wireLayer.style, '--wire-anchor', `translate(${x + wirePanMargin}px, ${y + wirePanMargin}px) scale(${zoom})`);
                wireLayer.classList.add('pan-wire-layer');
            }
            wireLayer.style.transform = `translate(${x - wireAnchor.x}px, ${y - wireAnchor.y}px)`;
            return;
        }
        if (wireAnchor) {
            wireAnchor = null;
            wireLayer.classList.remove('pan-wire-layer');
            wireLayer.style.transform = '';
        }
        const svgTransform = `translate(${x}, ${y}) scale(${zoom})`;
        setTransformAttribute(elements.connectionsGroup, svgTransform);
        setTransformAttribute(elements.originAxes, svgTransform);
    }

    function updateOriginAxisBounds(x, y, zoom) {
        if (!horizontalAxis || !verticalAxis || !(zoom > 0)) return;
        const container = elements.canvasContainer;
        const width = canvasViewportSize?.width ?? container.clientWidth;
        const height = canvasViewportSize?.height ?? container.clientHeight;
        if (!(width > 0 && height > 0)) return;

        const margin = wireAnchor ? wirePanMargin : 0;
        const left = (originAxisScrollLeft - x - margin) / zoom;
        const top = (originAxisScrollTop - y - margin) / zoom;
        const right = left + (width + 2 * margin) / zoom;
        const bottom = top + (height + 2 * margin) / zoom;
        if (originAxisBounds && zoom <= originAxisBounds.zoom * 2 &&
            left >= originAxisBounds.left && right <= originAxisBounds.right &&
            top >= originAxisBounds.top && bottom <= originAxisBounds.bottom) return;

        // Chromium expands the dash pattern before clipping. A bounded segment
        // avoids generating dashes across two million world units on zoom.
        const padding = Math.max(width, height, MAX_WIRE_PAN_MARGIN * 2) / zoom;
        originAxisBounds = {
            left: left - padding, right: right + padding,
            top: top - padding, bottom: bottom + padding, zoom
        };
        horizontalAxis.setAttribute('x1', originAxisBounds.left);
        horizontalAxis.setAttribute('x2', originAxisBounds.right);
        verticalAxis.setAttribute('y1', originAxisBounds.top);
        verticalAxis.setAttribute('y2', originAxisBounds.bottom);
    }

    function applyCanvasVisualTransform(options = {}) {
        const { x, y, zoom } = state.canvas;
        const transform = `translate(${x}px, ${y}px) scale(${zoom})`;
        if (elements.nodesLayer.style.transform !== transform) elements.nodesLayer.style.transform = transform;
        if (elements.nodesLayer.style.transformOrigin !== '0px 0px') elements.nodesLayer.style.transformOrigin = '0px 0px';
        setCustomStyle(elements.nodesLayer.style, '--canvas-zoom', zoom);
        applyWireTransform(x, y, zoom);
        updateOriginAxisBounds(x, y, zoom);
        reportConnectionViewportFrame?.();
        const dotSpacing = getCanvasDotSpacing() * zoom;
        setCustomStyle(canvasGrid.style, '--canvas-dot-spacing-scaled', `${dotSpacing}px`);
        setCustomStyle(canvasGrid.style, '--canvas-dot-offset-x', `${x}px`);
        setCustomStyle(canvasGrid.style, '--canvas-dot-offset-y', `${y}px`);
        if (elements.zoomLevel) {
            const label = `${Math.round(zoom * 100)}%`;
            if (elements.zoomLevel.textContent !== label) {
                const text = elements.zoomLevel.firstChild;
                // Replacing the child invalidates ancestor :has() selectors and
                // unrelated node styles on every zoom frame. Keep the text node.
                if (text?.nodeType === 3 && text === elements.zoomLevel.lastChild) text.data = label;
                else elements.zoomLevel.textContent = label;
            }
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

    if (wireLayer || (horizontalAxis && verticalAxis)) {
        const container = elements.canvasContainer;
        const { ResizeObserver } = container.ownerDocument?.defaultView || {};
        const refreshOriginAxes = () => {
            const { x, y, zoom } = state.canvas;
            updateOriginAxisBounds(x, y, zoom);
        };
        if (ResizeObserver) {
            const observer = new ResizeObserver(([entry]) => {
                canvasViewportSize = entry.contentRect;
                refreshOriginAxes();
            });
            observer.observe(container);
        }
        if (horizontalAxis && verticalAxis) {
            container.addEventListener?.('scroll', () => {
                originAxisScrollLeft = container.scrollLeft;
                originAxisScrollTop = container.scrollTop;
                refreshOriginAxes();
            });
        }
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
