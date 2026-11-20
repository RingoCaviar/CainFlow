import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommerceImageSetImagePrompt, commerceImageSetSourceKey, createCommerceImageSetPlan,
    getCommerceImageSetHistoryAssetKeys, getCommerceShotCandidates, normalizeCommerceImageSetState,
    rememberCommerceShotCandidate, restoreCommerceShotCandidateDraft } from '../js/features/ecommerce-image-set/commerce-image-set-plan.js';
import { resolveCommerceImageSetStyle, updateCommerceArtDirection } from '../js/features/ecommerce-image-set/commerce-art-direction.js';
import { updateCommerceShotReferences } from '../js/features/ecommerce-image-set/commerce-shot-references.js';

const references = ['data:image/png;base64,cHJvZHVjdA=='];
const settings = { platformId: 'taobao', selectedShotIds: ['main', 'detail', 'detail-overview'], plannerModelId: 'vision',
    plannerProviderId: 'provider', productInfo: { name: '随行杯', sellingPoints: ['杯盖可拆卸'] } };
const style = '草木绿与米白，柔和侧光，细腻真实材质，清爽自然的整体氛围。';
const models = [{ id: 'vision', modelId: 'vision', taskType: 'chat', protocol: 'openai', providerIds: ['provider'] }];
const providers = [{ id: 'provider', endpoint: 'https://fixture.test/v1', apikey: 'test' }];

function planner({ omitArtDirection = false } = {}) {
    const requests = [];
    return { requests, options: { references, models, providers, getProxyHeaders: () => ({}),
        fetchRef: async (_url, { body }) => {
            const request = JSON.parse(body);
            const input = JSON.parse(request.messages.at(-1).content[0].text);
            requests.push({ system: request.messages.find(message => message.role === 'system').content, input,
                images: request.messages.at(-1).content.filter(part => part.type === 'image_url').map(part => part.image_url.url) });
            return Response.json({ choices: [{ message: { content: JSON.stringify({ productInfo: settings.productInfo,
                ...(omitArtDirection ? {} : { artDirection: input.currentShot ? '不应另起的红色风格' : style }),
                shots: input.shots.map(({ id }) => ({ id, prompt: `${id}：依据图位用途选择自己的构图。`, headline: '随行杯', body: '杯盖可拆卸' })) }) } }] });
        } } };
}

test('规划先确定并保存整套美术风格，单图重写与生图继续沿用', async () => {
    const { options, requests } = planner();
    const planned = await createCommerceImageSetPlan({ ...options, settings });
    assert.equal(planned.plan.artDirection, style);
    const restored = normalizeCommerceImageSetState(JSON.parse(JSON.stringify(planned)));
    assert.equal(restored.plan.artDirection, style);
    const rewritten = await createCommerceImageSetPlan({ ...options, settings: restored, shotId: 'detail' });
    assert.equal(rewritten.plan.artDirection, style);
    assert.match(requests[1].system, /草木绿与米白/);
    assert.match(requests[1].system, /图位用途要求具体视角时，保留可核实的商品视角，其他构图遵循风格规范/);
    for (const shot of rewritten.plan.shots) {
        const prompt = buildCommerceImageSetImagePrompt({ shot, plan: rewritten.plan });
        assert.match(prompt, /草木绿与米白/);
        assert.match(prompt, /图位用途要求具体视角时，保留可核实的商品视角，其他构图遵循风格规范/);
    }
    assert.equal(await commerceImageSetSourceKey({ settings: rewritten, references }), rewritten.plan.sourceKey);
});

test('手设风格和连接风格有明确优先级，修改后保留旧图并要求重新确认', async () => {
    const { options } = planner();
    const state = await createCommerceImageSetPlan({ ...options, settings: { ...settings, artDirection: '黑白版画，纸张肌理' } });
    assert.equal(state.plan.artDirection, '黑白版画，纸张肌理');
    assert.equal(resolveCommerceImageSetStyle(state).description, '黑白版画，纸张肌理');
    assert.equal(resolveCommerceImageSetStyle(state, { description: '冷蓝水彩' }).description, '冷蓝水彩');
    state.results = [{ shotId: 'main', status: 'completed', assetKey: 'media:kept' }];
    assert.equal(updateCommerceArtDirection(state, '暖棕摄影'), true);
    assert.equal(state.plan.stale, true);
    assert.equal(state.plan.confirmed, false);
    assert.equal(state.results[0].assetKey, 'media:kept');
    assert.equal(resolveCommerceImageSetStyle(state).description, '暖棕摄影');
    updateCommerceArtDirection(state, '', { automatic: true });
    assert.equal(resolveCommerceImageSetStyle(state), null);
});

test('亚马逊新方案生成白底 MAIN，平台首图要求优先于海报风格', async () => {
    const { options, requests } = planner();
    const state = await createCommerceImageSetPlan({ ...options, settings: { ...settings,
        platformId: 'amazon', selectedShotIds: ['main', 'feature'], artDirection: '黑金海报，大标题和舞台背景' } });
    assert.ok(requests[0].input.shots.some(shot => shot.id === 'main'));
    const main = state.plan.shots.find(shot => shot.id === 'main');
    assert.equal(main.source, 'generate');
    assert.equal(main.headline, '');
    assert.equal(main.body, '');
    const prompt = buildCommerceImageSetImagePrompt({ shot: main, plan: state.plan });
    assert.match(prompt, /RGB.*255/);
    assert.match(prompt, /85%/);
    assert.match(prompt, /第一张商品原图/);
    assert.match(prompt, /主图要求.*优先/);
    assert.doesNotMatch(prompt, /风格描述：黑金海报|大标题和舞台背景/);
    const restored = normalizeCommerceImageSetState(JSON.parse(JSON.stringify(state)));
    assert.equal(restored.plan.shots[0].source, 'generate');
    assert.equal(await commerceImageSetSourceKey({ settings: restored, references }), state.plan.sourceKey);
});

test('各图位设计参考按附图序号映射，候选保存恢复仍持有并还原对应参考', async () => {
    const { options, requests } = planner();
    const design = 'data:image/png;base64,ZGVzaWdu';
    const state = await createCommerceImageSetPlan({ ...options,
        settings: { ...settings, shotReferences: { main: ['media:design'], 'detail-overview': ['media:design'] } },
        readReferenceAsset: async key => { assert.equal(key, 'media:design'); return design; }
    });
    assert.deepEqual(requests[0].images, [references[0], design]);
    assert.deepEqual(requests[0].input.shotReferenceMap, { main: [2], 'detail-overview': [2] });
    assert.equal(requests[0].input.productReferenceCount, 1);
    const main = state.plan.shots.find(shot => shot.id === 'main');
    assert.deepEqual(main.referenceAssetKeys, ['media:design']);
    rememberCommerceShotCandidate(state, main, 'media:result');
    updateCommerceShotReferences(state, 'main', ['media:replacement']);
    const restored = normalizeCommerceImageSetState(JSON.parse(JSON.stringify(state)));
    assert.ok(getCommerceImageSetHistoryAssetKeys(restored).includes('media:design'));
    assert.ok(getCommerceImageSetHistoryAssetKeys(restored).includes('media:replacement'));
    const candidate = getCommerceShotCandidates(restored, 'main')[0];
    assert.equal(restoreCommerceShotCandidateDraft(restored, candidate), true);
    assert.deepEqual(restored.shotReferences.main, ['media:design']);
    assert.deepEqual(restored.plan.shots.find(shot => shot.id === 'main').referenceAssetKeys, ['media:design']);
});

test('图位提示以目标和可选手法为主，整套同风格但不固定版式', async () => {
    const { options, requests } = planner();
    const state = await createCommerceImageSetPlan({ ...options, settings });
    assert.match(requests[0].system, /各图位共享这套视觉语言.*构图、景别及信息节奏应按用途变化/);
    assert.match(requests[0].system, /不同商品及参考图可使用不同布局组合和节奏/);
    assert.match(requests[0].input.shots[0].purpose, /可选手法/);
    assert.match(requests[0].input.shots[0].purpose, /不指定固定位置/);
    for (const shot of state.plan.shots) {
        const prompt = buildCommerceImageSetImagePrompt({ shot, plan: state.plan });
        assert.match(prompt, /不强制固定版式/);
        if (shot.group === 'detail') {
            assert.match(prompt, /直接输出这一屏的成品/);
            assert.match(prompt, /在同一次出图中完成商品画面与文案排版/);
        }
        assert.ok(prompt.includes(shot.prompt));
    }
});

test('重设 AI 风格后即使模型漏回该字段，重规划仍保留统一的默认风格', async () => {
    const initial = await createCommerceImageSetPlan({ ...planner().options, settings });
    updateCommerceArtDirection(initial, '', { automatic: true });
    const replanned = await createCommerceImageSetPlan({ ...planner({ omitArtDirection: true }).options, settings: initial });
    assert.ok(replanned.plan.artDirection);
    assert.ok(replanned.plan.visualStyle);
    for (const shot of replanned.plan.shots) {
        assert.equal(shot.visualStyleSnapshot.description, replanned.plan.artDirection);
        assert.ok(buildCommerceImageSetImagePrompt({ shot, plan: replanned.plan }).includes(replanned.plan.artDirection));
    }
});

test('手动清空自设或 AI 风格都明确切回自动设定，不再回退旧风格', () => {
    const newSet = {};
    assert.equal(updateCommerceArtDirection(newSet, ' '), false);
    assert.deepEqual(newSet, {});
    for (const manual of ['', '旧手设风格']) {
        const state = { ...(manual ? { artDirection: manual } : {}),
            plan: { artDirection: '旧 AI 风格', confirmed: true, visualStyle: { description: '旧风格' } } };
        assert.equal(updateCommerceArtDirection(state, ''), true);
        assert.equal(state.artDirection, '');
        assert.equal(state.plan.artDirection, undefined);
        assert.equal(state.plan.stale, true);
        assert.equal(resolveCommerceImageSetStyle(state), null);
        const cleared = structuredClone(state);
        assert.equal(updateCommerceArtDirection(state, ''), false);
        assert.equal(updateCommerceArtDirection(state, '', { automatic: true }), false);
        assert.deepEqual(state, cleared);
    }
});
