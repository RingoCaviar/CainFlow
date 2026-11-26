const ACTIVE_CLASS = 'canvas-connection-bitmap-active';
const MAX_BITMAP_PIXELS = 6_000_000;
const MIN_BITMAP_PIXEL_RATIO = 0.75;
const ZOOM_REDRAW_THRESHOLD = 0.15;

export function createCanvasConnectionRenderer({ canvasContainer, documentRef = document, state, windowRef = window } = {}) {
    const flags = new URLSearchParams(windowRef.location?.search);
    const disabled = { enabled: false, begin() {}, draw() {}, end() {}, remove() {}, updateViewport() {}, refreshStyle() {}, destroy() {} };
    if (!canvasContainer || !state?.canvas || flags.get('perf') !== '1' || flags.get('canvasConnections') !== '1') return disabled;

    const canvas = documentRef.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return disabled;
    canvas.className = 'canvas-connections';
    canvas.setAttribute?.('aria-hidden', 'true');
    canvasContainer.prepend(canvas);

    const entries = new Map();
    let bitmap = null;
    let moving = false;
    let updating = false;
    let color = '';

    function setActive(active) {
        canvasContainer.classList.toggle(ACTIVE_CLASS, active);
    }

    function rasterize(view, dpr) {
        bitmap = null;
        if (updating || !entries.size || !color || color === 'none' || context.isContextLost?.()) return;
        const { width, height } = canvasContainer.getBoundingClientRect();
        if (!(width > 0 && height > 0 && view.zoom > 0)) return;
        const margin = Math.min(1024, Math.round(Math.max(width, height) * 0.55));
        const cssWidth = Math.ceil(width + 2 * margin);
        const cssHeight = Math.ceil(height + 2 * margin);
        const ratio = Math.min(dpr, 2, Math.sqrt(MAX_BITMAP_PIXELS / (cssWidth * cssHeight)));
        if (ratio < MIN_BITMAP_PIXEL_RATIO) return;
        const pixelWidth = Math.floor(cssWidth * ratio), pixelHeight = Math.floor(cssHeight * ratio);
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        canvas.style.width = cssWidth + 'px';
        canvas.style.height = cssHeight + 'px';

        const left = (-view.x - margin) / view.zoom;
        const top = (-view.y - margin) / view.zoom;
        const right = left + cssWidth / view.zoom;
        const bottom = top + cssHeight / view.zoom;
        const scaleX = pixelWidth / cssWidth, scaleY = pixelHeight / cssHeight;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, pixelWidth, pixelHeight);
        context.setTransform(scaleX * view.zoom, 0, 0, scaleY * view.zoom,
            -left * scaleX * view.zoom, -top * scaleY * view.zoom);
        context.beginPath();
        for (const { start, control1, control2, end } of entries.values()) {
            const points = [start, control1, control2, end];
            const padding = 2;
            if (points.every(point => point.x < left - padding) || points.every(point => point.x > right + padding) ||
                points.every(point => point.y < top - padding) || points.every(point => point.y > bottom + padding)) continue;
            context.moveTo(start.x, start.y);
            context.bezierCurveTo(control1.x, control1.y, control2.x, control2.y, end.x, end.y);
        }
        context.strokeStyle = color;
        context.lineWidth = 2.5;
        context.stroke();
        bitmap = { left, top, right, bottom, width, height, zoom: view.zoom, dpr };
    }

    function updateViewport(active) {
        moving = active;
        const contextLost = context.isContextLost?.();
        if (contextLost) bitmap = null;
        if (!active || state.canvasGpuAccelerationEnabled === false || contextLost) {
            setActive(false);
            return;
        }
        const view = state.canvas;
        const dpr = windowRef.devicePixelRatio || 1;
        if (!bitmap || bitmap.dpr !== dpr || Math.abs(view.zoom / bitmap.zoom - 1) >= ZOOM_REDRAW_THRESHOLD ||
            (-view.x / view.zoom) < bitmap.left || (-view.y / view.zoom) < bitmap.top ||
            ((bitmap.width - view.x) / view.zoom) > bitmap.right || ((bitmap.height - view.y) / view.zoom) > bitmap.bottom) {
            rasterize(view, dpr);
        }
        if (bitmap) {
            const offsetX = bitmap.left * view.zoom + view.x;
            const offsetY = bitmap.top * view.zoom + view.y;
            const transform = `translate(${offsetX}px, ${offsetY}px) scale(${view.zoom / bitmap.zoom})`;
            if (canvas.style.transform !== transform) canvas.style.transform = transform;
        }
        setActive(!!bitmap);
    }

    function invalidate() {
        bitmap = null;
        setActive(false);
    }

    function begin() {
        updating = true;
        entries.clear();
        invalidate();
    }

    function draw(id, curve) {
        if (!id || !curve?.start || !curve.control1 || !curve.control2 || !curve.end) return;
        entries.set(id, curve);
        if (bitmap) invalidate();
    }

    function refreshStyle() {
        color = windowRef.getComputedStyle(canvas).stroke;
        bitmap = null;
        if (moving) updateViewport(true);
        else rasterize(state.canvas, windowRef.devicePixelRatio || 1);
    }

    function end() {
        updating = false;
        refreshStyle();
    }

    function remove(id) {
        if (entries.delete(id) && bitmap) invalidate();
    }

    const resizeObserver = windowRef.ResizeObserver ? new windowRef.ResizeObserver(invalidate) : null;
    resizeObserver?.observe(canvasContainer);
    canvas.addEventListener?.('contextlost', invalidate);
    function destroy() {
        resizeObserver?.disconnect();
        canvas.removeEventListener?.('contextlost', invalidate);
        begin();
        canvas.remove();
    }

    return { enabled: true, begin, draw, end, remove, updateViewport, refreshStyle, destroy };
}
