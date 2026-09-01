/**
 * 视频生成卡片的只读协议契约摘要。
 * 这个纯函数同时供初始渲染和模型切换后的 DOM 更新使用。
 */
function getVariantParameters(protocol, variant) {
    return { ...(protocol?.parameters || {}), ...(variant?.parameters || {}) };
}

export function describeVideoProtocolCard(protocol, modelId) {
    const variants = protocol?.variants || {};
    const hasVariants = Object.keys(variants).length > 0;
    const variant = variants[modelId] || null;
    const isUnmatched = hasVariants && !variant;
    if (!protocol || !hasVariants) return { isDeclared: false, isUnmatched: false, summary: '' };
    if (isUnmatched) {
        return {
            isDeclared: true,
            isUnmatched: true,
            summary: `${protocol.label || protocol.id} · ${modelId || '未选择模型'} · 未配置变体`
        };
    }

    const parameters = getVariantParameters(protocol, variant);
    const constraints = [];
    const duration = parameters.seconds || parameters.duration;
    if (duration?.min !== undefined || duration?.max !== undefined) {
        constraints.push(`时长 ${duration.min ?? '—'}–${duration.max ?? '—'} 秒`);
    }
    const referenceImages = parameters.referenceImages;
    const maxImages = referenceImages?.portCount ?? variant?.referenceImage?.maxCount;
    if (maxImages !== undefined) constraints.push(`最多 ${maxImages} 张参考图`);

    return {
        isDeclared: true,
        isUnmatched: false,
        summary: [protocol.label || protocol.id, modelId, ...constraints].filter(Boolean).join(' · ')
    };
}
