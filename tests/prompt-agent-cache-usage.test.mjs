import assert from 'node:assert/strict';
import test from 'node:test';

import { getPromptAgentCacheUsage } from '../js/features/prompt-agent/prompt-agent-cache-usage.js';
import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';

const emptyUsage = {
    bytes: 0,
    workflowCount: 0,
    messageCount: 0,
    activeMessageCount: 0,
    archivedMessageCount: 0,
    referenceCount: 0,
    resultCount: 0,
    summaryCount: 0
};
const tab = (workflowId, promptAgent) => ({ workflowId, data: { workflowId, promptAgent } });
const conversation = (text) => ({ version: 1, memory: '', messages: [{ role: 'user', text }], panelWidth: 400 });
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const reference = (referenceId, dataUrl = 'data:image/png;base64,SAME') => ({ referenceId, name: '参考图', dataUrl });

test('Agent cache counts retained result positions in active and archived batches without embedding images', () => {
    const snapshot = { messages: [{ role: 'agent', text: '新结果', runs: [{ runId: 'b', mediaAssetKeys: ['media:shared'] }] }],
        archivedMessages: [{ role: 'agent', text: '旧结果', runs: [{ runId: 'a', mediaAssetKeys: ['media:shared', 'media:missing'] }] }] };
    const usage = getPromptAgentCacheUsage({ activeWorkflowId: 'workflow', activeConversation: snapshot });
    assert.equal(usage.current.resultCount, 3);
    assert.equal(usage.current.bytes, bytes(snapshot));
});

test('empty and preference-only snapshots are not reported as cached conversations', () => {
    assert.deepEqual(getPromptAgentCacheUsage(), { total: emptyUsage, current: emptyUsage });
    const usage = getPromptAgentCacheUsage({
        workflows: [null, {}, tab('old'), tab('prefs', { version: 1, panelWidth: 400, messages: [], memory: '  ' })],
        activeWorkflowId: 'prefs',
        activeConversation: { version: 1, panelWidth: 500, messages: [] }
    });
    assert.deepEqual(usage, { total: emptyUsage, current: emptyUsage });
    const store = createPromptAgentConversationStore();
    store.setImageModelId('selected-image-model');
    assert.deepEqual(getPromptAgentCacheUsage({
        workflows: [tab('image-preference', store.snapshot())],
        activeWorkflowId: 'image-preference',
        activeConversation: store.snapshot()
    }), { total: emptyUsage, current: emptyUsage });
});

test('live state replaces the saved active snapshot, including a cleared or missing live snapshot', () => {
    const saved = conversation('保存在场景中的旧聊天');
    const other = conversation('另一个场景');
    for (const activeConversation of [null, { version: 1, messages: [], memory: '', panelWidth: 600 }]) {
        const usage = getPromptAgentCacheUsage({
            workflows: [tab('active', saved), tab('other', other)],
            activeWorkflowId: 'active',
            activeConversation
        });
        assert.deepEqual(usage.current, emptyUsage);
        assert.equal(usage.total.workflowCount, 1);
        assert.equal(usage.total.messageCount, 1);
        assert.equal(usage.total.bytes, bytes(other));
    }
});

test('deduplicates workflow identities and replaces them with unsaved active changes', () => {
    const stale = conversation('旧消息');
    const last = conversation('同一个场景最后保存的状态');
    const live = conversation('尚未写入场景的新消息');
    const workflows = [tab('one', stale), { data: { workflowId: 'one', promptAgent: last } }];
    const savedUsage = getPromptAgentCacheUsage({ workflows });
    assert.equal(savedUsage.total.workflowCount, 1);
    assert.equal(savedUsage.total.bytes, bytes(last));

    const liveUsage = getPromptAgentCacheUsage({ workflows, activeWorkflowId: 'one', activeConversation: live });
    assert.deepEqual(liveUsage.total, liveUsage.current);
    assert.equal(liveUsage.current.bytes, bytes(live));
});

test('without an active identity, a live conversation is counted separately from unidentified saved tabs', () => {
    const first = conversation('没有 ID 的旧场景一');
    const second = conversation('没有 ID 的旧场景二');
    const live = conversation('尚未分配场景 ID 的临时对话');
    const usage = getPromptAgentCacheUsage({
        workflows: [{ data: { promptAgent: first } }, { data: { promptAgent: second } }],
        activeConversation: live
    });
    assert.equal(usage.current.workflowCount, 1);
    assert.equal(usage.current.bytes, bytes(live));
    assert.equal(usage.total.workflowCount, 3);
    assert.equal(usage.total.bytes, bytes(first) + bytes(second) + bytes(live));
    assert.deepEqual(getPromptAgentCacheUsage({
        workflows: [{ data: { promptAgent: first } }]
    }).current, emptyUsage);
});

test('measures Chinese and emoji using UTF-8 bytes and does not mutate the snapshot', () => {
    const saved = conversation('城市夜景 🌃');
    const workflows = [tab('中文场景', saved)];
    const before = structuredClone(workflows);
    const usage = getPromptAgentCacheUsage({ workflows });
    assert.equal(usage.total.bytes, bytes(saved));
    assert.ok(usage.total.bytes > JSON.stringify(saved).length);
    assert.deepEqual(workflows, before);
});

test('counts reference identities once per scene while measuring all repeated saved image payloads', () => {
    const first = reference('import-1');
    const second = reference('import-2');
    const saved = {
        version: 1,
        messages: [{ role: 'user', text: '参考第一张', referenceImages: [first] }],
        archivedMessages: [{ role: 'user', text: '上次的参考图', referenceImages: [first, second] }],
        referenceImages: [
            first, second,
            { name: '仅元数据' },
            { name: '外部链接', dataUrl: 'https://example.com/image.png' },
            { name: '非图片', dataUrl: 'data:text/plain;base64,SAME' }
        ]
    };
    const usage = getPromptAgentCacheUsage({ workflows: [tab('one', saved), tab('two', saved)] });
    assert.equal(usage.total.referenceCount, 4);
    assert.equal(usage.total.messageCount, 4);
    assert.equal(usage.total.activeMessageCount, 2);
    assert.equal(usage.total.archivedMessageCount, 2);
    assert.equal(usage.total.bytes, bytes(saved) * 2);
});

test('legacy references without IDs deduplicate by payload and plan-only state remains cached', () => {
    const image = { name: '旧参考图', dataUrl: 'data:image/png;base64,OLD' };
    const saved = {
        previousPromptPlan: { prompt: '保持角色一致', referenceImages: [image] },
        referenceImages: [image]
    };
    const usage = getPromptAgentCacheUsage({ workflows: [tab('legacy', saved)] });
    assert.equal(usage.total.referenceCount, 1);
    assert.equal(usage.total.messageCount, 0);
    assert.equal(usage.total.workflowCount, 1);
    assert.equal(usage.total.bytes, bytes(saved));
    assert.equal(getPromptAgentCacheUsage({
        workflows: [tab('plan', { previousPromptPlan: { prompt: '已保存的方案' } })]
    }).total.workflowCount, 1);
});

test('semantic compaction preserves archived storage and adds its summary instead of pretending to erase history', () => {
    const store = createPromptAgentConversationStore();
    store.append({ role: 'user', text: '生成城市夜景', referenceImages: [reference('source')] });
    store.append({ role: 'agent', text: '方案已就绪', promptPlan: { prompt: '霓虹灯照亮雨夜城市', parameters: {} } });
    const before = store.snapshot();
    store.compact('用户要城市雨夜，保持参考图构图；最新方案待确认。');
    const after = store.snapshot();

    const usage = getPromptAgentCacheUsage({ activeWorkflowId: 'scene', activeConversation: after });
    assert.equal(usage.current.messageCount, 2);
    assert.equal(usage.current.activeMessageCount, 0);
    assert.equal(usage.current.archivedMessageCount, 2);
    assert.equal(usage.current.summaryCount, 1);
    assert.equal(usage.current.referenceCount, 1);
    assert.equal(usage.current.bytes, bytes(after));
    assert.ok(usage.current.bytes > bytes(before));
    const withBothSummaries = { ...after, memory: '摘要之后新增的补充要求' };
    assert.equal(getPromptAgentCacheUsage({
        activeWorkflowId: 'scene', activeConversation: withBothSummaries
    }).current.summaryCount, 2);
});

test('a serialization failure is reported to the caller instead of disguising existing cache as zero bytes', () => {
    const circular = conversation('有缓存');
    circular.self = circular;
    assert.throws(() => getPromptAgentCacheUsage({ workflows: [tab('broken', circular)] }), /circular/i);
    assert.throws(() => getPromptAgentCacheUsage({
        workflows: [tab('broken', { ...conversation('有缓存'), unsupported: 1n })]
    }), /BigInt/);
});
