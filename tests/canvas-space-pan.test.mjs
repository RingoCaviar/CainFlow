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
    const viewportCalls = [];
    const projectionCalls = [];
    const legacyRefreshCalls = [];
    const api = createCanvasInteractionsApi({
        state, canvasContainer, nodesLayer: {}, tempConnection: { setAttribute() {} },
        viewportApi: {
            screenToCanvas: (x, y) => ({ x, y }),
            updateCanvasTransform(options) { viewportCalls.push(options); },
            refreshNodeTextRendering() {}
        },
        getPortPosition() {}, drawTempConnection() {}, updateAllConnections() {}, updatePortStyles() {},
        scheduleSave() {}, serializeOneNode() {}, addNode() {}, checkLineIntersection() {},
        getConnectionSamplePoints() { return []; }, documentRef,
        scheduleConnectionRefresh(options) { legacyRefreshCalls.push(options); },
        connectionProjection: {
            beginInteraction(kind, nodeIds) {
                projectionCalls.push(['begin', kind, nodeIds]);
                return {
                    changed() { projectionCalls.push(['changed', kind]); },
                    finish() { projectionCalls.push(['finish', kind]); return Promise.resolve(); }
                };
            }
        },
        windowRef: {
            addEventListener(type, listener) { windowListeners.push({ type, listener }); },
            getSelection() { return { removeAllRanges() {} }; },
            performance: { now() { return 100; } }
        },
        requestAnimationFrameRef(callback) { callback(); }
    });
    api.initCanvasInteractions();
    return { canvasListeners, windowListeners, state, viewportCalls, projectionCalls, legacyRefreshCalls };
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

test('continuous wheel zoom skips full node projection work until the interaction settles', () => {
    const { canvasListeners, viewportCalls } = createHarness();
    const wheelListener = canvasListeners.find(({ type }) => type === 'wheel');

    wheelListener.listener({
        clientX: 400,
        clientY: 300,
        deltaY: -1,
        target: { closest() { return null; } },
        preventDefault() {}
    });

    assert.deepEqual(viewportCalls.at(-1), {
        updateConnections: false,
        dispatchTransformEvent: false
    });
});

test('precision wheel deltas produce proportional zoom changes', () => {
    const { canvasListeners, state } = createHarness();
    const wheelListener = canvasListeners.find(({ type }) => type === 'wheel');

    wheelListener.listener({
        clientX: 400,
        clientY: 300,
        deltaY: -1,
        deltaMode: 0,
        target: { closest() { return null; } },
        preventDefault() {}
    });

    assert.ok(state.canvas.zoom > 1);
    assert.ok(state.canvas.zoom < 1.01);
});

test('line-mode mouse wheels are normalized before zooming', () => {
    const { canvasListeners, state } = createHarness();
    const wheelListener = canvasListeners.find(({ type }) => type === 'wheel');

    wheelListener.listener({
        clientX: 400,
        clientY: 300,
        deltaY: -1,
        deltaMode: 1,
        target: { closest() { return null; } },
        preventDefault() {}
    });

    assert.ok(state.canvas.zoom > 1.03);
    assert.ok(state.canvas.zoom < 1.05);
});

test('zoom settles with one projection refresh after wheel input stops', async () => {
    const { canvasListeners, viewportCalls, projectionCalls, legacyRefreshCalls } = createHarness();
    const wheelListener = canvasListeners.find(({ type }) => type === 'wheel');
    const settleListener = canvasListeners.find(({ type }) => type === 'wheel-zoom-settle');

    wheelListener.listener({
        clientX: 400,
        clientY: 300,
        deltaY: -1,
        target: { closest() { return null; } },
        preventDefault() {}
    });
    settleListener.listener();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(viewportCalls.at(-1), { updateConnections: false });
    assert.deepEqual(projectionCalls, [
        ['begin', 'zoom', undefined],
        ['changed', 'zoom'],
        ['finish', 'zoom']
    ]);
    assert.deepEqual(legacyRefreshCalls, []);
});

test('pan changes and settlement flow through one projection lease', () => {
    const { canvasListeners, windowListeners, projectionCalls, viewportCalls, legacyRefreshCalls } = createHarness();
    const event = {
        button: 0, clientX: 100, clientY: 200,
        target: { closest() { return null; } },
        preventDefault() {}, stopPropagation() {}
    };
    canvasListeners.find(({ type }) => type === 'mousedown').listener(event);
    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 130, clientY: 240 });
    windowListeners.find(({ type }) => type === 'mouseup').listener({ clientX: 130, clientY: 240, target: { closest() { return null; } } });

    assert.deepEqual(projectionCalls, [
        ['begin', 'pan', undefined],
        ['changed', 'pan'],
        ['finish', 'pan']
    ]);
    assert.deepEqual(viewportCalls.at(-1), { updateConnections: false });
    assert.deepEqual(legacyRefreshCalls, []);
});

test('node dragging reports targeted changes and settlement through a projection lease', () => {
    const { windowListeners, state, projectionCalls, legacyRefreshCalls } = createHarness();
    const node = state.nodes.get('node-1');
    node.el = {
        classList: createClassList(),
        style: { setProperty() {}, removeProperty() {} }
    };
    state.dragging = {
        nodes: ['node-1'],
        startX: 0,
        startY: 0,
        startPositions: new Map([['node-1', { x: 50, y: 60 }]]),
        isCloneDrag: false
    };

    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 10, clientY: 20 });
    windowListeners.find(({ type }) => type === 'mouseup').listener({ clientX: 10, clientY: 20, target: { closest() { return null; } } });

    assert.deepEqual(projectionCalls, [
        ['begin', 'node-drag', ['node-1']],
        ['changed', 'node-drag'],
        ['finish', 'node-drag']
    ]);
    assert.deepEqual(legacyRefreshCalls, []);
});

test('temporary connection drawing uses one projection lease', () => {
    const { windowListeners, state, projectionCalls } = createHarness();
    state.connecting = {
        startX: 0, startY: 0, screenX: 0, screenY: 0,
        nodeId: 'node-1', portName: 'output', dragged: false
    };

    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 20, clientY: 20 });
    windowListeners.find(({ type }) => type === 'mouseup').listener({
        clientX: 20, clientY: 20,
        target: { closest(selector) { return selector === '#canvas-container' ? {} : null; } }
    });

    assert.deepEqual(projectionCalls, [
        ['begin', 'connection-draw', undefined],
        ['changed', 'connection-draw'],
        ['finish', 'connection-draw']
    ]);
});
