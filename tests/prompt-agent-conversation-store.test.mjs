import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';

test('each generation retains its ordered batch through archive, compaction and JSON restore', () => {
    const store = createPromptAgentConversationStore({ maxContextCharacters: 64 });
    const index = store.append({ role: 'agent', text: '方案', promptPlan: { targetNodeId: 'image', prompt: '猫' } });
    assert.equal(store.beginRun(index, { runId: 'run-a', targetNodeId: 'image' }), true);
    assert.equal(store.finishRun('run-a', { status: 'completed', mediaAssetKeys: ['media:b', 'media:a'], persistenceStatus: 'retained',
        mediaOwnershipTemporaryOwners: [{ ownerId: 'operation-a', assetKeys: ['media:b', 'media:a'] }] }), true);
    assert.equal(store.beginRun(index, { runId: 'run-b', targetNodeId: 'image' }), true);
    assert.equal(store.finishRun('run-b', { status: 'completed', mediaAssetKeys: ['media:c'], persistenceStatus: 'saved' }), true);
    store.append({ role: 'user', text: '追加'.repeat(40) });
    store.compact('保留两次结果');
    const restored = createPromptAgentConversationStore({ maxContextCharacters: 64 });
    restored.restore(JSON.parse(JSON.stringify(store.snapshot())));
    assert.deepEqual(restored.getRun('run-a').mediaAssetKeys, ['media:b', 'media:a']);
    assert.deepEqual(restored.getRun('run-b').mediaAssetKeys, ['media:c']);
    assert.equal(restored.snapshot().archivedMessages[index].runs.length, 2);
    assert.equal(restored.getRun('run-a').mediaOwnershipTemporaryOwners[0].ownerId, 'operation-a');
    assert.deepEqual(restored.snapshot(), store.snapshot());
});

test('generation records do not persist presentation URLs or accept stale completion after clear', () => {
    const store = createPromptAgentConversationStore();
    const index = store.append({ role: 'agent', text: '方案', promptPlan: { prompt: '猫' } });
    assert.equal(store.beginRun(index, { runId: 'run-a', targetNodeId: 'image', images: ['data:image/png;base64,PRIVATE'], previewUrl: 'blob:private' }), true);
    assert.equal(store.beginRun(index, { runId: 'run-a', targetNodeId: 'other' }), false);
    assert.equal(store.beginRun(99, { runId: 'run-b' }), false);
    store.finishRun('run-a', { status: 'completed', mediaAssetKeys: ['media:a'], images: ['https://remote.test/image'] });
    assert.doesNotMatch(JSON.stringify(store.snapshot()), /PRIVATE|blob:private|remote.test/);
    const returned = store.getRun('run-a');
    returned.mediaAssetKeys.push('media:external');
    assert.deepEqual(store.getRun('run-a').mediaAssetKeys, ['media:a']);
    assert.equal(store.finishRun('run-a', { mediaAssetKeys: ['media:replacement'] }), false);
    assert.equal(store.finishRun('run-a', { persistenceStatus: 'saved', mediaOwnershipTemporaryOwners: [] }), true);
    store.clear();
    assert.equal(store.finishRun('run-a', { status: 'completed', mediaAssetKeys: ['media:late'] }), false);
    assert.equal(store.getRun('run-a'), null);
    assert.deepEqual(store.snapshot().messages, []);
});

test('only explicit restart restoration marks unfinished generation records interrupted', () => {
    const store = createPromptAgentConversationStore();
    store.append({ role: 'agent', text: '方案', runs: [{ runId: 'run-a', targetNodeId: 'image', status: 'running' }] });
    const snapshot = store.snapshot();
    store.restore(snapshot);
    assert.equal(store.getRun('run-a').status, 'running');
    store.restore(snapshot, { interruptRunning: true });
    assert.equal(store.getRun('run-a').status, 'interrupted');
    store.restore({ messages: [{ role: 'agent', text: '旧存档' }] });
    assert.equal(store.snapshot().messages[0].runs, undefined);
});

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
    assert.deepEqual(store.snapshot(), { version: 1, memory: '', messages: [] });
});

test('explicit image model selection round-trips as optional version-one workflow data', () => {
    const store = createPromptAgentConversationStore();
    assert.equal(store.getImageModelId(), '');
    assert.equal(Object.hasOwn(store.snapshot(), 'imageModelId'), false);
    assert.equal(store.setImageModelId(' image-model-a '), true);
    assert.equal(store.getImageModelId(), 'image-model-a');
    assert.equal(store.setImageModelId('image-model-a'), false);
    store.append({ role: 'user', text: '画一只猫' });

    const snapshot = store.snapshot();
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.imageModelId, 'image-model-a');
    const restored = createPromptAgentConversationStore();
    restored.restore(snapshot);
    assert.equal(restored.getImageModelId(), 'image-model-a');
    assert.deepEqual(restored.snapshot(), snapshot);
    assert.equal(restored.setImageModelId(''), true);
    assert.equal(Object.hasOwn(restored.snapshot(), 'imageModelId'), false);
    assert.equal(restored.setImageModelId(''), false);
});

test('restoring each workflow replaces image selection without borrowing another workflow or legacy node data', () => {
    const store = createPromptAgentConversationStore();
    store.setImageModelId('model-a');
    const first = store.snapshot();
    store.restore(null);
    assert.equal(store.getImageModelId(), '');
    store.setImageModelId('model-b');
    const second = store.snapshot();
    store.restore(first);
    assert.equal(store.getImageModelId(), 'model-a');
    store.restore(second);
    assert.equal(store.getImageModelId(), 'model-b');

    for (const imageModelId of [undefined, null, 42, {}, [], true, '   ']) {
        store.restore({ version: 1, imageModelId, messages: [{
            role: 'agent', text: '旧方案', promptPlan: {
                targetNodeId: 'node-a', modelId: 'node-model', prompt: '猫', parameters: {}
            }
        }] });
        assert.equal(store.getImageModelId(), '');
        assert.equal(Object.hasOwn(store.snapshot(), 'imageModelId'), false);
        store.setImageModelId('model-b');
    }
    store.restore({ version: 1, messages: [] });
    assert.equal(store.getImageModelId(), '');
});

test('context trimming, compaction and clearing retain the explicitly selected image model', () => {
    const store = createPromptAgentConversationStore({ maxContextCharacters: 64 });
    store.setImageModelId('image-model');
    store.append({ role: 'user', text: '初始要求'.repeat(30) });
    store.append({ role: 'agent', text: '新的方案' });
    assert.ok(store.snapshot().archivedMessages.length > 0);
    assert.equal(store.getImageModelId(), 'image-model');
    store.compact('保留最新方案');
    assert.equal(store.snapshot().imageModelId, 'image-model');
    store.clear();
    assert.deepEqual(store.snapshot(), {
        version: 1, memory: '', messages: [], imageModelId: 'image-model'
    });
    store.restore(null);
    assert.equal(store.getImageModelId(), '');
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

test('distinct scene selections with identical pixels preserve their order and node identity after restore', () => {
    const dataUrl = 'data:image/png;base64,SAME';
    const references = ['b', 'a'].map((id) => ({
        referenceId: `import-${id}`, sourceNodeId: id, sourceImageIndex: 0, name: id, type: 'image/png', dataUrl
    }));
    const store = createPromptAgentConversationStore();
    store.append({ role: 'user', text: '第 2 张', referenceImages: references });
    const restored = createPromptAgentConversationStore();
    restored.restore(store.snapshot());
    assert.deepEqual(restored.snapshot().messages[0].referenceImages, references);
    assert.deepEqual(restored.getReferenceImages(), references);
});

test('compression preserves the complete latest draft, image roles and workflow isolation', () => {
    const store = createPromptAgentConversationStore({ maxContextCharacters: 80 });
    const draft = {
        targetNodeId: 'image-1', prompt: '详细画面'.repeat(40), parameters: { count: 2 },
        referenceImages: [{ name: '照片', imageId: 'image-1', role: 'edit-target', dataUrl: 'data:image/png;base64,IMAGE' }]
    };
    store.append({ role: 'agent', intent: 'edit', text: '上版方案', promptPlan: draft });
    store.append({ role: 'user', text: '新的讨论'.repeat(40) });
    const snapshot = store.snapshot();
    assert.equal(snapshot.previousPromptPlan.prompt, draft.prompt);
    assert.equal(snapshot.previousPromptPlan.referenceImages[0].role, 'edit-target');
    assert.doesNotMatch(JSON.stringify(snapshot.previousPromptPlan), /base64/);
    const restored = createPromptAgentConversationStore({ maxContextCharacters: 80 });
    restored.restore(snapshot);
    assert.equal(restored.snapshot().previousPromptPlan.prompt, draft.prompt);
    restored.restore(null);
    assert.equal(restored.snapshot().previousPromptPlan, undefined);
});

test('explicit compaction replaces effective history while preserving visible turns, latest plan and reference identities', () => {
    const store = createPromptAgentConversationStore();
    const references = ['first', 'second'].map((id) => ({
        referenceId: id, sourceNodeId: `node-${id}`, sourceImageIndex: 0,
        name: `${id}.png`, type: 'image/png', dataUrl: `data:image/png;base64,${id}`
    }));
    store.append({ role: 'user', text: '保持第 2 张的主体。', referenceImages: references });
    store.append({ role: 'agent', text: '第一版方案', promptPlan: { prompt: '原始背景', parameters: {} } });
    const latestPlan = {
        targetNodeId: 'image-1', prompt: '第二张主体，蓝色背景', negativePrompt: '',
        parameters: { count: 2 }, referenceImages: [
            { ...references[1], imageId: 'image-2', role: 'edit-target', previewUrl: '不持久化的预览' }
        ]
    };
    store.append({ role: 'agent', text: '新版待应用', promptPlan: latestPlan });
    const originalMessages = store.snapshot().messages;
    store.restore({ ...store.snapshot(), panelWidth: 550 });

    store.compact(' 保留第二张主体，背景改蓝；新版方案待应用。 ');
    const snapshot = store.snapshot();
    assert.equal(snapshot.contextSummary, '保留第二张主体，背景改蓝；新版方案待应用。');
    assert.equal(snapshot.compactedMessageCount, originalMessages.length);
    assert.equal(snapshot.memory, '');
    assert.deepEqual(snapshot.messages, []);
    assert.deepEqual(snapshot.archivedMessages, originalMessages);
    assert.equal(snapshot.previousPromptPlan.prompt, latestPlan.prompt);
    assert.equal(snapshot.previousPromptPlan.negativePrompt, '');
    assert.equal(snapshot.previousPromptPlan.referenceImages[0].referenceId, 'second');
    assert.doesNotMatch(JSON.stringify(snapshot.previousPromptPlan), /base64|previewUrl/);
    assert.deepEqual(store.getReferenceImages(), references);
    assert.equal(snapshot.panelWidth, undefined);
    assert.match(store.getContext(), /^上下文摘要：保留第二张主体/);
    assert.doesNotMatch(store.getContext(), /第一版方案|保持第 2 张的主体/);
});

test('repeated compaction merges only new visible turns into the archive and round-trips all context state', () => {
    const store = createPromptAgentConversationStore();
    store.append({ role: 'user', text: '第一轮' });
    store.append({ role: 'agent', text: '初稿', promptPlan: { prompt: '红色主体', parameters: {} } });
    store.compact('第一轮摘要');
    store.append({ role: 'user', text: '换蓝色主体' });
    store.append({ role: 'agent', text: '新版', promptPlan: { prompt: '蓝色主体', parameters: {} } });
    store.compact('主体已改蓝，后续保持一致。');
    const snapshot = store.snapshot();
    assert.equal(snapshot.archivedMessages.length, 4);
    assert.equal(snapshot.compactedMessageCount, 4);
    assert.equal(snapshot.previousPromptPlan.prompt, '蓝色主体');
    assert.equal(snapshot.contextSummary, '主体已改蓝，后续保持一致。');
    assert.doesNotMatch(store.getContext(), /第一轮摘要/);

    const restored = createPromptAgentConversationStore();
    restored.restore(snapshot);
    assert.deepEqual(restored.snapshot(), snapshot);
    restored.compact('相同目标的新摘要');
    assert.equal(restored.snapshot().archivedMessages.length, 4);
    assert.equal(restored.snapshot().previousPromptPlan.prompt, '蓝色主体');
});

test('automatic compaction archives old turns without truncating an explicit checkpoint', () => {
    const store = createPromptAgentConversationStore({ maxContextCharacters: 80 });
    const summary = `最初目标必须保留：${'固定身份和构图。'.repeat(30)}`;
    store.append({ role: 'user', text: '初始要求' });
    store.compact(summary);
    store.append({ role: 'user', text: '补充要求'.repeat(25) });
    store.append({ role: 'agent', text: '中间回复'.repeat(25) });
    store.append({ role: 'user', text: '最后一条要求'.repeat(25) });
    const snapshot = store.snapshot();
    assert.equal(snapshot.contextSummary, summary);
    assert.equal(snapshot.archivedMessages.length + snapshot.messages.length, 4);
    assert.equal(snapshot.archivedMessages[0].text, '初始要求');
    assert.ok(snapshot.memory.length <= 40);
    assert.ok(store.getContext().startsWith(`上下文摘要：${summary}\n`));
    assert.ok(store.getContext().length <= summary.length + 80 + 8);
    assert.match(store.getContext(), /最后一条要求/);

    const restored = createPromptAgentConversationStore({ maxContextCharacters: 80 });
    restored.restore(snapshot);
    assert.deepEqual(restored.snapshot(), snapshot);
});

test('restoring archive-only reference images and plans recovers usable context without resending archived text', () => {
    const image = {
        name: '来源.png', referenceId: 'source-1', sourceNodeId: 'source-node', sourceImageIndex: 0,
        dataUrl: 'data:image/png;base64,PICTURE', type: 'image/png', previewUrl: '临时预览', loading: true
    };
    const store = createPromptAgentConversationStore();
    store.restore({
        version: 1, contextSummary: '保留已选图的主体。', memory: '', messages: [],
        archivedMessages: [
            { role: 'user', text: '归档原文', referenceImages: [image] },
            { role: 'agent', text: '归档草稿', promptPlan: { prompt: '完整历史方案', parameters: { count: 3 } } }
        ]
    });
    const snapshot = store.snapshot();
    assert.equal(snapshot.previousPromptPlan.prompt, '完整历史方案');
    assert.equal(snapshot.archivedMessages.length, 2);
    assert.equal(store.getReferenceImages()[0].dataUrl, image.dataUrl);
    assert.equal(snapshot.referenceImages[0].previewUrl, undefined);
    assert.equal(snapshot.referenceImages[0].loading, undefined);
    assert.doesNotMatch(store.getContext(), /归档原文|归档草稿/);
    store.append({ role: 'agent', text: '更新', promptPlan: { prompt: '新的方案', parameters: {} } });
    assert.equal(store.snapshot().previousPromptPlan, undefined);
    store.compact('新版待应用');
    assert.equal(store.snapshot().previousPromptPlan.prompt, '新的方案');
});

test('clear resets checkpoints, memory, archives, references and plans without serializing legacy panel width', () => {
    const store = createPromptAgentConversationStore({ maxContextCharacters: 80 });
    store.restore({ panelWidth: 610 });
    store.append({ role: 'user', text: '请求', referenceImages: [
        { name: '图片', type: 'image/png', dataUrl: 'data:image/png;base64,SOURCE' }
    ] });
    store.append({ role: 'agent', text: '方案', promptPlan: { prompt: '旧画面', parameters: {} } });
    store.compact('旧摘要');
    store.append({ role: 'user', text: '后续要求'.repeat(30) });
    store.append({ role: 'agent', text: '后续回复'.repeat(30) });
    store.clear();
    assert.deepEqual(store.snapshot(), { version: 1, memory: '', messages: [] });
    assert.equal(store.getContext(), '');
    assert.deepEqual(store.getReferenceImages(), []);
});

test('invalid compaction summaries leave all state untouched and accepted summaries are isolated from callers', () => {
    const store = createPromptAgentConversationStore();
    store.append({ role: 'user', text: '既有上下文' });
    const before = store.snapshot();
    for (const summary of [undefined, null, 42, {}, '', ' \n ', '长'.repeat(3001)]) {
        assert.throws(() => store.compact(summary), /摘要/);
        assert.deepEqual(store.snapshot(), before);
    }
    store.compact('摘'.repeat(3000));
    const snapshot = store.snapshot();
    snapshot.archivedMessages[0].text = '外部修改';
    assert.equal(store.snapshot().archivedMessages[0].text, '既有上下文');
});

test('invalid restored checkpoints are rejected atomically while legacy snapshots still restore', () => {
    const store = createPromptAgentConversationStore();
    store.append({ role: 'user', text: '应保留的上下文' });
    store.compact('有效摘要');
    const before = store.snapshot();
    for (const contextSummary of [null, 42, ' \n ', '长'.repeat(3001)]) {
        assert.throws(() => store.restore({ contextSummary, messages: [{ role: 'user', text: '无效替代' }] }), /摘要/);
        assert.deepEqual(store.snapshot(), before);
    }
    store.restore({ version: 1, memory: '旧版记忆', messages: [{ role: 'user', text: '旧版消息' }] });
    assert.equal(store.snapshot().contextSummary, undefined);
    assert.equal(store.snapshot().archivedMessages, undefined);
    assert.match(store.getContext(), /旧版记忆.*\n用户：旧版消息/);
});

test('manual compaction receives every automatically archived turn before its first semantic checkpoint', () => {
    const store = createPromptAgentConversationStore({ maxContextCharacters: 80 });
    const firstConstraint = '永久硬约束：必须保留右下角原始商标文字。';
    store.append({ role: 'user', text: firstConstraint });
    store.append({ role: 'agent', text: '回复'.repeat(60) });
    store.append({ role: 'user', text: '追加细节'.repeat(60) });
    store.append({ role: 'user', text: '最后补充'.repeat(60) });
    const ordinary = store.snapshot();
    assert.doesNotMatch(ordinary.memory, /永久硬约束/);
    assert.equal(ordinary.messages.some((message) => message.text === firstConstraint), false);
    const compaction = store.getCompactionContext();
    assert.deepEqual(compaction.archivedMessages, []);
    assert.equal(compaction.messages[0].text, firstConstraint);
    assert.equal(compaction.messages.length, 4);
    compaction.messages[0].text = '不能修改原存储';
    assert.equal(store.snapshot().archivedMessages[0].text, firstConstraint);
});

test('successive checkpoints persist their boundary and include only newly archived original turns for compaction', () => {
    const store = createPromptAgentConversationStore({ maxContextCharacters: 80 });
    store.append({ role: 'user', text: '第一阶段原文' });
    store.append({ role: 'agent', text: '第一阶段回复' });
    store.compact('第一阶段摘要');
    store.append({ role: 'user', text: '第二阶段硬约束'.repeat(30) });
    store.append({ role: 'agent', text: '第二阶段回复'.repeat(30) });
    store.append({ role: 'user', text: '第二阶段最新请求'.repeat(30) });
    const snapshot = store.snapshot();
    assert.equal(snapshot.compactedMessageCount, 2);
    assert.equal(snapshot.archivedMessages.length, 4);
    const restored = createPromptAgentConversationStore({ maxContextCharacters: 80 });
    restored.restore(snapshot);
    assert.deepEqual(restored.snapshot(), snapshot);
    const context = restored.getCompactionContext();
    assert.equal(context.contextSummary, '第一阶段摘要');
    assert.equal(context.archivedMessages.length, 2);
    assert.equal(context.messages.length, 3);
    assert.ok(context.messages.every((message) => message.text.startsWith('第二阶段')));
    restored.compact('第一与第二阶段合并摘要');
    assert.equal(restored.snapshot().compactedMessageCount, 5);
    assert.equal(restored.getCompactionContext().messages.length, 0);
    assert.equal(restored.getCompactionContext().archivedMessages.length, 5);
});

test('target bindings survive automatic trimming, explicit compaction and restore without rebinding other plans', () => {
    for (const compact of ['none', 'automatic', 'explicit']) {
        const store = createPromptAgentConversationStore({ maxContextCharacters: compact === 'automatic' ? 64 : 4000 });
        const old = store.append({ role: 'agent', text: '旧方案', promptPlan: { targetNodeId: null, prompt: '同一提示词', parameters: {} } });
        const latest = store.append({ role: 'agent', text: '新方案', promptPlan: { targetNodeId: null, prompt: '同一提示词', parameters: {} } });
        if (compact === 'automatic') store.append({ role: 'user', text: '继续'.repeat(80) });
        if (compact === 'explicit') store.compact('保留新方案');
        assert.equal(store.bindPromptPlanTarget(latest, 'created'), true);
        assert.equal(store.bindPromptPlanTarget(latest, 'another'), false);
        assert.equal(store.bindPromptPlanTarget(-1, 'bad'), false);
        const snapshot = store.snapshot();
        const transcript = [...(snapshot.archivedMessages || []), ...snapshot.messages];
        assert.equal(transcript[old].promptPlan.targetNodeId, null);
        assert.equal(transcript[latest].promptPlan.targetNodeId, 'created');
        if (compact !== 'none') assert.equal(snapshot.previousPromptPlan.targetNodeId, 'created');
        const restored = createPromptAgentConversationStore();
        restored.restore(snapshot);
        assert.deepEqual(restored.snapshot(), snapshot);
        assert.equal(restored.bindPromptPlanTarget(old, 'older-target'), true);
        if (compact !== 'none') assert.equal(restored.snapshot().previousPromptPlan.targetNodeId, 'created');
    }
});

test('legacy checkpoints infer archive coverage while invalid persisted coverage never replaces live state', () => {
    const store = createPromptAgentConversationStore();
    const archivedMessages = [{ role: 'user', text: '归档原文' }];
    store.restore({ contextSummary: '已有摘要', archivedMessages, messages: [] });
    assert.equal(store.snapshot().compactedMessageCount, 1);
    assert.deepEqual(store.getCompactionContext().messages, []);
    const before = store.snapshot();
    for (const compactedMessageCount of [-1, 2, 0.5, '1', null]) {
        assert.throws(() => store.restore({ ...before, compactedMessageCount }), /压缩|归档/);
        assert.deepEqual(store.snapshot(), before);
    }
    store.restore({ archivedMessages, messages: [] });
    assert.equal(store.getCompactionContext().messages[0].text, '归档原文');
    store.clear();
    assert.deepEqual(store.getCompactionContext().messages, []);
    assert.deepEqual(store.getCompactionContext().archivedMessages, []);
});
