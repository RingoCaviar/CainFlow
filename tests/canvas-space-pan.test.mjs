import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasInteractionsApi } from '../js/canvas/canvas-interactions.js';
import { createConnectionProjection } from '../js/canvas/connection-projection.js';

function createClassList() {
    return { add() {}, remove() {}, contains() { return false; } };
}

test('shake detach upgrades drag history before topology changes and leaves edges alone if protection fails',()=>{
    for(const fail of [false,true]) {
        const calls=[];
        const {state,windowListeners}=createHarness({connectionTargetApi:{
            detachNodesFromConnections(){calls.push('detach');return {changed:false}},
            showToast(){calls.push('error')}
        }});
        const node=state.nodes.get('node-1');node.el={classList:createClassList(),style:{setProperty(){},removeProperty(){}}};
        state.connections=[{from:{nodeId:'node-1'},to:{nodeId:'other'}}];
        state.dragging={nodes:['node-1'],startX:0,startY:0,startPositions:new Map([['node-1',{x:50,y:60}]]),isCloneDrag:false,
            promoteHistory(){calls.push('protect');if(fail)throw Error('unavailable')},
            connectionShake:{lastX:0,lastY:0,lastTime:95,activeSince:-300,reversalCount:4,travel:150}};
        windowListeners.find(({type})=>type==='mousemove').listener({clientX:30,clientY:20,buttons:1});
        assert.deepEqual(calls,fail?['protect','error']:['protect','detach']);
    }
});

function createHarness({ getNodeMinimumSize = null, connectionTargetApi = {}, requestFrame = null, connectionProjection = null } = {}) {
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
    const draggingConnectionCalls = [];
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
        getPortPosition() {}, drawTempConnection() {}, updateAllConnections() {},
        ...connectionTargetApi,
        updateDraggingConnections(draggingState) { draggingConnectionCalls.push(draggingState); },
        updatePortStyles() {},
        scheduleSave() { saveCalls.push(true); },
        getActiveWorkflowId: () => state.activeWorkflowId,
        saveViewportState(value) { viewportSaveCalls.push(value); },
        serializeOneNode: connectionTargetApi.serializeOneNode || (() => {}),
        addNode: connectionTargetApi.addNode || (() => {}), documentRef, getNodeMinimumSize,
        scheduleConnectionRefresh(options) { legacyRefreshCalls.push(options); },
        connectionProjection: connectionProjection || {
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
        requestAnimationFrameRef(callback) { if (requestFrame) return requestFrame(callback); callback(); }
    });
    api.initCanvasInteractions();
    return {
        api, canvasContainer, canvasListeners, windowListeners, state, viewportCalls, projectionCalls,
        draggingConnectionCalls, legacyRefreshCalls, saveCalls, viewportSaveCalls
    };
}

test('cutting records one protected snapshot per gesture before removing edges and refuses failed protection',()=>{
    for(const fail of [false,true]) {
        let calls=0;
        const {state,canvasListeners,windowListeners}=createHarness({connectionTargetApi:{
            findConnectionsCrossingSegments: () => new Set(['edge']),
            pushHistory(){calls++;if(fail)throw Error('protection failed')}
        }});
        const start=canvasListeners.find(({type,options})=>type==='mousedown'&&!options).listener;
        const move=windowListeners.find(({type})=>type==='mousemove').listener;
        const edge={id:'edge',from:{nodeId:'node-1'},to:{nodeId:'other'}};
        start({ctrlKey:true,button:2,clientX:0,clientY:0,preventDefault(){},stopPropagation(){}});
        state.connections=[edge];move({clientX:10,clientY:10});
        assert.equal(calls,1);assert.equal(state.connections.length,fail?1:0);
        if(!fail){state.connections=[edge];move({clientX:20,clientY:20});assert.equal(calls,1);}
    }
});

test('a fast cut preserves coalesced samples and its final release in one geometry pass', () => {
    const frames = [];
    const batches = [];
    let undoEntries = 0;
    const { state, canvasListeners, windowListeners } = createHarness({
        requestFrame(callback) { frames.push(callback); return frames.length; },
        connectionTargetApi: {
            findConnectionsCrossingSegments(segments) {
                batches.push(segments.map(segment => segment.map(({ x, y }) => [x, y])));
                return new Set(['first', 'second']);
            },
            pushHistory() { undoEntries += 1; }
        }
    });
    state.connections = [{ id: 'first' }, { id: 'second' }];
    const start = canvasListeners.find(({ type, options }) => type === 'mousedown' && !options).listener;
    const move = windowListeners.find(({ type }) => type === 'mousemove').listener;
    const release = windowListeners.find(({ type, options }) => type === 'mouseup' && !options).listener;

    start({ ctrlKey: true, button: 2, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
    move({ clientX: 80, clientY: 0, getCoalescedEvents: () => [
        { clientX: 20, clientY: 40 }, { clientX: 60, clientY: 40 }
    ] });
    assert.equal(batches.length, 0);
    release({ clientX: 90, clientY: -20, target: { closest() { return null; } } });
    while (frames.length) frames.shift()();

    assert.deepEqual(batches, [[[[0, 0], [20, 40]], [[20, 40], [60, 40]], [[60, 40], [80, 0]], [[80, 0], [90, -20]]]]);
    assert.equal(undoEntries, 1);
    assert.deepEqual(state.connections, []);
});

test('a queued cut does not affect another workflow or run during a protected edit', () => {
    for (const change of ['workflow', 'plan', 'undo']) {
        const frames = [];
        let undoEntries = 0;
        const { state, canvasListeners, windowListeners } = createHarness({
            requestFrame(callback) { frames.push(callback); return frames.length; },
            connectionTargetApi: {
                findConnectionsCrossingSegments: () => new Set(['shared-edge-id']),
                pushHistory() { undoEntries += 1; }
            }
        });
        const start = canvasListeners.find(({ type, options }) => type === 'mousedown' && !options).listener;
        const move = windowListeners.find(({ type }) => type === 'mousemove').listener;
        state.connections = [{ id: 'shared-edge-id' }];
        start({ ctrlKey: true, button: 2, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
        move({ clientX: 80, clientY: 0 });
        if (change === 'workflow') state.activeWorkflowId = 'another-workflow';
        if (change === 'plan') state.canvasPlanApplying = true;
        if (change === 'undo') state.historyTransitionInProgress = true;
        while (frames.length) frames.shift()();

        assert.equal(undoEntries, 0, change);
        assert.deepEqual(state.connections, [{ id: 'shared-edge-id' }], change);
    }
});

test('connection drawing coalesces pointer feedback and discards ended sessions', () => {
    const frames = [];
    const feedback = [];
    const { state, windowListeners } = createHarness({
        requestFrame: (callback) => { frames.push(callback); return frames.length; },
        connectionTargetApi: { updateConnectionTargetFeedback(source, x, y) { feedback.push([x, y]); } }
    });
    state.connecting = { nodeId: 'node-1', screenX: 0, screenY: 0 };
    const move = windowListeners.find(({ type }) => type === 'mousemove').listener;
    move({ clientX: 20, clientY: 20 });
    move({ clientX: 30, clientY: 40 });
    assert.equal(frames.length, 1);
    assert.deepEqual(feedback, []);
    frames.shift()();
    assert.deepEqual(feedback, [[30, 40]]);
    move({ clientX: 50, clientY: 60 });
    state.connecting = null;
    frames.shift()();
    assert.equal(feedback.length, 1);
});

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

test('window blur ends an in-progress middle-button canvas pan', () => {
    const { canvasListeners, windowListeners, state, projectionCalls, viewportCalls } = createHarness();
    const startPan = canvasListeners.find(({ type, options }) => type === 'mousedown' && !(options === true || options?.capture));
    startPan.listener({
        button: 1, clientX: 100, clientY: 200,
        target: { closest() { return null; } },
        preventDefault() {}, stopPropagation() {}
    });
    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 130, clientY: 240 });
    windowListeners.find(({ type }) => type === 'blur').listener();

    assert.equal(state.canvas.isPanning, false);
    assert.deepEqual(viewportCalls.at(-1), { updateConnections: false });
    assert.deepEqual(projectionCalls.at(-1), ['abort', 'pan']);
});

test('a returned mousemove without the middle button ends a stale canvas pan', () => {
    const { canvasListeners, windowListeners, state, projectionCalls } = createHarness();
    const startPan = canvasListeners.find(({ type, options }) => type === 'mousedown' && !(options === true || options?.capture));
    startPan.listener({
        button: 1, clientX: 100, clientY: 200,
        target: { closest() { return null; } },
        preventDefault() {}, stopPropagation() {}
    });

    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 130, clientY: 240, buttons: 4 });
    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 130, clientY: 240, buttons: 0 });

    assert.equal(state.canvas.isPanning, false);
    assert.deepEqual(projectionCalls.at(-1), ['abort', 'pan']);
});

test('window blur ends an in-progress space canvas pan', () => {
    const { canvasListeners, windowListeners, state, projectionCalls, viewportCalls } = createHarness();
    const startPan = canvasListeners.find(({ type, options }) => type === 'mousedown' && (options === true || options?.capture));
    startPan.listener({
        button: 0, clientX: 100, clientY: 200,
        target: { closest() { return null; } },
        preventDefault() {}, stopPropagation() {}
    });
    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 130, clientY: 240 });
    windowListeners.find(({ type }) => type === 'blur').listener();

    assert.equal(state.canvas.isPanning, false);
    assert.deepEqual(viewportCalls.at(-1), { updateConnections: false });
    assert.deepEqual(projectionCalls.at(-1), ['abort', 'pan']);
});

test('a returned mousemove without the space-pan button ends a stale canvas pan', () => {
    const { canvasListeners, windowListeners, state, projectionCalls } = createHarness();
    const startPan = canvasListeners.find(({ type, options }) => type === 'mousedown' && (options === true || options?.capture));
    startPan.listener({
        button: 0, clientX: 100, clientY: 200,
        target: { closest() { return null; } },
        preventDefault() {}, stopPropagation() {}
    });

    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 130, clientY: 240, buttons: 1 });
    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 130, clientY: 240, buttons: 0 });

    assert.equal(state.canvas.isPanning, false);
    assert.deepEqual(projectionCalls.at(-1), ['abort', 'pan']);
});

test('node dragging reports targeted changes and settlement through a projection lease', () => {
    const { windowListeners, state, projectionCalls, draggingConnectionCalls, legacyRefreshCalls } = createHarness();
    const node = state.nodes.get('node-1');
    node.el = {
        classList: createClassList(),
        style: { setProperty() {}, removeProperty() {} }
    };
    const draggingState = {
        nodes: ['node-1'],
        startX: 0,
        startY: 0,
        startPositions: new Map([['node-1', { x: 50, y: 60 }]]),
        isCloneDrag: false
    };
    state.dragging = draggingState;

    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 10, clientY: 20 });
    windowListeners.find(({ type, options }) => type === 'mouseup' && !(options === true || options?.capture))
        .listener({ clientX: 10, clientY: 20, target: { closest() { return null; } } });

    assert.deepEqual(projectionCalls, [
        ['begin', 'node-drag', ['node-1']],
        ['changed', 'node-drag'],
        ['finish', 'node-drag']
    ]);
    assert.equal(draggingConnectionCalls.length, 0);
    assert.deepEqual(legacyRefreshCalls, []);
});

test('dragging submits the latest pointer once per frame and saves the release position', () => {
    const frames = [];
    const { windowListeners, state, projectionCalls, saveCalls } = createHarness({
        requestFrame(callback) { frames.push(callback); return frames.length; }
    });
    const node = state.nodes.get('node-1');
    node.el = { classList: createClassList(), style: { setProperty() {}, removeProperty() {} } };
    state.dragging = {
        nodes: ['node-1'],
        startX: 0,
        startY: 0,
        startPositions: new Map([['node-1', { x: 50, y: 60 }]])
    };
    const move = windowListeners.find(({ type }) => type === 'mousemove').listener;
    const up = windowListeners.find(({ type, options }) => type === 'mouseup' && !options).listener;
    move({ clientX: 10, clientY: 20 });
    move({ clientX: 30, clientY: 40 });

    assert.equal(frames.length, 1);
    assert.equal(node.x, 50);
    assert.equal(projectionCalls.length, 0);
    frames.shift()();
    assert.equal(node.x, 80);
    assert.equal(node.y, 100);
    assert.equal(projectionCalls.filter(([event]) => event === 'changed').length, 1);

    move({ clientX: 40, clientY: 50 });
    up({ clientX: 60, clientY: 70, target: { closest() { return null; } } });
    assert.equal(state.dragging, null);
    assert.equal(node.el.style.left, '110px');
    assert.equal(node.el.style.top, '130px');
    assert.equal(saveCalls.length, 1);
    const callCount = projectionCalls.length;
    frames.shift()();
    assert.equal(projectionCalls.length, callCount, 'the queued callback belongs to the ended drag');
});

test('queued drag and resize never change a replacement node with the same id', () => {
    for (const kind of ['dragging', 'resizing']) {
        for (const switchWorkflow of [false, true]) {
            const frames = [];
            const { windowListeners, state, projectionCalls, saveCalls } = createHarness({
                requestFrame(callback) { frames.push(callback); }
            });
            const createElement = () => ({
                classList: createClassList(),
                style: { width: '240px', height: '180px', setProperty() {}, removeProperty() {} }
            });
            const node = state.nodes.get('node-1');
            node.el = createElement();
            state[kind] = kind === 'dragging' ? {
                nodes: ['node-1'], startX: 0, startY: 0,
                workflowId: state.activeWorkflowId,
                startPositions: new Map([['node-1', { x: 50, y: 60, node }]])
            } : {
                nodeId: 'node-1', node, workflowId: state.activeWorkflowId, edge: 'bottom-right', startX: 0, startY: 0,
                startWidth: 240, startHeight: 180, minWidth: 100, minHeight: 80
            };
            const move = windowListeners.find(({ type }) => type === 'mousemove').listener;
            const up = windowListeners.find(({ type, options }) => type === 'mouseup' && !options).listener;
            move({ clientX: 50, clientY: 30 });
            if (switchWorkflow) state.activeWorkflowId = 'workflow-b';
            const replacement = { x: 100, y: 120, el: createElement() };
            state.nodes.set('node-1', replacement);
            frames.shift()();
            up({ clientX: 80, clientY: 70, target: { closest() { return null; } } });

            assert.equal(state[kind], null);
            assert.deepEqual([replacement.x, replacement.y, replacement.el.style.width, replacement.el.style.height],
                [100, 120, '240px', '180px']);
            assert.deepEqual(projectionCalls, []);
            assert.deepEqual(saveCalls, []);
        }
    }
});

test('queued marquee cannot select nodes in a newly activated workflow', () => {
    const frames = [];
    const { canvasListeners, canvasContainer, windowListeners, state } = createHarness({
        requestFrame(callback) { frames.push(callback); }
    });
    state.isSpacePressed = false;
    const down = canvasListeners.find(({ type, options }) => type === 'mousedown' && !options).listener;
    const move = windowListeners.find(({ type }) => type === 'mousemove').listener;
    const up = windowListeners.find(({ type, options }) => type === 'mouseup' && !options).listener;
    down({ button: 0, clientX: 10, clientY: 10, target: canvasContainer, preventDefault() {} });
    move({ clientX: 75, clientY: 80 });
    state.activeWorkflowId = 'workflow-b';
    frames.shift()();
    up({ clientX: 75, clientY: 80, target: canvasContainer });
    assert.equal(state.marquee, null);
    assert.equal(state.selectedNodes.size, 0);
});

test('a clone released before its first frame captures undo before creating the clone', () => {
    const frames = [];
    const calls = [];
    const { windowListeners, state } = createHarness({
        requestFrame(callback) { frames.push(callback); return frames.length; },
        connectionTargetApi: {
            serializeOneNode() { return {}; },
            addNode(_type, x, y) {
                calls.push('clone');
                state.nodes.set('copy', { x, y, el: createNodeElement() });
                return 'copy';
            }
        }
    });
    function createNodeElement() {
        return { classList: createClassList(), style: { setProperty() {}, removeProperty() {} } };
    }
    state.nodes.get('node-1').el = createNodeElement();
    const dragging = {
        nodes: ['node-1'],
        startX: 0,
        startY: 0,
        startPositions: new Map([['node-1', { x: 50, y: 60, node: state.nodes.get('node-1') }]]),
        isCloneDrag: true,
        deferSelectionOnDrag: true,
        activateSelection() {
            calls.push('undo');
            dragging.selectionActivated = true;
        }
    };
    state.dragging = dragging;
    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 10, clientY: 10 });
    assert.deepEqual(calls, []);
    windowListeners.find(({ type, options }) => type === 'mouseup' && !options)
        .listener({ clientX: 35, clientY: 25, target: { closest() { return null; } } });

    assert.deepEqual(calls, ['undo', 'clone']);
    assert.equal(state.nodes.get('node-1').x, 50);
    assert.equal(state.nodes.get('copy').el.style.left, '85px');
    assert.equal(state.nodes.get('copy').el.style.top, '85px');
    assert.deepEqual([...state.selectedNodes], ['copy']);
    frames.shift()();
    assert.deepEqual(calls, ['undo', 'clone']);
});

test('a cloned group can keep moving in subsequent frames', () => {
    const frames = [];
    const createElement = () => ({
        classList: createClassList(), style: { setProperty() {}, removeProperty() {} }
    });
    const { windowListeners, state } = createHarness({
        requestFrame(callback) { frames.push(callback); },
        connectionTargetApi: {
            serializeOneNode(id) { return { customTitle: id }; },
            addNode(_type, x, y, data) {
                const id = `copy-${data.customTitle}`;
                state.nodes.set(id, { x, y, el: createElement() });
                return id;
            }
        }
    });
    state.nodes.get('node-1').el = createElement();
    state.nodes.set('node-2', { x: 100, y: 120, el: createElement() });
    state.dragging = {
        nodes: ['node-1', 'node-2'], workflowId: state.activeWorkflowId, startX: 0, startY: 0, isCloneDrag: true,
        startPositions: new Map([...state.nodes].map(([id, node]) => [id, { x: node.x, y: node.y, node }]))
    };
    const move = windowListeners.find(({ type }) => type === 'mousemove').listener;
    const up = windowListeners.find(({ type, options }) => type === 'mouseup' && !options).listener;
    move({ clientX: 10, clientY: 20 });
    frames.shift()();
    move({ clientX: 30, clientY: 40 });
    frames.shift()();
    assert.equal(state.nodes.get('copy-node-1').x, 80);
    assert.equal(state.nodes.get('copy-node-2').x, 130);
    up({ clientX: 50, clientY: 60, target: { closest() { return null; } } });
    assert.equal(state.nodes.get('copy-node-1').el.style.left, '100px');
    assert.equal(state.nodes.get('copy-node-2').el.style.left, '150px');
    assert.equal(state.nodes.get('node-1').x, 50);
    assert.equal(state.nodes.get('node-2').x, 100);
});

test('marquee selection coalesces movement and uses the release point before the frame', () => {
    const frames = [];
    const { canvasListeners, canvasContainer, windowListeners, state } = createHarness({
        requestFrame(callback) { frames.push(callback); return frames.length; }
    });
    state.isSpacePressed = false;
    const down = canvasListeners.find(({ type, options }) => type === 'mousedown' && !options).listener;
    const move = windowListeners.find(({ type }) => type === 'mousemove').listener;
    const up = windowListeners.find(({ type, options }) => type === 'mouseup' && !options).listener;
    down({ button: 0, clientX: 10, clientY: 10, target: canvasContainer, preventDefault() {} });
    move({ clientX: 15, clientY: 20 });
    move({ clientX: 35, clientY: 40 });
    assert.equal(frames.length, 1);
    assert.equal(state.selectedNodes.size, 0);

    up({ clientX: 75, clientY: 80, target: canvasContainer });
    assert.deepEqual([...state.selectedNodes], ['node-1']);
    assert.equal(state.marquee, null);
    frames.shift()();
    assert.deepEqual([...state.selectedNodes], ['node-1']);
});

test('window blur finalizes the queued marquee and prevents a stale selection frame', () => {
    const frames = [];
    const { canvasListeners, canvasContainer, windowListeners, state } = createHarness({
        requestFrame(callback) { frames.push(callback); return frames.length; }
    });
    state.isSpacePressed = false;
    const down = canvasListeners.find(({ type, options }) => type === 'mousedown' && !options).listener;
    const move = windowListeners.find(({ type }) => type === 'mousemove').listener;
    down({ button: 0, clientX: 10, clientY: 10, target: canvasContainer, preventDefault() {} });
    move({ clientX: 75, clientY: 80 });
    windowListeners.find(({ type }) => type === 'blur').listener();
    assert.equal(state.marquee, null);
    assert.deepEqual([...state.selectedNodes], ['node-1']);

    down({ button: 0, clientX: 10, clientY: 10, target: canvasContainer, preventDefault() {} });
    assert.equal(state.selectedNodes.size, 0);
    frames.shift()();
    assert.equal(state.selectedNodes.size, 0);
});

test('window blur settles an in-progress node drag', () => {
    const { windowListeners, state, projectionCalls } = createHarness();
    const node = state.nodes.get('node-1');
    node.el = {
        classList: createClassList(),
        style: { left: '', top: '', setProperty() {}, removeProperty() {} }
    };
    state.dragging = {
        nodes: ['node-1'],
        startX: 0,
        startY: 0,
        startPositions: new Map([['node-1', { x: 50, y: 60 }]]),
        isCloneDrag: false
    };

    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 10, clientY: 20 });
    windowListeners.find(({ type }) => type === 'blur').listener();

    assert.equal(state.dragging, null);
    assert.equal(node.el.style.left, '60px');
    assert.equal(node.el.style.top, '80px');
    assert.deepEqual(projectionCalls.at(-1), ['abort', 'node-drag']);
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

test('each node edge resizes on its axis and preserves the opposite edge at canvas zoom', () => {
    const cases = [
        { edge: 'left', pointer: [140, 100], expected: [70, 60, 300, 240] },
        { edge: 'right', pointer: [140, 100], expected: [50, 60, 340, 240] },
        { edge: 'top', pointer: [100, 140], expected: [50, 80, 320, 220] },
        { edge: 'bottom', pointer: [100, 140], expected: [50, 60, 320, 260] },
        { edge: 'bottom-right', pointer: [140, 140], expected: [50, 60, 340, 260] }
    ];
    for (const { edge, pointer, expected } of cases) {
        const { windowListeners, state, legacyRefreshCalls, saveCalls } = createHarness();
        state.canvas.zoom = 2;
        const style = { left: '50px', top: '60px', width: '320px', height: '240px' };
        const node = { x: 50, y: 60, el: { style, classList: createClassList() } };
        state.nodes.set('node-1', node);
        state.resizing = {
            nodeId: 'node-1', edge, startX: 100, startY: 100,
            startNodeX: 50, startNodeY: 60, startWidth: 320, startHeight: 240,
            minWidth: 180, maxWidth: 380, minHeight: 120, maxHeight: 300,
            textareaResizeTargets: []
        };
        windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: pointer[0], clientY: pointer[1] });
        windowListeners.find(({ type, options }) => type === 'mouseup' && !(options === true || options?.capture))
            .listener({ clientX: pointer[0], clientY: pointer[1], target: { closest() { return null; } } });

        assert.deepEqual([node.x, node.y, node.width, node.height], expected, edge);
        assert.equal(style.left, `${expected[0]}px`, edge);
        assert.equal(style.top, `${expected[1]}px`, edge);
        assert.equal(node.userResized, true, edge);
        assert.equal(state.resizing, null, edge);
        assert.equal(legacyRefreshCalls.at(-1).force, true, edge);
        assert.equal(saveCalls.length, 1, edge);
    }
});

test('left and top resize clamp to content minimum without moving the opposite edge', () => {
    for (const edge of ['left', 'top']) {
        const { windowListeners, state } = createHarness({
            getNodeMinimumSize() { return { minWidth: 260, minHeight: 180 }; }
        });
        const style = { left: '50px', top: '60px', width: '320px', height: '240px' };
        const node = { x: 50, y: 60, el: { style, classList: createClassList() } };
        state.nodes.set('node-1', node);
        state.resizing = {
            nodeId: 'node-1', edge, startX: 100, startY: 100,
            startNodeX: 50, startNodeY: 60, startWidth: 320, startHeight: 240,
            minWidth: 180, maxWidth: Infinity, minHeight: 120, maxHeight: Infinity,
            textareaResizeTargets: []
        };
        windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 400, clientY: 400 });
        windowListeners.find(({ type, options }) => type === 'mouseup' && !(options === true || options?.capture))
            .listener({ clientX: 400, clientY: 400, target: { closest() { return null; } } });
        assert.equal(node.x + node.width, 370, edge);
        assert.equal(node.y + node.height, 300, edge);
        assert.deepEqual([node.width, node.height], edge === 'left' ? [260, 240] : [320, 180]);
    }
});

test('window blur settles a node resize and clears its cursor state', () => {
    const { windowListeners, state, saveCalls } = createHarness();
    const style = { left: '50px', top: '60px', width: '320px', height: '240px' };
    state.nodes.set('node-1', { x: 50, y: 60, el: { style, classList: createClassList() } });
    state.resizing = {
        nodeId: 'node-1', edge: 'left', cursorClass: 'is-node-resizing-horizontal',
        startX: 100, startY: 100, startNodeX: 50, startNodeY: 60,
        startWidth: 320, startHeight: 240, minWidth: 180, minHeight: 120,
        maxWidth: Infinity, maxHeight: Infinity, textareaResizeTargets: []
    };
    // The resize state must be cleared even when the pointer is released outside the window.
    windowListeners.find(({ type }) => type === 'blur').listener();
    assert.equal(state.resizing, null);
    assert.equal(state.nodes.get('node-1').userResized, true);
    assert.equal(saveCalls.length, 1);
});

test('resizing processes one pointer per frame and flushes the last pointer on release', () => {
    const frames = [];
    const measuredWidths = [];
    const { windowListeners, state } = createHarness({
        requestFrame(callback) { frames.push(callback); return frames.length; },
        getNodeMinimumSize(_node, { width }) {
            measuredWidths.push(width);
            return { minWidth: 180, minHeight: 120 };
        }
    });
    const style = { width: '320px', height: '240px' };
    const node = { x: 50, y: 60, el: { style, classList: createClassList() } };
    state.nodes.set('node-1', node);
    state.resizing = {
        nodeId: 'node-1', edge: 'bottom-right', startX: 100, startY: 100,
        startNodeX: 50, startNodeY: 60, startWidth: 320, startHeight: 240,
        minWidth: 180, maxWidth: Infinity, minHeight: 120, maxHeight: Infinity,
        textareaResizeTargets: []
    };
    const move = windowListeners.find(({ type }) => type === 'mousemove').listener;
    const up = windowListeners.find(({ type, options }) => type === 'mouseup' && !options).listener;
    move({ clientX: 110, clientY: 120 });
    move({ clientX: 130, clientY: 140 });
    assert.equal(frames.length, 1);
    assert.deepEqual(measuredWidths, []);
    frames.shift()();
    assert.deepEqual(measuredWidths, [350]);
    assert.equal(style.height, '280px');

    move({ clientX: 140, clientY: 150 });
    up({ clientX: 160, clientY: 170, target: { closest() { return null; } } });
    assert.equal(state.resizing, null);
    assert.equal(node.width, 380);
    assert.equal(node.height, 310);
    assert.ok(measuredWidths.slice(1).every(width => width === 380));
    frames.shift()();
    assert.equal(node.width, 380);
});

test('releasing a resize or losing focus settles only the resized node connections', () => {
    for (const end of ['mouseup', 'blur']) {
        const frames = [];
        const calls = [];
        const projection = createConnectionProjection({
            updateAllConnections() { calls.push('full refresh'); },
            invalidateNodePortCache(nodeId, options) {
                calls.push([options?.measurementOnly ? 'measure' : 'invalidate', nodeId]);
            },
            updateDirtyConnections() { calls.push('refresh changed connections'); },
            detectMisalignedConnections({ nodeIds }) {
                calls.push(['check alignment', nodeIds, state.nodes.get('node-1').width]);
                return [{ connectionId: 'resized-edge' }];
            },
            markConnectionDirty(connectionId) { calls.push(['repair', connectionId]); },
            requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
            cancelAnimationFrameRef() {}
        });
        const { windowListeners, state, legacyRefreshCalls, saveCalls } = createHarness({ connectionProjection: projection.interactions });
        const style = { left: '50px', top: '60px', width: '320px', height: '240px' };
        state.nodes.set('node-1', { x: 50, y: 60, el: { style, classList: createClassList() } });
        state.resizing = {
            nodeId: 'node-1', edge: 'right', startX: 100, startY: 100,
            startNodeX: 50, startNodeY: 60, startWidth: 320, startHeight: 240,
            minWidth: 180, maxWidth: Infinity, minHeight: 120, maxHeight: Infinity,
            textareaResizeTargets: []
        };
        windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 140, clientY: 100 });
        windowListeners.find(({ type, options }) => type === end && !(options === true || options?.capture))
            .listener({ clientX: 140, clientY: 100, target: { closest() { return null; } } });

        assert.equal(state.resizing, null, end);
        assert.equal(saveCalls.length, 1, end);
        assert.equal(legacyRefreshCalls.filter(({ force }) => force).length, 0, end);
        assert.deepEqual(calls, [
            ['invalidate', 'node-1'],
            'refresh changed connections',
            ['invalidate', 'node-1']
        ], end);
        while (frames.length) frames.shift()();
        assert.deepEqual(calls, [
            ['invalidate', 'node-1'],
            'refresh changed connections',
            ['invalidate', 'node-1'],
            'refresh changed connections',
            ['measure', 'node-1'],
            ['check alignment', ['node-1'], 360],
            ['repair', 'resized-edge'],
            'refresh changed connections'
        ], end);
    }
});

test('a top resize that changes vertical ordering refreshes shared connection lanes', () => {
    const frames = [];
    let fullRefreshes = 0;
    const projection = createConnectionProjection({
        updateAllConnections() { fullRefreshes += 1; },
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });
    const { windowListeners, state } = createHarness({ connectionProjection: projection.interactions });
    const style = { left: '50px', top: '60px', width: '320px', height: '240px' };
    state.nodes.set('node-1', { x: 50, y: 60, el: { style, classList: createClassList() } });
    state.resizing = {
        nodeId: 'node-1', edge: 'top', startX: 100, startY: 100,
        startNodeX: 50, startNodeY: 60, startWidth: 320, startHeight: 240,
        minWidth: 180, maxWidth: Infinity, minHeight: 120, maxHeight: Infinity,
        textareaResizeTargets: []
    };
    windowListeners.find(({ type }) => type === 'mousemove').listener({ clientX: 100, clientY: 140 });
    windowListeners.find(({ type, options }) => type === 'mouseup' && !(options === true || options?.capture))
        .listener({ clientX: 100, clientY: 140, target: { closest() { return null; } } });
    while (frames.length) frames.shift()();

    assert.equal(state.nodes.get('node-1').y, 100);
    assert.equal(fullRefreshes, 1, 'peer lanes can change when the resized node moves vertically');
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

test('drag release connects to the nearest usable port even when released over the node body', () => {
    const finished = [];
    const { windowListeners, state } = createHarness({
        connectionTargetApi: {
            getNearestConnectionTarget: () => ({ target: { nodeId: 'node-2', port: 'input', dir: 'input' } }),
            finishConnection: (source, target) => { finished.push([source.nodeId, target.nodeId]); return true; }
        }
    });
    state.connecting = { nodeId: 'node-1', dragged: true };
    const captureMouseups = windowListeners.filter(({ type, options }) => type === 'mouseup' && options === true);
    captureMouseups[1].listener({ clientX: 20, clientY: 20, target: { closest: () => null } });
    assert.deepEqual(finished, [['node-1', 'node-2']]);
    assert.equal(state.connecting, null);
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
