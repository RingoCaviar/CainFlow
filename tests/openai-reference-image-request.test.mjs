import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createPromptAgentNodeAdapter } from '../js/features/prompt-agent/prompt-agent-node-adapter.js';
import { createPromptAgentExecutionAdapter } from '../js/features/prompt-agent/prompt-agent-execution-adapter.js';
import { orderInputConnections } from '../js/nodes/reference-image-ports.js';
import { createProxyHeadersGetter } from '../js/services/api-client.js';
import '../js/features/execution/protocols/openai.js';
import '../js/features/execution/protocols/agnesimage.js';

function createImageRequestHarness({
    captureOnly = false, generationCount = 1, concurrent = false, modelId = 'image-model', protocolParams = {},
    protocol = 'openai', provider = {}
} = {}) {
    const node = { id: 'image-generate', type: 'ImageGenerate', apiConfigId: 'model', data: { protocolParams }, enabled: true };
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
            models: [{ id: 'model', name: 'Image model', modelId, taskType: 'image', protocol, providerIds: ['provider'] }],
            providers: [{ id: 'provider', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', apikey: '<REDACTED>', type: 'openai', ...provider }],
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

test('OpenAI edits upload all previewed images from an old numbered input', async () => {
    const { api, node, requests, state } = createImageRequestHarness({ modelId: 'gpt-image-2.5-sunburst' });
    const images = ['first', 'second'].map(value => `data:image/png;base64,${Buffer.from(value).toString('base64')}`);
    const source = { id: 'source', type: 'ImagePreview', enabled: true, data: { imageList: images, imageCount: 2 } };
    state.nodes.set(source.id, source);
    state.connections.push({
        type: 'image', from: { nodeId: source.id, port: 'image' }, to: { nodeId: node.id, port: 'image_1' }
    });
    const preview = api.buildNodeRequestPreview(node.id);
    assert.deepEqual(preview.requestBody.reference_images, images);
    await api.nodeHandlers.ImageGenerate(node, { image_1: images }, new AbortController().signal);

    const form = await requests[0].formData();
    assert.deepEqual(await Promise.all(form.getAll('image[]').map(image => image.text())), ['first', 'second']);
});

test('OpenAI GPT Image sends all 16 references in order and rejects a seventeenth before fetching', async () => {
    const { api, node, requests, elements } = createImageRequestHarness({ modelId: 'gpt-image-2.6-sunburst' });
    elements.get('image-generate-resolution').value = '1536x864';
    const references = Array.from({ length: 17 }, (_, index) => `reference ${index + 1}`);
    const referenceImages = references.map(value => `data:image/png;base64,${Buffer.from(value).toString('base64')}`);
    const signal = new AbortController().signal;

    await api.nodeHandlers.ImageGenerate(node, { referenceImages: referenceImages.slice(0, 16) }, signal);
    assert.equal(requests.length, 1);
    const form = await requests[0].formData();
    assert.equal(form.has('image'), false);
    assert.equal(form.get('size'), '1536x864');
    assert.deepEqual(await Promise.all(form.getAll('image[]').map(image => image.text())), references.slice(0, 16));

    await assert.rejects(api.nodeHandlers.ImageGenerate(node, { referenceImages }, signal), /最多.*16.*张参考图/);
    assert.equal(requests.length, 1);
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

test('GPT Image generation forwards raster output options and omits edit and DALL-E fields', async () => {
    const { api, node, requests } = createImageRequestHarness({
        modelId: 'gpt-image-1.5',
        protocolParams: { output_format: 'jpeg', output_compression: '75', input_fidelity: 'high' }
    });
    await api.nodeHandlers.ImageGenerate(node, {
        params: { quality: 'max', response_format: 'url', style: 'natural', stream: true, seed: 42 }
    }, new AbortController().signal);

    const body = await requests[0].json();
    assert.equal(body.output_format, 'jpeg');
    assert.equal(body.output_compression, 75);
    for (const field of ['input_fidelity', 'response_format', 'style', 'stream', 'quality', 'seed']) {
        assert.equal(Object.hasOwn(body, field), false, field);
    }
    assert.deepEqual(node.data.imageList, ['data:image/jpeg;base64,cmVzdWx0']);
});

test('GPT Image edit fields reflect model support in sequential and concurrent requests', async () => {
    const referenceImages = ['data:image/png;base64,Zmlyc3Q='];
    for (const [modelId, concurrent, expectedFidelity] of [
        ['gpt-image-1.5', false, 'high'],
        ['gpt-image-1-mini', true, null],
        ['gpt-image-2-2026-04-21', true, null]
    ]) {
        const { api, node, requests } = createImageRequestHarness({
            modelId, concurrent, generationCount: 2,
            protocolParams: { input_fidelity: 'high', output_format: 'webp', output_compression: '0' }
        });
        await api.nodeHandlers.ImageGenerate(node, { referenceImages }, new AbortController().signal);
        assert.equal(requests.length, 2);
        for (const request of requests) {
            const form = await request.formData();
            assert.equal(form.get('input_fidelity'), expectedFidelity);
            assert.equal(form.get('output_format'), 'webp');
            assert.equal(form.get('output_compression'), '0');
        }
        assert.deepEqual(node.data.imageList, Array(2).fill('data:image/webp;base64,cmVzdWx0'));
    }
});

test('GPT Image 2.6 accepts custom dimensions, complexity and extended quality without compression for PNG', async () => {
    const { api, node, requests, elements } = createImageRequestHarness({
        modelId: 'gpt-image-2.6-flare',
        protocolParams: { output_format: 'png', output_compression: '75', complexity: 'low' }
    });
    elements.get('image-generate-quality').value = 'xhigh';
    elements.get('image-generate-resolution').value = '1920x1088';
    await api.nodeHandlers.ImageGenerate(node, {}, new AbortController().signal);
    const body = await requests[0].json();
    assert.equal(body.size, '1920x1088');
    assert.equal(body.quality, 'xhigh');
    assert.equal(body.complexity, 'low');
    assert.equal(body.output_format, 'png');
    assert.equal(Object.hasOwn(body, 'output_compression'), false);
});

test('GPT Image 2.6 Flare encodes GIF frame settings in preview and generation and preserves the result MIME', async () => {
    const { api, node, requests } = createImageRequestHarness({
        modelId: 'gpt-image-2.6-flare',
        protocolParams: { output_format: 'gif', frame_count: 12, frame_duration_ms: '230', output_compression: 70 }
    });
    const { requestBody } = api.buildNodeRequestPreview(node.id);
    assert.equal(requestBody.output_format, 'gif');
    assert.equal(requestBody.frame_count, 12);
    assert.equal(requestBody.frame_duration_ms, 230);
    assert.equal(Object.hasOwn(requestBody, 'output_compression'), false);
    await api.nodeHandlers.ImageGenerate(node, {}, new AbortController().signal);
    assert.deepEqual(await requests[0].json(), requestBody);
    assert.deepEqual(node.data.imageList, ['data:image/gif;base64,cmVzdWx0']);
});

test('GPT Image 2.6 Sunburst sends GIF edit fields as multipart and rejects GIF masks', async () => {
    const { api, node, requests } = createImageRequestHarness({
        modelId: 'gpt-image-2.6-sunburst',
        protocolParams: { output_format: 'gif', frame_count: 2, frame_duration_ms: 2000 }
    });
    const referenceImages = ['data:image/png;base64,Zmlyc3Q='];
    const mask = 'data:image/png;base64,bWFzaw==';
    const signal = new AbortController().signal;
    await api.nodeHandlers.ImageGenerate(node, { referenceImages }, signal);
    const form = await requests[0].formData();
    assert.equal(form.get('output_format'), 'gif');
    assert.equal(form.get('frame_count'), '2');
    assert.equal(form.get('frame_duration_ms'), '2000');
    assert.equal(form.has('mask'), false);
    await assert.rejects(api.nodeHandlers.ImageGenerate(node, { referenceImages, mask }, signal), /GIF.*遮罩/);
    await assert.rejects(api.nodeHandlers.ImageGenerate(node, { mask }, signal), /GIF.*遮罩/);
    assert.equal(requests.length, 1);
});

test('GPT Image 2.6 emits SVG as vector MIME and rejects SVG edits', async () => {
    const { api, node, requests } = createImageRequestHarness({
        modelId: 'gpt-image-2.6-sunburst',
        protocolParams: { output_format: 'svg', frame_count: 4, output_compression: 25 }
    });
    const signal = new AbortController().signal;
    await api.nodeHandlers.ImageGenerate(node, {}, signal);
    const body = await requests[0].json();
    assert.equal(body.n, 1);
    assert.equal(body.output_format, 'svg');
    assert.equal(Object.hasOwn(body, 'frame_count'), false);
    assert.equal(Object.hasOwn(body, 'output_compression'), false);
    assert.deepEqual(node.data.imageList, ['data:image/svg+xml;base64,cmVzdWx0']);
    await assert.rejects(api.nodeHandlers.ImageGenerate(node, {
        referenceImages: ['data:image/png;base64,Zmlyc3Q=']
    }, signal), /SVG.*编辑/);
    await assert.rejects(api.nodeHandlers.ImageGenerate(node, {
        mask: 'data:image/png;base64,bWFzaw=='
    }, signal), /SVG.*编辑/);
    assert.equal(requests.length, 1);
});

for (const modelId of ['gpt-image-2.5-flare', 'custom-relay-model']) {
    test(`${modelId} rejects a retained GIF or SVG selection before sending a request`, async () => {
        const { api, node, requests } = createImageRequestHarness({
            modelId, protocolParams: { output_format: 'gif' }
        });
        const signal = new AbortController().signal;
        await assert.rejects(api.nodeHandlers.ImageGenerate(node, {}, signal), /不支持 GIF/);
        node.data.protocolParams.output_format = 'svg';
        await assert.rejects(api.nodeHandlers.ImageGenerate(node, {}, signal), /不支持 SVG/);
        assert.equal(requests.length, 0);
    });
}

test('SVG generation supports project-enabled authoring settings through the custom parameter input', async () => {
    const { api, node, requests } = createImageRequestHarness({
        modelId: 'gpt-image-2.6-flare', protocolParams: { output_format: 'svg' }
    });
    const signal = new AbortController().signal;
    const run = params => api.nodeHandlers.ImageGenerate(node, { params }, signal);
    await run({ svg: { model: 'author-model', reasoning: { effort: 'low' } }, prompt_rewriter: 'enabled' });
    const body = await requests[0].json();
    assert.deepEqual(body.svg, { model: 'author-model', reasoning: { effort: 'low' } });
    assert.equal(Object.hasOwn(body, 'prompt_rewriter'), false);
    await assert.rejects(run({ svg: { reasoning: { effort: 'low' } } }), /svg\.model/);
    await assert.rejects(run({ svg: { model: 'author-model', reasoning: { effort: 'unknown' } } }), /推理档位无效/);
    assert.equal(requests.length, 1);
    node.data.protocolParams.output_format = 'png';
    await run({ svg: { model: 'author-model' } });
    assert.equal(Object.hasOwn(await requests[1].json(), 'svg'), false);
});

for (const modelId of ['gpt-image-2.5-flare', 'gpt-image-2.6-sunburst']) {
    test(`${modelId} routes the connected annotation to the official markup field without turning it into a mask`, async () => {
        const { api, node, requests } = createImageRequestHarness({
            modelId, protocolParams: { edit_guide: 'markup' }
        });
        const referenceBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGNYuOnw/4uPPv8HABxLBrvCHrUpAAAAAElFTkSuQmCC';
        const reference = `data:image/png;base64,${referenceBase64}`;
        const markupBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNYuOkww38Ghv8AE3wEFcq2QBIAAAAASUVORK5CYII=';
        const markup = `data:image/png;base64,${markupBase64}`;
        const signal = new AbortController().signal;
        await api.nodeHandlers.ImageGenerate(node, { referenceImages: [reference], mask: markup }, signal);
        const form = await requests[0].formData();
        assert.equal(Buffer.from(await form.get('image').arrayBuffer()).toString('base64'), referenceBase64);
        assert.equal(form.get('markup').type, 'image/png');
        assert.equal(Buffer.from(await form.get('markup').arrayBuffer()).toString('base64'), markupBase64);
        assert.equal(form.has('mask'), false);
        assert.equal(form.has('edit_guide'), false);
        await assert.rejects(api.nodeHandlers.ImageGenerate(node, {
            referenceImages: [reference]
        }, signal), /需要连接一张标注图层/);
        await assert.rejects(api.nodeHandlers.ImageGenerate(node, { mask: markup }, signal), /需要第一张参考图/);
        await assert.rejects(api.nodeHandlers.ImageGenerate(node, {
            referenceImages: [reference], mask: 'data:image/webp;base64,b3ZlcmxheQ=='
        }, signal), /标注图层.*PNG/);
        await assert.rejects(api.nodeHandlers.ImageGenerate(node, {
            referenceImages: [reference], mask: 'data:image/png;base64,b3ZlcmxheQ=='
        }, signal), /有效的 PNG/);
        const oversizedMarkup = Buffer.from(markupBase64, 'base64');
        oversizedMarkup.writeUInt32BE(8192, 16);
        oversizedMarkup.writeUInt32BE(4096, 20);
        await assert.rejects(api.nodeHandlers.ImageGenerate(node, {
            referenceImages: [reference], mask: `data:image/png;base64,${oversizedMarkup.toString('base64')}`
        }, signal), /16,777,216/);
        await assert.rejects(api.nodeHandlers.ImageGenerate(node, {
            referenceImages: [reference], mask: [markup, markup]
        }, signal), /只支持一张标注图层/);
        assert.equal(requests.length, 1);
    });
}

test('GIF settings use API defaults when empty and reject invalid frames before requesting', async () => {
    const { api, node, requests } = createImageRequestHarness({
        modelId: 'gpt-image-2.6-flare', protocolParams: { output_format: 'gif' }
    });
    const signal = new AbortController().signal;
    await api.nodeHandlers.ImageGenerate(node, {}, signal);
    const body = await requests[0].json();
    assert.equal(body.output_format, 'gif');
    assert.equal(Object.hasOwn(body, 'frame_count'), false);
    assert.equal(Object.hasOwn(body, 'frame_duration_ms'), false);
    node.data.protocolParams.frame_count = 17;
    await assert.rejects(api.nodeHandlers.ImageGenerate(node, {}, signal), /frame_count.*2 至 16/);
    node.data.protocolParams.frame_count = 3;
    node.data.protocolParams.frame_duration_ms = '19.5';
    await assert.rejects(api.nodeHandlers.ImageGenerate(node, {}, signal), /frame_duration_ms.*20 至 2000/);
    assert.equal(requests.length, 1);
});

test('DALL-E 3 compatibility keeps style and URL/base64 choice but omits GPT Image fields', async () => {
    const { api, node, requests, elements } = createImageRequestHarness({
        modelId: 'dall-e-3',
        protocolParams: { style: 'vivid', response_format: 'b64_json', output_format: 'jpeg' }
    });
    elements.get('image-generate-quality').value = 'hd';
    await api.nodeHandlers.ImageGenerate(node, {}, new AbortController().signal);
    const body = await requests[0].json();
    assert.equal(body.style, 'vivid');
    assert.equal(body.response_format, 'b64_json');
    assert.equal(body.quality, 'hd');
    for (const field of ['background', 'moderation', 'output_format']) {
        assert.equal(Object.hasOwn(body, field), false, field);
    }
    await assert.rejects(
        api.nodeHandlers.ImageGenerate(node, { referenceImages: ['data:image/png;base64,Zmlyc3Q='] }, new AbortController().signal),
        /不支持参考图/
    );
    assert.equal(requests.length, 1);
});

test('known OpenAI model IDs preserve relay-only custom extensions on JSON requests', async () => {
    const { api, node, requests } = createImageRequestHarness({
        modelId: 'gpt-image-1.5', provider: { endpoint: 'https://relay.example.test/v1' }
    });
    const params = { seed: 42, model: 'another-model', response_format: 'url', stream: true, n: 3 };
    await api.nodeHandlers.ImageGenerate(node, { params }, new AbortController().signal);
    const body = await requests[0].json();
    assert.equal(body.seed, 42);
    assert.equal(body.model, 'gpt-image-1.5');
    assert.equal(body.n, 1);
    assert.equal(Object.hasOwn(body, 'response_format'), false);
    assert.equal(Object.hasOwn(body, 'stream'), false);

    await api.nodeHandlers.ImageGenerate(node, {
        params,
        referenceImages: ['data:image/png;base64,Zmlyc3Q=']
    }, new AbortController().signal);
    const form = await requests[1].formData();
    assert.equal(form.has('seed'), false);
    assert.equal(form.get('model'), 'gpt-image-1.5');
});

test('other image compatibility formats keep their JSON references and custom parameters', async () => {
    const { api, node, requests } = createImageRequestHarness({
        modelId: 'gpt-image-1.5', protocol: 'agnesimage',
        provider: { endpoint: 'https://relay.example.test/v1/images/generations', autoComplete: false }
    });
    const referenceImages = ['data:image/png;base64,Zmlyc3Q='];
    await api.nodeHandlers.ImageGenerate(node, { referenceImages, params: { seed: 42 } }, new AbortController().signal);
    const body = await requests[0].json();
    assert.deepEqual(body.reference_images, referenceImages);
    assert.equal(body.seed, 42);
});

test('manual relay endpoints can still accept reference images in JSON', async () => {
    const { api, node, requests } = createImageRequestHarness({
        modelId: 'gpt-image-1.5', provider: { endpoint: 'https://relay.example.test/render', autoComplete: false }
    });
    const referenceImages = ['data:image/png;base64,Zmlyc3Q='];
    const inputs = { referenceImages, params: { seed: 42 } };
    await api.nodeHandlers.ImageGenerate(node, inputs, new AbortController().signal);
    const body = await requests[0].json();
    assert.deepEqual(body.reference_images, referenceImages);
    assert.equal(body.seed, 42);
});

test('manual OpenAI edits endpoint with a trailing slash still uploads multipart', async () => {
    const { api, node, requests } = createImageRequestHarness({
        modelId: 'gpt-image-1.5',
        provider: { endpoint: 'https://api.openai.com/v1/images/edits/', autoComplete: false }
    });
    await api.nodeHandlers.ImageGenerate(node, {
        referenceImages: ['data:image/png;base64,Zmlyc3Q=']
    }, new AbortController().signal);
    assert.match(requests[0].headers.get('content-type'), /^multipart\/form-data; boundary=/);
    assert.equal(await (await requests[0].formData()).get('image').text(), 'first');
});
