import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import '../js/features/execution/protocols/api6789-video.js';
import '../js/features/execution/protocols/veo-unified.js';

function createVideoExecutionApi({ node, elements, onRequestBody, model = {
    id: 'model-1', name: 'Kling O3', modelId: 'kling-o3',
    protocol: 'async-video-api', providerIds: ['provider-1']
} }) {
    return createExecutionCoreApi({
        state: {
            nodes: new Map([[node.id, node]]),
            connections: [],
            models: [model],
            providers: [{
                id: 'provider-1', name: 'Relay', endpoint: 'https://relay.example', apikey: '<REDACTED>'
            }]
        },
        nodeConfigs: {},
        documentRef: {
            getElementById: (id) => elements.get(id) || null,
            querySelectorAll: () => []
        },
        windowRef: { requestAnimationFrame: (callback) => callback() },
        showToast: () => {},
        addLog: () => {},
        getProxyHeaders: () => ({}),
        classifyProviderError: () => ({}),
        logRequestToPanel: (_title, _url, requestBody) => {
            onRequestBody(requestBody);
            throw new Error('request captured');
        },
        fitNodeToContent: () => {},
        refreshDependentImageResizePreviews: async () => {},
        getAbortMessage: () => ''
    });
}

test('video request preview shows the exact declared-protocol request body that execution sends', async () => {
    const node = {
        id: 'video-1', type: 'VideoGenerate', enabled: true,
        data: { protocolParams: { seconds: 12, size: '960x1280' } }
    };
    const elements = new Map(Object.entries({
        'video-1-apiconfig': { value: 'model-1' },
        'video-1-provider': { value: 'provider-1' },
        'video-1-prompt': { value: '海浪' },
        'video-1-aspect': { value: '16:9' },
        'video-1-generation-count': { value: '1' }
    }));
    let actualRequestBody = null;
    const api = createVideoExecutionApi({
        node,
        elements,
        onRequestBody: (requestBody) => { actualRequestBody = requestBody; }
    });

    const preview = api.buildNodeRequestPreview(node.id);
    await assert.rejects(
        api.nodeHandlers.VideoGenerate(node, {}, new AbortController().signal),
        /request captured/
    );

    assert.deepEqual(preview.requestBody, actualRequestBody);
});

test('VEO request preview includes the same declared duration and loop values as execution', async () => {
    const node = {
        id: 'video-1', type: 'VideoGenerate', enabled: true,
        data: {
            protocolParams: {
                aspect_ratio: '9:16', duration: '16s', loop: true,
                enhance_prompt: false, enable_upsample: false
            }
        }
    };
    const elements = new Map(Object.entries({
        'video-1-apiconfig': { value: 'model-1' },
        'video-1-provider': { value: 'provider-1' },
        'video-1-prompt': { value: '海浪' },
        'video-1-aspect': { value: '16:9' },
        'video-1-generation-count': { value: '1' }
    }));
    let actualRequestBody = null;
    const api = createVideoExecutionApi({
        node,
        elements,
        onRequestBody: (requestBody) => { actualRequestBody = requestBody; },
        model: {
            id: 'model-1', name: 'VEO', modelId: 'veo-3',
            protocol: 'veo-unified', providerIds: ['provider-1']
        }
    });

    const preview = api.buildNodeRequestPreview(node.id);
    await assert.rejects(
        api.nodeHandlers.VideoGenerate(node, {}, new AbortController().signal),
        /request captured/
    );

    assert.deepEqual(preview.requestBody, actualRequestBody);
    assert.deepEqual(preview.requestBody, {
        model: 'veo-3', prompt: '海浪', aspect_ratio: '9:16', duration: '16s',
        loop: true, enhance_prompt: false, enable_upsample: false
    });
});

test('video request preview reads a prompt currently entered in the protocol-driven control', () => {
    const node = {
        id: 'video-1', type: 'VideoGenerate', enabled: true,
        data: { protocolParams: { seconds: 12, size: '960x1280' } }
    };
    const elements = new Map(Object.entries({
        'video-1-apiconfig': { value: 'model-1' },
        'video-1-provider': { value: 'provider-1' },
        'video-1-prompt': { value: '' },
        'video-1-param-prompt': { value: '协议控件中的海浪' },
        'video-1-aspect': { value: '16:9' },
        'video-1-generation-count': { value: '1' }
    }));
    const api = createVideoExecutionApi({ node, elements, onRequestBody: () => {} });

    assert.equal(api.buildNodeRequestPreview(node.id).requestBody.prompt, '协议控件中的海浪');
});
