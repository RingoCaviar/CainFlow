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
        nodes: new Map([[node.id, node]]),
        runningNodeIds: new Set(),
        runningNodeCancelHandlers: new Map()
    };
    const api = createWorkflowRuntimeManager({
        state,
        nodeConfigs: {},
        connectionProjection: { nodeAppearanceChanged: (nodeId) => calls.push(nodeId) },
        documentRef: { getElementById: () => null },
        windowRef: { clearInterval: () => {}, setInterval: () => 1 },
        confirmRef: () => true
    });

    api.applyVisibleNodeRunState('workflow-a', {
        nodeId: node.id,
        status: 'completed',
        durationSec: '1.25'
    });

    assert.deepEqual(calls, ['runtime-node']);
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
