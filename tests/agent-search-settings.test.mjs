import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeModelConfig } from '../js/features/execution/provider-request-utils.js';
import { getAgentSearchAvailability, getAgentSearchCapability } from '../js/features/prompt-agent/prompt-agent-search-data.js';

const chat = { id: 'chat', name: 'Chat', modelId: 'chat', protocol: 'openai', providerIds: ['p'], taskType: 'chat' };
const search = { ...chat, id: 'search', agentSearch: 'images' };
const provider = { id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'controlled-key' };
const evaluate = (overrides = {}) => getAgentSearchAvailability({ model: chat, models: [chat, search], providers: [provider], providerId: 'p', settings: { modelId: 'search', providerId: 'p' }, ...overrides });

test('old configuration defaults and explicit search opt-out survive repeated normalization', () => {
    for (const protocol of ['google', 'openai', 'async-video-api']) for (const agentSearch of [undefined, 'none', 'web', 'images', 'invalid']) {
        const original = { ...chat, protocol, ...(agentSearch !== undefined ? { agentSearch } : {}) };
        const restored = normalizeModelConfig(normalizeModelConfig(original));
        assert.equal(getAgentSearchCapability(restored), getAgentSearchCapability(original));
        if (['none', 'web', 'images'].includes(agentSearch)) assert.equal(restored.agentSearch, agentSearch);
        if (agentSearch === undefined) assert.equal(Object.hasOwn(restored, 'agentSearch'), false);
    }
    for (const invalid of [0, -1, 1.5, '12000', null, Infinity]) assert.equal(normalizeModelConfig({ ...chat, autoCompactTokenLimit: invalid }).autoCompactTokenLimit, undefined);
});

test('search uses only the current model and ignores legacy dedicated selection', () => {
    assert.equal(evaluate().model.id, 'chat');
    assert.equal(evaluate({ model: search }).model.id, 'search');
    assert.equal(evaluate({ model: { ...chat, protocol: 'google' }, kind: 'images' }).available, true);
    assert.equal(evaluate({ model: search, settings: { mode: 'off' } }).reason, 'off');
    assert.equal(evaluate({ model: { ...search, providerIds: ['removed'] } }).reason, 'provider');
});

test('failed settings writes retain the exact search configuration for retry and disk rehydration', async () => {
    const previousFetch = globalThis.fetch;
    const configuration = { models: ['none', 'web', 'images'].map(agentSearch => ({ ...chat, id: agentSearch, agentSearch, autoCompactTokenLimit: 23456 })),
        providers: [{ ...provider, autoComplete: false, responsesEndpoint: 'https://controlled.test/responses' }] };
    const documents = new Map();
    let fail = true, storage, notified = false;
    globalThis.fetch = async (url, options = {}) => {
        if (options.method === 'PUT') {
            if (fail) return { ok: false, status: 503 };
            documents.set(url, JSON.parse(options.body).value);
        }
        return { ok: true, json: async () => ({ value: documents.get(url) ?? null }) };
    };
    try {
        ({ diskStorage: storage } = await import(`../js/services/storage-documents.js?search-write=${Date.now()}`));
        storage.onError = () => { notified = true; };
        storage.setItem('nodeflow_ai_state', JSON.stringify(configuration));
        await assert.rejects(storage.waitForKey('nodeflow_ai_state'), /503/);
        assert.equal(notified, true);
        assert.deepEqual(JSON.parse(storage.getItem('nodeflow_ai_state')), configuration);
        assert.ok(storage.pending.size);
        fail = false;
        storage.setItem('nodeflow_ai_state', JSON.stringify(configuration));
        await storage.waitForKey('nodeflow_ai_state');
        const { diskStorage: restarted } = await import(`../js/services/storage-documents.js?search-restart=${Date.now()}`);
        await restarted.hydrate();
        const restored = JSON.parse(restarted.getItem('nodeflow_ai_state'));
        assert.deepEqual(restored.models.map(model => normalizeModelConfig(model).agentSearch), ['none', 'web', 'images']);
        assert.ok(restored.models.every(model => normalizeModelConfig(model).autoCompactTokenLimit === 23456));
        assert.equal(restored.providers[0].responsesEndpoint, configuration.providers[0].responsesEndpoint);
    } finally {
        if (storage?.retryTimer) clearTimeout(storage.retryTimer);
        globalThis.fetch = previousFetch;
    }
});
