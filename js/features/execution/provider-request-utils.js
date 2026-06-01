/**
 * 统一封装供应商请求协议、模型能力与图片响应解析逻辑。
 */
import {
    getVideoProtocolOptionMeta as getRegisteredVideoProtocolOptionMeta,
    getProtocolSelectOptions,
    isKnownModelProtocol,
    MODEL_PROTOCOL_IDS
} from './model-protocol-registry.js';

const VALID_PROTOCOLS = new Set(MODEL_PROTOCOL_IDS);

function getImageInputKeys(inputs = {}) {
    return Object.keys(inputs)
        .filter((key) => /^image_\d+$/.test(key))
        .sort((a, b) => {
            const numA = parseInt(a.slice('image_'.length), 10) || 0;
            const numB = parseInt(b.slice('image_'.length), 10) || 0;
            return numA - numB;
        });
}

export const GOOGLE_IMAGE_RESOLUTION_OPTIONS = [
    { value: '', label: '默认 (1K)' },
    { value: '2K', label: '2K' },
    { value: '4K', label: '4K' }
];

export const OPENAI_IMAGE_RESOLUTION_OPTIONS = [
    { value: '', label: '自动 (auto)' },
    { value: '1024x1024', label: '1024×1024 · 1:1 方图' },
    { value: '1024x768', label: '1024×768 · 4:3 1K 横图' },
    { value: '768x1024', label: '768×1024 · 3:4 1K 竖图' },
    { value: '1536x1024', label: '1536×1024 · 3:2 横图' },
    { value: '1024x1536', label: '1024×1536 · 2:3 竖图' },
    { value: '2048x2048', label: '2048×2048 · 1:1 2K 方图' },
    { value: '2048x1536', label: '2048×1536 · 4:3 2K 横图' },
    { value: '1536x2048', label: '1536×2048 · 3:4 2K 竖图' },
    { value: '2048x1152', label: '2048×1152 · 16:9 2K 横图' },
    { value: '1152x2048', label: '1152×2048 · 9:16 2K 竖图' },
    { value: '2880x2880', label: '2880×2880 · 1:1 4K 方图' },
    { value: '3072x2304', label: '3072×2304 · 4:3 4K 横图' },
    { value: '2304x3072', label: '2304×3072 · 3:4 4K 竖图' },
    { value: '3840x2160', label: '3840×2160 · 16:9 4K 横图' },
    { value: '2160x3840', label: '2160×3840 · 9:16 4K 竖图' },
    { value: 'custom', label: '自定义' }
];

export const NEWAPI_ASYNC_IMAGE_RESOLUTION_OPTIONS = [
    { value: '', label: '默认' },
    { value: '1k', label: '1K' },
    { value: '2k', label: '2K' },
    { value: '4k', label: '4K' }
];

export const VIDEO_ASPECT_OPTIONS = [
    { value: '16:9', label: '16:9 横屏' },
    { value: '9:16', label: '9:16 竖屏' }
];

export const DOUBAO_VIDEO_RATIO_OPTIONS = [
    { value: '16:9', label: '16:9 横屏' },
    { value: '4:3', label: '4:3' },
    { value: '1:1', label: '1:1 方屏' },
    { value: '3:4', label: '3:4' },
    { value: '9:16', label: '9:16 竖屏' },
    { value: '21:9', label: '21:9 宽银幕' }
];

export const DOUBAO_VIDEO_RESOLUTION_OPTIONS = [
    { value: '480p', label: '480p' },
    { value: '720p', label: '720p' },
    { value: '1080p', label: '1080p' }
];

export const VIDEO_PROTOCOL_OPTIONS = getProtocolSelectOptions('video');

export function getVideoProtocolOptionMeta(protocol = '') {
    return getRegisteredVideoProtocolOptionMeta(protocol);
}

function getProtocolValue(protocol) {
    return isKnownModelProtocol(protocol) && VALID_PROTOCOLS.has(protocol) ? protocol : '';
}

function getFingerprintProtocol(model = {}) {
    const fingerprint = `${model?.name || ''} ${model?.modelId || ''}`.toLowerCase();
    if (fingerprint.includes('gemini')) return 'google';
    if (
        fingerprint.includes('gpt-') ||
        fingerprint.includes('dall-e') ||
        fingerprint.includes('gpt image') ||
        fingerprint.includes('gpt-image') ||
        fingerprint.includes('nana-banana') ||
        fingerprint.includes('openai')
    ) {
        return 'openai';
    }
    return '';
}

function normalizeUniqueStringList(values = []) {
    const seen = new Set();
    const result = [];
    values.forEach((value) => {
        const normalized = String(value || '').trim();
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        result.push(normalized);
    });
    return result;
}

export function getProviderFromLookup(providerId, providers) {
    if (!providerId || !providers) return null;
    if (providers instanceof Map) return providers.get(providerId) || null;
    if (Array.isArray(providers)) return providers.find((provider) => provider?.id === providerId) || null;
    if (typeof providers === 'object') return providers[providerId] || null;
    return null;
}

export function getModelProviderIds(model = {}) {
    if (Array.isArray(model?.providerIds)) {
        return normalizeUniqueStringList(model.providerIds);
    }
    const providerIds = [];
    const fallbackProviderId = typeof model?.providerId === 'string' ? model.providerId : '';
    return normalizeUniqueStringList([
        ...providerIds,
        fallbackProviderId
    ]);
}

export function modelSupportsProvider(model = {}, providerId = '') {
    const normalizedProviderId = String(providerId || '').trim();
    if (!normalizedProviderId) return false;
    return getModelProviderIds(model).includes(normalizedProviderId);
}

export function getModelProviders(model = {}, providers = null) {
    return getModelProviderIds(model)
        .map((providerId) => getProviderFromLookup(providerId, providers))
        .filter(Boolean);
}

export function getResolvedProviderIdForModel(model = {}, providers = null, preferredProviderId = '') {
    const preferredId = String(preferredProviderId || '').trim();
    const configuredProviderIds = getModelProviderIds(model);
    const availableProviderIds = providers
        ? getModelProviders(model, providers).map((provider) => provider.id)
        : configuredProviderIds;

    if (preferredId && availableProviderIds.includes(preferredId)) {
        return preferredId;
    }
    return availableProviderIds[0] || configuredProviderIds[0] || '';
}

export function getResolvedProviderForModel(model = {}, providers = null, preferredProviderId = '') {
    const providerId = getResolvedProviderIdForModel(model, providers, preferredProviderId);
    return getProviderFromLookup(providerId, providers);
}

export function getModelOptionLabel(model = {}, providers = null) {
    const modelName = String(model?.name || '').trim() || '未命名模型';
    const modelProviders = getModelProviders(model, providers);
    if (modelProviders.length === 1) {
        const providerName = String(modelProviders[0]?.name || '').trim();
        return providerName ? `${modelName} - ${providerName}` : modelName;
    }
    if (modelProviders.length > 1) {
        const providerName = String(modelProviders[0]?.name || '').trim();
        return providerName
            ? `${modelName} - ${providerName} 等${modelProviders.length}个供应商`
            : `${modelName} - ${modelProviders.length}个供应商`;
    }
    return modelName;
}

export function normalizeModelTaskType(taskType, model = {}) {
    if (taskType === 'image' || taskType === 'chat' || taskType === 'video') return taskType;

    const fingerprint = `${model?.name || ''} ${model?.modelId || ''}`.toLowerCase();
    if (
        fingerprint.includes('gpt-image') ||
        fingerprint.includes('banana') ||
        fingerprint.includes('dall-e') ||
        fingerprint.includes('image-preview') ||
        fingerprint.includes('image generation') ||
        fingerprint.includes('image-generation') ||
        fingerprint.includes('生图')
    ) {
        return 'image';
    }

    if (
        fingerprint.includes('veo') ||
        fingerprint.includes('video') ||
        fingerprint.includes('视频')
    ) {
        return 'video';
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
    if (isKnownModelProtocol(protocol)) {
        return protocol;
    }
    return getProtocolValue(protocol)
        || getProtocolValue(provider?.type)
        || inferProtocolFromEndpoint(provider?.endpoint)
        || getFingerprintProtocol(model)
        || 'openai';
}

export function getEffectiveProtocol(modelCfg = {}, apiCfg = null) {
    return normalizeModelProtocol(modelCfg?.protocol, modelCfg, apiCfg);
}

export function getImageResolutionOptionsForModel(model = {}, providers = null, preferredProviderId = '') {
    const provider = getResolvedProviderForModel(model, providers, preferredProviderId);
    const protocol = getEffectiveProtocol(model, provider);
    if (protocol === 'newapi-image-async') return NEWAPI_ASYNC_IMAGE_RESOLUTION_OPTIONS;
    return protocol === 'openai' ? OPENAI_IMAGE_RESOLUTION_OPTIONS : GOOGLE_IMAGE_RESOLUTION_OPTIONS;
}

export function normalizeImageResolutionForModel(resolution, model = {}, providers = null, preferredProviderId = '') {
    const options = getImageResolutionOptionsForModel(model, providers, preferredProviderId);
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

function isOpenAiImageResolutionOptionValid(option) {
    const value = String(option?.value || '').trim();
    if (!value || value === 'custom') return true;
    const match = value.match(/^(\d{2,5})x(\d{2,5})$/i);
    if (!match) return false;
    return validateOpenAiImageSize(match[1], match[2]).valid;
}

export function validateOpenAiImageResolutionOptions(options = OPENAI_IMAGE_RESOLUTION_OPTIONS) {
    return options.every(isOpenAiImageResolutionOptionValid);
}

export function normalizeModelConfig(model = {}, index = 0, providers = null) {
    const providerIds = getModelProviderIds(model);
    const provider = getResolvedProviderForModel({ ...model, providerIds }, providers);
    return {
        id: String(model?.id || `mod_import_${index + 1}`),
        name: typeof model?.name === 'string' && model.name.trim() ? model.name.trim() : `导入模型 ${index + 1}`,
        modelId: typeof model?.modelId === 'string' ? model.modelId : '',
        providerIds,
        providerId: providerIds[0] || '',
        taskType: normalizeModelTaskType(model?.taskType, model),
        protocol: normalizeModelProtocol(model?.protocol, model, provider)
    };
}

export function getModelsForTask(models = [], taskType) {
    return models.filter((model) => normalizeModelTaskType(model?.taskType, model) === taskType);
}

export function normalizeProviderEndpointUrl(endpoint) {
    const raw = String(endpoint || '').trim();
    if (!raw) return '';
    return raw.includes('://') ? raw : `http://${raw}`;
}

function getBaseEndpoint(endpoint) {
    return normalizeProviderEndpointUrl(endpoint).replace(/\/+$/, '');
}

function normalizeGoogleAutoCompleteBase(base) {
    return String(base || '').replace(/\/(?:v\d+(?:beta)?)(?:\/models(?:\/.*)?)?$/i, '');
}

function normalizeOpenAiAutoCompleteBase(base) {
    const cleaned = String(base || '').replace(/\/(?:chat\/completions|images\/(?:generations|edits)|responses|video\/(?:create|query)|videos(?:\/[^/?#]+(?:\/content)?)?)\/?$/i, '');
    if (!cleaned) return '';
    if (/\/v\d+$/i.test(cleaned)) return cleaned;
    return `${cleaned}/v1`;
}

function normalizeUnifiedVideoBase(base) {
    const cleaned = String(base || '')
        .replace(/\/(?:v\d+\/video\/(?:create|query)|video\/(?:create|query))\/?$/i, '')
        .replace(/\/+$/, '');
    return cleaned;
}

function normalizeDoubaoVideoBase(base) {
    return String(base || '')
        .replace(/\/(?:volc\/v1\/contents\/generations\/tasks(?:\/[^/?#]+)?|api\/v3\/contents\/generations\/tasks(?:\/[^/?#]+)?|v1\/video\/(?:create|query)|v1\/videos(?:\/[^/?#]+(?:\/content)?)?)\/?$/i, '')
        .replace(/\/+$/, '');
}

export function normalizeAutoCompleteBase(endpoint, protocol = '') {
    const base = getBaseEndpoint(endpoint);
    if (!base) return '';
    if (protocol === 'google') return normalizeGoogleAutoCompleteBase(base);
    if (protocol === 'openai' || protocol === 'veo-openai' || protocol === 'newapi-image-async') return normalizeOpenAiAutoCompleteBase(base);
    if (protocol === 'veo-unified') return normalizeUnifiedVideoBase(base);
    if (protocol === 'doubao-video') return normalizeDoubaoVideoBase(base);
    return base;
}

function appendOpenAiPath(base, path) {
    if (!base) return path;
    if (base.toLowerCase().endsWith(path)) return base;
    return `${base}${path}`;
}

function appendUnifiedVideoPath(base, path) {
    const normalizedBase = normalizeUnifiedVideoBase(base);
    if (!normalizedBase) return `/v1${path}`;
    if (normalizedBase.toLowerCase().endsWith(`/v1${path}`)) return normalizedBase;
    if (/\/v1$/i.test(normalizedBase)) return `${normalizedBase}${path}`;
    return `${normalizedBase}/v1${path}`;
}

function replaceVideoEndpointPath(endpoint, nextPath) {
    const base = String(endpoint || '').replace(/\/+$/, '');
    if (!base) return nextPath;
    return base.replace(/\/video\/(?:create|query)$/i, nextPath);
}

function appendQueryParam(url, key, value) {
    if (!url || value === undefined || value === null || value === '') return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
}

function hasOpenAiReferenceImages(inputs = {}) {
    return getImageInputKeys(inputs).some((key) => typeof inputs[key] === 'string' && inputs[key].trim());
}

export function resolveProviderUrl(apiCfg, modelCfg, taskType, options = {}) {
    if (apiCfg?.autoComplete === false) {
        const endpoint = normalizeProviderEndpointUrl(apiCfg?.endpoint);
        const protocol = getEffectiveProtocol(modelCfg, apiCfg);
        if (taskType === 'image' && protocol === 'newapi-image-async') {
            const action = options.action || 'create';
            if (action === 'query') return appendOpenAiPath(normalizeOpenAiAutoCompleteBase(endpoint), `/videos/${encodeURIComponent(options.imageTaskId || options.taskId || '')}`);
            return endpoint;
        }
        if (taskType === 'video') {
            const action = options.action || 'create';
            if (protocol === 'doubao-video') {
                const doubaoBase = normalizeDoubaoVideoBase(endpoint);
                if (action === 'query') return `${doubaoBase}/volc/v1/contents/generations/tasks/${encodeURIComponent(options.videoId || '')}`;
                return `${doubaoBase}/volc/v1/contents/generations/tasks`;
            }
            if (protocol === 'veo-openai') {
                if (action === 'create') return endpoint;
                if (action === 'query') return appendOpenAiPath(normalizeOpenAiAutoCompleteBase(endpoint), `/videos/${encodeURIComponent(options.videoId || '')}`);
                if (action === 'download') return appendOpenAiPath(normalizeOpenAiAutoCompleteBase(endpoint), `/videos/${encodeURIComponent(options.videoId || '')}/content`);
            }
            if (action === 'query') {
                return appendQueryParam(replaceVideoEndpointPath(endpoint, '/video/query'), 'id', options.videoId || '');
            }
            return replaceVideoEndpointPath(endpoint, '/video/create');
        }
        return endpoint;
    }

    const protocol = getEffectiveProtocol(modelCfg, apiCfg);
    const base = normalizeAutoCompleteBase(apiCfg?.endpoint, protocol);
    if (protocol === 'google') {
        return `${base}/v1beta/models/${encodeURIComponent(modelCfg.modelId)}:generateContent?key=${apiCfg.apikey}`;
    }

    if (taskType === 'image') {
        if (protocol === 'newapi-image-async') {
            const action = options.action || 'create';
            if (action === 'query') return appendOpenAiPath(base, `/videos/${encodeURIComponent(options.imageTaskId || options.taskId || '')}`);
            return appendOpenAiPath(base, '/videos');
        }
        const imagePath = hasOpenAiReferenceImages(options.inputs) ? '/images/edits' : '/images/generations';
        return appendOpenAiPath(base, imagePath);
    }

    if (taskType === 'video') {
        const action = options.action || 'create';
        if (protocol === 'doubao-video') {
            const doubaoBase = normalizeDoubaoVideoBase(apiCfg?.endpoint || base);
            if (action === 'query') return `${doubaoBase}/volc/v1/contents/generations/tasks/${encodeURIComponent(options.videoId || '')}`;
            return `${doubaoBase}/volc/v1/contents/generations/tasks`;
        }
        if (protocol === 'veo-openai') {
            if (action === 'create') return appendOpenAiPath(base, '/videos');
            if (action === 'query') return appendOpenAiPath(base, `/videos/${encodeURIComponent(options.videoId || '')}`);
            if (action === 'download') return appendOpenAiPath(base, `/videos/${encodeURIComponent(options.videoId || '')}/content`);
        }
        if (action === 'query') return appendQueryParam(appendUnifiedVideoPath(base, '/video/query'), 'id', options.videoId || '');
        return appendUnifiedVideoPath(base, '/video/create');
    }

    return appendOpenAiPath(base, '/chat/completions');
}

export function getInputInlineParts(inputs = {}) {
    const parts = [];
    getImageInputKeys(inputs).forEach((key) => {
        const value = inputs[key];
        if (!value) return;
        const match = value.match(/^data:(.+?);base64,(.+)$/);
        if (match) {
            parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
    });
    return parts;
}

export function getOpenAiImageContents(inputs = {}) {
    const imageContents = [];
    getImageInputKeys(inputs).forEach((key) => {
        if (inputs[key]) imageContents.push({ type: 'image_url', image_url: { url: inputs[key] } });
    });
    return imageContents;
}

function getCustomRequestParams(inputs = {}) {
    const params = inputs.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
    return Object.entries(params).reduce((acc, [key, value]) => {
        if (typeof key === 'string' && key.trim()) acc[key.trim()] = value;
        return acc;
    }, {});
}

function applyCustomRequestParams(requestBody, inputs = {}) {
    return { ...requestBody, ...getCustomRequestParams(inputs) };
}

export function buildGoogleImageRequest({ prompt, inputs = {}, aspect, resolution, searchEnabled }) {
    const parts = [{ text: prompt }, ...getInputInlineParts(inputs)];
    const requestBody = { contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } };
    const imageConfig = {};
    if (aspect) imageConfig.aspectRatio = aspect;
    if (resolution) imageConfig.imageSize = resolution;
    if (Object.keys(imageConfig).length > 0) requestBody.generationConfig.imageConfig = imageConfig;
    if (searchEnabled) requestBody.tools = [{ googleSearch: {} }];
    return applyCustomRequestParams(requestBody, inputs);
}

export function buildGoogleChatRequest({ prompt, inputs = {}, sysprompt, searchEnabled }) {
    const parts = [{ text: prompt }, ...getInputInlineParts(inputs)];
    const body = { contents: [{ parts }] };
    if (sysprompt) body.systemInstruction = { parts: [{ text: sysprompt }] };
    if (searchEnabled) body.tools = [{ googleSearch: {} }];
    return applyCustomRequestParams(body, inputs);
}

export function buildOpenAiChatRequest({ modelCfg, prompt, inputs = {}, sysprompt }) {
    const messages = [];
    if (sysprompt) messages.push({ role: 'system', content: sysprompt });

    const imageContents = getOpenAiImageContents(inputs);
    const userContent = imageContents.length > 0
        ? [{ type: 'text', text: prompt }, ...imageContents]
        : prompt;

    messages.push({ role: 'user', content: userContent });
    return applyCustomRequestParams({ model: modelCfg.modelId, messages }, inputs);
}

function normalizeOpenAiImageSize(resolution) {
    const value = String(resolution || '').trim().toLowerCase();
    if (value === 'auto') return 'auto';
    return /^\d{2,5}x\d{2,5}$/.test(value) ? value : '';
}

function normalizeOpenAiImageQuality(quality) {
    const value = String(quality || '').trim().toLowerCase();
    return value === 'low' || value === 'medium' || value === 'high' ? value : '';
}

function normalizeOpenAiImageModeration(moderation) {
    const value = String(moderation || '').trim().toLowerCase();
    return value === 'low' || value === 'auto' ? value : '';
}

function normalizeOpenAiImageBackground(background) {
    const value = String(background || '').trim().toLowerCase();
    return value === 'transparent' || value === 'opaque' || value === 'auto' ? value : '';
}

function getOpenAiReferenceImages(inputs = {}) {
    return getImageInputKeys(inputs)
        .map((key) => inputs[key])
        .filter((value) => typeof value === 'string' && value.trim());
}

function getImageInputUrl(inputs = {}, key = '') {
    const value = inputs[key];
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function getUnifiedVideoFrameImages(inputs = {}) {
    return ['image_1', 'image_2']
        .map((key) => getImageInputUrl(inputs, key))
        .filter(Boolean);
}

function getUnifiedVideoIngredientImages(inputs = {}) {
    return ['image_3', 'image_4', 'image_5']
        .map((key) => getImageInputUrl(inputs, key))
        .filter(Boolean);
}

function getDoubaoVideoFrameImage(inputs = {}, key = '') {
    return getImageInputUrl(inputs, key);
}

function getDoubaoVideoReferenceImages(inputs = {}) {
    return getImageInputKeys(inputs)
        .filter((key) => {
            const index = parseInt(key.slice('image_'.length), 10) || 0;
            return index >= 3;
        })
        .map((key) => getImageInputUrl(inputs, key))
        .filter(Boolean);
}

function addDoubaoImageContent(content, url, role) {
    if (!url) return;
    const item = {
        type: 'image_url',
        image_url: { url }
    };
    if (role) item.role = role;
    content.push(item);
}

export function buildOpenAiImageRequest({ modelCfg, prompt, resolution, quality, moderation, background, mask = null, inputs = {} }) {
    const requestBody = {
        model: modelCfg.modelId,
        prompt,
        n: 1
    };

    const size = normalizeOpenAiImageSize(resolution);
    if (size) requestBody.size = size;

    const normalizedQuality = normalizeOpenAiImageQuality(quality);
    if (normalizedQuality) requestBody.quality = normalizedQuality;

    const normalizedModeration = normalizeOpenAiImageModeration(moderation);
    if (normalizedModeration) requestBody.moderation = normalizedModeration;

    const normalizedBackground = normalizeOpenAiImageBackground(background);
    if (normalizedBackground) requestBody.background = normalizedBackground;

    if (mask?.data) {
        requestBody.mask = {
            name: mask.name || 'mask.png',
            type: mask.type || 'image/png',
            size: Number(mask.size) || 0,
            data: mask.data
        };
    }

    const referenceImages = getOpenAiReferenceImages(inputs);
    if (referenceImages.length > 0) requestBody.reference_images = referenceImages;

    return applyCustomRequestParams(requestBody, inputs);
}

function normalizeNewApiAsyncImageResolution(resolution) {
    const value = String(resolution || '').trim().toLowerCase();
    if (value === '1k' || value === '2k' || value === '4k') return value;
    return '';
}

export function buildNewApiAsyncImageRequest({ modelCfg, prompt, aspect, resolution, inputs = {} }) {
    const requestBody = {
        model: modelCfg.modelId,
        prompt
    };

    if (aspect) requestBody.aspect_ratio = aspect;

    const normalizedResolution = normalizeNewApiAsyncImageResolution(resolution);
    if (normalizedResolution) requestBody.resolution = normalizedResolution;

    const imageUrls = getOpenAiReferenceImages(inputs);
    if (imageUrls.length > 0) requestBody.image_urls = imageUrls;

    return applyCustomRequestParams(requestBody, inputs);
}

function applyVideoRatioParam(requestBody, aspectRatio, useSizeParam = false) {
    if (!aspectRatio) return;
    if (useSizeParam) requestBody.size = aspectRatio;
    else requestBody.aspect_ratio = aspectRatio;
}

export function buildUnifiedVideoRequest({
    modelCfg,
    prompt,
    aspectRatio,
    useSizeParam = false,
    enhancePrompt = false,
    enableUpsample = false,
    inputs = {}
}) {
    const requestBody = {
        model: modelCfg.modelId,
        prompt
    };

    applyVideoRatioParam(requestBody, aspectRatio, useSizeParam);
    requestBody.enhance_prompt = enhancePrompt === true;
    requestBody.enable_upsample = enableUpsample === true;

    const frameImages = getUnifiedVideoFrameImages(inputs);
    if (frameImages.length > 0) requestBody.images = frameImages;

    const ingredientImages = getUnifiedVideoIngredientImages(inputs);
    if (ingredientImages.length > 0) requestBody.Ingredients_images = ingredientImages;

    return applyCustomRequestParams(requestBody, inputs);
}

export function buildOpenAiVideoRequest({ modelCfg, prompt, aspectRatio, useSizeParam = false, inputs = {} }) {
    const requestBody = {
        model: modelCfg.modelId,
        prompt
    };

    applyVideoRatioParam(requestBody, aspectRatio, useSizeParam);

    const frameImages = getUnifiedVideoFrameImages(inputs);
    if (frameImages.length > 0) requestBody.images = frameImages;

    const ingredientImages = getUnifiedVideoIngredientImages(inputs);
    if (ingredientImages.length > 0) requestBody.Ingredients_images = ingredientImages;

    return applyCustomRequestParams(requestBody, inputs);
}

export function buildDoubaoVideoRequest({
    modelCfg,
    prompt,
    aspectRatio,
    resolution = '',
    duration = '',
    cameraFixed = false,
    generateAudio = false,
    watermark = false,
    seed = '',
    inputs = {}
}) {
    const normalizedResolution = String(resolution || '').trim();
    const normalizedRatio = String(aspectRatio || '').trim();
    const normalizedDuration = parseInt(duration, 10);
    const normalizedSeed = seed === '' || seed === null || seed === undefined
        ? null
        : parseInt(seed, 10);

    const requestBody = {
        model: modelCfg.modelId,
        content: [
            {
                type: 'text',
                text: prompt
            }
        ]
    };

    if (normalizedResolution) requestBody.resolution = normalizedResolution;
    if (normalizedRatio) requestBody.ratio = normalizedRatio;
    if (Number.isFinite(normalizedDuration) && normalizedDuration > 0) requestBody.duration = normalizedDuration;
    requestBody.camera_fixed = cameraFixed === true;
    requestBody.watermark = watermark === true;
    if (generateAudio === true) requestBody.generate_audio = true;
    if (Number.isFinite(normalizedSeed) && normalizedSeed >= 0) requestBody.seed = normalizedSeed;

    addDoubaoImageContent(requestBody.content, getDoubaoVideoFrameImage(inputs, 'image_1'), 'first_frame');
    addDoubaoImageContent(requestBody.content, getDoubaoVideoFrameImage(inputs, 'image_2'), 'last_frame');
    getDoubaoVideoReferenceImages(inputs).forEach((url) => {
        addDoubaoImageContent(requestBody.content, url, 'reference_image');
    });

    return applyCustomRequestParams(requestBody, inputs);
}

export function extractVideoTaskId(result, protocol = '') {
    if (protocol === 'veo-openai') {
        return String(result?.id || '').trim();
    }
    if (protocol === 'doubao-video') {
        return String(
            result?.id ||
            result?.task_id ||
            result?.data?.id ||
            result?.data?.task_id ||
            result?.task?.id ||
            ''
        ).trim();
    }
    if (protocol === 'veo-unified') {
        return String(
            result?.id ||
            result?.task_id ||
            result?.taskId ||
            result?.data?.id ||
            result?.data?.task_id ||
            result?.detail?.id ||
            result?.detail?.task_id ||
            ''
        ).trim();
    }
    return String(
        result?.id ||
        result?.task_id ||
        result?.taskId ||
        result?.data?.id ||
        result?.data?.task_id ||
        ''
    ).trim();
}

export function extractVideoStatus(result, protocol = '') {
    if (protocol === 'doubao-video') {
        const rawStatus = result?.status || result?.state || result?.data?.status || result?.data?.state || result?.task?.status || '';
        return String(rawStatus || '').trim().toLowerCase();
    }
    const rawStatus = protocol === 'veo-openai'
        ? (result?.status || result?.state || '')
        : (result?.status || result?.state || result?.data?.status || result?.data?.state || '');
    return String(rawStatus || '').trim().toLowerCase();
}

export function extractVideoResult(result, protocol = '') {
    const pickVideoUrl = (data = {}) => {
        const candidates = [
            data?.content_url,
            data?.video_url,
            data?.url,
            Array.isArray(data?.result_urls) ? data.result_urls[0] : '',
            Array.isArray(data?.video_urls) ? data.video_urls[0] : '',
            Array.isArray(data?.metadata?.result_urls) ? data.metadata.result_urls[0] : '',
            Array.isArray(data?.metadata?.video_urls) ? data.metadata.video_urls[0] : ''
        ];
        const matched = candidates.find((value) => typeof value === 'string' && value.trim());
        return typeof matched === 'string' ? matched.trim() : '';
    };

    if (protocol === 'veo-openai') {
        return {
            url: pickVideoUrl(result),
            revisedPrompt: typeof result?.prompt === 'string' ? result.prompt : ''
        };
    }
    if (protocol === 'doubao-video') {
        const data = result?.data && typeof result.data === 'object' ? result.data : result;
        return {
            url: pickVideoUrl(data),
            revisedPrompt: typeof data?.prompt === 'string'
                ? data.prompt
                : (typeof data?.text === 'string' ? data.text : '')
        };
    }

    const data = result?.data && typeof result.data === 'object' ? result.data : result;
    return {
        url: pickVideoUrl(data),
        revisedPrompt: typeof data?.prompt === 'string' ? data.prompt : ''
    };
}

export function extractAsyncImageTaskId(result) {
    return String(
        result?.id ||
        result?.task_id ||
        result?.taskId ||
        result?.data?.id ||
        result?.data?.task_id ||
        result?.metadata?.task_id ||
        ''
    ).trim();
}

export function extractAsyncImageStatus(result) {
    return String(
        result?.status ||
        result?.state ||
        result?.task_status ||
        result?.data?.status ||
        result?.data?.state ||
        result?.data?.task_status ||
        ''
    ).trim().toLowerCase();
}

export function extractAsyncImageResult(result) {
    const pickImageUrl = (data = {}) => {
        const candidates = [
            data?.image_url,
            data?.url,
            data?.video_url,
            data?.content_url,
            Array.isArray(data?.image_urls) ? data.image_urls[0] : '',
            Array.isArray(data?.result_urls) ? data.result_urls[0] : '',
            Array.isArray(data?.metadata?.result_urls) ? data.metadata.result_urls[0] : '',
            Array.isArray(data?.metadata?.image_urls) ? data.metadata.image_urls[0] : ''
        ];
        const matched = candidates.find((value) => typeof value === 'string' && value.trim());
        return typeof matched === 'string' ? matched.trim() : '';
    };
    const data = result?.data && typeof result.data === 'object' ? result.data : result;
    return {
        url: pickImageUrl(data),
        revisedPrompt: typeof data?.prompt === 'string' ? data.prompt : ''
    };
}

export function extractImageResult(apiCfg, result, modelCfg = null) {
    if (result?.cainflowRecoveredImage && result?.recoveredImage?.dataUrl) {
        return {
            dataUrl: result.recoveredImage.dataUrl,
            recovered: true,
            recoverySource: result.recoveredImage.source || 'backend'
        };
    }

    if (getEffectiveProtocol(modelCfg, apiCfg) === 'google') {
        const candidate = result?.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        for (const part of parts) {
            const inlineData = part?.inlineData || part?.inline_data;
            if (inlineData?.data) {
                return {
                    dataUrl: `data:${inlineData.mimeType || inlineData.mime_type || 'image/png'};base64,${inlineData.data}`
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
