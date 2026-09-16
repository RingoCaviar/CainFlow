import assert from 'node:assert/strict';
import test from 'node:test';

import {
    appendConversationMessage,
    listConversations,
    updateConversation
} from '../js/services/conversation-api.js';

test('conversation client maps filters and versioned mutations to the public HTTP API', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url).includes('/messages')) {
            return new Response(JSON.stringify({ message: { id: 'message-a' }, conversationRevision: 3 }));
        }
        if (options.method === 'PUT') return new Response(JSON.stringify({ conversation: { id: 'conversation-a', revision: 2 } }));
        return new Response(JSON.stringify({ conversations: [{ id: 'conversation-a' }] }));
    };
    try {
        assert.deepEqual(await listConversations({ status: 'archived', workflowId: 'workflow-a', search: 'quiet' }), [{ id: 'conversation-a' }]);
        assert.equal((await updateConversation('conversation-a', { revision: 1, title: 'Quiet' })).revision, 2);
        assert.equal((await appendConversationMessage('conversation-a', {
            revision: 2, role: 'user', status: 'completed', parts: [{ type: 'text', text: 'Hello' }]
        })).conversationRevision, 3);
    } finally {
        globalThis.fetch = previousFetch;
    }
    assert.equal(calls[0].url, '/api/conversations?status=archived&workflowId=workflow-a&search=quiet');
    assert.equal(calls[1].options.method, 'PUT');
    assert.equal(calls[2].url, '/api/conversations/conversation-a/messages');
});
