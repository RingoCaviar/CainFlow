import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasConnectionRenderer } from '../js/canvas/canvas-connection-renderer.js';

function createHarness(search = '?canvasConnections=1', { width = 100, height = 100, contextAvailable = true } = {}) {
    const operations = [];
    const events = new EventTarget();
    let contextLost = false;
    let notifySize;
    const context = {
        setTransform() {}, clearRect() { operations.push('clear'); }, beginPath() { operations.push('begin'); },
        moveTo() {}, bezierCurveTo() { operations.push('curve'); }, stroke() { operations.push('stroke'); },
        isContextLost() { return contextLost; },
        set strokeStyle(value) {}, set lineWidth(value) {}
    };
    const canvas = {
        className: '', width: 0, height: 0, style: {},
        getContext() { return contextAvailable ? context : null; },
        addEventListener: events.addEventListener.bind(events)
    };
    const documentRef = {
        createElement() { return canvas; }
    };
    const classes = new Set();
    const canvasContainer = {
        prepend() {},
        classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } },
        getBoundingClientRect() { return { width, height }; }
    };
    const windowRef = {
        location: { search }, document: documentRef, devicePixelRatio: 1,
        ResizeObserver: class {
            constructor(callback) { notifySize = callback; }
            observe() {}
        },
        getComputedStyle() { return { stroke: 'rgb(120, 50, 220)' }; }
    };
    const state = { canvas: { x: 0, y: 0, zoom: 1 } };
    const renderer = createCanvasConnectionRenderer({
        canvasContainer, documentRef, state, windowRef
    });
    return {
        renderer, operations, canvas, classes, state,
        setPixelRatio(value) { windowRef.devicePixelRatio = value; },
        resize(width, height) { notifySize([{ contentRect: { width, height } }]); },
        loseContext() { contextLost = true; events.dispatchEvent(new Event('contextlost')); },
        restoreContext() { contextLost = false; }
    };
}

const flags = '?perf=1&canvasConnections=1';
const curve = {
    start: { x: 0, y: 0 }, control1: { x: 15, y: 0 },
    control2: { x: 35, y: 50 }, end: { x: 50, y: 50 }
};

test('the bitmap remains unavailable without both development flags', () => {
    const harness = createHarness();
    harness.renderer.draw('visible', curve);
    assert.equal(harness.renderer.enabled, false);
    assert.equal(harness.operations.includes('stroke'), false);
});

test('panning and small zoom changes reuse the bitmap and restore SVG when the gesture ends', () => {
    const { renderer, state, canvas, operations, classes } = createHarness(flags);
    assert.equal(renderer.enabled, true);
    renderer.begin();
    renderer.draw('visible', curve);
    renderer.end();
    assert.equal(operations.filter(operation => operation === 'stroke').length, 1);
    const initialRaster = operations.length;
    state.canvas.x = 15;
    renderer.updateViewport(true);
    assert.ok(classes.has('canvas-connection-bitmap-active'));
    assert.match(canvas.style.transform, /^translate\(/);
    const panned = canvas.style.transform;
    state.canvas.zoom = 1.05;
    renderer.updateViewport(true);
    assert.notEqual(canvas.style.transform, panned);
    assert.match(canvas.style.transform, /scale\(1\.05\)/);
    assert.equal(operations.length, initialRaster);
    renderer.updateViewport(false);
    assert.equal(classes.has('canvas-connection-bitmap-active'), false);
});

test('crossing the cached bounds or zoom threshold redraws exactly once per crossing', () => {
    const { renderer, state, operations } = createHarness(flags);
    const countClears = () => operations.filter(operation => operation === 'clear').length;
    renderer.draw('visible', curve);
    renderer.end();
    assert.equal(countClears(), 1);
    state.canvas.x = -60;
    renderer.updateViewport(true);
    renderer.updateViewport(true);
    assert.equal(countClears(), 2);
    state.canvas.zoom = 1.2;
    renderer.updateViewport(true);
    renderer.updateViewport(true);
    assert.equal(countClears(), 3);
});

test('publishing unchanged connection geometry keeps the active raster while a changed route replaces it', () => {
    const { renderer, operations, classes, canvas } = createHarness(flags);
    const publish = geometry => {
        renderer.begin();
        renderer.draw('edge', geometry);
        renderer.end();
    };
    publish(curve);
    renderer.updateViewport(true);
    publish(structuredClone(curve));
    assert.equal(operations.filter(operation => operation === 'stroke').length, 1);
    assert.equal(classes.has('canvas-connection-bitmap-active'), true);

    publish({ ...curve, end: { x: 60, y: 50 } });
    assert.equal(operations.filter(operation => operation === 'stroke').length, 2);
    assert.equal(classes.has('canvas-connection-bitmap-active'), true);

    renderer.begin();
    renderer.end();
    assert.equal(classes.has('canvas-connection-bitmap-active'), false);
    assert.equal(canvas.width * canvas.height, 0);
});

test('insufficient bitmap budget, missing context and disabling acceleration preserve SVG', () => {
    const svg = createHarness(flags, { contextAvailable: false });
    assert.equal(svg.renderer.enabled, false);
    assert.ok(svg.renderer.requestCoverage());
    assert.equal(svg.renderer.requestCoverage(), null);
    svg.state.canvas.x = -60;
    assert.ok(svg.renderer.requestCoverage(), 'the SVG fallback can request geometry across the raster margin');
    const large = createHarness(flags, { width: 4000, height: 3000 });
    large.renderer.draw('visible', curve);
    large.renderer.end();
    large.renderer.updateViewport(true);
    assert.equal(large.operations.length, 0);
    assert.equal(large.classes.has('canvas-connection-bitmap-active'), false);

    const { renderer, state, classes } = createHarness(flags);
    renderer.draw('visible', curve);
    renderer.end();
    renderer.updateViewport(true);
    assert.ok(classes.has('canvas-connection-bitmap-active'));
    state.canvasGpuAccelerationEnabled = false;
    renderer.updateViewport(true);
    assert.equal(classes.has('canvas-connection-bitmap-active'), false);
});

test('resize and DPR changes rebuild the raster within the backing-store budget', () => {
    const { renderer, operations, canvas, classes, resize, setPixelRatio } = createHarness(flags);
    renderer.draw('edge', curve);
    renderer.end();
    renderer.updateViewport(true);
    const initialWidth = canvas.width;
    setPixelRatio(2);
    renderer.updateViewport(true);
    assert.equal(canvas.width, initialWidth * 2);
    resize(1364, 861);
    assert.equal(classes.has('canvas-connection-bitmap-active'), false);
    renderer.updateViewport(true);
    assert.equal(operations.filter(operation => operation === 'stroke').length, 3);
    assert.ok(canvas.width * canvas.height <= 6_000_000);
    assert.equal(classes.has('canvas-connection-bitmap-active'), true);
});

test('a lost bitmap context immediately shows SVG and restores only after rasterizing again', () => {
    const harness = createHarness(flags);
    const { renderer, operations, classes } = harness;
    renderer.draw('visible', curve);
    renderer.end();
    renderer.updateViewport(true);
    assert.ok(classes.has('canvas-connection-bitmap-active'));
    harness.loseContext();
    assert.equal(classes.has('canvas-connection-bitmap-active'), false);
    renderer.updateViewport(true);
    assert.equal(operations.filter(operation => operation === 'stroke').length, 1);
    harness.restoreContext();
    renderer.updateViewport(true);
    assert.equal(operations.filter(operation => operation === 'stroke').length, 2);
    assert.ok(classes.has('canvas-connection-bitmap-active'));
});
