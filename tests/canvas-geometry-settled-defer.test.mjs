import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CANVAS_GEOMETRY_SETTLED_EVENT,
    notifyCanvasGeometrySettled
} from '../js/canvas/canvas-geometry-settled.js';
import { createNodeLifecycleApi } from '../js/nodes/node-lifecycle.js';

function createDispatchRecorder() {
    const dispatched = [];
    return {
        dispatched,
        documentRef: {
            dispatchEvent(event) {
                dispatched.push(event.type);
                return true;
            }
        }
    };
}

test('the settle signal only fires once the viewport stopped moving', () => {
    const { dispatched, documentRef } = createDispatchRecorder();

    assert.equal(notifyCanvasGeometrySettled({ canvas: { isPanning: true } }, documentRef), false);
    assert.equal(notifyCanvasGeometrySettled({ canvas: { isPanning: false }, isInteracting: true }, documentRef), false);
    assert.deepEqual(dispatched, []);

    assert.equal(notifyCanvasGeometrySettled({ canvas: { isPanning: false }, isInteracting: false }, documentRef), true);
    assert.deepEqual(dispatched, [CANVAS_GEOMETRY_SETTLED_EVENT]);
});

function createCountingNode() {
    let reads = 0;
    const element = {
        style: { width: '', height: '' },
        classList: { contains: (name) => name === 'image-first-card', add() {}, remove() {}, toggle() {} },
        querySelector: () => null,
        querySelectorAll: () => [],
        contains: () => false,
        get offsetWidth() { reads += 1; return 100; },
        get offsetHeight() { reads += 1; return 100; }
    };
    const node = {
        id: 'style-1',
        type: 'VisualStyle',
        el: element,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        data: {}
    };
    return { node, element, reads: () => reads };
}

function createLifecycleFixture(state) {
    const listeners = new Map();
    const documentRef = {
        defaultView: {
            setTimeout: (callback) => { callback(); return 0; },
            clearTimeout() {},
            requestAnimationFrame: (callback) => { callback(); return 0; }
        },
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        removeEventListener(type) {
            listeners.delete(type);
        }
    };
    const lifecycle = createNodeLifecycleApi({
        state,
        nodeConfigs: {
            VisualStyle: { defaultWidth: 280, minWidth: 240, minHeight: 160, contentSized: false }
        },
        pushHistory: () => {},
        scheduleSave: () => {},
        showToast: () => {},
        updateAllConnections: () => {},
        updatePortStyles: () => {},
        getCacheSidebarActive: () => false,
        updateCacheUsage: () => {},
        documentRef
    });
    return { lifecycle, listeners };
}

test('node content fits read no geometry while the viewport is panning', () => {
    const { node, element, reads } = createCountingNode();
    const state = { nodes: new Map([[node.id, node]]), canvas: { isPanning: true }, isInteracting: false };
    const { lifecycle, listeners } = createLifecycleFixture(state);

    lifecycle.fitNodeToContent(node.id);
    lifecycle.enforceNodeContentMinimum(node.id);
    lifecycle.ensureNodeContentVisible?.(node.id);

    assert.equal(reads(), 0, 'a moving viewport must not measure node geometry');
    assert.equal(element.style.width, '', 'deferred work must not resize the node');
    assert.equal(typeof listeners.get(CANVAS_GEOMETRY_SETTLED_EVENT), 'function');

    state.canvas.isPanning = false;
    node.width = 100;
    node.height = 80;
    listeners.get(CANVAS_GEOMETRY_SETTLED_EVENT)();

    assert.ok(reads() > 0, 'the settled viewport finally fits the deferred node once');
    assert.equal(element.style.width, '240px');
    assert.equal(element.style.height, '160px');
});

test('node content fits keep running when nothing is moving', () => {
    const { node, element, reads } = createCountingNode();
    const state = { nodes: new Map([[node.id, node]]), canvas: { isPanning: false }, isInteracting: false };
    const { lifecycle } = createLifecycleFixture(state);

    lifecycle.fitNodeToContent(node.id);

    assert.ok(reads() > 0);
    assert.equal(element.style.width, '240px');
    assert.equal(element.style.height, '160px');
});
