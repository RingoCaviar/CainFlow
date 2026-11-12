import test from 'node:test';
import assert from 'node:assert/strict';
import {
    COMMERCE_IMAGE_SET_PRESETS, buildCommerceImageSetImagePrompt, createCommerceImageSetPlan,
    commerceImageSetSourceKey, normalizeCommerceImageSetPlan, normalizeCommerceImageSetState
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
    const plan = await createCommerceImageSetPlan({
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

test('a blank or no-copy slot still preserves original product labels without adding copy', () => {
    const plan = normalizeCommerceImageSetPlan({ sellingPoints: [], shots: [
        { id: 'detail', prompt: '对焦杯身。' }, { id: 'white', prompt: '白底正面展示。' }
    ] }, 'taobao', ['detail', 'white']);
    const [blankCopy, noCopy] = plan.shots;
    for (const shot of [blankCopy, { ...noCopy, headline: '不支持的文案', body: '额外说明' }]) {
        const prompt = buildCommerceImageSetImagePrompt({ shot, plan });
        assert.match(prompt, /不添加标题、正文、标签或水印，保留参考图中商品和包装原有的文字与商标/);
        assert.doesNotMatch(prompt, /^(?:标题|正文)：|不支持的文案|额外说明/m);
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
    assert.equal(loaded.plan.confirmed, true);
    assert.ok(loaded.plan.shots.every(shot => shot.group === 'gallery' && shot.aspect === '1:1' && !shot.headline && !shot.body));
    assert.equal(await commerceImageSetSourceKey({ settings: loaded, references }), sourceKey);
    assert.deepEqual(normalizeCommerceImageSetState(legacy).selectedShotIds, []);
    assert.equal(normalizeCommerceImageSetState({ ...loaded, selectedShotIds }).plan, null);
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
