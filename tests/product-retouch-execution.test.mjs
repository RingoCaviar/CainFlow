import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import '../js/features/execution/protocols/openai.js';
import '../js/features/execution/protocols/google.js';
import '../js/features/execution/protocols/ttapi-openai.js';

const original = 'data:image/png;base64,AAAA';
const finished = 'data:image/png;base64,AQAA';
const remoteOriginal = 'https://fixture.test/product.png';
const downloadedOriginal = 'data:image/png;base64,AgME';
const comparison = { originalAssetKey: 'media:asset-2', resultAssetKey: 'media:asset-1' };

function createRetouchFixture({ protocol = 'openai', modelId = 'gpt-image-2', endpoint = 'https://fixture.test', autoComplete = true } = {}) {
    const node = {
        id: 'retouch',
        type: 'ProductRetouch',
        activeMediaOperationId: 'retouch-operation',
        data: { productRetouch: {
            background: 'black', lighting: 'dramatic', shadow: 'none', finish: 'polished',
            notes: '保留杯身刻度', modelId: 'image-model', providerId: 'provider'
        } }
    };
    const requests = [], history = [], assets = [], saves = [], released = [], updates = [];
    const noop = () => {};
    let responseData = 'AQAA', onSave;
    const saveAssets = async (images, workflowId, nodeId, operationId) => {
        const ownerId = `${workflowId}:${nodeId}:${operationId}`;
        const batch = images.map(image => {
            const asset = { asset_key: `media:asset-${assets.length + 1}`, mediaTemporaryOwnerId: ownerId };
            assets.push({ image, asset });
            return asset;
        });
        saves.push({ images, workflowId, nodeId, operationId });
        return onSave ? onSave(batch) : batch;
    };
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
        blobToDataUrl: async blob => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`,
        fetchRef: async (url, { headers, body }) => {
            if (url === remoteOriginal) return new Response(Uint8Array.of(2, 3, 4), { headers: { 'Content-Type': 'image/png' } });
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
        saveWorkflowNodeMediaAssets: saveAssets,
        releaseWorkflowNodeMediaAssets: async entries => { released.push(...entries); },
        onNodeResultUpdated: (id, details) => { updates.push({ id, details }); }
    });
    const execute = (image = original, signal) => core.executeNode(node, { image }, signal);
    return {
        node, execute, requests, history, assets, saves, released, updates,
        getOutput: () => core.getCachedOutputValue(node, 'image'),
        setResponseData: data => { responseData = data; },
        setOnSave: callback => { onSave = callback; }
    };
}

test('product retouch stores the sent original beside its result and exposes only the result downstream', async () => {
    const { node, execute, requests, history, saves, updates, getOutput } = createRetouchFixture();
    assert.equal((await execute()).image, finished);
    assert.equal(requests.length, 1);
    const [{ url, body }] = requests;
    assert.match(url, /\/images\/edits$/);
    const references = body.getAll('image');
    assert.equal(references.length, 1);
    assert.deepEqual([...new Uint8Array(await references[0].arrayBuffer())], [0, 0, 0]);
    const prompt = body.get('prompt');
    assert.match(prompt, /^对所附商品原图进行商业摄影精修/);
    for (const text of ['纯黑', '高反差', '去除', '抛光', '保留杯身刻度', '比例', '标识', '包装文字', '构图']) {
        assert.ok(prompt.includes(text), `expected prompt to include ${text}`);
    }
    assert.equal(getOutput(), finished);
    assert.deepEqual(node.data.mediaAssetKeys, [comparison.resultAssetKey]);
    assert.deepEqual(node.data.productRetouchComparison, comparison);
    assert.deepEqual(saves, [
        { images: [finished, original], workflowId: 'workflow', nodeId: node.id, operationId: 'retouch-operation' }
    ]);
    assert.deepEqual(node.data.mediaOwnershipTemporaryOwners, [
        { ownerId: 'workflow:retouch:retouch-operation', assetKeys: [comparison.resultAssetKey, comparison.originalAssetKey] }
    ]);
    assert.deepEqual(history.map(entry => entry.image), [finished]);
    assert.ok(updates.some(({ details }) => details.downstreamImageResults));
});

test('product retouch stores the bytes resolved from its remote source for comparison', async () => {
    const { node, execute, requests, assets } = createRetouchFixture();
    await execute(remoteOriginal);
    const uploaded = requests[0].body.get('image');
    const saved = assets.find(({ asset }) => asset.asset_key === node.data.productRetouchComparison?.originalAssetKey);
    assert.equal(saved?.image, downloadedOriginal);
    assert.equal(Buffer.from(await uploaded.arrayBuffer()).toString('base64'), saved.image.split(',')[1]);
});

test('product retouch can compare identical output and original with one content-addressed asset key', async () => {
    const { node, execute, getOutput, setOnSave, setResponseData } = createRetouchFixture();
    setResponseData('AAAA');
    setOnSave(([asset]) => [asset, asset]);
    await execute(original);
    assert.equal(getOutput(), original);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:asset-1']);
    assert.deepEqual(node.data.productRetouchComparison, { originalAssetKey: 'media:asset-1', resultAssetKey: 'media:asset-1' });
});

test('Gemini retouch sends the inline original first and limits changes to the requested retouch settings', async () => {
    const { node, execute, requests } = createRetouchFixture({ protocol: 'google', modelId: 'gemini-2.5-flash-image' });
    node.data.productRetouch = { ...node.data.productRetouch, background: 'original', lighting: 'balanced', shadow: 'natural' };
    assert.equal((await execute()).image, finished);
    assert.equal(requests.length, 1);
    const [{ body }] = requests;
    const request = JSON.parse(body);
    const [reference, prompt] = request.contents[0].parts;
    assert.deepEqual(reference.inlineData, { mimeType: 'image/png', data: 'AAAA' });
    assert.match(prompt.text, /原图为唯一依据/);
    assert.match(prompt.text, /刻度.*包装文字/);
    assert.match(prompt.text, /位置.*字形.*内容/);
    assert.match(prompt.text, /保留原图的背景内容和颜色/);
    assert.match(prompt.text, /曝光和白平衡/);
    assert.match(prompt.text, /自然的接触阴影/);
    assert.match(prompt.text, /抛光.*材质/);
    assert.match(prompt.text, /补充要求.*保留杯身刻度/);
    assert.deepEqual(request.generationConfig, { responseModalities: ['TEXT', 'IMAGE'] });
    assert.equal(request.tools, undefined);
});

test('Gemini retouch explains how to separate a dark product from a black background without recoloring it', async () => {
    const { execute, requests } = createRetouchFixture({ protocol: 'google', modelId: 'gemini-3.1-flash-image' });
    await execute();
    const { contents, generationConfig } = JSON.parse(requests[0].body);
    const prompt = contents[0].parts[1].text;
    assert.match(prompt, /#000000/);
    assert.match(prompt, /轮廓.*保持商品原色/);
    assert.match(prompt, /高反差/);
    assert.match(prompt, /去除.*接触阴影.*保留商品自身/);
    assert.equal(generationConfig.imageConfig, undefined);
    assert.equal(generationConfig.thinkingConfig, undefined);
});

test('a recognized Gemini model behind an OpenAI relay uses the Gemini retouch brief with multipart transport', async () => {
    for (const modelId of ['gemini-3.1-flash-image', 'google/gemini-3.1-flash-image', 'gemini-nano-banana-2.1']) {
        const { execute, requests } = createRetouchFixture({ modelId });
        await execute();
        const { body } = requests[0];
        assert.ok(body.get('image') instanceof Blob);
        assert.equal(body.get('model'), modelId);
        assert.match(body.get('prompt'), /原图为唯一依据/);
    }
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

test('product retouch keeps its last comparison after a failed request, partial save or a canceled replacement', async () => {
    const { node, execute, assets, released, getOutput, setOnSave, setResponseData } = createRetouchFixture();
    await execute();

    setResponseData('');
    await assert.rejects(execute(), /API 未返回图片数据/);
    assert.equal(getOutput(), finished);
    assert.deepEqual(node.data.productRetouchComparison, comparison);
    assert.equal(assets.length, 2);

    setResponseData('YnJva2Vu');
    await assert.rejects(execute(), /模型返回的图片无法打开/);
    assert.equal(getOutput(), finished);
    assert.deepEqual(node.data.productRetouchComparison, comparison);
    assert.equal(assets.length, 2);

    setResponseData('AgAA');
    setOnSave(batch => batch.slice(0, 1));
    await assert.rejects(execute(downloadedOriginal), /工作流媒体保存失败/);
    assert.equal(getOutput(), finished);
    assert.deepEqual(node.data.productRetouchComparison, comparison);
    assert.deepEqual(released, [assets[2].asset]);

    const abort = new AbortController();
    setOnSave(batch => {
        abort.abort();
        return batch;
    });
    await assert.rejects(execute(downloadedOriginal, abort.signal), { name: 'AbortError' });
    assert.equal(getOutput(), finished);
    assert.deepEqual(node.data.mediaAssetKeys, [comparison.resultAssetKey]);
    assert.deepEqual(node.data.productRetouchComparison, comparison);
    assert.deepEqual(released, [assets[2].asset, assets[4].asset, assets[5].asset]);
});
