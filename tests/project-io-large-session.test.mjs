import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectIoApi } from '../js/features/persistence/project-io.js';
import { createViewportApi } from '../js/canvas/viewport.js';
import { createWorkflowActivation } from '../js/features/workflow/workflow-activation.js';
import { createWorkflowSessionActivator } from '../js/features/workflow/workflow-activation-coordinator.js';
import { createWorkflowDesk } from '../js/features/workflow/workflow-desk.js';

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
        workflowFolders: [],
        activeWorkflowName: '',
        activeWorkflowId: ''
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
        })),
        workflowTabs: overrides.workflowTabs,
        activeWorkflowName: overrides.activeWorkflowName,
        activeWorkflowId: overrides.activeWorkflowId,
        providers: overrides.providers,
        models: overrides.models
    };
    const restoreBatch = async (items, restoreItem) => {
        for (let index = 0; index < items.length; index += 1) {
            restoreItem(items[index]);
            if ((index + 1) % 100 === 0 && index + 1 < items.length) {
                await new Promise((resolve) => {
                    scheduledTasks.push({ callback: resolve, delay: 0 });
                });
            }
        }
    };
    const testActivator = async (restoredState) => {
        state.workflowTabs = restoredState.workflowTabs;
        state.activeWorkflowName = restoredState.activeWorkflowName;
        state.activeWorkflowId = restoredState.activeWorkflowId;
        state.workflowOrder = restoredState.workflowOrder;
        state.workflowFolders = restoredState.workflowFolders;
        Object.assign(state.canvas, restoredState.workflowData.canvas);
        const viewport = typeof overrides.viewportApi === 'function'
            ? overrides.viewportApi(state)
            : overrides.viewportApi;
        viewport?.updateCanvasTransform?.({ updateConnections: false });
        (overrides.beginMediaRestoreBatch || (() => {}))();
        try {
            await restoreBatch(restoredState.workflowData.nodes, (node) => {
                restoredNodeIds.push(node.id);
                state.nodes.set(node.id, { ...node });
            });
            await restoreBatch(restoredState.workflowData.connections, (connection) => {
                if (state.nodes.has(connection.from.nodeId) && state.nodes.has(connection.to.nodeId)) {
                    state.connections.push(connection);
                }
            });
        } finally {
            (overrides.endMediaRestoreBatch || (() => {}))();
        }
        await (overrides.finalizeMediaRestoreBatch || (async () => {}))();
        if (restoredState.workflowData.connections.length) (overrides.updatePortStyles || (() => {}))();
        await (overrides.connectionProjectionMaintenance?.workflowRestored
            || (async () => { wholeProjectionUpdates += 1; }))();
        return true;
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
        updatePortStyles: overrides.updatePortStyles || (() => {}),
        viewportApi: typeof overrides.viewportApi === 'function'
            ? overrides.viewportApi(state)
            : (overrides.viewportApi || { updateCanvasTransform: () => {} }),
        showToast: () => {},
        beginMediaRestoreBatch: overrides.beginMediaRestoreBatch || (() => {}),
        endMediaRestoreBatch: overrides.endMediaRestoreBatch || (() => {}),
        finalizeMediaRestoreBatch: overrides.finalizeMediaRestoreBatch || (async () => {}),
        activateRestoredWorkflowState: overrides.activateRestoredWorkflowState || testActivator
    });
    return {
        api,
        state,
        restoredNodeIds,
        scheduledTasks,
        getWholeProjectionUpdates: () => wholeProjectionUpdates
    };
}

test('加载会把已有供应商标识与地址作为普通用户配置保留', async () => {
    const provider = {
        id: 'prov_user_legacy',
        name: '用户保留的供应商',
        type: 'openai',
        apikey: 'saved-key',
        endpoint: 'https://api.user-provider.example/'
    };
    const model = {
        id: 'user-model',
        name: '用户模型',
        modelId: 'custom-model',
        providerIds: ['prov_user_legacy'],
        protocol: 'openai'
    };
    const { api, state } = createHarness(1, 0, { providers: [provider], models: [model] });

    assert.equal(await api.loadState(), true);
    assert.equal(state.providers.length, 1);
    assert.equal(state.providers[0].id, provider.id);
    assert.equal(state.providers[0].endpoint, provider.endpoint);
    assert.deepEqual(state.models[0].providerIds, [provider.id]);
});

test('project IO requires an atomic workflow activator', () => {
    assert.throws(() => createProjectIoApi({
        state: {},
        localStorageRef: {},
        documentRef: {},
        windowRef: {}
    }), /workflow activator/i);
});

test('failed session workflow activation keeps the previous active workflow', async () => {
    const previousTabs = [{ workflowId: 'previous-id', name: 'previous', data: { nodes: [] } }];
    let liveState = null;
    let nodeIdsAtActivation = [];
    const { api, state } = createHarness(1, 0, {
        workflowTabs: [{ workflowId: 'saved-id', name: 'saved', data: { nodes: [] } }],
        activeWorkflowName: 'saved',
        activeWorkflowId: 'saved-id',
        activateRestoredWorkflowState: async () => {
            nodeIdsAtActivation = Array.from(liveState.nodes.keys());
            return false;
        }
    });
    liveState = state;
    state.workflowTabs = previousTabs;
    state.activeWorkflowName = 'previous';
    state.activeWorkflowId = 'previous-id';
    state.nodes.set('previous-node', { id: 'previous-node' });
    state.connections = [{ id: 'previous-connection' }];
    state.canvas = { x: 9, y: 8, zoom: 0.75 };

    assert.equal(await api.loadState(), false);
    assert.deepEqual(nodeIdsAtActivation, ['previous-node']);
    assert.equal(state.workflowTabs, previousTabs);
    assert.equal(state.activeWorkflowName, 'previous');
    assert.equal(state.activeWorkflowId, 'previous-id');
    assert.deepEqual(Array.from(state.nodes.keys()), ['previous-node']);
    assert.deepEqual(state.connections, [{ id: 'previous-connection' }]);
    assert.deepEqual(state.canvas, { x: 9, y: 8, zoom: 0.75 });
});

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

test('loading a saved session applies port layout before restoring connection paths', async () => {
    let portLayoutReady = false;
    let portLayoutAtProjectionRestore = false;
    const { api } = createHarness(3, 2, {
        updatePortStyles() {
            portLayoutReady = true;
        },
        connectionProjectionMaintenance: {
            workflowRestored: async () => {
                portLayoutAtProjectionRestore = portLayoutReady;
            }
        }
    });

    assert.equal(await api.loadState(), true);
    assert.equal(portLayoutAtProjectionRestore, true);
});

test('loading a saved session finalizes media layout before restoring connection paths', async () => {
    let mediaLayoutReady = false;
    let mediaLayoutAtProjectionRestore = false;
    const { api } = createHarness(3, 2, {
        finalizeMediaRestoreBatch: async () => {
            mediaLayoutReady = true;
        },
        connectionProjectionMaintenance: {
            workflowRestored: async () => {
                mediaLayoutAtProjectionRestore = mediaLayoutReady;
            }
        }
    });

    assert.equal(await api.loadState(), true);
    assert.equal(mediaLayoutAtProjectionRestore, true);
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

test('loading a legacy session assigns one unique stable identity to the active workflow', async () => {
    let activateRestoredState;
    const { api, state } = createHarness(1, 0, {
        workflowTabs: [
            { name: 'other', workflowId: 'duplicate-id', identityPendingSave: true, data: { workflowId: 'duplicate-id', nodes: [], connections: [] } },
            { name: 'folder/a', workflowId: 'duplicate-id', data: { workflowId: 'duplicate-id', nodes: [], connections: [] } }
        ],
        activeWorkflowName: 'folder/a',
        activeWorkflowId: 'duplicate-id',
        activateRestoredWorkflowState: (restoredState) => activateRestoredState(restoredState)
    });
    const workflowDesk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        createWorkflowId: () => 'generated-workflow-id'
    });
    activateRestoredState = createWorkflowSessionActivator({
        state,
        getActiveWorkflow: () => workflowDesk.snapshot().active,
        workflowDesk,
        workflowActivation: createWorkflowActivation(),
        createWorkflowId: () => 'generated-workflow-id',
        prepareEditorView: async () => ({
            commit: () => true,
            rollback: () => true,
            finalize: () => true,
            dispose: () => true
        })
    }).activate;

    assert.equal(await api.loadState(), true);
    assert.equal(state.workflowTabs[0].workflowId, 'duplicate-id');
    assert.equal(state.workflowTabs[0].identityPendingSave, true);
    assert.equal(state.workflowTabs[1].workflowId, 'generated-workflow-id');
    assert.equal(state.workflowTabs[1].data.workflowId, 'generated-workflow-id');
    assert.equal(workflowDesk.snapshot().active.workflowId, 'generated-workflow-id');
});

test('session workflow activation applies the committed canvas to the visible viewport', async () => {
    let activateRestoredState;
    let canvasAtViewportApply = null;
    const { api, state } = createHarness(1, 0, {
        canvas: { x: 48, y: -24, zoom: 1.25 },
        workflowTabs: [{ name: 'active', data: { nodes: [], connections: [] } }],
        activeWorkflowName: 'active',
        activateRestoredWorkflowState: (restoredState) => activateRestoredState(restoredState)
    });
    const workflowDesk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        createWorkflowId: () => 'active-id'
    });
    activateRestoredState = createWorkflowSessionActivator({
        state,
        getActiveWorkflow: () => workflowDesk.snapshot().active,
        workflowDesk,
        workflowActivation: createWorkflowActivation(),
        createWorkflowId: () => 'active-id',
        prepareEditorView: async (_workflowName, workflowData) => ({
            commit: () => { state.canvas = workflowData.canvas; return true; },
            rollback: () => true,
            finalize: () => true,
            dispose: () => true
        }),
        applyViewport: () => { canvasAtViewportApply = { ...state.canvas }; }
    }).activate;

    assert.equal(await api.loadState(), true);
    assert.deepEqual(canvasAtViewportApply, { x: 48, y: -24, zoom: 1.25 });
});
