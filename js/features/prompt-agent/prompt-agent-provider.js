import { getModelProviders, normalizeProviderEndpointUrl } from '../execution/provider-request-utils.js';

// Explicit Agent choices never use the canvas dropdown's fallback behavior.
export function resolveAgentProvider(model, providers = [], providerId = '', { requireCredentials = true } = {}) {
    const bound = getModelProviders(model || {}, providers);
    const provider = bound.find(item => item.id === providerId);
    const fail = (message, field) => {
        const error = new Error(`${model?.name || model?.modelId || '模型'}：${message}`);
        error.configurationTarget = provider ? { providerId: provider.id, field }
            : { modelId: model?.id, field: 'providerIds' };
        throw error;
    };
    if (!provider) fail(providerId ? '指定供应商已删除或解绑，请重新选择供应商' : '请选择供应商');
    let url;
    try { url = new URL(normalizeProviderEndpointUrl(provider.endpoint)); } catch { /* report below */ }
    if (!url || !['http:', 'https:'].includes(url.protocol)) fail(`${provider.name || provider.id} 的地址未配置或无效`, 'endpoint');
    if (requireCredentials && !String(provider.apikey || '').trim()) fail(`${provider.name || provider.id} 的密钥未配置`, 'apikey');
    return provider;
}

export function getAgentProviderLabel(model, providers = [], providerId = '') {
    const bound = getModelProviders(model || {}, providers);
    const provider = bound.find(item => item.id === providerId);
    const name = model?.name || model?.modelId || model?.id || '未选择模型';
    return `${name} · ${provider?.name || provider?.id || (providerId ? '指定供应商不可用' : '请选择供应商')}`;
}
