import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetachedWorkflowViewBuilder } from '../js/features/workflow/detached-workflow-view-builder.js';

function root(...children) {
    return {
        childNodes: children,
        replaceChildren(...next) { this.childNodes = next; }
    };
}

test('visible workflow commit waits for its connection projection to materialize', async () => {
    const targetNode = { id: 'target', type: 'Text' };
    const liveRoot = root();
    const liveState = {
        nodes: new Map(),
        connections: [],
        selectedNodes: new Set(),
        canvas: { x: 0, y: 0, zoom: 1 }
    };
    let visiblePath = '';
    const context = {
        state: {
            nodes: new Map([[targetNode.id, targetNode]]),
            connections: [{ id: 'connection-1' }],
            selectedNodes: new Set(),
            canvas: { x: 20, y: 10, zoom: 1 }
        },
        elements: { nodesLayer: root(targetNode) },
        waitForImageRestores: async () => {},
        refreshConnectionProjection() {},
        captureConnectionProjectionHandoff: () => ({ kind: 'target-projection' }),
        dispose() {}
    };
    const builder = createDetachedWorkflowViewBuilder({
        liveState,
        visibleNodesLayer: liveRoot,
        createRuntimeContext: () => context,
        visibleConnectionProjectionMaintenance: {
            captureViewHandoff: () => ({ kind: 'previous-projection' }),
            adoptViewHandoff() {},
            workflowRestored: async () => {
                assert.equal(liveRoot.childNodes[0], targetNode);
                assert.equal(liveState.nodes.has(targetNode.id), true);
                visiblePath = 'M 10 20 L 30 40';
            }
        }
    });

    const prepared = await builder.prepare('workflow-1', {});
    await prepared.commit();

    assert.notEqual(visiblePath, '');
});

test('visible workflow commit fails when its connection projection cannot materialize', async () => {
    const targetNode = { id: 'target', type: 'Text' };
    const builder = createDetachedWorkflowViewBuilder({
        liveState: {
            nodes: new Map(),
            connections: [],
            selectedNodes: new Set(),
            canvas: { x: 0, y: 0, zoom: 1 }
        },
        visibleNodesLayer: root(),
        createRuntimeContext: () => ({
            state: {
                nodes: new Map([[targetNode.id, targetNode]]),
                connections: [{ id: 'connection-1' }],
                selectedNodes: new Set(),
                canvas: { x: 0, y: 0, zoom: 1 }
            },
            elements: { nodesLayer: root(targetNode) },
            waitForImageRestores: async () => {},
            refreshConnectionProjection() {},
            captureConnectionProjectionHandoff: () => ({ kind: 'target-projection' }),
            dispose() {}
        }),
        visibleConnectionProjectionMaintenance: {
            captureViewHandoff: () => ({ kind: 'previous-projection' }),
            adoptViewHandoff() {},
            workflowRestored: async () => false
        }
    });

    const prepared = await builder.prepare('workflow-1', {});

    assert.equal(await prepared.commit(), false);
});

function createHarness() {
    const liveRoot = root();
    const liveState = {
        nodes: new Map(),
        connections: [],
        selectedNodes: new Set(),
        canvas: { x: 0, y: 0, zoom: 1 }
    };
    let restorationResult = true;
    const builder = createDetachedWorkflowViewBuilder({
        liveState,
        visibleNodesLayer: liveRoot,
        createRuntimeContext: (workflow) => {
            const workflowId = workflow.workflowId;
            const node = { id: `${workflowId}-node`, type: 'Text' };
            return {
                state: {
                    nodes: new Map([[node.id, node]]),
                    connections: [],
                    selectedNodes: new Set(),
                    canvas: { x: 0, y: 0, zoom: 1 }
                },
                elements: { nodesLayer: root(node) },
                waitForImageRestores: async () => {},
                refreshConnectionProjection() {},
                captureConnectionProjectionHandoff: () => ({ workflowId }),
                dispose() {}
            };
        },
        bindVisibleNodeInteractions() {},
        visibleConnectionProjectionMaintenance: {
            captureViewHandoff: () => ({ visible: true }),
            adoptViewHandoff() {},
            workflowRestored: async () => restorationResult
        }
    });
    return {
        builder,
        liveRoot,
        liveState,
        setRestorationResult(result) { restorationResult = result; }
    };
}

async function activate(builder, workflowId) {
    const view = await builder.prepare(
        { workflowId, workflowName: workflowId },
        { workflowId, nodes: [], connections: [] }
    );
    assert.equal(await view.commit(), true);
    assert.equal(view.finalize(), true);
}

test('returning to an opened workflow preserves its editor view and edits', async () => {
    const { builder, liveRoot } = createHarness();

    await activate(builder, 'workflow-a');
    const originalNode = liveRoot.childNodes[0];
    originalNode.draft = 'edited while active';

    await activate(builder, 'workflow-b');
    await activate(builder, 'workflow-a');

    assert.equal(liveRoot.childNodes[0], originalNode);
    assert.equal(liveRoot.childNodes[0].draft, 'edited while active');
});

test('returning to a workflow restores editor state objects replaced while active', async () => {
    const { builder, liveState } = createHarness();
    await activate(builder, 'workflow-a');
    const latestConnections = [{ id: 'latest-connection' }];
    const latestSelection = new Set(['workflow-a-node']);
    const latestCanvas = { x: 480, y: 320, zoom: 1.5 };
    liveState.connections = latestConnections;
    liveState.selectedNodes = latestSelection;
    liveState.canvas = latestCanvas;

    await activate(builder, 'workflow-b');
    await activate(builder, 'workflow-a');

    assert.equal(liveState.connections, latestConnections);
    assert.equal(liveState.selectedNodes, latestSelection);
    assert.equal(liveState.canvas, latestCanvas);
});

test('releasing an inactive workflow discards its preserved editor view', async () => {
    const { builder, liveRoot } = createHarness();

    await activate(builder, 'workflow-a');
    const releasedNode = liveRoot.childNodes[0];
    await activate(builder, 'workflow-b');

    assert.equal(builder.release({ workflowId: 'workflow-a' }), true);
    await activate(builder, 'workflow-a');

    assert.notEqual(liveRoot.childNodes[0], releasedNode);
});

test('failed workflow activation restores the previously cached editor view', async () => {
    const { builder, liveRoot, setRestorationResult } = createHarness();
    await activate(builder, 'workflow-a');
    const originalNode = liveRoot.childNodes[0];
    originalNode.draft = 'keep me';
    setRestorationResult(false);

    const failedView = await builder.prepare(
        { workflowId: 'workflow-b', workflowName: 'workflow-b' },
        { workflowId: 'workflow-b', nodes: [], connections: [] }
    );
    assert.equal(await failedView.commit(), false);
    assert.equal(failedView.rollback(), true);

    assert.equal(liveRoot.childNodes[0], originalNode);
    assert.equal(liveRoot.childNodes[0].draft, 'keep me');
});

test('releasing the active workflow allows an atomic replacement view', async () => {
    const { builder, liveRoot } = createHarness();
    await activate(builder, 'workflow-a');
    const replacedNode = liveRoot.childNodes[0];

    assert.equal(builder.release({ workflowId: 'workflow-a' }), true);
    await activate(builder, 'workflow-a');

    assert.notEqual(liveRoot.childNodes[0], replacedNode);
});
