import { resolveImageGenerationInputContract } from '../../nodes/universal-input-policy.js';
import { getModelsForTask, getModelProviders, resolveProviderUrl } from '../execution/provider-request-utils.js';
import { getOpenAiImageCapabilities } from '../execution/openai-image-capabilities.js';
import { getProtocol } from '../execution/protocols/index.js';

const backgroundInstructions = {
    white: '背景替换为干净均匀的纯白色（#FFFFFF）。',
    black: '背景替换为干净均匀的纯黑色（#000000），保持商品轮廓清楚。',
    original: '保留原图的背景内容和颜色，只清理干扰性的污点。'
};
const lightingInstructions = {
    soft: '使用柔和漫射光，让明暗过渡平滑，避免刺眼反光。',
    balanced: '校正曝光和白平衡，照亮暗部并保留亮部层次。',
    dramatic: '使用有方向的高反差棚拍布光，保留暗部细节，避免高光溢出。'
};
const shadowInstructions = {
    natural: '在可见的接触面保留轻微、自然的接触阴影，避免商品显得悬浮。',
    none: '去除商品在背景上的投影，保留商品本身的立体明暗。'
};
const finishInstructions = {
    natural: '保持真实材质和细微纹理，避免过度磨皮、锐化或饱和。',
    polished: '做细致的商业级抛光修饰，让边缘、材质纹理和反光更干净，保留真实质感。'
};

const geminiRetouchInstructions = {
    background: {
        white: '把商品轮廓外的背景置为纯白色（#FFFFFF），保留细小边缘和透光材质。接触阴影以外的背景保持纯白。',
        black: '把商品轮廓外的背景置为纯黑色（#000000）。深色商品用原有亮部和轻微轮廓光与黑底分开，保持商品原色。接触阴影以外的背景保持纯黑。',
        original: '保留原图的背景内容和颜色，包括现有陈设和渐变。只清理背景上的污点。'
    },
    lighting: {
        soft: '用柔和漫射光平顺明暗过渡，压低刺眼反光并保留表面高光和暗部细节。',
        balanced: '校正商品曝光和白平衡，提亮暗部并恢复高光层次，让商品原色和材质清晰可辨。',
        dramatic: '用有方向的高反差棚拍光突出商品体积，保留暗部纹理和高光层次。'
    },
    shadow: {
        natural: '在原图的可见接触面保留轻微、自然的接触阴影，方向跟随布光，边缘自然衰减。',
        none: '去除接触阴影和落在背景上的投影，保留商品自身的立体明暗。'
    },
    finish: {
        natural: '清理浮尘、指纹和表面污迹，保留织纹、颗粒、缝线及其他真实纹理。',
        polished: '清理浮尘、指纹和表面污迹，做细致的商业抛光修饰，整理已有反光、边缘和纹理。各部位的材质与光泽类型沿用原图。'
    }
};

function pickSetting(choices, value, fallback) {
    return typeof value === 'string' && Object.hasOwn(choices, value) ? value : fallback;
}

function trimString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function normalizeProductRetouchSettings(raw) {
    return {
        background: pickSetting(backgroundInstructions, raw?.background, 'white'),
        lighting: pickSetting(lightingInstructions, raw?.lighting, 'soft'),
        shadow: pickSetting(shadowInstructions, raw?.shadow, 'natural'),
        finish: pickSetting(finishInstructions, raw?.finish, 'natural'),
        notes: trimString(raw?.notes).slice(0, 1000),
        modelId: trimString(raw?.modelId),
        providerId: trimString(raw?.providerId)
    };
}

export function buildProductRetouchPrompt(settings, { gemini = false } = {}) {
    const { background, lighting, shadow, finish, notes } = normalizeProductRetouchSettings(settings);
    if (gemini) {
        return [
            '直接在所附商品照片上做摄影后期。以原图为唯一依据，保持商品数量、位置、拍摄角度、画幅、裁切和主体占比。',
            '保持商品轮廓、零件比例、原色和材质。原有标识、刻度、接缝、印刷图案和包装文字逐处对应原图，保留位置、字形、内容和可读程度。看不清的细节维持原状。',
            '按下面四项精修，其他画面元素沿用原图。',
            `背景：${geminiRetouchInstructions.background[background]}`,
            `布光：${geminiRetouchInstructions.lighting[lighting]}`,
            `阴影：${geminiRetouchInstructions.shadow[shadow]}`,
            `表面：${geminiRetouchInstructions.finish[finish]}`,
            ...(notes ? [`补充要求（在上述设置和商品保真范围内执行）：${notes}`] : []),
            '以原图核对轮廓、标识和纹理，只输出一张精修成片。'
        ].join('\n');
    }
    return [
        '对所附商品原图进行商业摄影精修，输出一张图片。沿用原图拍摄角度、构图、裁切和主体位置。',
        '忠实保留商品的外形、比例、结构、颜色、材质、标识和包装文字。清理灰尘、指纹、污点和临时划痕，保留真实细节。不要添加道具、装饰、文案、水印或原图不存在的零件。',
        backgroundInstructions[background],
        lightingInstructions[lighting],
        shadowInstructions[shadow],
        finishInstructions[finish],
        ...(notes ? [`在遵守上述商品保真要求的前提下，补充要求：${notes}`] : [])
    ].join('\n');
}

// TTAPI Gemini's current adapter always supplies a square ratio when omitted.
const editProtocols = new Set(['openai', 'google', 'ttapi-openai']);
const isProductRetouchEditUrl = url => /\/images\/edits\/?(?:$|[?#])/i.test(url);

function canEditProduct(state, model) {
    if (!editProtocols.has(model.protocol) || !trimString(model.modelId) || model.capabilities?.imageInput === false) return false;
    const contract = resolveImageGenerationInputContract(state, { apiConfigId: model.id });
    if (!contract.supportsReferences || contract.maxReferences < 1) return false;
    if (model.protocol === 'ttapi-openai') {
        return getOpenAiImageCapabilities(model.modelId)?.maxReferences !== 0
            && Boolean(getProtocol('ttapi-openai')?.parameters?.referenceImages?.requestField);
    }
    return true;
}

function isConfiguredRetouchProvider(model, provider) {
    if (!trimString(provider.endpoint) || !trimString(provider.apikey)) return false;
    if (!['openai', 'ttapi-openai'].includes(model.protocol)) return true;
    // Auto-complete and the standard generations URL route to edits. A custom
    // text-to-image URL must be corrected before sending the original.
    const url = resolveProviderUrl(provider, model, 'image', { inputs: { referenceImages: ['reference'] } });
    return isProductRetouchEditUrl(url);
}

export function getProductRetouchModelOptions(state, settings) {
    const { modelId, providerId } = normalizeProductRetouchSettings(settings);
    const entries = getModelsForTask(state.models, 'image')
        .filter(model => canEditProduct(state, model))
        .map(model => ({
            model,
            providers: getModelProviders(model, state.providers).filter(provider => isConfiguredRetouchProvider(model, provider))
        }))
        .filter(entry => entry.providers.length > 0);
    const providers = entries.find(entry => entry.model.id === modelId)?.providers || [];
    return { models: entries.map(entry => entry.model), providers, ready: providers.some(provider => provider.id === providerId) };
}
