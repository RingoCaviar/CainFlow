import { generateId } from '../../core/common-utils.js';
import { createChatRequestPlan, requestChatCompletion } from '../execution/chat-request-plan.js';
import { getEffectiveProtocol, getModelsForTask } from '../execution/provider-request-utils.js';
import { resolveAgentProvider } from '../prompt-agent/prompt-agent-provider.js';

export const COMMERCE_IMAGE_SET_ASPECTS = Object.freeze(['1:1', '3:4', '2:3', '4:5', '9:16', '4:3', '3:2', '16:9']);
export const COMMERCE_IMAGE_SET_DEFAULT_ASPECTS = Object.freeze({ gallery: '1:1', detail: '9:16' });
export const COMMERCE_IMAGE_SET_COPY_LIMITS = Object.freeze({ headline: 24, body: 64 });
export const COMMERCE_SCENE_DESCRIPTION_LIMIT = 400;
export const COMMERCE_SHOT_CANDIDATE_LIMIT = 4;
const COMMERCE_SCENE_SUMMARY_LIMIT = 240;
const COMMERCE_SHOT_PLAN_KEY_PATTERN = /^v1-[0-9a-f]{1,8}-[0-9a-f]{1,8}-\d{1,5}$/;
const COMMERCE_ASSET_KEY_PATTERN = /^media:[a-zA-Z0-9_-]+$/;
export const COMMERCE_IMAGE_SET_COPY_LANGUAGES = Object.freeze({
    auto: '自动', 'zh-CN': '简体中文', 'zh-TW': '繁体中文', en: '英语', ja: '日语', ko: '韩语',
    de: '德语', fr: '法语', es: '西班牙语', it: '意大利语', pt: '葡萄牙语', nl: '荷兰语',
    ru: '俄语', ar: '阿拉伯语', th: '泰语', vi: '越南语', id: '印度尼西亚语'
});
export const COMMERCE_PRODUCT_INFO_LIMITS = Object.freeze({
    name: 160, sellingPoint: 160, sellingPoints: 8, audience: 400, useCases: 800, details: 4000
});

export function normalizeCommerceImageSetCandidateCount(value) {
    return Number.isInteger(value) && value >= 1 && value <= COMMERCE_SHOT_CANDIDATE_LIMIT ? value : 1;
}

function normalizePartialCandidateProgress(progress) {
    const { completed, total } = progress || {};
    return Number.isInteger(completed) && completed > 0 && completed < total
        && total === normalizeCommerceImageSetCandidateCount(total) ? { completed, total } : null;
}

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
const isCopyLanguage = value => typeof value === 'string' && Object.hasOwn(COMMERCE_IMAGE_SET_COPY_LANGUAGES, value);

export function normalizeCommerceImageSetCopyLanguage(value) {
    return isCopyLanguage(value) ? value : 'auto';
}

export function updateCommerceImageSetCopyLanguage(settings, value) {
    if (!isCopyLanguage(value) || normalizeCommerceImageSetCopyLanguage(settings.copyLanguage) === value) return false;
    settings.copyLanguage = value;
    if (settings.plan) {
        settings.plan.confirmed = false;
        settings.plan.stale = true;
        settings.plan.shots?.forEach(markCommerceSceneForReview);
    }
    return true;
}

export function normalizeCommerceProductInfo(raw) {
    const limits = COMMERCE_PRODUCT_INFO_LIMITS;
    return {
        name: text(raw?.name, limits.name),
        sellingPoints: Array.isArray(raw?.sellingPoints)
            ? [...new Set(raw.sellingPoints.map(value => copyText(value, limits.sellingPoint)).filter(Boolean))].slice(0, limits.sellingPoints)
            : [],
        audience: text(raw?.audience, limits.audience),
        useCases: text(raw?.useCases, limits.useCases),
        details: text(raw?.details, limits.details)
    };
}

export function getCommerceProductInfo(settings) {
    return normalizeCommerceProductInfo({
        details: settings?.productNotes,
        sellingPoints: settings?.plan?.sellingPoints,
        ...settings?.productInfo
    });
}

const hasProductValue = value => value.length > 0;
const sameProductValue = (first, second) => JSON.stringify(first) === JSON.stringify(second);

export function updateCommerceProductInfoField(settings, key, value) {
    const previous = getCommerceProductInfo(settings);
    if (!Object.hasOwn(previous, key)) return false;
    const next = normalizeCommerceProductInfo({ ...previous, [key]: value });
    const auto = normalizeCommerceProductInfo(settings.autoProductInfo);
    const changed = !sameProductValue(previous[key], next[key]);
    const wasAuto = hasProductValue(auto[key]) && sameProductValue(previous[key], auto[key]);
    if (!changed && !wasAuto) return false;
    settings.productInfo = next;
    settings.autoProductInfo = normalizeCommerceProductInfo({ ...auto, [key]: undefined });
    delete settings.productNotes;
    if (changed && settings.plan) {
        settings.plan.confirmed = false;
        if (key === 'sellingPoints') settings.plan.sellingPoints = next.sellingPoints;
        else settings.plan.stale = true;
        settings.plan.shots?.forEach(markCommerceSceneForReview);
    }
    return true;
}

function getManualProductInfo(settings) {
    const product = settings.productInfo;
    return normalizeCommerceProductInfo(Object.fromEntries(Object.entries(product)
        .filter(([key, value]) => !sameProductValue(value, settings.autoProductInfo[key]))));
}

function mergeCommerceProductInfo(manual, detected) {
    const autoProductInfo = normalizeCommerceProductInfo(Object.fromEntries(Object.entries(detected)
        .filter(([key]) => !hasProductValue(manual[key]))));
    const productInfo = Object.fromEntries(Object.entries(manual)
        .map(([key, value]) => [key, hasProductValue(value) ? value : autoProductInfo[key]]));
    return { productInfo, autoProductInfo };
}

function normalizeAspect(value, group) {
    return COMMERCE_IMAGE_SET_ASPECTS.includes(value) ? value : COMMERCE_IMAGE_SET_DEFAULT_ASPECTS[group];
}

function isCommerceShotGroup(group) {
    return typeof group === 'string' && Object.hasOwn(COMMERCE_IMAGE_SET_DEFAULT_ASPECTS, group);
}

function isCommerceSceneId(id) {
    return typeof id === 'string' && /^scene-[a-z0-9_-]{1,64}$/.test(id);
}

function normalizeCustomScenes(raw) {
    const scenes = new Map();
    for (const item of Array.isArray(raw) ? raw : []) {
        if (!isCommerceSceneId(item?.id) || !isCommerceShotGroup(item.group) || scenes.has(item.id)) continue;
        scenes.set(item.id, { id: item.id, group: item.group, description: text(item.description, COMMERCE_SCENE_DESCRIPTION_LIMIT) });
    }
    return [...scenes.values()];
}

function customSceneShot(item, groupIndex, aspect) {
    const design = item.group === 'gallery' ? scene : detailModules.at(-1);
    return { ...design, id: item.id, label: `场景图 ${groupIndex + 1}`, aspect,
        customScene: true, description: item.description };
}

function scenePromptKey(prompt) {
    const value = text(prompt, 2000);
    return value ? changeFingerprint(value) : '';
}

export function getCommerceSceneSummary(shot, limit = COMMERCE_SCENE_SUMMARY_LIMIT) {
    const promptKey = scenePromptKey(shot?.prompt);
    if (!promptKey) return '';
    return copyText(shot.sceneSummaryPromptKey === promptKey ? shot.sceneSummary || shot.prompt : shot.prompt, limit);
}

function scenePlanFields(input, prompt, restoring) {
    const summary = copyText(input?.sceneSummary, COMMERCE_SCENE_SUMMARY_LIMIT);
    const summaryPromptKey = restoring ? text(input?.sceneSummaryPromptKey, 64) : scenePromptKey(prompt);
    const needsReview = restoring && !!prompt && input?.sceneNeedsReview === true;
    return {
        sceneSummary: summary || copyText(prompt, COMMERCE_SCENE_SUMMARY_LIMIT),
        ...(summaryPromptKey ? { sceneSummaryPromptKey: summaryPromptKey } : {}),
        ...(needsReview ? { sceneNeedsReview: true } : {}),
        sceneConfirmed: restoring && !!prompt && !needsReview && input?.sceneConfirmed === true
    };
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
    if (!Array.isArray(ids)) return [];
    const selected = new Set(ids);
    const customScenes = normalizeCustomScenes(settings?.customScenes);
    return Object.entries(aspects).flatMap(([group, aspect]) => [
        ...platform.shots.filter(item => item.group === group && selected.has(item.id)).map(item => ({ ...item, aspect })),
        ...customScenes.filter(item => item.group === group)
            .map((item, index) => customSceneShot(item, index, aspect)).filter(item => selected.has(item.id))
    ]);
}

export function appendCommerceSceneShot(settings, group, id = `scene-${globalThis.crypto.randomUUID?.() || generateId()}`) {
    const plan = settings?.plan;
    if (!plan?.sourceKey || plan.stale || !Array.isArray(plan.shots) || !isCommerceShotGroup(group) || !isCommerceSceneId(id)) return null;
    const customScenes = normalizeCustomScenes(settings.customScenes);
    if (customScenes.some(item => item.id === id)) return null;
    const selectedShotIds = getSelectedCommerceImageSetShots(settings).map(item => item.id);
    const metadata = { id, group, description: '' };
    const added = { ...customSceneShot(metadata, customScenes.filter(item => item.group === group).length,
        normalizeAspect(settings[`${group}Aspect`], group)),
        prompt: '', headline: '', body: '', ...scenePlanFields(null, '', true) };
    const existing = new Map(plan.shots.map(item => [item.id, item]));
    if (selectedShotIds.some(shotId => !existing.has(shotId))) return null;
    existing.set(id, added);
    const nextScenes = [...customScenes, metadata];
    const selected = getSelectedCommerceImageSetShots({ ...settings, selectedShotIds: [...selectedShotIds, id], customScenes: nextScenes });
    settings.customScenes = nextScenes;
    settings.selectedShotIds = selected.map(item => item.id);
    settings.plan = { ...plan, shots: selected.map(item => existing.get(item.id)) };
    return added;
}

export function removeCommerceSceneShot(settings, shotId) {
    const scenes = normalizeCustomScenes(settings?.customScenes);
    if (!scenes.some(scene => scene.id === shotId) || isCommerceShotFinalized(settings, shotId)) return false;

    settings.customScenes = scenes.filter(scene => scene.id !== shotId);
    if (Array.isArray(settings.selectedShotIds)) {
        settings.selectedShotIds = settings.selectedShotIds.filter(id => id !== shotId);
    }
    if (Array.isArray(settings.plan?.shots)) {
        const labels = new Map(getSelectedCommerceImageSetShots(settings)
            .filter(shot => shot.customScene).map(shot => [shot.id, shot.label]));
        const shots = settings.plan.shots.filter(shot => shot.id !== shotId).map(shot => {
            const label = labels.get(shot.id);
            return label && label !== shot.label ? { ...shot, label } : shot;
        });
        settings.plan = { ...settings.plan, shots };
    }
    for (const field of ['results', 'candidates', 'previousExportResults']) {
        if (Array.isArray(settings[field])) {
            settings[field] = settings[field].filter(row => row?.shotId !== shotId);
        }
    }
    return true;
}

export function updateCommerceSceneDescription(settings, shotId, value) {
    const metadata = settings?.customScenes?.find(item => item.id === shotId);
    const shot = settings?.plan?.shots?.find(item => item.id === shotId);
    const description = text(value, COMMERCE_SCENE_DESCRIPTION_LIMIT);
    if (!metadata || !shot?.customScene || description === metadata.description) return false;
    metadata.description = description;
    shot.description = description;
    markCommerceSceneForReview(shot);
    return true;
}

function markCommerceSceneForReview(shot) {
    if (!shot.customScene || !text(shot.prompt, 2000)) return;
    shot.sceneConfirmed = false;
    shot.sceneNeedsReview = true;
}

export function confirmCommerceSceneShot(settings, shotId) {
    const shot = settings?.plan?.shots?.find(item => item.id === shotId);
    if (settings?.plan?.stale || !shot?.customScene || !getCommerceSceneSummary(shot)) return false;
    delete shot.sceneNeedsReview;
    shot.sceneConfirmed = true;
    return true;
}

function isCompletedCommerceResult(row) {
    return row?.status === 'completed' && typeof row.assetKey === 'string' && COMMERCE_ASSET_KEY_PATTERN.test(row.assetKey);
}

export function isCommerceShotFinalized(settings, shotId) {
    return Array.isArray(settings?.results)
        && settings.results.some(row => row?.shotId === shotId && row.finalized === true && isCompletedCommerceResult(row));
}

export function setCommerceShotFinalized(settings, shotId, finalized) {
    if (!Array.isArray(settings?.results) || typeof finalized !== 'boolean') return false;
    const row = settings.results.find(row => row?.shotId === shotId && isCompletedCommerceResult(row));
    if (!row || (row.finalized === true) === finalized) return false;
    if (finalized) row.finalized = true;
    else delete row.finalized;
    return true;
}

function normalizePreviousExportResults(raw) {
    const results = new Map();
    for (const row of Array.isArray(raw) ? raw : []) {
        const preset = getCommerceImageSetPreset(row?.platformId);
        if (!preset || typeof row.outputKey !== 'string' || !/^media:[a-zA-Z0-9_-]+$/.test(row.outputKey)
            || !Number.isSafeInteger(row.order) || row.order < 0) continue;
        const shot = preset.shots.find(item => item.id === row.shotId);
        const group = shot?.group ?? (isCommerceSceneId(row.shotId) && isCommerceShotGroup(row.group) ? row.group : '');
        const label = shot?.label ?? text(row.label, 100);
        if (!group || !label) continue;
        const key = `${preset.id}:${row.shotId}`;
        if (!results.has(key)) {
            const referenceRevision = text(row.referenceRevision, 512);
            const referenceContentKey = text(row.referenceContentKey, 128);
            const aspect = COMMERCE_IMAGE_SET_ASPECTS.includes(row.aspect) ? row.aspect : '';
            results.set(key, { platformId: preset.id, shotId: row.shotId, label, group, order: row.order, outputKey: row.outputKey,
                ...(referenceRevision ? { referenceRevision } : {}), ...(referenceContentKey ? { referenceContentKey } : {}),
                ...(aspect ? { aspect } : {}), ...(row.retained === true ? { retained: true } : {}) });
        }
    }
    return [...results.values()];
}

export function preserveCommerceImageSetExportResults(settings, { previousAspects, replacingReferences = false } = {}) {
    if (!Array.isArray(settings?.plan?.shots) || !Array.isArray(settings.results)) return;
    const { platformId, referenceRevision, referenceContentKey, shots } = settings.plan;
    const completed = new Map(settings.results.filter(isCompletedCommerceResult).map(row => [row.shotId, row.assetKey]));
    const previous = Array.isArray(settings.previousExportResults) ? settings.previousExportResults : [];
    const hasOtherReferences = previous.some(row => row.retained && (row.referenceContentKey && referenceContentKey
        ? row.referenceContentKey !== referenceContentKey
        : row.referenceRevision && referenceRevision && row.referenceRevision !== referenceRevision));
    if (!replacingReferences && hasOtherReferences) return;
    const previousOutputs = new Map(previous.filter(row => row?.platformId === platformId).map(row => [row.shotId, row]));
    const retained = normalizePreviousExportResults(shots.flatMap(({ id, label, group, aspect }, order) => completed.has(id)
        ? [{ platformId, shotId: id, label, group, aspect: previousAspects?.get(id) ?? aspect, order, outputKey: completed.get(id),
            referenceRevision, referenceContentKey, retained: true }] : []));
    if (retained.some(row => {
        const prior = previousOutputs.get(row.shotId);
        return prior?.outputKey !== row.outputKey || prior.referenceContentKey !== row.referenceContentKey
            || prior.referenceRevision !== row.referenceRevision || prior.aspect !== row.aspect || !prior.retained;
    })) {
        settings.previousExportResults = retained;
    }
}

export function getCommerceImageSetPreviousAssetKeys(settings) {
    return [...new Set(normalizePreviousExportResults(settings?.previousExportResults)
        .filter(row => row.retained === true).map(row => row.outputKey))];
}

function normalizeCommerceShotCopy(input, allowCopy) {
    return {
        headline: allowCopy ? copyText(input?.headline, COMMERCE_IMAGE_SET_COPY_LIMITS.headline) : '',
        body: allowCopy ? copyText(input?.body, COMMERCE_IMAGE_SET_COPY_LIMITS.body) : ''
    };
}

export function commerceShotPlanKey(shot) {
    if (shot?.source !== 'generate') return '';
    const { headline, body } = normalizeCommerceShotCopy(shot, shot.allowCopy);
    return `v1-${changeFingerprint(JSON.stringify([text(shot.prompt, 2000), headline, body]))}`;
}

function normalizeCandidateDraft(input, shot) {
    const prompt = text(input?.prompt, 2000);
    if (!prompt || shot?.source !== 'generate') return null;
    return { prompt, ...normalizeCommerceShotCopy(input, shot.allowCopy),
        ...(shot.customScene ? {
            description: text(input.description, COMMERCE_SCENE_DESCRIPTION_LIMIT),
            ...scenePlanFields(input, prompt, true)
        } : {}) };
}

function normalizeCommerceShotCandidates(raw, selectedShots) {
    const shots = new Map(selectedShots.map(shot => [shot.id, shot]));
    const keysByShot = new Map();
    const candidates = [];
    for (const row of Array.isArray(raw) ? raw : []) {
        const shot = shots.get(row?.shotId);
        if (!shot || row.aspect !== shot.aspect || typeof row.assetKey !== 'string' || !COMMERCE_ASSET_KEY_PATTERN.test(row.assetKey)) continue;
        const draft = normalizeCandidateDraft(row.draft, shot);
        if (!draft) continue;
        const planKey = commerceShotPlanKey({ ...shot, ...draft });
        const key = `${row.assetKey}:${planKey}`;
        const keys = keysByShot.get(shot.id) || new Set();
        if (keys.has(key) || keys.size >= COMMERCE_SHOT_CANDIDATE_LIMIT) continue;
        keys.add(key);
        keysByShot.set(shot.id, keys);
        const referenceRevision = text(row.referenceRevision, 512);
        const referenceContentKey = text(row.referenceContentKey, 128);
        const sceneContextKey = text(row.sceneContextKey, 128);
        candidates.push({ shotId: shot.id, key, assetKey: row.assetKey, aspect: shot.aspect, draft, planKey,
            ...(referenceRevision ? { referenceRevision } : {}), ...(referenceContentKey ? { referenceContentKey } : {}),
            ...(sceneContextKey ? { sceneContextKey } : {}) });
    }
    return candidates;
}

export function getCommerceShotCandidates(settings, shotId) {
    const shots = getSelectedCommerceImageSetShots(settings).filter(shot => shot.id === shotId);
    return normalizeCommerceShotCandidates(settings?.candidates, shots);
}

export function getCommerceImageSetCandidateAssetKeys(settings) {
    const candidates = normalizeCommerceShotCandidates(settings?.candidates, getSelectedCommerceImageSetShots(settings));
    return [...new Set(candidates.map(candidate => candidate.assetKey))];
}

export function getCommerceImageSetHistoryAssetKeys(settings) {
    return [...new Set([...getCommerceImageSetCandidateAssetKeys(settings), ...getCommerceImageSetPreviousAssetKeys(settings)])];
}

export function rememberCommerceShotCandidate(settings, shot, assetKey) {
    if (shot.source !== 'generate') return;
    const candidate = { shotId: shot.id, assetKey, aspect: shot.aspect, draft: shot,
        referenceRevision: settings.plan?.referenceRevision, referenceContentKey: settings.plan?.referenceContentKey,
        sceneContextKey: shot.customScene ? settings.plan?.sceneContextKeys?.[shot.group] : undefined };
    settings.candidates = normalizeCommerceShotCandidates([candidate, ...(settings.candidates || [])], getSelectedCommerceImageSetShots(settings));
}

export function restoreCommerceShotCandidateDraft(settings, candidate) {
    const shot = settings.plan?.shots.find(item => item.id === candidate.shotId);
    if (!shot) return false;
    Object.assign(shot, candidate.draft);
    if (shot.customScene) {
        if (candidate.draft.sceneNeedsReview !== true) delete shot.sceneNeedsReview;
        if (!candidate.draft.sceneSummaryPromptKey) delete shot.sceneSummaryPromptKey;
        if (candidate.sceneContextKey && candidate.sceneContextKey !== settings.plan.sceneContextKeys?.[shot.group]) {
            markCommerceSceneForReview(shot);
        }
        const scene = settings.customScenes?.find(item => item.id === shot.id);
        if (scene) scene.description = shot.description;
    }
    return true;
}

export function isCommerceShotImageStale(shot, result) {
    return shot?.source === 'generate' && result?.status === 'completed'
        && (result.previousVersion === true || (!!result.planKey && result.planKey !== commerceShotPlanKey(shot)));
}

export function getRunnableCommerceImageSetShots(settings) {
    if (!Array.isArray(settings?.plan?.shots)) return [];
    const selected = new Set(getSelectedCommerceImageSetShots(settings).map(shot => shot.id));
    return settings.plan.shots.filter(shot => selected.has(shot.id) && (!shot.customScene || shot.sceneConfirmed === true));
}

export function getGeneratableCommerceImageSetShots(settings) {
    return getRunnableCommerceImageSetShots(settings).filter(shot => !isCommerceShotFinalized(settings, shot.id));
}

export function getUnfinishedCommerceImageSetShots(settings) {
    const results = new Map((Array.isArray(settings?.results) ? settings.results : []).map(row => [row?.shotId, row]));
    return getRunnableCommerceImageSetShots(settings).filter(shot => !isCompletedCommerceResult(results.get(shot.id)));
}

export function normalizeCommerceImageSetPlan(raw, platformId, selectedShotIds, settings, { allowBlankPrompts = false } = {}) {
    const platform = getCommerceImageSetPreset(platformId);
    if (!platform || (raw?.platformId && raw.platformId !== platform.id) || !Array.isArray(raw?.sellingPoints) || !Array.isArray(raw?.shots)) {
        throw new Error('套图方案格式无效，请重新规划。');
    }
    const selected = getSelectedCommerceImageSetShots({
        ...settings, platformId, selectedShotIds: selectedShotIds === undefined ? platform.shots.map(item => item.id) : selectedShotIds
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
        if (item.source === 'generate' && !prompt && !(allowBlankPrompts && (typeof input?.prompt === 'string' || item.customScene))) {
            throw new Error(`套图方案缺少「${item.label}」的画面说明。`);
        }
        return { ...item, prompt, ...normalizeCommerceShotCopy(input, item.allowCopy),
            ...(item.customScene ? scenePlanFields(input, prompt, allowBlankPrompts) : {}) };
    });
    return { version: 1, platformId: platform.id, copyLanguage: normalizeCommerceImageSetCopyLanguage(settings?.copyLanguage),
        sellingPoints: normalizeCommerceProductInfo(raw).sellingPoints, shots };
}

export function normalizeCommerceImageSetState(raw) {
    const selected = getSelectedCommerceImageSetShots(raw);
    const candidateCount = normalizeCommerceImageSetCandidateCount(raw?.candidateCount);
    const settings = {
        platformId: getCommerceImageSetPreset(raw?.platformId)?.id || 'taobao',
        selectedShotIds: selected.map(item => item.id),
        customScenes: normalizeCustomScenes(raw?.customScenes),
        galleryAspect: normalizeAspect(raw?.galleryAspect, 'gallery'),
        detailAspect: normalizeAspect(raw?.detailAspect, 'detail'),
        copyLanguage: normalizeCommerceImageSetCopyLanguage(raw?.copyLanguage),
        productInfo: getCommerceProductInfo(raw),
        autoProductInfo: normalizeCommerceProductInfo(raw?.autoProductInfo),
        plannerModelId: text(raw?.plannerModelId, 200), plannerProviderId: text(raw?.plannerProviderId, 200),
        imageModelId: text(raw?.imageModelId, 200), imageProviderId: text(raw?.imageProviderId, 200),
        ...(candidateCount > 1 ? { candidateCount } : {}),
        plan: null, results: []
    };
    const sourceKey = text(raw?.plan?.sourceKey, 128);
    if (raw?.plan?.version === 1 && sourceKey) {
        try {
            const copyLanguage = normalizeCommerceImageSetCopyLanguage(raw.plan.copyLanguage);
            const stale = raw.plan.stale === true || copyLanguage !== settings.copyLanguage;
            const plan = normalizeCommerceImageSetPlan(raw.plan, settings.platformId, settings.selectedShotIds,
                { ...settings, copyLanguage }, { allowBlankPrompts: true });
            const productContextKey = text(raw.plan.productContextKey, 128);
            const referenceRevision = text(raw.plan.referenceRevision, 512);
            const referenceContentKey = text(raw.plan.referenceContentKey, 128);
            const sceneContextKeys = Object.fromEntries(Object.keys(COMMERCE_IMAGE_SET_DEFAULT_ASPECTS)
                .map(group => [group, text(raw.plan.sceneContextKeys?.[group], 128)]).filter(([, key]) => key));
            settings.plan = { ...plan, sourceKey, ...(productContextKey ? { productContextKey } : {}),
                ...(referenceRevision ? { referenceRevision } : {}), ...(referenceContentKey ? { referenceContentKey } : {}),
                ...(Object.keys(sceneContextKeys).length ? { sceneContextKeys } : {}),
                confirmed: raw.plan.confirmed === true && !stale, ...(stale ? { stale: true } : {}) };
        } catch { /* Invalid stored plans can be replaced by planning again. */ }
    }
    if (Array.isArray(raw?.results)) {
        const results = new Map(raw.results.map(item => [item?.shotId, item]));
        const planned = new Map(settings.plan?.shots.map(shot => [shot.id, shot]));
        settings.results = selected.flatMap(({ id, source }) => {
            const row = results.get(id);
            if (row?.status === 'failed') return [{ shotId: id, status: 'failed', error: text(row.error, 300) }];
            if (row?.status === 'canceled') return [{ shotId: id, status: 'canceled' }];
            if (isCompletedCommerceResult(row)) {
                // Older workflows can track changes starting from their restored draft.
                const storedKey = typeof row.planKey === 'string' && COMMERCE_SHOT_PLAN_KEY_PATTERN.test(row.planKey) ? row.planKey : '';
                const planKey = source === 'generate' ? storedKey || commerceShotPlanKey(planned.get(id)) : '';
                const replacementError = text(row.replacementError, 300);
                const candidateProgress = source === 'generate' ? normalizePartialCandidateProgress(row.candidateProgress) : null;
                return [{ shotId: id, status: 'completed', assetKey: row.assetKey, ...(planKey ? { planKey } : {}),
                    ...(row.finalized === true ? { finalized: true } : {}), ...(replacementError ? { replacementError } : {}),
                    ...(row.previousVersion === true ? { previousVersion: true } : {}),
                    ...(candidateProgress ? { candidateProgress } : {}) }];
            }
            return [];
        });
    }
    const candidates = normalizeCommerceShotCandidates(raw?.candidates, selected);
    if (candidates.length) settings.candidates = candidates;
    const previousExportResults = normalizePreviousExportResults(raw?.previousExportResults);
    if (previousExportResults.length) settings.previousExportResults = previousExportResults;
    return settings;
}

export function commerceImageSetPlanningSettingsKey(raw, shotId) {
    const settings = normalizeCommerceImageSetState(raw);
    if (!shotId) return JSON.stringify(settings);
    const { plan, results, candidates, customScenes, selectedShotIds, ...shared } = settings;
    const presetShotIds = selectedShotIds.filter(id => !isCommerceSceneId(id));
    const shot = plan?.shots.find(item => item.id === shotId);
    const finalized = results.some(row => row.shotId === shotId && row.finalized === true);
    return JSON.stringify([{ ...shared, selectedShotIds: presetShotIds }, plan?.sourceKey, plan?.stale, plan?.sellingPoints, shot, finalized]);
}

function normalizeReferences(references) {
    if (!Array.isArray(references) || !references.length || references.length > 5
        || references.some(image => typeof image !== 'string' || !/^(?:data:image\/[^;,]+;base64,|https?:\/\/)/i.test(image))) {
        throw new Error('请连接 1 至 5 张可读取的商品参考图。');
    }
    return references;
}

function changeFingerprint(value) {
    let a = 2166136261, b = 0;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        a = Math.imul(a ^ code, 16777619);
        b = Math.imul(b ^ code, 31) + index;
    }
    return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}-${value.length}`;
}

async function sourceFingerprint(value) {
    if (globalThis.crypto?.subtle) {
        const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
        return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    // LAN browser sessions can lack SubtleCrypto. This key only detects edited inputs.
    return `lan-${changeFingerprint(value)}`;
}

export async function commerceImageSetReferenceContentKey(references) {
    const hashes = await Promise.all(normalizeReferences(references).map(sourceFingerprint));
    return sourceFingerprint(JSON.stringify(hashes));
}

async function commerceImageSetKeys({ settings, references }) {
    const normalized = normalizeCommerceImageSetState(settings);
    const { platformId, productInfo, plannerModelId, plannerProviderId, selectedShotIds,
        galleryAspect, detailAspect, copyLanguage } = normalized;
    const images = normalizeReferences(references);
    const hashes = await Promise.all(images.map(sourceFingerprint));
    const { name, details, audience, useCases } = productInfo;
    const inputs = [platformId, details, plannerModelId, plannerProviderId, hashes];
    // Selling points remain editable in the approved draft without changing its image inputs.
    if (name || audience || useCases) inputs.push({ name, audience, useCases });
    const platform = getCommerceImageSetPreset(platformId);
    const presetShotIds = selectedShotIds.filter(id => !isCommerceSceneId(id));
    const includesDetail = platform.shots.some(shot => shot.group === 'detail' && presetShotIds.includes(shot.id));
    const galleryCount = platform.shots.filter(shot => shot.group === 'gallery').length;
    // Older plans only had gallery shots. Full sets saved before slot selection omitted the ID list.
    if (includesDetail || presetShotIds.length !== galleryCount) inputs.push(presetShotIds);
    if (includesDetail || galleryAspect !== COMMERCE_IMAGE_SET_DEFAULT_ASPECTS.gallery || detailAspect !== COMMERCE_IMAGE_SET_DEFAULT_ASPECTS.detail) {
        inputs.push({ galleryAspect, detailAspect });
    }
    if (copyLanguage !== 'auto') inputs.push({ copyLanguage });
    const manual = getManualProductInfo(normalized);
    const [sourceKey, productContextKey, referenceContentKey] = await Promise.all([
        sourceFingerprint(JSON.stringify(inputs)),
        sourceFingerprint(JSON.stringify([hashes, manual.name, manual.details, manual.audience, manual.useCases])),
        sourceFingerprint(JSON.stringify(hashes))
    ]);
    const sceneContextKeys = Object.fromEntries(await Promise.all(Object.entries({ gallery: galleryAspect, detail: detailAspect })
        .map(async ([group, aspect]) => [group, await sourceFingerprint(JSON.stringify([referenceContentKey, platformId,
            productInfo, copyLanguage, aspect]))])));
    return { sourceKey, productContextKey, referenceContentKey, sceneContextKeys };
}

export async function commerceImageSetSourceKey(input) {
    return (await commerceImageSetKeys(input)).sourceKey;
}

export function buildCommerceImageSetImagePrompt({ shot, plan, productInfo, productNotes }) {
    const platform = getCommerceImageSetPreset(plan.platformId);
    const { name, details, audience, useCases } = normalizeCommerceProductInfo({ details: productNotes, ...productInfo });
    const { headline, body } = normalizeCommerceShotCopy(shot, shot.allowCopy);
    const onImageCopy = [headline && `标题：${JSON.stringify(headline)}`, body && `正文：${JSON.stringify(body)}`].filter(Boolean);
    const copyLanguage = normalizeCommerceImageSetCopyLanguage(plan.copyLanguage);
    const lettering = onImageCopy.length ? [
        copyLanguage !== 'auto' && `图中文字语言：${COMMERCE_IMAGE_SET_COPY_LANGUAGES[copyLanguage]}。`,
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
        name && `商品名称：${name}`,
        details && `已确认的商品资料：${details}`,
        audience && `适用人群用于辅助画面设计：${audience}`,
        useCases && `使用场景用于辅助画面设计：${useCases}`,
        plan.sellingPoints.length > 0 && `已确认的卖点：${plan.sellingPoints.join('；')}`,
        '以下文字规则优先于画面设计里的旧文案或排字要求。',
        ...lettering
    ].filter(Boolean).join('\n');
}

const PRODUCT_ANALYSIS_INSTRUCTIONS = [
    '从商品参考图和用户提供的商品资料分析产品信息。按 productInfo 中已有的非空字段使用原值；仅补充留空的字段。',
    'productInfo 包含 name（商品名称或通用类目名称）、sellingPoints（按优先级排列的字符串数组，最多 8 条）、audience（建议适用人群）、useCases（合理的用途和使用场景）、details（产品外观、可观察到的结构与已核实规格）。除卖点外均为字符串。',
    '只使用参考图可观察到或商品资料明确提供的事实。尺寸、材质、功效、认证、销量、价格及包装数量无法核实时留空。人群和场景只作创意建议，避免写成事实或效果承诺。'
].join('\n');

function requestCommerceJson({
    settings, references, models, providers, fetchRef, getProxyHeaders, signal, systemPrompt, message,
    responseError, validate, shot, runRequest = (_request, execute) => execute()
}) {
    const model = getModelsForTask(models, 'chat').find(item => item.id === settings.plannerModelId);
    if (!model) throw new Error('请选择支持图片输入的规划模型。');
    const provider = resolveAgentProvider(model, providers, settings.plannerProviderId);
    const protocol = getEffectiveProtocol(model, provider);
    const request = createChatRequestPlan({
        model, provider, protocol,
        capabilities: { imageInput: model.capabilities?.imageInput !== false },
        systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(message) }],
        media: references.map(url => ({ type: 'image', url }))
    });
    const providerHeaders = { 'Content-Type': 'application/json',
        ...(request.protocol === 'openai' ? { Authorization: `Bearer ${provider.apikey}` } : {}) };
    const headers = getProxyHeaders?.(request.url, request.method, providerHeaders);
    return runRequest(request, async () => {
        const { text: reply } = await requestChatCompletion(request, { fetchRef, headers, signal });
        signal?.throwIfAborted();
        let raw;
        try { raw = JSON.parse(reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
        catch { throw new Error(responseError); }
        return validate(raw);
    }, shot);
}

function readAnalyzedProductInfo(raw, { acceptLegacy = false, responseError }) {
    const info = raw?.productInfo;
    if (info && typeof info === 'object' && !Array.isArray(info)) {
        const normalized = normalizeCommerceProductInfo(info);
        if (Object.keys(normalized).some(key => key === 'sellingPoints' ? Array.isArray(info[key]) : typeof info[key] === 'string')) {
            return normalized;
        }
    }
    if (acceptLegacy && Array.isArray(raw?.sellingPoints)) return normalizeCommerceProductInfo(raw);
    throw new Error(responseError);
}

export async function analyzeCommerceImageSetProduct({ settings, references, ...requestOptions }) {
    const input = normalizeCommerceImageSetState(settings);
    const images = normalizeReferences(references);
    const manual = getManualProductInfo(input);
    const responseError = '规划模型未返回有效的商品信息，请重试。';
    const detected = await requestCommerceJson({
        ...requestOptions, settings: input, references: images, responseError,
        systemPrompt: `${PRODUCT_ANALYSIS_INSTRUCTIONS}\n只返回纯 JSON，根对象仅含 productInfo。`,
        message: { platform: getCommerceImageSetPreset(input.platformId).label, productInfo: manual },
        validate: raw => readAnalyzedProductInfo(raw, { responseError })
    });
    const updated = { ...input, ...mergeCommerceProductInfo(manual, detected) };
    if (input.plan) {
        const sellingPoints = updated.productInfo.sellingPoints;
        const stale = input.plan.stale || input.plan.sourceKey !== await commerceImageSetSourceKey({ settings: updated, references: images });
        updated.plan = {
            ...input.plan, sellingPoints,
            confirmed: input.plan.confirmed && !stale && sameProductValue(sellingPoints, input.plan.sellingPoints),
            ...(stale ? { stale: true } : {})
        };
        if (!sameProductValue(input.productInfo, updated.productInfo)) updated.plan.shots.forEach(markCommerceSceneForReview);
    }
    return updated;
}

export async function createCommerceImageSetPlan({ settings, references, shotId, referenceRevision, ...requestOptions }) {
    const input = normalizeCommerceImageSetState(settings);
    // A newly selected preset may have no draft yet. Full replanning can still
    // recover the previously planned scenes from the last set of slots.
    if (shotId === undefined && !input.plan && Array.isArray(settings?.plan?.shots)) {
        const oldPlan = normalizeCommerceImageSetState({ ...settings,
            platformId: settings.plan.platformId || input.platformId,
            selectedShotIds: settings.plan.shots.map(shot => shot?.id)
        }).plan;
        if (oldPlan) input.plan = oldPlan;
    }
    const images = normalizeReferences(references);
    const currentShot = shotId === undefined ? null : input.plan?.shots.find(shot => shot.id === shotId);
    const selectedShotIds = currentShot ? [currentShot.id] : input.selectedShotIds.filter(id => !isCommerceSceneId(id));
    if (!selectedShotIds.length) throw new Error('请至少选择一个图位。');
    if (shotId !== undefined && currentShot?.source !== 'generate') throw new Error('请选择一个需要生图的图位。');
    if (currentShot && isCommerceShotFinalized(input, shotId)) throw new Error('图位已定稿，请解锁后重新规划。');
    const keysForCurrentShot = currentShot ? await commerceImageSetKeys({ settings: input, references: images }) : null;
    if (currentShot && (input.plan.stale || input.plan.sourceKey !== keysForCurrentShot.sourceKey)) {
        throw new Error('商品资料、参考图或生成设置已改变，请重新规划整套方案。');
    }
    const platform = getCommerceImageSetPreset(input.platformId);
    const slots = getSelectedCommerceImageSetShots({ ...input, selectedShotIds }).filter(item => item.source === 'generate');
    const productInfo = currentShot ? input.productInfo : getManualProductInfo(input);
    const supplemental = currentShot?.customScene === true;
    const existingScenes = supplemental ? input.plan.shots.filter(shot => shot.id !== shotId
        && (shot.customScene || shot.role === 'scene' || shot.role === 'detail-scene'))
        .map(shot => ({ id: shot.id, group: shot.group, summary: getCommerceSceneSummary(shot, 2000) }))
        .filter(({ summary }) => summary) : [];
    const responseError = '规划模型未返回有效套图方案，请重试。';
    const { raw, plan, product } = await requestCommerceJson({
        ...requestOptions, settings: input, references: images, responseError, shot: currentShot,
        systemPrompt: [
            '你负责规划电商商品主副图和详情页图片。只提取参考图可观察到或商品资料明确提供的卖点。不要推断尺寸、材质、功效、认证、销量或价格。',
            !currentShot && PRODUCT_ANALYSIS_INSTRUCTIONS,
            !currentShot && '先完成产品分析，再用用户提供或本次分析的商品信息规划各图位与文案。',
            '保持同一商品的外观、颜色、商标、包装和销售数量。图中不得添加虚构标签、促销标识或其他商品。不使用逼真的生成式人物。',
            '按各图位的用途和宽高比设计不同的画面。主副图用于商品列表和轮播展示，详情图各自说明一个主题，依次组成详情页内容。',
            currentShot ? '输出纯 JSON，根对象仅含 shots。' : '输出纯 JSON，根对象包含 productInfo 和 shots。',
            supplemental
                ? 'shots 只返回指定的场景图位，包含 id、sceneSummary、prompt、headline、body。sceneSummary 用简体中文简述实际画面与展示重点。'
                : 'shots 是对象数组，每项仅含 id、prompt、headline、body。只为给定 id 编写方案。',
            supplemental && 'sceneDescription 是用户对场景的要求。优先依据它构图，留空时结合参考图和商品用途推荐一个场景。参考 existingScenes 避免与其他图位重复。',
            '每个 prompt 都应写清画面内容、构图和摄影风格，具体到展示的商品部位、场景、景别、拍摄角度、主体位置、光线和色调。全套图片协调统一，每个图位有自己的构图重点。',
            'allowCopy 为 true 且有文案时，在 prompt 中描述与商品构图融为一体的文字布局，指定标题和正文的位置、对齐、层级、字体风格和字色，保证阅读对比度，不遮挡实物。用“标题”“正文”指代，不在 prompt 中重复实际文案。',
            'headline 和 body 分别填写要出现在图上的短标题和辅助说明，具体、自然，贴合本图用途。避免多张图重复同样的文案。缺少合适证据时留空。',
            'allowCopy 为 false 的图位两项留空，画面不添加额外文字。',
            input.copyLanguage === 'auto'
                ? '图上文案遵循商品资料指定的语言，默认亚马逊使用英语，其他平台使用简体中文。'
                : `图上文案的 headline 和 body 使用${COMMERCE_IMAGE_SET_COPY_LANGUAGES[input.copyLanguage]}，这项设置优先于平台默认值、商品资料或当前草稿中的语言要求。商品分析和画面说明沿用原有语言。`,
            currentShot && '只重新规划指定图位。以现有商品卖点为依据，参考当前草稿提出新的构图或文案。'
        ].filter(Boolean).join('\n'),
        message: { platform: platform.label, productInfo, copyLanguage: input.copyLanguage,
            copyLimits: COMMERCE_IMAGE_SET_COPY_LIMITS,
            ...(currentShot ? { currentShot: { prompt: currentShot.prompt, headline: currentShot.headline, body: currentShot.body },
                sellingPoints: input.plan.sellingPoints } : {}),
            ...(supplemental ? { sceneDescription: currentShot.description, existingScenes } : {}),
            shots: slots.map(({ id, label, group, aspect, purpose, allowCopy }) => ({ id, label, group, aspect, purpose, allowCopy })) },
        validate(raw) {
            const product = currentShot ? null
                : mergeCommerceProductInfo(productInfo, readAnalyzedProductInfo(raw, { acceptLegacy: true, responseError }));
            const sellingPoints = product?.productInfo.sellingPoints ?? input.plan.sellingPoints;
            return { raw, product, plan: normalizeCommerceImageSetPlan({ ...raw, sellingPoints }, platform.id, selectedShotIds, input) };
        }
    });
    if (input.copyLanguage === 'auto') {
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
    }
    const revision = text(referenceRevision, 512);
    if (currentShot) return { ...input, plan: { ...input.plan,
        ...keysForCurrentShot, ...(revision ? { referenceRevision: revision } : {}),
        confirmed: supplemental && input.plan.confirmed,
        shots: input.plan.shots.map(shot => shot.id === currentShot.id ? plan.shots[0] : shot) } };
    const updated = { ...input, ...product };
    const previousAspects = new Map((Array.isArray(settings?.plan?.shots) ? settings.plan.shots : [])
        .filter(shot => COMMERCE_IMAGE_SET_ASPECTS.includes(shot?.aspect)).map(shot => [shot.id, shot.aspect]));
    const keys = await commerceImageSetKeys({ settings: updated, references: images });
    const { sourceKey, productContextKey, referenceContentKey, sceneContextKeys } = keys;
    const sameProductContext = input.plan?.productContextKey
        ? input.plan.productContextKey === productContextKey : input.plan?.sourceKey === sourceKey;
    const sameReferences = input.plan?.referenceContentKey
        ? input.plan.referenceContentKey === referenceContentKey
        : revision && input.plan?.referenceRevision ? input.plan.referenceRevision === revision : sameProductContext;
    preserveCommerceImageSetExportResults(updated, { previousAspects, replacingReferences: !sameReferences });
    const previousShots = new Map((input.plan?.shots || []).map(shot => [shot.id, shot]));
    const hasCompatibleAspect = shot => previousShots.get(shot.id)?.source === shot.source
        && (shot.source === 'reference' || (previousAspects.get(shot.id) ?? previousShots.get(shot.id)?.aspect) === shot.aspect);
    const hasMatchingSceneContext = shot => sameReferences && (input.plan?.sceneContextKeys?.[shot.group]
        ? input.plan.sceneContextKeys[shot.group] === sceneContextKeys[shot.group]
        : sameProductContext && input.plan.copyLanguage === updated.copyLanguage && hasCompatibleAspect(shot));
    const finalizedShots = new Map((input.plan?.shots || []).filter(shot =>
        sameReferences && hasCompatibleAspect(shot) && isCommerceShotFinalized(input, shot.id))
        .map(shot => [shot.id, shot]));
    const keptScenes = [...previousShots.values()]
        .filter(shot => shot.customScene && input.selectedShotIds.includes(shot.id)).map(shot => {
            if (hasMatchingSceneContext(shot)) return shot;
            const draft = { ...shot };
            markCommerceSceneForReview(draft);
            return draft;
        });
    const combinedShots = [...plan.shots.map(shot => finalizedShots.get(shot.id) || shot), ...keptScenes];
    const combined = normalizeCommerceImageSetPlan({ ...plan, shots: combinedShots },
        platform.id, updated.selectedShotIds, updated, { allowBlankPrompts: true });
    const compatibleShots = new Map(combined.shots.filter(hasCompatibleAspect).map(shot => [shot.id, shot]));
    const results = sameReferences ? input.results.flatMap(row => {
        const shot = compatibleShots.get(row.shotId);
        if (!shot) return [];
        const matchingContext = hasMatchingSceneContext(shot);
        if (!isCompletedCommerceResult(row)) return shot.customScene && matchingContext ? [row] : [];
        return [shot.source === 'generate' && !matchingContext ? { ...row, previousVersion: true } : row];
    }) : [];
    const currentReferenceRevision = revision || (sameReferences ? input.plan?.referenceRevision : '');
    return { ...updated,
        plan: { ...combined, ...keys, ...(currentReferenceRevision ? { referenceRevision: currentReferenceRevision } : {}), confirmed: false },
        results };
}
