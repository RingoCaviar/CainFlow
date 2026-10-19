/** 图片生成节点的分辨率档位、比例与请求尺寸共用同一份映射。 */

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

const LEGACY_PRESET_SIZES = new Map(
    Object.entries(OPENAI_PRESET_SIZES).flatMap(([resolution, ratios]) =>
        Object.entries(ratios).map(([aspect, size]) => [size, { resolution, aspect }])
    )
);

export function usesOpenAiImageSize(protocol) {
    return protocol === 'openai' || protocol === 'ttapi-openai';
}

export function getImageResolutionOptionsForProtocol(protocol) {
    if (protocol === 'newapi-image-async') return NEWAPI_ASYNC_IMAGE_RESOLUTION_OPTIONS;
    return usesOpenAiImageSize(protocol) ? OPENAI_IMAGE_RESOLUTION_OPTIONS : GOOGLE_IMAGE_RESOLUTION_OPTIONS;
}

export function getImageAspectOptionsForProtocol(protocol) {
    return usesOpenAiImageSize(protocol) ? OPENAI_IMAGE_ASPECT_OPTIONS : IMAGE_ASPECT_OPTIONS;
}

export function getImageAspectSelectState(protocol, resolution, aspect = '') {
    const options = getImageAspectOptionsForProtocol(protocol);
    if (!usesOpenAiImageSize(protocol)) {
        return { options, value: aspect, disabled: false, title: '' };
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

export function getLegacyOpenAiImageSizeSelection(size) {
    const value = String(size || '').trim().toLowerCase();
    if (!/^\d{2,5}x\d{2,5}$/.test(value)) return null;
    const preset = LEGACY_PRESET_SIZES.get(value);
    if (preset) return { ...preset, customWidth: '', customHeight: '' };
    const [, customWidth, customHeight] = value.match(/^(\d+)x(\d+)$/);
    return { resolution: 'custom', aspect: '', customWidth, customHeight };
}

export function normalizeImageSizeControls({ resolution = '', aspect = '', customWidth = '', customHeight = '' } = {}, protocol = '') {
    const legacy = usesOpenAiImageSize(protocol) ? getLegacyOpenAiImageSizeSelection(resolution) : null;
    const options = getImageResolutionOptionsForProtocol(protocol);
    const rawResolution = legacy?.resolution || String(resolution || '').trim();
    const caseMatched = options.find((option) => option.value && option.value.toLowerCase() === rawResolution.toLowerCase());
    const normalizedResolution = options.some((option) => option.value === rawResolution)
        ? rawResolution
        : (caseMatched?.value || '');
    const ratioOptions = getImageAspectOptionsForProtocol(protocol);
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

export function resolveImageRequestSize({ protocol = '', resolution = '', aspect = '', customWidth = '', customHeight = '' } = {}) {
    if (usesOpenAiImageSize(protocol)) {
        const legacy = getLegacyOpenAiImageSizeSelection(resolution);
        const selected = legacy || normalizeImageSizeControls({ resolution, aspect, customWidth, customHeight }, protocol);
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

    const selected = normalizeImageSizeControls({ resolution, aspect }, protocol);
    const requestResolution = protocol === 'ttapi' ? (selected.resolution || '1K') : selected.resolution;
    const label = requestResolution || '默认（未指定）';
    return {
        resolution: requestResolution,
        aspect: selected.aspect,
        display: requestResolution ? `${label}（具体像素由模型决定）` : label
    };
}

