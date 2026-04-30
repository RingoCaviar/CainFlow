import {
    getModelProviderIds,
    getResolvedProviderForModel,
    normalizeModelProtocol,
    normalizeModelTaskType
} from '../execution/provider-request-utils.js';

const MODEL_NODE_TASK_TYPES = {
    ImageGenerate: 'image',
    TextChat: 'chat'
};

function getModelNodeTaskType(node = {}) {
    return MODEL_NODE_TASK_TYPES[node.type] || '';
}

function getProviderById(providerId, providers = []) {
    return providers.find((provider) => provider?.id === providerId) || null;
}

function normalizeKey(value) {
    return String(value || '').trim().toLowerCase();
}

function uniqueById(models = []) {
    const seen = new Set();
    return models.filter((model) => {
        if (!model?.id || seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
    });
}

function findUniqueMatch(candidates, predicate) {
    const matches = uniqueById(candidates.filter(predicate));
    return matches.length === 1 ? matches[0] : null;
}

function getLegacyModel(workflowData, modelId) {
    if (!Array.isArray(workflowData?.models)) return null;
    return workflowData.models.find((model) => model?.id === modelId) || null;
}

function getModelDisplayName(modelId, legacyModel = null) {
    const name = String(legacyModel?.name || '').trim();
    const modelValue = String(legacyModel?.modelId || '').trim();
    if (name && modelValue && name !== modelValue) return `${name} (${modelValue})`;
    return name || modelValue || modelId;
}

function findCurrentModelMatch(modelId, taskType, legacyModel, currentModels, currentProviders, legacyProviders) {
    const taskCandidates = currentModels.filter((model) => normalizeModelTaskType(model?.taskType, model) === taskType);

    const directModelIdMatch = findUniqueMatch(taskCandidates, (model) => normalizeKey(model.modelId) === normalizeKey(modelId));
    if (directModelIdMatch) return directModelIdMatch;

    if (!legacyModel) return null;

    const legacyProviderId = Array.isArray(legacyModel?.providerIds) && legacyModel.providerIds.length > 0
        ? legacyModel.providerIds[0]
        : legacyModel?.providerId;
    const legacyProvider = getProviderById(legacyProviderId, legacyProviders);
    const legacyProtocol = normalizeModelProtocol(legacyModel.protocol, legacyModel, legacyProvider);
    const legacyModelId = normalizeKey(legacyModel.modelId);
    const legacyName = normalizeKey(legacyModel.name);

    const protocolMatches = (model) => {
        const provider = getResolvedProviderForModel(model, currentProviders);
        return normalizeModelProtocol(model.protocol, model, provider) === legacyProtocol;
    };

    return findUniqueMatch(taskCandidates, (model) => normalizeKey(model.modelId) === legacyModelId && protocolMatches(model))
        || findUniqueMatch(taskCandidates, (model) => normalizeKey(model.modelId) === legacyModelId)
        || findUniqueMatch(taskCandidates, (model) => normalizeKey(model.name) === legacyName && protocolMatches(model))
        || findUniqueMatch(taskCandidates, (model) => normalizeKey(model.name) === legacyName);
}

export function resolveWorkflowModelReferences(workflowData, currentState) {
    const currentModels = Array.isArray(currentState?.models) ? currentState.models : [];
    const currentProviders = Array.isArray(currentState?.providers) ? currentState.providers : [];
    const legacyProviders = Array.isArray(workflowData?.providers) ? workflowData.providers : [];
    const modelById = new Map(currentModels.map((model) => [model.id, model]));
    const providerById = new Map(currentProviders.map((provider) => [provider.id, provider]));
    const remappedModels = [];
    const missingModels = [];
    const missingProviders = [];
    const reportedMissingModels = new Set();
    const reportedMissingProviders = new Set();

    const nodes = Array.isArray(workflowData?.nodes)
        ? workflowData.nodes.map((node) => {
            const taskType = getModelNodeTaskType(node);
            const modelId = String(node?.apiConfigId || '').trim();
            if (!taskType || !modelId) return node;

            const currentModel = modelById.get(modelId);
            if (currentModel) {
                const providerIds = getModelProviderIds(currentModel);
                const availableProviderIds = providerIds.filter((providerId) => providerById.has(providerId));
                const requestedProviderId = String(node?.providerId || '').trim();
                const nextProviderId = requestedProviderId && availableProviderIds.includes(requestedProviderId)
                    ? requestedProviderId
                    : (availableProviderIds[0] || '');
                if (!nextProviderId && providerIds.length > 0) {
                    providerIds.forEach((providerId) => {
                        if (!reportedMissingProviders.has(providerId)) {
                            missingProviders.push({
                                providerId,
                                modelId: currentModel.id,
                                modelName: currentModel.name || currentModel.id
                            });
                            reportedMissingProviders.add(providerId);
                        }
                    });
                }
                return {
                    ...node,
                    providerId: nextProviderId
                };
            }

            const legacyModel = getLegacyModel(workflowData, modelId);
            const matchedModel = findCurrentModelMatch(modelId, taskType, legacyModel, currentModels, currentProviders, legacyProviders);
            if (matchedModel) {
                remappedModels.push({
                    from: modelId,
                    to: matchedModel.id,
                    label: getModelDisplayName(modelId, legacyModel)
                });
                return {
                    ...node,
                    apiConfigId: matchedModel.id,
                    providerId: String(node?.providerId || '').trim()
                };
            }

            if (!reportedMissingModels.has(modelId)) {
                missingModels.push({
                    id: modelId,
                    taskType,
                    label: getModelDisplayName(modelId, legacyModel)
                });
                reportedMissingModels.add(modelId);
            }
            return node;
        })
        : [];

    return {
        nodes,
        remappedModels,
        missingModels,
        missingProviders
    };
}

export function buildWorkflowModelWarningMessage(result) {
    const lines = [];
    if (result.missingModels.length > 0) {
        lines.push('工作流引用了当前 API 设置中不存在的模型：');
        result.missingModels.slice(0, 6).forEach((item) => {
            lines.push(`- ${item.label} (${item.id})`);
        });
        if (result.missingModels.length > 6) lines.push(`- 另外 ${result.missingModels.length - 6} 个模型`);
    }

    if (result.missingProviders.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('当前模型绑定的供应商缺失：');
        result.missingProviders.slice(0, 6).forEach((item) => {
            lines.push(`- ${item.modelName} -> ${item.providerId || '未绑定供应商'}`);
        });
        if (result.missingProviders.length > 6) lines.push(`- 另外 ${result.missingProviders.length - 6} 个供应商引用`);
    }

    if (lines.length === 0) return '';
    lines.push('');
    lines.push('请在设置中补齐模型/供应商，或继续加载后手动重新选择节点模型。');
    return lines.join('\n');
}
