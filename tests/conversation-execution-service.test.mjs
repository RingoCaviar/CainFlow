import assert from 'node:assert/strict';
import test from 'node:test';

import { createConversationExecutionService, deriveConversationTitle, projectConversationContext } from '../js/features/conversation/conversation-execution-service.js';

function conversation(id = 'c1') {
    return {
        id,
        revision: 1,
        defaultModelId: 'm1',
        defaultProviderId: 'p1',
        systemPrompt: '简洁回答',
        systemPromptVersion: 3,
        messages: [{ id: 'old', role: 'user', status: 'completed', parts: [{ type: 'text', text: '历史问题' }] }]
    };
}

test('Conversation execution persists the user turn and actual completed assistant execution record', async () => {
    const appended = [];
    const updated = [];
    const api = {
        appendConversationMessage: async (_id, input) => {
            appended.push(input);
            return { message: { id: `message-${appended.length}`, ...input }, conversationRevision: input.revision + 1 };
        },
        updateConversationMessage: async (_conversationId, messageId, input) => {
            updated.push({ messageId, input });
            return { message: { id: messageId, ...input }, conversationRevision: input.revision + 1 };
        }
    };
    const service = createConversationExecutionService({
        api,
        createPlan: (input) => ({ ...input, protocol: 'openai', requestBody: {} }),
        executePlan: async () => ({ text: '完成回复', diagnosticId: 'diag-redacted' }),
        now: (() => { let value = 100; return () => ++value; })()
    });

    const result = await service.send({
        conversation: conversation(),
        text: '新问题',
        model: { id: 'm1', modelId: 'chat-1', name: 'Chat 1' },
        provider: { id: 'p1', name: 'Provider 1', apikey: 'secret' }
    });

    assert.equal(result.text, '完成回复');
    assert.equal(appended[0].role, 'user');
    assert.equal(appended[1].role, 'assistant');
    assert.equal(appended[1].status, 'pending');
    assert.equal(updated[0].input.status, 'completed');
    assert.equal(updated[0].input.parts[0].text, '完成回复');
    assert.equal(updated[0].input.execution.modelId, 'm1');
    assert.equal(updated[0].input.execution.providerId, 'p1');
    assert.equal(updated[0].input.execution.systemPromptVersion, 3);
    assert.equal(JSON.stringify(updated).includes('secret'), false);
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function memoryApi() {
    const revisions = new Map();
    return {
        appendConversationMessage: async (id, input) => {
            const revision = (revisions.get(id) || input.revision) + 1;
            revisions.set(id, revision);
            return { message: { id: `${id}-${revision}`, ...input }, conversationRevision: revision };
        },
        updateConversationMessage: async (id, messageId, input) => {
            const revision = (revisions.get(id) || input.revision) + 1;
            revisions.set(id, revision);
            return { message: { id: messageId, ...input }, conversationRevision: revision };
        }
    };
}

test('one Conversation rejects overlapping requests while another Conversation runs independently', async () => {
    const gates = new Map([['c1', deferred()], ['c2', deferred()]]);
    const service = createConversationExecutionService({
        api: memoryApi(),
        createPlan: ({ messages }) => ({ conversationId: messages.at(-1).content, requestBody: {} }),
        executePlan: (plan) => gates.get(plan.conversationId).promise
    });
    const input = (id) => ({
        conversation: conversation(id), text: id,
        model: { id: 'm1', modelId: 'chat' }, provider: { id: 'p1' }
    });

    const first = service.send(input('c1'));
    await assert.rejects(service.send(input('c1')), (error) => error.code === 'conversation_busy');
    const second = service.send(input('c2'));
    assert.equal(service.getRunState('c1').status, 'running');
    assert.equal(service.getRunState('c2').status, 'running');
    gates.get('c1').resolve({ text: 'one' });
    gates.get('c2').resolve({ text: 'two' });
    assert.deepEqual((await Promise.all([first, second])).map((item) => item.text), ['one', 'two']);
});

test('stopping a streaming Conversation persists its partial assistant response', async () => {
    const updates = [];
    const api = memoryApi();
    const originalUpdate = api.updateConversationMessage;
    api.updateConversationMessage = async (...args) => {
        const result = await originalUpdate(...args);
        updates.push(args[2]);
        return result;
    };
    const service = createConversationExecutionService({
        api,
        createPlan: () => ({ requestBody: {} }),
        executePlan: (_plan, { signal, onChunk }) => new Promise((_resolve, reject) => {
            onChunk('已经生成');
            signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'aborted' })), { once: true });
        })
    });
    const running = service.send({
        conversation: conversation(), text: 'stop-me',
        model: { id: 'm1', modelId: 'chat' }, provider: { id: 'p1' }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.stop('c1'), true);
    await assert.rejects(running, /stopped/);
    assert.equal(updates.at(-1).status, 'partial');
    assert.equal(updates.at(-1).parts[0].text, '已经生成');
});

test('automatic retry retains every request attempt under one assistant response', async () => {
    const updates = [];
    const api = memoryApi();
    const originalUpdate = api.updateConversationMessage;
    api.updateConversationMessage = async (...args) => {
        updates.push(args[2]);
        return originalUpdate(...args);
    };
    let calls = 0;
    const service = createConversationExecutionService({
        api,
        maxRetries: 1,
        createPlan: () => ({ requestBody: {} }),
        executePlan: async () => {
            calls += 1;
            if (calls === 1) throw Object.assign(new Error('temporary'), { code: 'timeout' });
            return { text: 'retried' };
        }
    });

    await service.send({
        conversation: conversation(), text: 'retry',
        model: { id: 'm1', modelId: 'chat' }, provider: { id: 'p1' }
    });
    const attempts = updates.at(-1).execution.attempts;
    assert.deepEqual(attempts.map(({ ordinal, status }) => ({ ordinal, status })), [
        { ordinal: 1, status: 'failed' }, { ordinal: 2, status: 'completed' }
    ]);
    assert.equal(attempts[0].error.code, 'timeout');
});

test('context projection keeps durable history intact and reports omissions at the model boundary', () => {
    const durable = conversation();
    durable.messages = [
        { role: 'user', status: 'completed', parts: [{ type: 'text', text: 'older-12345' }] },
        { role: 'assistant', status: 'completed', parts: [{ type: 'text', text: 'newer-12345' }] }
    ];
    const projection = projectConversationContext({ conversation: durable, nextUserText: 'latest', maxCharacters: 18 });

    assert.deepEqual(durable.messages.map((message) => message.parts[0].text), ['older-12345', 'newer-12345']);
    assert.deepEqual(projection.messages.map((message) => message.content), ['newer-12345', 'latest']);
    assert.equal(projection.summary.omittedMessageCount, 1);
});

test('restart recovery marks an interrupted pending assistant response as failed', async () => {
    const updates = [];
    const service = createConversationExecutionService({
        api: { updateConversationMessage: async (_id, messageId, input) => {
            updates.push(input);
            return { message: { id: messageId, ...input }, conversationRevision: input.revision + 1 };
        } },
        createPlan: () => ({}), executePlan: async () => ({ text: '' })
    });
    const restored = conversation();
    restored.messages = [{ id: 'pending-a', role: 'assistant', status: 'pending', parts: [{ type: 'text', text: '' }] }];

    const result = await service.recoverInterrupted(restored);
    assert.equal(result.messages[0].status, 'failed');
    assert.equal(updates[0].execution.status, 'interrupted');
});

test('request timeout aborts transport and persists a classified failed attempt', async () => {
    const updates = [];
    const api = memoryApi();
    const originalUpdate = api.updateConversationMessage;
    api.updateConversationMessage = async (...args) => { updates.push(args[2]); return originalUpdate(...args); };
    const service = createConversationExecutionService({
        api, requestTimeoutMs: 5,
        createPlan: () => ({ requestBody: {} }),
        executePlan: (_plan, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
    });

    await assert.rejects(service.send({
        conversation: conversation(), text: 'timeout',
        model: { id: 'm1', modelId: 'chat' }, provider: { id: 'p1' }
    }), (error) => error.code === 'conversation_timeout');
    assert.equal(updates.at(-1).execution.attempts[0].error.code, 'conversation_timeout');
});

test('first user message derives a bounded local title', () => {
    assert.equal(deriveConversationTitle('  一个   简洁的标题  '), '一个 简洁的标题');
    assert.equal(deriveConversationTitle('x'.repeat(40)), `${'x'.repeat(32)}…`);
});

test('regeneration appends a sibling assistant version without overwriting the previous reply', async () => {
    const appended = [];
    const api = memoryApi();
    const originalAppend = api.appendConversationMessage;
    api.appendConversationMessage = async (id, input) => { appended.push(input); return originalAppend(id, input); };
    const service = createConversationExecutionService({
        api, createPlan: () => ({ requestBody: {} }), executePlan: async () => ({ text: 'new version' })
    });
    const source = conversation();
    source.revision = 4;
    source.messages = [
        { id: 'u1', role: 'user', status: 'completed', parts: [{ type: 'text', text: 'question' }] },
        { id: 'a1', parentMessageId: 'u1', role: 'assistant', status: 'completed', parts: [{ type: 'text', text: 'old version' }] }
    ];

    await service.regenerate({ conversation: source, assistantMessageId: 'a1', model: { id: 'm1', modelId: 'chat' }, provider: { id: 'p1' } });
    assert.equal(appended.length, 1);
    assert.equal(appended[0].role, 'assistant');
    assert.equal(appended[0].parentMessageId, 'u1');
    assert.equal(source.messages[1].parts[0].text, 'old version');
});
