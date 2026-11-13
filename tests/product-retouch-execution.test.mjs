import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import '../js/features/execution/protocols/openai.js';
import '../js/features/execution/protocols/google.js';
import '../js/features/execution/protocols/ttapi-openai.js';

const original = 'data:image/png;base64,AAAA';
const finished = 'data:image/png;base64,AQAA';

function createRetouchFixture({ protocol = 'openai', modelId = 'gpt-image-2', endpoint = 'https://fixture.test', autoComplete = true } = {}) {
    const node = {
        id: 'retouch',
        type: 'ProductRetouch',
        data: { productRetouch: {
            background: 'black', lighting: 'dramatic', shadow: 'none', finish: 'polished',
            notes: '保留杯身刻度', modelId: 'image-model', providerId: 'provider'
        } }
    };
    const requests = [], history = [], assets = [], released = [], updates = [];
    const noop = () => {};
    let responseData = 'AQAA', onSave;
    const core = createExecutionCoreApi({
        state: {
            nodes: new Map([[node.id, node]]), connections: [],
            models: [{ id: 'image-model', name: 'Image', modelId, taskType: 'image', protocol, providerIds: ['provider'] }],
            providers: [{ id: 'provider', endpoint, autoComplete, apikey: 'fixture-key' }]
        },
        nodeConfigs: {},
        documentRef: { getElementById: () => null },
        windowRef: { requestAnimationFrame: noop, Image: class {
            async decode() {
                if (this.src.endsWith(',YnJva2Vu')) throw new Error('Invalid fixture image');
            }
        } },
        getActiveWorkflowId: () => 'workflow',
        showToast: noop,
        addLog: noop,
        getProxyHeaders: url => ({ 'X-Test-Provider': url }),
        logRequestToPanel: noop,
        dataURLtoBlob: source => new Blob([Buffer.from(source.split(',')[1], 'base64')], { type: 'image/png' }),
        fetchRef: async (url, { headers, body }) => {
            assert.equal(url, '/proxy');
            requests.push({ url: headers['X-Test-Provider'], body });
            if (protocol === 'google') {
                return Response.json({ candidates: [{ content: { parts: [
                    responseData ? { inlineData: { mimeType: 'image/png', data: responseData } } : { text: 'no image' }
                ] } }] });
            }
            if (protocol === 'ttapi-openai') {
                return Response.json({ data: { image_url: `data:image/png;base64,${responseData}` } });
            }
            return Response.json({ data: responseData ? [{ b64_json: responseData }] : [] });
        },
        saveHistoryEntry: async entry => { history.push(entry); },
        saveWorkflowNodeMediaAsset: async (image, workflowId, nodeId) => {
            const asset = { asset_key: `media:result-${assets.length + 1}` };
            assets.push({ image, workflowId, nodeId, asset });
            return onSave ? onSave(asset) : asset;
        },
        releaseWorkflowNodeMediaAssets: async entries => { released.push(...entries); },
        onNodeResultUpdated: (id, details) => { updates.push({ id, details }); }
    });
    const execute = (image = original, signal) => core.executeNode(node, { image }, signal);
    return {
        node, execute, requests, history, assets, released, updates,
        getOutput: () => core.getCachedOutputValue(node, 'image'),
        setResponseData: data => { responseData = data; },
        setOnSave: callback => { onSave = callback; }
    };
}

test('product retouch sends the original and the selected edits and stores one downstream image', async () => {
    const { node, execute, requests, history, assets, updates, getOutput } = createRetouchFixture();
    assert.equal((await execute()).image, finished);
    assert.equal(requests.length, 1);
    const [{ url, body }] = requests;
    assert.match(url, /\/images\/edits$/);
    const references = body.getAll('image');
    assert.equal(references.length, 1);
    assert.deepEqual([...new Uint8Array(await references[0].arrayBuffer())], [0, 0, 0]);
    const prompt = body.get('prompt');
    for (const text of ['纯黑', '高反差', '去除', '抛光', '保留杯身刻度', '比例', '标识', '包装文字', '构图']) {
        assert.ok(prompt.includes(text), `expected prompt to include ${text}`);
    }
    assert.equal(getOutput(), finished);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:result-1']);
    assert.deepEqual(assets.map(({ image, workflowId, nodeId }) => ({ image, workflowId, nodeId })), [
        { image: finished, workflowId: 'workflow', nodeId: node.id }
    ]);
    assert.deepEqual(history.map(entry => entry.image), [finished]);
    assert.ok(updates.some(({ details }) => details.downstreamImageResults));
});

test('product retouch sends Gemini the inline original with its background and shadow instructions', async () => {
    const { node, execute, requests } = createRetouchFixture({ protocol: 'google', modelId: 'gemini-2.5-flash-image' });
    node.data.productRetouch = { ...node.data.productRetouch, background: 'original', lighting: 'balanced', shadow: 'natural' };
    assert.equal((await execute()).image, finished);
    assert.equal(requests.length, 1);
    const [{ body }] = requests;
    const [prompt, reference] = JSON.parse(body).contents[0].parts;
    assert.match(prompt.text, /保留原图的背景内容和颜色/);
    assert.match(prompt.text, /曝光和白平衡/);
    assert.match(prompt.text, /自然的接触阴影/);
    assert.deepEqual(reference.inlineData, { mimeType: 'image/png', data: 'AAAA' });
});

test('product retouch sends TTAPI OpenAI the original at its image edits endpoint', async () => {
    const { execute, requests } = createRetouchFixture({ protocol: 'ttapi-openai' });
    assert.equal((await execute()).image, finished);
    assert.equal(requests.length, 1);
    const [{ url, body }] = requests;
    assert.match(url, /\/images\/edits$/);
    const request = JSON.parse(body);
    assert.deepEqual(request.images, [original]);
    assert.equal(request.size, 'auto');
});

test('product retouch requires one intact source and an image editing endpoint before sending a request', async () => {
    const { execute, requests } = createRetouchFixture();
    for (const image of ['', [original, original], [original, null]]) {
        await assert.rejects(execute(image), /一张完整的商品参考图/);
    }
    await assert.rejects(execute('data:image/png;base64,'), /无法读取商品参考图/);
    assert.equal(requests.length, 0);

    const generationOnlyModel = createRetouchFixture({ modelId: 'dall-e-3' });
    await assert.rejects(generationOnlyModel.execute(), /支持参考图编辑/);
    assert.equal(generationOnlyModel.requests.length, 0);

    const generationOnlyEndpoint = createRetouchFixture({ endpoint: 'https://fixture.test/text-to-image', autoComplete: false });
    await assert.rejects(generationOnlyEndpoint.execute(), /支持参考图编辑/);
    assert.equal(generationOnlyEndpoint.requests.length, 0);
});

test('product retouch keeps its last saved result after a failed request or a canceled replacement', async () => {
    const { node, execute, assets, released, getOutput, setOnSave, setResponseData } = createRetouchFixture();
    await execute();

    setResponseData('');
    await assert.rejects(execute(), /API 未返回图片数据/);
    assert.equal(getOutput(), finished);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:result-1']);
    assert.equal(assets.length, 1);

    setResponseData('YnJva2Vu');
    await assert.rejects(execute(), /模型返回的图片无法打开/);
    assert.equal(getOutput(), finished);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:result-1']);
    assert.equal(assets.length, 1);

    const abort = new AbortController();
    setResponseData('AgAA');
    setOnSave(asset => {
        abort.abort();
        return asset;
    });
    await assert.rejects(execute(original, abort.signal), { name: 'AbortError' });
    assert.equal(getOutput(), finished);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:result-1']);
    assert.deepEqual(released, [assets[1].asset]);
});
