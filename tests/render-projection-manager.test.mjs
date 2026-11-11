import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderProjectionManager } from '../js/canvas/render-projection-manager.js';

function classList() {
    const values = new Set();
    return {
        toggle(name, enabled) { enabled ? values.add(name) : values.delete(name); },
        contains(name) { return values.has(name); }
    };
}

function createHarness({ zoom = 1, nodes = [], performanceMonitor } = {}) {
    const documentRef = { addEventListener() {}, removeEventListener() {} };
    const canvasContainer = { classList: classList(), getBoundingClientRect() { return { width: 800, height: 600 }; } };
    const nodesLayer = { addEventListener() {} };
    const state = {
        canvas: { x: 0, y: 0, zoom }, nodes: new Map(nodes), runningNodeIds: new Set(),
        canvasRender: { denseModeOverride: 'auto' }
    };
    const api = createRenderProjectionManager({
        state, canvasContainer, nodesLayer, documentRef, windowRef: {}, performanceMonitor,
        requestAnimationFrameRef: (callback) => { callback(); return 1; }
    });
    return { api, state, canvasContainer };
}

test('unchanged projections perform no attribute or class writes', () => {
    let attributes = 0;
    let classes = 0;
    const list = classList();
    const toggle = list.toggle;
    list.toggle = (...args) => { classes += 1; toggle(...args); };
    const el = { classList: list, setAttribute() { attributes += 1; } };
    const { api, state } = createHarness({ nodes: [['n1', { x: 0, y: 0, el }]] });
    api.refreshNow();
    attributes = 0; classes = 0;
    api.refreshNow();
    assert.equal(attributes, 0);
    assert.equal(classes, 0);
    state.canvas.zoom = 0.2;
    api.refreshNow();
    assert.equal(attributes, 0);
    assert.equal(classes, 0);
});

test('a monitored projection reads the viewport once per refresh', () => {
    const { api, canvasContainer } = createHarness({
        performanceMonitor: { measure(_name, callback) { return callback(); } }
    });
    let reads = 0;
    canvasContainer.getBoundingClientRect = () => {
        reads += 1;
        return { width: 800, height: 600 };
    };
    api.refreshNow();
    assert.equal(reads, 1);
});

test('offscreen projection preserves the node shell and workflow model', () => {
    const el = { classList: classList(), setAttribute() {} };
    const node = { id: 'n1', x: 5000, y: 0, width: 240, height: 180, el, data: { prompt: 'keep me' } };
    const { api, state } = createHarness({ nodes: [['n1', node]] });
    api.refreshNow();
    assert.equal(el.classList.contains('is-virtualized'), true);
    assert.equal(state.nodes.get('n1').data.prompt, 'keep me');
});

test('search can reveal an offscreen node while preserving its state', () => {
    const el = { classList: classList(), setAttribute() {} };
    const node = { id: 'n1', x: 10000, y: 0, width: 240, height: 180, el, data: { value: 1 } };
    const { api, state } = createHarness({ zoom: 0.2, nodes: [['n1', node]] });
    api.refreshNow();
    assert.equal(el.classList.contains('is-virtualized'), true);
    api.focusNode('n1');
    assert.equal(el.classList.contains('is-virtualized'), false);
    assert.deepEqual(state.nodes.get('n1').data, { value: 1 });
});

test('node content remains fully projected at minimum zoom', () => {
    let projection;
    const el = { classList: classList(), setAttribute(_name, value) { projection = value; } };
    const node = { id: 'n1', x: 0, y: 0, width: 240, height: 180, el };
    const { api } = createHarness({ zoom: 0.1, nodes: [['n1', node]] });
    api.refreshNow();
    assert.equal(projection, 'full');
});

test('dense-mode manual override wins over density automation', () => {
    const { api, state, canvasContainer } = createHarness();
    state.canvasRender.denseModeOverride = 'on';
    api.refreshNow();
    assert.equal(canvasContainer.classList.contains('canvas-dense-mode'), true);
    state.canvasRender.denseModeOverride = 'off';
    api.refreshNow();
    assert.equal(canvasContainer.classList.contains('canvas-dense-mode'), false);
});
