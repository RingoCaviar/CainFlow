import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelSettings } from '../js/features/settings/model-settings.js';
import { createProviderSettings } from '../js/features/settings/provider-settings.js';

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
