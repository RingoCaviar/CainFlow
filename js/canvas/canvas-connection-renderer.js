const ACTIVE_CLASS = 'canvas-connection-bitmap-active';
const MAX_BITMAP_PIXELS = 6_000_000;
const MAX_BITMAP_SIDE = 8192;
const MIN_BITMAP_PIXEL_RATIO = 0.75;
const ZOOM_REDRAW_THRESHOLD = 0.15;
const CURVE_POINTS = ['start', 'control1', 'control2', 'end'];

function sameCurve(first, second) {
    return first === second || (!!first && !!second && CURVE_POINTS.every(point =>
        first[point].x === second[point].x && first[point].y === second[point].y));
}

export function createCanvasConnectionRenderer({ canvasContainer, documentRef = document, state, windowRef = window } = {}) {
    const flags = new URLSearchParams(windowRef.location?.search);
    const disabled = { enabled: false, begin() {}, draw() {}, end() {}, remove() {}, updateViewport() {}, refreshStyle() {}, destroy() {} };
    if (!canvasContainer || !state?.canvas || flags.get('perf') !== '1' || flags.get('canvasConnections') !== '1') return disabled;

    const canvas = documentRef.createElement('canvas');
    let context;
    try {
        context = canvas.getContext('2d');
    } catch {
        context = null;
    }
    if (context) {
        canvas.className = 'canvas-connections';
        canvas.setAttribute?.('aria-hidden', 'true');
        canvasContainer.prepend(canvas);
    }

    let entries = new Map();
    let pendingEntries = null;
    let bitmap = null;
    let bitmapEnabled = true;
    let moving = false;
    let color = '';
    let observedSize = null;
    let projectedCoverage = null;
    let scrollLeft = canvasContainer.scrollLeft || 0;
    let scrollTop = canvasContainer.scrollTop || 0;

    function setActive(active) {
        canvasContainer.classList.toggle(ACTIVE_CLASS, active);
    }

    function measureCoverage(view, { width, height } = observedSize || canvasContainer.getBoundingClientRect()) {
        if (!(width > 0 && height > 0 && view.zoom > 0)) return null;
        const margin = Math.min(1024, Math.round(Math.max(width, height) * 0.55));
        const cssWidth = Math.ceil(width + 2 * margin);
        const cssHeight = Math.ceil(height + 2 * margin);
        const left = (scrollLeft - view.x - margin) / view.zoom;
        const top = (scrollTop - view.y - margin) / view.zoom;
        return { left, top, right: left + cssWidth / view.zoom, bottom: top + cssHeight / view.zoom,
            width, height, cssWidth, cssHeight, zoom: view.zoom };
    }

    function coversViewport(coverage, view) {
        if (!coverage || Math.abs(view.zoom / coverage.zoom - 1) >= ZOOM_REDRAW_THRESHOLD) return false;
        const left = (scrollLeft - view.x) / view.zoom;
        const top = (scrollTop - view.y) / view.zoom;
        return left >= coverage.left && top >= coverage.top && left + coverage.width / view.zoom <= coverage.right &&
            top + coverage.height / view.zoom <= coverage.bottom;
    }

    function requestCoverage() {
        if (pendingEntries || coversViewport(projectedCoverage, state.canvas)) return null;
        projectedCoverage = measureCoverage(state.canvas);
        return projectedCoverage;
    }

    function rasterize(view, dpr) {
        bitmap = null;
        if (!bitmapEnabled || pendingEntries || !entries.size || !color || color === 'none' ||
            state.canvasGpuAccelerationEnabled === false || context.isContextLost?.()) return;
        const coverage = measureCoverage(view);
        if (!coverage) return;
        const { left, top, right, bottom, cssWidth, cssHeight } = coverage;
        const ratio = Math.min(dpr, 2, MAX_BITMAP_SIDE / cssWidth, MAX_BITMAP_SIDE / cssHeight,
            Math.sqrt(MAX_BITMAP_PIXELS / (cssWidth * cssHeight)));
        if (ratio < MIN_BITMAP_PIXEL_RATIO) return;
        const pixelWidth = Math.floor(cssWidth * ratio), pixelHeight = Math.floor(cssHeight * ratio);
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        canvas.style.width = cssWidth + 'px';
        canvas.style.height = cssHeight + 'px';
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
        bitmap = { ...coverage, dpr };
    }

    function updateViewport(active) {
        moving = active;
        const contextLost = context.isContextLost?.();
        if (contextLost) bitmap = null;
        if (!bitmapEnabled || state.canvasGpuAccelerationEnabled === false) {
            releaseBitmap();
            return;
        }
        if (!active || pendingEntries || state.dragging || state.connecting || contextLost) {
            setActive(false);
            return;
        }
        const view = state.canvas;
        const dpr = windowRef.devicePixelRatio || 1;
        if (bitmap?.dpr !== dpr || !coversViewport(bitmap, view)) {
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

    function releaseBitmap() {
        invalidate();
        if (canvas.width !== 0) canvas.width = 0;
        if (canvas.height !== 0) canvas.height = 0;
    }

    function setBitmapEnabled(enabled) {
        if (bitmapEnabled === enabled) return;
        bitmapEnabled = enabled;
        if (enabled) prepareBitmap();
        else releaseBitmap();
    }

    function begin() {
        pendingEntries = new Map();
        projectedCoverage = null;
        setActive(false);
    }

    function draw(id, curve) {
        if (!id || !curve?.start || !curve.control1 || !curve.control2 || !curve.end) return;
        if (pendingEntries) {
            pendingEntries.set(id, curve);
        } else if (!sameCurve(entries.get(id), curve)) {
            entries.set(id, curve);
            invalidate();
        }
    }

    function refreshStyle() {
        const nextColor = windowRef.getComputedStyle(canvas).stroke;
        if (nextColor !== color) {
            color = nextColor;
            invalidate();
        }
        prepareBitmap();
    }

    function prepareBitmap() {
        if (moving) updateViewport(true);
        else if (!bitmap) rasterize(state.canvas, windowRef.devicePixelRatio || 1);
    }

    function end() {
        if (pendingEntries) {
            const changed = entries.size !== pendingEntries.size || [...pendingEntries].some(([id, curve]) =>
                !sameCurve(entries.get(id), curve));
            entries = pendingEntries;
            pendingEntries = null;
            if (changed) invalidate();
        }
        if (!entries.size) releaseBitmap();
        if (color) prepareBitmap();
        else refreshStyle();
    }

    function remove(id) {
        pendingEntries?.delete(id);
        if (!entries.delete(id)) return;
        if (!entries.size) releaseBitmap();
        else if (bitmap) invalidate();
    }

    const resizeObserver = windowRef.ResizeObserver ? new windowRef.ResizeObserver(([{ contentRect }]) => {
        const previous = observedSize || bitmap;
        observedSize = contentRect;
        if (contentRect.width !== previous?.width || contentRect.height !== previous?.height) {
            projectedCoverage = null;
            invalidate();
        }
    }) : null;
    resizeObserver?.observe(canvasContainer);
    function onScroll() {
        scrollLeft = canvasContainer.scrollLeft || 0;
        scrollTop = canvasContainer.scrollTop || 0;
        if (moving) setActive(false);
    }
    canvasContainer.addEventListener?.('scroll', onScroll);
    canvas.addEventListener?.('contextlost', invalidate);
    function destroy() {
        resizeObserver?.disconnect();
        canvasContainer.removeEventListener?.('scroll', onScroll);
        canvas.removeEventListener?.('contextlost', invalidate);
        pendingEntries = null;
        entries.clear();
        releaseBitmap();
        canvas.remove?.();
    }

    const getProjectionCoverage = size => measureCoverage(state.canvas, size);
    if (!context) return { ...disabled, begin() { projectedCoverage = null; }, requestCoverage, getProjectionCoverage, destroy };
    return { enabled: true, begin, draw, end, remove, requestCoverage, updateViewport, refreshStyle, setBitmapEnabled, destroy,
        getProjectionCoverage };
}
