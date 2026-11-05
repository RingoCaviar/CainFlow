import { getResolvedProviderForModel, normalizeModelTaskType } from './provider-request-utils.js';
import { getModelProtocolConfig } from './model-protocol-registry.js';

/** Configuration checks only; this never sends a provider request. */
export function getModelConfigurationIssue({ model, providers = [], taskType, providerId = '' }) {
    const target = { modelId: model?.id || '' };
    if (!model) return { message: '请先配置并选择模型', target };
    if (!String(model.modelId || '').trim()) return { message: '请填写模型代码（Model ID）', target: { ...target, field: 'modelId' } };
    if (taskType && normalizeModelTaskType(model.taskType, model) !== taskType) {
        return { message: '所选模型用途与当前节点不匹配', target: { ...target, field: 'taskType' } };
    }
    const protocol = getModelProtocolConfig(model.protocol);
    if (!protocol || (taskType && !protocol.defaultTaskTypes.includes(taskType))) {
        return { message: '请选择适用于当前用途的兼容格式', target: { ...target, field: 'protocol' } };
    }
    const provider = getResolvedProviderForModel(model, providers, providerId);
    if (!provider) return { message: '请先为模型绑定供应商', target: { ...target, field: 'providerIds' } };
    if (!String(provider.endpoint || '').trim()) return { message: '请填写供应商接口地址', target: { providerId: provider.id, field: 'endpoint' } };
    return null;
}

export function getNodeModelConfigurationIssue({ state, node, documentRef }) {
    const taskType = { ImageGenerate: 'image', VideoGenerate: 'video', TextChat: 'chat' }[node?.type];
    if (!taskType || node.enabled === false) return null;
    const field = suffix => documentRef?.getElementById?.(`${node.id}-${suffix}`)?.value;
    const modelId = field('apiconfig') ?? node.apiConfigId ?? node.data?.apiConfigId;
    return getModelConfigurationIssue({
        model: state.models?.find(model => model.id === modelId), providers: state.providers,
        providerId: field('provider') ?? node.providerId ?? node.data?.providerId ?? '', taskType
    });
}
