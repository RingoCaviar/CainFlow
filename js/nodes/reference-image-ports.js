export const DEFAULT_REFERENCE_IMAGE_COUNT = 5;
export const MIN_REFERENCE_IMAGE_COUNT = 0;
export const MAX_REFERENCE_IMAGE_COUNT = 64;
export const REFERENCE_IMAGE_NODE_TYPES = new Set(['ImageGenerate', 'VideoGenerate', 'TextChat']);

export function normalizeReferenceImageCount(value, fallback = DEFAULT_REFERENCE_IMAGE_COUNT) {
    const parsed = parseInt(value ?? fallback, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_REFERENCE_IMAGE_COUNT;
    return Math.max(MIN_REFERENCE_IMAGE_COUNT, Math.min(MAX_REFERENCE_IMAGE_COUNT, parsed));
}

export function getReferenceImageCount(restoreData = {}) {
    const rd = restoreData || {};
    return normalizeReferenceImageCount(
        rd.referenceImageCount ?? rd.referenceImageInputCount ?? rd.data?.referenceImageCount,
        DEFAULT_REFERENCE_IMAGE_COUNT
    );
}

export function getReferenceImageInputPorts(restoreData = {}, nodeType = '') {
    const count = getReferenceImageCount(restoreData);
    const normalizedNodeType = String(nodeType || restoreData?.type || restoreData?.nodeType || '').trim();
    if (normalizedNodeType === 'VideoGenerate') {
        const labels = ['首帧', '尾帧', '参考图 1', '参考图 2', '参考图 3'];
        return Array.from({ length: count }, (_, index) => ({
            name: `image_${index + 1}`,
            type: 'image',
            label: labels[index] || `参考图 ${Math.max(1, index - 1)}`
        }));
    }
    return Array.from({ length: count }, (_, index) => ({
        name: `image_${index + 1}`,
        type: 'image',
        label: `参考图 ${index + 1}`
    }));
}

export function applyReferenceImagePorts(config, restoreData = {}) {
    if (!REFERENCE_IMAGE_NODE_TYPES.has(config?.type)) return config;
    const baseInputs = Array.isArray(config.inputs)
        ? config.inputs.filter((port) => !(port?.type === 'image' && /^image_\d+$/.test(String(port?.name || ''))))
        : [];
    const paramsIndex = baseInputs.findIndex((port) => port?.name === 'params');
    const referencePorts = getReferenceImageInputPorts(restoreData, config?.type || '');
    const inputs = paramsIndex >= 0
        ? [
            ...baseInputs.slice(0, paramsIndex),
            ...referencePorts,
            ...baseInputs.slice(paramsIndex)
        ]
        : [...baseInputs, ...referencePorts];
    return { ...config, inputs };
}
