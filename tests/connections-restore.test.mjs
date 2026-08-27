import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionsApi } from '../js/canvas/connections.js';
import { createConnectionProjection } from '../js/canvas/connection-projection.js';

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
            querySelectorAll(selector) {
                if (selector.includes('data-direction="output"')) return [outputPort];
                if (selector.includes('data-direction="input"')) return [inputPort];
                if (selector.includes('.node-port')) return ports;
                return [];
            }
        }
    };
}

function createHarness(connectionCount, {
    requestAnimationFrameImpl,
    cancelAnimationFrameImpl,
    setTimeoutImpl,
    createBezierPathImpl,
    connectionRenderer,
    distinctTargets = false,
    portsInitiallyVisible = true,
    running = false
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
    const state = {
        nodes,
        connections: Array.from({ length: connectionCount }, (_, index) => ({
            id: `connection-${index + 1}`,
            from: { nodeId: 'from', port: 'text' },
            to: { nodeId: distinctTargets ? `to-${index + 1}` : 'to', port: 'text' },
            type: 'text'
        })),
        selectedNodes: new Set(),
        runningNodeIds: new Set(running ? ['from'] : []),
        canvas: { x: 0, y: 0, zoom: 1, isPanning: false }
    };
    const connectionsGroup = {
        setAttribute() {},
        classList: createClassList(),
        appendChild(path) { paths.push(path); }
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
    const api = createConnectionsApi({
        state,
        canvasContainer: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) },
        connectionsGroup,
        tempConnection: { setAttribute() {} },
        originAxes: null,
        getNodeById: (id) => nodes.get(id),
        createBezierPath: (fromX, fromY, toX, toY, options) => createBezierPathImpl
            ? createBezierPathImpl(fromX, fromY, toX, toY, options)
            : `M ${fromX} ${fromY} L ${toX} ${toY}`,
        getConnectionSamplePoints: () => [],
        pushHistory: () => {},
        showToast: () => {},
        scheduleSave: () => {},
        documentRef,
        connectionRenderer
    });
    return {
        api,
        state,
        frames,
        paths,
        getPortRectReadCount() { return portRectReads; },
        setPortsVisible(visible) { portsVisible = visible; },
        setOutputPortLeft(left) { outputPortLeft = left; }
    };
}

function createRestorationProjection(connections, overrides = {}) {
    return createConnectionProjection({
        updateAllConnections: connections.updateAllConnections,
        beginConnectionRestoration: connections.beginConnectionRestoration,
        updateDirtyConnections: connections.updateDirtyConnections,
        invalidateNodePortCache: connections.invalidateNodePortCache,
        markNodeConnectionsDirty: connections.markNodeConnectionsDirty,
        markConnectionDirty: connections.markConnectionDirty,
        ...overrides
    });
}

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

test('later restoration batches use the latest active connection selection', () => {
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

    assert.notEqual(paths[0].getAttribute('d'), initialPath);
    assert.equal(alignmentReason, 'workflow-restored');
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
    await restoring;
    await Promise.resolve();
    assert.equal(paths.length, 0);

    setPortsVisible(true);
    assert.equal(pendingFrames.size, 1);
    pendingFrames.values().next().value(0);
    await Promise.resolve();

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
