export function createCanvasConnectionRenderer({ canvasContainer, documentRef = document, state, windowRef = window } = {}) {
    // The Canvas connection renderer remains experimental and is disabled for release.
    const enabled = false;
    if (!enabled || !canvasContainer) return { enabled: false, begin() {}, destroy() {}, draw() {}, end() {} };

    const canvas = windowRef.document.createElement('canvas');
    canvas.className = 'canvas-connections';
    canvasContainer.prepend(canvas);
    const context = canvas.getContext('2d');
    const entries = new Map();
    let redrawFrame = null;
    let canvasWidth = 0;
    let canvasHeight = 0;
    let canvasRatio = 0;

    function prepareCanvas() {
        const rect = canvasContainer.getBoundingClientRect();
        const ratio = windowRef.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(rect.width * ratio));
        const height = Math.max(1, Math.round(rect.height * ratio));
        if (canvasWidth !== width || canvasHeight !== height || canvasRatio !== ratio) {
            canvas.width = width;
            canvas.height = height;
            canvasWidth = width;
            canvasHeight = height;
            canvasRatio = ratio;
        }
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, rect.width, rect.height);
        return rect;
    }

    function redraw() {
        const rect = prepareCanvas();
        const { x = 0, y = 0, zoom = 1 } = state?.canvas || {};
        entries.forEach(({ curve, color }) => {
            if (!curve) return;
            const screenPoints = [curve.start, curve.control1, curve.control2, curve.end]
                .map((point) => ({ x: point.x * zoom + x, y: point.y * zoom + y }));
            const minX = Math.min(...screenPoints.map((point) => point.x));
            const maxX = Math.max(...screenPoints.map((point) => point.x));
            const minY = Math.min(...screenPoints.map((point) => point.y));
            const maxY = Math.max(...screenPoints.map((point) => point.y));
            if (maxX < 0 || minX > rect.width || maxY < 0 || minY > rect.height) return;
            context.beginPath();
            context.moveTo(screenPoints[0].x, screenPoints[0].y);
            context.bezierCurveTo(
                screenPoints[1].x, screenPoints[1].y,
                screenPoints[2].x, screenPoints[2].y,
                screenPoints[3].x, screenPoints[3].y
            );
            context.strokeStyle = color;
            context.lineWidth = 2.5;
            context.stroke();
        });
    }

    function draw(id, curve, color = 'rgba(168, 85, 247, 0.68)') {
        if (!id || !curve?.start || !curve?.control1 || !curve?.control2 || !curve?.end) return;
        entries.set(id, { curve, color });
    }

    function remove(id) {
        entries.delete(id);
    }

    const schedulePanRedraw = () => {
        if (redrawFrame !== null) return;
        redrawFrame = windowRef.requestAnimationFrame(() => {
            redrawFrame = null;
            redraw();
        });
    };
    documentRef.addEventListener('cainflow:canvas-transform', redraw);
    documentRef.addEventListener('cainflow:canvas-pan-transform', schedulePanRedraw);

    function end() {
        redraw();
    }

    function destroy() {
        documentRef.removeEventListener('cainflow:canvas-transform', redraw);
        documentRef.removeEventListener('cainflow:canvas-pan-transform', schedulePanRedraw);
        if (redrawFrame !== null) windowRef.cancelAnimationFrame(redrawFrame);
        redrawFrame = null;
        entries.clear();
        canvas.remove();
    }

    return { enabled: true, begin() { entries.clear(); }, destroy, draw, remove, end };
}
