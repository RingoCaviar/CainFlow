/**
 * 统一封装供应商请求协议、模型能力与图片响应解析逻辑。
 */
const IMAGE_INPUT_KEYS = ['image_1', 'image_2', 'image_3', 'image_4', 'image_5'];
const VALID_PROTOCOLS = new Set(['google', 'openai']);

export const GOOGLE_IMAGE_RESOLUTION_OPTIONS = [
    { value: '', label: '默认 (1K)' },
    { value: '2K', label: '2K' },
    { value: '4K', label: '4K' }
];

export const OPENAI_IMAGE_RESOLUTION_OPTIONS = [
    { value: '', label: '自动' },
    { value: '1024x1024', label: '1024×1024' },
    { value: '2048x2048', label: '2048×2048' },
    { value: 'custom', label: '自定义' }
];

function getProtocolValue(protocol) {
    return VALID_PROTOCOLS.has(protocol) ? protocol : '';
}

function getFingerprintProtocol(model = {}) {
    const fingerprint = `${model?.name || ''} ${model?.modelId || ''}`.toLowerCase();
    if (fingerprint.includes('gemini')) return 'google';
    if (
        fingerprint.includes('gpt-') ||
        fingerprint.includes('dall-e') ||
        fingerprint.includes('gpt image') ||
        fingerprint.includes('gpt-image') ||
        fingerprint.includes('openai')
    ) {
        return 'openai';
    }
    return '';
}

function getProviderFromLookup(providerId, providers) {
    if (!providerId || !providers) return null;
    if (providers instanceof Map) return providers.get(providerId) || null;
    if (Array.isArray(providers)) return providers.find((provider) => provider?.id === providerId) || null;
    if (typeof providers === 'object') return providers[providerId] || null;
    return null;
}

export function getModelOptionLabel(model = {}, providers = null) {
    const modelName = String(model?.name || '').trim() || '未命名模型';
    const provider = getProviderFromLookup(model?.providerId, providers);
    const providerName = String(provider?.name || '').trim();
    return providerName ? `${modelName} - ${providerName}` : modelName;
}

export function normalizeModelTaskType(taskType, model = {}) {
    if (taskType === 'image' || taskType === 'chat') return taskType;

    const fingerprint = `${model?.name || ''} ${model?.modelId || ''}`.toLowerCase();
    if (
        fingerprint.includes('gpt-image') ||
        fingerprint.includes('dall-e') ||
        fingerprint.includes('image-preview') ||
        fingerprint.includes('image generation') ||
        fingerprint.includes('image-generation') ||
        fingerprint.includes('生图')
    ) {
        return 'image';
    }

    return 'chat';
}

export function inferProtocolFromEndpoint(endpoint) {
    const normalized = String(endpoint || '').trim().toLowerCase();
    if (!normalized) return '';
    if (
        normalized.includes('generativelanguage.googleapis.com') ||
        normalized.includes('/v1beta/models/') ||
        normalized.includes(':generatecontent')
    ) {
        return 'google';
    }
    if (
        normalized.includes('/chat/completions') ||
        normalized.includes('/images/generations') ||
        normalized.includes('/images/edits') ||
        normalized.includes('/responses')
    ) {
        return 'openai';
    }
    return '';
}

export function normalizeProviderType(type, provider = {}, fallbackProtocol = '') {
    return getProtocolValue(type) || inferProtocolFromEndpoint(provider?.endpoint) || fallbackProtocol;
}

export function normalizeModelProtocol(protocol, model = {}, provider = null) {
    return getProtocolValue(protocol)
        || getProtocolValue(provider?.type)
        || inferProtocolFromEndpoint(provider?.endpoint)
        || getFingerprintProtocol(model)
        || 'openai';
}

export function getEffectiveProtocol(modelCfg = {}, apiCfg = null) {
    return normalizeModelProtocol(modelCfg?.protocol, modelCfg, apiCfg);
}

export function getImageResolutionOptionsForModel(model = {}, providers = null) {
    const provider = getProviderFromLookup(model?.providerId, providers);
    return getEffectiveProtocol(model, provider) === 'openai'
        ? OPENAI_IMAGE_RESOLUTION_OPTIONS
        : GOOGLE_IMAGE_RESOLUTION_OPTIONS;
}

export function normalizeImageResolutionForModel(resolution, model = {}, providers = null) {
    const options = getImageResolutionOptionsForModel(model, providers);
    const value = String(resolution || '').trim();
    if (options.some((option) => option.value === value)) return value;
    return options[0]?.value || '';
}

export function validateOpenAiImageSize(widthValue, heightValue) {
    const width = Number(widthValue);
    const height = Number(heightValue);
    const errors = [];

    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        return {
            valid: false,
            errors: ['请输入有效的宽度和高度。'],
            width,
            height
        };
    }

    const longSide = Math.max(width, height);
    const shortSide = Math.min(width, height);
    const totalPixels = width * height;

    if (longSide > 3840) errors.push('最大边长必须小于或等于 3840px。');
    if (width % 16 !== 0 || height % 16 !== 0) errors.push('宽度和高度都必须是 16px 的倍数。');
    if (longSide / shortSide > 3) errors.push('长边与短边之比不得超过 3:1。');
    if (totalPixels < 655360 || totalPixels > 8294400) {
        errors.push('总像素数必须至少为 655,360，且不得超过 8,294,400。');
    }

    return {
        valid: errors.length === 0,
        errors,
        width,
        height
    };
}

export function normalizeModelConfig(model = {}, index = 0, providers = null) {
    const provider = getProviderFromLookup(model?.providerId, providers);
    return {
        id: String(model?.id || `mod_import_${index + 1}`),
        name: typeof model?.name === 'string' && model.name.trim() ? model.name.trim() : `导入模型 ${index + 1}`,
        modelId: typeof model?.modelId === 'string' ? model.modelId : '',
        providerId: typeof model?.providerId === 'string' ? model.providerId : '',
        taskType: normalizeModelTaskType(model?.taskType, model),
        protocol: normalizeModelProtocol(model?.protocol, model, provider)
    };
}

export function getModelsForTask(models = [], taskType) {
    return models.filter((model) => normalizeModelTaskType(model?.taskType, model) === taskType);
}

function getBaseEndpoint(endpoint) {
    return String(endpoint || '').replace(/\/+$/, '');
}

function normalizeGoogleAutoCompleteBase(base) {
    return String(base || '').replace(/\/(?:v\d+(?:beta)?)(?:\/models(?:\/.*)?)?$/i, '');
}

function normalizeOpenAiAutoCompleteBase(base) {
    const cleaned = String(base || '').replace(/\/(?:chat\/completions|images\/(?:generations|edits)|responses)\/?$/i, '');
    if (!cleaned) return '';
    if (/\/v\d+$/i.test(cleaned)) return cleaned;
    return `${cleaned}/v1`;
}

export function normalizeAutoCompleteBase(endpoint, protocol = '') {
    const base = getBaseEndpoint(endpoint);
    if (!base) return '';
    if (protocol === 'google') return normalizeGoogleAutoCompleteBase(base);
    if (protocol === 'openai') return normalizeOpenAiAutoCompleteBase(base);
    return base;
}

function appendOpenAiPath(base, path) {
    if (!base) return path;
    if (base.toLowerCase().endsWith(path)) return base;
    return `${base}${path}`;
}

function hasOpenAiReferenceImages(inputs = {}) {
    return IMAGE_INPUT_KEYS.some((key) => typeof inputs[key] === 'string' && inputs[key].trim());
}

export function resolveProviderUrl(apiCfg, modelCfg, taskType, options = {}) {
    if (apiCfg?.autoComplete === false) return apiCfg?.endpoint || '';

    const protocol = getEffectiveProtocol(modelCfg, apiCfg);
    const base = normalizeAutoCompleteBase(apiCfg?.endpoint, protocol);
    if (protocol === 'google') {
        return `${base}/v1beta/models/${encodeURIComponent(modelCfg.modelId)}:generateContent?key=${apiCfg.apikey}`;
    }

    if (taskType === 'image') {
        const imagePath = hasOpenAiReferenceImages(options.inputs) ? '/images/edits' : '/images/generations';
        return appendOpenAiPath(base, imagePath);
    }

    return appendOpenAiPath(base, '/chat/completions');
}

export function getInputInlineParts(inputs = {}) {
    const parts = [];
    for (const key of IMAGE_INPUT_KEYS) {
        const value = inputs[key];
        if (!value) continue;
        const match = value.match(/^data:(.+?);base64,(.+)$/);
        if (match) {
            parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
    }
    return parts;
}

export function getOpenAiImageContents(inputs = {}) {
    const imageContents = [];
    for (const key of IMAGE_INPUT_KEYS) {
        if (inputs[key]) imageContents.push({ type: 'image_url', image_url: { url: inputs[key] } });
    }
    return imageContents;
}

export function buildGoogleImageRequest({ prompt, inputs = {}, aspect, resolution, searchEnabled }) {
    const parts = [{ text: prompt }, ...getInputInlineParts(inputs)];
    const requestBody = { contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } };
    const imageConfig = {};
    if (aspect) imageConfig.aspectRatio = aspect;
    if (resolution) imageConfig.imageSize = resolution;
    if (Object.keys(imageConfig).length > 0) requestBody.generationConfig.imageConfig = imageConfig;
    if (searchEnabled) requestBody.tools = [{ googleSearch: {} }];
    return requestBody;
}

export function buildGoogleChatRequest({ prompt, inputs = {}, sysprompt, searchEnabled }) {
    const parts = [{ text: prompt }, ...getInputInlineParts(inputs)];
    const body = { contents: [{ parts }] };
    if (sysprompt) body.systemInstruction = { parts: [{ text: sysprompt }] };
    if (searchEnabled) body.tools = [{ googleSearch: {} }];
    return body;
}

export function buildOpenAiChatRequest({ modelCfg, prompt, inputs = {}, sysprompt }) {
    const messages = [];
    if (sysprompt) messages.push({ role: 'system', content: sysprompt });

    const imageContents = getOpenAiImageContents(inputs);
    const userContent = imageContents.length > 0
        ? [{ type: 'text', text: prompt }, ...imageContents]
        : prompt;

    messages.push({ role: 'user', content: userContent });
    return { model: modelCfg.modelId, messages };
}

function normalizeOpenAiImageSize(resolution) {
    const value = String(resolution || '').trim().toLowerCase();
    if (value === 'auto') return 'auto';
    return /^\d{2,5}x\d{2,5}$/.test(value) ? value : '';
}

function getOpenAiReferenceImages(inputs = {}) {
    return IMAGE_INPUT_KEYS
        .map((key) => inputs[key])
        .filter((value) => typeof value === 'string' && value.trim());
}

export function buildOpenAiImageRequest({ modelCfg, prompt, resolution, inputs = {} }) {
    const requestBody = {
        model: modelCfg.modelId,
        prompt,
        n: 1
    };

    const size = normalizeOpenAiImageSize(resolution);
    if (size) requestBody.size = size;

    const referenceImages = getOpenAiReferenceImages(inputs);
    if (referenceImages.length > 0) requestBody.reference_images = referenceImages;

    return requestBody;
}

export function extractImageResult(apiCfg, result, modelCfg = null) {
    if (getEffectiveProtocol(modelCfg, apiCfg) === 'google') {
        const candidate = result?.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        for (const part of parts) {
            if (part?.inlineData?.data) {
                return {
                    dataUrl: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
                };
            }
        }
        return null;
    }

    const firstImage = result?.data?.[0];
    if (!firstImage) return null;

    const base64Data = firstImage.b64_json || firstImage.b64Json || '';
    if (base64Data) {
        return {
            dataUrl: `data:image/png;base64,${base64Data}`
        };
    }

    if (typeof firstImage.url === 'string' && firstImage.url.trim()) {
        return {
            url: firstImage.url.trim()
        };
    }

    return null;
}
