import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelSettings } from '../js/features/settings/model-settings.js';
import { createProviderSettings } from '../js/features/settings/provider-settings.js';

async function fetchCatalog(provider, routes) {
    const state = { providers: [provider], models: [], proxy: { enabled: false } };
    const dialog = { query: 'gemini' };
    const requests = [];
    const providerSettings = createProviderSettings({ ctx: { state }, store: {}, dialogs: {}, getDeps: () => ({}) });
    const settings = createModelSettings({
        ctx: {
            state,
            fetchImpl: async (url, options) => {
                const request = JSON.parse(options.body);
                requests.push(request);
                const payload = routes(request);
                return new Response(JSON.stringify(payload || { error: 'unavailable' }), { status: payload ? 200 : 404 });
            },
            windowRef: { AbortController, setTimeout, clearTimeout },
            showToast() {}
        },
        store: { modelFetchDialogState: dialog, constants: { MODEL_FETCH_CLIENT_TIMEOUT_SECONDS: 1 }, activeModelFetchRequestId: 0 },
        dialogs: { renderProviderModelsDialog() {} },
        providerSettings,
        getDeps: () => ({})
    });
    await settings.fetchProviderModels(provider.id);
    return { requests, dialog };
}

test('a relay saved with the default Google type merges both catalogs and follows Gemini pages', async () => {
    const provider = {
        id: 'relay', type: 'google', name: '云雾海外',
        endpoint: 'https://relay.test/gateway/v1beta/models/gemini:generateContent?key=stale',
        apikey: 'test-key'
    };
    const { requests, dialog } = await fetchCatalog(provider, ({ url, protocol }) => {
        const target = new URL(url);
        if (target.pathname === '/gateway/v1/models' && protocol === 'openai') {
            assert.equal(target.searchParams.has('key'), false);
            return { data: [{ id: 'gpt-4o' }, { id: 'claude-sonnet-4' }, { id: 'gemini-2.5-flash' }] };
        }
        if (target.pathname !== '/gateway/v1beta/models' || protocol !== 'google') return null;
        assert.equal(target.searchParams.get('key'), 'test-key');
        if (target.searchParams.has('pageToken')) {
            assert.equal(target.searchParams.get('pageToken'), 'next + /');
            return { models: [{ name: 'models/imagen-4' }] };
        }
        return { models: [{ name: 'models/gemini-2.5-flash' }], nextPageToken: 'next + /' };
    });

    assert.equal(requests.length, 3);
    assert.ok(requests.every(({ apikey }) => apikey === 'test-key'));
    assert.deepEqual(dialog.models.map(({ id }) => id), ['claude-sonnet-4', 'gemini-2.5-flash', 'gpt-4o', 'imagen-4']);
    assert.equal(dialog.error, '');
    assert.equal(dialog.query, '');
});

test('Google official discovery uses its own catalog and preserves earlier pages on failure', async () => {
    const { requests, dialog } = await fetchCatalog({
        id: 'google', type: 'openai', endpoint: 'https://generativelanguage.googleapis.com/v1beta', apikey: 'test-key'
    }, ({ url, protocol }) => {
        if (protocol !== 'google' || new URL(url).searchParams.has('pageToken')) return null;
        return { models: [{ name: 'models/gemini-2.5-flash' }], nextPageToken: 'unavailable' };
    });

    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ protocol, url }) => protocol === 'google' && new URL(url).pathname === '/v1beta/models'));
    assert.deepEqual(dialog.models.map(({ id }) => id), ['gemini-2.5-flash']);
    assert.equal(dialog.error, '');
    assert.match(dialog.warning, /部分/);
});

test('a relay can list models when its Gemini catalog is unavailable', async () => {
    const { dialog } = await fetchCatalog({
        id: 'relay', type: 'google', endpoint: 'https://relay.test/v1', apikey: 'test-key'
    }, ({ protocol }) => protocol === 'openai' ? { data: [{ id: 'gpt-image-1' }] } : null);
    assert.deepEqual(dialog.models.map(({ id, taskType }) => [id, taskType]), [['gpt-image-1', 'image']]);
    assert.equal(dialog.error, '');
});

function modelListUrl(endpoint) {
    const settings = createModelSettings({
        ctx: { state: { providers: [], models: [] } },
        store: { modelFetchDialogState: {}, constants: {} },
        dialogs: {},
        providerSettings: {},
        getDeps: () => ({})
    });
    return settings.getProviderModelListUrl({ endpoint }, 'openai');
}

test('OpenAI official base and model-list URLs resolve to the same models endpoint', () => {
    for (const endpoint of [
        'https://api.openai.com',
        'https://api.openai.com/v1',
        'https://api.openai.com/v1/models',
        'https://api.openai.com/v1/models/'
    ]) {
        assert.equal(modelListUrl(endpoint), 'https://api.openai.com/v1/models', endpoint);
    }
});

test('a provider changed from the default Google URL to the official OpenAI URL fetches OpenAI models', async () => {
    const provider = {
        id: 'custom', name: 'OpenAI', type: 'google',
        endpoint: 'https://api.openai.com/v1', apikey: 'test-key'
    };
    const state = { providers: [provider], models: [], proxy: { enabled: false } };
    const dialogState = {};
    const requests = [];
    const providerSettings = createProviderSettings({ ctx: { state }, store: {}, dialogs: {}, getDeps: () => ({}) });
    const settings = createModelSettings({
        ctx: {
            state,
            fetchImpl: async (url, options) => {
                const body = JSON.parse(options.body);
                requests.push(body);
                const ok = body.url === 'https://api.openai.com/v1/models' && body.protocol === 'openai';
                return { ok, status: ok ? 200 : 404, text: async () => ok
                    ? JSON.stringify({ data: [{ id: 'gpt-4o', object: 'model' }] })
                    : '请求失败 (404)' };
            },
            windowRef: { AbortController, setTimeout, clearTimeout },
            showToast() {}
        },
        store: {
            modelFetchDialogState: dialogState,
            constants: { MODEL_FETCH_CLIENT_TIMEOUT_SECONDS: 1 },
            activeModelFetchRequestId: 0
        },
        dialogs: { renderProviderModelsDialog() {} },
        providerSettings,
        getDeps: () => ({})
    });

    await settings.fetchProviderModels(provider.id);

    assert.deepEqual(requests.map(({ url, protocol, apikey }) => ({ url, protocol, apikey })), [
        { url: 'https://api.openai.com/v1/models', protocol: 'openai', apikey: 'test-key' }
    ]);
    assert.deepEqual(dialogState.models.map((model) => model.id), ['gpt-4o']);
    assert.equal(dialogState.error, '');
});

test('fetching models from an OpenAI models URL sends the API key and displays the response', async () => {
    const provider = {
        id: 'openai', name: 'OpenAI', type: 'openai',
        endpoint: 'https://api.openai.com/v1/models', apikey: 'test-key'
    };
    const state = { providers: [provider], models: [], proxy: { enabled: false } };
    const dialogState = {};
    let request;
    const settings = createModelSettings({
        ctx: {
            state,
            fetchImpl: async (url, options) => {
                request = { url, body: JSON.parse(options.body) };
                return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'gpt-4o', object: 'model' }] }) };
            },
            windowRef: { AbortController, setTimeout, clearTimeout },
            showToast() {}
        },
        store: {
            modelFetchDialogState: dialogState,
            constants: { MODEL_FETCH_CLIENT_TIMEOUT_SECONDS: 1 },
            activeModelFetchRequestId: 0
        },
        dialogs: { renderProviderModelsDialog() {} },
        providerSettings: {
            getModelFetchProtocol: () => 'openai',
            getSafeProviderName: () => 'OpenAI',
            isVectorEngineEndpoint: () => false
        },
        getDeps: () => ({})
    });

    await settings.fetchProviderModels(provider.id);

    assert.equal(request.url, '/api/provider_models');
    assert.equal(request.body.url, 'https://api.openai.com/v1/models');
    assert.equal(request.body.apikey, 'test-key');
    assert.deepEqual(dialogState.models.map((model) => model.id), ['gpt-4o']);
    assert.equal(dialogState.error, '');
});
