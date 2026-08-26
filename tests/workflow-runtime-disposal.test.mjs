import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowRuntimeDisposer } from '../js/features/workflow/workflow-runtime-disposal.js';

test('workflow runtime disposal is idempotent and keeps adopted nodes when requested', () => {
    const events = [];
    const nodes = new Map([['node-1', { id: 'node-1' }]]);
    const registry = new Map([['context-1', {}]]);
    const resources = {
        contextId: 'context-1',
        registry,
        state: { nodes, connections: [{ id: 'connection-1' }] },
        nodeLifecycle: { cancelPendingImageRestores: () => events.push('cancel-media') },
        connections: { destroy: () => events.push('destroy-connections') },
        elements: { wrapper: { remove: () => events.push('remove-wrapper') } },
        layoutHost: { dispose: () => events.push('dispose-layout') },
        cleanupNode: () => events.push('cleanup-node')
    };
    const dispose = createWorkflowRuntimeDisposer(resources);

    dispose({ keepNodes: true });
    dispose({ keepNodes: true });

    assert.equal(nodes.size, 1);
    assert.deepEqual(resources.state.connections, []);
    assert.equal(registry.has('context-1'), false);
    assert.deepEqual(events, [
        'cancel-media',
        'destroy-connections',
        'remove-wrapper',
        'dispose-layout'
    ]);
});

test('workflow runtime disposal releases remaining resources when node cleanup fails', () => {
    const events = [];
    const resources = {
        contextId: 'context-1',
        registry: new Map([['context-1', {}]]),
        state: {
            nodes: new Map([
                ['broken', { id: 'broken' }],
                ['healthy', { id: 'healthy' }]
            ]),
            connections: [{}]
        },
        connections: { destroy: () => events.push('destroy-connections') },
        elements: { wrapper: { remove: () => events.push('remove-wrapper') } },
        layoutHost: { dispose: () => events.push('dispose-layout') },
        cleanupNode: (node) => {
            events.push(`cleanup:${node.id}`);
            if (node.id === 'broken') throw new Error('broken cleanup');
        }
    };

    createWorkflowRuntimeDisposer(resources)();

    assert.equal(resources.state.nodes.size, 0);
    assert.deepEqual(events, [
        'destroy-connections',
        'cleanup:broken',
        'cleanup:healthy',
        'remove-wrapper',
        'dispose-layout'
    ]);
});
