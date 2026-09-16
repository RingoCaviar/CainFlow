import assert from 'node:assert/strict';
import test from 'node:test';

import { createStagedConversationContext, snapshotWorkflowNode } from '../js/features/conversation/conversation-context.js';

test('staged Conversation context preserves visible order and removes items explicitly', () => {
    const context = createStagedConversationContext();
    context.add({ id: 'a', type: 'media', assetKey: 'asset-a' });
    context.add({ id: 'b', type: 'media', assetKey: 'asset-b' });
    context.move('b', 0);
    context.remove('a');

    assert.deepEqual(context.list().map((item) => item.id), ['b']);
    assert.deepEqual(context.toMessageParts(), [{ type: 'media', assetKey: 'asset-b', mediaType: 'image' }]);
});

test('node source snapshot is immutable after the workflow node changes', () => {
    const node = { id: 'node-a', type: 'TextChat', data: { text: 'original', mediaAssetKeys: ['asset-1', 'asset-2'] } };
    const snapshot = snapshotWorkflowNode({ workflowId: 'workflow-a', node });
    node.data.text = 'changed';
    node.data.mediaAssetKeys.reverse();

    assert.deepEqual(snapshot, {
        type: 'node-source', workflowId: 'workflow-a', nodeId: 'node-a', nodeType: 'TextChat',
        textSnapshot: 'original', mediaAssetKeys: ['asset-1', 'asset-2']
    });
});
