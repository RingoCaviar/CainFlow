import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelSettings } from '../js/features/settings/model-settings.js';

function createHarness(models = []) {
    const events = [];
    const collapseState = new Map();
    const renderedCards = new Map();
    const modelsList = {
        innerHTML: '',
        appendChild(element) {
            renderedCards.set(element.dataset.modelId, element);
        },
        querySelector(selector) {
            const id = selector.match(/data-model-id="([^"]+)"/)?.[1];
            return id ? renderedCards.get(id) || null : null;
        },
        querySelectorAll() { return []; }
    };
    const documentRef = {
        createElement() {
            return {
                className: '', dataset: {}, innerHTML: '',
                addEventListener() {},
                scrollIntoView() { events.push('revealed'); }
            };
        },
        getElementById() { return null; },
        querySelector() { return null; }
    };
    const provider = { id: 'provider_openai', name: 'OpenAI relay', type: 'openai' };
    const state = { models, providers: [provider], nodes: new Map() };
    const dialogs = {
        escapeHtml: (value) => String(value),
        renderProviderModelsDialog: () => events.push('dialog-rendered'),
        closeProviderModelsDialog: () => events.push('dialog-closed'),
        closeFloatingModelProviderPanel() {}
    };
    const providerSettings = {
        getResolvedModelProvider: () => provider,
        getResolvedModelProviderId: () => provider.id,
        getVisibleSettingsProviders: () => [provider],
        getModelProviderSummary: () => provider.name,
        getModelBoundProviders: () => [provider],
        syncModelProviderBindings: (model) => model.providerIds || [],
        isVectorEngineEndpoint: () => false,
        isTtapiEndpoint: () => false,
        isTtapiOpenAiEndpoint: () => false,
        getModelFetchProtocol: () => 'openai'
    };
    const api = createModelSettings({
        ctx: {
            state, modelsList, documentRef,
            windowRef: { setTimeout: (fn) => fn(), requestAnimationFrame: (fn) => fn() },
            showToast: (message, type) => events.push(`toast:${type}:${message}`),
            saveState: () => events.push('saved'),
            fitNodeToContent() {},
            fetchImpl() {}
        },
        store: {
            modelFetchDialogState: {}, constants: {}, modelCollapseState: collapseState,
            openModelProviderPanelId: '', activeModelFetchRequestId: 0
        },
        dialogs,
        providerSettings,
        getDeps: () => ({})
    });
    return { api, state, provider, events, collapseState };
}

test('adding an unrecognized fetched model closes the list and reveals manual format selection', () => {
    const harness = createHarness();

    harness.api.addFetchedModel(harness.provider, {
        id: 'unknown-image-model', name: 'Unknown Image', taskType: 'image'
    });

    assert.equal(harness.state.models.length, 1);
    assert.equal(harness.state.models[0].protocol, '');
    assert.equal(harness.collapseState.get(harness.state.models[0].id), false);
    assert.ok(harness.events.includes('dialog-closed'));
    assert.ok(harness.events.includes('revealed'));
    assert.ok(harness.events.some((event) => event.startsWith('toast:warning:无法自动识别')));
});

test('binding an unrecognized fetched model to another provider repeats the manual format guidance', () => {
    const existingModel = {
        id: 'mod_existing', name: 'Unknown Image', modelId: 'unknown-image-model',
        providerIds: ['provider_old'], providerId: 'provider_old', taskType: 'image', protocol: ''
    };
    const harness = createHarness([existingModel]);

    harness.api.addFetchedModel(harness.provider, {
        id: 'unknown-image-model', name: 'Unknown Image', taskType: 'image'
    });

    assert.deepEqual(existingModel.providerIds, ['provider_old', 'provider_openai']);
    assert.equal(harness.collapseState.get(existingModel.id), false);
    assert.ok(harness.events.includes('dialog-closed'));
    assert.ok(harness.events.includes('revealed'));
    assert.ok(harness.events.some((event) => event.startsWith('toast:warning:无法自动识别')));
    assert.equal(harness.events.some((event) => event.includes('已将供应商绑定')), false);
});

test('a fetched MiniMax H3 model is classified as video', () => {
    const harness = createHarness();

    assert.equal(harness.api.inferFetchedModelTaskType('minimax-h3', { name: 'MiniMax H3' }), 'video');
});
