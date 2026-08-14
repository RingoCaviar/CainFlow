import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasInteractionsApi } from '../js/canvas/canvas-interactions.js';

function createClassList() {
    return { add() {}, remove() {}, contains() { return false; } };
}

function createHarness() {
    const canvasListeners = [];
    const windowListeners = [];
    const canvasContainer = {
        addEventListener(type, listener, options) { canvasListeners.push({ type, listener, options }); },
        classList: createClassList(),
        style: {},
        focus() {},
        getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
    };
    const documentRef = {
        activeElement: null,
        body: { classList: createClassList() },
        getElementById(id) {
            return id === 'connections-group'
                ? { classList: createClassList() }
                : { classList: createClassList(), style: {} };
        }
    };
    const state = {
        canvas: { x: 10, y: 20, zoom: 1, isPanning: false },
        isSpacePressed: true,
        nodes: new Map([['node-1', { x: 50, y: 60 }]]), selectedNodes: new Set(), connections: [], dragging: null
    };
    const api = createCanvasInteractionsApi({
        state, canvasContainer, nodesLayer: {}, tempConnection: {},
        viewportApi: { screenToCanvas: (x, y) => ({ x, y }), updateCanvasTransform() {} },
        getPortPosition() {}, drawTempConnection() {}, updateAllConnections() {}, updatePortStyles() {},
        scheduleSave() {}, serializeOneNode() {}, addNode() {}, checkLineIntersection() {},
        getConnectionSamplePoints() { return []; }, documentRef,
        windowRef: {
            addEventListener(type, listener) { windowListeners.push({ type, listener }); },
            getSelection() { return { removeAllRanges() {} }; },
            performance: { now() { return 100; } }
        },
        requestAnimationFrameRef(callback) { callback(); }
    });
    api.initCanvasInteractions();
    return { canvasListeners, windowListeners, state };
}

test('space plus left press on a node starts panning before node handlers can run', () => {
    const { canvasListeners, windowListeners, state } = createHarness();
    let nodeMouseDowns = 0;
    const event = {
        button: 0, clientX: 100, clientY: 200, target: { closest(selector) { return selector === '.node' ? {} : null; } },
        preventDefault() {}, stopPropagation() { this.propagationStopped = true; }
    };
    const listener = canvasListeners.find(({ type }) => type === 'mousedown');

    const isCapturing = listener.options === true || listener.options?.capture;
    if (isCapturing) listener.listener(event);
    if (!event.propagationStopped) nodeMouseDowns++;
    if (!event.propagationStopped && !isCapturing) listener.listener(event);

    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 130, clientY: 240 });

    assert.equal(state.canvas.isPanning, true);
    assert.deepEqual({ x: state.canvas.x, y: state.canvas.y }, { x: 40, y: 60 });
    assert.deepEqual({ x: state.nodes.get('node-1').x, y: state.nodes.get('node-1').y }, { x: 50, y: 60 });
    assert.equal(state.dragging, null);
    assert.equal(nodeMouseDowns, 0);
});

test('space pan blocks the parameter click dispatched after mousedown', () => {
    const { canvasListeners } = createHarness();
    let parameterClickCount = 0;
    const clickEvent = {
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; }
    };
    const clickListener = canvasListeners.find(({ type, options }) => type === 'click' && (options === true || options?.capture));

    clickListener.listener(clickEvent);
    if (!clickEvent.propagationStopped) parameterClickCount += 1;

    assert.equal(clickEvent.defaultPrevented, true);
    assert.equal(parameterClickCount, 0);
});
