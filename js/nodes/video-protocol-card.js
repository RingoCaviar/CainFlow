/**
 * 视频生成卡片的只读协议契约摘要。
 * 这个纯函数同时供初始渲染和模型切换后的 DOM 更新使用。
 */
function getVariantParameters(protocol, variant) {
    return { ...(protocol?.parameters || {}), ...(variant?.parameters || {}) };
}

export function getVideoProtocolInputPorts(protocol, modelId) {
    const variants = protocol?.variants || {};
    const hasVariants = Object.keys(variants).length > 0;
    const variant = variants[modelId] || null;
    if (!protocol || (hasVariants && !variant)) return [];
    const parameters = getVariantParameters(protocol, variant);
    return ['image_1', 'image_2', 'referenceImages'].filter((id) => parameters[id]?.inputPort === true);
}

export function describeVideoProtocolCard(protocol, modelId) {
    const variants = protocol?.variants || {};
    const hasVariants = Object.keys(variants).length > 0;
    const variant = variants[modelId] || null;
    const isUnmatched = hasVariants && !variant;
    if (!protocol) return { isDeclared: false, isIncomplete: false, isUnmatched: false, summary: '' };
    if (isUnmatched) {
        return {
            isDeclared: true,
            isIncomplete: false,
            isUnmatched: true,
            summary: `${protocol.label || protocol.id} · ${modelId || '未选择模型'} · 未配置变体`
        };
    }

    const parameters = getVariantParameters(protocol, variant);
    const isIncomplete = Object.keys(parameters).length === 0;
    if (isIncomplete) {
        return {
            isDeclared: false,
            isIncomplete: true,
            isUnmatched: false,
            summary: `${protocol.label || protocol.id} · ${modelId || '未选择模型'} · 未声明可编辑视频参数`
        };
    }
    const constraints = [];
    const duration = parameters.seconds || parameters.duration;
    if (duration?.min !== undefined || duration?.max !== undefined) {
        constraints.push(`时长 ${duration.min ?? '—'}–${duration.max ?? '—'} 秒`);
    }
    const referenceImages = parameters.referenceImages;
    const maxImages = referenceImages?.portCount ?? variant?.referenceImage?.maxCount;
    if (maxImages !== undefined) constraints.push(`最多 ${maxImages} 张参考图`);

    return {
        isDeclared: Object.keys(parameters).length > 0,
        isIncomplete: false,
        isUnmatched: false,
        summary: [protocol.label || protocol.id, modelId, ...constraints].filter(Boolean).join(' · ')
    };
}
