/** 图片生成节点的分辨率档位、比例与请求尺寸共用同一份映射。 */
import { getGoogleImageCapabilities } from './google-image-capabilities.js';
import { getOpenAiImageCapabilities } from './openai-image-capabilities.js';

export const GOOGLE_IMAGE_RESOLUTION_OPTIONS = [
    { value: '', label: '默认 (1K)' },
    { value: '2K', label: '2K' },
    { value: '4K', label: '4K' }
];

export const OPENAI_IMAGE_RESOLUTION_OPTIONS = [
    { value: '', label: '自动' },
    { value: '1K', label: '1K' },
    { value: '2K', label: '2K' },
    { value: '4K', label: '4K' },
    { value: 'custom', label: '自定义' }
];

export const NEWAPI_ASYNC_IMAGE_RESOLUTION_OPTIONS = [
    { value: '', label: '默认' },
    { value: '1k', label: '1K' },
    { value: '2k', label: '2K' },
    { value: '4k', label: '4K' }
];

export const IMAGE_ASPECT_OPTIONS = [
    { value: '', label: '自动' },
    ...['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9']
        .map((value) => ({ value, label: value }))
];

export const OPENAI_IMAGE_ASPECT_OPTIONS = [
    ...['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
        .map((value) => ({ value, label: value }))
];

// Values are the exact OpenAI `size` strings. All satisfy the documented GPT Image 2 limits.
const OPENAI_PRESET_SIZES = {
    '1K': {
        '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024',
        '3:4': '768x1024', '4:3': '1024x768', '4:5': '816x1024',
        '5:4': '1024x816', '9:16': '864x1536', '16:9': '1536x864',
        '21:9': '1536x656'
    },
    '2K': {
        '1:1': '2048x2048', '2:3': '1360x2048', '3:2': '2048x1360',
        '3:4': '1536x2048', '4:3': '2048x1536', '4:5': '1648x2048',
        '5:4': '2048x1648', '9:16': '1152x2048', '16:9': '2048x1152',
        '21:9': '2048x880'
    },
    '4K': {
        '1:1': '2880x2880', '2:3': '2304x3456', '3:2': '3456x2304',
        '3:4': '2304x3072', '4:3': '3072x2304', '4:5': '2560x3200',
        '5:4': '3200x2560', '9:16': '2160x3840', '16:9': '3840x2160',
        '21:9': '3840x1648'
    }
};

const FIXED_OPENAI_SIZES = {
    'gpt-image-1': { '1K': { '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024' } },
    'dall-e-2': { '1K': { '1:1': '1024x1024' }, '256px': { '1:1': '256x256' }, '512px': { '1:1': '512x512' } },
    'dall-e-3': { '1K': { '1:1': '1024x1024', '7:4': '1792x1024', '4:7': '1024x1792' } }
};

function fixedOpenAiSizes(protocol, modelId) {
    return protocol === 'openai' ? FIXED_OPENAI_SIZES[getOpenAiImageCapabilities(modelId)?.sizeProfile] : undefined;
}

export function usesOpenAiImageSize(protocol) {
    return protocol === 'openai' || protocol === 'ttapi-openai';
}

export function getImageResolutionOptionsForProtocol(protocol, modelId) {
    if (protocol === 'newapi-image-async') return NEWAPI_ASYNC_IMAGE_RESOLUTION_OPTIONS;
    const imageSizes = protocol === 'google' ? getGoogleImageCapabilities(modelId)?.imageSizes : undefined;
    if (imageSizes) {
        return [GOOGLE_IMAGE_RESOLUTION_OPTIONS[0], ...imageSizes.map(value => ({ value, label: value === '512' ? '512 px' : value }))];
    }
    const fixed = fixedOpenAiSizes(protocol, modelId);
    if (fixed) {
        const automatic = fixed === FIXED_OPENAI_SIZES['gpt-image-1'];
        return [{ value: '', label: automatic ? '自动' : '默认' }, ...Object.keys(fixed).map(value => ({ value, label: value }))];
    }
    return usesOpenAiImageSize(protocol) ? OPENAI_IMAGE_RESOLUTION_OPTIONS : GOOGLE_IMAGE_RESOLUTION_OPTIONS;
}

export function getImageAspectOptionsForProtocol(protocol, modelId) {
    const aspectRatios = protocol === 'google' ? getGoogleImageCapabilities(modelId)?.aspectRatios : undefined;
    if (aspectRatios) return IMAGE_ASPECT_OPTIONS.filter(({ value }) => !value || aspectRatios.includes(value));
    const fixed = fixedOpenAiSizes(protocol, modelId);
    if (fixed) return Object.keys(fixed['1K']).map(value => ({ value, label: value }));
    return usesOpenAiImageSize(protocol) ? OPENAI_IMAGE_ASPECT_OPTIONS : IMAGE_ASPECT_OPTIONS;
}

export function getImageAspectSelectState(protocol, resolution, aspect = '', modelId) {
    const options = getImageAspectOptionsForProtocol(protocol, modelId);
    if (!usesOpenAiImageSize(protocol)) {
        const value = protocol === 'google' && getGoogleImageCapabilities(modelId)?.aspectRatios
            ? (options.some(option => option.value === aspect) ? aspect : '')
            : aspect;
        return { options, value, disabled: false, title: '' };
    }
    if (!resolution || resolution === 'custom') {
        const label = resolution === 'custom' ? '由自定义宽高决定' : '由模型决定';
        return {
            options: [{ value: '', label, disabled: true }, ...options],
            value: '', disabled: true, title: label
        };
    }
    return {
        options,
        value: options.some((option) => option.value === aspect) ? aspect : '1:1',
        disabled: false,
        title: ''
    };
}

export function getLegacyOpenAiImageSizeSelection(size, protocol = 'openai', modelId) {
    const value = String(size || '').trim().toLowerCase();
    if (!/^\d{2,5}x\d{2,5}$/.test(value)) return null;
    const fixed = fixedOpenAiSizes(protocol, modelId);
    for (const [resolution, ratios] of Object.entries(fixed || OPENAI_PRESET_SIZES)) {
        const aspect = Object.keys(ratios).find(ratio => ratios[ratio] === value);
        if (aspect) return { resolution, aspect, customWidth: '', customHeight: '' };
    }
    if (fixed) return null;
    const [customWidth, customHeight] = value.split('x');
    return { resolution: 'custom', aspect: '', customWidth, customHeight };
}

export function normalizeImageSizeControls({ resolution = '', aspect = '', customWidth = '', customHeight = '' } = {}, protocol = '', modelId) {
    const fixed = fixedOpenAiSizes(protocol, modelId);
    const storedSize = fixed && resolution === 'custom' ? `${customWidth}x${customHeight}` : resolution;
    const legacy = usesOpenAiImageSize(protocol) ? getLegacyOpenAiImageSizeSelection(storedSize, protocol, modelId) : null;
    const options = getImageResolutionOptionsForProtocol(protocol, modelId);
    const rawResolution = legacy?.resolution || String(resolution || '').trim();
    const caseMatched = options.find((option) => option.value && option.value.toLowerCase() === rawResolution.toLowerCase());
    const normalizedResolution = options.some((option) => option.value === rawResolution)
        ? rawResolution
        : (caseMatched?.value || '');
    const ratioOptions = getImageAspectOptionsForProtocol(protocol, modelId);
    const rawAspect = legacy?.aspect || String(aspect || '').trim();
    const normalizedAspect = usesOpenAiImageSize(protocol)
        ? (normalizedResolution && normalizedResolution !== 'custom'
            ? (ratioOptions.some((option) => option.value === rawAspect) ? rawAspect : '1:1')
            : '')
        : (ratioOptions.some((option) => option.value === rawAspect) ? rawAspect : '');
    return {
        resolution: normalizedResolution,
        aspect: normalizedAspect,
        customWidth: legacy?.customWidth || String(customWidth || ''),
        customHeight: legacy?.customHeight || String(customHeight || '')
    };
}

export function validateOpenAiImageSize(widthValue, heightValue) {
    const width = Number(widthValue);
    const height = Number(heightValue);
    const errors = [];
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        return { valid: false, errors: ['请输入有效的宽度和高度。'], width, height };
    }
    const longSide = Math.max(width, height);
    const shortSide = Math.min(width, height);
    const totalPixels = width * height;
    if (longSide > 3840) errors.push('最大边长必须小于或等于 3840px。');
    if (width % 16 !== 0 || height % 16 !== 0) errors.push('宽度和高度都必须是 16px 的倍数。');
    if (longSide / shortSide > 3) errors.push('长边与短边之比不得超过 3:1。');
    if (totalPixels < 655360 || totalPixels > 8294400) errors.push('总像素数必须至少为 655,360，且不得超过 8,294,400。');
    return { valid: errors.length === 0, errors, width, height };
}

export function resolveImageRequestSize({ protocol = '', modelId, resolution = '', aspect = '', customWidth = '', customHeight = '' } = {}) {
    if (usesOpenAiImageSize(protocol)) {
        const fixed = fixedOpenAiSizes(protocol, modelId);
        const storedSize = fixed && resolution === 'custom' ? `${customWidth}x${customHeight}` : resolution;
        const legacy = getLegacyOpenAiImageSizeSelection(storedSize, protocol, modelId);
        const selected = legacy || normalizeImageSizeControls({ resolution, aspect, customWidth, customHeight }, protocol, modelId);
        if (fixed) {
            const requested = String(resolution || '').trim().toLowerCase();
            if (requested && requested !== 'auto' && (!selected.resolution || !legacy && aspect && selected.aspect !== aspect)) {
                throw new Error(`${modelId} 不支持所选分辨率或宽高比，请重新选择。`);
            }
            const size = fixed[selected.resolution]?.[selected.aspect] || '';
            const fallback = fixed === FIXED_OPENAI_SIZES['gpt-image-1'] ? '自动（由模型决定）' : '默认（由模型决定）';
            return { resolution: size, aspect: '', display: size ? `${size.replace('x', ' × ')} px` : fallback };
        }
        if (legacy && legacy.resolution !== 'custom') {
            return { resolution: String(resolution).toLowerCase(), aspect: '', display: `${String(resolution).replace('x', ' × ')} px` };
        }
        if (selected.resolution === 'custom') {
            const width = legacy?.customWidth || customWidth;
            const height = legacy?.customHeight || customHeight;
            const validation = validateOpenAiImageSize(width, height);
            if (!validation.valid) throw new Error(`自定义分辨率不符合 OpenAI 规范：${validation.errors.join(' ')}`);
            const size = `${validation.width}x${validation.height}`;
            return { resolution: size, aspect: '', display: `${validation.width} × ${validation.height} px` };
        }
        const size = OPENAI_PRESET_SIZES[selected.resolution]?.[selected.aspect || '1:1'] || '';
        return { resolution: size, aspect: '', display: size ? `${size.replace('x', ' × ')} px` : '自动（由模型决定）' };
    }

    const selected = normalizeImageSizeControls({ resolution, aspect }, protocol, modelId);
    const google = protocol === 'google' ? getGoogleImageCapabilities(modelId) : undefined;
    if (google?.imageSizes) {
        const requestedSize = String(resolution || '').trim().toUpperCase();
        const requestedAspect = String(aspect || '').trim();
        const fixedSizeDefault = !google.imageSizes.length && requestedSize === '1K';
        if (requestedSize && requestedSize !== 'AUTO' && !fixedSizeDefault && !selected.resolution) {
            throw new Error(`${modelId} 不支持分辨率 ${resolution}，请重新选择。`);
        }
        if (requestedAspect && requestedAspect.toLowerCase() !== 'auto' && !selected.aspect) {
            throw new Error(`${modelId} 不支持宽高比 ${aspect}，请重新选择。`);
        }
    }
    const requestResolution = protocol === 'ttapi' ? (selected.resolution || '1K') : selected.resolution;
    const label = requestResolution || (google?.imageSizes ? '默认（1K）' : '默认（未指定）');
    return {
        resolution: requestResolution,
        aspect: selected.aspect,
        display: requestResolution ? `${label}（具体像素由模型决定）` : label
    };
}
