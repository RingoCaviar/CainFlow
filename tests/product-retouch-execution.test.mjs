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
const advice = '杯身右侧：沿局部纹理去除污点';

function createRetouchFixture({
    protocol = 'openai', modelId = 'gpt-image-2', endpoint = 'https://fixture.test', autoComplete = true,
    analysisProtocol = 'openai', analysisModelId = 'vision-chat', analysisEndpoint = 'https://vision.test',
    analysisAutoComplete = true, useOriginalFile = false
} = {}) {
    const node = {
        id: 'retouch',
        type: 'ProductRetouch',
        activeMediaOperationId: 'retouch-operation',
        data: { productRetouch: {
            background: 'black', lighting: 'dramatic', shadow: 'none', finish: 'polished',
            notes: '保留杯身刻度', modelId: 'image-model', providerId: 'provider',
            analysisModelId: 'vision-model', analysisProviderId: 'vision-provider'
        } }
    };
    const requests = [], analysisRequests = [], logs = [], history = [], assets = [], saves = [], released = [], updates = [];
    const noop = () => {};
    let responseData = 'AQAA', onSave;
    let analyze = () => JSON.stringify({ adjustments: [{ area: '杯身右侧', edit: '沿局部纹理去除污点' }] });
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
            nodes: new Map([[node.id, node], ...(useOriginalFile ? [['original', { type: 'FileImport' }]] : [])]),
            connections: useOriginalFile ? [{ from: { nodeId: 'original', port: 'image' }, to: { nodeId: node.id, port: 'image' } }] : [],
            models: [
                { id: 'image-model', name: 'Image', modelId, taskType: 'image', protocol, providerIds: ['provider'] },
                { id: 'vision-model', name: 'Vision', modelId: analysisModelId, taskType: 'chat', protocol: analysisProtocol, providerIds: ['vision-provider'] }
            ],
            providers: [
                { id: 'provider', endpoint, autoComplete, apikey: 'fixture-key' },
                { id: 'vision-provider', endpoint: analysisEndpoint, autoComplete: analysisAutoComplete, apikey: 'vision-key' }
            ]
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
        getProxyHeaders: (url, _method, headers) => ({ 'X-Test-Provider': url, ...headers }),
        logRequestToPanel: (title, url, body, details) => { logs.push({ title, url, body, details }); },
        dataURLtoBlob: source => new Blob([Buffer.from(source.split(',')[1], 'base64')], { type: 'image/png' }),
        blobToDataUrl: async blob => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`,
        fetchRef: async (url, { headers, body, signal }) => {
            if (url === remoteOriginal) return new Response(Uint8Array.of(2, 3, 4), { headers: { 'Content-Type': 'image/png' } });
            assert.equal(url, '/proxy');
            const target = headers['X-Test-Provider'];
            if (new URL(target).hostname === new URL(analysisEndpoint).hostname) {
                analysisRequests.push({ url: target, body: JSON.parse(body), headers, stage: node.productRetouchStage });
                const reply = await analyze(signal);
                if (reply instanceof Response) return reply;
                return analysisProtocol === 'google'
                    ? Response.json({ candidates: [{ content: { parts: [{ text: reply }] } }] })
                    : Response.json({ choices: [{ message: { content: reply } }] });
            }
            requests.push({ url: target, body });
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
        onNodeResultUpdated: (id, details) => { updates.push({ id, details, stage: node.productRetouchStage, analysis: node.data.productRetouchAnalysis }); }
    });
    const execute = (image = original, signal) => core.executeNode(node, { image }, signal);
    return {
        node, execute, requests, analysisRequests, logs, history, assets, saves, released, updates,
        getOutput: () => core.getCachedOutputValue(node, 'image'),
        setResponseData: data => { responseData = data; },
        setOnSave: callback => { onSave = callback; },
        setAnalyze: callback => { analyze = callback; }
    };
}

test('product retouch analyzes the original before editing and exposes only the result downstream', async () => {
    const { node, execute, requests, analysisRequests, history, saves, updates, getOutput } = createRetouchFixture();
    assert.equal((await execute()).image, finished);
    assert.equal(requests.length, 1);
    assert.equal(analysisRequests.length, 1);
    const [{ url: analysisUrl, body: analysisBody, stage }] = analysisRequests;
    assert.match(analysisUrl, /^https:\/\/vision\.test\/.*chat\/completions$/);
    assert.equal(stage, 'analyzing');
    assert.equal(analysisBody.messages.at(-1).content[1].image_url.url, original);
    const [{ url, body }] = requests;
    assert.match(url, /\/images\/edits$/);
    const references = body.getAll('image');
    assert.equal(references.length, 1);
    assert.deepEqual([...new Uint8Array(await references[0].arrayBuffer())], [0, 0, 0]);
    const prompt = body.get('prompt');
    assert.match(prompt, /^直接在所附商品照片上做摄影后期/);
    for (const text of ['纯黑', '高反差', '去除', '抛光', '保留杯身刻度', '比例', '标识', '包装文字', advice]) {
        assert.ok(prompt.includes(text), `expected prompt to include ${text}`);
    }
    assert.deepEqual(node.data.productRetouchAnalysis, { prompt: advice });
    assert.equal(node.productRetouchStage, undefined);
    assert.ok(updates.some(({ stage, analysis }) => stage === 'retouching' && analysis.prompt === advice));
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
    assert.ok(updates.some(({ details }) => details?.downstreamImageResults));
});

test('product retouch persists only the generated result when the input is an original file', async () => {
    const { node, execute, analysisRequests, saves, history } = createRetouchFixture({ useOriginalFile: true });
    assert.equal((await execute()).image, finished);
    assert.equal(analysisRequests[0].body.messages.at(-1).content[1].image_url.url, original);
    assert.equal(analysisRequests[0].headers['X-Cainflow-Private-Input'], '1');
    assert.deepEqual(saves[0].images, [finished]);
    assert.equal(node.data.productRetouchComparison, undefined);
    assert.equal(history[0].prompt, '');
});

test('product retouch stores the bytes resolved from its remote source for comparison', async () => {
    const { node, execute, requests, analysisRequests, assets } = createRetouchFixture();
    await execute(remoteOriginal);
    const uploaded = requests[0].body.get('image');
    const saved = assets.find(({ asset }) => asset.asset_key === node.data.productRetouchComparison?.originalAssetKey);
    assert.equal(saved?.image, downloadedOriginal);
    assert.equal(analysisRequests[0].body.messages.at(-1).content[1].image_url.url, saved.image);
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
    assert.match(prompt.text, /优先局部去除.*灰尘.*指纹.*污渍.*浅表擦痕.*周围的纹理和明暗/);
    assert.match(prompt.text, /刻度.*包装文字/);
    assert.match(prompt.text, /位置.*字形.*内容/);
    assert.match(prompt.text, /接缝、印刷图案/);
    assert.match(prompt.text, /看不清的标识和文字维持原状/);
    assert.match(prompt.text, /保留原图的背景内容和颜色/);
    assert.match(prompt.text, /曝光和白平衡/);
    assert.match(prompt.text, /自然的接触阴影/);
    assert.match(prompt.text, /抛光.*材质/);
    assert.match(prompt.text, /随所选布光轻微整理杂乱高光/);
    assert.match(prompt.text, /补充要求.*保留杯身刻度/);
    assert.deepEqual(request.generationConfig, { responseModalities: ['TEXT', 'IMAGE'] });
    assert.equal(request.tools, undefined);
});

test('Gemini retouch explains how to separate a dark product from a black background without recoloring it', async () => {
    const { node, execute, requests } = createRetouchFixture({ protocol: 'google', modelId: 'gemini-3.1-flash-image' });
    node.data.productRetouch.finish = 'natural';
    await execute();
    const { contents, generationConfig } = JSON.parse(requests[0].body);
    const prompt = contents[0].parts[1].text;
    assert.match(prompt, /#000000/);
    assert.match(prompt, /轮廓.*保持商品原色/);
    assert.match(prompt, /高反差/);
    assert.match(prompt, /去除.*接触阴影.*保留商品自身/);
    assert.match(prompt, /优先局部去除.*浅表擦痕/);
    assert.match(prompt, /表面：.*保留织纹、颗粒、缝线/);
    assert.equal(generationConfig.imageConfig, undefined);
    assert.equal(generationConfig.thinkingConfig, undefined);
});

test('native Gemini and OpenAI relay editing receive the same prompt and wire formats stay compatible', async () => {
    const gemini = createRetouchFixture({ protocol: 'google', modelId: 'gemini-3.1-flash-image' });
    await gemini.execute();
    const [, { text: prompt }] = JSON.parse(gemini.requests[0].body).contents[0].parts;
    const relay = createRetouchFixture({ modelId: 'google/gemini-3.1-flash-image' });
    await relay.execute();
    const { body } = relay.requests[0];
    assert.ok(body.get('image') instanceof Blob);
    assert.equal(body.get('model'), 'google/gemini-3.1-flash-image');
    assert.equal(body.get('prompt'), prompt);
    const gpt = createRetouchFixture();
    await gpt.execute();
    assert.equal(gpt.requests[0].body.get('prompt'), prompt);
});

test('Gemini vision receives the configured settings and permits an empty list of photo-specific adjustments', async () => {
    const { node, execute, requests, analysisRequests, setAnalyze } = createRetouchFixture({ analysisProtocol: 'google' });
    setAnalyze(() => '{"adjustments":[]}');
    await execute();
    const [{ url, body }] = analysisRequests;
    assert.match(url, /:generateContent\?/);
    const [text, reference] = body.contents[0].parts;
    assert.deepEqual(reference.inlineData, { mimeType: 'image/png', data: 'AAAA' });
    assert.match(text.text, /#000000/);
    assert.match(text.text, /高反差/);
    assert.match(text.text, /保留杯身刻度/);
    assert.deepEqual(node.data.productRetouchAnalysis, { prompt: '' });
    assert.doesNotMatch(requests[0].body.get('prompt'), /针对原图的局部处理/);
});

test('retouch skips image editing after invalid analysis, provider error, or cancellation', async () => {
    const { node, execute, requests, assets, analysisRequests, setAnalyze } = createRetouchFixture();
    for (const reply of ['无法处理', '{"adjustments":[{"area":"杯身","edit":""}]}',
        JSON.stringify({ adjustments: [{ area: '杯身', edit: '长'.repeat(161) }] })]) {
        setAnalyze(() => reply);
        await assert.rejects(execute(), /未返回有效的精修建议/);
        assert.equal(node.productRetouchStage, undefined);
    }
    setAnalyze(() => new Response('{}', { status: 500 }));
    await assert.rejects(execute(), /对话请求失败（HTTP 500）/);

    const abort = new AbortController();
    setAnalyze(signal => {
        assert.equal(signal, abort.signal);
        abort.abort();
        return '{"adjustments":[]}';
    });
    await assert.rejects(execute(original, abort.signal), { name: 'AbortError' });
    assert.equal(analysisRequests.length, 5);
    assert.equal(requests.length, 0);
    assert.equal(assets.length, 0);
    assert.equal(node.data.productRetouchAnalysis, undefined);
    assert.equal(node.productRetouchStage, undefined);
});

test('retouch requires an explicitly configured vision-capable model and bound provider', async () => {
    const legacy = createRetouchFixture();
    delete legacy.node.data.productRetouch.analysisProviderId;
    await assert.rejects(legacy.execute(), /请选择支持图片输入/);
    assert.equal(legacy.analysisRequests.length, 0);
    assert.equal(legacy.requests.length, 0);

    const textOnly = createRetouchFixture({ analysisModelId: 'gpt-3.5-turbo', analysisEndpoint: 'https://api.openai.com' });
    await assert.rejects(textOnly.execute(), /请选择支持图片输入/);
    assert.equal(textOnly.analysisRequests.length, 0);
    assert.equal(textOnly.requests.length, 0);
});

test('retouch excludes known text-only chat models on compatible relays', async () => {
    for (const analysisModelId of ['gpt-3.5-turbo', 'openai/o3-mini-2025-01-31']) {
        const fixture = createRetouchFixture({ analysisModelId });
        await assert.rejects(fixture.execute(), /请选择支持图片输入/);
        assert.equal(fixture.analysisRequests.length, 0);
        assert.equal(fixture.requests.length, 0);
    }
});

test('retouch analysis request logs keep inline image bytes private for both chat protocols', async () => {
    for (const analysisProtocol of ['google', 'openai']) {
        const { execute, analysisRequests, logs } = createRetouchFixture({ analysisProtocol });
        await execute();
        assert.match(JSON.stringify(analysisRequests[0].body), /AAAA/);
        const analysisLog = logs.find(log => log.details.operation === 'analyze');
        assert.deepEqual(analysisLog.body, { model: 'vision-chat', referenceImageCount: 1 });
        assert.doesNotMatch(JSON.stringify(analysisLog), /AAAA|vision-key/);
    }
});

test('a manual Gemini analysis address uses the saved key unless the URL already carries a key', async () => {
    const analysisEndpoint = 'https://vision.test/v1beta/models/vision-chat:generateContent';
    const manual = createRetouchFixture({ analysisProtocol: 'google', analysisEndpoint, analysisAutoComplete: false });
    await manual.execute();
    assert.equal(manual.analysisRequests[0].url, analysisEndpoint);
    assert.equal(manual.analysisRequests[0].headers['x-goog-api-key'], 'vision-key');

    const explicitUrl = `${analysisEndpoint}?key=explicit-key`;
    const explicit = createRetouchFixture({ analysisProtocol: 'google', analysisEndpoint: explicitUrl, analysisAutoComplete: false });
    await explicit.execute();
    assert.equal(explicit.analysisRequests[0].url, explicitUrl);
    assert.equal(explicit.analysisRequests[0].headers['x-goog-api-key'], undefined);
    assert.doesNotMatch(JSON.stringify(explicit.logs), /explicit-key/);
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

test('product retouch keeps the latest analysis and last saved comparison when editing fails', async () => {
    const { node, execute, assets, released, getOutput, setOnSave, setResponseData, setAnalyze } = createRetouchFixture();
    await execute();

    setAnalyze(() => '{"adjustments":[{"area":"杯底","edit":"清除浮尘"}]}');
    setResponseData('');
    await assert.rejects(execute(), /API 未返回图片数据/);
    assert.equal(getOutput(), finished);
    assert.deepEqual(node.data.productRetouchComparison, comparison);
    assert.deepEqual(node.data.productRetouchAnalysis, { prompt: '杯底：清除浮尘' });
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
