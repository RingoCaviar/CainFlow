import { getOpenAiImageCapabilities } from '../features/execution/openai-image-capabilities.js';
import { getGoogleImageCapabilities } from '../features/execution/google-image-capabilities.js';

export function supportsImageWebSearch(protocol, modelId) {
    if (protocol === 'google') return getGoogleImageCapabilities(modelId)?.search !== false;
    return !['openai', 'ttapi-openai', 'newapi-image-async'].includes(protocol);
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
