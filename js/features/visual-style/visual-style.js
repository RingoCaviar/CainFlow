export const VISUAL_STYLE_FIELDS = Object.freeze({
    description: '风格描述', medium: '表现形式', palette: '配色', lighting: '光影',
    texture: '质感', background: '背景氛围', composition: '构图倾向', typography: '图文排版', avoid: '避免项'
});
export const VISUAL_STYLE_PRESETS = Object.freeze({
    custom: { label: '自定义' },
    natural: { label: '自然生活', medium: '真实摄影', palette: '暖米色、低饱和绿色', lighting: '柔和自然光', texture: '细腻自然', background: '简洁生活环境', composition: '留白充足' },
    studio: { label: '极简棚拍', medium: '商业摄影', palette: '中性色', lighting: '柔和棚拍布光', texture: '真实清晰', background: '干净简洁', composition: '主体突出' },
    technology: { label: '科技冷调', medium: '商业摄影', palette: '冷蓝与深灰', lighting: '清晰轮廓光', texture: '精细材质', background: '简洁抽象空间' },
    illustration: { label: '手绘插画', medium: '手绘插画', palette: '低饱和协调配色', texture: '自然笔触', composition: '简洁清晰' }
});

export function normalizeVisualStyle(raw = {}) {
    const preset = Object.hasOwn(VISUAL_STYLE_PRESETS, raw?.preset) ? raw.preset : 'custom';
    const defaults = VISUAL_STYLE_PRESETS[preset];
    return { version: 1, preset, ...Object.fromEntries(Object.keys(VISUAL_STYLE_FIELDS).map(key => [key,
        typeof raw?.[key] === 'string' ? raw[key].trim().slice(0, key === 'description' ? 20000 : 2000) : defaults[key] || ''])) };
}

export function visualStyleKey(style) {
    return style ? JSON.stringify(normalizeVisualStyle(style)) : '';
}

/** Flatten legacy structured styles for the single editable style description. */
export function visualStyleText(style) {
    const normalized = normalizeVisualStyle(style);
    return Object.entries(VISUAL_STYLE_FIELDS).filter(([key]) => normalized[key])
        .map(([key, label]) => key === 'description' ? normalized[key] : `${label}：${normalized[key]}`).join('\n');
}

export function buildVisualStylePrompt(style, { lettering = false } = {}) {
    if (!style) return '';
    const normalized = normalizeVisualStyle(style);
    const rows = Object.entries(VISUAL_STYLE_FIELDS).filter(([key]) => normalized[key] && (key !== 'typography' || lettering))
        .map(([key, label]) => `${label}：${normalized[key]}`);
    if (!rows.length) return '';
    return ['画面风格规范：', ...rows,
        '风格仅控制视觉表达。保持主体身份以及商品的结构、固有颜色、标识和包装文字；明确的背景、图位用途、文案与其他任务硬性要求优先。',
        '在不违反上述要求时，配色、光影、质感以本风格规范为准；不复制风格参考图中的商品、人物、文字或具体场景。',
        lettering ? '排版风格仅作用于任务要求的文字，不添加额外文案。' : '排版要求仅在任务明确需要文字时应用，不因风格新增文字。'
    ].join('\n');
}

export function resolveVisualStyle(state, nodeId, inputs = {}) {
    const edges = (state?.connections || []).filter(edge => edge.to?.nodeId === nodeId && edge.to.port === 'style');
    if (edges.length > 1) throw new Error('每个节点只能连接一个画面风格。');
    if (edges.length) {
        const source = state.nodes.get(edges[0].from.nodeId);
        if (source?.type !== 'VisualStyle' || source.enabled === false) throw new Error('画面风格来源不可用，请启用或断开连接。');
        return normalizeVisualStyle(source.data?.visualStyle ?? source.visualStyle);
    }
    return inputs.style ? normalizeVisualStyle(inputs.style) : null;
}
