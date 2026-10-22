import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareGenerationSaveTargets } from '../js/features/execution/generation-save-targets.js';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createWorkflowRunnerApi } from '../js/features/execution/workflow-runner.js';
import { createNodeLifecycleApi } from '../js/nodes/node-lifecycle.js';
import { createNodeSerializer } from '../js/nodes/node-serializer.js';
import { imageSaveNode } from '../js/nodes/types/image-save.js';
import { createWorkflowManagerApi } from '../js/features/workflow/workflow-manager.js';

const noop = () => {};
const element = () => ({
    style: {}, dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 240 }), addEventListener: noop, remove: noop
});

function fixture(type = 'ImageGenerate') {
    const source = { id: 'generate', type, enabled: true, data: { prompt: '受控生成' }, el: element(), x: 0, y: 0, width: 240 };
    const state = {
        nodes: new Map([[source.id, source]]), connections: [], providers: [], models: [],
        selectedNodes: new Set(), canvas: { zoom: 1, x: 0, y: 0 }, requestTimeoutEnabled: false
    };
    const documentRef = {
        defaultView: { requestAnimationFrame: (callback) => callback() },
        getElementById: (id) => id === 'generate-prompt' ? { value: '受控生成' } : null,
        querySelectorAll: () => []
    };
    const nodeConfigs = {
        ImageGenerate: { title: '图片生成', outputs: [{ name: 'image', type: 'image' }] },
        VideoGenerate: { title: '视频生成', outputs: [{ name: 'video', type: 'video' }] },
        ImageSave: imageSaveNode
    };
    const directorySaves = [];
    const core = createExecutionCoreApi({
        state, nodeConfigs, documentRef, windowRef: {}, showToast: noop,
        syncImageSaveNode: async () => {}, refreshDependentImageResizePreviews: async () => {},
        autoSaveToDir: async (nodeId, payload) => directorySaves.push({ nodeId, payload })
    });
    const changes = [];
    let saved = 0;
    let nextId = 0;
    const prepare = (runInput, options = {}) => prepareGenerationSaveTargets({
        state, runInput,
        normalizeRunOptions: core.normalizeRunOptions, resolveExecutionPlan: core.resolveExecutionPlan,
        addNode(nodeType, x, y, restoreData) {
            const id = `auto-${++nextId}`;
            state.nodes.set(id, { id, type: nodeType, x, y, data: {}, el: element(), ...restoreData });
            return id;
        },
        generateId: () => String(++nextId), onConnectionsChanged: (change) => changes.push(change),
        scheduleSave: () => { saved += 1; }, ...options
    });
    const connect = (id, { enabled = true, automatic = false, targetType = 'ImageSave', missing = false } = {}) => {
        if (!missing) state.nodes.set(id, {
            id, type: targetType, enabled, autoAddedForGeneration: automatic,
            data: {}, el: element(), x: 320, y: 0
        });
        const port = type === 'ImageGenerate' ? 'image' : 'video';
        state.connections.push({ id: `to-${id}`, type: port,
            from: { nodeId: source.id, port, type: port }, to: { nodeId: id, port, type: port } });
    };
    return { state, source, documentRef, nodeConfigs, core, prepare, connect, changes, directorySaves, get saved() { return saved; } };
}

for (const type of ['ImageGenerate', 'VideoGenerate']) {
    for (const mode of ['all', 'selected-only', 'target-node']) {
        test(`${mode} ${type} creates and executes one reusable save with the generated batch`, async () => {
            const f = fixture(type);
            const input = { mode, selectedNodeIds: ['generate'], targetNodeId: 'generate' };
            const prepared = f.prepare(input);
            const [saveId] = prepared.includedAutoSaveNodeIds;
            assert.ok(saveId);
            assert.equal(f.state.nodes.get(saveId).autoAddedForGeneration, true);
            assert.equal(f.saved, 1);
            assert.equal(f.changes[0].connectionIds.length, 1);
            const executed = [];
            let saveInput;
            const images = ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'];
            const videos = [{ url: 'first.mp4' }, { url: 'second.mp4' }];
            const runner = createWorkflowRunnerApi({
                state: f.state, nodeConfigs: f.nodeConfigs, documentRef: f.documentRef, confirmRef: () => true,
                normalizeRunOptions: f.core.normalizeRunOptions, resolveExecutionPlan: f.core.resolveExecutionPlan,
                getCachedOutputValue: f.core.getCachedOutputValue,
                executeNode: async (node, inputs) => {
                    executed.push(node.id);
                    if (node.id === 'generate') {
                        if (type === 'ImageGenerate') node.data.imageList = images;
                        else { node.data.videos = videos; node.data.video = videos[0]; }
                    } else {
                        saveInput = inputs;
                        return f.core.executeNode(node, inputs);
                    }
                },
                showToast: noop, addLog: noop, scheduleSave: noop, updatePortStyles: noop,
                getAbortMessage: () => '', playNotificationSound: noop
            });
            const result = await runner.runWorkflow(prepared);
            assert.equal(result.reason, 'finished', JSON.stringify([...f.state.nodes.values()].map((node) => node.executionFailure)));
            assert.deepEqual(executed, ['generate', saveId]);
            assert.deepEqual(type === 'ImageGenerate' ? saveInput.image : saveInput.video, type === 'ImageGenerate' ? images : videos);
            assert.equal(f.directorySaves[0].nodeId, saveId);
            assert.deepEqual(type === 'ImageGenerate' ? f.directorySaves[0].payload.images : f.directorySaves[0].payload.videos,
                type === 'ImageGenerate' ? images : videos);
            const retryInput = f.prepare(input);
            assert.deepEqual(retryInput.includedAutoSaveNodeIds, [saveId]);
            assert.equal((await runner.runWorkflow(retryInput)).reason, 'finished');
            assert.deepEqual(f.directorySaves.map((entry) => entry.nodeId), [saveId, saveId]);
            assert.equal(f.state.nodes.size, 2);
            assert.equal(f.saved, 1);
        });
    }
}

test('disabled and missing downstream nodes do not block creation, and old disabled nodes are preserved', () => {
    const f = fixture();
    f.connect('disabled', { enabled: false, automatic: true });
    f.connect('missing', { missing: true });
    const prepared = f.prepare({ mode: 'selected-only', selectedNodeIds: ['generate'] });
    const save = f.state.nodes.get(prepared.includedAutoSaveNodeIds[0]);
    assert.equal(save.enabled, true);
    assert.equal(f.state.nodes.get('disabled').enabled, false);
    assert.ok(save.y >= 380 || save.y + 340 <= -40 || save.x >= 600, 'new save does not cover the disabled downstream node');
    assert.equal(f.state.connections.length, 3);
});

test('any enabled downstream node prevents creation without adding unrelated nodes to a selected run', () => {
    const f = fixture();
    f.connect('disabled', { enabled: false });
    f.connect('manual-save');
    f.connect('transform', { targetType: 'ImageResize' });
    const prepared = f.prepare({ mode: 'selected-only', selectedNodeIds: ['generate'] });
    assert.deepEqual(prepared.includedAutoSaveNodeIds, []);
    assert.equal(f.saved, 0);
    assert.deepEqual(f.core.resolveExecutionPlan(prepared).executionOrder, ['generate']);
});

test('only generators in the run scope get automatic saves, and disabled generators get none', () => {
    const f = fixture();
    f.state.nodes.set('other', { ...f.source, id: 'other', data: {}, x: 700 });
    f.prepare({ mode: 'selected-only', selectedNodeIds: ['generate'] });
    assert.equal(f.state.connections.some((c) => c.from.nodeId === 'other'), false);
    f.source.enabled = false;
    const prepared = f.prepare({ mode: 'selected-only', selectedNodeIds: ['generate'] });
    assert.deepEqual(prepared.includedAutoSaveNodeIds, []);
    assert.equal(f.saved, 1);
});

test('scope extensions reject manual, disabled, disconnected and wrong-port save targets', () => {
    const f = fixture();
    f.connect('valid', { automatic: true });
    f.connect('manual');
    f.connect('disabled', { automatic: true, enabled: false });
    f.connect('wrong-port', { automatic: true });
    f.state.connections.at(-1).to.port = 'video';
    f.state.nodes.set('disconnected', { id: 'disconnected', type: 'ImageSave', enabled: true, autoAddedForGeneration: true });
    const plan = f.core.resolveExecutionPlan({ mode: 'selected-only', selectedNodeIds: ['generate'],
        includedAutoSaveNodeIds: ['valid', 'manual', 'disabled', 'wrong-port', 'disconnected'] });
    assert.deepEqual(plan.executionOrder, ['generate', 'valid']);
});

test('workflow activation invalidates preparation before it mutates nodes or connections', () => {
    const f = fixture();
    assert.throws(() => f.prepare(null, { isWorkflowCurrent: () => false }), /工作流已切换/);
    assert.equal(f.state.nodes.size, 1);
    assert.equal(f.state.connections.length, 0);
});

test('an already running node in the run scope prevents preparation from changing any graph branch', () => {
    const f = fixture();
    f.state.nodes.set('other', { ...f.source, id: 'other', type: 'TextChat', data: {}, x: 700 });
    f.state.runningNodeIds = new Set(['other']);
    assert.throws(() => f.prepare(), /仍在运行/);
    assert.equal(f.state.nodes.size, 2);
    assert.equal(f.state.connections.length, 0);
    assert.equal(f.saved, 0);
});

test('preparing on the editable workflow preserves automatic nodes in repeated active snapshots', async () => {
    const f = fixture();
    Object.assign(f.state, { workflowTabs: [], workflowOrder: [], workflowFolders: [] });
    const serializer = createNodeSerializer({ state: f.state, documentRef: f.documentRef });
    const manager = createWorkflowManagerApi({
        state: f.state, nodeSerializer: serializer, viewportApi: { updateCanvasTransform: noop },
        addNode: noop, updateAllConnections: noop, updatePortStyles: noop, scheduleSave: noop, showToast: noop,
        panelManager: {}, prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
        documentRef: f.documentRef, windowRef: { innerWidth: 0, innerHeight: 0 },
        localStorageRef: { getItem: () => null, setItem: noop }
    });
    await manager.activateRestoredWorkflowState({
        workflowTabs: [{ workflowId: 'workflow-a', name: 'A', data: {
            workflowId: 'workflow-a', nodes: serializer.serializeNodes(), connections: []
        } }], activeWorkflowId: 'workflow-a', activeWorkflowName: 'A'
    });
    const prepared = f.prepare({ mode: 'selected-only', selectedNodeIds: ['generate'] });
    const [saveId] = prepared.includedAutoSaveNodeIds;
    const snapshot = manager.getActiveWorkflowSnapshot();
    assert.equal(snapshot.nodes.find((node) => node.id === saveId).autoAddedForGeneration, true);
    assert.equal(snapshot.connections[0].to.nodeId, saveId);
    manager.updateWorkflowTabDataById('workflow-a', snapshot, {
        mergeRunResults: true, mergeWithCanvas: true,
        baseNodeIds: new Set(snapshot.nodes.map((node) => node.id)),
        baseConnectionIds: new Set(snapshot.connections.map((connection) => connection.id)),
        mergeNodeIds: new Set(f.core.resolveExecutionPlan(prepared).nodeIds)
    });
    const nextSnapshot = manager.getActiveWorkflowSnapshot();
    assert.ok(nextSnapshot.nodes.some((node) => node.id === saveId));
    assert.equal(nextSnapshot.connections[0].to.nodeId, saveId);
});

test('automatic-save identity survives real node serialization and restoration', () => {
    const f = fixture();
    const prepared = f.prepare({ mode: 'selected-only', selectedNodeIds: ['generate'] });
    const [saveId] = prepared.includedAutoSaveNodeIds;
    const serializer = createNodeSerializer({ state: f.state, documentRef: f.documentRef });
    const saved = serializer.serializeNodes().find((node) => node.id === saveId);
    assert.equal(saved.autoAddedForGeneration, true);
    const nodesLayer = { appendChild: noop };
    const documentRef = {
        defaultView: { setTimeout: (callback) => { callback(); return 0; }, clearTimeout: noop, requestAnimationFrame: (callback) => callback() },
        createElement: element, getElementById: () => null, querySelectorAll: () => []
    };
    f.state.nodes.delete(saveId);
    const lifecycle = createNodeLifecycleApi({
        state: f.state, nodeConfigs: f.nodeConfigs, nodesLayer, documentRef,
        createNodeMarkup: () => '', generateId: () => 'unused', bindNodeInteractions: noop,
        pushHistory: noop, scheduleSave: noop, showToast: noop, updateAllConnections: noop, updatePortStyles: noop,
        getCacheSidebarActive: () => false, updateCacheUsage: noop, getImageAsset: async () => null,
        getImageAssetList: async () => []
    });
    lifecycle.addNode('ImageSave', saved.x, saved.y, saved, true);
    assert.equal(f.state.nodes.get(saveId).autoAddedForGeneration, true);
    assert.deepEqual(f.prepare({ mode: 'selected-only', selectedNodeIds: ['generate'] }).includedAutoSaveNodeIds, [saveId]);
    assert.equal(f.saved, 1);
});

test('automatic save chooses nearby space above a tall obstruction instead of walking far down', () => {
    const f = fixture();
    f.state.nodes.set('wall', { id: 'wall', x: 320, y: 0, width: 240, height: 5000 });
    const result = f.prepare({ mode: 'all' });
    const save = f.state.nodes.get(result.includedAutoSaveNodeIds[0]);
    assert.ok(Math.abs(save.y) <= 400, `save too far away: ${save.y}`);
});
