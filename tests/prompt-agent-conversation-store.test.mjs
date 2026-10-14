import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';

test('conversation and Workflow Memory round-trip as workflow-scoped data', () => {
    const store = createPromptAgentConversationStore({ maxContextCharacters: 500 });
    store.append({ role: 'user', text: '做一张城市夜景' });
    store.append({ role: 'agent', text: '计划已就绪', promptPlan: { targetNodeId: 'image-1', prompt: '城市夜景', parameters: {} } });

    const snapshot = store.snapshot();
    const restored = createPromptAgentConversationStore({ maxContextCharacters: 500 });
    restored.restore(snapshot);

    assert.deepEqual(restored.snapshot(), snapshot);
    assert.match(restored.getContext(), /城市夜景/);
});

test('oversized context compresses older turns and keeps recent turns usable', () => {
    const store = createPromptAgentConversationStore({ maxContextCharacters: 90 });
    store.append({ role: 'user', text: `角色设定：${'红色长发'.repeat(12)}` });
    store.append({ role: 'agent', text: `已记录：${'电影感'.repeat(12)}` });
    store.append({ role: 'user', text: '这次改成侧脸构图' });

    const snapshot = store.snapshot();
    assert.ok(snapshot.memory.length > 0);
    assert.doesNotMatch(snapshot.memory, /用户：|Agent：/);
    assert.ok(snapshot.messages.length < 3);
    assert.match(store.getContext(), /侧脸构图/);
    assert.ok(store.getContext().length <= 180);
});

test('a single oversized recent turn is bounded when building Agent context', () => {
    const store = createPromptAgentConversationStore({ maxContextCharacters: 80 });
    store.append({ role: 'user', text: '场景'.repeat(100) });
    assert.ok(store.getContext().length <= 80);
});

test('restoring missing workflow Agent data clears previous conversation', () => {
    const store = createPromptAgentConversationStore();
    store.append({ role: 'user', text: '旧工作流内容' });
    store.restore(null);
    assert.deepEqual(store.snapshot(), { version: 1, memory: '', messages: [], panelWidth: null });
});
