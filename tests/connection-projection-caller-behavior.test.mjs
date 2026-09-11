import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionApi } from '../js/canvas/selection.js';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createWorkflowRuntimeManager } from '../js/features/workflow/workflow-runtime-manager.js';

function createClassList() {
    const values = new Set();
    return {
        add: (...names) => names.forEach((name) => values.add(name)),
        remove: (...names) => names.forEach((name) => values.delete(name)),
        toggle: (name, enabled) => enabled ? values.add(name) : values.delete(name),
        contains: (name) => values.has(name)
    };
}

function createNode(id, type = 'Text') {
    return {
        id,
        type,
        data: {},
        el: {
            classList: createClassList(),
            querySelector: () => null,
            querySelectorAll: () => []
        }
    };
}

test('select-all reports affected node ids through the appearance seam', () => {
    const calls = [];
    const nodes = new Map([
        ['node-a', createNode('node-a')],
        ['node-b', createNode('node-b')]
    ]);
    const api = createSelectionApi({
        state: { nodes, selectedNodes: new Set(['node-a']) },
        connectionProjection: { nodeAppearanceChanged: (nodeIds) => calls.push(nodeIds) }
    });

    api.selectAllNodes();

    assert.deepEqual(calls, [['node-a', 'node-b']]);
});

test('visible workflow completion reports the runtime node id through the appearance seam', () => {
    const calls = [];
    const node = createNode('runtime-node');
    const state = {
        activeWorkflowName: 'workflow-a',
        activeWorkflowId: 'workflow-a-id',
        nodes: new Map([[node.id, node]]),
        runningNodeIds: new Set(),
        runningNodeCancelHandlers: new Map()
    };
    const api = createWorkflowRuntimeManager({
        state,
        nodeConfigs: {},
        getWorkflowManagerApi: () => ({ getActiveWorkflow: () => ({ workflowId: 'workflow-a-id', label: 'workflow-a' }) }),
        connectionProjection: { nodeAppearanceChanged: (nodeId) => calls.push(nodeId) },
        documentRef: { getElementById: () => null },
        windowRef: { clearInterval: () => {}, setInterval: () => 1 },
        confirmRef: () => true
    });

    api.applyVisibleNodeRunState({ workflowId: 'workflow-a-id', workflowName: 'workflow-a' }, {
        nodeId: node.id,
        status: 'completed',
        durationSec: '1.25'
    });

    assert.deepEqual(calls, ['runtime-node']);
});

test('visible run state is isolated by workflow identity when node ids overlap', () => {
    const calls = [];
    const node = createNode('shared-node');
    const state = {
        activeWorkflowName: 'renamed-workflow',
        activeWorkflowId: 'workflow-a',
        nodes: new Map([[node.id, node]]),
        runningNodeIds: new Set(),
        runningNodeCancelHandlers: new Map()
    };
    const api = createWorkflowRuntimeManager({
        state,
        nodeConfigs: {},
        getWorkflowManagerApi: () => ({ getActiveWorkflow: () => ({ workflowId: 'workflow-a', label: 'renamed-workflow' }) }),
        connectionProjection: { nodeAppearanceChanged: (nodeId) => calls.push(nodeId) },
        documentRef: { getElementById: () => null },
        windowRef: { clearInterval: () => {}, setInterval: () => 1 },
        confirmRef: () => true
    });

    api.applyVisibleNodeRunState({ workflowId: 'workflow-b', workflowName: 'renamed-workflow' }, {
        nodeId: node.id,
        status: 'completed'
    });
    api.applyVisibleNodeRunState({ workflowId: 'workflow-a', workflowName: 'old-name' }, {
        nodeId: node.id,
        status: 'completed'
    });

    assert.deepEqual(calls, ['shared-node']);
});

test('visible cancellation cannot cross a workflow identity with the same node id', () => {
    const node = createNode('shared-node');
    const state = {
        activeWorkflowName: 'workflow-a-name',
        activeWorkflowId: 'workflow-a',
        nodes: new Map([[node.id, node]]),
        runningNodeIds: new Set(),
        runningNodeCancelHandlers: new Map()
    };
    const api = createWorkflowRuntimeManager({
        state,
        nodeConfigs: {},
        getWorkflowManagerApi: () => ({ getActiveWorkflow: () => ({ workflowId: 'workflow-a', label: 'workflow-a-name' }) }),
        connectionProjection: { nodeAppearanceChanged: () => {} },
        documentRef: { getElementById: () => null },
        windowRef: { clearInterval: () => {}, setInterval: () => 1 },
        confirmRef: () => true
    });
    api.applyVisibleNodeRunState({ workflowId: 'workflow-a', workflowName: 'workflow-a-name' }, {
        nodeId: node.id,
        status: 'running',
        running: true
    });

    assert.equal(api.cancelRunningNode({ workflowId: 'workflow-b', workflowName: 'workflow-b-name' }, node.id), false);
    assert.equal(api.cancelRunningNode({ workflowId: 'workflow-a', workflowName: 'old-name' }, node.id), true);
});

test('workflow runtime entry points reject a mutable name used as the workflow reference', async () => {
    const api = createWorkflowRuntimeManager({
        state: {
            activeWorkflowName: 'renamed-workflow',
            activeWorkflowId: 'workflow-a',
            nodes: new Map(),
            connections: [],
            selectedNodes: new Set()
        },
        nodeConfigs: {},
        connectionProjection: { nodeAppearanceChanged: () => {} },
        documentRef: { getElementById: () => null },
        windowRef: { clearInterval: () => {}, setInterval: () => 1 },
        confirmRef: () => true
    });

    await assert.rejects(
        api.runWorkflowInContext('renamed-workflow', { nodes: [], connections: [] }),
        /workflow reference/i
    );
    assert.throws(
        () => api.getRunConflictInfo('renamed-workflow', { nodes: [], connections: [] }),
        /workflow reference/i
    );
    assert.throws(
        () => api.cancelRunningNode('renamed-workflow', 'node-a'),
        /workflow reference/i
    );
});

test('text merge reports the output node id through the geometry seam', async () => {
    const calls = [];
    const node = createNode('text-merge', 'TextMerge');
    const api = createExecutionCoreApi({
        state: { nodes: new Map([[node.id, node]]), models: [], providers: [], connections: [] },
        nodeConfigs: {},
        documentRef: { getElementById: () => null },
        windowRef: { requestAnimationFrame: (callback) => callback() },
        connectionProjection: { nodeGeometryChanged: (nodeId) => calls.push(nodeId) },
        addLog: () => {},
        fitNodeToContent: () => {},
        refreshDependentImageResizePreviews: async () => {}
    });

    await api.nodeHandlers.TextMerge(node, { text_1: 'first', text_2: 'second' });

    assert.deepEqual(calls, ['text-merge']);
});

test('image resize retains replaced formal media until the document ownership transition', async () => {
    const node = createNode('resize', 'ImageResize');
    node.data.mediaAssetKeys = ['media:previous'];
    const elements = new Map(Object.entries({
        'resize-resize-mode': { value: 'scale' },
        'resize-scale-percent': { value: '50' },
        'resize-target-width': { value: '' },
        'resize-target-height': { value: '' },
        'resize-keep-aspect': { checked: true },
        'resize-quality': { value: '92' }
    }));
    const writes = [];
    const releases = [];
    const api = createExecutionCoreApi({
        state: { nodes: new Map([[node.id, node]]), models: [], providers: [], connections: [] },
        nodeConfigs: {},
        documentRef: { getElementById: (id) => elements.get(id) || null },
        windowRef: { requestAnimationFrame: (callback) => callback() },
        addLog: () => {},
        fitNodeToContent: () => {},
        getActiveWorkflowId: () => 'workflow-a',
        resizeImageData: async () => ({
            dataUrl: 'data:image/png;base64,cmVzaXplZA==', originalWidth: 100, originalHeight: 100,
            outputWidth: 50, outputHeight: 50, outputFormat: 'png', outputQuality: 92, estimatedBytes: 20
        }),
        saveWorkflowNodeMediaAsset: async (value, workflowId, nodeId) => {
            writes.push({ value, workflowId, nodeId });
            return {
                asset_key: 'media:resized',
                mediaTemporaryOwnerId: 'workflow-a:resize:operation-a'
            };
        },
        releaseWorkflowNodeMediaAssets: async (keys, workflowId, nodeId) => {
            releases.push({ keys, workflowId, nodeId });
            return true;
        },
        releaseNodeImageData: async () => true,
        restoreImageResizePreview: () => {},
        showResolutionBadge: () => {},
        refreshDependentImageResizePreviews: async () => {}
    });

    await api.nodeHandlers.ImageResize(node, { image: 'data:image/png;base64,c291cmNl' });

    assert.deepEqual(writes, [{
        value: 'data:image/png;base64,cmVzaXplZA==', workflowId: 'workflow-a', nodeId: 'resize'
    }]);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:resized']);
    assert.equal(node.data.imageAssetKey, 'media:resized');
    assert.deepEqual(node.data.mediaOwnershipTemporaryOwners, [{
        ownerId: 'workflow-a:resize:operation-a', assetKeys: ['media:resized']
    }]);
    assert.deepEqual(releases, []);
});
