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

test('reference images round-trip without adding image payloads to text context', () => {
    const store = createPromptAgentConversationStore();
    store.append({
        role: 'user',
        text: '参考这个构图',
        referenceImages: [{ name: '构图.png', type: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }]
    });

    const restored = createPromptAgentConversationStore();
    restored.restore(store.snapshot());
    assert.equal(restored.getReferenceImages()[0].dataUrl, 'data:image/png;base64,AAAA');
    assert.match(restored.getContext(), /构图\.png/);
    assert.doesNotMatch(restored.getContext(), /AAAA/);

    store.append({
        role: 'agent',
        text: '已整理方案',
        promptPlan: { prompt: '主体', parameters: {}, referenceImages: [{ name: '构图.png', type: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }] }
    });
    const plan = store.snapshot().messages.at(-1).promptPlan;
    assert.equal(plan.referenceImages[0].dataUrl, undefined);
    assert.equal(JSON.stringify(plan).includes('AAAA'), false);
});

test('reference images remain available after older turns are compressed', () => {
    const store = createPromptAgentConversationStore({ maxContextCharacters: 80 });
    store.append({
        role: 'user',
        text: '请保留这个主体和构图，并持续使用同一套视觉语言',
        referenceImages: [{ name: '主体.png', type: 'image/png', dataUrl: 'data:image/png;base64,SOURCE' }]
    });
    store.append({ role: 'agent', text: '已整理第一版方案，并保留当前主体与构图。', promptPlan: { prompt: '主体', parameters: {} } });
    store.append({ role: 'user', text: '再调整光线和色彩，让画面保持一致并继续迭代' });

    const snapshot = store.snapshot();
    assert.equal(snapshot.messages.some((message) => message.referenceImages?.length), false);
    assert.equal(store.getReferenceImages()[0].name, '主体.png');
    const restored = createPromptAgentConversationStore({ maxContextCharacters: 80 });
    restored.restore(snapshot);
    assert.equal(restored.getReferenceImages()[0].dataUrl, 'data:image/png;base64,SOURCE');
});
