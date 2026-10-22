import { getImageResolutionOptionsForProtocol, getImageAspectOptionsForProtocol, getLegacyOpenAiImageSizeSelection, usesOpenAiImageSize, validateOpenAiImageSize, resolveImageRequestSize } from '../execution/image-generation-size.js';

export const SIZE_KEYS = ['resolution', 'aspectRatio', 'customWidth', 'customHeight'];
export function sizeFields(value = {}) {
    const result = Object.fromEntries(SIZE_KEYS.filter(key => Object.hasOwn(value || {}, key)).map(key => [key, value[key]]));
    if (Object.hasOwn(value || {}, 'aspect')) {
        if (Object.hasOwn(result, 'aspectRatio') && result.aspectRatio !== value.aspect) throw new Error('方案中的比例设置冲突，请明确需要的比例。');
        result.aspectRatio = value.aspect;
    }
    return result;
}
export function sizeCapabilities(protocol) {
    return { resolutions: getImageResolutionOptionsForProtocol(protocol), aspects: getImageAspectOptionsForProtocol(protocol),
        automaticLocksAspect: usesOpenAiImageSize(protocol) };
}
export function resolveAgentSize({ protocol = '', current = {}, defaults = {}, parameters = {} } = {}) {
    const patch = { ...sizeFields(defaults), ...sizeFields(parameters) };
    const effective = { resolution: '', aspectRatio: '', customWidth: '', customHeight: '', ...sizeFields(current), ...patch };
    const capabilities = sizeCapabilities(protocol);
    const legacy = usesOpenAiImageSize(protocol) && getLegacyOpenAiImageSizeSelection(effective.resolution);
    if (legacy) Object.assign(effective, { ...legacy, aspectRatio: patch.aspectRatio ?? legacy.aspect });
    const resolution = capabilities.resolutions.find(option => option.value.toLowerCase() === String(effective.resolution).toLowerCase());
    if (!resolution) throw new Error('当前模型不支持所选分辨率，请重新选择。');
    effective.resolution = resolution.value;
    if (Object.hasOwn(patch, 'resolution')) patch.resolution = effective.resolution;
    if (legacy) Object.assign(patch, { resolution: effective.resolution, aspectRatio: effective.aspectRatio,
        ...(legacy.resolution === 'custom' ? { customWidth: legacy.customWidth, customHeight: legacy.customHeight } : {}) });
    if (effective.resolution !== 'custom' && !legacy) {
        if (['customWidth', 'customHeight'].some(key => Object.hasOwn(parameters, key))) throw new Error('设置宽高需要选择自定义分辨率，请确认具体尺寸。');
        delete patch.customWidth; delete patch.customHeight;
    }
    const requestedAspect = patch.aspectRatio;
    if (capabilities.automaticLocksAspect && effective.resolution && effective.resolution !== 'custom' && requestedAspect === '') throw new Error('当前分辨率档位需要具体比例，请选择比例，或将分辨率改为自动。');
    const need = (message, kind) => {
        const error = new Error(message); error.sizeClarification = { kind, choices: capabilities.resolutions.filter(item => item.value), requestedAspect }; throw error;
    };
    if (capabilities.automaticLocksAspect && requestedAspect && !effective.resolution) {
        need('当前为自动分辨率，无法单独指定比例。请选择需要的分辨率。', 'resolution');
    }
    if (effective.resolution === 'custom') {
        if (!effective.customWidth || !effective.customHeight) need('自定义分辨率的比例由宽高决定，请提供具体宽度和高度。', 'dimensions');
        const validation = validateOpenAiImageSize(effective.customWidth, effective.customHeight);
        if (!validation.valid) throw new Error(validation.errors.join(' '));
        if (requestedAspect) {
            const [w, h] = String(requestedAspect).split(':').map(Number);
            if (!w || !h || Math.abs(validation.width / validation.height - w / h) > 0.002) need('自定义分辨率的比例由宽高决定，请提供符合所需比例的宽度和高度，或选择分辨率档位。', 'dimensions');
        }
        effective.aspectRatio = ''; // The request uses width and height; the draft retains the requested ratio.
    } else if (effective.aspectRatio && !capabilities.aspects.some(item => item.value === effective.aspectRatio)) {
        throw new Error('当前模型不支持所选比例，请重新选择。');
    }
    if (capabilities.automaticLocksAspect && !effective.resolution) effective.aspectRatio = '';
    if (capabilities.automaticLocksAspect && effective.resolution && effective.resolution !== 'custom' && !effective.aspectRatio) effective.aspectRatio = '1:1';
    const summary = resolveImageRequestSize({ protocol, ...effective, aspect: effective.aspectRatio }).display;
    return { patch, effective, summary: `${resolution.label}${effective.aspectRatio ? ' · ' + effective.aspectRatio : ''} · ${summary}` };
}

// A short resolution answer is interpreted only while one plan is awaiting this information.
export function parseSizeAnswer(text) {
    const value = String(text || '').trim();
    const tier = value.match(/^(?:用|使用|选择|分辨率(?:设为|设置为)?|设为)?\s*([124])\s*[kK](?:分辨率)?[。！!]?$/);
    if (tier) return { resolution: `${tier[1]}K` };
    const dimensions = value.match(/^(?:自定义|尺寸|用|使用)?\s*(\d{2,5})\s*[xX×*]\s*(\d{2,5})(?:\s*(?:px|像素))?[。！!]?$/);
    return dimensions ? { resolution: 'custom', customWidth: Number(dimensions[1]), customHeight: Number(dimensions[2]) } : null;
}
