import test from 'node:test';
import assert from 'node:assert/strict';
import {
    COMMERCE_IMAGE_SET_PRESETS, appendCommerceSceneShot, buildCommerceImageSetImagePrompt, confirmCommerceSceneShot,
    createCommerceImageSetPlan, commerceImageSetPlanningSettingsKey, commerceImageSetSourceKey, commerceShotPlanKey,
    getRunnableCommerceImageSetShots, getUnfinishedCommerceImageSetShots, normalizeCommerceImageSetPlan,
    isCommerceShotImageStale, normalizeCommerceImageSetState, updateCommerceSceneDescription
} from '../js/features/ecommerce-image-set/commerce-image-set-plan.js';

const references = ['data:image/png;base64,aGVsbG8='];
const settings = { platformId: 'amazon', productNotes: '白色马克杯', plannerModelId: 'vision', plannerProviderId: 'provider',
    selectedShotIds: ['feature', 'main', 'detail'] };
const models = [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['provider'] }];
const providers = [{ id: 'provider', endpoint: 'https://fixture.test/v1', apikey: 'test' }];

test('the platform-aware planner sends the original product photo and returns an unconfirmed plan with a real Amazon main image', async () => {
    assert.deepEqual(Object.keys(COMMERCE_IMAGE_SET_PRESETS), ['taobao', 'jd', 'pinduoduo', 'douyin', 'amazon']);
    const mixedSettings = { ...settings, selectedShotIds: [...settings.selectedShotIds, 'detail-overview'],
        galleryAspect: '4:3', detailAspect: '2:3' };
    const expectedIds = ['detail', 'feature', 'detail-overview'];
    let request;
    const { plan } = await createCommerceImageSetPlan({
        settings: mixedSettings, references, models, providers,
        getProxyHeaders: (_url, _method, headers) => headers,
        fetchRef: async (path, options) => {
            request = { path, headers: options.headers, body: JSON.parse(options.body) };
            const content = JSON.stringify({ sellingPoints: ['杯柄便于握持'],
                shots: expectedIds.toReversed().map(id => ({ id, prompt: `展示${id}视图`,
                    ...(id === 'detail-overview' ? { headline: 'A cup for every day', body: 'A sturdy handle for a comfortable grip' } : {}) })) });
            return Response.json({ choices: [{ message: { content } }] });
        }
    });
    assert.equal(request.path, '/proxy');
    assert.equal(request.headers.Authorization, 'Bearer test');
    const systemPrompt = request.body.messages.find(message => message.role === 'system').content;
    assert.match(systemPrompt, /画面内容、构图和摄影风格/);
    assert.match(systemPrompt, /文字布局.*位置、对齐、层级、字体风格和字色/);
    assert.match(systemPrompt, /不在 prompt 中重复实际文案/);
    const input = request.body.messages.at(-1).content;
    assert.match(input[0].text, /白色马克杯/);
    const requestedShots = JSON.parse(input[0].text).shots;
    assert.deepEqual(requestedShots.map(({ id, group, aspect }) => [id, group, aspect]), [
        ['detail', 'gallery', '4:3'], ['feature', 'gallery', '4:3'], ['detail-overview', 'detail', '2:3']
    ]);
    assert.ok(requestedShots.every(shot => shot.allowCopy && shot.purpose));
    assert.equal(input[1].image_url.url, references[0]);
    assert.equal(plan.confirmed, false);
    assert.deepEqual(plan.sellingPoints, ['杯柄便于握持']);
    assert.deepEqual(plan.shots.map(shot => shot.id), ['main', ...expectedIds]);
    assert.equal(plan.shots[0].source, 'reference');
    assert.equal(plan.shots[0].prompt, '');
    assert.equal(plan.shots.find(shot => shot.id === 'feature').headline, '杯柄便于握持');
    assert.equal(plan.shots.find(shot => shot.id === 'detail-overview').headline, 'A cup for every day');
    assert.notEqual(plan.sourceKey, await commerceImageSetSourceKey({ settings: mixedSettings, references: ['data:image/png;base64,d29ybGQ='] }));
    assert.notEqual(plan.sourceKey, await commerceImageSetSourceKey({ settings: { ...mixedSettings, selectedShotIds: ['detail'] }, references }));
    assert.notEqual(plan.sourceKey, await commerceImageSetSourceKey({ settings: { ...mixedSettings, detailAspect: '3:4' }, references }));
    assert.equal(plan.sourceKey, await commerceImageSetSourceKey({ settings: { ...mixedSettings, imageModelId: 'choose-after-planning' }, references }));
    const restored = normalizeCommerceImageSetState({ ...mixedSettings, plan });
    assert.deepEqual(restored.plan.shots, plan.shots);
});

test('the image model receives the composition and only the latest approved copy for a shot', () => {
    const plan = normalizeCommerceImageSetPlan({ sellingPoints: ['可拆杯盖'], shots: [{
        id: 'detail-overview', prompt: '暖色侧光，马克杯位于下半幅，上方留白中的标题居左，暖灰无衬线字。',
        headline: '初稿标题', body: '原始说明'
    }] }, 'amazon', ['detail-overview']);
    const shot = { ...plan.shots[0], headline: '外出好携带', body: '  ' };
    const prompt = buildCommerceImageSetImagePrompt({ shot, plan, productNotes: '带一个杯盖' });
    assert.match(prompt, /亚马逊.*详情首屏.*9:16/);
    assert.ok(prompt.includes(shot.prompt));
    assert.match(prompt, /已确认的商品资料：带一个杯盖/);
    assert.match(prompt, /已确认的卖点：可拆杯盖/);
    assert.match(prompt, /同一次出图.*文案排版/);
    assert.match(prompt, /^标题："外出好携带"$/m);
    assert.doesNotMatch(prompt, /^正文：|初稿标题|原始说明/m);
});

test('explicit copy language applies to planning, rewriting and image prompt lettering', async () => {
    const requests = [];
    const options = { references, models, providers, fetchRef: async (_path, { body }) => {
        const { messages } = JSON.parse(body);
        const system = messages.find(message => message.role === 'system').content;
        const input = JSON.parse(messages.at(-1).content[0].text);
        requests.push({ system, input });
        const shots = input.shots.map(({ id }) => id === 'feature' ? { id, prompt: '展示杯柄' } : {
            id, prompt: '用柔光突出马克杯', headline: input.currentShot ? '毎日使えるマグ' : '持ちやすいマグ', body: '手になじむ持ち手'
        });
        return Response.json({ choices: [{ message: { content: JSON.stringify({
            ...(input.currentShot ? {} : { sellingPoints: ['杯柄好握'] }), shots
        }) } }] });
    } };
    const planned = await createCommerceImageSetPlan({
        ...options, settings: { ...settings, copyLanguage: 'ja' }
    });
    const rewritten = await createCommerceImageSetPlan({ ...options, settings: planned, shotId: 'detail' });
    assert.equal(planned.copyLanguage, 'ja');
    assert.equal(planned.plan.copyLanguage, 'ja');
    for (const { input, system } of requests) {
        assert.equal(input.copyLanguage, 'ja');
        assert.match(system, /headline 和 body.*日语/);
    }
    assert.deepEqual(planned.productInfo.sellingPoints, ['杯柄好握']);
    assert.equal(planned.plan.shots.find(shot => shot.id === 'feature').headline, '');
    const detail = rewritten.plan.shots.find(shot => shot.id === 'detail');
    assert.equal(detail.headline, '毎日使えるマグ');
    const prompt = buildCommerceImageSetImagePrompt({ shot: detail, plan: rewritten.plan });
    assert.match(prompt, /图中文字语言：日语/);
    assert.match(prompt, /^标题："毎日使えるマグ"$/m);
    assert.match(prompt, /^正文："手になじむ持ち手"$/m);
    assert.notEqual(planned.plan.sourceKey, await commerceImageSetSourceKey({ settings: { ...planned, copyLanguage: 'fr' }, references }));
    const restored = normalizeCommerceImageSetState({ ...planned, copyLanguage: 'fr', plan: { ...planned.plan, confirmed: true } });
    assert.equal(restored.plan.copyLanguage, 'ja');
    assert.equal(restored.plan.stale, true);
    assert.equal(restored.plan.confirmed, false);
});

test('a blank or no-copy slot still preserves original product labels without adding copy', () => {
    const plan = normalizeCommerceImageSetPlan({ sellingPoints: [], shots: [
        { id: 'detail', prompt: '对焦杯身。' }, { id: 'white', prompt: '白底正面展示。' }
    ] }, 'taobao', ['detail', 'white'], { copyLanguage: 'ja' });
    const [blankCopy, noCopy] = plan.shots;
    for (const shot of [blankCopy, { ...noCopy, headline: '不支持的文案', body: '额外说明' }]) {
        const prompt = buildCommerceImageSetImagePrompt({ shot, plan });
        assert.match(prompt, /不添加标题、正文、标签或水印，保留参考图中商品和包装原有的文字与商标/);
        assert.doesNotMatch(prompt, /^(?:标题|正文|图中文字语言)：|不支持的文案|额外说明/m);
    }
});

test('the planner requires at least one selection and rejects a response containing an unselected platform slot', async () => {
    await assert.rejects(createCommerceImageSetPlan({ settings: { ...settings, selectedShotIds: [] }, references, models, providers,
        fetchRef: () => assert.fail('No request should be sent for an empty selection.') }), /选择.*图位/);
    await assert.rejects(createCommerceImageSetPlan({ settings: { ...settings, selectedShotIds: ['detail'] }, references, models, providers,
        fetchRef: async () => Response.json({ choices: [{ message: { content: JSON.stringify({
            sellingPoints: [], shots: [{ id: 'detail', prompt: '展示杯盖' }, { id: 'scene', prompt: '桌面' }]
        }) } }] }) }), /未知图位/);
});

test('loading a pre-selection workflow preserves the approved set and its original source key', async () => {
    const { selectedShotIds, ...legacy } = settings;
    const allIds = ['main', 'angle', 'detail', 'feature', 'scene', 'included'];
    const sourceKey = '51602be35ee0c4ed2e5a78f8b3315dfc2d9efa3d0ff487f613e285e12e454303';
    const loaded = normalizeCommerceImageSetState({ ...legacy, plan: { version: 1, platformId: 'amazon', confirmed: true,
        sourceKey, sellingPoints: [], shots: allIds.map(id => ({ id, prompt: '展示商品' })) } });
    assert.deepEqual(loaded.selectedShotIds, allIds);
    assert.equal(loaded.copyLanguage, 'auto');
    assert.equal(loaded.plan.copyLanguage, 'auto');
    assert.equal(loaded.plan.confirmed, true);
    assert.ok(loaded.plan.shots.every(shot => shot.group === 'gallery' && shot.aspect === '1:1' && !shot.headline && !shot.body));
    assert.equal(await commerceImageSetSourceKey({ settings: loaded, references }), sourceKey);
    assert.deepEqual(normalizeCommerceImageSetState(legacy).selectedShotIds, []);
    assert.equal(normalizeCommerceImageSetState({ ...loaded, selectedShotIds }).plan, null);
});

test('restoring a draft allows a cleared prompt while planner responses and missing shot drafts are rejected', async () => {
    const selectedShotIds = ['detail', 'feature'];
    const raw = { sellingPoints: [], shots: [{ id: 'detail', prompt: '' }, { id: 'feature', prompt: '展示杯柄' }] };
    const saved = { ...settings, selectedShotIds, plan: { ...raw, version: 1, sourceKey: 'saved-key' } };
    const restored = normalizeCommerceImageSetState(JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(restored.plan?.shots.map(({ id, prompt }) => [id, prompt]), [['detail', ''], ['feature', '展示杯柄']]);
    assert.throws(() => normalizeCommerceImageSetPlan(raw, 'amazon', selectedShotIds), /缺少.*画面说明/);
    assert.equal(normalizeCommerceImageSetState({ ...saved, plan: { ...saved.plan, shots: raw.shots.slice(1) } }).plan, null);
    assert.equal(normalizeCommerceImageSetState({ ...saved, plan: { ...saved.plan, shots: [{ id: 'detail' }, raw.shots[1]] } }).plan, null);
});

test('restoring older completed images records a stable baseline for each generated shot', () => {
    const restored = normalizeCommerceImageSetState({ ...settings,
        plan: { version: 1, sourceKey: 'saved-key', sellingPoints: [],
            shots: [{ id: 'main' }, { id: 'detail', prompt: '展示杯身', headline: '商品细节', body: '保留纹理' },
                { id: 'feature', prompt: '展示杯柄' }] },
        results: ['main', 'detail', 'feature'].map(shotId => ({ shotId, status: 'completed', assetKey: `media:${shotId}` }))
    });
    const [originalPhoto, detail, feature] = restored.results;
    assert.equal(originalPhoto.planKey, undefined);
    assert.ok(detail.planKey);
    assert.ok(feature.planKey);

    const [, detailShot, featureShot] = restored.plan.shots;
    assert.equal(isCommerceShotImageStale(detailShot, detail), false);
    assert.equal(isCommerceShotImageStale({ ...detailShot, prompt: ' 展示杯身 ', headline: '商品细节 ' }, detail), false);
    detailShot.body = '新版本正文';
    const reopened = normalizeCommerceImageSetState(JSON.parse(JSON.stringify(restored)));
    assert.deepEqual(reopened.results, restored.results);
    assert.equal(isCommerceShotImageStale(reopened.plan.shots[1], reopened.results[1]), true);
    assert.equal(isCommerceShotImageStale(featureShot, feature), false);
});

test('platform slots reject an unexpected AI-generated shot and retain real-product first images', () => {
    for (const id of ['taobao', 'jd', 'pinduoduo', 'douyin', 'amazon']) {
        const platform = COMMERCE_IMAGE_SET_PRESETS[id];
        const shots = platform.shots.map(item => ({ id: item.id, source: 'generate', aspect: '3:2', group: 'unexpected',
            prompt: '展示商品', headline: '  商品\n标题  ', body: '句'.repeat(70) }));
        const plan = normalizeCommerceImageSetPlan({ sellingPoints: [], shots }, id);
        assert.equal(plan.shots[0].source, ['douyin', 'amazon'].includes(id) ? 'reference' : 'generate');
        assert.equal(plan.shots[0].headline, '');
        assert.equal(plan.shots[0].body, '');
        assert.ok(plan.shots.filter(shot => shot.group === 'gallery').every(shot => shot.aspect === '1:1'));
        const detailShots = plan.shots.filter(shot => shot.group === 'detail');
        assert.deepEqual(detailShots.map(shot => shot.id), ['detail-overview', 'detail-feature', 'detail-closeup', 'detail-scene']);
        assert.ok(detailShots.every(shot => shot.aspect === '9:16' && shot.headline === '商品 标题' && shot.body.length === 64));
        assert.throws(() => normalizeCommerceImageSetPlan({ sellingPoints: [], shots: [...shots, { id: 'other', prompt: '新增' }] }, id), /未知图位/);
    }
});

async function baseScenePlan() {
    const input = { ...settings, selectedShotIds: ['scene', 'detail-overview'], galleryAspect: '4:5', detailAspect: '3:4' };
    const sourceKey = await commerceImageSetSourceKey({ settings: input, references });
    return normalizeCommerceImageSetState({ ...input, plan: { version: 1, sourceKey, confirmed: true,
        sellingPoints: ['好拿取'], shots: [{ id: 'scene', prompt: '厨房台面展示马克杯' }, { id: 'detail-overview', prompt: '侧光展示杯柄' }] },
        results: [{ shotId: 'scene', status: 'completed', assetKey: 'media:gallery' },
            { shotId: 'detail-overview', status: 'completed', assetKey: 'media:detail' }] });
}

test('supplemental scenes persist in each group without changing an existing source key, plan or results', async () => {
    const state = await baseScenePlan();
    const original = structuredClone(state);
    const gallery = appendCommerceSceneShot(state, 'gallery');
    const detail = appendCommerceSceneShot(state, 'detail');
    const focusedKey = commerceImageSetPlanningSettingsKey(state, gallery.id);
    const secondGallery = appendCommerceSceneShot(state, 'gallery');
    assert.notEqual(secondGallery.id, gallery.id);
    assert.match(gallery.id, /^scene-/);
    assert.equal(commerceImageSetPlanningSettingsKey(state, gallery.id), focusedKey);
    const restored = normalizeCommerceImageSetState(JSON.parse(JSON.stringify(state)));
    assert.equal(restored.plan.sourceKey, original.plan.sourceKey);
    assert.equal(restored.plan.confirmed, true);
    assert.equal(await commerceImageSetSourceKey({ settings: restored, references }), original.plan.sourceKey);
    assert.deepEqual(restored.plan.shots.map(({ id, aspect }) => [id, aspect]), [
        ['scene', '4:5'], [gallery.id, '4:5'], [secondGallery.id, '4:5'], ['detail-overview', '3:4'], [detail.id, '3:4']
    ]);
    assert.deepEqual(restored.plan.shots.filter(shot => !shot.customScene), original.plan.shots);
    assert.deepEqual(restored.results, original.results);
    assert.deepEqual(getRunnableCommerceImageSetShots(restored), original.plan.shots);
    assert.deepEqual(getUnfinishedCommerceImageSetShots(restored), []);
});

test('a scene planner takes the optional brief, sees existing scenes and needs explicit confirmation', async () => {
    const state = await baseScenePlan();
    const current = appendCommerceSceneShot(state, 'gallery');
    const suggested = appendCommerceSceneShot(state, 'detail');
    updateCommerceSceneDescription(state, current.id, '  咖啡店窗边的工作桌  ');
    assert.equal(confirmCommerceSceneShot(state, current.id), false);
    const requests = [];
    const options = { references, models, providers, fetchRef: async (_path, { body }) => {
        const { messages } = JSON.parse(body);
        const input = JSON.parse(messages.at(-1).content[0].text);
        requests.push({ input, system: messages[0].content });
        return Response.json({ choices: [{ message: { content: JSON.stringify({
            shots: [{ id: input.shots[0].id, prompt: '将商品置于画面中部的桌面', sceneSummary: '窗边柔光衬托杯身', headline: '日常用杯' }]
        }) } }] });
    } };
    const first = await createCommerceImageSetPlan({ ...options, settings: state, shotId: current.id });
    const second = await createCommerceImageSetPlan({ ...options, settings: first, shotId: suggested.id });
    assert.deepEqual(requests.map(({ input }) => [input.sceneDescription, input.shots[0].group, input.shots[0].aspect]),
        [['咖啡店窗边的工作桌', 'gallery', '4:5'], ['', 'detail', '3:4']]);
    assert.deepEqual(requests[0].input.existingScenes.map(({ summary }) => summary), ['厨房台面展示马克杯']);
    assert.deepEqual(requests[1].input.existingScenes.map(({ summary }) => summary), ['厨房台面展示马克杯', '窗边柔光衬托杯身']);
    assert.match(requests[1].system, /sceneSummary/);
    assert.equal(first.plan.confirmed, true);
    assert.equal(first.plan.shots.find(({ id }) => id === current.id).sceneSummary, '窗边柔光衬托杯身');
    assert.equal(second.plan.shots.find(({ id }) => id === suggested.id).sceneConfirmed, false);
    assert.deepEqual(second.results, state.results);
    assert.deepEqual(getUnfinishedCommerceImageSetShots(second), []);
    assert.equal(confirmCommerceSceneShot(second, suggested.id), true);
    assert.deepEqual(getUnfinishedCommerceImageSetShots(second).map(({ id }) => id), [suggested.id]);
    assert.equal(updateCommerceSceneDescription(second, suggested.id, '早餐桌边'), true);
    const reset = second.plan.shots.find(({ id }) => id === suggested.id);
    assert.deepEqual([reset.sceneSummary, reset.prompt, reset.sceneConfirmed], ['', '', false]);
    assert.deepEqual(getUnfinishedCommerceImageSetShots(second), []);
    assert.equal(second.plan.confirmed, true);
});

test('replanning preset shots keeps supplemental scene briefs and only reuses scene plans for matching inputs', async () => {
    const state = await baseScenePlan();
    const scene = appendCommerceSceneShot(state, 'detail');
    updateCommerceSceneDescription(state, scene.id, '书桌旁');
    const options = { references, models, providers, fetchRef: async (_path, { body }) => {
        const { messages } = JSON.parse(body);
        const input = JSON.parse(messages.at(-1).content[0].text);
        if (!input.currentShot) assert.deepEqual(input.shots.map(({ id }) => id), ['scene', 'detail-overview']);
        return Response.json({ choices: [{ message: { content: JSON.stringify({
            ...(input.currentShot ? {} : { sellingPoints: input.productInfo.sellingPoints }),
            shots: input.shots.map(({ id }) => ({ id, prompt: '柔光照在杯身上', sceneSummary: '窗边马克杯' }))
        }) } }] });
    } };
    const planned = await createCommerceImageSetPlan({ ...options, settings: state, shotId: scene.id });
    assert.equal(confirmCommerceSceneShot(planned, scene.id), true);
    const approved = planned.plan.shots.find(({ id }) => id === scene.id);
    const completed = { shotId: scene.id, status: 'completed', assetKey: 'media:supplemental', planKey: commerceShotPlanKey(approved) };
    planned.results.push(completed);
    const refreshed = await createCommerceImageSetPlan({ ...options, settings: planned });
    assert.deepEqual(refreshed.plan.shots.find(({ id }) => id === scene.id), approved);
    assert.deepEqual(refreshed.results, [completed]);
    const changed = await createCommerceImageSetPlan({ ...options, settings: planned, references: ['data:image/png;base64,d29ybGQ='] });
    const pending = changed.plan.shots.find(({ id }) => id === scene.id);
    assert.equal(pending.description, '书桌旁');
    assert.equal(pending.prompt, '');
    assert.equal(pending.sceneConfirmed, false);
    assert.deepEqual(changed.results, []);
});
