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
