import assert from 'node:assert/strict';
import test from 'node:test';

import { createToolbarControllerApi } from '../js/features/ui/toolbar-controller.js';

function makeToolbar(nodes, selectedIds = [], documentRef = { getElementById: () => null, body: { classList: { contains: () => false } } }) {
    const state = {
        nodes: new Map(nodes.map((node) => [node.id, node])),
        selectedNodes: new Set(selectedIds),
        canvas: { x: 0, y: 0, zoom: 1 }
    };
    let updates = 0;
    const toolbar = createToolbarControllerApi({
        state,
        canvasContainer: { clientWidth: 1200, clientHeight: 800 },
        viewportApi: { updateCanvasTransform() { updates += 1; } },
        confirmRef: () => true,
        documentRef
    });
    return { state, toolbar, get updates() { return updates; } };
}

function node(id, x, y) {
    return { id, x, y, el: { offsetWidth: 240, offsetHeight: 160 } };
}

test('F focus makes a single selected node large enough to inspect', () => {
    const view = makeToolbar([node('first', 100, 200), node('other', 700, 200)], ['first']);
    view.toolbar.zoomToFit();
    assert.equal(view.state.canvas.zoom, 2);
    assert.equal(view.state.canvas.x, 160);
    assert.equal(view.state.canvas.y, -160);
    assert.equal(view.updates, 1);
});

test('F focus still keeps a multi-node selection within the viewport', () => {
    const view = makeToolbar([node('first', 100, 200), node('other', 700, 200)], ['first', 'other']);
    view.toolbar.zoomToFit();
    assert.equal(view.state.canvas.zoom, 1.2);
    assert.equal(view.updates, 1);
});

test('F focus uses full canvas width and keeps a pinned unified toolbar clear', () => {
    const toolbar = { offsetHeight: 64, matches: () => false, querySelector: () => null };
    const view = makeToolbar([node('first', 100, 200)], ['first'], {
        getElementById: id => id === 'toolbar' ? toolbar : null,
        body: { classList: { contains: name => name === 'toolbar-pinned' || name === 'sidebar-pinned' } }
    });
    view.toolbar.zoomToFit();
    assert.equal(view.state.canvas.zoom, 2);
    assert.equal(view.state.canvas.x, 160);
    assert.equal(view.state.canvas.y, -124);
});
