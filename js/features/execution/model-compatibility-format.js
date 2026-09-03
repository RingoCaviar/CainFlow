import { isKnownModelProtocol } from './model-protocol-registry.js';

function getModelFingerprint(model = {}) {
    return `${model.id || ''} ${model.modelId || ''} ${model.name || ''} ${model.displayName || ''}`.toLowerCase();
}

export function inferModelCompatibilityFormat(model = {}) {
    const fingerprint = getModelFingerprint(model);

    if (/(?:^|[^a-z0-9])(?:ttapi|veo|newapi|new-api)(?:$|[^a-z0-9])/.test(fingerprint)) return '';
    if (/(?:^|[^a-z0-9])(?:gemini|banana)(?:$|[^a-z0-9])/.test(fingerprint)) return 'google';
    if (/(?:^|[^a-z0-9])(?:doubao|seedance)(?:$|[^a-z0-9])/.test(fingerprint)) return 'doubao-video';
    if (/(?:^|[^a-z0-9])kling-o3(?:$|[^a-z0-9])/.test(fingerprint)) return 'async-video-api';
    if (
        fingerprint.includes('grok') ||
        /\b(?:gpt|openai)\b/.test(fingerprint) ||
        fingerprint.includes('dall-e') ||
        /\bo[134](?:-|\b)/.test(fingerprint)
    ) {
        return 'openai';
    }
    return '';
}

export function getModelCompatibilityFormatLabel(protocol = '') {
    if (protocol === 'google') return 'Google / Gemini';
    if (protocol === 'openai') return 'OpenAI';
    if (protocol === 'doubao-video') return '豆包视频';
    if (protocol === 'async-video-api') return '6789中转视频';
    return '未识别 · 需手动选择';
}

export function createFetchedModelConfig({ generatedId, providerId, fetchedModel = {}, taskType }) {
    return {
        id: generatedId,
        name: fetchedModel.name || fetchedModel.id,
        modelId: fetchedModel.id,
        providerIds: [providerId],
        providerId,
        taskType,
        protocol: inferModelCompatibilityFormat(fetchedModel)
    };
}

export function addFetchedModelToCollection({ models, config = null, ...configOptions }) {
    const fetchedConfig = config || createFetchedModelConfig(configOptions);
    models.push(fetchedConfig);
    return fetchedConfig;
}

export function findFetchedModelConfig(models = [], { modelId, protocol, taskType }, normalizeTaskType = (value) => value) {
    return models.find((model) => (
        model.modelId === modelId &&
        normalizeTaskType(model.taskType, model) === normalizeTaskType(taskType, model) &&
        (isKnownModelProtocol(model.protocol) ? model.protocol : '') === protocol
    )) || null;
}

export function requireModelCompatibilityFormat(model = {}) {
    const protocol = String(model.protocol || '').trim();
    if (!isKnownModelProtocol(protocol)) {
        const name = String(model.name || model.modelId || '当前模型').trim();
        throw new Error(`无法使用“${name}”：请先在模型设置中手动选择兼容格式`);
    }
    return protocol;
}
