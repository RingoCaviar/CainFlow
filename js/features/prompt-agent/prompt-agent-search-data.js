import { getResolvedProviderForModel, normalizeProviderEndpointUrl } from '../execution/provider-request-utils.js';

// Search configuration and durable metadata; never treat model-authored URLs as results.
export function getAgentSearchCapability(model) {
    const configured = model?.agentSearch;
    if (model?.taskType && model.taskType !== 'chat') return 'none';
    if (!['google', 'openai'].includes(model?.protocol)) return 'none';
    if (configured === 'none') return 'none';
    if (model.protocol === 'google') return configured === undefined || configured === 'web' ? 'web' : 'none';
    return ['web', 'images'].includes(configured) ? configured : 'none';
}

// The menu and execution must agree, including the selected Provider's address.
// Configuration describes declared support; it never probes or infers model support.
export function getAgentSearchAvailability({ model, models = [], providers = [], settings = {}, kind = 'web' }) {
    const fail = (reason, message, target = {}) => ({ available: false, reason, message, target });
    if (settings.mode === 'off') return fail('off', '联网已关闭');
    const current = canAgentSearch(model, kind);
    const selected = current ? model : models.find(item => item.id === settings.modelId);
    if (!selected || !canAgentSearch(selected, kind)) {
        return fail('model', `请选择支持${kind === 'images' ? '搜图' : '网页搜索'}的专用搜索模型`,
            { modelId: selected?.id, field: 'agentSearch' });
    }
    const provider = getResolvedProviderForModel(selected, providers);
    if (!String(selected.modelId || '').trim()) return fail('model', '搜索模型缺少模型 ID', { modelId: selected.id, field: 'modelId' });
    if (!provider || !safeSearchUrl(normalizeProviderEndpointUrl(provider.endpoint))) {
        return fail('provider', '搜索模型或 Provider 配置不完整', provider
            ? { providerId: provider.id, field: 'endpoint' } : { modelId: selected.id, field: 'providerIds' });
    }
    if (selected.protocol === 'openai' && provider.autoComplete === false && !safeSearchUrl(provider.responsesEndpoint)) {
        return fail('responses-endpoint', 'Provider 缺少独立 Responses 地址', { providerId: provider.id, field: 'responsesEndpoint' });
    }
    return { available: true, model: selected, provider, source: current ? 'conversation' : 'dedicated',
        message: `${selected.name || selected.modelId}（${current ? '对话模型' : '专用模型'}）`, target: { modelId: selected.id, field: 'agentSearch' } };
}

export function canAgentSearch(model, kind = 'web') {
    const capability = getAgentSearchCapability(model);
    return kind === 'images' ? capability === 'images' : capability !== 'none';
}

export function resolveAgentSearchModel(model, models, settings, kind) {
    if (settings?.mode === 'off') throw new Error('联网已关闭，请在联网菜单中开启自动搜索。');
    if (canAgentSearch(model, kind)) return model;
    const dedicated = models.find(item => item.id === settings?.modelId);
    if (!dedicated || !canAgentSearch(dedicated, kind)) {
        throw new Error(`当前模型不支持${kind === 'images' ? '搜图' : '网页搜索'}，请在联网菜单中配置具备该能力的专用搜索模型。`);
    }
    return dedicated;
}

export function safeSearchUrl(value) {
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
}

export function normalizeAgentSearch(value) {
    if (!value || typeof value !== 'object') return null;
    const sources = (Array.isArray(value.sources) ? value.sources : []).filter(item =>
        typeof item?.id === 'string' && /^[a-zA-Z0-9-]+$/.test(item.id) && safeSearchUrl(item.url))
        .map(item => ({ id: item.id, url: safeSearchUrl(item.url), title: String(item.title || item.url) }));
    const images = (Array.isArray(value.images) ? value.images : []).filter(item =>
        typeof item?.id === 'string' && safeSearchUrl(item.imageUrl) && safeSearchUrl(item.pageUrl)).slice(0, 12)
        .map(item => ({ id: item.id, imageUrl: safeSearchUrl(item.imageUrl), pageUrl: safeSearchUrl(item.pageUrl),
            thumbnailUrl: safeSearchUrl(item.thumbnailUrl), title: String(item.title || '网络图片') }));
    return { searched: value.searched === true, kind: value.kind === 'images' ? 'images' : 'web',
        query: String(value.query || ''), text: String(value.text || ''), sources, images,
        notice: String(value.notice || ''),
        // Only rendered inside a sandboxed frame, never injected into the host DOM.
        suggestionsHtml: typeof value.suggestionsHtml === 'string' ? value.suggestionsHtml : '' };
}

export function projectAgentSearch(value) {
    const result = normalizeAgentSearch(value);
    if (!result) return null;
    const { suggestionsHtml, ...context } = result;
    return context;
}

export function getConversationSearchSources(conversation) {
    const sources = [...(conversation?.archivedMessages || []), ...(conversation?.messages || [])]
        .flatMap(message => normalizeAgentSearch(message.search)?.sources || []);
    return [...new Map(sources.map(source => [source.id, source])).values()];
}

export function getSummarySearchSources(conversation) {
    const cited = new Set([...String(conversation?.contextSummary || '').matchAll(/\[\[source:([^\]]+)\]\]/g)].map(match => match[1]));
    return getConversationSearchSources(conversation).filter(source => cited.has(source.id));
}
