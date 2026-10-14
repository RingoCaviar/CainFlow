import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCanvasMaterializationPlan, createCanvasMaterializationCommand } from '../js/features/conversation/conversation-canvas-materialization.js';

test('materialization preview declares workflow, placement, node types, and shared asset references', () => {
    const plan = buildCanvasMaterializationPlan({
        workflowId: 'workflow-a', messageId: 'assistant-a', textNodeType: 'TextChat',
        text: 'Use a low camera angle.', media: [{ assetKey: 'asset-a', mediaType: 'image' }],
        origin: { x: 400, y: 260 }
    });

    assert.deepEqual(plan.nodes.map((node) => node.type), ['TextChat', 'ImagePreview']);
    assert.equal(plan.nodes[1].restoreData.mediaAssetKeys[0], 'asset-a');
    assert.equal(plan.workflowId, 'workflow-a');
    assert.deepEqual(plan.origin, { x: 400, y: 260 });
});

test('materialization command is atomic on success, cancellation, and partial failure', async () => {
    const plan = buildCanvasMaterializationPlan({ workflowId: 'w', messageId: 'm', text: 'hello', media: [{ assetKey: 'a', mediaType: 'image' }], origin: { x: 0, y: 0 } });
    const nodes = new Map();
    const removed = [];
    let history = 0;
    const command = createCanvasMaterializationCommand({
        addNode(type, x, y, restoreData) {
            if (type === 'ImagePreview') throw new Error('failed');
            nodes.set('n1', { type, x, y, restoreData });
            return 'n1';
        },
        removeNode(id) { removed.push(id); nodes.delete(id); },
        pushHistory() { history += 1; return 'undo-a'; },
        discardHistory() { history -= 1; }
    });

    assert.deepEqual(await command.apply(plan, { confirmed: false }), { status: 'cancelled', nodeIds: [] });
    await assert.rejects(command.apply(plan, { confirmed: true }), /failed/);
    assert.equal(nodes.size, 0);
    assert.deepEqual(removed, ['n1']);
    assert.equal(history, 0);
});

test('successful materialization creates one undo unit, selects nodes, and switches Workspace mode', async () => {
    const plan = buildCanvasMaterializationPlan({ workflowId: 'w', messageId: 'm', text: 'hello', origin: { x: 20, y: 30 } });
    const events = [];
    const command = createCanvasMaterializationCommand({
        addNode: () => 'text-a', removeNode: () => {},
        pushHistory: () => { events.push('history'); return 'undo-a'; },
        selectNode: (id) => events.push(`select:${id}`),
        save: async () => { events.push('save'); return true; },
        switchToCanvas: () => events.push('canvas'), focusNode: (id) => events.push(`focus:${id}`)
    });

    assert.deepEqual(await command.apply(plan, { confirmed: true }), { status: 'applied', nodeIds: ['text-a'], undoToken: 'undo-a' });
    assert.deepEqual(events, ['history', 'select:text-a', 'save', 'canvas', 'focus:text-a']);
});

test('missing media is rejected before history or Canvas mutation', () => {
    assert.throws(() => buildCanvasMaterializationPlan({
        workflowId: 'w', messageId: 'm', media: [{ assetKey: 'missing', mediaType: 'image', missing: true }]
    }), /missing/);
});
