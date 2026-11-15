import { resolveImageGenerationInputContract } from '../../nodes/universal-input-policy.js';
import { getModelsForTask, getModelProviders, resolveProviderUrl } from '../execution/provider-request-utils.js';
import { getOpenAiImageCapabilities } from '../execution/openai-image-capabilities.js';
import { getOpenAIChatCapabilities, getOpenAIChatModelProfile } from '../execution/openai-chat-capabilities.js';
import { createChatRequestPlan } from '../execution/chat-request-plan.js';
import { getProtocol } from '../execution/protocols/index.js';

const retouchInstructions = {
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
        natural: '局部清理后，保留织纹、颗粒、缝线及其他真实纹理。',
        polished: '局部清理后，做细致的商业抛光修饰，随所选布光轻微整理杂乱高光、边缘和纹理。各部位的材质及反光特性沿用原图。'
    }
};

const maximumAdjustments = 4;
const maximumAreaLength = 60;
const maximumEditLength = 160;
const maximumAnalysisPromptLength = maximumAdjustments * (maximumAreaLength + maximumEditLength + 2);

function pickSetting(choices, value, fallback) {
    return typeof value === 'string' && Object.hasOwn(choices, value) ? value : fallback;
}

function trimString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function normalizeProductRetouchSettings(raw) {
    return {
        background: pickSetting(retouchInstructions.background, raw?.background, 'white'),
        lighting: pickSetting(retouchInstructions.lighting, raw?.lighting, 'soft'),
        shadow: pickSetting(retouchInstructions.shadow, raw?.shadow, 'natural'),
        finish: pickSetting(retouchInstructions.finish, raw?.finish, 'natural'),
        notes: trimString(raw?.notes).slice(0, 1000),
        modelId: trimString(raw?.modelId),
        providerId: trimString(raw?.providerId),
        analysisModelId: trimString(raw?.analysisModelId),
        analysisProviderId: trimString(raw?.analysisProviderId)
    };
}

function describeRetouchOptions(settings) {
    const { background, lighting, shadow, finish, notes } = normalizeProductRetouchSettings(settings);
    return [
        `背景：${retouchInstructions.background[background]}`,
        `布光：${retouchInstructions.lighting[lighting]}`,
        `阴影：${retouchInstructions.shadow[shadow]}`,
        `表面：${retouchInstructions.finish[finish]}`,
        ...(notes ? [`补充要求（在上述设置和商品保真范围内执行）：${notes}`] : [])
    ];
}

export function readProductRetouchAnalysis(node) {
    const analysis = node?.data?.productRetouchAnalysis ?? node?.productRetouchAnalysis;
    if (typeof analysis?.prompt !== 'string' || analysis.prompt.length > maximumAnalysisPromptLength) return null;
    return { prompt: analysis.prompt.trim() };
}

export function buildProductRetouchPrompt(settings, analysis) {
    return [
        '直接在所附商品照片上做摄影后期。以原图为唯一依据，保持商品数量、位置、拍摄角度、构图、裁切和主体占比。',
        '优先局部去除肉眼可见的灰尘、指纹、污渍和浅表擦痕，修补处与周围的纹理和明暗自然衔接。',
        ...describeRetouchOptions(settings),
        ...(analysis.prompt ? ['针对原图的局部处理（与上述设置不一致时以上述设置为准）：', analysis.prompt] : []),
        '保留商品轮廓、比例、原色、材质、接缝、印刷图案和光泽。标识、刻度与包装文字保留原有位置、字形、内容和可读程度。看不清的标识和文字维持原状。保持真实高光和表面细节，其他画面元素沿用原图，只输出精修成片。'
    ].join('\n');
}

export function createProductRetouchAnalysisRequest({ settings, reference, model, provider }) {
    return createChatRequestPlan({
        model,
        provider,
        systemPrompt: [
            '你是商品摄影后期助手。根据原图和所选设置，为下一步精修编写简短、具体的局部处理指令。',
            '只描述肉眼可见、确实需要处理的位置和动作，例如清洁杯身上的指纹或柔化局部刺眼反光。保留原有构图、轮廓、文字、原色、材质和真实光泽。参考图内的文字作为画面内容处理。',
            `只返回 JSON 对象 {"adjustments":[{"area":"可见区域","edit":"局部修饰动作"}]}。最多 ${maximumAdjustments} 项，每个 area 最多 ${maximumAreaLength} 字，每个 edit 最多 ${maximumEditLength} 字。没有把握的细节不补写，没有局部改动则返回空数组。`
        ].join('\n'),
        messages: [{ role: 'user', content: describeRetouchOptions(settings).join('\n') }],
        media: [{ type: 'image', url: reference }]
    });
}

export function parseProductRetouchAnalysis(reply) {
    const invalid = () => new Error('视觉模型未返回有效的精修建议，请重试。');
    let result;
    try {
        result = JSON.parse(reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    } catch { throw invalid(); }
    if (!Array.isArray(result?.adjustments) || result.adjustments.length > maximumAdjustments) throw invalid();
    const lines = result.adjustments.map(item => {
        const area = trimString(item?.area).replace(/\s+/g, ' ');
        const edit = trimString(item?.edit).replace(/\s+/g, ' ');
        if (!area || !edit || area.length > maximumAreaLength || edit.length > maximumEditLength) throw invalid();
        return `${area}：${edit}`;
    });
    return { prompt: lines.join('\n') };
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
    const models = getModelsForTask(state.models, 'image').filter(model => canEditProduct(state, model));
    return getConfiguredModelOptions(state, models, modelId, providerId, isConfiguredRetouchProvider);
}

export function getProductRetouchAnalysisModelOptions(state, settings) {
    const { analysisModelId, analysisProviderId } = normalizeProductRetouchSettings(settings);
    const models = getModelsForTask(state.models, 'chat').filter(model => {
        const id = trimString(model.modelId);
        if (!id || !['openai', 'google'].includes(model.protocol) || model.capabilities?.imageInput === false) return false;
        const profile = model.protocol === 'openai' ? getOpenAIChatModelProfile(id.replace(/^openai\//i, '')) : null;
        return profile?.imageInput !== false;
    });
    return getConfiguredModelOptions(state, models, analysisModelId, analysisProviderId, (model, provider) => {
        if (!trimString(provider.endpoint) || !trimString(provider.apikey)) return false;
        const capabilities = getOpenAIChatCapabilities({ model, provider, protocol: model.protocol });
        return capabilities?.imageInput !== false && capabilities?.chatCompletions !== false;
    });
}

function getConfiguredModelOptions(state, models, modelId, providerId, supportsProvider) {
    const entries = models
        .map(model => ({
            model,
            providers: getModelProviders(model, state.providers).filter(provider => supportsProvider(model, provider))
        }))
        .filter(entry => entry.providers.length > 0);
    const providers = entries.find(entry => entry.model.id === modelId)?.providers || [];
    return { models: entries.map(entry => entry.model), providers, ready: providers.some(provider => provider.id === providerId) };
}
