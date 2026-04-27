/**
 * 提供图片绘制与编辑器能力，负责画布绘制、结果回写与图片覆盖保存。
 */
export function createImagePainterApi({
    state,
    dirHandles,
    autoSaveToDir,
    scheduleSave,
    showToast,
    documentRef = document,
    windowRef = window,
    requestAnimationFrameRef = requestAnimationFrame
}) {
    function openImagePainter(src, nodeId) {
        const overlay = documentRef.createElement('div');
        overlay.className = 'painter-overlay';
        overlay.innerHTML = `
        <div class="painter-header">
            <h2>图片编辑器 - 绘制功能</h2>
            <div style="display: flex; gap: 10px; align-items: center;">
                <div class="painter-btn painter-btn-undo" id="painter-undo" title="撤回 (Ctrl+Z)" disabled>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
                </div>
                <div style="width: 1px; height: 24px; background: rgba(255,255,255,0.1); margin: 0 5px;"></div>
                <div class="painter-btn painter-btn-save" id="painter-save" title="应用并保存 (S)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div class="painter-btn painter-btn-cancel" id="painter-cancel" title="取消并退出 (Esc)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </div>
            </div>
        </div>
        <div class="painter-body">
            <div class="painter-toolbar-left">
                <div class="painter-tool-btn active" data-tool="pen" title="自由绘制 (P)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </div>
                <div class="painter-tool-btn" data-tool="line" title="绘制直线 (L)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"/></svg>
                </div>
                <div class="painter-tool-btn" data-tool="arrow" title="绘制箭头 (A)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="12 5 19 5 19 12"/></svg>
                </div>
                <div class="painter-tool-btn" data-tool="rect" title="绘制矩形 (R)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
                </div>
                <div class="painter-tool-btn" data-tool="circle" title="绘制圆形 (C)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>
                </div>
                <div class="painter-size-control" title="画笔大小">
                    <div class="painter-size-preview" id="painter-size-preview"></div>
                    <input type="range" id="painter-size-slider" class="painter-size-slider" min="1" max="32" value="4" aria-label="画笔大小">
                    <div class="painter-size-value" id="painter-size-value">4</div>
                </div>
                <div class="painter-colors">
                    <div class="painter-color-swatch active" data-color="#22d3ee" style="background: #22d3ee;"></div>
                    <div class="painter-color-swatch" data-color="#ef4444" style="background: #ef4444;"></div>
                    <div class="painter-color-swatch" data-color="#10b981" style="background: #10b981;"></div>
                    <div class="painter-color-swatch" data-color="#f59e0b" style="background: #f59e0b;"></div>
                    <div class="painter-color-swatch" data-color="#ffffff" style="background: #ffffff;"></div>
                    <div class="painter-color-swatch" data-color="#000000" style="background: #000000;"></div>
                    <div class="painter-color-swatch painter-color-custom-btn" id="painter-custom-color" title="自定义颜色"></div>
                </div>

                <div class="painter-color-panel" id="color-picker-panel">
                    <div class="painter-hue-wrapper">
                        <canvas id="hue-wheel" class="painter-hue-canvas"></canvas>
                    </div>
                    <div class="painter-hsb-controls">
                        <div class="hsb-slider-group">
                            <label>饱和度 (S) <span id="s-val">100%</span></label>
                            <input type="range" id="s-slider" class="hsb-slider" min="0" max="100" value="100">
                        </div>
                        <div class="hsb-slider-group">
                            <label>亮度 (B) <span id="b-val">100%</span></label>
                            <input type="range" id="b-slider" class="hsb-slider" min="0" max="100" value="100">
                        </div>
                        <div class="painter-color-preview-row">
                            <div class="color-preview-box" id="color-preview"></div>
                            <input type="text" class="color-hex-input" id="color-hex" value="#22d3ee" readonly>
                        </div>
                    </div>
                </div>
            </div>
            <div class="painter-canvas-container">
                <canvas id="painter-canvas"></canvas>
            </div>
        </div>`;

        documentRef.body.appendChild(overlay);
        const canvas = overlay.querySelector('#painter-canvas');
        const ctx = canvas.getContext('2d');
        const container = overlay.querySelector('.painter-canvas-container');
        const undoBtn = overlay.querySelector('#painter-undo');

        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = src;

        let scale = 1;
        let offsetX = 0;
        let offsetY = 0;
        let currentTool = 'pen';
        let currentColor = '#22d3ee';
        let currentStrokeWidth = 4;
        let isDrawing = false;
        let isPanning = false;
        let startPan = { x: 0, y: 0 };
        let shapes = [];
        let currentShape = null;
        const sizeSlider = overlay.querySelector('#painter-size-slider');
        const sizeValue = overlay.querySelector('#painter-size-value');
        const sizePreview = overlay.querySelector('#painter-size-preview');

        function updateStrokeSize(value) {
            currentStrokeWidth = Math.max(1, Math.min(32, parseInt(value, 10) || 4));
            sizeSlider.value = String(currentStrokeWidth);
            sizeValue.textContent = String(currentStrokeWidth);
            const previewSize = Math.max(4, Math.min(24, currentStrokeWidth));
            sizePreview.style.width = `${previewSize}px`;
            sizePreview.style.height = `${previewSize}px`;
        }

        function resetView() {
            const rect = container.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
                requestAnimationFrameRef(resetView);
                return;
            }
            const padding = 100;
            const nextScale = Math.min((rect.width - padding) / img.width, (rect.height - padding) / img.height);
            scale = nextScale;
            offsetX = (rect.width - img.width * scale) / 2;
            offsetY = (rect.height - img.height * scale) / 2;
            render();
        }

        img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            requestAnimationFrameRef(() => {
                resetView();
                setTimeout(resetView, 100);
            });
        };

        function onResize() {
            if (documentRef.body.contains(overlay)) resetView();
        }

        windowRef.addEventListener('resize', onResize);

        function render() {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);

            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            shapes.forEach((shape) => drawShape(shape));
            if (currentShape) drawShape(currentShape);

            canvas.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
            canvas.style.transformOrigin = '0 0';
            undoBtn.disabled = shapes.length === 0;
        }

        function drawShape(shape) {
            ctx.beginPath();
            ctx.strokeStyle = shape.color || currentColor;
            ctx.lineWidth = shape.strokeWidth || 4;

            if (shape.type === 'pen') {
                if (shape.points.length < 2) return;
                ctx.moveTo(shape.points[0].x, shape.points[0].y);
                for (let i = 1; i < shape.points.length; i++) ctx.lineTo(shape.points[i].x, shape.points[i].y);
                ctx.stroke();
            } else if (shape.type === 'line') {
                ctx.moveTo(shape.start.x, shape.start.y);
                ctx.lineTo(shape.end.x, shape.end.y);
                ctx.stroke();
            } else if (shape.type === 'arrow') {
                const h = 20;
                const a = Math.atan2(shape.end.y - shape.start.y, shape.end.x - shape.start.x);
                ctx.moveTo(shape.start.x, shape.start.y);
                ctx.lineTo(shape.end.x, shape.end.y);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(shape.end.x, shape.end.y);
                ctx.lineTo(shape.end.x - h * Math.cos(a - Math.PI / 6), shape.end.y - h * Math.sin(a - Math.PI / 6));
                ctx.moveTo(shape.end.x, shape.end.y);
                ctx.lineTo(shape.end.x - h * Math.cos(a + Math.PI / 6), shape.end.y - h * Math.sin(a + Math.PI / 6));
                ctx.stroke();
            } else if (shape.type === 'rect') {
                ctx.strokeRect(shape.start.x, shape.start.y, shape.end.x - shape.start.x, shape.end.y - shape.start.y);
            } else if (shape.type === 'circle') {
                const r = Math.sqrt(Math.pow(shape.end.x - shape.start.x, 2) + Math.pow(shape.end.y - shape.start.y, 2));
                ctx.arc(shape.start.x, shape.start.y, r, 0, 2 * Math.PI);
                ctx.stroke();
            }
        }

        let hsb_h = 190;
        let hsb_s = 85;
        let hsb_b = 93;
        const pickerPanel = overlay.querySelector('#color-picker-panel');
        const hueWheel = overlay.querySelector('#hue-wheel');
        const sSlider = overlay.querySelector('#s-slider');
        const bSlider = overlay.querySelector('#b-slider');
        const previewBox = overlay.querySelector('#color-preview');
        const hexInput = overlay.querySelector('#color-hex');
        const customSwatch = overlay.querySelector('#painter-custom-color');

        function hsbToHex(h, s, b) {
            b /= 100;
            s /= 100;
            const k = (n) => (n + h / 60) % 6;
            const f = (n) => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
            const toHex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
            return `#${toHex(f(5))}${toHex(f(3))}${toHex(f(1))}`;
        }

        function updateColorFromHSB() {
            const hex = hsbToHex(hsb_h, hsb_s, hsb_b);
            currentColor = hex;
            previewBox.style.background = hex;
            hexInput.value = hex.toUpperCase();
            customSwatch.style.background = hex;
            overlay.querySelectorAll('.painter-color-swatch').forEach((swatch) => swatch.classList.remove('active'));
            customSwatch.classList.add('active');

            overlay.querySelector('#s-val').textContent = `${Math.round(hsb_s)}%`;
            overlay.querySelector('#b-val').textContent = `${Math.round(hsb_b)}%`;
            render();
        }

        function initHueWheel() {
            hueWheel.width = 160;
            hueWheel.height = 160;
            const hctx = hueWheel.getContext('2d');
            const cx = 80;
            const cy = 80;
            const r = 70;

            for (let angle = 0; angle < 360; angle++) {
                const start = (angle * Math.PI) / 180;
                const end = ((angle + 2) * Math.PI) / 180;
                hctx.beginPath();
                hctx.moveTo(cx, cy);
                hctx.arc(cx, cy, r, start, end);
                hctx.fillStyle = `hsl(${angle}, 100%, 50%)`;
                hctx.fill();
            }

            hctx.beginPath();
            hctx.arc(cx, cy, r - 15, 0, Math.PI * 2);
            hctx.fillStyle = 'rgba(30, 41, 59, 1)';
            hctx.fill();
        }

        hueWheel.addEventListener('mousedown', (e) => {
            const pick = (ev) => {
                const rect = hueWheel.getBoundingClientRect();
                const x = ev.clientX - rect.left - 80;
                const y = ev.clientY - rect.top - 80;
                hsb_h = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
                updateColorFromHSB();
            };
            const onMove = (ev) => pick(ev);
            const onUp = () => {
                windowRef.removeEventListener('mousemove', onMove);
                windowRef.removeEventListener('mouseup', onUp);
            };
            windowRef.addEventListener('mousemove', onMove);
            windowRef.addEventListener('mouseup', onUp);
            pick(e);
        });

        sSlider.addEventListener('input', (e) => {
            hsb_s = parseInt(e.target.value, 10);
            updateColorFromHSB();
        });
        bSlider.addEventListener('input', (e) => {
            hsb_b = parseInt(e.target.value, 10);
            updateColorFromHSB();
        });

        customSwatch.addEventListener('click', (e) => {
            e.stopPropagation();
            pickerPanel.classList.toggle('active');
            if (pickerPanel.classList.contains('active')) {
                initHueWheel();
                updateColorFromHSB();
            }
        });

        overlay.addEventListener('click', (e) => {
            if (!pickerPanel.contains(e.target) && e.target !== customSwatch) {
                pickerPanel.classList.remove('active');
            }
        });

        function getPos(e) {
            const rect = canvas.getBoundingClientRect();
            return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
        }

        const onWheel = (e) => {
            e.preventDefault();
            const nz = Math.max(0.05, Math.min(50, scale * (e.deltaY > 0 ? 0.9 : 1.1)));
            const rect = container.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            offsetX = cx - (cx - offsetX) * (nz / scale);
            offsetY = cy - (cy - offsetY) * (nz / scale);
            scale = nz;
            render();
        };

        const onMouseDown = (e) => {
            if (e.button === 1 || (e.button === 0 && e.altKey)) {
                isPanning = true;
                startPan = { x: e.clientX - offsetX, y: e.clientY - offsetY };
                container.style.cursor = 'grabbing';
                return;
            }
            if (e.button === 0) {
                isDrawing = true;
                const p = getPos(e);
                currentShape = currentTool === 'pen'
                    ? { type: 'pen', points: [p], color: currentColor, strokeWidth: currentStrokeWidth }
                    : { type: currentTool, start: p, end: p, color: currentColor, strokeWidth: currentStrokeWidth };
            }
        };

        const onMouseMove = (e) => {
            if (isPanning) {
                offsetX = e.clientX - startPan.x;
                offsetY = e.clientY - startPan.y;
                render();
            } else if (isDrawing) {
                const p = getPos(e);
                if (currentTool === 'pen') currentShape.points.push(p);
                else currentShape.end = p;
                render();
            }
        };

        const onMouseUp = () => {
            if (isPanning) {
                isPanning = false;
                container.style.cursor = 'crosshair';
            } else if (isDrawing) {
                isDrawing = false;
                if (currentShape) {
                    shapes.push(currentShape);
                    if (shapes.length > 20) shapes.shift();
                }
                currentShape = null;
                render();
            }
        };

        overlay.addEventListener('wheel', onWheel, { passive: false });
        container.addEventListener('mousedown', onMouseDown);
        windowRef.addEventListener('mousemove', onMouseMove);
        windowRef.addEventListener('mouseup', onMouseUp);

        overlay.querySelectorAll('.painter-tool-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                overlay.querySelectorAll('.painter-tool-btn').forEach((button) => button.classList.remove('active'));
                btn.classList.add('active');
                currentTool = btn.dataset.tool;
            });
        });

        overlay.querySelectorAll('.painter-color-swatch:not(.painter-color-custom-btn)').forEach((swatch) => {
            swatch.addEventListener('click', () => {
                overlay.querySelectorAll('.painter-color-swatch').forEach((item) => item.classList.remove('active'));
                swatch.classList.add('active');
                currentColor = swatch.dataset.color;
                pickerPanel.classList.remove('active');
            });
        });

        sizeSlider.addEventListener('input', (e) => {
            updateStrokeSize(e.target.value);
        });
        updateStrokeSize(currentStrokeWidth);

        function undo() {
            if (shapes.length > 0) {
                shapes.pop();
                render();
            }
        }

        function cleanup() {
            overlay.classList.remove('active');
            setTimeout(() => overlay.remove(), 300);
            windowRef.removeEventListener('mousemove', onMouseMove);
            windowRef.removeEventListener('mouseup', onMouseUp);
            windowRef.removeEventListener('resize', onResize);
            documentRef.removeEventListener('keydown', onKey);
        }

        async function save() {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            shapes.forEach((shape) => drawShape(shape));

            const data = canvas.toDataURL('image/png');
            const node = state.nodes.get(nodeId);
            if (node) {
                if (node.imageData !== undefined) {
                    node.imageData = data;
                    const dropZone = node.el.querySelector(`#${nodeId}-drop`);
                    if (dropZone) {
                        dropZone.innerHTML = `<img src="${data}" alt="已导入图片" draggable="false" style="pointer-events: none;" />`;
                    }
                } else if (node.data && node.data.image !== undefined) {
                    node.data.image = data;
                    const nodeImage = node.el.querySelector('img');
                    if (nodeImage) nodeImage.src = data;
                }

                if (node.dirHandle || dirHandles.get(nodeId)) {
                    await autoSaveToDir(nodeId, data);
                }
                scheduleSave();
                showToast('图片已更新', 'success');
            }
            cleanup();
        }

        undoBtn.addEventListener('click', undo);
        overlay.querySelector('#painter-save').addEventListener('click', save);
        overlay.querySelector('#painter-cancel').addEventListener('click', cleanup);

        function onKey(e) {
            if (e.key === 'Escape') cleanup();
            if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
            }
            if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                undo();
            }
            const tools = { p: 'pen', l: 'line', a: 'arrow', r: 'rect', c: 'circle' };
            if (tools[e.key.toLowerCase()]) {
                const tool = tools[e.key.toLowerCase()];
                overlay.querySelectorAll('.painter-tool-btn').forEach((button) => {
                    const active = button.dataset.tool === tool;
                    button.classList.toggle('active', active);
                    if (active) currentTool = tool;
                });
            }
        }

        documentRef.addEventListener('keydown', onKey);
        requestAnimationFrameRef(() => overlay.classList.add('active'));
    }

    return {
        openImagePainter
    };
}
