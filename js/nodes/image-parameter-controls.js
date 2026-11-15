import { getOpenAiImageCapabilities } from '../features/execution/openai-image-capabilities.js';
import { getGoogleImageCapabilities } from '../features/execution/google-image-capabilities.js';

export function supportsImageWebSearch(protocol, modelId) {
    if (protocol === 'google') return getGoogleImageCapabilities(modelId)?.search !== false;
    return !['openai', 'ttapi-openai', 'newapi-image-async'].includes(protocol);
}

export function supportsOpenAiOutputCompression(format) {
    return format === 'jpeg' || format === 'webp';
}

const DEFAULT_VALUES = {
    quality: ['auto', 'low', 'medium', 'high'],
    moderation: ['auto', 'low'],
    background: ['auto', 'transparent', 'opaque']
};
const LABELS = {
    '': '默认', auto: '自动', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高',
    standard: '标准', hd: '高清', transparent: '透明', opaque: '不透明'
};

export function getImageParameterValues(protocol, modelId) {
    if (protocol === 'ttapi-openai') return DEFAULT_VALUES;
    if (protocol !== 'openai') return {};
    const capabilities = getOpenAiImageCapabilities(modelId);
    return capabilities ? {
        quality: capabilities.qualities.length > 1 ? capabilities.qualities : [],
        moderation: capabilities.moderations,
        background: capabilities.backgrounds
    } : DEFAULT_VALUES;
}

const STANDARD_PROTOCOL_FIELDS = new Set([
    'referenceImages', 'prompt', 'model', 'aspect', 'aspect_ratio', 'resolution', 'image_size',
    'size', 'quality', 'moderation', 'background', 'search', 'google_search'
]);
export function getImageGenerateExtraProtocol(protocol, modelId) {
    if (!protocol?.parameters) return null;
    const capabilities = protocol.id === 'openai' ? getOpenAiImageCapabilities(modelId) : null;
    const openAiOptions = {
        output_format: capabilities?.outputFormats,
        input_fidelity: capabilities?.inputFidelities?.length > 1 ? capabilities.inputFidelities : [],
        style: capabilities?.styles,
        response_format: capabilities?.responseFormats,
        complexity: capabilities?.complexities
    };
    const parameters = Object.entries(protocol.parameters).reduce((result, [paramId, param]) => {
        const effectiveId = param.id || paramId;
        if (param.exposed !== true || param.taskTypes && !param.taskTypes.includes('image')
            || STANDARD_PROTOCOL_FIELDS.has(paramId) || STANDARD_PROTOCOL_FIELDS.has(effectiveId)) return result;
        if (protocol.id === 'openai' && Object.hasOwn(openAiOptions, effectiveId)) {
            const values = openAiOptions[effectiveId];
            if (values?.length) result[paramId] = { ...param, options: (param.options || []).filter(option => !option.value || values.includes(option.value)) };
        } else if (protocol.id !== 'openai' || effectiveId !== 'output_compression' || capabilities?.outputFormats.length) {
            result[paramId] = param;
        }
        return result;
    }, {});
    return Object.keys(parameters).length ? { ...protocol, parameters } : null;
}

export function renderImageParameterOptions(name, values, selected = '') {
    const current = String(selected || '').toLowerCase();
    const options = values?.length ? values : DEFAULT_VALUES[name];
    return ['', ...options].map(value =>
        `<option value="${value}"${value === current ? ' selected' : ''}>${name === 'moderation' && value === 'low' ? '低限制' : LABELS[value]}</option>`
    ).join('');
}

export function syncImageParameterControls(documentRef, id, protocol, modelId) {
    const fields = getImageParameterValues(protocol, modelId);
    for (const name of Object.keys(DEFAULT_VALUES)) {
        const values = fields[name] || [];
        const field = documentRef.getElementById(`${id}-${name}-field`);
        const control = documentRef.getElementById(`${id}-${name}`);
        field?.classList.toggle('hidden', values.length === 0);
        if (control && values.length) control.innerHTML = renderImageParameterOptions(name, values, control.value);
    }
}
