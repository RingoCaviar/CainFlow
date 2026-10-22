// Reviewed against official API documentation on 2026-10-22. Profiles describe wire
// contracts, not promises that a relay supports the same upstream capabilities.
export const THINKING_SOURCES = {
    openai: 'https://developers.openai.com/api/docs/guides/reasoning',
    google: 'https://ai.google.dev/gemini-api/docs/generate-content/thinking?hl=en',
    image: 'https://ai.google.dev/gemini-api/docs/image-generation',
    deepseek: 'https://api-docs.deepseek.com/guides/thinking_mode/',
    qwen: 'https://help.aliyun.com/en/model-studio/deep-thinking'
};
export const THINKING_PROFILES = {
    'openai-max': { label: 'OpenAI GPT-6 Astra / 6.1 Sol · low 至 max', wire: 'openai', task: 'chat', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'openai-basic': { label: 'OpenAI · low / medium / high', wire: 'openai', task: 'chat', levels: ['low', 'medium', 'high'] },
    'openai-gpt5': { label: 'OpenAI GPT-5 · minimal 至 high', wire: 'openai', task: 'chat', levels: ['minimal', 'low', 'medium', 'high'] },
    'openai-none-high': { label: 'OpenAI · none 至 high', wire: 'openai', task: 'chat', levels: ['none', 'low', 'medium', 'high'] },
    'openai-none-xhigh': { label: 'OpenAI · none 至 xhigh', wire: 'openai', task: 'chat', levels: ['none', 'low', 'medium', 'high', 'xhigh'] },
    'google-level': { label: 'Gemini · minimal / low / medium / high', wire: 'google-level', task: 'chat', levels: ['minimal', 'low', 'medium', 'high'] },
    'google-pro': { label: 'Gemini Pro · low / high', wire: 'google-level', task: 'chat', levels: ['low', 'high'] },
    'google-level-no-minimal': { label: 'Gemini · low / medium / high', wire: 'google-level', task: 'chat', levels: ['low', 'medium', 'high'] },
    'google-25-pro': { label: 'Gemini 2.5 Pro · Token 预算', wire: 'google-budget', task: 'chat', min: 128, max: 32768, dynamic: true },
    'google-25-flash': { label: 'Gemini 2.5 Flash · Token 预算', wire: 'google-budget', task: 'chat', min: 1, max: 24576, off: true, dynamic: true },
    'google-25-lite': { label: 'Gemini 2.5 Flash-Lite · Token 预算', wire: 'google-budget', task: 'chat', min: 512, max: 24576, off: true, dynamic: true },
    'google-image': { label: 'Gemini 3.1 Flash Image · minimal / high', wire: 'google-level', task: 'image', levels: ['minimal', 'high'] },
    'deepseek': { label: 'DeepSeek · 开关及 low / high / max', wire: 'deepseek', task: 'chat', off: true, on: true, levels: ['low', 'high', 'max'] },
    'qwen': { label: 'Qwen 混合思考 · 开关及预算', wire: 'qwen', task: 'chat', off: true, on: true, min: 1, max: 32768 },
    'qwen-thinking': { label: 'Qwen 固定思考 · 预算', wire: 'qwen-fixed', task: 'chat', min: 1, max: 32768 },
    'ttapi-image': { label: 'TTAPI 既有生图兼容 · Minimal / High（需确认接口）', wire: 'ttapi', task: 'image', levels: ['Minimal', 'High'] }
};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
export function normalizeThinkingConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return { profile: typeof value.profile === 'string' ? value.profile : 'auto',
        ...(value.default && typeof value.default === 'object' ? { default: normalizeThinkingSelection(value.default) } : {}),
        providers: Object.fromEntries(Object.entries(value.providers && typeof value.providers === 'object' && !Array.isArray(value.providers) ? value.providers : {}).filter(([key, profile]) => key && typeof profile === 'string')) };
}
export function normalizeThinkingSelection(value) {
    if (value == null || value.mode === 'inherit') return undefined;
    return { mode: String(value.mode || 'invalid'), ...(own(value, 'value') ? { value: value.value } : {}) };
}
function automaticProfile(model, provider, task, protocol) {
    let host = '';
    const endpoint = protocol === 'responses' && provider?.autoComplete === false ? provider.responsesEndpoint : provider?.endpoint;
    try { host = new URL(endpoint || '').hostname.toLowerCase(); } catch { return ''; }
    const id = String(model?.modelId || '').toLowerCase();
    if (protocol === 'google' && host === 'generativelanguage.googleapis.com') {
        if (task === 'image') return /^gemini-3\.1-flash(?:-lite)?-image(?:-preview)?$/.test(id) ? 'google-image' : '';
        const known = { 'gemini-2.5-pro': 'google-25-pro', 'gemini-2.5-flash': 'google-25-flash', 'gemini-2.5-flash-lite': 'google-25-lite',
            'gemini-3-flash-preview': 'google-level', 'gemini-3-pro-preview': 'google-pro', 'gemini-3.1-pro-preview': 'google-pro',
            'gemini-3.1-flash-lite': 'google-level', 'gemini-3.5-flash-lite': 'google-level', 'gemini-3.6-flash': 'google-level', 'gemini-3.8-flash': 'google-level-no-minimal', 'gemini-4-argon': 'google-level-no-minimal' };
        return known[id] || '';
    }
    if (task !== 'chat' || !['openai', 'responses'].includes(protocol)) return '';
    if (host === 'api.openai.com') {
        if (['gpt-6-astra', 'gpt-6.1-sol'].includes(id)) return 'openai-max';
        if (/^(o1|o3|o3-mini|o4-mini)(-\d{4}-\d{2}-\d{2})?$/.test(id)) return 'openai-basic';
        if (/^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return 'openai-gpt5';
        if (/^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return 'openai-none-high';
        if (/^gpt-5\.[245](?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return 'openai-none-xhigh';
    }
    if (host === 'api.deepseek.com' && ['deepseek-flash', 'deepseek-v4-pro'].includes(id)) return 'deepseek';
    if ((host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com') && ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus'].includes(id)) return 'qwen';
    return '';
}
export function getThinkingCapability({ model = {}, provider = {}, task = model.taskType || 'chat', protocol = model.protocol } = {}) {
    const config = normalizeThinkingConfig(model.thinking);
    const configured = config?.providers?.[provider.id] || config?.profile || 'auto';
    const id = configured === 'auto' ? automaticProfile(model, provider, task, protocol) : configured;
    const profile = THINKING_PROFILES[id];
    const compatible = profile && profile.task === task && !(profile.wire.startsWith('qwen') && protocol === 'responses') && (profile.wire.startsWith('google') ? protocol === 'google'
        : profile.wire === 'ttapi' ? protocol === 'ttapi' : ['openai', 'responses', 'ttapi-openai'].includes(protocol));
    return { ...(compatible ? profile : {}), id, supported: Boolean(compatible),
        reason: configured === 'none' ? '已设置不发送思考参数' : !compatible ? '由接口控制；当前模型或渠道未确认可调整思考参数' : '',
        source: profile?.wire.startsWith('google') ? THINKING_SOURCES[task === 'image' ? 'image' : 'google'] : THINKING_SOURCES[profile?.wire.startsWith('qwen') ? 'qwen' : profile?.wire],
        verifiedAt: '2026-10-22' };
}
export function resolveThinking(options, ...overrides) {
    const capability = getThinkingCapability(options);
    const setting = overrides.find(value => value != null && value.mode !== 'inherit') || options.model?.thinking?.default || { mode: 'default' };
    const fail = message => { throw new Error(`${options.model?.name || options.model?.modelId || '模型'} / ${options.provider?.name || options.provider?.id || 'Provider'}：${message}`); };
    if (setting.mode === 'default') return { capability, setting: { mode: 'default' }, patch: {} };
    if (!capability.supported) fail(`思考设置不可用：${capability.reason}`);
    const { mode, value } = setting;
    if (mode === 'level' ? !capability.levels?.includes(value)
        : mode === 'budget' ? !Number.isSafeInteger(value) || value < capability.min || value > capability.max || !capability.max
        : mode === 'off' ? !capability.off : mode === 'dynamic' ? !capability.dynamic : mode === 'on' ? !capability.on : true) fail('思考档位或 Token 预算已失效，请重新设置');
    let patch;
    switch (capability.wire) {
        case 'openai': patch = options.protocol === 'responses' ? { reasoning: { effort: value } } : { reasoning_effort: value }; break;
        case 'google-level': patch = { generationConfig: { thinkingConfig: { thinkingLevel: value } } }; break;
        case 'google-budget': patch = { generationConfig: { thinkingConfig: { thinkingBudget: mode === 'off' ? 0 : mode === 'dynamic' ? -1 : value } } }; break;
        case 'deepseek': patch = options.protocol === 'responses' ? { reasoning: { effort: mode === 'off' ? 'none' : mode === 'on' ? 'high' : value } }
            : { thinking: { type: mode === 'off' ? 'disabled' : 'enabled' }, ...(mode === 'level' ? { reasoning_effort: value } : {}) }; break;
        case 'qwen': case 'qwen-fixed': patch = { ...(capability.wire === 'qwen' ? { enable_thinking: mode !== 'off' } : {}), ...(mode === 'budget' ? { thinking_budget: value } : {}) }; break;
        case 'ttapi': patch = { thinking_level: value }; break;
    }
    return { capability, setting: { ...setting }, patch };
}
export function applyThinking(body, options, ...overrides) {
    const resolved = resolveThinking(options, ...overrides);
    const fields = ['reasoning_effort', 'reasoning', 'thinking', 'enable_thinking', 'thinking_budget', 'thinking_level'];
    const hasCustom = fields.some(key => own(body, key)) || own(body.generationConfig, 'thinkingConfig');
    const explicit = overrides.some(value => value != null && value.mode !== 'inherit') || options.model?.thinking?.default != null;
    if (hasCustom && explicit && resolved.setting.mode !== 'default') {
        const expected = resolved.patch;
        const conflicting = fields.some(key => own(body, key) && JSON.stringify(body[key]) !== JSON.stringify(expected[key]))
            || (own(body.generationConfig, 'thinkingConfig') && JSON.stringify(body.generationConfig.thinkingConfig) !== JSON.stringify(expected.generationConfig?.thinkingConfig));
        if (conflicting) throw new Error('自定义参数与思考设置冲突，请移除重复配置');
    }
    Object.assign(body, { ...resolved.patch, ...(resolved.patch.generationConfig ? { generationConfig: { ...body.generationConfig, ...resolved.patch.generationConfig } } : {}) });
    return body;
}
