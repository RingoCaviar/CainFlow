import assert from 'node:assert/strict';
import { normalizeCommerceImageSetState, updateCommerceImageSetCopyLanguage, updateCommerceProductInfoField } from '../js/features/ecommerce-image-set/commerce-image-set-plan.js';
import test from 'node:test';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import '../js/features/execution/protocols/google.js';
import '../js/features/execution/protocols/openai.js';
import '../js/features/execution/protocols/ttapi-openai.js';

const reference = 'data:image/png;base64,AAAA';
const nextReference = 'data:image/png;base64,AgAA';
const roles = ['angle', 'detail', 'feature', 'scene', 'included'];

function createCommerceExecutionFixture({ failedRole, selectedShotIds = ['main', ...roles], beforeImageRequest, beforePlanRequest,
    galleryAspect, imageModel = 'gemini-2.5-flash-image', imageProtocol = 'google', responseImageData, referenceImageCatalog } = {}) {
    const node = { id: 'commerce', type: 'ECommerceImageSet', data: { commerceImageSet: {
        platformId: 'amazon', productNotes: '杯盖可拆卸', plannerModelId: 'vision', plannerProviderId: 'provider',
        imageModelId: 'image', imageProviderId: 'provider', selectedShotIds, galleryAspect
    } } };
    const apiCalls = [];
    const requestLogs = [];
    const requestStatistics = [];
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
        referenceImageCatalog,
        nodeConfigs: {}, documentRef: { getElementById: () => null }, windowRef: { requestAnimationFrame: noop },
        dataURLtoBlob: source => new Blob([Buffer.from(source.split(',')[1], 'base64')], { type: 'image/png' }),
        getProxyHeaders: () => ({}), showToast: noop, addLog: noop, showResolutionBadge: noop,
        logRequestToPanel: (title, url, requestBody, details) => {
            const entry = { title, url, requestBody, ...details };
            requestLogs.push(entry);
            assert.equal(entry.requestStatus, 'pending');
            return (requestStatus, result) => {
                assert.equal(entry.requestStatus, 'pending', 'a request entry settles once');
                Object.assign(entry, { requestStatus }, result);
            };
        },
        recordNodeRequest: record => requestStatistics.push(record),
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
                if (output instanceof Response) return output;
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
    return { node, execute, normalizeRunOptions: core.normalizeRunOptions, apiCalls, requestLogs, requestStatistics, imagePrompts, history, assets,
        setFailure: role => { failedRole = role; }, clearFailure: () => { failedRole = undefined; } };
}

test('commerce shot mentions attach a scene image only to the selected shot', async () => {
    const { node, execute, apiCalls, imagePrompts } = createCommerceExecutionFixture({
        selectedShotIds: ['detail', 'scene'],
        referenceImageCatalog: { readImage: async source => source.historyId === '1' ? nextReference : '' }
    });
    await execute('plan');
    node.data.imagePromptMentions = [{ token: '@图片1', source: { id: 'history:1', historyId: '1', name: '细节素材' } }];
    node.data.commerceImageSet.plan.shots.find(shot => shot.id === 'detail').prompt += '使用 @图片1。';
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    assert.deepEqual(apiCalls.filter(call => call.type === 'image').map(call => call.images), [['AAAA', 'AgAA'], ['AAAA']]);
    assert.match(imagePrompts.get('detail'), /使用 参考图 2。/);
    assert.doesNotMatch(imagePrompts.get('scene'), /参考图 2/);
});

test('commerce logs every planner and image request with its operation and outcome', async () => {
    const { node, execute, apiCalls, requestLogs, requestStatistics, clearFailure } = createCommerceExecutionFixture({
        selectedShotIds: ['main', 'detail', 'scene'], failedRole: 'detail',
        beforePlanRequest: input => input.currentShot
            ? Response.json({ error: 'Planner rejected the request' }, { status: 429 }) : undefined
    });
    await execute('plan');
    await assert.rejects(execute('replan-shot', reference, 'scene'), /HTTP 429/);
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    clearFailure();
    await execute('retry', reference, 'detail');

    assert.equal(requestLogs.length, apiCalls.length);
    assert.deepEqual(requestLogs.map(log => [log.operation, log.shotId, log.requestStatus]), [
        ['plan', undefined, 'success'], ['replan-shot', 'scene', 'failed'],
        ['generate', 'detail', 'failed'], ['generate', 'scene', 'success'], ['retry', 'detail', 'success']
    ]);
    assert.ok(requestLogs.every(log => log.nodeType === 'ECommerceImageSet' && log.nodeId === node.id && log.requestBody));
    assert.equal(requestLogs[1].status, 429);
    assert.match(requestLogs[1].error, /HTTP 429/);
    assert.ok(requestLogs[2].error, 'a response without a usable image has a failure message');
    assert.deepEqual(requestStatistics.map(record => record.success), [true, false, false, true, true]);
    assert.equal(requestStatistics[1].status, 429);
    assert.ok(requestStatistics.every(record => record.nodeType === 'ECommerceImageSet' && !record.url.includes('fixture-key')));
});

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

test('product analysis refreshes AI fields, preserves explicit edits, and supplies the resulting product information to the image model', async () => {
    const { node, execute, normalizeRunOptions, requestLogs, imagePrompts } = createCommerceExecutionFixture({
        selectedShotIds: ['detail'],
        beforePlanRequest(input) {
            const planning = Boolean(input.shots);
            assert.equal(input.productInfo.details, '杯盖可拆卸');
            assert.equal(input.productInfo.name, planning ? '旅行杯' : '');
            assert.deepEqual(input.productInfo.sellingPoints, planning ? ['杯盖开合方便'] : []);
            assert.equal(input.productInfo.audience, '');
            return { productInfo: {
                name: '杯子', sellingPoints: ['杯口宽', '杯口宽'], audience: planning ? '办公族' : '通勤者',
                useCases: planning ? '办公桌饮水' : '随身饮水', details: '模型推测的材质'
            }, ...(planning ? { shots: [{ id: 'detail', prompt: '突出杯盖的结构和开合。' }] } : {}) };
        }
    });
    const analyzeOptions = { mode: 'selected-only', selectedNodeIds: [node.id], commerceNodeId: node.id, commerceAction: 'analyze' };
    assert.equal(normalizeRunOptions(analyzeOptions).commerceAction, 'analyze');
    assert.throws(() => normalizeRunOptions({ ...analyzeOptions, mode: 'full' }), /请选择一个.*节点/);
    await execute('analyze');
    let info = node.data.commerceImageSet;
    assert.deepEqual(info.productInfo, { name: '杯子', sellingPoints: ['杯口宽'], audience: '通勤者', useCases: '随身饮水', details: '杯盖可拆卸' });
    assert.equal(info.plan, null);

    updateCommerceProductInfoField(info, 'name', '旅行杯');
    updateCommerceProductInfoField(info, 'sellingPoints', ['杯盖开合方便']);
    node.data.commerceImageSet = normalizeCommerceImageSetState(JSON.parse(JSON.stringify(info)));
    await execute('plan', nextReference);
    info = node.data.commerceImageSet;
    assert.deepEqual(info.productInfo, { name: '旅行杯', sellingPoints: ['杯盖开合方便'],
        audience: '办公族', useCases: '办公桌饮水', details: '杯盖可拆卸' });
    assert.deepEqual(info.plan.sellingPoints, info.productInfo.sellingPoints);
    assert.deepEqual(requestLogs.map(log => log.operation), ['analyze', 'plan']);
    info.plan.confirmed = true;
    await execute('generate', nextReference);
    assert.match(imagePrompts.get('突出杯盖的结构和开合。'), /商品名称：旅行杯[\s\S]*办公族[\s\S]*办公桌饮水[\s\S]*杯盖开合方便/);

    info = node.data.commerceImageSet;
    const sourceKey = info.plan.sourceKey;
    const images = structuredClone(info.results);
    updateCommerceProductInfoField(info, 'sellingPoints', ['宽口易清洁']);
    assert.deepEqual(info.plan.sellingPoints, ['宽口易清洁']);
    assert.equal(info.plan.sourceKey, sourceKey);
    assert.equal(info.plan.stale, undefined);

    updateCommerceProductInfoField(info, 'audience', '露营人群');
    const saved = normalizeCommerceImageSetState(JSON.parse(JSON.stringify(info)));
    assert.equal(saved.plan.stale, true);
    assert.equal(saved.plan.confirmed, false);
    assert.deepEqual(saved.results, images);
    await assert.rejects(execute('retry', nextReference, 'detail'), /重新规划/);
});

test('changing the copy language keeps the previous images and blocks an old plan from running', async () => {
    const { node, execute, apiCalls } = createCommerceExecutionFixture({ selectedShotIds: ['detail'] });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    const savedOutput = structuredClone(node.data.commerceImageSet.results);
    assert.equal(savedOutput[0].status, 'completed');
    const requestCount = apiCalls.length;

    assert.equal(updateCommerceImageSetCopyLanguage(node.data.commerceImageSet, 'ja'), true);
    await assert.rejects(execute('generate'), /生成设置已改变.*重新规划/);
    await assert.rejects(execute('retry', reference, 'detail'), /重新规划/);
    await assert.rejects(execute('replan-shot', reference, 'detail'), /重新规划整套/);
    assert.equal(apiCalls.length, requestCount);
    assert.deepEqual(node.data.commerceImageSet.results, savedOutput);
});

test('failed, aborted, and superseded analysis leaves the previous product and image results intact', async () => {
    let response = { productInfo: { name: '圆口杯', sellingPoints: ['宽口'] } };
    let afterRequest;
    const { node, execute, requestLogs } = createCommerceExecutionFixture({
        selectedShotIds: ['main'],
        beforePlanRequest(input, signal) {
            if (input.shots) return { ...response, shots: [] };
            afterRequest?.(signal);
            return response;
        }
    });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    const prior = structuredClone(node.data.commerceImageSet);

    response = { productInfo: { ignored: true } };
    await assert.rejects(execute('analyze'), /没有有效的商品信息|未返回有效的商品信息/);
    assert.deepEqual(node.data.commerceImageSet, prior);
    response = { productInfo: { name: '另一款商品', sellingPoints: ['防滑外观'] } };
    const controller = new AbortController();
    afterRequest = () => controller.abort();
    await assert.rejects(execute('analyze', reference, undefined, controller.signal), { name: 'AbortError' });
    assert.deepEqual(node.data.commerceImageSet, prior);
    assert.deepEqual(requestLogs.slice(-2).map(log => log.requestStatus), ['failed', 'canceled']);

    afterRequest = () => updateCommerceProductInfoField(node.data.commerceImageSet, 'name', '用户的新商品名');
    await assert.rejects(execute('analyze'), /设置已改变/);
    assert.equal(node.data.commerceImageSet.productInfo.name, '用户的新商品名');
    assert.deepEqual(node.data.commerceImageSet.results, prior.results);
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
    let abortRequest = false;
    const { node, execute, apiCalls } = createCommerceExecutionFixture({
        selectedShotIds: ['main', 'angle', 'detail'], beforePlanRequest(input) {
            if (input.shots.length !== 1) return;
            if (abortRequest) controller.abort();
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
    abortRequest = true;
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
    const { node, execute, apiCalls, history, normalizeRunOptions } = createCommerceExecutionFixture({ selectedShotIds: ['main', 'angle', 'detail'] });
    const runOptions = { mode: 'selected-only', selectedNodeIds: [node.id], commerceNodeId: node.id, commerceAction: 'retry' };
    assert.throws(() => normalizeRunOptions(runOptions), /需要生图的图位/);
    assert.equal(normalizeRunOptions({ ...runOptions, commerceShotId: 'detail' }).commerceShotId, 'detail');
    await execute('plan');
    const output = await execute('retry', reference, 'detail');
    assert.deepEqual(apiCalls.slice(1).map(call => call.role), ['detail']);
    assert.equal(output.images.length, 1);
    assert.deepEqual(node.data.commerceImageSet.results.map(row => row.shotId), ['detail']);
    assert.equal(history.length, 1);
    assert.equal(node.data.commerceImageSet.plan.confirmed, false);
    await assert.rejects(execute('generate'), /确认方案/);
});

test('an empty commerce prompt blocks only generation that includes that shot', async () => {
    const { node, execute, apiCalls } = createCommerceExecutionFixture({ selectedShotIds: ['angle', 'detail'] });
    await execute('plan');
    const state = node.data.commerceImageSet;
    state.plan.shots.find(shot => shot.id === 'detail').prompt = '';

    await assert.rejects(execute('retry', reference, 'detail'), /缺少.*生图提示词/);
    assert.equal(apiCalls.length, 1);
    await execute('retry', reference, 'angle');
    assert.deepEqual(apiCalls.slice(1).map(call => call.role), ['angle']);
    assert.equal(node.data.commerceImageSet.plan.shots.find(shot => shot.id === 'detail').prompt, '');
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
    const { node, execute, apiCalls, history, requestLogs } = createCommerceExecutionFixture({
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
        assert.equal(requestLogs.at(-1).requestStatus, 'pending');
    } finally {
        controller.abort();
        await assert.rejects(generation, { name: 'AbortError' });
    }
    assert.deepEqual(apiCalls.slice(callCount).map(call => call.role), ['angle', 'detail']);
    assert.deepEqual(requestLogs.slice(callCount).map(log => log.requestStatus), ['success', 'canceled']);
    assert.deepEqual(node.data.mediaAssetKeys, priorKeys);
    assert.deepEqual(node.data.commerceImageSet.results, priorResults);
    assert.equal(node.commerceShotPreviews, undefined);
    assert.equal(history.at(-1).image, changedArtwork);
});

test('commerce shot requests can overlap and completing one preserves the other shot outputs and drafts', async () => {
    const firstStarted = Promise.withResolvers();
    const finishFirst = Promise.withResolvers();
    const { node, execute, apiCalls } = createCommerceExecutionFixture({
        selectedShotIds: ['angle', 'detail', 'scene'],
        async beforeImageRequest(role) {
            if (role !== 'detail') return;
            firstStarted.resolve();
            await finishFirst.promise;
        },
        beforePlanRequest(input) {
            if (input.currentShot) return { shots: [{ id: 'scene', prompt: '清晨窗边一杯茶' }] };
        }
    });
    await execute('plan');
    const first = execute('retry', reference, 'detail');
    try {
        await Promise.race([firstStarted.promise, first]);
        await execute('retry', reference, 'angle');
        await execute('replan-shot', reference, 'scene');
        assert.equal(node.commerceShotPreviews.detail.status, 'running');
    } finally {
        finishFirst.resolve();
        await first;
    }
    assert.deepEqual(apiCalls.slice(1, 3).map(call => call.role), ['detail', 'angle']);
    assert.deepEqual(node.data.commerceImageSet.results.map(row => row.shotId), ['angle', 'detail']);
    assert.equal(node.data.commerceImageSet.plan.shots.find(shot => shot.id === 'scene').prompt, '清晨窗边一杯茶');
});

test('canceling an individual commerce generation aborts its request and leaves the sibling available', async () => {
    const started = Promise.withResolvers();
    let waitForCancellation = true;
    const { node, execute, requestLogs } = createCommerceExecutionFixture({
        selectedShotIds: ['angle', 'detail'],
        beforeImageRequest(role, signal) {
            if (role !== 'detail' || !waitForCancellation) return;
            started.resolve();
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
    });
    await execute('plan');
    const controller = new AbortController();
    const generation = execute('retry', reference, 'detail', controller.signal);
    try {
        await Promise.race([started.promise, generation]);
        await execute('retry', reference, 'angle');
        assert.equal(node.commerceShotCancelHandlers?.get('detail')?.(), true);
        await assert.rejects(generation, { name: 'AbortError' });
        assert.equal(requestLogs.find(log => log.operation === 'retry' && log.shotId === 'detail')?.requestStatus, 'canceled');
        assert.deepEqual(node.data.commerceImageSet.results.map(({ shotId, status }) => [shotId, status]),
            [['angle', 'completed'], ['detail', 'canceled']]);
    } finally {
        controller.abort();
        await assert.rejects(generation, { name: 'AbortError' });
    }
    waitForCancellation = false;
    await execute('retry', reference, 'detail');
    assert.ok(node.data.commerceImageSet.results.every(row => row.status === 'completed'));
});

test('canceling one batch shot and rerunning a finished shot can leave the remaining batch intact', async () => {
    const detailStarted = Promise.withResolvers();
    let angleAttempt = 0;
    const { node, execute, apiCalls } = createCommerceExecutionFixture({
        selectedShotIds: ['main', 'angle', 'detail', 'scene'],
        responseImageData: role => role === 'angle' ? (++angleAttempt === 1 ? 'AgAA' : 'AwAA') : undefined,
        beforeImageRequest(role, signal) {
            if (role !== 'detail') return;
            detailStarted.resolve();
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
    });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    const controller = new AbortController();
    const batch = execute('generate', reference, undefined, controller.signal);
    try {
        await Promise.race([detailStarted.promise, batch]);
        await execute('retry', reference, 'angle');
        assert.equal(node.commerceShotCancelHandlers?.get('detail')?.(), true);
        await batch;
        assert.deepEqual(apiCalls.slice(1).map(call => call.role), ['angle', 'detail', 'angle', 'scene']);
        assert.deepEqual(node.data.commerceImageSet.results.map(({ shotId, status }) => [shotId, status]),
            [['main', 'completed'], ['angle', 'completed'], ['detail', 'canceled'], ['scene', 'completed']]);
        assert.equal(node.data.commerceImageSet.results[1].assetKey, 'media:030000');
    } finally {
        controller.abort();
        await batch.catch(() => {});
    }
});
