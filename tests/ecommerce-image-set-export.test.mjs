import assert from 'node:assert/strict';
import test from 'node:test';
import {
    commerceShotPlanKey, createCommerceImageSetPlan, normalizeCommerceImageSetState, preserveCommerceImageSetExportResults
} from '../js/features/ecommerce-image-set/commerce-image-set-plan.js';
import { projectCommerceImageSetExport } from '../js/features/ecommerce-image-set/commerce-image-set-export.js';

function fixture() {
    const settings = normalizeCommerceImageSetState({
        platformId: 'amazon',
        selectedShotIds: ['detail-overview', 'scene-extra', 'feature', 'main'],
        customScenes: [{ id: 'scene-extra', group: 'gallery', description: '厨房' }],
        productInfo: { name: '随行杯' },
        plannerModelId: 'vision',
        plannerProviderId: 'provider',
        plan: { version: 1, platformId: 'amazon', sourceKey: 'generated-plan', confirmed: true,
            sellingPoints: [], shots: [
                { id: 'main' },
                { id: 'feature', prompt: '展示杯盖', headline: '易于清洗' },
                { id: 'detail-overview', prompt: '展示杯身' }
            ] }
    });
    settings.results = [
        { shotId: 'detail-overview', status: 'completed', assetKey: 'media:overview',
            planKey: commerceShotPlanKey(settings.plan.shots.find(shot => shot.id === 'detail-overview')) },
        { shotId: 'feature', status: 'failed', error: '生成超时' },
        { shotId: 'main', status: 'completed', assetKey: 'media:original' }
    ];
    return { settings, mediaAssetKeys: ['media:overview', 'media:original'] };
}

test('export scopes keep the plan order and numbering, including missing and supplemental slots', () => {
    const input = fixture();
    const all = projectCommerceImageSetExport(input);
    assert.equal(all.title, '随行杯');
    assert.deepEqual(all.rows.map(({ shotId, status, fileStem }) => [shotId, status, fileStem]), [
        ['main', 'current', '01_白底实拍 MAIN'],
        ['feature', 'missing', '02_卖点图'],
        ['scene-extra', 'missing', '03_场景图 1'],
        ['detail-overview', 'current', '04_详情首屏']
    ]);
    assert.deepEqual(projectCommerceImageSetExport({ ...input, scope: 'gallery' }).rows, all.rows.slice(0, 3));
    assert.deepEqual(projectCommerceImageSetExport({ ...input, scope: 'detail' }).rows, all.rows.slice(3));

    input.settings.productInfo.name = '  随行杯/系列:新品.  ';
    assert.equal(projectCommerceImageSetExport(input).title, '随行杯_系列_新品');
    input.settings.productInfo.name = 'CON.txt';
    assert.equal(projectCommerceImageSetExport(input).title, '_CON.txt');
});

test('export marks stale drafts and missing owned references without inventing shot identities', () => {
    const input = fixture();
    input.settings.plan.shots.at(-1).prompt = '新版本构图';
    let output = projectCommerceImageSetExport({ ...input, mediaAssetKeys: [...input.mediaAssetKeys, 'media:unmapped'] });
    assert.deepEqual(output.rows.map(({ status }) => status), ['current', 'missing', 'missing', 'previous']);
    assert.equal(output.unmappedCount, 1);

    input.settings.plan.stale = true;
    output = projectCommerceImageSetExport({ ...input, mediaAssetKeys: ['media:original'] });
    assert.deepEqual(output.rows.map(({ status }) => status), ['previous', 'missing', 'missing', 'missing']);
    assert.equal(output.rows.at(-1).assetKey, null);
});

test('export keeps owned old images attached to their original slots after reset and reopening', () => {
    const input = fixture();
    preserveCommerceImageSetExportResults(input.settings);
    const restored = normalizeCommerceImageSetState(JSON.parse(JSON.stringify({
        ...input.settings, detailAspect: '4:5', plan: null, results: []
    })));
    assert.deepEqual(projectCommerceImageSetExport({ ...input, settings: restored }).rows.map(({ shotId, status, assetKey }) => [shotId, status, assetKey]), [
        ['main', 'previous', 'media:original'],
        ['feature', 'missing', null],
        ['scene-extra', 'missing', null],
        ['detail-overview', 'previous', 'media:overview']
    ]);

    restored.platformId = 'taobao';
    restored.selectedShotIds = ['main', 'detail-overview'];
    const switched = projectCommerceImageSetExport({ ...input, settings: restored });
    assert.deepEqual(switched.rows.map(({ status }) => status), ['missing', 'missing']);
    assert.equal(switched.unmappedCount, 0, 'previous images still have known original slots');

    restored.selectedShotIds = [];
    const lastSet = projectCommerceImageSetExport({ ...input, settings: restored });
    assert.deepEqual(lastSet.rows.map(({ status, fileStem }) => [status, fileStem]), [
        ['previous', '01_白底实拍 MAIN'], ['previous', '02_详情首屏']
    ]);
});

test('an export snapshot tracks output identity without owning assets or retaining every previous set', () => {
    const { settings } = fixture();
    preserveCommerceImageSetExportResults(settings);
    const snapshot = settings.previousExportResults;
    assert.deepEqual(snapshot.map(({ outputKey }) => outputKey), ['media:original', 'media:overview']);
    assert.ok(snapshot.every(row => !Object.hasOwn(row, 'assetKey')));

    settings.results = settings.results.filter(row => row.shotId === 'detail-overview');
    preserveCommerceImageSetExportResults(settings);
    assert.deepEqual(settings.previousExportResults, snapshot, 'an unchanged subset does not replace the last snapshot');

    settings.results = [{ ...settings.results[0], assetKey: 'media:new-overview' }];
    preserveCommerceImageSetExportResults(settings);
    assert.deepEqual(settings.previousExportResults.map(row => row.outputKey), ['media:new-overview']);
});

test('export can still use the last set when replanning replaces the result list', async () => {
    const input = fixture();
    const settings = await createCommerceImageSetPlan({
        settings: input.settings,
        references: ['data:image/png;base64,AA=='],
        models: [{ id: 'vision', name: 'Vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', name: 'Provider', endpoint: 'https://fixture.test/v1', apikey: 'fixture' }],
        fetchRef: async () => Response.json({ choices: [{ message: { content: JSON.stringify({
            sellingPoints: [], shots: [{ id: 'feature', prompt: '新画面' }, { id: 'detail-overview', prompt: '首屏' }]
        }) } }] })
    });
    assert.deepEqual(settings.results, []);
    const output = projectCommerceImageSetExport({ ...input, settings });
    assert.deepEqual(output.rows.filter(row => row.assetKey).map(row => [row.shotId, row.status]), [
        ['main', 'previous'], ['detail-overview', 'previous']
    ]);
});
