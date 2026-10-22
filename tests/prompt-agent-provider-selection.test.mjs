import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentProvider } from '../js/features/prompt-agent/prompt-agent-provider.js';
import { createPromptAgentModelReply } from '../js/features/prompt-agent/prompt-agent-model.js';
import { createPromptAgentCompaction } from '../js/features/prompt-agent/prompt-agent-compaction.js';
import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';
import { createRequestStatisticsApi } from '../js/features/statistics/request-statistics.js';
import { getAgentSearchAvailability } from '../js/features/prompt-agent/prompt-agent-search-data.js';
import { createCanvasContext } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';

const providers = [{ id: 'a', name: '甲', endpoint: 'https://first.test/v1', apikey: 'first-key' },
    { id: 'b', name: '乙', endpoint: 'https://second.test/v1', apikey: 'second-key' }];
const model = { id: 'chat', name: 'chat', modelId: 'test-model', protocol: 'openai', providerIds: ['a', 'b'] };
const response = value => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
function statistics(raw = {}) {
    const memory = new Map(Object.entries(raw));
    const storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
    const state = {};
    const api = createRequestStatisticsApi({ state, documentRef: { getElementById: () => null }, localStorageRef: storage });
    return { api, state, storage };
}

test('explicit provider is strict; missing selection blocks requests; unavailable choices never fall back', () => {
    assert.throws(() => resolveAgentProvider(model, providers), /请选择供应商/);
    assert.throws(() => resolveAgentProvider({ ...model, providerIds: ['a'] }, [providers[0]]), /请选择供应商/);
    assert.equal(resolveAgentProvider(model, providers, 'b').id, 'b');
    for (const bad of [[], [providers[0]], [providers[0], { ...providers[1], apikey: '' }], [providers[0], { ...providers[1], endpoint: '' }]])
        assert.throws(() => resolveAgentProvider(model, bad, 'b'));
    assert.throws(() => resolveAgentProvider({ ...model, providerIds: ['a'] }, providers, 'b'), /解绑/);
});

test('provider preferences restore by purpose/model and survive clear/compact, legacy remains unselected', () => {
    const store = createPromptAgentConversationStore();
    store.setProvider('chat', 'chat', 'b'); store.setProvider('image', 'chat', 'a'); store.setProvider('search', 's', 'b');
    const expected = store.snapshot().providerSettings;
    store.append({ role: 'user', text: 'hello' }); store.compact('summary'); store.clear();
    assert.deepEqual(store.snapshot().providerSettings, expected);
    const restored = createPromptAgentConversationStore(); restored.restore(store.snapshot());
    assert.equal(restored.getProvider('chat', 'chat'), 'b'); assert.equal(restored.getProvider('image', 'chat'), 'a');
    restored.restore({}); assert.equal(restored.getProvider('chat', 'chat'), '');
});

test('second provider supplies actual URL/auth and one durable Agent request; response validation does not add requests', async () => {
    const { api, storage, state } = statistics();
    let sent = 0;
    const options = { model, providers, providerId: 'b', workflowId: 'workflow-origin', message: 'hello', recordRequest: api.recordRequest,
        getHeaders: plan => ({ target: plan.url, Authorization: plan.provider.apikey }),
        fetchRef: async (_, init) => { sent++; assert.equal(init.headers.target, 'https://second.test/v1/chat/completions');
            assert.equal(init.headers.Authorization, 'second-key'); return response({ intent: 'chat', message: 'hello' }); } };
    await createPromptAgentModelReply(options);
    assert.equal(sent, 1); assert.equal(api.getTodaySummary().total, 1);
    assert.deepEqual(api.getTodaySummary().sources, { agent: 1, canvas: 0 });
    assert.equal(state.requestStatistics[0].workflowId, 'workflow-origin'); assert.equal(state.requestStatistics[0].providerId, 'b');
    api.recordRequest(state.requestStatistics[0]); assert.equal(api.getTodaySummary().total, 1, 'idempotent identity');
    await assert.rejects(createPromptAgentModelReply({ ...options, fetchRef: async () => response({ invalid: 'reply' }) }));
    assert.equal(api.getTodaySummary().total, 2); assert.equal(api.getTodaySummary().success, 2);
    const restored = createRequestStatisticsApi({ state: {}, localStorageRef: storage, documentRef: { getElementById: () => null } });
    assert.equal(restored.getTodaySummary().total, 2);
    const legacy = statistics({ cainflow_request_statistics: JSON.stringify({ records: [{ timestamp: Date.now(), success: true }] }) });
    assert.equal(legacy.api.getTodaySummary().sources.canvas, 1);
});

test('prevalidation/pre-cancel sends/counts nothing; dispatched failure/cancel and retry count exactly once each', async () => {
    const { api } = statistics(); const abort = new AbortController(); abort.abort();
    const options = { model, providers, providerId: 'b', message: 'hi', recordRequest: api.recordRequest };
    await assert.rejects(createPromptAgentModelReply({ ...options, providerId: 'missing', fetchRef: () => assert.fail() }));
    await assert.rejects(createPromptAgentModelReply({ ...options, signal: abort.signal, fetchRef: () => assert.fail() }));
    assert.equal(api.getTodaySummary().total, 0);
    await assert.rejects(createPromptAgentModelReply({ ...options, fetchRef: async () => new Response('bad', { status: 503 }) }));
    const inflight = new AbortController();
    await assert.rejects(createPromptAgentModelReply({ ...options, signal: inflight.signal, fetchRef: async () => { inflight.abort(); return response({ intent: 'chat', message: 'late' }); } }));
    await createPromptAgentModelReply({ ...options, fetchRef: async () => response({ intent: 'chat', message: 'retry' }) });
    assert.equal(api.getTodaySummary().total, 3); assert.equal(api.getTodaySummary().failed, 2);
});

test('search uses explicit dedicated route, synthesis retains conversation snapshot and per-call purposes', async () => {
    const config = structuredClone({ model, providers }); const records = [], calls = [];
    const search = { ...model, id: 'search', agentSearch: 'web' };
    await createPromptAgentModelReply({ ...config, models: [config.model, search], providerId: 'b', message: 'search',
        searchSettings: { mode: 'auto', modelId: 'search', providerId: 'a' }, recordRequest: record => records.push(record),
        getHeaders: plan => ({ target: plan.url, Authorization: plan.provider.apikey }), fetchRef: async (_, init) => {
            calls.push(init.headers);
            config.providers[1].apikey = 'changed'; config.model.providerIds = ['a'];
            if (calls.length === 1) return response({ searchRequest: { kind: 'web', query: 'facts' } });
            if (calls.length === 2) return new Response(JSON.stringify({ output: [{ type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://source.test', title: 'source' }] } }] }));
            return response({ intent: 'chat', message: 'done' });
        } });
    assert.deepEqual(calls.map(call => call.Authorization), ['second-key', 'first-key', 'second-key']);
    assert.deepEqual(records.map(record => [record.purpose, record.providerId]), [['chat', 'b'], ['web-search', 'a'], ['search-summary', 'b']]);
});

test('compaction snapshots provider and counts every actual batch even when summary validation fails', async () => {
    const records = []; let calls = 0;
    const args = { model, providers, providerId: 'b', recordRequest: record => records.push(record),
        conversation: { messages: [{ role: 'user', text: 'long context '.repeat(18000) }] },
        getHeaders: plan => { assert.equal(plan.provider.id, 'b'); return {}; },
        fetchRef: async () => { calls++; return response({ summary: 'summary' }); } };
    await createPromptAgentCompaction(args);
    assert.ok(calls > 1); assert.equal(records.length, calls); assert.ok(records.every(record => record.purpose === 'compact'));
    await assert.rejects(createPromptAgentCompaction({ ...args, fetchRef: async () => { calls++; return response({ invalid: true }); } }));
    assert.equal(records.length, calls); assert.ok(records.every(record => record.success));
});

test('canvas detail followups keep the selected provider and count independent requests', async () => {
    const records = [], headers = [];
    const canvasContext = createCanvasContext({ workflowId: 'w', nodes: [], connections: [] });
    await createPromptAgentModelReply({ model, providers, providerId: 'b', message: '解释画布', canvasContext,
        recordRequest: record => records.push(record), getHeaders: plan => ({ key: plan.provider.apikey }),
        fetchRef: async (_, init) => { headers.push(init.headers);
            return response(headers.length === 1 ? { canvasRead: { offset: 0 } } : { intent: 'chat', message: '空画布' }); } });
    assert.deepEqual(headers.map(header => header.key), ['second-key', 'second-key']);
    assert.deepEqual(records.map(record => record.purpose), ['chat', 'canvas-followup']);
});

test('provider thinking incompatibility and missing dedicated credentials block without fallback or counting', async () => {
    const thinkingModel = { ...model, agentSearch: 'web', thinking: { profile: 'openai-basic', providers: { b: 'none' }, default: { mode: 'level', value: 'high' } } };
    const records = [];
    await assert.rejects(createPromptAgentModelReply({ model: thinkingModel, providers, providerId: 'b', message: 'hello',
        recordRequest: record => records.push(record), fetchRef: () => assert.fail() }), /思考设置不可用/);
    assert.equal(records.length, 0);
    assert.equal(getAgentSearchAvailability({ model: thinkingModel, providers, providerId: 'b' }).reason, 'thinking');
    assert.equal(getAgentSearchAvailability({ model: thinkingModel, providers, providerId: 'a' }).provider.id, 'a');
    const selected = { ...model, id: 'search', agentSearch: 'web' };
    const availability = getAgentSearchAvailability({ model, models: [selected], providers: [providers[0]], settings: { modelId: 'search', providerId: 'b' } });
    assert.equal(availability.available, false); assert.equal(availability.target.modelId, 'search');
});
