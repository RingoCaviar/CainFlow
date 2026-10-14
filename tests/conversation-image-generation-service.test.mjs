import assert from 'node:assert/strict';
import test from 'node:test';

import { createConversationImageGenerationService } from '../js/features/conversation/conversation-image-generation-service.js';

test('Conversation image generation creates and executes a configured ImageGenerate node', async () => {
    const calls = [];
    const service = createConversationImageGenerationService({
        ensureWorkflow: async () => true,
        createImageNode: (input) => { calls.push(['create', input]); return { id: 'image-node-1' }; },
        executeImageNode: async (node) => { calls.push(['execute', node.id]); return { image: 'data:image/png;base64,ok' }; }
    });

    const result = await service.generate({
        conversationId: 'c1', prompt: '雨夜的霓虹街道',
        model: { id: 'image-model', taskType: 'image' }, provider: { id: 'provider-1' }
    });

    assert.equal(result.nodeId, 'image-node-1');
    assert.deepEqual(calls, [
        ['create', { prompt: '雨夜的霓虹街道', model: { id: 'image-model', taskType: 'image' }, provider: { id: 'provider-1' } }],
        ['execute', 'image-node-1']
    ]);
});

test('Conversation image generation blocks incomplete setup before creating a canvas node', async () => {
    const service = createConversationImageGenerationService();

    await assert.rejects(service.generate({ conversationId: 'c1', prompt: '图', model: null, provider: null }), /生图模型与 Provider/);
});
