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

function createHarness({ zoom = 1, nodes = [] } = {}) {
    const documentRef = { addEventListener() {}, removeEventListener() {} };
    const canvasContainer = { classList: classList(), getBoundingClientRect() { return { width: 800, height: 600 }; } };
    const nodesLayer = { addEventListener() {} };
    const state = {
        canvas: { x: 0, y: 0, zoom }, nodes: new Map(nodes), runningNodeIds: new Set(),
        canvasRender: { denseModeOverride: 'auto' }
    };
    const api = createRenderProjectionManager({
        state, canvasContainer, nodesLayer, documentRef, windowRef: {},
        requestAnimationFrameRef: (callback) => { callback(); return 1; }
    });
    return { api, state, canvasContainer };
}

test('offscreen projection preserves the node shell and workflow model', () => {
    const el = { classList: classList(), setAttribute() {} };
    const node = { id: 'n1', x: 5000, y: 0, width: 240, height: 180, el, data: { prompt: 'keep me' } };
    const { api, state } = createHarness({ nodes: [['n1', node]] });
    api.refreshNow();
    assert.equal(el.classList.contains('is-virtualized'), true);
    assert.equal(state.nodes.get('n1').data.prompt, 'keep me');
});

test('compact LOD is reversible and focused node state stays intact', () => {
    const el = { classList: classList(), setAttribute() {} };
    const node = { id: 'n1', x: 0, y: 0, width: 240, height: 180, el, data: { value: 1 } };
    const { api, state } = createHarness({ zoom: 0.2, nodes: [['n1', node]] });
    api.refreshNow();
    assert.equal(el.classList.contains('is-compact-lod'), true);
    api.focusNode('n1');
    assert.equal(el.classList.contains('is-compact-lod'), false);
    assert.deepEqual(state.nodes.get('n1').data, { value: 1 });
});

test('node content remains visible above twenty percent zoom', () => {
    const el = { classList: classList(), setAttribute() {} };
    const node = { id: 'n1', x: 0, y: 0, width: 240, height: 180, el };
    const { api } = createHarness({ zoom: 0.21, nodes: [['n1', node]] });
    api.refreshNow();
    assert.equal(el.classList.contains('is-compact-lod'), false);
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
