import assert from 'node:assert/strict';
import test from 'node:test';
import {
    describeCommerceDetailPanel, getCommerceOutputAssetKey, normalizeCommerceDetailPage, orderCommerceOutputRows
} from '../js/features/ecommerce-image-set/commerce-detail-page.js';
import { projectCommerceImageSetExport } from '../js/features/ecommerce-image-set/commerce-image-set-export.js';
import { normalizeCommerceImageSetPlan, commerceShotPlanKey } from '../js/features/ecommerce-image-set/commerce-image-set-plan.js';

const gallery = { id: 'main', group: 'gallery' };
const overview = { id: 'detail-overview', group: 'detail', label: '详情首屏', headline: '商品名称', body: '商品介绍' };
const feature = { id: 'detail-feature', group: 'detail', label: '核心卖点说明', headline: '核心卖点', body: '' };

test('详情长图保留模型提出的顺序和有效版式，补全实际图位并忽略多余数据', () => {
    const proposed = { version: 1, theme: { background: '#123ABC', accent: 'url(https://example.com)' }, sections: [
        { shotId: feature.id, layout: 'grid', anchor: 'top-right', transition: 'shared', tone: 'accent', height: 'short', assetKey: 'media:fake' },
        { shotId: feature.id, layout: 'feature' }, { shotId: 'fake' }, { shotId: gallery.id }
    ] };
    const page = normalizeCommerceDetailPage(proposed, [gallery, overview, feature]);
    assert.equal(page.version, 2);
    assert.deepEqual(page.sections.map(({ composition, topEdge, bottomEdge, ...section }) => section), [
        { shotId: feature.id, layout: 'grid', anchor: 'top-right', transition: 'shared', tone: 'accent', height: 'short' },
        { shotId: overview.id, layout: 'hero', anchor: 'bottom-left', transition: 'curve', tone: 'surface', height: 'tall' }
    ]);
    assert.equal(page.theme.background, '#123abc');
    assert.match(page.theme.accent, /^#[a-f\d]{6}$/);
    assert.equal(normalizeCommerceDetailPage(null, [overview]), null);
    assert.equal(normalizeCommerceDetailPage(null, [gallery], { fallback: true }), null);
});

test('同一交界的设计要求同时进入相邻两屏的生图提示词', () => {
    const page = normalizeCommerceDetailPage({ version: 2, guide: { typography: '奶油色粗体标题，居左对齐' }, sections: [
        { shotId: overview.id, bottomEdge: '深绿弧线从左缘 40% 高度开始，落在右缘 20%' },
        { shotId: feature.id, topEdge: '冲突的说明', transition: 'shared' }
    ] }, [overview, feature]);
    const first = describeCommerceDetailPanel(page, overview.id);
    const second = describeCommerceDetailPanel(page, feature.id);
    const edge = (prompt, side) => prompt.split('\n').find(line => line.startsWith(`${side}边缘：`)).slice(4);
    assert.equal(edge(first, '下'), edge(second, '上'));
    assert.match(first, /奶油色粗体标题，居左对齐/);
    assert.match(second, /深绿弧线从左缘 40% 高度开始/);
    assert.doesNotMatch(second, /冲突的说明/);
});

test('节点输出和 ZIP 沿用模型原图并按详情顺序排列，旧成品仍可导出', () => {
    const selectedShotIds = [gallery.id, overview.id, feature.id];
    const detailPage = { version: 2, sections: [{ shotId: feature.id }, { shotId: overview.id }] };
    const plan = normalizeCommerceImageSetPlan({ sellingPoints: [], detailPage,
        shots: selectedShotIds.map(id => ({ id, prompt: '商品画面', headline: '产品名称' }))
    }, 'taobao', selectedShotIds, { platformId: 'taobao', selectedShotIds });
    plan.sourceKey = 'planned';
    const results = plan.shots.map((shot, index) => ({ shotId: shot.id, status: 'completed', assetKey: `media:image-${index}`,
        planKey: commerceShotPlanKey(shot), ...(shot.id === overview.id ? { detailAssetKind: 'finished' } : {}),
        ...(shot.id === feature.id ? { detailAssetKind: 'clean', detailOutputKey: 'media:composed' } : {}) }));
    const settings = { platformId: 'taobao', selectedShotIds, plan, results };
    assert.equal(getCommerceOutputAssetKey(results.find(row => row.shotId === overview.id)), 'media:image-1');
    const mediaAssetKeys = orderCommerceOutputRows(settings).map(getCommerceOutputAssetKey);
    assert.deepEqual(mediaAssetKeys, ['media:image-0', 'media:composed', 'media:image-1']);
    const manifest = projectCommerceImageSetExport({ settings, mediaAssetKeys, scope: 'detail' });
    assert.deepEqual(manifest.rows.map(row => [row.shotId, row.assetKey]), [
        [feature.id, 'media:composed'], [overview.id, 'media:image-1']
    ]);
});
