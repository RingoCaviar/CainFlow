import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import '../js/features/execution/protocols/google.js';
import '../js/features/execution/protocols/openai.js';
import '../js/features/execution/protocols/ttapi-openai.js';

const reference = 'data:image/png;base64,AAAA';
const nextReference = 'data:image/png;base64,AgAA';
const roles = ['angle', 'detail', 'feature', 'scene', 'included'];

function createCommerceExecutionFixture({ failedRole, selectedShotIds = ['main', ...roles], beforeImageRequest, beforePlanRequest,
    galleryAspect, imageModel = 'gemini-2.5-flash-image', imageProtocol = 'google', responseImageData } = {}) {
    const node = { id: 'commerce', type: 'ECommerceImageSet', data: { commerceImageSet: {
        platformId: 'amazon', productNotes: '杯盖可拆卸', plannerModelId: 'vision', plannerProviderId: 'provider',
        imageModelId: 'image', imageProviderId: 'provider', selectedShotIds, galleryAspect
    } } };
    const apiCalls = [];
    const imagePrompts = new Map();
    const history = [];
    const assets = new Map();
    const noop = () => {};
    const core = createExecutionCoreApi({
        state: {
            nodes: new Map([[node.id, node]]), connections: [],
            models: [
                { id: 'vision', name: 'Vision', modelId: 'gemini-2.5-flash', taskType: 'chat', protocol: 'google', providerIds: ['provider'] },
                { id: 'image', name: 'Image', modelId: imageModel, taskType: 'image', protocol: imageProtocol, providerIds: ['provider'] }
            ],
            providers: [{ id: 'provider', endpoint: 'https://fixture.test', apikey: 'fixture-key' }]
        },
        nodeConfigs: {}, documentRef: { getElementById: () => null }, windowRef: { requestAnimationFrame: noop },
        dataURLtoBlob: source => new Blob([Buffer.from(source.split(',')[1], 'base64')], { type: 'image/png' }),
        getProxyHeaders: () => ({}), showToast: noop, addLog: noop, logRequestToPanel: noop, showResolutionBadge: noop,
        getActiveWorkflowId: () => 'workflow', getImageAsset: async key => assets.get(key),
        saveHistoryEntry: async entry => { history.push(entry); return true; },
        saveWorkflowNodeMediaAssets: async images => images.map(image => {
            const asset_key = `media:${Buffer.from(image.split(',')[1], 'base64').toString('hex')}`;
            assets.set(asset_key, image);
            return { asset_key };
        }),
        fetchRef: async (url, { body, signal }) => {
            assert.equal(url, '/proxy');
            const multipart = body instanceof FormData;
            const request = multipart ? null : JSON.parse(body);
            const parts = request?.contents[0].parts || [];
            const images = parts.filter(part => part.inlineData).map(part => part.inlineData.data);
            if (request?.systemInstruction) {
                apiCalls.push({ type: 'plan', images });
                const input = JSON.parse(parts.find(part => part.text).text);
                const output = await beforePlanRequest?.(input, signal) || {
                    sellingPoints: ['可拆卸杯盖'], shots: selectedShotIds.filter(id => id !== 'main').map(id => ({
                        id, prompt: `${id}\n商品位于画面右侧，左上角留给文字，柔和侧光，温暖米色摄影风格。`, headline: '规划草稿', body: '规划正文'
                    }))
                };
                return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] });
            }
            const prompt = multipart ? body.get('prompt') : parts[0].text;
            const role = prompt.match(/^画面设计：(\S+)$/m)?.[1];
            imagePrompts.set(role, prompt);
            apiCalls.push({ type: 'image', role, images, ...(multipart ? { size: body.get('size') } : {}) });
            await beforeImageRequest?.(role, signal);
            if (role === failedRole) return Response.json({ candidates: [{ content: { parts: [{ text: 'No image' }] } }] });
            const data = responseImageData?.(role) || Buffer.from([roles.indexOf(role) + 1]).toString('base64');
            if (multipart) return Response.json({ data: [{ b64_json: data }] });
            return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data } }] } }] });
        }
    });
    const execute = (action, image = reference, commerceShotId, signal = new AbortController().signal) => core.executeNode(
        node, { referenceImages: [image] }, signal, { commerceAction: action, commerceShotId });
    return { node, execute, normalizeRunOptions: core.normalizeRunOptions, apiCalls, imagePrompts, history, assets,
        setFailure: role => { failedRole = role; }, clearFailure: () => { failedRole = undefined; } };
}

test('commerce planning requires confirmation and unchanged original references before any images are generated', async () => {
    const { node, execute, apiCalls, history, assets } = createCommerceExecutionFixture();
    await execute('plan');
    assert.deepEqual(apiCalls, [{ type: 'plan', images: ['AAAA'] }]);
    assert.deepEqual(node.data.commerceImageSet.plan.sellingPoints, ['可拆卸杯盖']);
    assert.equal(node.data.commerceImageSet.plan.confirmed, false);
    await assert.rejects(execute('generate'), /确认方案/);
    node.data.commerceImageSet.plan.confirmed = true;
    await assert.rejects(execute('generate', nextReference), /参考图.*改变/);
    assert.equal(apiCalls.length, 1);

    const output = await execute('generate');
    assert.deepEqual(apiCalls.slice(1), roles.map(role => ({ type: 'image', role, images: ['AAAA'] })));
    assert.equal(output.image[0], reference);
    assert.equal(history.length, 6);
    assert.deepEqual(node.data.commerceImageSet.results.map(row => row.shotId), ['main', ...roles]);
    assert.deepEqual(node.data.mediaAssetKeys, node.data.commerceImageSet.results.map(row => row.assetKey));
    assert.deepEqual(node.data.mediaAssetKeys.map(key => assets.get(key)), output.image);
});

test('retrying one failed commerce shot keeps all previously saved images in platform order', async () => {
    const selectedShotIds = ['main', 'angle', 'detail', 'scene'];
    const { node, execute, apiCalls, history, clearFailure } = createCommerceExecutionFixture({ failedRole: 'detail', selectedShotIds });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    const partial = await execute('generate');
    assert.equal(partial.image.length, 3);
    assert.equal(node.data.commerceImageSet.results.find(row => row.shotId === 'detail').status, 'failed');
    clearFailure();
    const callCount = apiCalls.length;
    const complete = await execute('retry', reference, 'detail');
    assert.deepEqual(apiCalls.slice(callCount), [{ type: 'image', role: 'detail', images: ['AAAA'] }]);
    assert.equal(history.length, 4);
    assert.deepEqual(complete.image.filter((_, index) => index !== 2), partial.image);
    assert.ok(node.data.commerceImageSet.results.every(row => row.status === 'completed'));
    assert.deepEqual(node.data.commerceImageSet.results.map(row => row.shotId), selectedShotIds);
});

test('replanning a commerce shot changes only its draft and preserves existing images and shared selling points', async () => {
    const { node, execute, normalizeRunOptions, apiCalls, history } = createCommerceExecutionFixture({
        selectedShotIds: ['main', 'detail', 'scene'], beforePlanRequest(input) {
            if (input.shots.length !== 1) return;
            assert.deepEqual(input.shots.map(shot => shot.id), ['scene']);
            assert.deepEqual(input.sellingPoints, ['可拆卸杯盖']);
            assert.equal(input.currentShot.headline, '规划草稿');
            return { sellingPoints: ['不应更新的卖点'], shots: [{ id: 'scene', prompt: '窗边自然光，桌面场景。', headline: '清晨一杯', body: '自然光下展示杯身' }] };
        }
    });
    const options = normalizeRunOptions({ mode: 'selected-only', selectedNodeIds: [node.id],
        commerceNodeId: node.id, commerceAction: 'replan-shot', commerceShotId: 'scene' });
    assert.equal(options.commerceAction, 'replan-shot');
    assert.equal(options.commerceShotId, 'scene');
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    const priorPlan = structuredClone(node.data.commerceImageSet.plan);
    const priorResults = structuredClone(node.data.commerceImageSet.results);
    const priorKeys = node.data.mediaAssetKeys.slice();
    const requestCount = apiCalls.length;
    const historyCount = history.length;

    await execute('replan-shot', reference, 'scene');
    const { plan, results } = node.data.commerceImageSet;
    assert.deepEqual(apiCalls.slice(requestCount), [{ type: 'plan', images: ['AAAA'] }]);
    assert.deepEqual(plan, { ...priorPlan, confirmed: false, shots: [
        ...priorPlan.shots.slice(0, -1), { ...priorPlan.shots.at(-1),
            prompt: '窗边自然光，桌面场景。', headline: '清晨一杯', body: '自然光下展示杯身' }
    ] });
    assert.deepEqual(results, priorResults);
    assert.deepEqual(node.data.mediaAssetKeys, priorKeys);
    assert.equal(history.length, historyCount);
});

test('replanning validates its target and source and preserves the draft when canceled or when the response is invalid', async () => {
    const controller = new AbortController();
    const { node, execute, apiCalls } = createCommerceExecutionFixture({
        selectedShotIds: ['main', 'angle', 'detail'], beforePlanRequest(input, signal) {
            if (input.shots.length !== 1) return;
            if (signal === controller.signal) controller.abort();
            return { sellingPoints: [], shots: [{ id: 'angle', prompt: '错误图位' }] };
        }
    });
    await execute('plan');
    const prior = structuredClone(node.data.commerceImageSet);
    for (const invalidId of [undefined, 'main', 'absent']) {
        await assert.rejects(execute('replan-shot', reference, invalidId), /图位/);
    }
    await assert.rejects(execute('replan-shot', nextReference, 'detail'), /参考图.*改变/);
    assert.equal(apiCalls.length, 1);
    await assert.rejects(execute('replan-shot', reference, 'detail'), /未知图位/);
    await assert.rejects(execute('replan-shot', reference, 'detail', controller.signal), { name: 'AbortError' });
    assert.deepEqual(node.data.commerceImageSet, prior);
});

test('regenerating a completed commerce shot replaces only its own image after a successful retry', async () => {
    const waiting = Promise.withResolvers();
    let interruptRetry = false;
    let regenerate = false;
    const changedArtwork = 'data:image/png;base64,AwAA';
    const { node, execute, apiCalls, imagePrompts, history, setFailure, clearFailure } = createCommerceExecutionFixture({
        selectedShotIds: ['main', 'angle', 'detail'],
        responseImageData: role => regenerate && role === 'detail' ? changedArtwork.split(',')[1] : undefined,
        beforeImageRequest: async (role, signal) => {
            if (!interruptRetry || role !== 'detail') return;
            waiting.resolve();
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
    });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    const original = await execute('generate');
    const originalKeys = node.data.mediaAssetKeys.slice();
    const originalResults = structuredClone(node.data.commerceImageSet.results);
    const callCount = apiCalls.length;

    setFailure('detail');
    await assert.rejects(execute('retry', reference, 'detail'));
    assert.deepEqual(node.data.mediaAssetKeys, originalKeys);
    assert.deepEqual(node.data.commerceImageSet.results, originalResults);
    assert.equal(history.length, 3);

    clearFailure();
    interruptRetry = true;
    const controller = new AbortController();
    const retry = execute('retry', reference, 'detail', controller.signal);
    try {
        await Promise.race([waiting.promise, retry]);
        assert.deepEqual(node.apiGenerationProgress, { completed: 0, total: 1 });
        assert.deepEqual(node.commerceShotPreviews, { detail: { status: 'running' } });
        assert.deepEqual(node.data.commerceImageSet.results, originalResults);
    } finally {
        controller.abort();
        await assert.rejects(retry, { name: 'AbortError' });
    }
    assert.deepEqual(node.data.mediaAssetKeys, originalKeys);
    assert.deepEqual(node.data.commerceImageSet.results, originalResults);
    assert.equal(history.length, 3);

    interruptRetry = false;
    regenerate = true;
    const { plan } = node.data.commerceImageSet;
    plan.confirmed = false;
    plan.shots.find(shot => shot.id === 'detail').headline = '新的标题';
    const updated = await execute('retry', reference, 'detail');
    assert.deepEqual(apiCalls.slice(callCount).map(call => call.role), ['detail', 'detail', 'detail']);
    assert.deepEqual(updated.images, [original.images[0], original.images[1], changedArtwork]);
    assert.match(imagePrompts.get('detail'), /新的标题/);
    assert.equal(node.data.mediaAssetKeys[0], originalKeys[0]);
    assert.equal(node.data.mediaAssetKeys[1], originalKeys[1]);
    assert.deepEqual(node.data.commerceImageSet.results.map(row => row.shotId), ['main', 'angle', 'detail']);
    assert.equal(history.length, 4);
});

test('a pending commerce shot can be generated individually and leaves the other slots pending', async () => {
    const { node, execute, apiCalls, history } = createCommerceExecutionFixture({ selectedShotIds: ['main', 'angle', 'detail'] });
    await execute('plan');
    const output = await execute('retry', reference, 'detail');
    assert.deepEqual(apiCalls.slice(1).map(call => call.role), ['detail']);
    assert.equal(output.images.length, 1);
    assert.deepEqual(node.data.commerceImageSet.results.map(row => row.shotId), ['detail']);
    assert.equal(history.length, 1);
    assert.equal(node.data.commerceImageSet.plan.confirmed, false);
    await assert.rejects(execute('generate'), /确认方案/);
});

test('commerce retry reports a missing sibling asset before generating or changing saved results', async () => {
    const { node, execute, apiCalls, assets } = createCommerceExecutionFixture({ selectedShotIds: ['main', 'angle', 'detail'] });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    const originalKeys = node.data.mediaAssetKeys.slice();
    const originalResults = structuredClone(node.data.commerceImageSet.results);
    assets.delete(originalKeys[2]);
    const callCount = apiCalls.length;
    await assert.rejects(execute('retry', reference, 'angle'), /已保存/);
    assert.equal(apiCalls.length, callCount);
    assert.deepEqual(node.data.mediaAssetKeys, originalKeys);
    assert.deepEqual(node.data.commerceImageSet.results, originalResults);
});

test('a selected original-only commerce set publishes the original without a generation provider', async () => {
    const { node, execute, apiCalls, history } = createCommerceExecutionFixture({ selectedShotIds: ['main'] });
    node.data.commerceImageSet.imageModelId = '';
    node.data.commerceImageSet.imageProviderId = '';
    await execute('plan');
    await assert.rejects(execute('retry', reference, 'main'), /需要生图/);
    node.data.commerceImageSet.plan.confirmed = true;
    const output = await execute('generate');
    assert.deepEqual(apiCalls, [{ type: 'plan', images: ['AAAA'] }]);
    assert.deepEqual(output.image, [reference]);
    assert.deepEqual(node.data.commerceImageSet.results, [{ shotId: 'main', status: 'completed', assetKey: node.data.mediaAssetKeys[0] }]);
    assert.equal(history.length, 1);
});

test('commerce sends approved copy and layout to the image model and saves the response as returned', async () => {
    const { node, execute, imagePrompts, history } = createCommerceExecutionFixture({ selectedShotIds: ['angle', 'detail'] });
    await execute('plan');
    const plan = node.data.commerceImageSet.plan;
    Object.assign(plan.shots.find(shot => shot.id === 'detail'), { headline: '旋开即可清洗', body: '杯盖可拆卸' });
    plan.confirmed = true;

    const output = await execute('generate');
    assert.match(imagePrompts.get('detail'), /左上角.*柔和侧光.*米色摄影风格/);
    assert.ok(imagePrompts.get('detail').includes('旋开即可清洗'));
    assert.ok(imagePrompts.get('detail').includes('杯盖可拆卸'));
    assert.doesNotMatch(imagePrompts.get('detail'), /规划草稿|规划正文/);
    assert.doesNotMatch(imagePrompts.get('angle'), /旋开即可清洗|规划草稿|规划正文/);
    assert.deepEqual(output.images, ['data:image/png;base64,AQ==', 'data:image/png;base64,Ag==']);
    assert.deepEqual(history.map(entry => entry.image), output.images);
});

test('commerce rejects a model that cannot produce the selected ratio before requesting images', async () => {
    for (const imageProtocol of ['openai', 'ttapi-openai']) {
        const { node, execute, apiCalls } = createCommerceExecutionFixture({
            selectedShotIds: ['main', 'detail-overview'], imageModel: 'gpt-image-1', imageProtocol
        });
        await execute('plan');
        node.data.commerceImageSet.plan.confirmed = true;
        await assert.rejects(execute('generate'), /不支持直接生成.*9:16/, imageProtocol);
        assert.deepEqual(apiCalls, [{ type: 'plan', images: ['AAAA'] }], imageProtocol);
    }
});

test('commerce requests exact 4:5 dimensions from a flexible image model', async () => {
    const { node, execute, apiCalls } = createCommerceExecutionFixture({
        selectedShotIds: ['detail'], galleryAspect: '4:5', imageModel: 'gpt-image-2', imageProtocol: 'openai'
    });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    assert.equal(apiCalls[1].size, '832x1040');
});

test('commerce shows model results and failure rows before the remaining image finishes', async () => {
    const waiting = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const finishedArtwork = 'data:image/png;base64,AgAA';
    const { node, execute, history } = createCommerceExecutionFixture({
        selectedShotIds: ['main', 'angle', 'detail', 'scene'], failedRole: 'detail',
        beforeImageRequest: async role => {
            if (role !== 'scene') return;
            waiting.resolve();
            await finish.promise;
        },
        responseImageData: role => role === 'angle' ? finishedArtwork.split(',')[1] : undefined
    });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    const generation = execute('generate');
    try {
        await Promise.race([waiting.promise, generation]);
        assert.deepEqual(node.commerceShotPreviews.main, { status: 'completed', image: reference });
        assert.deepEqual(node.commerceShotPreviews.angle, { status: 'completed', image: finishedArtwork });
        assert.equal(node.commerceShotPreviews.detail.status, 'failed');
        assert.equal(node.commerceShotPreviews.scene.status, 'running');
        assert.deepEqual(node.data.commerceImageSet.results, []);
        assert.deepEqual(history.map(entry => entry.image), [reference, finishedArtwork]);
    } finally {
        finish.resolve();
        await generation;
    }
    assert.equal(node.commerceShotPreviews, undefined);
    assert.equal(node.data.commerceImageSet.results.find(row => row.shotId === 'angle').assetKey, 'media:020000');
});

test('stopping during progressive commerce generation retains the prior workflow output and archived completed images', async () => {
    const waiting = Promise.withResolvers();
    let interruptAttempt = false;
    const changedArtwork = 'data:image/png;base64,AwAA';
    const { node, execute, apiCalls, history } = createCommerceExecutionFixture({
        selectedShotIds: ['main', 'angle', 'detail', 'scene'],
        beforeImageRequest: (role, signal) => {
            if (!interruptAttempt || role !== 'detail') return;
            waiting.resolve();
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        },
        responseImageData: role => interruptAttempt && role === 'angle' ? changedArtwork.split(',')[1] : undefined
    });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    const priorKeys = node.data.mediaAssetKeys.slice();
    const priorResults = structuredClone(node.data.commerceImageSet.results);
    const callCount = apiCalls.length;
    interruptAttempt = true;
    const controller = new AbortController();
    const generation = execute('generate', reference, undefined, controller.signal);
    try {
        await Promise.race([waiting.promise, generation]);
        assert.equal(node.commerceShotPreviews.angle.image, changedArtwork);
    } finally {
        controller.abort();
        await assert.rejects(generation, { name: 'AbortError' });
    }
    assert.deepEqual(apiCalls.slice(callCount).map(call => call.role), ['angle', 'detail']);
    assert.deepEqual(node.data.mediaAssetKeys, priorKeys);
    assert.deepEqual(node.data.commerceImageSet.results, priorResults);
    assert.equal(node.commerceShotPreviews, undefined);
    assert.equal(history.at(-1).image, changedArtwork);
});
