import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewportApi } from '../js/canvas/viewport.js';

function createHarness({ originLines = [], ResizeObserver } = {}) {
    const calls = [];
    const documentRef = { dispatchEvent() {}, defaultView: { ResizeObserver } };
    const container = {
        ownerDocument: documentRef,
        style: { setProperty() {} },
        clientWidth: 800,
        clientHeight: 600
    };
    const elements = {
        canvasContainer: container,
        nodesLayer: { style: { setProperty() {} } },
        connectionsGroup: { setAttribute() {} },
        originAxes: { setAttribute() {}, querySelectorAll() { return originLines; } },
        zoomLevel: { textContent: '' }
    };
    const canvas = { x: 10, y: 20, zoom: 1 };
    const api = createViewportApi({
        state: { canvas },
        elements,
        updateAllConnections() {},
        scheduleConnectionRefresh(options) { calls.push(options); },
        requestAnimationFrameRef(callback) { callback(); }
    });
    return { api, calls, canvas };
}

test('origin axes paint bounded segments that still span the viewport after a distant pan', () => {
    const makeLine = () => {
        const attributes = new Map();
        return { setAttribute(name, value) { attributes.set(name, Number(value)); }, attributes };
    };
    const horizontal = makeLine();
    const vertical = makeLine();
    const { api, canvas } = createHarness({ originLines: [horizontal, vertical] });
    const update = () => api.applyCanvasVisualTransform({ dispatchTransformEvent: false });
    update();
    const initial = [...horizontal.attributes.values()];
    assert.ok(horizontal.attributes.get('x1') < -canvas.x);
    assert.ok(horizontal.attributes.get('x2') > 800 - canvas.x);
    assert.ok(horizontal.attributes.get('x2') - horizontal.attributes.get('x1') < 10_000);
    canvas.x += 200;
    update();
    assert.deepEqual([...horizontal.attributes.values()], initial, 'a short pan reuses the bounded segment');

    canvas.zoom = 2.5;
    update();
    assert.ok((horizontal.attributes.get('x2') - horizontal.attributes.get('x1')) * canvas.zoom < 10_000);

    canvas.x = 2_000_000;
    canvas.zoom = 0.5;
    update();
    const toScreen = worldX => worldX * canvas.zoom + canvas.x;
    assert.ok(toScreen(horizontal.attributes.get('x1')) <= 0);
    assert.ok(toScreen(horizontal.attributes.get('x2')) >= 800);
    assert.ok(vertical.attributes.get('y1') < -canvas.y / canvas.zoom);
    assert.ok(vertical.attributes.get('y2') > (600 - canvas.y) / canvas.zoom);
});

test('growing the idle canvas extends origin axes without another gesture', () => {
    let resize;
    class ResizeObserver {
        constructor(callback) { resize = callback; }
        observe() {}
    }
    const horizontal = { setAttribute(name, value) { this[name] = Number(value); } };
    const vertical = { setAttribute(name, value) { this[name] = Number(value); } };
    const { api, canvas } = createHarness({ originLines: [horizontal, vertical], ResizeObserver });
    api.applyCanvasVisualTransform({ dispatchTransformEvent: false });
    resize([{ contentRect: { width: 4200, height: 3400 } }]);
    assert.ok(horizontal.x2 * canvas.zoom + canvas.x >= 4200);
    assert.ok(vertical.y2 * canvas.zoom + canvas.y >= 3400);
});

test('settleConnections is explicit and does not depend on reason', () => {
    const { api, calls } = createHarness();
    api.updateCanvasTransform({ connectionRefreshReason: 'pan-settled' });
    assert.equal(calls.at(-1).settle, false);

    api.updateCanvasTransform({ connectionRefreshReason: 'pan-settled', settleConnections: true });
    assert.equal(calls.at(-1).settle, true);
});

test('continuous Canvas zoom reads the themed grid spacing only once', () => {
    const originalGetComputedStyle = globalThis.getComputedStyle;
    let styleReadCount = 0;
    globalThis.getComputedStyle = () => ({
        getPropertyValue(name) {
            assert.equal(name, '--canvas-dot-spacing');
            styleReadCount += 1;
            return '24px';
        }
    });

    try {
        const { api } = createHarness();
        api.applyCanvasVisualTransform({ dispatchTransformEvent: false });
        api.applyCanvasVisualTransform({ dispatchTransformEvent: false });

        assert.equal(styleReadCount, 1);
    } finally {
        globalThis.getComputedStyle = originalGetComputedStyle;
    }
});

test('refreshing Canvas theme metrics reloads the themed grid spacing', () => {
    const originalGetComputedStyle = globalThis.getComputedStyle;
    let themedSpacing = '22px';
    let styleReadCount = 0;
    globalThis.getComputedStyle = () => ({
        getPropertyValue() {
            styleReadCount += 1;
            return themedSpacing;
        }
    });

    try {
        const { api } = createHarness();
        api.applyCanvasVisualTransform({ dispatchTransformEvent: false });
        themedSpacing = '24px';

        api.refreshCanvasThemeMetrics();
        api.applyCanvasVisualTransform({ dispatchTransformEvent: false });

        assert.equal(styleReadCount, 2);
    } finally {
        globalThis.getComputedStyle = originalGetComputedStyle;
    }
});

function createTextRefreshHarness() {
    const canvas = { x: 0, y: 0, zoom: 1 };
    const nodes = new Map();
    const frames = [];
    const measured = [];
    const refreshed = new Set();
    const container = { left: 20, top: 30, right: 820, bottom: 630, width: 800, height: 600 };
    const canvasContainer = { scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => container };
    const api = createViewportApi({
        state: { canvas, nodes },
        elements: {
            canvasContainer,
            nodesLayer: { querySelectorAll: () => [...nodes.values()].map(node => node.el) }
        },
        requestAnimationFrameRef: callback => frames.push(callback)
    });

    function addNode(id, { x, y, width, height = 100, renderedWidth = width }) {
        const el = {
            id,
            classList: { add() { refreshed.add(id); }, remove() { refreshed.delete(id); } },
            getBoundingClientRect() {
                measured.push(id);
                const left = container.left + canvas.x + x * canvas.zoom - canvasContainer.scrollLeft;
                const top = container.top + canvas.y + y * canvas.zoom - canvasContainer.scrollTop;
                return { left, top, right: left + renderedWidth * canvas.zoom, bottom: top + height * canvas.zoom };
            }
        };
        nodes.set(id, { x, y, width, height, el });
    }

    return { api, canvas, canvasContainer, frames, measured, refreshed, addNode };
}

test('text refresh measures only nearby and uncertain cards in a two hundred node workspace', () => {
    const { api, canvas, frames, measured, refreshed, addNode } = createTextRefreshHarness();
    canvas.zoom = 0.5;
    canvas.x = 50;
    const visible = Array.from({ length: 8 }, (_, index) => `visible-${index}`);
    visible.forEach((id, index) => addNode(id, { x: 60 * index, y: 100, width: 120 }));
    addNode('unknown-width', { x: -2000, y: 100, renderedWidth: 2020 });
    addNode('fringe', { x: 1580, y: 100, width: 120 });
    for (let index = 0; index < 190; index += 1) {
        addNode(`far-${index}`, { x: index % 2 === 0 ? -4000 : 4000, y: 100, width: 120 });
    }

    api.refreshNodeTextRendering();

    assert.deepEqual(measured, [...visible, 'unknown-width', 'fringe']);
    assert.deepEqual([...refreshed], [...visible, 'unknown-width']);
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.equal(refreshed.size, 0);
});

test('a card that was offscreen receives text refresh when brought into view', () => {
    const { api, canvas, measured, refreshed, addNode } = createTextRefreshHarness();
    addNode('distant', { x: 4000, y: 120, width: 180 });
    addNode('wide-edge', { x: -470, y: 120, width: 90, renderedWidth: 540 });

    api.refreshNodeTextRendering();
    assert.deepEqual(measured, ['wide-edge']);
    assert.deepEqual([...refreshed], ['wide-edge']);

    canvas.x = -3900;
    api.refreshNodeTextRendering();
    assert.deepEqual(measured, ['wide-edge', 'distant']);
    assert.equal(refreshed.has('distant'), true);
});

test('repeated text refreshes keep the current paint scheduled once', () => {
    const { api, frames, measured, refreshed, addNode } = createTextRefreshHarness();
    addNode('visible', { x: 100, y: 100, width: 120 });

    api.refreshNodeTextRendering();
    api.refreshNodeTextRendering();
    assert.deepEqual(measured, ['visible']);
    assert.deepEqual([...refreshed], ['visible']);
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.equal(refreshed.size, 0);
});

test('text refresh includes cards revealed by native canvas scrolling', () => {
    const { api, canvasContainer, measured, refreshed, addNode } = createTextRefreshHarness();
    addNode('located', { x: 4000, y: 3000, width: 180 });
    canvasContainer.scrollLeft = 3750;
    canvasContainer.scrollTop = 2800;

    api.refreshNodeTextRendering();
    assert.deepEqual(measured, ['located']);
    assert.deepEqual([...refreshed], ['located']);
});
