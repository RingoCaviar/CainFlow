import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelSettings } from '../js/features/settings/model-settings.js';

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
