import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionsApi } from '../js/canvas/connections.js';
import { createConnectionProjection } from '../js/canvas/connection-projection.js';
import { createCanvasPerformanceMonitor } from '../js/app/dev/canvas-performance-monitor.js';
import { getConnectionSamplePoints } from '../js/canvas/geometry.js';

function createClassList() {
    const values = new Set();
    return {
        add: (...names) => names.forEach((name) => values.add(name)),
        remove: (...names) => names.forEach((name) => values.delete(name)),
        toggle: (name, enabled) => enabled ? values.add(name) : values.delete(name),
        contains: (name) => values.has(name)
    };
}

function createPort(name, direction, getLeft, onRectRead = null, isVisible = () => true) {
    const dot = {
        classList: createClassList(),
        getBoundingClientRect: () => {
            onRectRead?.();
            const size = isVisible() ? 8 : 0;
            return {
                left: typeof getLeft === 'function' ? getLeft() : getLeft,
                top: 20,
                width: size,
                height: size
            };
        }
    };
    return {
        dataset: { port: name, direction },
        classList: createClassList(),
        offsetParent: {},
        querySelector: (selector) => selector === '.port-dot' ? dot : null
    };
}

function createNode(id, x, outputPort, inputPort) {
    const ports = [outputPort, inputPort];
    return {
        id,
        x,
        y: 0,
        width: 120,
        height: 80,
        el: {
            offsetWidth: 120,
            offsetHeight: 80,
            scrollWidth: 120,
            scrollHeight: 80,
            classList: createClassList(),
            querySelector(selector) {
                return selector.includes('.port-dot') && selector.includes(`data-port="${outputPort.dataset.port}"`)
                    ? outputPort.querySelector('.port-dot') : null;
            },
            querySelectorAll(selector) {
                if (selector.includes('data-direction="output"')) return [outputPort];
                if (selector.includes('data-direction="input"')) return [inputPort];
                if (selector.includes('.node-port')) return ports;
                return [];
            }
        }
    };
}

test('drag insertion upgrades history before graph writes and rejects failed media protection',()=>{
    const {api,state}=createHarness(1);
    const node=createNode('insert',100,createPort('text','output',180),createPort('text','input',100));
    state.nodes.set(node.id,node);
    for(const item of state.nodes.values()) {
        item.el.querySelector=selector=>item.el.querySelectorAll(selector)[0];
        for(const port of item.el.querySelectorAll('.node-port')) port.querySelector('.port-dot').classList=createClassList();
    }
    const before=state.connections.slice();let calls=0,fail=true;
    state.dragging={promoteHistory(){calls++;assert.deepEqual(state.connections.slice(),before);if(fail)throw Error('protection unavailable')}};
    const preview=()=>{state.connectionInsertPreview={connectionId:'connection-1',nodeId:'insert',inputPort:'text',outputPort:'text'}};
    preview();assert.equal(api.commitConnectionInsertPreview(),false);assert.deepEqual(state.connections.slice(),before);
    fail=false;preview();assert.equal(api.commitConnectionInsertPreview(),true);assert.equal(calls,2);
    assert.equal(state.connections.length,2);
});

function createHarness(connectionCount, {
    requestAnimationFrameImpl,
    cancelAnimationFrameImpl,
    setTimeoutImpl,
    createBezierPathImpl,
    sampleConnection = () => [],
    connectionRenderer,
    performanceMonitor,
    distinctTargets = false,
    portsInitiallyVisible = true,
    running = false,
    pushHistory = () => {},
    scheduleSave = () => {},
    onConnectionsChanged = () => {}
} = {}) {
    const frames = [];
    const paths = [];
    let outputPortLeft = 120;
    let portsVisible = portsInitiallyVisible;
    let portRectReads = 0;
    const countPortRectRead = () => { portRectReads += 1; };
    const isPortVisible = () => portsVisible;
    const outputPort = createPort('text', 'output', () => outputPortLeft, countPortRectRead, isPortVisible);
    const inputPort = createPort('text', 'input', 220, countPortRectRead, isPortVisible);
    const nodes = new Map([
        ['from', createNode('from', 0, outputPort, inputPort)],
        ['to', createNode('to', 200, outputPort, inputPort)]
    ]);
    if (distinctTargets) {
        for (let index = 0; index < connectionCount; index += 1) {
            const id = `to-${index + 1}`;
            const node = createNode(id, 200, outputPort, inputPort);
            node.y = index;
            nodes.set(id, node);
        }
    }
    let connectionForEachReads = 0;
    const connections = Array.from({ length: connectionCount }, (_, index) => ({
        id: `connection-${index + 1}`,
        from: { nodeId: 'from', port: 'text' },
        to: { nodeId: distinctTargets ? `to-${index + 1}` : 'to', port: 'text' },
        type: 'text'
    }));
    const connectionForEach = connections.forEach.bind(connections);
    connections.forEach = (...args) => {
        connectionForEachReads += 1;
        return connectionForEach(...args);
    };
    const state = {
        nodes,
        connections,
        selectedNodes: new Set(),
        runningNodeIds: new Set(running ? ['from'] : []),
        canvas: { x: 0, y: 0, zoom: 1, isPanning: false }
    };
    const layerAttributes = new Map(), axesAttributes = new Map();
    const connectionsGroup = {
        setAttribute(name, value) { layerAttributes.set(name, value); },
        getAttribute(name) { return layerAttributes.get(name) ?? null; },
        classList: createClassList(),
        appendChild(path) { paths.push(path); }
    };
    const originAxes = {
        setAttribute(name, value) { axesAttributes.set(name, value); },
        getAttribute(name) { return axesAttributes.get(name) ?? null; }
    };
    const documentRef = {
        defaultView: {
            requestAnimationFrame(callback) {
                if (requestAnimationFrameImpl) return requestAnimationFrameImpl(callback);
                frames.push(callback);
                return frames.length;
            },
            cancelAnimationFrame(id) {
                cancelAnimationFrameImpl?.(id);
            },
            setTimeout(callback) {
                if (setTimeoutImpl) return setTimeoutImpl(callback);
                return setTimeout(callback, 0);
            },
            clearTimeout(id) {
                if (!setTimeoutImpl) clearTimeout(id);
            }
        },
        addEventListener() {},
        querySelectorAll() { return []; },
        createElementNS() {
            const attributes = new Map();
            const element = {
                isConnected: true,
                removed: false,
                classList: createClassList(),
                style: {},
                parentNode: { insertBefore() {} },
                addEventListener() {},
                setAttribute(name, value) { attributes.set(name, value); },
                getAttribute(name) { return attributes.get(name) || ''; },
                getTotalLength() { return 120; },
                getPointAtLength(length) { return { x: length, y: 0 }; },
                removeAttribute() {},
                appendChild() {},
                remove() { element.removed = true; }
            };
            return element;
        }
    };
    const canvasEvents = new Map();
    const api = createConnectionsApi({
        state,
        canvasContainer: {
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
            addEventListener(name, listener) { canvasEvents.set(name, listener); }
        },
        connectionsGroup,
        tempConnection: { setAttribute() {} },
        originAxes,
        getNodeById: (id) => nodes.get(id),
        createBezierPath: (fromX, fromY, toX, toY, options) => createBezierPathImpl
            ? createBezierPathImpl(fromX, fromY, toX, toY, options)
            : `M ${fromX} ${fromY} L ${toX} ${toY}`,
        getConnectionSamplePoints: sampleConnection,
        pushHistory,
        showToast: () => {},
        scheduleSave,
        onConnectionsChanged,
        documentRef,
        connectionRenderer,
        performanceMonitor
    });
    return {
        api,
        state,
        frames,
        paths,
        connectionsGroup,
        originAxes,
        hoverNode(id) { canvasEvents.get('pointerover')({ target: { closest: () => id ? { id } : null } }); },
        leaveCanvas() { canvasEvents.get('pointerleave')(); },
        getPortRectReadCount() { return portRectReads; },
        getConnectionForEachReadCount() { return connectionForEachReads; },
        setPortsVisible(visible) { portsVisible = visible; },
        setOutputPortLeft(left) { outputPortLeft = left; }
    };
}

const referenceTargets = [
    ['ImageGenerate', ['mask']],
    ['VideoGenerate', ['image_1', 'image_2']],
    ['TextChat', []],
    ['ECommerceImageSet', []]
];

function createReferenceHarness(type, sourceCount, callbacks) {
    const harness = createHarness(sourceCount, callbacks);
    const { state } = harness;
    state.nodes.get('to').type = type;
    state.connections = state.connections.map((connection, index) => {
        const sourceId = `reference-source-${index + 1}`;
        const source = createNode(sourceId, 0, createPort('image', 'output', 120), createPort('image', 'input', 0));
        state.nodes.set(sourceId, source);
        return { ...connection, type: 'image', from: { nodeId: sourceId, port: 'image' }, to: { nodeId: 'to', port: 'referenceImages' } };
    });
    return harness;
}

for (const [type, fixedPorts] of referenceTargets) {
    test(`${type} reorders and disconnects only its reference image sources`, () => {
        const updates = [];
        const { api, state } = createReferenceHarness(type, 3, {
            pushHistory: () => updates.push('history'),
            scheduleSave: () => updates.push('save'),
            onConnectionsChanged: () => updates.push('projection')
        });
        const [last, first, implicit] = state.connections;
        last.order = 2.5;
        first.order = 0;
        const fixed = fixedPorts.map(port => ({ ...first, id: port, to: { ...first.to, port } }));
        state.connections = [last, first, ...fixed, implicit];

        assert.equal(api.moveImageReferenceConnection('to', first.id, last.id), true);
        const orders = state.connections.filter(connection => connection.to.port === 'referenceImages')
            .map(connection => [connection.id, connection.order]);
        assert.deepEqual(orders, [[last.id, 1], [first.id, 2], [implicit.id, 0]]);
        for (const edge of fixed) {
            assert.equal(state.connections.find(connection => connection.id === edge.id), edge);
            assert.equal(api.moveImageReferenceConnection('to', first.id, edge.id), false);
            assert.equal(api.disconnectImageReferenceConnection('to', edge.id), false);
        }
        assert.equal(api.disconnectImageReferenceConnection('to', last.id), true);
        assert.deepEqual(state.connections.map(connection => connection.id), [first.id, ...fixedPorts, implicit.id]);
        assert.deepEqual(updates, ['history', 'save', 'projection', 'history', 'save', 'projection']);
    });
}

test('reference image adjustments preserve graph and history while either endpoint or the graph is busy', () => {
    const updates = [];
    const { api, state } = createReferenceHarness('ECommerceImageSet', 2, { pushHistory: () => updates.push('history') });
    const connections = state.connections;
    const [first, second] = connections;
    const target = state.nodes.get('to');
    const source = state.nodes.get(first.from.nodeId);
    const assertLocked = () => {
        assert.equal(api.moveImageReferenceConnection('to', first.id, second.id), false);
        assert.equal(api.disconnectImageReferenceConnection('to', first.id), false);
        assert.equal(state.connections, connections);
        assert.deepEqual(updates, []);
    };

    state.runningNodeIds.add(source.id);
    assertLocked();
    state.runningNodeIds.clear();
    target.runStatus = 'waiting';
    assertLocked();
    target.runStatus = 'completed';
    source.runStatus = 'running';
    assertLocked();
    source.runStatus = 'completed';
    state.canvasPlanApplying = true;
    assertLocked();
    state.canvasPlanApplying = false;
    state.historyTransitionInProgress = true;
    assertLocked();
});

test('node hover clears newly created and reconnected paths without geometry work on pointer transitions', () => {
    const { api, state, paths, hoverNode, leaveCanvas, getPortRectReadCount } = createHarness(1);
    api.updateAllConnections();
    let reads = getPortRectReadCount();
    hoverNode('from');
    assert.equal(paths[0].classList.contains('is-hovered'), true);
    hoverNode('from');
    assert.equal(getPortRectReadCount(), reads, 'moving inside a node performs no geometry reads');

    state.connections.push({ id: 'new-hovered', from: { nodeId: 'from', port: 'text' }, to: { nodeId: 'to', port: 'text' }, type: 'text' });
    api.updateAllConnections();
    assert.equal(paths[1].classList.contains('is-hovered'), true, 'a path created below the pointer is highlighted immediately');
    reads = getPortRectReadCount();
    leaveCanvas();
    assert.ok(paths.every(path => !path.classList.contains('is-hovered')), 'leaving the canvas clears both existing and newly created paths');
    assert.equal(getPortRectReadCount(), reads, 'leaving performs no geometry reads');

    hoverNode('from');
    const other = createNode('other', 400, createPort('text', 'output', 520), createPort('text', 'input', 400));
    state.nodes.set('other', other);
    state.connections[1].from.nodeId = 'other';
    api.updateAllConnections();
    assert.equal(paths[1].classList.contains('is-hovered'), false, 'reconnecting away from the hovered node removes emphasis');
    hoverNode('other');
    assert.equal(paths[1].classList.contains('is-hovered'), true);
    leaveCanvas();
    assert.equal(paths[1].classList.contains('is-hovered'), false);
});

function createRestorationProjection(connections, overrides = {}) {
    return createConnectionProjection({
        projectionHandoffAdapter: connections.projectionHandoffAdapter,
        updateAllConnections: connections.updateAllConnections,
        beginConnectionRestoration: connections.beginConnectionRestoration,
        updateDirtyConnections: connections.updateDirtyConnections,
        invalidateNodePortCache: connections.invalidateNodePortCache,
        markNodeConnectionsDirty: connections.markNodeConnectionsDirty,
        markConnectionDirty: connections.markConnectionDirty,
        ...overrides
    });
}

test('internal drag paths translate without geometry reads while external edges redraw and real geometry invalidates reuse', () => {
    let draws = 0;
    const { api, state, paths, setOutputPortLeft, getPortRectReadCount } = createHarness(2, { distinctTargets: true,
        createBezierPathImpl: (x,y,tx,ty) => { draws++; return `M ${x} ${y} L ${tx} ${ty}`; } });
    api.updateAllConnections();
    const ids = ['from','to-1'];
    state.dragging = { nodes: ids, startPositions: new Map(ids.map(id=>[id,{x:state.nodes.get(id).x,y:state.nodes.get(id).y}])),
        portOffsets: new Map(), isCloneDrag: false };
    const before = paths[0].getAttribute('d');
    for (const id of ids) { state.nodes.get(id).x += 20; api.invalidateNodePortCache(id, { translationOnly: true }); }
    draws = 0;
    api.updateDirtyConnections();
    assert.equal(draws, 1, 'only the cross-selection edge is regenerated');
    assert.equal(paths[0].getAttribute('d'), before);
    assert.equal(paths[0].getAttribute('transform'), 'translate(20, 0)');
    // Isolate the internal edge to prove its fast path reads no port rectangles.
    const reads = getPortRectReadCount();
    api.markConnectionDirty('connection-1');api.updateDirtyConnections();
    assert.equal(getPortRectReadCount(), reads);
    api.invalidateNodePortCache('to-2');api.markConnectionDirty('connection-1');
    draws=0;api.updateDirtyConnections();
    assert.equal(draws,1,'unrelated endpoint geometry does not invalidate the internal edge');
    api.invalidateNodePortCache('from',{markDirty:false,measurementOnly:true});
    api.markConnectionDirty('connection-1');draws=0;api.updateDirtyConnections();
    assert.equal(draws,0,'fresh alignment measurement alone retains the rendered geometry baseline');
    state.dragging.portOffsets.set('from-text-output', {dx:124,dy:24});
    setOutputPortLeft(180);
    api.invalidateNodePortCache('from');
    draws = 0;api.updateDirtyConnections();
    assert.equal(draws, 2, 'real geometry invalidates both internal and boundary edges');
    assert.equal(paths[0].getAttribute('transform'), '');
    assert.match(paths[0].getAttribute('d'), /^M 184 /, 'invalid geometry must not use the drag-start port offset');
    state.nodes.get('from').x += 10;state.nodes.get('to-1').x += 10;
    for(const id of ids)api.invalidateNodePortCache(id,{translationOnly:true});
    api.updateDirtyConnections();
    assert.equal(paths[0].getAttribute('transform'), 'translate(10, 0)', 'reuse rebases after geometry refresh');
    state.dragging = null;
    for(const id of ids)api.invalidateNodePortCache(id);
    api.updateDirtyConnections();
    assert.equal(paths[0].getAttribute('transform'), '', 'settlement removes temporary path translation');
});

test('drag reuse falls back on unequal movement zoom routing and hidden ports', () => {
    const {api,state,paths,setPortsVisible}=createHarness(1);
    api.updateAllConnections();
    state.dragging={nodes:['from','to'],portOffsets:new Map(),isCloneDrag:false};
    const move = () => {
        for(const id of ['from','to']) {state.nodes.get(id).x+=10;api.invalidateNodePortCache(id,{translationOnly:true});}
        api.updateDirtyConnections();
    };
    move();assert.match(paths[0].getAttribute('transform'),/translate/);
    state.nodes.get('from').x+=5;api.markConnectionDirty('connection-1');api.updateDirtyConnections();
    assert.equal(paths[0].getAttribute('transform'),'');
    move();state.canvas.zoom=2;api.markConnectionDirty('connection-1');api.updateDirtyConnections();
    assert.equal(paths[0].getAttribute('transform'),'');
    move();state.connectionLineType='orthogonal';api.markConnectionDirty('connection-1');api.updateDirtyConnections();
    assert.equal(paths[0].getAttribute('transform'),'');
    move();setPortsVisible(false);api.invalidateNodePortCache('from');api.updateDirtyConnections();
    assert.equal(paths[0].getAttribute('d'),'');
    assert.equal(paths[0].getAttribute('transform'),'');
});

test('offscreen paths and shared SVG layers skip identical attributes while retaining all 400 connections and real geometry changes', () => {
    const { api, state, paths, connectionsGroup, originAxes } = createHarness(400);
    api.updateAllConnections();
    assert.equal(paths.length, 400);
    const originalPaths = paths.slice();
    const writes = [];
    for (const [id, element] of [...paths.map((path, index) => [`path-${index}`, path]), ['connections', connectionsGroup], ['axes', originAxes]]) {
        const setAttribute = element.setAttribute;
        element.setAttribute = (name, value) => {
            if (name === 'd' || name === 'transform') writes.push({ id, name, value });
            return setAttribute(name, value);
        };
    }
    for (const node of state.nodes.values()) node.y = 4000;
    api.updateAllConnections();
    assert.equal(paths.filter(path => path.getAttribute('d') === '').length, 400, 'moving both endpoints offscreen clears each real visible path');
    assert.equal(writes.filter(write => write.name === 'd').length, 400);
    writes.length = 0;
    api.updateAllConnections();
    api.markNodeConnectionsDirty('from');
    api.updateDirtyConnections();
    assert.equal(writes.length, 0, 'whole and dirty projections do not rewrite already-empty paths or unchanged layer transforms');
    assert.equal(state.connections.length, 400, 'the complete graph and maintenance workload remain intact');
    assert.deepEqual(paths, originalPaths, 'projection keeps the same 400 path objects');

    Object.assign(state.canvas, { x: 31, y: 47, zoom: .5 });
    api.updateAllConnections();
    assert.deepEqual(writes, [
        { id: 'connections', name: 'transform', value: 'translate(31, 47) scale(0.5)' },
        { id: 'axes', name: 'transform', value: 'translate(31, 47) scale(0.5)' }
    ], 'a real viewport change updates both SVG layers without touching empty paths');
    writes.length = 0;
    for (const node of state.nodes.values()) node.y = 0;
    api.updateAllConnections();
    assert.equal(paths.filter(path => path.getAttribute('d')).length, 400, 'returning endpoints to view restores every real path');
    assert.equal(writes.filter(write => write.name === 'd').length, 400);
    writes.length = 0;
    api.updateAllConnections();
    assert.deepEqual(writes, [], 'the stable visible geometry also keeps its existing SVG attributes');
});

test('cut hit-testing samples nearby routes once until the route or endpoint changes', () => {
    let sampled = 0;
    const { api, state, setOutputPortLeft } = createHarness(2, {
        distinctTargets: true,
        sampleConnection(...args) {
            sampled += 1;
            return getConnectionSamplePoints(...args);
        }
    });
    const distantSource = createNode('distant-source', 5000, createPort('text', 'output', 5120), createPort('text', 'input', 5000));
    const distantTarget = createNode('distant-target', 5500, createPort('text', 'output', 5620), createPort('text', 'input', 5500));
    state.nodes.set(distantSource.id, distantSource);
    state.nodes.set(distantTarget.id, distantTarget);
    state.connections[1].from.nodeId = distantSource.id;
    state.connections[1].to.nodeId = distantTarget.id;
    const segments = [[{ x: 170, y: 0 }, { x: 170, y: 60 }]];

    assert.deepEqual([...api.findConnectionsCrossingSegments(segments)], ['connection-1']);
    assert.deepEqual([...api.findConnectionsCrossingSegments(segments)], ['connection-1']);
    assert.equal(sampled, 1, 'distant connections are not sampled and the nearby route is reused');

    state.connectionLineType = 'orthogonal';
    assert.deepEqual([...api.findConnectionsCrossingSegments(segments)], ['connection-1']);
    assert.equal(sampled, 2, 'changing the route invalidates cached samples');

    setOutputPortLeft(190);
    api.invalidateNodePortCache('from');
    assert.deepEqual([...api.findConnectionsCrossingSegments(segments)], []);
    assert.equal(sampled, 3, 'fresh endpoint geometry is tested');

    state.runningNodeIds.add('from');
    assert.deepEqual([...api.findConnectionsCrossingSegments([[{ x: 205, y: 0 }, { x: 205, y: 60 }]])], []);
    assert.equal(sampled, 3, 'running endpoint protection is checked live');
});

test('insertion preview reuses local curve samples and checks the actual release position', () => {
    let sampled = 0;
    const { api, state } = createHarness(2, {
        distinctTargets: true,
        sampleConnection(...args) {
            sampled += 1;
            return getConnectionSamplePoints(...args);
        }
    });
    const distantSource = createNode('distant-source', 5000, createPort('text', 'output', 5120), createPort('text', 'input', 5000));
    const distantTarget = createNode('distant-target', 5500, createPort('text', 'output', 5620), createPort('text', 'input', 5500));
    state.nodes.set(distantSource.id, distantSource);
    state.nodes.set(distantTarget.id, distantTarget);
    state.connections[1].from.nodeId = distantSource.id;
    state.connections[1].to.nodeId = distantTarget.id;
    const insert = createNode('insert', 140, createPort('text', 'output', 260), createPort('text', 'input', 140));
    insert.el.querySelector = selector => insert.el.querySelectorAll(selector)[0];
    state.nodes.set(insert.id, insert);
    state.dragging = { nodes: [insert.id] };

    api.updateDirtyConnections();
    assert.equal(state.connectionInsertPreview?.connectionId, 'connection-1');
    insert.x += 10;
    api.markNodeConnectionsDirty(insert.id);
    api.updateDirtyConnections();
    assert.equal(state.connectionInsertPreview?.connectionId, 'connection-1');
    assert.equal(sampled, 1, 'the moving isolated node keeps the nearby curve geometry cached');

    insert.x = 600;
    assert.equal(api.commitConnectionInsertPreview({ refresh: true }), false);
    assert.equal(state.connectionInsertPreview, null);
    assert.equal(state.connections.length, 2, 'releasing away from the line leaves both edges intact');
});

test('repeated connection projection only changes insertion highlight classes when the candidate changes', () => {
    const { api, state, paths } = createHarness(2);
    api.updateAllConnections();
    const input = createPort('text', 'input', 160);
    const output = createPort('text', 'output', 280);
    const first = createNode('insert-first', 140, output, input);
    const second = createNode('insert-second', 140, output, input);
    state.nodes.set(first.id, first);
    state.nodes.set(second.id, second);
    const writes = [];
    for (const [id, element] of [...state.nodes].map(([id, node]) => [id, node.el]).concat(paths.map((path, index) => [`path-${index}`, path]))) {
        for (const method of ['add', 'remove']) {
            const original = element.classList[method];
            element.classList[method] = (...names) => {
                for (const name of names) if (name.startsWith('connection-insert-')) writes.push({ id, method, name });
                return original(...names);
            };
        }
        const toggle = element.classList.toggle;
        element.classList.toggle = (name, enabled) => {
            if (name.startsWith('connection-insert-')) writes.push({ id, method: 'toggle', name, enabled });
            return toggle(name, enabled);
        };
    }
    api.updateAllConnections();
    api.markNodeConnectionsDirty('from');
    api.updateDirtyConnections();
    assert.deepEqual(writes, [], 'refreshing a graph without an insertion candidate must not write identical class attributes');

    state.connectionInsertPreview = { connectionId: 'connection-1', nodeId: first.id, inputPort: 'text', outputPort: 'text' };
    api.updateAllConnections();
    assert.equal(first.el.classList.contains('connection-insert-candidate'), true);
    assert.equal(paths[0].classList.contains('connection-insert-target'), true);
    writes.length = 0;
    api.updateAllConnections();
    assert.deepEqual(writes, [], 'an unchanged visible candidate retains its highlight without removing and readding classes');

    state.connectionInsertPreview = { connectionId: 'connection-2', nodeId: second.id, inputPort: 'text', outputPort: 'text' };
    api.updateAllConnections();
    assert.equal(first.el.classList.contains('connection-insert-candidate'), false);
    assert.equal(paths[0].classList.contains('connection-insert-target'), false);
    assert.equal(second.el.classList.contains('connection-insert-candidate'), true);
    assert.equal(paths[1].classList.contains('connection-insert-target'), true);
    assert.equal(writes.length, 4, 'switching candidate updates only the old and new node and path');
    writes.length = 0;
    api.clearConnectionInsertPreview();
    assert.equal(second.el.classList.contains('connection-insert-candidate'), false);
    assert.equal(paths[1].classList.contains('connection-insert-target'), false);
    assert.equal(writes.length, 2, 'clearing removes both actual highlights');
    writes.length = 0;
    api.clearConnectionInsertPreview();
    api.updateAllConnections();
    assert.deepEqual(writes, [], 'a cleared preview does not resume writing empty highlights');
});

test('node dirty intents defer index validation and dirty rendering scans linearly', () => {
    const { api, state } = createHarness(40);
    api.updateAllConnections();
    let reads = 0;
    state.connections.forEach((connection) => {
        const type = connection.type;
        Object.defineProperty(connection, 'type', { get() { reads += 1; return type; } });
    });
    for (let index = 0; index < 10; index += 1) api.markNodeConnectionsDirty('from');
    assert.equal(reads, 0);
    assert.equal(api.updateDirtyConnections(), true);
    assert.ok(reads < 40 * 15, `expected linear reads, got ${reads}`);
});

test('deferred node dirty intents resolve against the current topology', () => {
    const { api, state, paths } = createHarness(1);
    api.updateAllConnections();
    api.markNodeConnectionsDirty('from');
    state.connections.push({ ...state.connections[0], id: 'new-connection' });
    assert.equal(api.updateDirtyConnections(), true);
    assert.ok(paths.some((path) => path.getAttribute('data-conn-id') === 'new-connection'));
});

test('connection restoration materializes only the requested batch', () => {
    const { api, paths } = createHarness(201);

    const restoration = api.beginConnectionRestoration();
    assert.equal(restoration.renderNextBatch(100), false);
    assert.equal(paths.length, 100);
    assert.equal(restoration.renderNextBatch(100), false);
    assert.equal(paths.length, 200);
    assert.equal(restoration.renderNextBatch(100), true);
    assert.equal(paths.length, 201);
    restoration.finish({ completed: true });
});

test('connection restoration reuses the lane map across batches until layout invalidation', () => {
    const { api, getConnectionForEachReadCount } = createHarness(201, { distinctTargets: true });

    const restoration = api.beginConnectionRestoration();
    restoration.renderNextBatch(100);
    const firstBatchReads = getConnectionForEachReadCount();
    assert.ok(firstBatchReads >= 2);

    restoration.renderNextBatch(100);
    assert.equal(getConnectionForEachReadCount(), firstBatchReads);

    api.markNodeConnectionsDirty('from');
    restoration.renderNextBatch(100);
    assert.ok(getConnectionForEachReadCount() > firstBatchReads);
    restoration.finish({ completed: false });
});

test('connection restoration rebuilds the lane map after topology index invalidation', () => {
    const { api, state, getConnectionForEachReadCount } = createHarness(201, { distinctTargets: true });

    const restoration = api.beginConnectionRestoration();
    restoration.renderNextBatch(100);
    const firstBatchReads = getConnectionForEachReadCount();

    state.connections.push({
        ...state.connections[0],
        id: 'connection-extra'
    });
    api.rebuildConnectionIndex();
    restoration.renderNextBatch(100);

    assert.ok(getConnectionForEachReadCount() > firstBatchReads);
    restoration.finish({ completed: false });
});

test('connection restoration materializes only connections near the viewport', () => {
    const { api, state, paths } = createHarness(2, { distinctTargets: true });
    const offscreenSource = { ...state.nodes.get('to-2'), id: 'from-2', x: 1800 };
    state.nodes.set(offscreenSource.id, offscreenSource);
    state.nodes.get('to-2').x = 2000;
    state.connections[1].from.nodeId = offscreenSource.id;

    const restoration = api.beginConnectionRestoration();
    assert.equal(restoration.renderViewport(), true);
    restoration.finish({ completed: true });

    assert.equal(paths.length, 1);
    assert.equal(paths[0].getAttribute('data-conn-id'), 'connection-1');
});

test('one full refresh keeps never-rendered offscreen connections culled until they enter view', () => {
    const { api, state, paths, getPortRectReadCount } = createHarness(1);
    state.nodes.get('from').x = 2000;
    state.nodes.get('to').x = 2200;

    api.updateAllConnections();
    assert.deepEqual(api.detectMisalignedConnections(), []);
    assert.equal(paths.length, 0);
    assert.equal(getPortRectReadCount(), 0);

    state.canvas.x = -2000;
    api.updateAllConnections();
    assert.ok(paths[0]?.getAttribute('d'));
});

test('restoration renders a long connection crossing the viewport with both endpoints offscreen', () => {
    const { api, state, paths } = createHarness(1, {
        createBezierPathImpl: (fromX, fromY, toX, toY) => `M ${fromX} ${fromY} L ${toX} ${toY}`
    });
    const source = state.nodes.get('from');
    const target = state.nodes.get('to');
    source.x = -600;
    target.x = 1300;
    const output = createPort('text', 'output', source.x + source.width);
    const input = createPort('text', 'input', target.x);
    state.nodes.set(source.id, createNode(source.id, source.x, output, input));
    state.nodes.set(target.id, createNode(target.id, target.x, output, input));

    const restoration = api.beginConnectionRestoration();
    restoration.renderViewport();
    restoration.finish({ completed: true });

    assert.equal(paths[0]?.getAttribute('d'), 'M -476 24 L 1304 24');
    api.updateAllConnections();
    assert.equal(paths[0]?.getAttribute('d'), 'M -476 24 L 1304 24');
});

test('pan and zoom settlement measure newly visible connections and defer distant ones', async () => {
    const { api, state, frames, paths } = createHarness(3, { distinctTargets: true });
    let visiblePortReads = 0;
    let distantPortReads = 0;
    function addConnectionNodes(index, x, onRead) {
        const outputPort = createPort('text', 'output', () => x + 120 + state.canvas.x, onRead);
        const inputPort = createPort('text', 'input', () => x + 200 + state.canvas.x, onRead);
        const source = createNode(`from-${index}`, x, outputPort, inputPort);
        const target = createNode(`to-${index}`, x + 200, outputPort, inputPort);
        state.nodes.set(source.id, source);
        state.nodes.set(target.id, target);
        state.connections[index - 1].from.nodeId = source.id;
    }
    addConnectionNodes(2, 1800, () => { visiblePortReads += 1; });
    addConnectionNodes(3, 4200, () => { distantPortReads += 1; });
    const restoration = api.beginConnectionRestoration();
    restoration.renderViewport();
    restoration.finish({ completed: true });
    assert.deepEqual(paths.map(path => path.getAttribute('data-conn-id')), ['connection-1']);

    const projection = createRestorationProjection(api, {
        detectMisalignedConnections: api.detectMisalignedConnections,
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });
    for (const [kind, x, expected] of [['pan', -1800, 'connection-2'], ['zoom', -4200, 'connection-3']]) {
        const finished = projection.interactions.beginInteraction(kind).finish();
        state.canvas.x = x;
        frames.shift()(0);
        await finished;
        assert.ok(paths.find(path => path.getAttribute('data-conn-id') === expected)?.getAttribute('d'));
        if (kind === 'pan') {
            assert.ok(visiblePortReads > 0);
            assert.equal(distantPortReads, 0, 'distant, unmaterialized endpoints need no measurements');
        }
    }
    assert.ok(distantPortReads > 0, 'a later viewport change measures the newly visible endpoints');
});

test('adopted connection projection is reindexed by the visible renderer', () => {
    const { api, paths } = createHarness(1);
    const frame = () => 1;
    const source = createConnectionProjection({
        projectionHandoffAdapter: {
            capture: () => [{
                id: 'connection-1',
                d: 'M 10 20 L 30 40',
                selected: true
            }]
        },
        requestAnimationFrameRef: frame,
        cancelAnimationFrameRef: () => {}
    });
    const target = createRestorationProjection(api, {
        projectionHandoffAdapter: api.projectionHandoffAdapter,
        requestAnimationFrameRef: frame,
        cancelAnimationFrameRef: () => {}
    });

    target.maintenance.adoptViewHandoff(source.maintenance.captureViewHandoff());

    assert.equal(paths[0].getAttribute('d'), 'M 10 20 L 30 40');
    assert.equal(paths[0].classList.contains('selected'), true);
    assert.equal(api.deleteConnection('connection-1'), true);
    assert.equal(paths[0].removed, true);
});

test('adopting an empty startup projection materializes visible connections', () => {
    const { api, paths, frames } = createHarness(1);
    const queueFrame = (callback) => {
        frames.push(callback);
        return frames.length;
    };
    const source = createConnectionProjection({
        projectionHandoffAdapter: { capture: () => [{ id: 'connection-1', d: '' }] },
        requestAnimationFrameRef: queueFrame,
        cancelAnimationFrameRef: () => {}
    });
    const target = createRestorationProjection(api, {
        requestAnimationFrameRef: queueFrame,
        cancelAnimationFrameRef: () => {}
    });

    target.maintenance.adoptViewHandoff(source.maintenance.captureViewHandoff());

    assert.equal(paths.length, 1);
    assert.notEqual(paths[0].getAttribute('d'), '');
});

test('adopting an empty startup projection retries after desktop ports receive layout', async () => {
    const { api, paths, frames, setPortsVisible } = createHarness(1, {
        portsInitiallyVisible: false
    });
    const queueFrame = (callback) => {
        frames.push(callback);
        return frames.length;
    };
    const source = createConnectionProjection({
        projectionHandoffAdapter: {
            capture: () => [{ id: 'connection-1', d: '' }]
        },
        requestAnimationFrameRef: queueFrame,
        cancelAnimationFrameRef: () => {}
    });
    const target = createRestorationProjection(api, {
        projectionHandoffAdapter: api.projectionHandoffAdapter,
        requestAnimationFrameRef: queueFrame,
        cancelAnimationFrameRef: () => {}
    });

    target.maintenance.adoptViewHandoff(source.maintenance.captureViewHandoff());
    assert.equal(paths[0]?.getAttribute('d') || '', '');

    frames.shift()(0);
    await Promise.resolve();
    assert.equal(paths[0].getAttribute('d'), '');

    setPortsVisible(true);
    while (frames.length) {
        frames.shift()(0);
        await Promise.resolve();
    }
    assert.notEqual(paths[0].getAttribute('d'), '');
});

test('adopting an empty projection stops scheduling frames when ports never receive layout', async () => {
    const { api, frames } = createHarness(1, { portsInitiallyVisible: false });
    const queueFrame = (callback) => {
        frames.push(callback);
        return frames.length;
    };
    const source = createConnectionProjection({
        projectionHandoffAdapter: { capture: () => [{ id: 'connection-1', d: '' }] },
        requestAnimationFrameRef: queueFrame,
        cancelAnimationFrameRef: () => {}
    });
    const target = createRestorationProjection(api, {
        projectionHandoffAdapter: api.projectionHandoffAdapter,
        requestAnimationFrameRef: queueFrame,
        cancelAnimationFrameRef: () => {}
    });

    target.maintenance.adoptViewHandoff(source.maintenance.captureViewHandoff());
    let executedFrames = 0;
    while (executedFrames < 6) {
        assert.ok(frames.length > 0);
        frames.shift()(0);
        executedFrames += 1;
        await Promise.resolve();
    }

    assert.equal(frames.length, 0);
});

test('destroying ConnectionProjection cancels adopted handoff settlement', () => {
    const cancelledFrames = [];
    const { api, frames } = createHarness(1, { portsInitiallyVisible: false });
    const queueFrame = (callback) => {
        frames.push(callback);
        return frames.length;
    };
    const source = createConnectionProjection({
        projectionHandoffAdapter: { capture: () => [{ id: 'connection-1', d: '' }] },
        requestAnimationFrameRef: queueFrame,
        cancelAnimationFrameRef: () => {}
    });
    const target = createRestorationProjection(api, {
        projectionHandoffAdapter: api.projectionHandoffAdapter,
        requestAnimationFrameRef: queueFrame,
        cancelAnimationFrameRef: (frameId) => cancelledFrames.push(frameId)
    });

    target.maintenance.adoptViewHandoff(source.maintenance.captureViewHandoff());
    target.destroy();

    assert.deepEqual(cancelledFrames, [1]);
});

test('ConnectionProjection transfers a renderer-owned view through an opaque handoff', () => {
    let adopted = null;
    const { api } = createHarness(0);
    const projection = createRestorationProjection(api, {
        projectionHandoffAdapter: {
            capture: () => ({ rendererCache: 'private-cache' }),
            adopt: (snapshot) => { adopted = snapshot; }
        },
        requestAnimationFrameRef: () => 1,
        cancelAnimationFrameRef: () => {}
    });

    const handoff = projection.maintenance.captureViewHandoff();
    assert.equal(handoff.rendererCache, undefined);
    assert.equal(projection.maintenance.adoptViewHandoff(handoff), true);
    assert.deepEqual(adopted, { rendererCache: 'private-cache' });
});

test('destroying connections cancels flow animation and removes derived paths', () => {
    const cancelledFrames = [];
    const { api, paths } = createHarness(1, {
        running: true,
        requestAnimationFrameImpl: () => 42,
        cancelAnimationFrameImpl: (id) => cancelledFrames.push(id)
    });
    api.updateAllConnections();

    api.destroy();

    assert.deepEqual(cancelledFrames, [42]);
    assert.equal(paths[0].removed, true);
});

test('whole connection projection refreshes stale port geometry', () => {
    const { api, paths, setOutputPortLeft } = createHarness(1);

    api.updateAllConnections();
    const initialPath = paths[0].getAttribute('d');
    setOutputPortLeft(160);
    api.updateAllConnections();

    assert.notEqual(paths[0].getAttribute('d'), initialPath);
});

test('whole connection projection measures each node port once per refresh', () => {
    const { api, getPortRectReadCount } = createHarness(200);

    api.updateAllConnections();
    assert.equal(getPortRectReadCount(), 4);

    api.updateAllConnections();
    assert.equal(getPortRectReadCount(), 8);
});

test('later restoration batches use current selection and ignore stale active-node history', () => {
    const { api, state, paths } = createHarness(201);

    const restoration = api.beginConnectionRestoration();
    restoration.renderNextBatch(100);
    assert.equal(paths[0].classList.contains('selected'), false);

    state.activeNodeRelationCache = {
        anchorNodeId: 'from',
        incomingConnectionIds: [],
        outgoingConnectionIds: []
    };
    restoration.renderNextBatch(100);
    restoration.finish({ completed: false });

    assert.equal(paths[100].classList.contains('selected'), false);
    state.selectedNodes.add('from');
    api.updateAllConnections();
    assert.equal(paths[100].classList.contains('selected'), true);
});

test('later restoration batches use the latest node geometry when assigning connection lanes', () => {
    const { api, state, paths } = createHarness(201, {
        distinctTargets: true,
        createBezierPathImpl: (_fromX, _fromY, _toX, _toY, options) => String(options.laneOffset)
    });

    const restoration = api.beginConnectionRestoration();
    restoration.renderNextBatch(100);
    state.nodes.get('to-101').y = -1000;
    api.markNodeConnectionsDirty('to-101');
    restoration.renderNextBatch(100);
    restoration.finish({ completed: false });

    assert.equal(paths[100].getAttribute('d'), '-42');
});

test('connection projection reapplies geometry intents received during restoration', async () => {
    const { api: connections, frames, paths, setOutputPortLeft } = createHarness(201);
    const projection = createRestorationProjection(connections, {
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });

    const restoring = projection.maintenance.workflowRestored();
    const originalPath = paths[0].getAttribute('d');
    setOutputPortLeft(160);
    projection.interactions.nodeGeometryChanged('from');

    while (frames.length) {
        frames.shift()(0);
        await Promise.resolve();
    }
    await restoring;

    assert.notEqual(paths[0].getAttribute('d'), originalPath);
});

test('workflow restoration corrects port geometry that settles on the next layout frame', async () => {
    const { api: connections, frames, paths, setOutputPortLeft } = createHarness(1);
    let alignmentReason = '';
    const projection = createRestorationProjection(connections, {
        detectMisalignedConnections: connections.detectMisalignedConnections,
        onAlignmentCorrected: ({ reason }) => { alignmentReason = reason; },
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });

    let settled = false;
    const restoring = projection.maintenance.workflowRestored().then(() => { settled = true; });
    await Promise.resolve();
    const initialPath = paths[0].getAttribute('d');
    setOutputPortLeft(160);

    assert.equal(settled, false);
    assert.equal(frames.length, 1);
    frames.shift()(0);
    await restoring;
    await Promise.resolve();

    assert.equal(settled, true);
    assert.equal(paths[0].getAttribute('d'), initialPath, 'activation should not wait for whole-workflow alignment');
    assert.equal(frames.length, 1);
    frames.shift()(0);
    await Promise.resolve();

    assert.notEqual(paths[0].getAttribute('d'), initialPath);
    assert.equal(alignmentReason, 'workflow-restored-late-frame');
});

test('workflow restoration corrects port geometry that settles one frame after startup alignment', async () => {
    const { api: connections, frames, paths, setOutputPortLeft } = createHarness(1);
    const projection = createRestorationProjection(connections, {
        detectMisalignedConnections: connections.detectMisalignedConnections,
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });

    const restoring = projection.maintenance.workflowRestored();
    const initialPath = paths[0].getAttribute('d');
    frames.shift()(0);
    await restoring;
    await Promise.resolve();

    setOutputPortLeft(160);
    assert.equal(frames.length, 1, 'startup must schedule a late alignment check for deferred layout');
    frames.shift()(0);
    await Promise.resolve();

    assert.notEqual(paths[0].getAttribute('d'), initialPath);
});

test('workflow restoration materializes a connection whose ports become visible on the next layout frame', async () => {
    const { api: connections, frames, paths, setPortsVisible } = createHarness(1, {
        portsInitiallyVisible: false
    });
    const projection = createRestorationProjection(connections, {
        detectMisalignedConnections: connections.detectMisalignedConnections,
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });

    const restoring = projection.maintenance.workflowRestored();
    assert.equal(paths.length, 0);

    setPortsVisible(true);
    frames.shift()(0);
    await restoring;

    assert.equal(paths.length, 1);
    assert.notEqual(paths[0].getAttribute('d'), '');
});

test('workflow restoration stays pending until late desktop port layout materializes', async () => {
    const { api: connections, frames, paths, setPortsVisible } = createHarness(1, {
        portsInitiallyVisible: false
    });
    const projection = createRestorationProjection(connections, {
        detectMisalignedConnections: connections.detectMisalignedConnections,
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });

    let settled = false;
    const restoring = projection.maintenance.workflowRestored().then(() => { settled = true; });
    frames.shift()(0);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(settled, false);
    assert.equal(paths[0]?.getAttribute('d') || '', '');
    assert.ok(frames.length > 0);
    setPortsVisible(true);
    frames.shift()(0);
    await restoring;

    assert.notEqual(paths[0].getAttribute('d'), '');
});

test('workflow restoration resumes after its frame budget when layout reports geometry', async () => {
    const { api: connections, frames, paths, setPortsVisible } = createHarness(1, {
        portsInitiallyVisible: false
    });
    const projection = createRestorationProjection(connections, {
        detectMisalignedConnections: connections.detectMisalignedConnections,
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });

    let settled = false;
    const restoring = projection.maintenance.workflowRestored().then(() => { settled = true; });
    for (let frame = 0; frame < 7; frame += 1) {
        frames.shift()(0);
        await Promise.resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(settled, false);
    setPortsVisible(true);
    projection.interactions.nodeGeometryChanged(['from', 'to']);
    await restoring;

    assert.notEqual(paths[0].getAttribute('d'), '');
});

test('superseded workflow restoration releases its materialization wait', async () => {
    const { api: connections, frames } = createHarness(1, { portsInitiallyVisible: false });
    const projection = createRestorationProjection(connections, {
        detectMisalignedConnections: connections.detectMisalignedConnections,
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });
    const controller = new AbortController();

    const restoring = projection.maintenance.workflowRestored({ signal: controller.signal });
    for (let frame = 0; frame < 7; frame += 1) {
        frames.shift()(0);
        await Promise.resolve();
    }
    controller.abort();

    assert.equal(await restoring, false);
});

test('workflow restoration does not wait for a connection with a missing endpoint', async () => {
    const { api: connections, state, frames } = createHarness(1);
    state.connections[0].from.port = 'missing-port';
    const projection = createRestorationProjection(connections, {
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });

    const restoring = projection.maintenance.workflowRestored();
    frames.shift()(0);

    assert.equal(await restoring, true);
    assert.ok(frames.length <= 1, 'restoration must not start materialization polling');
});

test('workflow restoration does not wait for a connection whose endpoints are both offscreen', async () => {
    const { api: connections, state, frames } = createHarness(1);
    state.nodes.get('from').x = 2000;
    state.nodes.get('to').x = 2200;
    connections.projectionHandoffAdapter.adopt([]);
    const projection = createRestorationProjection(connections, {
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });

    const restoring = projection.maintenance.workflowRestored();
    frames.shift()(0);

    assert.equal(await restoring, true);
    assert.ok(frames.length <= 1, 'offscreen connections must not start materialization polling');
});

test('workflow restoration reports degraded completion after layout checks are exhausted', async () => {
    const timers = [];
    const { api: connections, frames } = createHarness(1, { portsInitiallyVisible: false });
    const projection = createRestorationProjection(connections, {
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {},
        setTimeoutRef(callback) { timers.push(callback); return timers.length; },
        clearTimeoutRef() {}
    });

    const restoring = projection.maintenance.workflowRestored();
    for (let frame = 0; frame < 7; frame += 1) {
        frames.shift()(0);
        await Promise.resolve();
    }
    while (timers.length) {
        timers.shift()();
        await Promise.resolve();
    }

    assert.equal(await restoring, false);
});

test('workflow restoration repairs ports after timeout wins before the next layout frame', async () => {
    const timers = [];
    const pendingFrames = new Map();
    let nextFrameId = 0;
    const { api: connections, paths, setPortsVisible } = createHarness(1, {
        portsInitiallyVisible: false
    });
    const projection = createRestorationProjection(connections, {
        detectMisalignedConnections: connections.detectMisalignedConnections,
        requestAnimationFrameRef(callback) {
            const frameId = ++nextFrameId;
            pendingFrames.set(frameId, callback);
            return frameId;
        },
        cancelAnimationFrameRef(frameId) { pendingFrames.delete(frameId); },
        setTimeoutRef(callback) {
            timers.push(callback);
            return timers.length;
        },
        clearTimeoutRef() {}
    });

    const restoring = projection.maintenance.workflowRestored();
    timers.shift()();
    await Promise.resolve();
    assert.equal(paths.length, 0);

    setPortsVisible(true);
    assert.equal(pendingFrames.size, 1);
    pendingFrames.values().next().value(0);
    await restoring;

    assert.equal(paths.length, 1);
    assert.notEqual(paths[0].getAttribute('d'), '');
});

test('aligned workflow restoration leaves no pending connection work', async () => {
    const { api: connections, frames } = createHarness(1);
    connections.updateAllConnections();
    const projection = createRestorationProjection(connections, {
        detectMisalignedConnections: connections.detectMisalignedConnections,
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });

    const restoring = projection.maintenance.workflowRestored();
    frames.shift()(0);
    await restoring;

    assert.equal(connections.updateDirtyConnections(), false);
});

test('connection restoration progresses when animation frames are paused', async () => {
    const timers = [];
    const { api: connections, paths } = createHarness(201);
    const projection = createRestorationProjection(connections, {
        requestAnimationFrameRef: () => 1,
        cancelAnimationFrameRef() {},
        setTimeoutRef(callback) {
            timers.push(callback);
            return timers.length;
        },
        clearTimeoutRef() {}
    });

    let settled = false;
    const restoring = projection.maintenance.workflowRestored().then(() => { settled = true; });

    assert.equal(timers.length, 1);
    while (timers.length) {
        timers.shift()();
        await Promise.resolve();
    }
    await restoring;

    assert.equal(paths.length, 201);
    assert.equal(settled, true);
});

test('finishing a Canvas interaction during restoration defers its projection commit', async () => {
    const { api: connections, frames, paths, setOutputPortLeft } = createHarness(201);
    const projection = createRestorationProjection(connections, {
        detectMisalignedConnections: () => [],
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });

    const restoring = projection.maintenance.workflowRestored();
    const originalPath = paths[0].getAttribute('d');
    setOutputPortLeft(160);
    const interaction = projection.interactions.beginInteraction('node-drag', ['from']);
    interaction.changed();
    const finishing = interaction.finish();

    assert.equal(paths[0].getAttribute('d'), originalPath);

    while (frames.length) {
        frames.shift()(0);
        await Promise.resolve();
    }
    await restoring;
    await Promise.resolve();
    while (frames.length) {
        frames.shift()(0);
        await Promise.resolve();
    }
    await finishing;

    assert.notEqual(paths[0].getAttribute('d'), originalPath);
});

test('destroying connection projection stops an in-progress restoration', async () => {
    const { api: connections, frames, paths } = createHarness(201);
    const projection = createRestorationProjection(connections, {
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });

    const restoring = projection.maintenance.workflowRestored();
    const renderedBeforeDestroy = paths.length;
    projection.destroy();

    while (frames.length) {
        frames.shift()(0);
        await Promise.resolve();
    }
    await restoring;

    assert.equal(paths.length, renderedBeforeDestroy);
});

test('alignment verification waits for workflow restoration before updating paths', async () => {
    const { api: connections, frames, paths, setOutputPortLeft } = createHarness(201);
    let alignmentChecks = 0;
    const projection = createRestorationProjection(connections, {
        detectMisalignedConnections: () => {
            alignmentChecks += 1;
            return [{ connectionId: 'connection-1' }];
        },
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });

    const restoring = projection.maintenance.workflowRestored();
    const originalPath = paths[0].getAttribute('d');
    setOutputPortLeft(160);
    const interaction = projection.interactions.beginInteraction('node-drag', ['from']);
    interaction.changed();
    const finishing = interaction.finish();

    frames.shift()(0);
    await Promise.resolve();

    assert.equal(paths[0].getAttribute('d'), originalPath);
    assert.equal(alignmentChecks, 0);

    while (frames.length) {
        frames.shift()(0);
        await Promise.resolve();
    }
    await restoring;
    await Promise.resolve();
    while (frames.length) {
        frames.shift()(0);
        await Promise.resolve();
    }
    await finishing;
    assert.notEqual(paths[0].getAttribute('d'), originalPath);
});

test('a full connection refresh renders once with performance sampling on or off', () => {
    for (const search of ['', '?perf=1']) {
        const renderedConnections = [];
        const { api } = createHarness(2, {
            performanceMonitor: createCanvasPerformanceMonitor({ globalRef: { location: { search } } }),
            createBezierPathImpl(fromX, fromY, toX, toY) {
                renderedConnections.push(`M ${fromX} ${fromY} L ${toX} ${toY}`);
                return renderedConnections.at(-1);
            }
        });

        api.updateAllConnections();

        assert.equal(renderedConnections.length, 2, `one render per connection with search "${search}"`);
    }
});

test('connection restoration closes its renderer transaction after a render failure', async () => {
    const lifecycle = [];
    let failRendering = true;
    const { api: connections } = createHarness(1, {
        createBezierPathImpl() {
            if (failRendering) throw new Error('render failed');
            return 'M 0 0 L 1 1';
        },
        connectionRenderer: {
            enabled: false,
            begin() { lifecycle.push('begin'); },
            draw() {},
            remove() {},
            end() { lifecycle.push('end'); }
        }
    });
    const projection = createRestorationProjection(connections, {
        requestAnimationFrameRef: (callback) => callback(),
        cancelAnimationFrameRef() {}
    });

    await assert.rejects(
        async () => projection.maintenance.workflowRestored(),
        /render failed/
    );
    assert.deepEqual(lifecycle, ['begin', 'end']);

    failRendering = false;
    await projection.maintenance.workflowRestored();
    assert.deepEqual(lifecycle, ['begin', 'end', 'begin', 'end']);
});

test('connection restoration closes its renderer transaction after a completion failure', () => {
    const lifecycle = [];
    let failCompletion = false;
    const { api, state } = createHarness(1, {
        createBezierPathImpl() {
            if (failCompletion) throw new Error('completion failed');
            return 'M 0 0 L 1 1';
        },
        connectionRenderer: {
            enabled: false,
            begin() { lifecycle.push('begin'); },
            draw() {},
            remove() {},
            end() { lifecycle.push('end'); }
        }
    });

    const restoration = api.beginConnectionRestoration();
    assert.equal(restoration.renderNextBatch(100), true);
    state.connectionInsertPreview = {
        connectionId: 'connection-1',
        nodeId: 'to',
        inputPort: 'text',
        outputPort: 'text'
    };
    failCompletion = true;

    assert.throws(
        () => restoration.finish({ completed: true }),
        /completion failed/
    );
    assert.deepEqual(lifecycle, ['begin', 'end']);
});
