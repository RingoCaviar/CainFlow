import { getImageResolutionOptionsForProtocol, getImageAspectOptionsForProtocol, getLegacyOpenAiImageSizeSelection, OPENAI_IMAGE_DIMENSION_LIMITS, usesOpenAiImageSize, validateOpenAiImageSize, resolveImageRequestSize } from '../execution/image-generation-size.js';
import { getGoogleImageCapabilities } from '../execution/google-image-capabilities.js';

export const SIZE_KEYS = ['resolution', 'aspectRatio', 'customWidth', 'customHeight'];
export function sizeFields(value = {}) {
    const result = Object.fromEntries(SIZE_KEYS.filter(key => Object.hasOwn(value || {}, key)).map(key => [key, value[key]]));
    if (Object.hasOwn(value || {}, 'aspect')) {
        if (Object.hasOwn(result, 'aspectRatio') && result.aspectRatio !== value.aspect) throw new Error('方案中的比例设置冲突，请明确需要的比例。');
        result.aspectRatio = value.aspect;
    }
    return result;
}
export function sizeCapabilities(protocol, modelId) {
    const resolutions = getImageResolutionOptionsForProtocol(protocol, modelId);
    return { resolutions, aspects: getImageAspectOptionsForProtocol(protocol, modelId),
        automaticLocksAspect: usesOpenAiImageSize(protocol),
        ...(resolutions.some(option => option.value === 'custom') ? { customDimensions: OPENAI_IMAGE_DIMENSION_LIMITS } : {}) };
}

export function replaceAgentSizeFields(parameters, size) {
    const { resolution, aspect, aspectRatio, customWidth, customHeight, ...rest } = parameters || {};
    return { ...rest, ...size };
}

function resolutionValue(value, protocol, modelId) {
    const normalized = String(value).trim().toLowerCase();
    const googleSizes = protocol === 'google' ? getGoogleImageCapabilities(modelId)?.imageSizes : undefined;
    if (googleSizes?.length === 0 && normalized === '1k') return '';
    if (googleSizes?.includes('512') && normalized === '512px') return '512';
    return normalized;
}

function aspectClarification(capabilities, requestedAspect, message) {
    const choices = [...capabilities.aspects.filter(option => option.value), { value: '', label: '由模型决定' }];
    return sizeClarification(message, 'aspect', choices, requestedAspect);
}

function sizeClarification(message, kind, choices, requestedAspect) {
    const error = new Error(message);
    error.sizeClarification = { kind, choices, requestedAspect };
    return error;
}

function customDimensionsForAspect(desired, tolerance, targetPixels) {
    const { alignment, maxEdge, minPixels, maxPixels } = OPENAI_IMAGE_DIMENSION_LIMITS;
    let best;
    for (let height = alignment; height <= maxEdge; height += alignment) {
        const width = Math.round(desired * height / alignment) * alignment;
        if (width <= 0 || width > maxEdge || width * height < minPixels || width * height > maxPixels) continue;
        const distance = Math.abs(Math.log((width / height) / desired));
        if (distance > tolerance || !validateOpenAiImageSize(width, height).valid) continue;
        const pixelDistance = Math.abs(Math.log(width * height / targetPixels));
        if (!best || distance < best.distance - 1e-10 || (Math.abs(distance - best.distance) < 1e-10 && pixelDistance < best.pixelDistance)) {
            best = { width, height, distance, pixelDistance };
        }
    }
    return best;
}

export function resolveDesiredAgentAspect({ protocol = '', modelId = '', aspectRatio, referenceSize, approximate = false,
    current = {}, defaults = {}, parameters = {} } = {}) {
    const capabilities = sizeCapabilities(protocol, modelId);
    const [width, height] = aspectRatio ? String(aspectRatio).split(':').map(Number)
        : [referenceSize?.width, referenceSize?.height];
    const desired = width / height;
    if (width <= 0 || height <= 0 || !Number.isFinite(desired)) {
        throw aspectClarification(capabilities, aspectRatio, '无法确定参考画面的宽高比，请选择画面比例。');
    }
    const presets = capabilities.aspects.filter(option => option.value).map(option => {
        const [w, h] = option.value.split(':').map(Number);
        return { ...option, distance: Math.abs(Math.log((w / h) / desired)) };
    }).sort((a, b) => a.distance - b.distance);
    const nearest = presets[0];
    const wantsExactRatio = Boolean(aspectRatio && !approximate);
    const tolerance = wantsExactRatio ? 1e-10 : Math.log(1.05);
    const presetsByTier = capabilities.resolutions.filter(option => option.value !== 'custom'
        && (option.value || !capabilities.automaticLocksAspect));
    const matchingTier = value => presetsByTier.find(option => option.value.toLowerCase() === resolutionValue(value, protocol, modelId));
    if (parameters.resolution && parameters.resolution !== 'custom' && !matchingTier(parameters.resolution)) {
        throw sizeClarification('当前模型不支持所选分辨率，请重新选择。', 'resolution', capabilities.resolutions, aspectRatio);
    }
    const preferredTier = [parameters.resolution, defaults.resolution, current.resolution].map(matchingTier).find(Boolean);
    const defaultTier = presetsByTier[0];
    const presetPatch = () => {
        const patch = { aspectRatio: nearest.value };
        const tier = preferredTier || (capabilities.automaticLocksAspect ? defaultTier : null);
        if (tier) patch.resolution = tier.value;
        return patch;
    };
    if (nearest?.distance <= tolerance) return presetPatch();

    if (capabilities.customDimensions) {
        const presetSize = nearest && resolveImageRequestSize({ protocol, modelId,
            resolution: (preferredTier || defaultTier)?.value, aspect: nearest.value }).resolution;
        const [presetWidth, presetHeight] = String(presetSize || '').split('x').map(Number);
        const targetPixels = (!aspectRatio && !preferredTier ? width * height : presetWidth * presetHeight) || 1024 * 1024;
        const dimensions = customDimensionsForAspect(desired, tolerance, targetPixels);
        if (dimensions) return { resolution: 'custom', customWidth: dimensions.width, customHeight: dimensions.height };
    }
    if (!wantsExactRatio && nearest) return presetPatch();
    throw aspectClarification(capabilities, aspectRatio, `当前生图模型无法设置 ${aspectRatio} 的画面比例，请选择可用比例。`);
}

export function resolveAgentSize({ protocol = '', modelId = '', current = {}, defaults = {}, parameters = {}, clarifyDraft = false } = {}) {
    const patch = { ...sizeFields(defaults), ...sizeFields(parameters) };
    const effective = { resolution: '', aspectRatio: '', customWidth: '', customHeight: '', ...sizeFields(current), ...patch };
    const capabilities = sizeCapabilities(protocol, modelId);
    const need = (message, kind, choices = capabilities.resolutions.filter(item => item.value)) => {
        throw sizeClarification(message, kind, choices, patch.aspectRatio);
    };
    const invalid = (message, kind, choices) => {
        if (clarifyDraft) need(message, kind, choices);
        throw new Error(message);
    };
    const invalidAspect = message => {
        if (clarifyDraft) throw aspectClarification(capabilities, patch.aspectRatio, message);
        throw new Error(message);
    };
    const supportsCustom = capabilities.resolutions.some(option => option.value === 'custom');
    const fixedDimensions = !supportsCustom && effective.resolution === 'custom';
    const legacySize = fixedDimensions ? `${effective.customWidth}x${effective.customHeight}` : effective.resolution;
    const legacy = usesOpenAiImageSize(protocol) && getLegacyOpenAiImageSizeSelection(legacySize, protocol, modelId);
    if (legacy) {
        const { aspect, ...size } = legacy;
        if (aspect && patch.aspectRatio && patch.aspectRatio !== aspect) {
            invalidAspect('指定的分辨率与画面比例不一致，请重新选择。');
        }
        Object.assign(effective, size, { aspectRatio: patch.aspectRatio || aspect });
    }
    const requestedResolution = resolutionValue(effective.resolution, protocol, modelId);
    const resolution = capabilities.resolutions.find(option => option.value.toLowerCase() === requestedResolution);
    if (!resolution) {
        const kind = fixedDimensions && effective.customWidth && effective.customHeight ? 'dimensions' : 'resolution';
        invalid('当前模型不支持所选分辨率，请重新选择。', kind, capabilities.resolutions);
    }
    effective.resolution = resolution.value;
    if (Object.hasOwn(patch, 'resolution')) patch.resolution = effective.resolution;
    if (legacy) Object.assign(patch, { resolution: effective.resolution, aspectRatio: effective.aspectRatio,
        ...(legacy.resolution === 'custom' ? { customWidth: legacy.customWidth, customHeight: legacy.customHeight } : {}) });
    if (effective.resolution !== 'custom') {
        if (!fixedDimensions && ['customWidth', 'customHeight'].some(key => Object.hasOwn(parameters, key))) invalid('设置宽高需要选择自定义分辨率，请确认具体尺寸。', 'dimensions');
        delete patch.customWidth; delete patch.customHeight;
        if (clarifyDraft) { effective.customWidth = ''; effective.customHeight = ''; }
    }
    const requestedAspect = patch.aspectRatio;
    if (effective.resolution !== 'custom' && effective.aspectRatio && !capabilities.aspects.some(item => item.value === effective.aspectRatio)) {
        invalidAspect('当前模型不支持所选比例，请重新选择。');
    }
    if (capabilities.automaticLocksAspect && effective.resolution && effective.resolution !== 'custom' && requestedAspect === '') {
        invalidAspect('当前分辨率档位需要具体比例，请选择比例，或将分辨率改为自动。');
    }
    if (capabilities.automaticLocksAspect && requestedAspect && !effective.resolution) {
        need('当前为自动分辨率，无法单独指定比例。请选择需要的分辨率。', 'resolution');
    }
    if (effective.resolution === 'custom') {
        if (!effective.customWidth || !effective.customHeight) need('自定义分辨率的比例由宽高决定，请提供具体宽度和高度。', 'dimensions');
        const validation = validateOpenAiImageSize(effective.customWidth, effective.customHeight);
        if (!validation.valid) invalid(validation.errors.join(' '), 'dimensions', capabilities.resolutions.filter(item => item.value !== 'custom'));
        if (requestedAspect) {
            const [w, h] = String(requestedAspect).split(':').map(Number);
            if (!w || !h || Math.abs(validation.width / validation.height - w / h) > 0.002) need('自定义分辨率的比例由宽高决定，请提供符合所需比例的宽度和高度，或选择分辨率档位。', 'dimensions');
        }
        effective.aspectRatio = ''; // The request uses width and height; the draft retains the requested ratio.
    }
    if (capabilities.automaticLocksAspect && !effective.resolution) effective.aspectRatio = '';
    if (capabilities.automaticLocksAspect && effective.resolution && effective.resolution !== 'custom' && !effective.aspectRatio) effective.aspectRatio = '1:1';
    const summary = resolveImageRequestSize({ protocol, modelId, ...effective, aspect: effective.aspectRatio }).display;
    return { patch, effective, summary: `${resolution.label}${effective.aspectRatio ? ' · ' + effective.aspectRatio : ''} · ${summary}` };
}

export function resolveDraftImageSize({ protocol = '', modelId = '', current = {}, defaults = {}, parameters = {},
    sizeIntent, answer = {}, sources = {} } = {}) {
    const answerSize = sizeFields(answer);
    const candidate = sizeFields(parameters);
    for (;;) {
        try {
            return resolveDraftSize({ protocol, modelId, current, defaults, sizeIntent,
                answerSize, sources, selected: { ...candidate, ...answerSize } });
        } catch (error) {
            const kind = error.sizeClarification?.kind;
            const fields = kind === 'aspect' ? ['aspectRatio'] : kind === 'resolution' || kind === 'dimensions'
                ? ['resolution', 'customWidth', 'customHeight'] : [];
            const discard = fields.filter(key => sources[key] === '方案建议' && Object.hasOwn(candidate, key) && !Object.hasOwn(answerSize, key));
            if (!discard.length) throw error;
            for (const key of discard) delete candidate[key];
        }
    }
}

function resolveDraftSize({ protocol, modelId, current, defaults, sizeIntent, answerSize, sources, selected }) {
    const settings = { protocol, modelId, current, defaults: sizeFields(defaults), clarifyDraft: true };
    const hasAspectAnswer = Object.hasOwn(answerSize, 'aspectRatio');
    if (answerSize.resolution !== undefined && answerSize.resolution !== 'custom') {
        delete selected.customWidth;
        delete selected.customHeight;
    }
    if (hasAspectAnswer && !answerSize.aspectRatio) {
        if (usesOpenAiImageSize(protocol)) selected.resolution = '';
        delete selected.customWidth;
        delete selected.customHeight;
        return resolveAgentSize({ ...settings, parameters: selected });
    }
    const suppliedDimensions = selected.resolution === 'custom' && selected.customWidth && selected.customHeight;
    const suggestedAspect = !suppliedDimensions && sources.aspectRatio === '方案建议' && selected.aspectRatio;
    const intent = hasAspectAnswer ? { aspectRatio: answerSize.aspectRatio } : sizeIntent || (suggestedAspect && { aspectRatio: suggestedAspect });
    if (intent && (hasAspectAnswer || !suppliedDimensions && answerSize.resolution !== 'custom')) {
        const resolved = resolveDesiredAgentAspect({ ...settings, ...intent, parameters: selected });
        delete settings.defaults.aspectRatio;
        return resolveAgentSize({ ...settings, parameters: resolved });
    }
    if (answerSize.resolution === 'custom' && suppliedDimensions) {
        selected.aspectRatio = '';
    } else if (intent?.aspectRatio) {
        selected.aspectRatio = intent.aspectRatio;
    } else if (suppliedDimensions && !Object.hasOwn(selected, 'aspectRatio')) {
        delete settings.defaults.aspectRatio;
    }
    return resolveAgentSize({ ...settings, parameters: selected });
}

// A short resolution answer is interpreted only while one plan is awaiting this information.
export function parseSizeAnswer(text) {
    const value = String(text || '').trim();
    const tier = value.match(/^(?:用|使用|选择|分辨率(?:设为|设置为)?|设为)?\s*([124])\s*[kK](?:分辨率)?[。！!]?$/);
    if (tier) return { resolution: `${tier[1]}K` };
    const square = value.match(/^(?:用|使用|选择|分辨率(?:设为|设置为)?|设为)?\s*(256|512)\s*px[。！!]?$/i);
    if (square) return { resolution: `${square[1]}px` };
    const ratio = value.match(/^(?:用|使用|选择|(?:画面|画幅|宽高)?比(?:例)?(?:设为|设置为)?|设为)?\s*(\d{1,5})\s*[:：]\s*(\d{1,5})[。！!]?$/);
    if (ratio && Number(ratio[1]) > 0 && Number(ratio[2]) > 0) return { aspectRatio: `${Number(ratio[1])}:${Number(ratio[2])}` };
    const dimensions = value.match(/^(?:自定义|尺寸|用|使用)?\s*(\d{2,5})\s*[xX×*]\s*(\d{2,5})(?:\s*(?:px|像素))?[。！!]?$/);
    return dimensions ? { resolution: 'custom', customWidth: Number(dimensions[1]), customHeight: Number(dimensions[2]) } : null;
}
