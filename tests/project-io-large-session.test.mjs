import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectIoApi } from '../js/features/persistence/project-io.js';
import { createViewportApi } from '../js/canvas/viewport.js';

function createHarness(nodeCount, connectionCount = 0, overrides = {}) {
    const scheduledTasks = [];
    const restoredNodeIds = [];
    let wholeProjectionUpdates = 0;
    const state = {
        providers: [],
        models: [],
        nodes: new Map(),
        connections: [],
        selectedNodes: new Set(),
        canvas: { x: 0, y: 0, zoom: 1 },
        workflowTabs: [],
        workflowFolders: []
    };
    const session = {
        canvas: overrides.canvas,
        nodes: Array.from({ length: nodeCount }, (_, index) => ({
            id: `node-${index + 1}`,
            type: 'Text',
            x: index,
            y: index
        })),
        connections: Array.from({ length: connectionCount }, (_, index) => ({
            id: `connection-${index + 1}`,
            from: { nodeId: `node-${(index % nodeCount) + 1}`, port: 'text' },
            to: { nodeId: `node-${((index + 1) % nodeCount) + 1}`, port: 'text' }
        }))
    };
    const api = createProjectIoApi({
        state,
        storageKey: 'session',
        localStorageRef: { getItem: () => JSON.stringify(session) },
        documentRef: { getElementById: () => null },
        windowRef: {
            setTimeout(callback, delay = 0) {
                scheduledTasks.push({ callback, delay });
                return scheduledTasks.length;
            }
        },
        getHandle: async () => null,
        addNode(type, x, y, nodeData) {
            restoredNodeIds.push(nodeData.id);
            state.nodes.set(nodeData.id, { ...nodeData });
        },
        applyHistoryGridCols: () => {},
        connectionProjectionMaintenance: overrides.connectionProjectionMaintenance || {
            workflowRestored: async () => { wholeProjectionUpdates += 1; }
        },
        updatePortStyles: () => {},
        viewportApi: typeof overrides.viewportApi === 'function'
            ? overrides.viewportApi(state)
            : (overrides.viewportApi || { updateCanvasTransform: () => {} }),
        showToast: () => {}
    });
    return {
        api,
        state,
        restoredNodeIds,
        scheduledTasks,
        getWholeProjectionUpdates: () => wholeProjectionUpdates
    };
}

test('large saved session yields control before mounting every node', async () => {
    const { api, restoredNodeIds, scheduledTasks } = createHarness(3001);

    let settled = false;
    const loading = api.loadState().then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(settled, false);
    assert.ok(restoredNodeIds.length > 0);
    assert.ok(restoredNodeIds.length < 3001);
    assert.ok(scheduledTasks.some((task) => task.delay === 0));

    void loading;
});

test('large saved session eventually restores every node and connection', async () => {
    const {
        api,
        state,
        scheduledTasks,
        getWholeProjectionUpdates
    } = createHarness(301, 600);

    let settled = false;
    let result = false;
    const loading = api.loadState().then((value) => {
        result = value;
        settled = true;
    });

    for (let turn = 0; !settled && turn < 20; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        const taskIndex = scheduledTasks.findIndex((task) => task.delay === 0);
        if (taskIndex >= 0) scheduledTasks.splice(taskIndex, 1)[0].callback();
    }
    await loading;

    assert.equal(result, true);
    assert.equal(state.nodes.size, 301);
    assert.equal(state.connections.length, 600);
    assert.equal(getWholeProjectionUpdates(), 1);
});

test('small saved session restores without scheduling batch yields', async () => {
    const { api, state, scheduledTasks } = createHarness(3, 2);

    const result = await api.loadState();

    assert.equal(result, true);
    assert.equal(state.nodes.size, 3);
    assert.equal(state.connections.length, 2);
    assert.equal(scheduledTasks.some((task) => task.delay === 0), false);
});

test('loadState remains pending until the restored connection projection completes', async () => {
    let finishProjection;
    let projectionStarted = false;
    const projectionComplete = new Promise((resolve) => { finishProjection = resolve; });
    const { api } = createHarness(3, 2, {
        connectionProjectionMaintenance: {
            workflowRestored: async () => {
                projectionStarted = true;
                await projectionComplete;
            }
        }
    });

    let settled = false;
    const loading = api.loadState().then((result) => {
        settled = true;
        return result;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(projectionStarted, true);
    assert.equal(settled, false);

    finishProjection();
    assert.equal(await loading, true);
});

test('connectionless session still waits for workflow restoration', async () => {
    let finishProjection;
    let projectionStarted = false;
    const projectionComplete = new Promise((resolve) => { finishProjection = resolve; });
    const { api } = createHarness(3, 0, {
        connectionProjectionMaintenance: {
            workflowRestored: async () => {
                projectionStarted = true;
                await projectionComplete;
            }
        }
    });

    let settled = false;
    const loading = api.loadState().then((result) => {
        settled = true;
        return result;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(projectionStarted, true);
    assert.equal(settled, false);

    finishProjection();
    assert.equal(await loading, true);
});

test('loading a saved session applies its viewport without scheduling another connection projection', async () => {
    let projectionRefreshes = 0;
    const style = { transform: '', transformOrigin: '', setProperty() {} };
    const { api, state } = createHarness(3, 2, {
        canvas: { x: 24, y: -12, zoom: 1.5 },
        viewportApi: (viewportState) => createViewportApi({
            state: viewportState,
            elements: {
                nodesLayer: { style },
                canvasContainer: {
                    style: { setProperty() {} },
                    ownerDocument: { dispatchEvent() {} }
                },
                connectionsGroup: { setAttribute() {} },
                originAxes: { setAttribute() {} },
                zoomLevel: { textContent: '' }
            },
            updateAllConnections: () => { projectionRefreshes += 1; },
            scheduleConnectionRefresh: () => { projectionRefreshes += 1; },
            requestAnimationFrameRef: (callback) => callback()
        })
    });

    const result = await api.loadState();

    assert.equal(result, true);
    assert.equal(projectionRefreshes, 0);
    assert.equal(style.transform, `translate(${state.canvas.x}px, ${state.canvas.y}px) scale(${state.canvas.zoom})`);
});

test('loading a saved session applies its viewport before restoring the connection projection', async () => {
    const style = { transform: '', transformOrigin: '', setProperty() {} };
    let transformAtProjectionRestore = '';
    const { api } = createHarness(3, 2, {
        canvas: { x: 24, y: -12, zoom: 1.5 },
        connectionProjectionMaintenance: {
            workflowRestored: async () => {
                transformAtProjectionRestore = style.transform;
            }
        },
        viewportApi: (viewportState) => createViewportApi({
            state: viewportState,
            elements: {
                nodesLayer: { style },
                canvasContainer: {
                    style: { setProperty() {} },
                    ownerDocument: { dispatchEvent() {} }
                },
                connectionsGroup: { setAttribute() {} },
                originAxes: { setAttribute() {} },
                zoomLevel: { textContent: '' }
            },
            updateAllConnections: () => {},
            scheduleConnectionRefresh: () => {},
            requestAnimationFrameRef: (callback) => callback()
        })
    });

    const result = await api.loadState();

    assert.equal(result, true);
    assert.equal(transformAtProjectionRestore, 'translate(24px, -12px) scale(1.5)');
});

test('large saved session yields control while restoring connections', async () => {
    const { api, state, scheduledTasks } = createHarness(101, 6000);

    let settled = false;
    const loading = api.loadState().then((result) => {
        settled = true;
        return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const firstYield = scheduledTasks.shift();
    assert.equal(firstYield?.delay, 0);
    firstYield.callback();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(settled, false);
    assert.ok(state.connections.length > 0);
    assert.ok(state.connections.length < 6000);

    void loading;
});
