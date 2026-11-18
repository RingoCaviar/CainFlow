import assert from 'node:assert/strict';
import test from 'node:test';
import { getSnapshotMediaKeys } from '../js/features/persistence/snapshot-media-keys.js';
import { collectWorkflowMediaOwnerLists } from '../js/features/media/workflow-media-ownership-commit.js';
import { getCommerceImageConfigurationIssue } from '../js/features/execution/commerce-run-preflight.js';
import { describeCommerceReferenceMedia } from '../js/features/ecommerce-image-set/commerce-shot-reference-controls.js';
import { createReferenceImageCatalog } from '../js/features/media/reference-image-catalog.js';
import '../js/features/execution/protocols/openai.js';
import {
    commerceShotPlanKey, getCommerceShotCandidates, normalizeCommerceImageSetState,
    rememberCommerceShotCandidate, restoreCommerceShotCandidateDraft
} from '../js/features/ecommerce-image-set/commerce-image-set-plan.js';
import {
    buildCommercePlanningReferenceInput, buildCommerceShotReferenceInstructions, commerceConnectedStyleRevision,
    getCommerceShotReferenceAssetKeys, hasCommerceStyleReferenceChange, normalizeCommerceShotReferences, projectCommerceStyleReferences,
    readCommerceShotReferences, updateCommerceShotReferences
} from '../js/features/ecommerce-image-set/commerce-shot-references.js';

const product = 'data:image/png;base64,cHJvZHVjdA==';
const mainReference = 'data:image/png;base64,bWFpbg==';
const detailReference = 'data:image/png;base64,ZGV0YWls';

test('旧批次风格连线按图位显示缩略图和原图，已加载的图片无需重新读取', async () => {
    const source = { id: 'legacy', type: 'ImageGenerate', data: {
        imageAssetKey: 'legacy-batch', imageCount: 2, imageList: [mainReference, detailReference]
    } };
    const state = { nodes: new Map([[source.id, source]]), connections: [{
        from: { nodeId: source.id, port: 'image' }, to: { nodeId: 'commerce', port: 'styleReferenceImages' }
    }] };
    const catalog = createReferenceImageCatalog({ state,
        getImageAsset: key => assert.fail('旧批次不能按单张素材读取 ' + key),
        getImageAssetList: async key => {
            assert.equal(key, 'legacy-batch');
            return [mainReference, detailReference];
        },
        createThumbnail: original => {
            assert.equal(original, detailReference);
            return 'data:image/png;base64,dGh1bWI=';
        }
    });
    const second = () => describeCommerceReferenceMedia(projectCommerceStyleReferences(state, 'commerce').slots[1]);
    const loaded = second();
    assert.equal(loaded.previewUrl, detailReference);
    assert.equal(await catalog.readImage(loaded), detailReference);
    delete source.data.imageList;
    const stored = second();
    assert.equal(await catalog.readThumbnail(stored), 'data:image/png;base64,dGh1bWI=');
    assert.equal(await catalog.readImage(stored), detailReference);
});

test('未分类风格用于所有生图图位，指定图位的连线风格只用于相应请求', async () => {
    const settings = normalizeCommerceImageSetState({ selectedShotIds: ['main', 'detail-overview'],
        shotReferences: { '*': ['media:shared'] }, styleReferenceTypes: { 'source:style:image:0': 'main' } });
    const connected = [{ bindingId: 'source:style:image:0', image: mainReference }];
    const read = async key => key === 'media:shared' ? detailReference : assert.fail(key);
    const plan = await buildCommercePlanningReferenceInput(settings, [{ id: 'main' }, { id: 'detail-overview' }],
        [product], read, undefined, connected);
    assert.deepEqual(plan.references, [product, detailReference, mainReference]);
    assert.deepEqual(plan.shotReferenceMap, { main: [2, 3], 'detail-overview': [2] });
    assert.deepEqual(await readCommerceShotReferences(settings, 'main', read, undefined, connected), [detailReference, mainReference]);
    assert.deepEqual(await readCommerceShotReferences(settings, 'detail-overview', read, undefined, connected), [detailReference]);
    assert.deepEqual(getCommerceShotReferenceAssetKeys(settings), ['media:shared']);
});

test('风格端口按连线和批次位置映射，旧类型在取消勾选图位后不会变成整套参考', () => {
    const target = { id: 'set', type: 'ECommerceImageSet' };
    const source = (id, images) => ({ id, type: 'ImageImport', data: { imageList: images } });
    const edge = (id, port, order) => ({ from: { nodeId: id, port: 'image' }, to: { nodeId: 'set', port }, order });
    const state = { nodes: new Map([target, source('product', [product]), source('single', [product]),
        source('batch', [mainReference, detailReference])].map(node => [node.id, node])),
        connections: [edge('product', 'referenceImages', 0), edge('single', 'styleReferenceImages', 3), edge('batch', 'styleReferenceImages', 1)] };
    const projection = projectCommerceStyleReferences(state, target.id);
    const bindings = projection.slots.map(slot => slot.bindingId);
    assert.deepEqual(bindings, ['source:batch:image:0', 'source:batch:image:1', 'source:single:image:0']);
    const settings = normalizeCommerceImageSetState({ platformId: 'taobao', selectedShotIds: ['detail-overview'],
        shotReferences: { main: ['media:picked'] }, styleReferenceTypes: { [bindings[1]]: 'main' } });
    assert.deepEqual(settings.shotReferences, { main: ['media:picked'] });
    assert.equal(settings.styleReferenceTypes[bindings[1]], 'main');
    settings.plan = { connectedStyleRevision: commerceConnectedStyleRevision(settings, projection) };
    assert.equal(hasCommerceStyleReferenceChange(settings, projection), false);
    state.connections.pop();
    assert.equal(hasCommerceStyleReferenceChange(settings, projectCommerceStyleReferences(state, target.id)), true);
});

test('图位参考只保存素材身份并限制每个图位的数量', () => {
    const normalized = normalizeCommerceShotReferences({ main: ['media:A', 'media:A', 'https://example.test/image',
        'media:B', 'media:C', 'media:D'], 'detail-overview': ['media:E'], unknown: ['media:X'] }, ['main', 'detail-overview']);
    assert.deepEqual(normalized, { main: ['media:A', 'media:B', 'media:C'], 'detail-overview': ['media:E'] });
    assert.deepEqual(getCommerceShotReferenceAssetKeys({ shotReferences: normalized }), ['media:A', 'media:B', 'media:C', 'media:E']);
});

test('规划使用商品原图在前并将设计参考映射到对应主副图和详情图', async () => {
    const settings = { shotReferences: { main: ['media:main'], feature: ['media:main'], 'detail-overview': ['media:detail'] } };
    const reads = [];
    const input = await buildCommercePlanningReferenceInput(settings,
        [{ id: 'main' }, { id: 'feature' }, { id: 'detail-overview' }], [product], async key => {
            reads.push(key);
            return { 'media:main': mainReference, 'media:detail': detailReference }[key];
        });
    assert.deepEqual(input.references, [product, mainReference, detailReference]);
    assert.deepEqual(input.shotReferenceMap, { main: [2], feature: [2], 'detail-overview': [3] });
    assert.deepEqual(reads, ['media:main', 'media:detail']);
    assert.match(buildCommerceShotReferenceInstructions(1, 1), /第 1.*商品/);
    assert.match(buildCommerceShotReferenceInstructions(1, 1), /第 2.*设计参考/);
    assert.match(buildCommerceShotReferenceInstructions(1, 1), /不复制.*商品.*文字/);
});

test('单图生成只读取本图位设计参考，缺失和取消不静默跳过', async () => {
    const settings = { shotReferences: { main: ['media:main'], 'detail-overview': ['media:detail'] } };
    const reads = [];
    assert.deepEqual(await readCommerceShotReferences(settings, 'detail-overview', async key => {
        reads.push(key); return detailReference;
    }), [detailReference]);
    assert.deepEqual(reads, ['media:detail']);
    await assert.rejects(readCommerceShotReferences(settings, 'main', async () => ''), /设计参考图.*不可用/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(readCommerceShotReferences(settings, 'main', async () => assert.fail('aborted'), controller.signal), /abort/i);
});

test('替换设计参考只取消方案确认并保留其他图位、既有结果和输入身份', () => {
    const settings = { selectedShotIds: ['main', 'detail-overview'], shotReferences: { main: ['media:old'] },
        plan: { sourceKey: 'product-key', confirmed: true, shots: [
            { id: 'main', prompt: '主图', referenceAssetKeys: ['media:old'] },
            { id: 'detail-overview', prompt: '详情', headline: '手动文案' }
        ] }, results: [{ shotId: 'main', assetKey: 'media:completed', status: 'completed' }] };
    const detail = structuredClone(settings.plan.shots[1]);
    const results = structuredClone(settings.results);
    assert.equal(updateCommerceShotReferences(settings, 'main', ['media:new']), true);
    assert.equal(settings.plan.confirmed, false);
    assert.equal(settings.plan.stale, undefined);
    assert.equal(settings.plan.sourceKey, 'product-key');
    assert.deepEqual(settings.plan.shots[0].referenceAssetKeys, ['media:new']);
    assert.deepEqual(settings.plan.shots[1], detail);
    assert.deepEqual(settings.results, results);
    assert.equal(updateCommerceShotReferences(settings, 'main', ['media:new']), false);
    assert.equal(updateCommerceShotReferences(settings, 'unknown', ['media:other']), false);
    assert.equal(updateCommerceShotReferences(settings, 'main', []), true);
    assert.deepEqual(settings.shotReferences, {});
});

test('设计参考及候选历史中的参考由工作流持有，不混入套图输出', () => {
    const node = { id: 'commerce', type: 'ECommerceImageSet', mediaAssetKeys: ['media:rendered'], commerceImageSet: {
        platformId: 'taobao', selectedShotIds: ['main'], shotReferences: { main: ['media:design'] },
        candidates: [{ shotId: 'main', aspect: '1:1', assetKey: 'media:old-rendered',
            draft: { prompt: '旧构图', referenceAssetKeys: ['media:old-design'] } }]
    } };
    assert.deepEqual(new Set(getSnapshotMediaKeys(node)), new Set(['media:rendered', 'media:design', 'media:old-rendered', 'media:old-design']));
    assert.deepEqual(new Set(collectWorkflowMediaOwnerLists({ nodes: [node] })[0].assetKeys),
        new Set(['media:rendered', 'media:design', 'media:old-rendered', 'media:old-design']));
    assert.deepEqual(node.mediaAssetKeys, ['media:rendered']);
});

test('采用已保存候选恢复该版本设计参考，重新打开仍保留同一完整草稿', () => {
    const state = normalizeCommerceImageSetState({ platformId: 'taobao', selectedShotIds: ['main'],
        shotReferences: { main: ['media:old-design'] },
        plan: { version: 1, sourceKey: 'product-key', confirmed: true, sellingPoints: [],
            shots: [{ id: 'main', prompt: '依照旧参考构图', headline: '商品标题' }] }
    });
    const originalKey = commerceShotPlanKey(state.plan.shots[0]);
    rememberCommerceShotCandidate(state, state.plan.shots[0], 'media:old-rendered');
    updateCommerceShotReferences(state, 'main', ['media:new-design']);
    assert.notEqual(commerceShotPlanKey(state.plan.shots[0]), originalKey);
    const candidate = getCommerceShotCandidates(state, 'main')[0];
    assert.equal(restoreCommerceShotCandidateDraft(state, candidate), true);
    assert.deepEqual(state.shotReferences, { main: ['media:old-design'] });
    assert.equal(commerceShotPlanKey(state.plan.shots[0]), originalKey);
    const restored = normalizeCommerceImageSetState(JSON.parse(JSON.stringify(state)));
    assert.deepEqual(restored.shotReferences, state.shotReferences);
    assert.equal(commerceShotPlanKey(restored.plan.shots[0]), originalKey);
});

test('运行前按最重图位合计商品与设计参考，避免超出供应商输入上限后才付费请求', () => {
    const settings = { imageModelId: 'image', imageProviderId: 'provider', shotReferences: {
        main: ['media:A', 'media:B'], 'detail-overview': ['media:C']
    } };
    const node = { id: 'commerce', type: 'ECommerceImageSet', data: { commerceImageSet: settings } };
    const state = { nodes: new Map([[node.id, node]]), connections: [],
        models: [{ id: 'image', modelId: 'gpt-image-2', protocol: 'openai', taskType: 'image', providerIds: ['provider'] }],
        providers: [{ id: 'provider', endpoint: 'https://fixture.test/v1', apikey: 'test' }] };
    const generatedShots = [{ id: 'main', source: 'generate', aspect: '1:1' }, { id: 'detail-overview', source: 'generate', aspect: '9:16' }];
    assert.equal(getCommerceImageConfigurationIssue({ state, node, settings, generatedShots, referenceCount: 3 }), '');
    assert.match(getCommerceImageConfigurationIssue({ state, node, settings, generatedShots, referenceCount: 4 }), /合计最多 5 张/);
    assert.equal(getCommerceImageConfigurationIssue({ state, node, settings, generatedShots: [generatedShots[1]], referenceCount: 4 }), '');
});
