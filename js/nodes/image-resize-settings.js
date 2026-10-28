/** Read the original controls or their existing node fields, scoped to one node identity. */
export function readImageResizeSettings(node) {
    const id = node?.id || '', data = node?.data || {};
    const control = suffix => node?.el?.querySelector?.(`#${id}-${suffix}`) || node?.parameterRoot?.querySelector?.(`#${id}-${suffix}`);
    const value = (suffix, key, fallback) => control(suffix)?.value ?? node?.[key] ?? data[key] ?? fallback;
    const percent = (raw, fallback) => Math.max(1, Math.min(100, parseInt(raw, 10) || fallback));
    return {
        resizeMode: value('resize-mode', 'resizeMode', 'scale') === 'dimensions' ? 'dimensions' : 'scale',
        scalePercent: percent(value('scale-percent', 'scalePercent', 100), 100),
        targetWidth: String(value('target-width', 'targetWidth', '')),
        targetHeight: String(value('target-height', 'targetHeight', '')),
        keepAspect: control('keep-aspect')?.checked ?? node?.keepAspect ?? data.keepAspect ?? true,
        quality: percent(value('quality', 'quality', 92), 92)
    };
}
