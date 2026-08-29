import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasInteractionsApi } from '../js/canvas/canvas-interactions.js';

function createClassList() {
    return { add() {}, remove() {}, contains() { return false; } };
}

function createHarness({ getNodeMinimumSize = null } = {}) {
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
        activeWorkflowId: 'workflow-a',
        isSpacePressed: true,
        nodes: new Map([['node-1', { x: 50, y: 60 }]]), selectedNodes: new Set(), connections: [], dragging: null
    };
    const viewportCalls = [];
    const projectionCalls = [];
    const legacyRefreshCalls = [];
    const saveCalls = [];
    const viewportSaveCalls = [];
    const api = createCanvasInteractionsApi({
        state, canvasContainer, nodesLayer: {}, tempConnection: { setAttribute() {} },
        viewportApi: {
            screenToCanvas: (x, y) => ({ x, y }),
            updateCanvasTransform(options) { viewportCalls.push(options); },
            refreshNodeTextRendering() {}
        },
        getPortPosition() {}, drawTempConnection() {}, updateAllConnections() {}, updatePortStyles() {},
        scheduleSave() { saveCalls.push(true); },
        saveViewportState(value) { viewportSaveCalls.push(value); },
        serializeOneNode() {}, addNode() {}, checkLineIntersection() {},
        getConnectionSamplePoints() { return []; }, documentRef, getNodeMinimumSize,
        scheduleConnectionRefresh(options) { legacyRefreshCalls.push(options); },
        connectionProjection: {
            beginInteraction(kind, nodeIds) {
                projectionCalls.push(['begin', kind, nodeIds]);
                return {
                    changed(change) {
                        projectionCalls.push(change ? ['changed', kind, change] : ['changed', kind]);
                    },
                    finish() { projectionCalls.push(['finish', kind]); return Promise.resolve(); },
                    abort() { projectionCalls.push(['abort', kind]); return Promise.resolve(); }
                };
            }
        },
        windowRef: {
            addEventListener(type, listener, options) { windowListeners.push({ type, listener, options }); },
            getSelection() { return { removeAllRanges() {} }; },
            performance: { now() { return 100; } }
        },
        requestAnimationFrameRef(callback) { callback(); }
    });
    api.initCanvasInteractions();
    return { api, canvasListeners, windowListeners, state, viewportCalls, projectionCalls, legacyRefreshCalls, saveCalls, viewportSaveCalls };
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
    windowListeners.find(({ type, options }) => type === 'mouseup' && !(options === true || options?.capture))
        .listener({ clientX: 130, clientY: 240, target: { closest() { return null; } } });

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
    windowListeners.find(({ type, options }) => type === 'mouseup' && !(options === true || options?.capture))
        .listener({ clientX: 10, clientY: 20, target: { closest() { return null; } } });

    assert.deepEqual(projectionCalls, [
        ['begin', 'node-drag', ['node-1']],
        ['changed', 'node-drag'],
        ['finish', 'node-drag']
    ]);
    assert.deepEqual(legacyRefreshCalls, []);
});

test('zoom settlement persists only lightweight viewport state', async () => {
    const { canvasListeners, state, saveCalls, viewportSaveCalls } = createHarness();
    canvasListeners.find(({ type }) => type === 'wheel').listener({
        clientX: 400,
        clientY: 300,
        deltaY: -1,
        target: { closest() { return null; } },
        preventDefault() {}
    });
    canvasListeners.find(({ type }) => type === 'wheel-zoom-settle').listener();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(viewportSaveCalls, [{
        workflowId: 'workflow-a',
        canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom }
    }]);
    assert.deepEqual(saveCalls, []);
});

test('a previously enlarged node can shrink back to its current content minimum', () => {
    const { windowListeners, state } = createHarness({
        getNodeMinimumSize() {
            return { minWidth: 180, minHeight: 160 };
        }
    });
    const style = { width: '320px', height: '640px' };
    const node = {
        el: {
            style,
            classList: createClassList(),
            get offsetWidth() { return Number.parseInt(style.width, 10); },
            get offsetHeight() { return Number.parseInt(style.height, 10); }
        }
    };
    state.nodes.set('node-1', node);
    state.resizing = {
        nodeId: 'node-1', startX: 0, startY: 0, startWidth: 320, startHeight: 640,
        minWidth: 180, minHeight: 500, maxHeight: Infinity, textareaResizeTargets: []
    };

    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 0, clientY: -320 });

    assert.equal(style.height, '320px');
});

test('temporary connection drawing uses one projection lease', () => {
    const { windowListeners, state, projectionCalls } = createHarness();
    state.connecting = {
        startX: 0, startY: 0, screenX: 0, screenY: 0,
        nodeId: 'node-1', portName: 'output', dragged: false
    };

    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 20, clientY: 20 });
    windowListeners.find(({ type, options }) => type === 'mouseup' && !(options === true || options?.capture)).listener({
        clientX: 20, clientY: 20,
        target: { closest(selector) { return selector === '#canvas-container' ? {} : null; } }
    });

    assert.deepEqual(projectionCalls, [
        ['begin', 'connection-draw', ['node-1']],
        ['changed', 'connection-draw', { nodeIds: ['node-1'] }],
        ['finish', 'connection-draw']
    ]);
});

test('port mouseup closes the connection-draw lease before the next gesture', async () => {
    const { windowListeners, state, projectionCalls } = createHarness();
    const move = windowListeners.find(({ type }) => type === 'mousemove').listener;
    state.connecting = {
        startX: 0, startY: 0, screenX: 0, screenY: 0,
        nodeId: 'node-1', portName: 'output', dragged: false
    };
    move({ clientX: 20, clientY: 20 });

    const captureMouseup = windowListeners.find(({ type, options }) => (
        type === 'mouseup' && (options === true || options?.capture)
    ));
    assert.ok(captureMouseup, 'connection settlement must observe port mouseup in capture phase');
    captureMouseup.listener({
        target: {
            closest(selector) {
                return selector === '.node-port' ? { dataset: { nodeId: 'node-2' } } : null;
            }
        }
    });
    state.connecting = null;
    await Promise.resolve();

    state.connecting = {
        startX: 0, startY: 0, screenX: 0, screenY: 0,
        nodeId: 'node-1', portName: 'output', dragged: false
    };
    move({ clientX: 30, clientY: 30 });

    assert.deepEqual(projectionCalls, [
        ['begin', 'connection-draw', ['node-1']],
        ['changed', 'connection-draw', { nodeIds: ['node-1'] }],
        ['changed', 'connection-draw', { nodeIds: ['node-1', 'node-2'] }],
        ['finish', 'connection-draw'],
        ['begin', 'connection-draw', ['node-1']],
        ['changed', 'connection-draw', { nodeIds: ['node-1'] }]
    ]);
});

test('window blur aborts the active connection-draw lease', () => {
    const { windowListeners, state, projectionCalls } = createHarness();
    state.connecting = {
        startX: 0, startY: 0, screenX: 0, screenY: 0,
        nodeId: 'node-1', portName: 'output', dragged: false
    };
    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 20, clientY: 20 });

    const blur = windowListeners.find(({ type }) => type === 'blur');
    assert.ok(blur, 'Canvas interactions must expose a window cancellation path');
    blur.listener();

    assert.deepEqual(projectionCalls, [
        ['begin', 'connection-draw', ['node-1']],
        ['changed', 'connection-draw', { nodeIds: ['node-1'] }],
        ['abort', 'connection-draw']
    ]);
});

test('Performance sampling run drives pan through the Canvas interaction seam', () => {
    const { api, state, projectionCalls, viewportCalls } = createHarness();

    api.performSampleInteractionStep({ kind: 'pan', phase: 'start', progress: 0 });
    api.performSampleInteractionStep({ kind: 'pan', phase: 'update', progress: 0.5 });
    api.performSampleInteractionStep({ kind: 'pan', phase: 'finish', progress: 1 });

    assert.deepEqual(projectionCalls, [
        ['begin', 'pan', undefined],
        ['changed', 'pan'],
        ['finish', 'pan']
    ]);
    assert.deepEqual(viewportCalls.at(-1), { updateConnections: false });
    assert.deepEqual({ x: state.canvas.x, y: state.canvas.y }, { x: 10, y: 20 });
});

test('Performance sampling run drives zoom through the Canvas interaction seam', () => {
    const { api, state, projectionCalls, viewportCalls } = createHarness();

    api.performSampleInteractionStep({ kind: 'zoom', phase: 'start', progress: 0 });
    api.performSampleInteractionStep({ kind: 'zoom', phase: 'update', progress: 0.5 });
    api.performSampleInteractionStep({ kind: 'zoom', phase: 'finish', progress: 1 });

    assert.deepEqual(projectionCalls, [
        ['begin', 'zoom', undefined],
        ['changed', 'zoom'],
        ['finish', 'zoom']
    ]);
    assert.deepEqual(viewportCalls.at(-1), { updateConnections: false });
    assert.equal(state.canvas.zoom, 1);
});

test('Performance sampling run drives targeted node drag through the Canvas interaction seam', () => {
    const { api, state, projectionCalls } = createHarness();
    const node = state.nodes.get('node-1');
    node.el = { classList: createClassList(), style: {} };

    api.performSampleInteractionStep({ kind: 'node-drag', phase: 'start', progress: 0 });
    api.performSampleInteractionStep({ kind: 'node-drag', phase: 'update', progress: 0.5 });
    api.performSampleInteractionStep({ kind: 'node-drag', phase: 'finish', progress: 1 });

    assert.deepEqual(projectionCalls, [
        ['begin', 'node-drag', ['node-1']],
        ['changed', 'node-drag'],
        ['finish', 'node-drag']
    ]);
    assert.deepEqual({ x: node.x, y: node.y }, { x: 50, y: 60 });
});

test('Performance sampling run drives scoped connection drawing through the Canvas interaction seam', () => {
    const { api, state, projectionCalls } = createHarness();
    state.nodes.set('node-2', { x: 150, y: 160 });
    state.connections.push({
        id: 'connection-1',
        from: { nodeId: 'node-1', port: 'text' },
        to: { nodeId: 'node-2', port: 'text' },
        type: 'text'
    });

    api.performSampleInteractionStep({ kind: 'connection-draw', phase: 'start', progress: 0 });
    api.performSampleInteractionStep({ kind: 'connection-draw', phase: 'update', progress: 0.5 });
    api.performSampleInteractionStep({ kind: 'connection-draw', phase: 'finish', progress: 1 });

    assert.deepEqual(projectionCalls, [
        ['begin', 'connection-draw', ['node-1']],
        ['changed', 'connection-draw', { nodeIds: ['node-1', 'node-2'] }],
        ['finish', 'connection-draw']
    ]);
});
