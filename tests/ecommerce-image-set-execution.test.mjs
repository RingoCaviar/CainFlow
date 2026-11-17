import assert from 'node:assert/strict';
import {
    appendCommerceSceneShot, confirmCommerceSceneShot, getCommerceShotCandidates, isCommerceShotImageStale,
    normalizeCommerceImageSetState, updateCommerceImageSetCopyLanguage, updateCommerceProductInfoField
} from '../js/features/ecommerce-image-set/commerce-image-set-plan.js';
import test from 'node:test';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import '../js/features/execution/protocols/google.js';
import '../js/features/execution/protocols/openai.js';
import '../js/features/execution/protocols/ttapi-openai.js';

const reference = 'data:image/png;base64,AAAA';
const nextReference = 'data:image/png;base64,AgAA';
const roles = ['angle', 'detail', 'feature', 'scene', 'included'];

function createCommerceExecutionFixture({ failedRole, selectedShotIds = ['main', ...roles], beforeImageRequest, beforePlanRequest,
    galleryAspect, imageModel = 'gemini-2.5-flash-image', imageProtocol = 'google', responseImageData,
    referenceImageCatalog, syncImagePreviewNode, visualStyle } = {}) {
    const node = { id: 'commerce', type: 'ECommerceImageSet', data: { commerceImageSet: {
        platformId: 'amazon', productNotes: '杯盖可拆卸', plannerModelId: 'vision', plannerProviderId: 'provider',
        imageModelId: 'image', imageProviderId: 'provider', selectedShotIds, galleryAspect
    } } };
    const apiCalls = [];
    const requestLogs = [];
    const requestStatistics = [];
    const imagePrompts = new Map();
    const history = [];
    const warnings = [];
    const assets = new Map();
    const noop = () => {};
    const nodes = new Map([[node.id, node]]);
    const connections = [];
    if (visualStyle) {
        nodes.set('style', { id: 'style', type: 'VisualStyle', data: { visualStyle } });
        connections.push({ from: { nodeId: 'style', port: 'style' }, to: { nodeId: node.id, port: 'style' } });
    }
    const setConnectedReference = image => {
        const id = 'product-reference';
        if (!nodes.has(id)) connections.push({ from: { nodeId: id, port: 'image' }, to: {
            nodeId: node.id, port: 'referenceImages'
        } });
        nodes.set(id, { id, type: 'ImageImport', data: { imageList: [image] } });
    };
    if (syncImagePreviewNode) {
        nodes.set('preview', { id: 'preview', type: 'ImagePreview' });
        connections.push({ from: { nodeId: node.id, port: 'image' }, to: { nodeId: 'preview', port: 'image' } });
    }
    const core = createExecutionCoreApi({
        state: {
            nodes, connections,
            models: [
                { id: 'vision', name: 'Vision', modelId: 'gemini-2.5-flash', taskType: 'chat', protocol: 'google', providerIds: ['provider'] },
                { id: 'image', name: 'Image', modelId: imageModel, taskType: 'image', protocol: imageProtocol, providerIds: ['provider'] }
            ],
            providers: [{ id: 'provider', endpoint: 'https://fixture.test', apikey: 'fixture-key' }]
        },
        referenceImageCatalog, syncImagePreviewNode,
        nodeConfigs: {}, documentRef: { getElementById: () => null }, windowRef: { requestAnimationFrame: noop },
        dataURLtoBlob: source => new Blob([Buffer.from(source.split(',')[1], 'base64')], { type: 'image/png' }),
        getProxyHeaders: () => ({}), showToast: (message, kind) => { if (kind === 'warning') warnings.push(message); },
        addLog: noop, showResolutionBadge: noop,
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
    const execute = (action, image = reference, commerceShotId, signal = new AbortController().signal, commerceCandidateKey) => core.executeNode(
        node, { referenceImages: image ? [image] : [] }, signal, { commerceAction: action, commerceShotId, commerceCandidateKey });
    return { node, execute, normalizeRunOptions: core.normalizeRunOptions, removeCommerceScene: core.removeCommerceScene,
        getCachedOutputValue: core.getCachedOutputValue, apiCalls, requestLogs, requestStatistics, imagePrompts, history, assets, warnings,
        setConnectedReference, setFailure: role => { failedRole = role; }, clearFailure: () => { failedRole = undefined; } };
}

test('finalized legacy commerce output checks the connected original before republishing without supplied inputs', async () => {
    const { node, execute, apiCalls, setConnectedReference, getCachedOutputValue } = createCommerceExecutionFixture({
        selectedShotIds: ['main']
    });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    delete node.data.commerceImageSet.plan.referenceContentKey;
    node.data.commerceImageSet.results[0].finalized = true;
    const requests = apiCalls.length;

    setConnectedReference(reference);
    assert.equal(getCachedOutputValue(node, 'image'), undefined, 'synchronous reuse waits for proven provenance');
    assert.deepEqual((await execute('generate', null)).image, [reference]);

    setConnectedReference(nextReference);
    await assert.rejects(execute('generate', null), /参考图.*变更.*重新规划/);
    assert.equal(apiCalls.length, requests);
});

test('regenerating a commerce set retains finalized shots and an entirely finalized set runs without references', async () => {
    let variant = 1;
    const { node, execute, apiCalls } = createCommerceExecutionFixture({
        selectedShotIds: ['main', 'detail'],
        beforePlanRequest: input => ({ sellingPoints: [], shots: input.shots.map(({ id }) => ({
            id, prompt: `${id}\n保留原有光线`, headline: input.copyLanguage === 'ja' ? '草稿' : '定稿标题'
        })) }),
        responseImageData: () => Buffer.from([variant++]).toString('base64')
    });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    const [main, firstDetail] = node.data.commerceImageSet.results;
    main.finalized = true;
    firstDetail.finalized = true;
    const requestCount = apiCalls.length;
    await assert.rejects(execute('retry', reference, 'detail'), /定稿/);
    await assert.rejects(execute('replan-shot', reference, 'detail'), /定稿/);
    assert.deepEqual((await execute('generate', null)).image[0], reference);
    await assert.rejects(execute('generate', nextReference), /参考图已变更/);
    assert.equal(apiCalls.length, requestCount);
    const settings = node.data.commerceImageSet;
    assert.deepEqual(settings.results.map(row => [row.assetKey, row.finalized]), [[main.assetKey, true], [firstDetail.assetKey, true]]);

    updateCommerceImageSetCopyLanguage(settings, 'ja');
    node.data.commerceImageSet = normalizeCommerceImageSetState(JSON.parse(JSON.stringify(settings)));
    await execute('plan');
    assert.deepEqual(node.data.commerceImageSet.results.map(row => row.assetKey), [main.assetKey, firstDetail.assetKey]);
    assert.equal(node.data.commerceImageSet.plan.shots[1].headline, '定稿标题');
    assert.equal(getCommerceShotCandidates(node.data.commerceImageSet, 'detail')[0].assetKey, firstDetail.assetKey);
    delete node.data.commerceImageSet.results[1].finalized;
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    assert.deepEqual(apiCalls.filter(call => call.type === 'image').map(call => call.role), ['detail', 'detail']);
    assert.equal(node.data.mediaAssetKeys[0], main.assetKey);
    assert.notEqual(node.data.mediaAssetKeys[1], firstDetail.assetKey);
});

test('restoring a commerce candidate updates the chosen output and its exact captured draft without calling a model', async () => {
    let variant = 1;
    const { node, execute, apiCalls, assets, normalizeRunOptions } = createCommerceExecutionFixture({
        selectedShotIds: ['detail', 'feature'],
        responseImageData: () => Buffer.from([variant++]).toString('base64')
    });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    const [originalKey, featureKey] = node.data.mediaAssetKeys;
    const originalShot = node.data.commerceImageSet.plan.shots[0];
    Object.assign(originalShot, { prompt: '新的俯拍构图', headline: '新标题', body: '新正文' });
    await execute('retry', reference, 'detail');
    const currentKey = node.data.mediaAssetKeys[0];
    const [newCandidate, originalCandidate] = getCommerceShotCandidates(node.data.commerceImageSet, 'detail');
    assert.deepEqual([newCandidate, originalCandidate].map(({ assetKey, draft }) => [assetKey, draft.headline]),
        [[currentKey, '新标题'], [originalKey, '规划草稿']]);
    await execute('plan');
    assert.deepEqual(node.data.commerceImageSet.results.map(row => row.assetKey), [currentKey, featureKey]);
    assert.equal(isCommerceShotImageStale(node.data.commerceImageSet.plan.shots[0], node.data.commerceImageSet.results[0]), true);
    const [featureCandidate] = getCommerceShotCandidates(node.data.commerceImageSet, 'feature');
    const input = { mode: 'selected-only', selectedNodeIds: [node.id], commerceNodeId: node.id,
        commerceAction: 'select-candidate', commerceShotId: 'detail', commerceCandidateKey: originalCandidate.key };
    assert.equal(normalizeRunOptions(input).commerceCandidateKey, originalCandidate.key);
    assert.throws(() => normalizeRunOptions({ ...input, commerceCandidateKey: featureCandidate.key }), /候选/);

    const requestCount = apiCalls.length;
    await execute('select-candidate', null, 'detail', undefined, originalCandidate.key);
    assert.equal(apiCalls.length, requestCount);
    assert.deepEqual(node.data.mediaAssetKeys, [originalKey, featureKey]);
    const restored = node.data.commerceImageSet.plan.shots[0];
    assert.match(restored.prompt, /商品位于画面右侧/);
    assert.equal(restored.headline, '规划草稿');
    assert.equal(restored.body, '规划正文');
    assert.equal(isCommerceShotImageStale(restored, node.data.commerceImageSet.results[0]), false);

    node.data.commerceImageSet.results[0].finalized = true;
    await assert.rejects(execute('select-candidate', null, 'detail', undefined, newCandidate.key), /定稿/);
    delete node.data.commerceImageSet.results[0].finalized;
    assets.delete(currentKey);
    await assert.rejects(execute('select-candidate', null, 'detail', undefined, newCandidate.key), /无法读取/);
    assert.deepEqual(node.data.mediaAssetKeys, [originalKey, featureKey]);
    assert.equal(node.data.commerceImageSet.plan.shots[0].headline, '规划草稿');
});

test('a downstream preview error after candidate adoption reports the update warning and keeps the selected output', async () => {
    let variant = 1;
    let failPreview = false;
    const { node, execute, warnings } = createCommerceExecutionFixture({
        selectedShotIds: ['detail'],
        responseImageData: () => Buffer.from([variant++]).toString('base64'),
        async syncImagePreviewNode() {
            if (failPreview) throw new Error('预览暂时无法写入');
        }
    });
    await execute('plan');
    node.data.commerceImageSet.candidateCount = 2;
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    const candidate = getCommerceShotCandidates(node.data.commerceImageSet, 'detail')[0];
    failPreview = true;
    await execute('select-candidate', null, 'detail', undefined, candidate.key);
    assert.deepEqual(node.data.mediaAssetKeys, [candidate.assetKey]);
    assert.ok(warnings.some(message => /已采用候选.*下游预览.*失败/.test(message)));
});

test('a commerce run saves multiple candidates per generated slot but publishes one image per slot', async () => {
    let variant = 10;
    const { node, execute, apiCalls, history, assets } = createCommerceExecutionFixture({
        selectedShotIds: ['main', 'detail', 'feature'],
        responseImageData: () => Buffer.from([variant++]).toString('base64')
    });
    await execute('plan');
    node.data.commerceImageSet.candidateCount = 4;
    node.data.commerceImageSet.plan.confirmed = true;
    const generated = await execute('generate');
    assert.deepEqual(apiCalls.filter(call => call.type === 'image').map(call => call.role),
        ['detail', 'detail', 'detail', 'detail', 'feature', 'feature', 'feature', 'feature']);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:000000', 'media:0a', 'media:0e']);
    assert.deepEqual(generated.images, node.data.mediaAssetKeys.map(key => assets.get(key)));
    const settings = normalizeCommerceImageSetState(node.data.commerceImageSet);
    assert.deepEqual(getCommerceShotCandidates(settings, 'detail').map(item => item.assetKey),
        ['media:0d', 'media:0c', 'media:0b', 'media:0a']);
    assert.deepEqual(getCommerceShotCandidates(settings, 'main'), []);
    assert.equal(history.length, 9);
});

test('commerce candidate failure allows later successes and records the shortfall', async () => {
    let attempt = 0;
    let variant = 16;
    const { node, execute, requestLogs } = createCommerceExecutionFixture({
        selectedShotIds: ['detail'],
        beforeImageRequest() {
            if (++attempt === 1) throw new Error('第一张生成失败');
        },
        responseImageData: () => Buffer.from([variant++]).toString('base64')
    });
    await execute('plan');
    node.data.commerceImageSet.candidateCount = 3;
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    assert.deepEqual(requestLogs.filter(request => request.operation === 'generate').map(item => item.requestStatus),
        ['failed', 'success', 'success']);
    assert.equal(node.data.commerceImageSet.results[0].assetKey, 'media:10');
    assert.deepEqual(node.data.commerceImageSet.results[0].candidateProgress, { completed: 2, total: 3 });
    assert.equal(node.generationAttemptIncomplete, true);
    assert.equal(getCommerceShotCandidates(node.data.commerceImageSet, 'detail').length, 2);
});

test('identical responses occupy one candidate version and only count as one saved candidate', async () => {
    const { node, execute, apiCalls } = createCommerceExecutionFixture({ selectedShotIds: ['detail'] });
    await execute('plan');
    node.data.commerceImageSet.candidateCount = 3;
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    assert.equal(apiCalls.filter(call => call.type === 'image').length, 3);
    const settings = normalizeCommerceImageSetState(node.data.commerceImageSet);
    assert.equal(getCommerceShotCandidates(settings, 'detail').length, 1);
    assert.deepEqual(settings.results[0].candidateProgress, { completed: 1, total: 3 });
});

test('canceling a commerce slot stops future requests and saves only successful candidates without replacing the prior output', async () => {
    let attempt = 0;
    let variant = 24;
    const blocked = Promise.withResolvers();
    const { node, execute, requestLogs } = createCommerceExecutionFixture({
        selectedShotIds: ['detail'],
        async beforeImageRequest(_, signal) {
            if (++attempt !== 7) return;
            blocked.resolve();
            await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        },
        responseImageData: () => Buffer.from([variant++]).toString('base64')
    });
    await execute('plan');
    node.data.commerceImageSet.candidateCount = 4;
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    const generating = execute('retry', reference, 'detail');
    await blocked.promise;
    assert.deepEqual(node.commerceShotPreviews.detail.candidateProgress, { completed: 2, total: 4 });
    node.commerceShotCancelHandlers.get('detail')();
    await assert.rejects(generating, { name: 'AbortError' });
    assert.deepEqual(requestLogs.filter(request => request.operation === 'retry').map(item => item.requestStatus),
        ['success', 'success', 'canceled']);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:18']);
    assert.deepEqual(getCommerceShotCandidates(node.data.commerceImageSet, 'detail').map(item => item.assetKey).sort(),
        ['media:18', 'media:1b', 'media:1c', 'media:1d']);
});

test('the same commerce image asset can restore either of its distinct captured drafts', async () => {
    const { node, execute } = createCommerceExecutionFixture({ selectedShotIds: ['detail'], responseImageData: () => 'Aw==' });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    node.data.commerceImageSet.plan.shots[0].headline = '新版文字';
    await execute('retry', reference, 'detail');
    const candidates = getCommerceShotCandidates(node.data.commerceImageSet, 'detail');
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].assetKey, candidates[1].assetKey);
    assert.notEqual(candidates[0].key, candidates[1].key);
    await execute('select-candidate', null, 'detail', undefined, candidates[1].key);
    assert.equal(node.data.commerceImageSet.plan.shots[0].headline, '规划草稿');
    assert.equal(node.data.commerceImageSet.results[0].planKey, candidates[1].planKey);
});

test('bulk redo retains an earlier image when replacement fails and still publishes successful siblings', async () => {
    const failing = new Set();
    let variant = 1;
    const { node, execute } = createCommerceExecutionFixture({
        selectedShotIds: ['detail', 'feature'],
        beforeImageRequest(role) { if (failing.has(role)) throw new Error(`无法生成 ${role}`); },
        responseImageData: () => Buffer.from([variant++]).toString('base64')
    });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    const [originalDetail, originalFeature] = node.data.mediaAssetKeys;
    failing.add('detail');
    await execute('generate');
    const current = node.data.commerceImageSet;
    assert.equal(current.results[0].assetKey, originalDetail);
    assert.equal(current.results[0].status, 'completed');
    assert.match(current.results[0].replacementError, /无法生成 detail/);
    assert.equal(normalizeCommerceImageSetState(current).results[0].replacementError, current.results[0].replacementError);
    assert.notEqual(current.results[1].assetKey, originalFeature);
    assert.equal(getCommerceShotCandidates(current, 'detail')[0].assetKey, originalDetail);
    assert.equal(node.generationAttemptIncomplete, true);

    const currentAssets = node.data.mediaAssetKeys.slice();
    failing.add('feature');
    await assert.rejects(execute('generate'), /无法生成 detail/);
    assert.deepEqual(node.data.mediaAssetKeys, currentAssets);
    assert.ok(node.data.commerceImageSet.results.every(row => row.status === 'completed' && row.replacementError));
    assert.equal(node.generationAttemptIncomplete, true);
});

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

test('commerce fill attempts failed, canceled and pending slots while retaining completed assets in place', async () => {
    const selectedShotIds = ['main', 'angle', 'detail', 'scene'];
    const { node, execute, apiCalls, requestLogs, history, assets } = createCommerceExecutionFixture({ selectedShotIds });
    await execute('plan');
    const { commerceImageSet } = node.data;
    commerceImageSet.plan.confirmed = true;
    const retained = { shotId: 'main', status: 'completed', assetKey: 'media:prior' };
    assets.set(retained.assetKey, nextReference);
    commerceImageSet.results = [retained, { shotId: 'angle', status: 'failed', error: 'provider failed' },
        { shotId: 'detail', status: 'canceled' }];
    const result = await execute('fill');
    assert.deepEqual(apiCalls.filter(call => call.type === 'image').map(call => call.role), ['angle', 'detail', 'scene']);
    const log = requestLogs.filter(entry => entry.operation === 'fill');
    assert.deepEqual(log.map(entry => entry.shotId), ['angle', 'detail', 'scene']);
    assert.ok(log.every(entry => entry.title.includes('补齐图片')));
    assert.equal(history.length, 3);
    assert.deepEqual(node.data.commerceImageSet.results.map(row => row.shotId), selectedShotIds);
    assert.deepEqual(node.data.commerceImageSet.results[0], retained);
    assert.equal(node.data.mediaAssetKeys[0], retained.assetKey);
    assert.equal(result.image[0], nextReference);
});

test('commerce fill requires a confirmed plan and makes no request when every slot is complete', async () => {
    const { node, execute, apiCalls, normalizeRunOptions, history } = createCommerceExecutionFixture({ selectedShotIds: ['main', 'angle'] });
    const input = { mode: 'selected-only', selectedNodeIds: [node.id], commerceNodeId: node.id, commerceAction: 'fill' };
    assert.equal(normalizeRunOptions(input).commerceAction, 'fill');
    assert.throws(() => normalizeRunOptions({ ...input, mode: 'all' }), /请选择一个需要补齐/);
    assert.throws(() => normalizeRunOptions({ ...input, commerceShotId: 'angle' }), /请选择一个需要补齐/);
    await execute('plan');
    await assert.rejects(execute('fill'), /确认方案/);
    assert.equal(apiCalls.length, 1);
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('fill');
    assert.deepEqual(apiCalls.filter(call => call.type === 'image').map(call => call.role), ['angle']);
    const before = structuredClone(node.data.commerceImageSet.results);
    const historyLength = history.length;
    assert.throws(() => normalizeRunOptions(input), /所有图位已完成/);
    await assert.rejects(execute('fill'), /所有图位已完成/);
    assert.equal(apiCalls.length, 2);
    assert.equal(history.length, historyLength);
    assert.deepEqual(node.data.commerceImageSet.results, before);
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
    assert.deepEqual(plan.shots.filter((shot, index) => isCommerceShotImageStale(shot, results[index])).map(shot => shot.id), ['scene']);
    assert.deepEqual(node.data.mediaAssetKeys, priorKeys);
    assert.equal(history.length, historyCount);
});

test('a supplemental scene can be planned during base generation and is only generated after confirmation', async () => {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const selectedShotIds = ['main', 'detail-overview'];
    const { node, execute, apiCalls } = createCommerceExecutionFixture({
        selectedShotIds,
        responseImageData: role => role === 'detail-overview' ? 'AQ==' : 'Ag==',
        async beforeImageRequest(role) {
            if (role === 'detail-overview') {
                started.resolve();
                await release.promise;
            }
        },
        beforePlanRequest(input) {
            const id = input.shots[0]?.id;
            if (!id?.startsWith('scene-')) return;
            return { shots: [{ id, sceneSummary: '清晨窗边', prompt: '窗边自然光，左侧展示商品', headline: '清晨一杯' }] };
        }
    });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    const base = execute('generate');
    let id;
    try {
        await Promise.race([started.promise, base]);
        id = appendCommerceSceneShot(node.data.commerceImageSet, 'gallery').id;
        await execute('replan-shot', reference, id);
        assert.equal(node.data.commerceImageSet.plan.confirmed, true);
        assert.equal(node.data.commerceImageSet.plan.shots.find(shot => shot.id === id).headline, '清晨一杯');
        await assert.rejects(execute('retry', reference, id), /确认.*方案/);
    } finally {
        release.resolve();
        await base;
    }
    const before = structuredClone(node.data.commerceImageSet.results);
    assert.deepEqual(before.map(row => row.shotId), selectedShotIds);
    assert.equal(node.generationAttemptIncomplete, false);
    await assert.rejects(execute('fill'), /所有图位已完成/);
    assert.deepEqual(apiCalls.filter(call => call.type === 'image').map(call => call.role), ['detail-overview']);

    assert.equal(confirmCommerceSceneShot(node.data.commerceImageSet, id), true);
    await execute('retry', reference, id);
    assert.deepEqual(node.data.commerceImageSet.results.map(row => row.shotId), ['main', id, 'detail-overview']);
    assert.deepEqual(node.data.commerceImageSet.results.filter(row => row.shotId !== id), before);
    assert.deepEqual(apiCalls.filter(call => call.type === 'image').map(call => call.role), ['detail-overview', '窗边自然光，左侧展示商品']);
});

test('adding a scene after replanning keeps compatible preset results in their original output order', async () => {
    const { node, execute } = createCommerceExecutionFixture({
        selectedShotIds: ['main', 'detail'],
        beforePlanRequest: input => ({ sellingPoints: [], shots: input.shots.map(({ id }) => ({
            id, prompt: id.startsWith('scene-') ? '清晨窗边场景' : id,
            ...(id.startsWith('scene-') ? { sceneSummary: '清晨窗边' } : {})
        })) })
    });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    const original = await execute('generate');
    const originalKeys = node.data.mediaAssetKeys.slice();

    updateCommerceProductInfoField(node.data.commerceImageSet, 'name', '更新商品资料');
    await execute('plan');
    const scene = appendCommerceSceneShot(node.data.commerceImageSet, 'gallery', 'scene-added-after-replan');
    await execute('replan-shot', reference, scene.id);
    assert.equal(confirmCommerceSceneShot(node.data.commerceImageSet, scene.id), true);
    const updated = await execute('retry', reference, scene.id);
    assert.equal(updated.image.length, 3);
    assert.deepEqual([updated.image[0], updated.image[1]], original.image);
    assert.deepEqual(node.data.mediaAssetKeys.slice(0, 2), originalKeys);
    assert.equal(node.data.commerceImageSet.results.find(row => row.shotId === 'detail').previousVersion, true);
});

test('replanning with changed references removes old photos from active output and archives their positions', async () => {
    const { node, execute, getCachedOutputValue } = createCommerceExecutionFixture({
        selectedShotIds: ['main', 'detail']
    });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    const originalKeys = node.data.mediaAssetKeys.slice();
    const oldCandidate = getCommerceShotCandidates(node.data.commerceImageSet, 'detail')[0];

    await execute('plan', nextReference);
    assert.equal(getCachedOutputValue(node, 'image'), undefined);
    assert.equal(node.data.mediaAssetKeys?.length || 0, 0);
    assert.deepEqual(node.data.commerceImageSet.previousExportResults.map(row => row.outputKey), originalKeys);
    await assert.rejects(
        execute('select-candidate', null, 'detail', undefined, oldCandidate.key),
        /参考图.*旧|旧.*参考图/
    );
    delete node.data.commerceImageSet.candidates.find(candidate => candidate.key === oldCandidate.key).referenceContentKey;
    await assert.rejects(
        execute('select-candidate', null, 'detail', undefined, oldCandidate.key),
        /无法确认.*参考图版本/
    );
    assert.equal(getCachedOutputValue(node, 'image'), undefined);

    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate', nextReference);
    assert.equal(getCachedOutputValue(node, 'image')[0], nextReference);
    assert.deepEqual(node.data.commerceImageSet.previousExportResults.map(row => row.outputKey), originalKeys);
});

test('deleting a completed scene keeps the shared image in its other output position after memory release', async () => {
    const { node, execute, apiCalls, removeCommerceScene, getCachedOutputValue } = createCommerceExecutionFixture({
        selectedShotIds: ['main', 'detail-overview'],
        responseImageData: role => (role === 'detail-overview' ? nextReference : reference).split(',')[1]
    });
    await execute('plan');
    const settings = node.data.commerceImageSet;
    const scene = appendCommerceSceneShot(settings, 'detail', 'scene-shared');
    Object.assign(scene, { sceneSummary: '清晨窗边', prompt: '窗边马克杯' });
    assert.equal(confirmCommerceSceneShot(settings, scene.id), true);
    settings.plan.confirmed = true;
    assert.deepEqual((await execute('generate')).images, [reference, nextReference, reference]);
    const [sharedKey, detailKey, sceneKey] = node.data.mediaAssetKeys;
    assert.equal(sceneKey, sharedKey);
    assert.notEqual(detailKey, sharedKey);
    const requests = apiCalls.length;

    delete node.data.imageList;
    node.data.imageMemoryReleased = true;
    assert.equal(getCachedOutputValue(node, 'image'), undefined);
    assert.equal(await removeCommerceScene(node, scene.id, () => true), true);
    assert.deepEqual(node.data.commerceImageSet.results.map(({ shotId }) => shotId), ['main', 'detail-overview']);
    assert.deepEqual(node.data.mediaAssetKeys, [sharedKey, detailKey]);
    assert.equal(node.data.imageCount, 2);
    assert.deepEqual(getCachedOutputValue(node, 'image'), [reference, nextReference]);
    assert.equal(apiCalls.length, requests);
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
    const { plan } = node.data.commerceImageSet;
    const detail = plan.shots.find(shot => shot.id === 'detail');
    const originalDetail = originalResults.find(row => row.shotId === 'detail');
    assert.equal(isCommerceShotImageStale(detail, originalDetail), false);
    plan.confirmed = false;
    detail.headline = '新的标题';
    assert.equal(isCommerceShotImageStale(detail, originalDetail), true);

    setFailure('detail');
    await assert.rejects(execute('retry', reference, 'detail'));
    assert.deepEqual(node.data.mediaAssetKeys, originalKeys);
    assert.deepEqual(node.data.commerceImageSet.results, originalResults);
    assert.equal(isCommerceShotImageStale(detail, node.data.commerceImageSet.results.at(-1)), true);
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
    const updated = await execute('retry', reference, 'detail');
    assert.deepEqual(apiCalls.slice(callCount).map(call => call.role), ['detail', 'detail', 'detail']);
    assert.deepEqual(updated.images, [original.images[0], original.images[1], changedArtwork]);
    assert.match(imagePrompts.get('detail'), /新的标题/);
    assert.equal(node.data.mediaAssetKeys[0], originalKeys[0]);
    assert.equal(node.data.mediaAssetKeys[1], originalKeys[1]);
    assert.deepEqual(node.data.commerceImageSet.results.map(row => row.shotId), ['main', 'angle', 'detail']);
    assert.equal(isCommerceShotImageStale(detail, node.data.commerceImageSet.results.at(-1)), false);
    assert.deepEqual(node.data.commerceImageSet.results.slice(0, -1), originalResults.slice(0, -1));
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
    let previewPlanKey;
    try {
        await Promise.race([waiting.promise, generation]);
        assert.deepEqual(node.commerceShotPreviews.main, { status: 'completed', image: reference });
        const preview = node.commerceShotPreviews.angle;
        assert.equal(preview.status, 'completed');
        assert.equal(preview.image, finishedArtwork);
        previewPlanKey = preview.planKey;
        assert.ok(previewPlanKey);
        const angle = node.data.commerceImageSet.plan.shots.find(shot => shot.id === 'angle');
        assert.equal(isCommerceShotImageStale(angle, preview), false);
        angle.prompt += '\n改用俯拍。';
        assert.equal(isCommerceShotImageStale(angle, preview), true);
        assert.equal(node.commerceShotPreviews.detail.status, 'failed');
        assert.equal(node.commerceShotPreviews.scene.status, 'running');
        assert.deepEqual(node.data.commerceImageSet.results, []);
        assert.deepEqual(history.map(entry => entry.image), [reference, finishedArtwork]);
    } finally {
        finish.resolve();
        await generation;
    }
    assert.equal(node.commerceShotPreviews, undefined);
    const angleResult = node.data.commerceImageSet.results.find(row => row.shotId === 'angle');
    assert.equal(angleResult.assetKey, 'media:020000');
    assert.equal(angleResult.planKey, previewPlanKey);
    const angle = node.data.commerceImageSet.plan.shots.find(shot => shot.id === 'angle');
    assert.equal(isCommerceShotImageStale(angle, angleResult), true);
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


test('共用风格参与套图规划和生图，变更后保留旧结果与定稿', async () => {
    const visualStyle = { preset: 'custom', palette: '苔藓绿', typography: '标题左对齐' };
    const fixture = createCommerceExecutionFixture({ selectedShotIds: ['main', 'detail'], visualStyle });
    await fixture.execute('plan');
    assert.equal(fixture.node.data.commerceImageSet.plan.visualStyle.palette, '苔藓绿');
    fixture.node.data.commerceImageSet.plan.confirmed = true;
    await fixture.execute('generate');
    assert.match(fixture.imagePrompts.get('detail'), /苔藓绿/);
    const before = structuredClone(fixture.node.data.commerceImageSet.results);
    visualStyle.palette = '深蓝';
    await assert.rejects(fixture.execute('generate'), /画面风格已更新/);
    assert.deepEqual(fixture.node.data.commerceImageSet.results, before);
    fixture.node.data.commerceImageSet.results[1].finalized = true;
    await fixture.execute('plan');
    assert.equal(fixture.node.data.commerceImageSet.plan.visualStyle.palette, '深蓝');
    assert.equal(fixture.node.data.commerceImageSet.plan.shots.find(shot => shot.id === 'detail').visualStyleSnapshot.palette, '苔藓绿');
    assert.equal(fixture.node.data.commerceImageSet.results[1].assetKey, before[1].assetKey);
});

test('旧追加场景在风格变更并重规划后重新确认，使用当前风格', async () => {
    const visualStyle = { palette: '苔藓绿' };
    const { node, execute, imagePrompts } = createCommerceExecutionFixture({ selectedShotIds: ['main', 'detail'], visualStyle,
        beforePlanRequest: input => input.shots[0].id.startsWith('scene-') ? { shots: [{ id: input.shots[0].id,
            prompt: 'scene\n窗边生活场景', sceneSummary: '窗边生活场景', headline: '', body: '' }] } : undefined });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    const scene = appendCommerceSceneShot(node.data.commerceImageSet, 'gallery');
    await execute('replan-shot', reference, scene.id);
    confirmCommerceSceneShot(node.data.commerceImageSet, scene.id);
    visualStyle.palette = '深蓝';
    await execute('plan');
    node.data.commerceImageSet = normalizeCommerceImageSetState(JSON.parse(JSON.stringify(node.data.commerceImageSet)));
    node.data.commerceImageSet.plan.confirmed = true;
    assert.equal(confirmCommerceSceneShot(node.data.commerceImageSet, scene.id), true);
    await execute('retry', reference, scene.id);
    assert.match(imagePrompts.get('scene'), /深蓝/);
    assert.doesNotMatch(imagePrompts.get('scene'), /苔藓绿/);
});


test('appending eight candidates retains the adopted output and bounds history to twenty versions', async () => {
    let variant = 1;
    const { node, execute } = createCommerceExecutionFixture({ selectedShotIds: ['detail'],
        responseImageData: () => Buffer.from([variant++]).toString('base64') });
    await execute('plan');
    node.data.commerceImageSet.plan.confirmed = true;
    await execute('generate');
    const original = structuredClone(node.data.commerceImageSet.results[0]);
    const output = [...node.data.mediaAssetKeys];
    node.data.commerceImageSet.candidateCount = 8;
    await execute('generate-candidates', reference, 'detail');
    assert.equal(getCommerceShotCandidates(node.data.commerceImageSet, 'detail').length, 9);
    assert.deepEqual(node.data.commerceImageSet.results[0], original);
    assert.deepEqual(node.data.mediaAssetKeys, output);
    await execute('generate-candidates', reference, 'detail');
    await execute('generate-candidates', reference, 'detail');
    const versions = getCommerceShotCandidates(node.data.commerceImageSet, 'detail');
    assert.equal(versions.length, 20);
    assert.ok(versions.some(version => version.assetKey === original.assetKey));
    await execute('select-candidate', null, 'detail', undefined, versions[0].key);
    assert.equal(node.data.commerceImageSet.results[0].assetKey, versions[0].assetKey);
    assert.ok(getCommerceShotCandidates(node.data.commerceImageSet, 'detail').some(version => version.assetKey === original.assetKey));
});
