import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createPromptAgentNodeAdapter } from '../js/features/prompt-agent/prompt-agent-node-adapter.js';
import { createPromptAgentExecutionAdapter } from '../js/features/prompt-agent/prompt-agent-execution-adapter.js';
import { orderInputConnections } from '../js/nodes/reference-image-ports.js';
import { createProxyHeadersGetter } from '../js/services/api-client.js';

function createImageRequestHarness({ captureOnly = false, generationCount = 1, concurrent = false } = {}) {
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
        'image-generate-generation-count': { value: String(generationCount) },
        'image-generate-prompt': { value: '保留主体并改变背景' },
    }));
    let capturedBody;
    const requests = [];
    const remoteImages = new Map();
    const state = {
            concurrentRequestMode: concurrent,
            nodes: new Map([[node.id, node]]),
            connections: [],
            models: [{ id: 'model', name: 'Image model', modelId: 'image-model', protocol: 'openai', providerIds: ['provider'] }],
            providers: [{ id: 'provider', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', apikey: '<REDACTED>', type: 'openai' }],
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
            if (remoteImages.has(_url)) return new Response(remoteImages.get(_url));
            capturedBody = options.body;
            requests.push(new Request('http://localhost/proxy', options));
            if (captureOnly) throw new Error('stop after request capture');
            return Response.json({ data: [{ b64_json: 'cmVzdWx0' }] });
        },
        showToast: () => {},
        addLog: () => {},
        getProxyHeaders: createProxyHeadersGetter(() => state),
        classifyProviderError: () => ({ message: 'stop after request capture' }),
        logRequestToPanel: () => {},
        fitNodeToContent: () => {},
        refreshDependentImageResizePreviews: async () => {},
        saveHistoryEntry: async () => true,
        dataURLtoBlob: (value) => new Blob([Buffer.from(value.split(',')[1], 'base64')], {
            type: value.slice(5, value.indexOf(';')),
        }),
        getAbortMessage: () => '',
    });
    return { api, node, state, elements, requests, remoteImages, get capturedBody() { return capturedBody; } };
}

test('OpenAI image edit uploads multiple references using the official image[] multipart field', async () => {
    const harness = createImageRequestHarness({ captureOnly: true });
    const { api, node, state, elements } = harness;

    await assert.rejects(
        api.nodeHandlers.ImageGenerate(node, {
            referenceImages: [
                'data:image/png;base64,Zmlyc3Q=',
                'data:image/png;base64,c2Vjb25k',
            ],
        }, new AbortController().signal),
        /stop after request capture/,
    );

    assert.ok(harness.capturedBody instanceof FormData);
    assert.equal(harness.capturedBody.getAll('image[]').length, 2);
    assert.equal(harness.capturedBody.has('image'), false);

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
    const wireBody = await harness.requests.at(-1).formData();
    assert.deepEqual(await Promise.all(wireBody.getAll('image[]').map((image) => image.text())), ['second', 'first']);
});

for (const concurrent of [false, true]) {
    test(`OpenAI ${concurrent ? 'concurrent' : 'sequential'} image edits serialize all references and a separate mask`, async () => {
        const { api, node, requests, remoteImages } = createImageRequestHarness({ generationCount: 2, concurrent });
        const remoteUrl = 'https://cdn.example.test/second.webp';
        remoteImages.set(remoteUrl, new Blob(['second'], { type: 'image/webp' }));
        const signal = new AbortController().signal;

        await api.nodeHandlers.ImageGenerate(node, {
            referenceImages: ['data:image/jpeg;base64,dGhpcmQ='],
            image_2: remoteUrl,
            image: 'data:image/png;base64,Zmlyc3Q=',
            mask: 'data:image/png;base64,bWFzaw==',
        }, signal);

        assert.equal(node.generationCompletedCount, 2);
        assert.equal(requests.length, 2);
        for (const request of requests) {
            assert.equal(Buffer.from(request.headers.get('x-target-url-b64'), 'base64url').toString(),
                'https://api.openai.com/v1/images/edits');
            assert.match(request.headers.get('content-type'), /^multipart\/form-data; boundary=/);
            const form = await request.formData();
            const images = form.getAll('image[]');
            assert.equal(form.has('image'), false);
            assert.deepEqual(await Promise.all(images.map((image) => image.text())), ['first', 'second', 'third']);
            assert.deepEqual(images.map((image) => [image.name, image.type]), [
                ['reference_1.png', 'image/png'],
                ['reference_2.webp', 'image/webp'],
                ['reference_3.jpg', 'image/jpeg'],
            ]);
            assert.equal(form.get('model'), 'image-model');
            assert.equal(form.get('prompt'), '保留主体并改变背景');
            assert.equal(form.get('size'), '1024x1024');
            assert.equal(form.getAll('mask').length, 1);
            assert.equal(form.get('mask').name, 'mask.png');
            assert.equal(await form.get('mask').text(), 'mask');
        }
    });
}

test('OpenAI single-reference edits keep the scalar image field', async () => {
    const { api, node, requests } = createImageRequestHarness();
    await api.nodeHandlers.ImageGenerate(node, {
        referenceImages: ['data:image/png;base64,Zmlyc3Q='],
    }, new AbortController().signal);

    assert.equal(node.generationCompletedCount, 1);
    const form = await requests[0].formData();
    assert.equal(form.getAll('image').length, 1);
    assert.equal(await form.get('image').text(), 'first');
    assert.equal(form.has('image[]'), false);
    assert.equal(form.has('mask'), false);
});

test('OpenAI generation without references keeps the JSON generations request', async () => {
    const { api, node, requests } = createImageRequestHarness();
    await api.nodeHandlers.ImageGenerate(node, {}, new AbortController().signal);

    assert.equal(node.generationCompletedCount, 1);
    assert.equal(Buffer.from(requests[0].headers.get('x-target-url-b64'), 'base64url').toString(),
        'https://api.openai.com/v1/images/generations');
    assert.equal(requests[0].headers.get('content-type'), 'application/json');
    const body = await requests[0].json();
    assert.equal(body.prompt, '保留主体并改变背景');
    assert.equal('image' in body, false);
    assert.equal('images' in body, false);
});
