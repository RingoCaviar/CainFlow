export function createCanvasConnectionRenderer({ canvasContainer, documentRef = document, state, windowRef = window } = {}) {
    const enabled = new URLSearchParams(windowRef.location?.search || '').get('canvasConnections') === '1';
    if (!enabled || !canvasContainer) return { enabled: false, begin() {}, draw() {}, end() {} };

    const canvas = windowRef.document.createElement('canvas');
    canvas.className = 'canvas-connections';
    canvasContainer.prepend(canvas);
    const context = canvas.getContext('2d');
    const entries = new Map();

    function prepareCanvas() {
        const rect = canvasContainer.getBoundingClientRect();
        const ratio = windowRef.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(rect.width * ratio));
        canvas.height = Math.max(1, Math.round(rect.height * ratio));
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, rect.width, rect.height);
    }

    function redraw() {
        prepareCanvas();
        const { x = 0, y = 0, zoom = 1 } = state?.canvas || {};
        entries.forEach(({ points, color }) => {
            if (!points?.length) return;
            context.beginPath();
            context.moveTo(points[0].x * zoom + x, points[0].y * zoom + y);
            points.slice(1).forEach((point) => context.lineTo(point.x * zoom + x, point.y * zoom + y));
            context.strokeStyle = color;
            context.lineWidth = 2.5;
            context.stroke();
        });
    }

    function draw(id, points, color = 'rgba(168, 85, 247, 0.68)') {
        if (!id || !points?.length) return;
        entries.set(id, { points, color });
    }

    function remove(id) {
        entries.delete(id);
    }

    documentRef.addEventListener('cainflow:canvas-transform', redraw);

    function end() {
        redraw();
    }

    return { enabled: true, begin() { entries.clear(); }, draw, remove, end };
}
