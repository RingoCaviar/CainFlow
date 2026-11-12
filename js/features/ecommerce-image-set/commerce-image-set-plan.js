import { createChatRequestPlan, requestChatCompletion } from '../execution/chat-request-plan.js';
import { getEffectiveProtocol, getModelsForTask } from '../execution/provider-request-utils.js';
import { resolveAgentProvider } from '../prompt-agent/prompt-agent-provider.js';

export const COMMERCE_IMAGE_SET_ASPECTS = Object.freeze(['1:1', '3:4', '2:3', '4:5', '9:16', '4:3', '3:2', '16:9']);
export const COMMERCE_IMAGE_SET_DEFAULT_ASPECTS = Object.freeze({ gallery: '1:1', detail: '9:16' });
export const COMMERCE_IMAGE_SET_COPY_LIMITS = Object.freeze({ headline: 24, body: 64 });

const shot = (id, label, purpose, { group = 'gallery', source = 'generate', allowCopy = false } = {}) => Object.freeze({
    id, role: id, label, group, aspect: COMMERCE_IMAGE_SET_DEFAULT_ASPECTS[group], source, purpose, allowCopy
});
const cleanMain = '干净背景下完整展示实际销售商品，产品居中且轮廓清晰，避免遮挡、道具干扰和装饰元素，不添加文案。';
const angle = shot('angle', '多角度图', '选择与首图不同的真实角度，展示商品的侧面、背面或结构，保留商品实际造型，不添加文案。');
const detail = shot('detail', '商品特写', '用近距离构图展示参考图中可核实的纹理、结构或做工，让文案与画面所展示的细节呼应。', { allowCopy: true });
const feature = shot('feature', '卖点图', '突出一个清楚可核实的商品卖点，用构图展示对应设计或功能，让文案与商品的视觉动线一致。', { allowCopy: true });
const scene = shot('scene', '使用场景图', '把商品放在合理的使用环境中，体现具体用途，保持商品为主体，让简短文案融入场景中的留白。', { allowCopy: true });
const detailModules = [
    shot('detail-overview', '详情首屏', '用完整商品作为视觉主体，与标题和商品介绍共同构成首屏的阅读层级，让买家快速识别商品及用途。', { group: 'detail', allowCopy: true }),
    shot('detail-feature', '核心卖点说明', '围绕一个买家关心且有证据的卖点，展示对应的实际商品设计，并用简短文案说明它带来的用途。', { group: 'detail', allowCopy: true }),
    shot('detail-closeup', '细节与做工', '放大参考图能核实的商品细节，保持纹理与结构一致，用文案说明画面展示的位置或用途。', { group: 'detail', allowCopy: true }),
    shot('detail-scene', '场景与用法', '展示符合商品实际用途的生活场景，留出位置说明使用方法或适用场合。', { group: 'detail', allowCopy: true })
];
const preset = (id, label, guide, rulesUrl, gallery) => Object.freeze({
    id, label, guide, rulesUrl, shots: Object.freeze([...gallery, ...detailModules])
});

export const COMMERCE_IMAGE_SET_PRESETS = Object.freeze({
    taobao: preset('taobao', '淘宝／天猫', '先规划方形商品主图。竖图和白底素材要求按类目核对。',
        'https://developer.alibaba.com/support/announcementDetail.htm?id=25721',
        [shot('main', '商品主图', cleanMain), feature, detail, scene,
            shot('white', '白底素材', '纯白背景上完整展示商品，保持颜色与比例，不添加道具、边框或文案。')]),
    jd: preset('jd', '京东', '清楚展示所售商品、实际细节和使用场景。长图需求按类目核对。',
        'https://jdrdl.jd.com/Design-image.html',
        [shot('main', '商品主图', cleanMain), angle, feature, detail, scene]),
    pinduoduo: preset('pinduoduo', '拼多多', '方形轮播图为制作预设。尺寸和活动图位请在商家后台核对。',
        'https://mms.pinduoduo.com/',
        [shot('main', '轮播首图', cleanMain), angle, detail, feature, scene]),
    douyin: preset('douyin', '抖音电商', '将清晰、方形且至少 600 × 600 的实物图作为第一张参考图。首图保留原图。',
        'https://school.jinritemai.com/doudian/web/articlev0/ahean96xqddv',
        [shot('main', '实物首图', '直接使用第一张商品实物参考图。', { source: 'reference' }), angle, detail, feature, scene]),
    amazon: preset('amazon', '亚马逊', '将纯白底、商品完整且无叠字的实拍图放在第一张。MAIN 保留原图，建议最长边至少 1000 像素。',
        'https://sellercentral.amazon.com/help/hub/reference/external/G1881?locale=en_us',
        [shot('main', '白底实拍 MAIN', '直接使用第一张商品白底实拍参考图。', { source: 'reference' }), angle, detail, feature, scene,
            shot('included', '商品组成展示', '仅展示参考图或商品资料确认在包装内的商品和配件，清晰体现实际销售数量，不添加文案。')])
});

const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const copyText = (value, limit) => typeof value === 'string' ? text(value.replace(/\s+/g, ' '), limit) : '';

function normalizeAspect(value, group) {
    return COMMERCE_IMAGE_SET_ASPECTS.includes(value) ? value : COMMERCE_IMAGE_SET_DEFAULT_ASPECTS[group];
}

export function getCommerceImageSetPreset(platformId) {
    return Object.hasOwn(COMMERCE_IMAGE_SET_PRESETS, platformId) ? COMMERCE_IMAGE_SET_PRESETS[platformId] : null;
}

export function getSelectedCommerceImageSetShots(settings) {
    const platform = getCommerceImageSetPreset(settings?.platformId) || COMMERCE_IMAGE_SET_PRESETS.taobao;
    const legacyPlan = settings?.selectedShotIds === undefined && settings?.plan?.version === 1 && settings.plan.platformId === platform.id;
    const ids = legacyPlan && Array.isArray(settings.plan.shots)
        ? settings.plan.shots.map(item => item?.id) : settings?.selectedShotIds;
    const aspects = {
        gallery: normalizeAspect(settings?.galleryAspect, 'gallery'),
        detail: normalizeAspect(settings?.detailAspect, 'detail')
    };
    return Array.isArray(ids) ? platform.shots.filter(item => ids.includes(item.id))
        .map(item => ({ ...item, aspect: aspects[item.group] })) : [];
}

export function normalizeCommerceImageSetPlan(raw, platformId, selectedShotIds, aspectSettings) {
    const platform = getCommerceImageSetPreset(platformId);
    if (!platform || (raw?.platformId && raw.platformId !== platform.id) || !Array.isArray(raw?.sellingPoints) || !Array.isArray(raw?.shots)) {
        throw new Error('套图方案格式无效，请重新规划。');
    }
    const selected = getSelectedCommerceImageSetShots({
        ...aspectSettings, platformId, selectedShotIds: selectedShotIds === undefined ? platform.shots.map(item => item.id) : selectedShotIds
    });
    if (!selected.length) throw new Error('请至少选择一个图位。');
    const knownIds = new Set(selected.map(item => item.id));
    const planned = new Map();
    for (const item of raw.shots) {
        if (!knownIds.has(item?.id) || planned.has(item.id)) throw new Error('套图方案包含重复或未知图位，请重新规划。');
        planned.set(item.id, item);
    }
    const shots = selected.map(item => {
        const input = planned.get(item.id);
        const prompt = item.source === 'generate' ? text(input?.prompt, 2000) : '';
        if (item.source === 'generate' && !prompt) throw new Error(`套图方案缺少「${item.label}」的画面说明。`);
        return { ...item, prompt,
            headline: item.allowCopy ? copyText(input?.headline, COMMERCE_IMAGE_SET_COPY_LIMITS.headline) : '',
            body: item.allowCopy ? copyText(input?.body, COMMERCE_IMAGE_SET_COPY_LIMITS.body) : '' };
    });
    return { version: 1, platformId: platform.id, sellingPoints: [...new Set(raw.sellingPoints.map(value => text(value, 160)).filter(Boolean))].slice(0, 8), shots };
}

export function normalizeCommerceImageSetState(raw) {
    const selected = getSelectedCommerceImageSetShots(raw);
    const settings = {
        platformId: getCommerceImageSetPreset(raw?.platformId)?.id || 'taobao',
        selectedShotIds: selected.map(item => item.id),
        galleryAspect: normalizeAspect(raw?.galleryAspect, 'gallery'),
        detailAspect: normalizeAspect(raw?.detailAspect, 'detail'),
        productNotes: text(raw?.productNotes, 4000),
        plannerModelId: text(raw?.plannerModelId, 200), plannerProviderId: text(raw?.plannerProviderId, 200),
        imageModelId: text(raw?.imageModelId, 200), imageProviderId: text(raw?.imageProviderId, 200),
        plan: null, results: []
    };
    const sourceKey = text(raw?.plan?.sourceKey, 128);
    if (raw?.plan?.version === 1 && sourceKey) {
        try {
            settings.plan = { ...normalizeCommerceImageSetPlan(raw.plan, settings.platformId, settings.selectedShotIds, settings),
                sourceKey, confirmed: raw.plan.confirmed === true };
        } catch { /* Invalid stored plans can be replaced by planning again. */ }
    }
    if (Array.isArray(raw?.results)) {
        const results = new Map(raw.results.map(item => [item?.shotId, item]));
        settings.results = selected.flatMap(({ id }) => {
            const row = results.get(id);
            if (row?.status === 'failed') return [{ shotId: id, status: 'failed', error: text(row.error, 300) }];
            if (row?.status === 'completed' && /^media:[a-zA-Z0-9_-]+$/.test(row.assetKey || '')) {
                return [{ shotId: id, status: 'completed', assetKey: row.assetKey }];
            }
            return [];
        });
    }
    return settings;
}

function normalizeReferences(references) {
    if (!Array.isArray(references) || !references.length || references.length > 5
        || references.some(image => typeof image !== 'string' || !/^(?:data:image\/[^;,]+;base64,|https?:\/\/)/i.test(image))) {
        throw new Error('请连接 1 至 5 张可读取的商品参考图。');
    }
    return references;
}

async function sourceFingerprint(value) {
    if (globalThis.crypto?.subtle) {
        const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
        return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    // LAN browser sessions can lack SubtleCrypto. This key only detects edited inputs.
    let a = 2166136261, b = 0;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        a = Math.imul(a ^ code, 16777619);
        b = Math.imul(b ^ code, 31) + index;
    }
    return `lan-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}-${value.length}`;
}

export async function commerceImageSetSourceKey({ settings, references }) {
    const { platformId, productNotes, plannerModelId, plannerProviderId, selectedShotIds, galleryAspect, detailAspect } = normalizeCommerceImageSetState(settings);
    const images = normalizeReferences(references);
    const hashes = await Promise.all(images.map(sourceFingerprint));
    const inputs = [platformId, productNotes, plannerModelId, plannerProviderId, hashes];
    const platform = getCommerceImageSetPreset(platformId);
    const includesDetail = platform.shots.some(shot => shot.group === 'detail' && selectedShotIds.includes(shot.id));
    const galleryCount = platform.shots.filter(shot => shot.group === 'gallery').length;
    // Older plans only had gallery shots. Full sets saved before slot selection omitted the ID list.
    if (includesDetail || selectedShotIds.length !== galleryCount) inputs.push(selectedShotIds);
    if (includesDetail || galleryAspect !== COMMERCE_IMAGE_SET_DEFAULT_ASPECTS.gallery || detailAspect !== COMMERCE_IMAGE_SET_DEFAULT_ASPECTS.detail) {
        inputs.push({ galleryAspect, detailAspect });
    }
    return sourceFingerprint(JSON.stringify(inputs));
}

export function buildCommerceImageSetImagePrompt({ shot, plan, productNotes }) {
    const platform = getCommerceImageSetPreset(plan.platformId);
    const headline = shot.allowCopy ? copyText(shot.headline, COMMERCE_IMAGE_SET_COPY_LIMITS.headline) : '';
    const body = shot.allowCopy ? copyText(shot.body, COMMERCE_IMAGE_SET_COPY_LIMITS.body) : '';
    const onImageCopy = [headline && `标题：${JSON.stringify(headline)}`, body && `正文：${JSON.stringify(body)}`].filter(Boolean);
    const lettering = onImageCopy.length ? [
        '在同一次出图中完成商品画面与文案排版。遵循画面设计中的文字位置、对齐、字体风格和字色，让文字融入背景与留白，和商品主体共同构图。避免独立于画面的底部色条和贴片。',
        '标题为主要文字，正文使用较小字号并保持合适的行距。文字与背景对比清晰，不遮挡商品，四周留足安全边距。仅有一项文案时按该项重新平衡布局，不保留空文字区。',
        '以以下文案为准，每项只渲染一次，逐字保留，不翻译、不改写，不画出引号、字段名、商品资料或其他说明。禁止额外标语、装饰性假字和水印。',
        ...onImageCopy
    ] : [
        '画面不添加标题、正文、标签或水印，保留参考图中商品和包装原有的文字与商标。将构图的留白用于衬托商品，不预留空白文字区。'
    ];
    return [
        `为${platform?.label || '电商平台'}生成「${shot.label}」成品图，宽高比 ${shot.aspect}。`,
        `图位用途：${shot.purpose}`,
        `画面设计：${shot.prompt}`,
        '商品的外观、颜色、商标、包装与销售数量须与参考图一致。只呈现参考图或资料能证实的商品信息。',
        productNotes && `已确认的商品资料：${productNotes}`,
        plan.sellingPoints.length > 0 && `已确认的卖点：${plan.sellingPoints.join('；')}`,
        '以下文字规则优先于画面设计里的旧文案或排字要求。',
        ...lettering
    ].filter(Boolean).join('\n');
}

export async function createCommerceImageSetPlan({
    settings, references, models, providers, fetchRef, getProxyHeaders, signal, shotId,
    runRequest = (_request, execute) => execute()
}) {
    const input = normalizeCommerceImageSetState(settings);
    if (!input.selectedShotIds.length) throw new Error('请至少选择一个图位。');
    const images = normalizeReferences(references);
    const currentShot = shotId === undefined ? null : input.plan?.shots.find(shot => shot.id === shotId);
    if (shotId !== undefined && currentShot?.source !== 'generate') throw new Error('请选择一个需要生图的图位。');
    if (currentShot && input.plan.sourceKey !== await commerceImageSetSourceKey({ settings: input, references: images })) {
        throw new Error('商品资料、参考图、图位或规划模型已改变，请重新规划整套方案。');
    }
    const platform = getCommerceImageSetPreset(input.platformId);
    const model = getModelsForTask(models, 'chat').find(item => item.id === input.plannerModelId);
    if (!model) throw new Error('请选择支持图片输入的规划模型。');
    const provider = resolveAgentProvider(model, providers, input.plannerProviderId);
    const protocol = getEffectiveProtocol(model, provider);
    const selectedShotIds = currentShot ? [currentShot.id] : input.selectedShotIds;
    const slots = getSelectedCommerceImageSetShots({ ...input, selectedShotIds }).filter(item => item.source === 'generate');
    const request = createChatRequestPlan({
        model, provider, protocol,
        capabilities: { imageInput: model.capabilities?.imageInput !== false },
        systemPrompt: [
            '你负责规划电商商品主副图和详情页图片。只提取参考图可观察到或商品资料明确提供的卖点。不要推断尺寸、材质、功效、认证、销量或价格。',
            '保持同一商品的外观、颜色、商标、包装和销售数量。图中不得添加虚构标签、促销标识或其他商品。不使用逼真的生成式人物。',
            '按各图位的用途和宽高比设计不同的画面。主副图用于商品列表和轮播展示，详情图各自说明一个主题，依次组成详情页内容。',
            '输出纯 JSON，包含 sellingPoints（字符串数组）和 shots（每项仅含 id、prompt、headline、body）。只为给定 id 编写方案。',
            '每个 prompt 都应写清画面内容、构图和摄影风格，具体到展示的商品部位、场景、景别、拍摄角度、主体位置、光线和色调。全套图片协调统一，每个图位有自己的构图重点。',
            'allowCopy 为 true 且有文案时，在 prompt 中描述与商品构图融为一体的文字布局，指定标题和正文的位置、对齐、层级、字体风格和字色，保证阅读对比度，不遮挡实物。用“标题”“正文”指代，不在 prompt 中重复实际文案。',
            'headline 和 body 分别填写要出现在图上的短标题和辅助说明，具体、自然，贴合本图用途。避免多张图重复同样的文案。缺少合适证据时留空。',
            'allowCopy 为 false 的图位两项留空，画面不添加额外文字。遵循商品资料指定的语言，默认亚马逊使用英语，其他平台使用简体中文。',
            currentShot && '只重新规划指定图位。以现有商品卖点为依据，参考当前草稿提出新的构图或文案。'
        ].filter(Boolean).join('\n'),
        messages: [{ role: 'user', content: JSON.stringify({ platform: platform.label, productNotes: input.productNotes,
            copyLimits: COMMERCE_IMAGE_SET_COPY_LIMITS,
            ...(currentShot ? { currentShot: { prompt: currentShot.prompt, headline: currentShot.headline, body: currentShot.body },
                sellingPoints: input.plan.sellingPoints } : {}),
            shots: slots.map(({ id, label, group, aspect, purpose, allowCopy }) => ({ id, label, group, aspect, purpose, allowCopy })) }) }],
        media: images.map(url => ({ type: 'image', url }))
    });
    const providerHeaders = { 'Content-Type': 'application/json',
        ...(request.protocol === 'openai' ? { Authorization: `Bearer ${provider.apikey}` } : {}) };
    const headers = getProxyHeaders?.(request.url, request.method, providerHeaders);
    const { raw, plan } = await runRequest(request, async () => {
        const { text: reply } = await requestChatCompletion(request, { fetchRef, headers, signal });
        signal?.throwIfAborted();
        let raw;
        try { raw = JSON.parse(reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
        catch { throw new Error('规划模型未返回有效套图方案，请重试。'); }
        return { raw, plan: normalizeCommerceImageSetPlan(raw, platform.id, selectedShotIds, input) };
    }, currentShot);
    const missingHeadlines = new Set(raw.shots.filter(shot => !Object.hasOwn(shot, 'headline')).map(shot => shot.id));
    const usedHeadlines = new Set(plan.shots.map(shot => shot.headline));
    const sellingPoints = currentShot ? input.plan.sellingPoints : plan.sellingPoints;
    if (currentShot) {
        for (const shot of input.plan.shots) {
            if (shot.id !== currentShot.id) usedHeadlines.add(shot.headline);
        }
    }
    for (const shot of plan.shots) {
        if (!['feature', 'detail-feature'].includes(shot.id) || shot.body || !missingHeadlines.has(shot.id)) continue;
        const fallback = sellingPoints.find(point => point.length <= COMMERCE_IMAGE_SET_COPY_LIMITS.headline && !usedHeadlines.has(point));
        if (!fallback) continue;
        shot.headline = copyText(fallback, COMMERCE_IMAGE_SET_COPY_LIMITS.headline);
        usedHeadlines.add(fallback);
    }
    if (currentShot) return { ...input.plan, confirmed: false,
        shots: input.plan.shots.map(shot => shot.id === currentShot.id ? plan.shots[0] : shot) };
    return { ...plan, sourceKey: await commerceImageSetSourceKey({ settings: input, references: images }), confirmed: false };
}
