import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';

test('OpenAI image edit uploads every image connected through the referenceImages port', async () => {
    const node = { id: 'image-generate', type: 'ImageGenerate', data: {}, enabled: true };
    const elements = new Map(Object.entries({
        'image-generate-apiconfig': { value: 'model' },
        'image-generate-provider': { value: 'provider' },
        'image-generate-aspect': { value: '1:1' },
        'image-generate-resolution': { value: '1024x1024' },
        'image-generate-quality': { value: 'auto' },
        'image-generate-moderation': { value: 'auto' },
        'image-generate-background': { value: 'auto' },
        'image-generate-search': { checked: false },
        'image-generate-generation-count': { value: '1' },
        'image-generate-prompt': { value: '保留主体并改变背景' },
    }));
    let capturedBody;
    const api = createExecutionCoreApi({
        state: {
            nodes: new Map([[node.id, node]]),
            connections: [],
            models: [{ id: 'model', name: 'Image model', modelId: 'image-model', protocol: 'openai', providerIds: ['provider'] }],
            providers: [{ id: 'provider', name: 'Provider', endpoint: 'https://example.test/v1', apikey: '<REDACTED>', type: 'openai' }],
        },
        nodeConfigs: {},
        documentRef: {
            getElementById: (id) => elements.get(id) || null,
            querySelectorAll: () => [],
        },
        windowRef: { requestAnimationFrame: (callback) => callback() },
        fetchRef: async (_url, options) => {
            capturedBody = options.body;
            throw new Error('stop after request capture');
        },
        showToast: () => {},
        addLog: () => {},
        getProxyHeaders: () => ({}),
        classifyProviderError: () => ({ message: 'stop after request capture' }),
        logRequestToPanel: () => {},
        fitNodeToContent: () => {},
        refreshDependentImageResizePreviews: async () => {},
        dataURLtoBlob: () => new Blob(['image'], { type: 'image/png' }),
        getAbortMessage: () => '',
    });

    await assert.rejects(
        api.nodeHandlers.ImageGenerate(node, {
            referenceImages: [
                'data:image/png;base64,Zmlyc3Q=',
                'data:image/png;base64,c2Vjb25k',
            ],
        }, new AbortController().signal),
        /stop after request capture/,
    );

    assert.ok(capturedBody instanceof FormData);
    assert.equal(capturedBody.getAll('image').length, 2);
});
