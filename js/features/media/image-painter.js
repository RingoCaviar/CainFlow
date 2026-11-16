import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';
/**
 * 提供图片绘制与编辑器能力，负责画布绘制、结果回写与图片覆盖保存。
 */
export function createImagePainterApi({
    state,
    dirHandles,
    autoSaveToDir,
    applyEditedImage = async () => false,
    scheduleSave,
    showToast,
    documentRef = document,
    windowRef = window,
    requestAnimationFrameRef = requestAnimationFrame
}) {
    function openImagePainter(src, nodeId) {
        const overlay = documentRef.createElement('div');
        overlay.className = 'painter-overlay';
        documentRef.body?.classList.add('preview-active');
        overlay.innerHTML = `
        <div class="painter-body">
            <div class="painter-toolbar-left" role="group" aria-label="绘制工具与画笔设置">
                <div class="painter-tools">
                    <button type="button" class="painter-tool-btn active" data-tool="pen" title="自由绘制 (P)" aria-label="自由绘制" aria-pressed="true">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                    </button>
                    <button type="button" class="painter-tool-btn" data-tool="line" title="绘制直线 (L)" aria-label="绘制直线" aria-pressed="false">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="5" y1="19" x2="19" y2="5"/></svg>
                    </button>
                    <button type="button" class="painter-tool-btn" data-tool="arrow" title="绘制箭头 (A)" aria-label="绘制箭头" aria-pressed="false">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="12 5 19 5 19 12"/></svg>
                    </button>
                    <button type="button" class="painter-tool-btn" data-tool="rect" title="绘制矩形 (R)" aria-label="绘制矩形" aria-pressed="false">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
                    </button>
                    <button type="button" class="painter-tool-btn" data-tool="circle" title="绘制圆形 (C)" aria-label="绘制圆形" aria-pressed="false">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>
                    </button>
                </div>
                <div class="painter-size-control" title="画笔大小">
                    <div class="painter-size-preview" id="painter-size-preview"></div>
                    <input type="range" id="painter-size-slider" class="painter-size-slider" min="1" max="32" value="4" aria-label="画笔大小">
                    <div class="painter-size-value" id="painter-size-value">4</div>
                </div>
                <div class="painter-colors" role="group" aria-label="画笔颜色">
                    <button type="button" class="painter-color-swatch active" data-color="#22d3ee" style="background: #22d3ee;" aria-label="青色" aria-pressed="true"></button>
                    <button type="button" class="painter-color-swatch" data-color="#ef4444" style="background: #ef4444;" aria-label="红色" aria-pressed="false"></button>
                    <button type="button" class="painter-color-swatch" data-color="#10b981" style="background: #10b981;" aria-label="绿色" aria-pressed="false"></button>
                    <button type="button" class="painter-color-swatch" data-color="#f59e0b" style="background: #f59e0b;" aria-label="橙色" aria-pressed="false"></button>
                    <button type="button" class="painter-color-swatch" data-color="#ffffff" style="background: #ffffff;" aria-label="白色" aria-pressed="false"></button>
                    <button type="button" class="painter-color-swatch" data-color="#000000" style="background: #000000;" aria-label="黑色" aria-pressed="false"></button>
                    <button type="button" class="painter-color-swatch painter-color-custom-btn" id="painter-custom-color" title="自定义颜色" aria-label="自定义颜色" aria-expanded="false" aria-controls="color-picker-panel"></button>
                </div>
            </div>
            <div class="painter-canvas-container">
                <canvas id="painter-canvas"></canvas>
            </div>
            <div class="painter-color-panel" id="color-picker-panel" role="group" aria-label="自定义颜色">
                <canvas id="hue-wheel" class="painter-hue-canvas" role="slider" tabindex="0" aria-label="色相" aria-valuemin="0" aria-valuemax="359" aria-valuenow="190"></canvas>
                <div class="painter-hsb-controls">
                    <div class="hsb-slider-group">
                        <label for="s-slider">饱和度 <span id="s-val">100%</span></label>
                        <input type="range" id="s-slider" class="hsb-slider" min="0" max="100" value="100">
                    </div>
                    <div class="hsb-slider-group">
                        <label for="b-slider">亮度 <span id="b-val">100%</span></label>
                        <input type="range" id="b-slider" class="hsb-slider" min="0" max="100" value="100">
                    </div>
                    <div class="painter-color-preview-row">
                        <div class="color-preview-box" id="color-preview" aria-hidden="true"></div>
                        <input type="text" class="color-hex-input" id="color-hex" aria-label="颜色值" value="#22d3ee" readonly>
                    </div>
                </div>
            </div>
        </div>
        <div class="painter-floating-actions" role="group" aria-label="图片编辑操作">
            <button type="button" class="painter-btn painter-btn-undo" id="painter-undo" title="撤回 (Ctrl+Z)" aria-label="撤回" disabled>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
            </button>
            <button type="button" class="painter-btn painter-btn-save" id="painter-save" title="确认编辑 (Ctrl+S)" aria-label="确认编辑">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            </button>
            <button type="button" class="painter-btn painter-btn-cancel" id="painter-cancel" title="取消并退出 (Esc)" aria-label="取消编辑">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
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
            sizePreview.style.setProperty('--painter-size-preview-scale', String(previewSize / 4));
        }

        function resetView() {
            const rect = container.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
                requestAnimationFrameRef(resetView);
                return;
            }
            const padding = Math.min(100, rect.width * 0.25, rect.height * 0.25);
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
            if (!img.naturalWidth) return;
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
        const swatches = overlay.querySelectorAll('.painter-color-swatch');
        const toolButtons = overlay.querySelectorAll('.painter-tool-btn');

        function selectSwatch(selected) {
            for (const swatch of swatches) {
                swatch.classList.toggle('active', swatch === selected);
                if (swatch !== customSwatch) swatch.setAttribute('aria-pressed', String(swatch === selected));
            }
        }

        function selectTool(tool) {
            currentTool = tool;
            for (const button of toolButtons) {
                const selected = button.dataset.tool === tool;
                button.classList.toggle('active', selected);
                button.setAttribute('aria-pressed', String(selected));
            }
        }

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
            selectSwatch(customSwatch);

            hueWheel.setAttribute('aria-valuenow', String(Math.floor(hsb_h)));
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

            hctx.globalCompositeOperation = 'destination-out';
            hctx.beginPath();
            hctx.arc(cx, cy, r - 15, 0, Math.PI * 2);
            hctx.fill();
            hctx.globalCompositeOperation = 'source-over';
        }

        hueWheel.addEventListener('mousedown', (e) => {
            const pick = (ev) => {
                const rect = hueWheel.getBoundingClientRect();
                const x = ev.clientX - rect.left - rect.width / 2;
                const y = ev.clientY - rect.top - rect.height / 2;
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

        hueWheel.addEventListener('keydown', (event) => {
            const steps = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 15, PageDown: -15 };
            if (event.key === 'Home') hsb_h = 0;
            else if (event.key === 'End') hsb_h = 359;
            else if (Object.hasOwn(steps, event.key)) hsb_h = Math.min(359, Math.max(0, hsb_h + steps[event.key]));
            else return;
            event.preventDefault();
            updateColorFromHSB();
        });

        sSlider.addEventListener('input', (e) => {
            hsb_s = parseInt(e.target.value, 10);
            updateColorFromHSB();
        });
        bSlider.addEventListener('input', (e) => {
            hsb_b = parseInt(e.target.value, 10);
            updateColorFromHSB();
        });

        function setColorPanelOpen(open) {
            pickerPanel.classList.toggle('active', open);
            customSwatch.setAttribute('aria-expanded', String(open));
            if (open) {
                initHueWheel();
                updateColorFromHSB();
            }
        }

        customSwatch.addEventListener('click', (event) => {
            event.stopPropagation();
            const open = !pickerPanel.classList.contains('active');
            setColorPanelOpen(open);
            if (open && event.detail === 0) hueWheel.focus({ preventScroll: true });
        });

        overlay.addEventListener('click', (e) => {
            if (!pickerPanel.contains(e.target) && e.target !== customSwatch) {
                setColorPanelOpen(false);
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

        container.addEventListener('wheel', onWheel, { passive: false });
        container.addEventListener('mousedown', onMouseDown);
        windowRef.addEventListener('mousemove', onMouseMove);
        windowRef.addEventListener('mouseup', onMouseUp);

        for (const button of toolButtons) {
            button.addEventListener('click', () => selectTool(button.dataset.tool));
        }

        for (const swatch of swatches) {
            if (swatch === customSwatch) continue;
            swatch.addEventListener('click', () => {
                selectSwatch(swatch);
                currentColor = swatch.dataset.color;
            });
        }

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
            documentRef.body?.classList.remove('preview-active');
            setTimeout(() => overlay.remove(), 300);
            windowRef.removeEventListener('mousemove', onMouseMove);
            windowRef.removeEventListener('mouseup', onMouseUp);
            windowRef.removeEventListener('resize', onResize);
            documentRef.removeEventListener('keydown', onKey);
        }

        let saving = false;
        async function save() {
            if (saving || !img.complete || !img.naturalWidth) return;
            saving = true;
            try {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0);
                shapes.forEach((shape) => drawShape(shape));

                const data = canvas.toDataURL('image/png');
                const node = state.nodes.get(nodeId);
                if (node?.type === 'ImageSave') {
                    const created = await applyEditedImage({ nodeId, dataUrl: data, node, source: src });
                    if (!created) {
                        showToast('编辑结果未能创建图片导入节点，请重试', 'error');
                        return;
                    }
                    showToast('已创建图片导入节点', 'success');
                    cleanup();
                    return;
                }
                if (node) {
                    const handledByExternalApply = await applyEditedImage({
                        nodeId,
                        dataUrl: data,
                        node,
                        source: src
                    });
                    if (handledByExternalApply) {
                        showToast('图片已更新', 'success');
                    } else if (node.imageData !== undefined) {
                        node.imageData = data;
                        node.imageDataList = [data];
                        node.data = node.data || {};
                        node.data.image = data;
                        node.data.images = [data];
                        const dropZone = node.el.querySelector(`#${nodeId}-drop`);
                        if (dropZone) {
                            dropZone.innerHTML = `<img src="${data}" alt="已导入图片" draggable="false" style="pointer-events: none;" />`;
                        }
                    } else if (node.data && node.data.image !== undefined) {
                        node.data.image = data;
                        node.data.images = [data];
                        node.imageData = data;
                        node.imageDataList = [data];
                        const nodeImage = node.el.querySelector('img');
                        if (nodeImage) nodeImage.src = data;
                    }

                    if (!handledByExternalApply && (node.dirHandle || dirHandles.get(nodeId))) {
                        await autoSaveToDir(nodeId, data);
                    }
                    scheduleSave();
                    if (!handledByExternalApply) {
                        showToast('图片已更新', 'success');
                    }
                }
                cleanup();
            } catch (error) {
                console.warn('Saving edited image failed:', error);
                showToast('保存编辑结果失败，请重试', 'error');
            } finally {
                saving = false;
            }
        }

        undoBtn.addEventListener('click', undo);
        overlay.querySelector('#painter-save').addEventListener('click', save);
        overlay.querySelector('#painter-cancel').addEventListener('click', () => {
            if (!saving) cleanup();
        });

        function onKey(e) {
            const top = getSurfaceCoordinator(documentRef)?.topModal();
            if (top && top !== overlay) return;
            if (e.key === 'Escape' && !saving) {
                if (e.target && pickerPanel.classList.contains('active')) {
                    setColorPanelOpen(false);
                    customSwatch.focus({ preventScroll: true });
                } else cleanup();
                return;
            }
            if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
            }
            if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                undo();
            }
            const tools = { p: 'pen', l: 'line', a: 'arrow', r: 'rect', c: 'circle' };
            const tool = tools[e.key.toLowerCase()];
            if (tool && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target?.matches?.('input')) selectTool(tool);
        }

        documentRef.addEventListener('keydown', onKey);
        getSurfaceCoordinator(documentRef)?.registerEscape(overlay, onKey);
        requestAnimationFrameRef(() => overlay.classList.add('active'));
    }

    return {
        openImagePainter
    };
}
