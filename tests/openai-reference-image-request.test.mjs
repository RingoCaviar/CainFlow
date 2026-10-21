import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createPromptAgentNodeAdapter } from '../js/features/prompt-agent/prompt-agent-node-adapter.js';
import { createPromptAgentExecutionAdapter } from '../js/features/prompt-agent/prompt-agent-execution-adapter.js';
import { orderInputConnections } from '../js/nodes/reference-image-ports.js';

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
    const state = {
            nodes: new Map([[node.id, node]]),
            connections: [],
            models: [{ id: 'model', name: 'Image model', modelId: 'image-model', protocol: 'openai', providerIds: ['provider'] }],
            providers: [{ id: 'provider', name: 'Provider', endpoint: 'https://example.test/v1', apikey: '<REDACTED>', type: 'openai' }],
        };
    const api = createExecutionCoreApi({
        state,
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
        dataURLtoBlob: (value) => new Blob([value], { type: 'image/png' }),
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

    // Real Agent application -> selected-only execution plan -> cached image
    // inputs -> real OpenAI multipart request. No manually authored connections.
    const images = ['data:image/png;base64,Zmlyc3Q=', 'data:image/png;base64,c2Vjb25k'];
    images.forEach((image, index) => state.nodes.set(`source-${index}`, {
        id: `source-${index}`, type: 'ImageImport', enabled: true, data: { image }
    }));
    for (const element of elements.values()) element.dispatchEvent = () => {};
    const nodeAdapter = createPromptAgentNodeAdapter({ state,
        documentRef: { getElementById: (id) => elements.get(id) || null, querySelectorAll: () => [] }
    });
    const agent = createPromptAgentExecutionAdapter({ state, nodeAdapter,
        runWorkflow: async (options) => {
            const plan = api.resolveExecutionPlan(options);
            const connections = orderInputConnections(node.type, plan.inputConnectionsByNode[node.id]);
            const inputs = { referenceImages: connections.map((connection) => api.getCachedOutputValue(
                state.nodes.get(connection.from.nodeId), connection.from.port
            )) };
            await api.nodeHandlers.ImageGenerate(node, inputs, new AbortController().signal);
        }
    });
    await assert.rejects(agent.applyAndGenerate({ targetNodeId: node.id, prompt: '按两张参考图生成',
        referenceImages: [{ sourceNodeId: 'source-1' }, { sourceNodeId: 'source-0' }]
    }), /stop after request capture/);
    assert.deepEqual(await Promise.all(capturedBody.getAll('image').map((image) => image.text())), images.toReversed());
});
