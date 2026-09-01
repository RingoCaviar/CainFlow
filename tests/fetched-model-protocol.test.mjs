import assert from 'node:assert/strict';
import test from 'node:test';

import {
    addFetchedModelToCollection,
    findFetchedModelConfig,
    getModelCompatibilityFormatLabel,
    inferModelCompatibilityFormat,
    requireModelCompatibilityFormat
} from '../js/features/execution/model-compatibility-format.js';
import { resolveProviderUrl } from '../js/features/execution/provider-request-utils.js';
import { RelayVideoProtocol } from '../js/features/execution/protocols/api6789-video.js';

test('a fetched nano-banana model is persisted with the Google Gemini format', () => {
    const models = [];
    const config = addFetchedModelToCollection({ models,
        generatedId: 'mod_test', providerId: 'provider_test',
        fetchedModel: { id: 'nano-banana-fast', name: 'Nano Banana Fast' }, taskType: 'image'
    });
    assert.equal(config.protocol, 'google');
    assert.equal(models[0], config);
});

test('fetched Grok text and image models are persisted with the OpenAI format', () => {
    for (const id of ['grok-4.5', 'grok-imagine-image-2.0', 'GROK4', 'my-grok-proxy']) {
        const models = [];
        const config = addFetchedModelToCollection({
            models,
            generatedId: `mod_${id}`,
            providerId: 'provider_test',
            fetchedModel: { id },
            taskType: id.includes('image') ? 'image' : 'chat'
        });
        assert.equal(config.protocol, 'openai', id);
    }
    for (const id of ['veo-grok', 'ttapi-grok', 'newapi-grok']) {
        assert.equal(inferModelCompatibilityFormat({ id }), '', id);
    }
    assert.equal(inferModelCompatibilityFormat({ id: 'xai-chat' }), '');
});

test('model compatibility format uses only reliable model-name keywords', () => {
    for (const id of ['gemini-2.5-pro', 'banana-fast', 'nano-banana-fast', 'nano banana pro', 'nano_banana']) {
        assert.equal(inferModelCompatibilityFormat({ id }), 'google', id);
    }
    for (const id of ['gpt-5-nano', 'openai-image', 'dall-e-3', 'o3-mini']) {
        assert.equal(inferModelCompatibilityFormat({ id }), 'openai', id);
    }
    for (const id of ['doubao-video', 'seedance-1.0']) {
        assert.equal(inferModelCompatibilityFormat({ id }), 'doubao-video', id);
    }
});

test('provider and endpoint metadata never determine model compatibility format', () => {
    assert.equal(inferModelCompatibilityFormat({
        id: 'unknown-image-async',
        raw: { supported_endpoint_types: ['openai', 'gemini', 'newapi-image-async'] }
    }), '');
    for (const id of ['ttapi-openai', 'veo-gpt-video', 'newapi-gpt-image']) {
        assert.equal(inferModelCompatibilityFormat({ id }), '', id);
    }
    assert.equal(getModelCompatibilityFormatLabel(''), '未识别 · 需手动选择');
});

test('an unrecognized fetched model is persisted without a compatibility format', () => {
    const models = [];
    const config = addFetchedModelToCollection({ models,
        generatedId: 'mod_unknown', providerId: 'provider_openai',
        fetchedModel: { id: 'unknown-image-model' }, taskType: 'image'
    });
    assert.equal(config.protocol, '');
    assert.equal(models.length, 1);
    assert.equal(findFetchedModelConfig(models, {
        modelId: 'unknown-image-model', protocol: '', taskType: 'image'
    }), config);
});

test('workflow execution rejects a model whose compatibility format is empty', () => {
    assert.throws(
        () => requireModelCompatibilityFormat({ name: 'Unknown image', protocol: '' }),
        /请先在模型设置中手动选择兼容格式/
    );
    assert.equal(requireModelCompatibilityFormat({ name: 'Configured', protocol: 'google' }), 'google');
    assert.throws(
        () => resolveProviderUrl(
            { endpoint: 'https://relay.example/v1', type: 'openai' },
            { name: 'Unknown image', modelId: 'unknown-image', protocol: '' },
            'image'
        ),
        /请先在模型设置中手动选择兼容格式/
    );
});

test('a configured MiniMax H3 model can use the loaded async video API compatibility format', () => {
    assert.equal(requireModelCompatibilityFormat({
        name: 'MiniMax H3', modelId: 'minimax-h3', protocol: RelayVideoProtocol.id
    }), 'async-video-api');
});

test('the retired relay-video identifier resolves to the async video API protocol', () => {
    assert.equal(requireModelCompatibilityFormat({
        name: 'Legacy MiniMax H3', modelId: 'minimax-h3', protocol: 'relay-video'
    }), 'relay-video');
});
