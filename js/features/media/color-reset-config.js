const CONTROL_NAMES = ['temperature', 'tint', 'vibrance', 'saturation'];

export function normalizeColorResetConfig(options = {}) {
    const clamp = (value) => Math.max(-100, Math.min(100, Number(value) || 0));
    const mode = ['original', 'auto', 'custom'].includes(options.whiteBalanceMode)
        ? options.whiteBalanceMode
        : 'original';
    const sourceGains = options.whiteBalanceGains || {};
    const gain = (value) => Math.max(0.67, Math.min(1.5, Number(value) || 1));
    return {
        whiteBalanceMode: mode,
        whiteBalanceGains: { r: gain(sourceGains.r), g: gain(sourceGains.g), b: gain(sourceGains.b) },
        temperature: clamp(options.temperature),
        tint: clamp(options.tint),
        vibrance: clamp(options.vibrance),
        saturation: clamp(options.saturation)
    };
}

export function readColorResetConfig(node, documentRef = null) {
    const data = node?.data || {};
    const id = node?.id || '';
    const readControl = (name, fallback) => {
        const control = id && documentRef?.getElementById?.(`${id}-${name}`);
        return control ? control.value : fallback;
    };
    const persistedMode = node?.whiteBalanceMode || data.whiteBalanceMode || 'original';
    const mode = readControl('white-balance', persistedMode);
    const normalized = normalizeColorResetConfig({
        whiteBalanceMode: mode,
        whiteBalanceGains: node?.customWhiteBalanceGains || data.customWhiteBalanceGains
            || node?.whiteBalanceGains || data.whiteBalanceGains || { r: 1, g: 1, b: 1 },
        ...Object.fromEntries(CONTROL_NAMES.map((name) => [name, readControl(name, node?.[name] ?? data[name] ?? 0)]))
    });
    return {
        ...normalized,
        samplePoint: node?.whiteBalanceSamplePoint || data.whiteBalanceSamplePoint || null,
        whiteBalanceMessage: node?.whiteBalanceMessage || data.whiteBalanceMessage || ''
    };
}

export function resolveWhiteBalanceSampleSelection(previous = {}, candidatePoint = null, analysis = {}) {
    const accepted = analysis?.status === 'applied' && Boolean(candidatePoint);
    return {
        accepted,
        mode: accepted ? 'custom' : (previous.mode || 'original'),
        samplePoint: accepted ? candidatePoint : (previous.samplePoint || null),
        keepPicking: !accepted,
        message: analysis?.message || (accepted ? '已从 5×5 区域取样' : '取样区域无有效像素，请重新选择')
    };
}
