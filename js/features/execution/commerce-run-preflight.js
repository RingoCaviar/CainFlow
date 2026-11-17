import { projectImageReferences } from '../../nodes/image-reference-projection.js';
import { projectImageOutput } from '../../nodes/image-output-projection.js';
import { REFERENCE_IMAGES_PORT } from '../../nodes/reference-image-ports.js';
import { resolveImageGenerationInputContract } from '../../nodes/universal-input-policy.js';
import {
    getRunnableCommerceImageSetShots, getSelectedCommerceImageSetShots,
    getUnfinishedCommerceImageSetShots, normalizeCommerceImageSetState
} from '../ecommerce-image-set/commerce-image-set-plan.js';
import { getCanonicalImageList } from './execution-data-utils.js';
import { getImageAspectOptionsForProtocol, usesOpenAiImageSize } from './image-generation-size.js';
import { getEffectiveProtocol, getModelsForTask, getResolvedProviderForModel, getResolvedProviderIdForModel } from './provider-request-utils.js';

export function resolveCommerceImageGenerationSettings({ state, settings, generatedShots }) {
    const model = getModelsForTask(state.models, 'image').find(candidate => candidate.id === settings.imageModelId);
    const providerId = settings.imageProviderId;
    const provider = model && providerId && getResolvedProviderIdForModel(model, state.providers, providerId) === providerId
        ? getResolvedProviderForModel(model, state.providers, providerId) : null;
    if (!model || !provider?.apikey) throw new Error('请选择绑定且已配置密钥的生图模型与供应商。');
    const protocol = getEffectiveProtocol(model, provider);
    if (!['openai', 'google', 'ttapi', 'ttapi-openai'].includes(protocol)) {
        throw new Error('电商套图需要支持商品参考图的同步生图模型。');
    }
    const options = getImageAspectOptionsForProtocol(protocol === 'ttapi-openai' ? 'openai' : protocol, model.modelId);
    const unsupportedShot = generatedShots.find(shot => !options.some(option => option.value === shot.aspect));
    if (unsupportedShot) {
        throw new Error(`当前生图模型不支持直接生成「${unsupportedShot.label}」的 ${unsupportedShot.aspect} 比例。请更换生图模型，或调整该组比例并重新规划。`);
    }
    return { apiConfigId: model.id, providerId, generationCount: 1,
        resolution: usesOpenAiImageSize(protocol) ? '1K' : '', protocolParams: {} };
}

function getImageConfigurationIssue(state, node, settings, generatedShots, retainedReferenceCount) {
    let imageSettings;
    try {
        imageSettings = resolveCommerceImageGenerationSettings({ state, settings, generatedShots });
    } catch (error) {
        return error.message;
    }
    const contract = resolveImageGenerationInputContract(state, { ...node, apiConfigId: imageSettings.apiConfigId });
    if (contract.error) return contract.error;
    if (!contract.supportsReferences || !contract.maxReferences) return '当前生图模型协议不支持商品参考图。';
    if (retainedReferenceCount > contract.maxReferences) {
        return `当前生图模型最多接收 ${contract.maxReferences} 张参考图。`;
    }
    return '';
}

function referenceSourceMayChange(source, { state, plan, scope }) {
    if (!scope.has(source.id) || source.type === 'ImageImport') return false;
    // A preview retains its last output when its image input supplies nothing.
    if (source.type !== 'ImagePreview') return true;
    return (plan.inputConnectionsByNode?.[source.id] || []).some(edge => {
        if (edge.to.port !== 'image') return false;
        const input = state.nodes.get(edge.from.nodeId);
        if (!input || input.enabled === false) return false;
        if (scope.has(input.id) && input.type !== 'ImageImport') return true;
        return projectImageOutput(input, getCanonicalImageList(input)).count > 0;
    });
}

/** Checks only facts available from the planned graph and stored configuration. */
export function getCommerceRunPreflight({ state, plan }) {
    if (!plan) return [];
    const pending = plan.executionOrder || plan.nodeIds || [];
    const scope = plan.scopeNodeSet || new Set(pending);
    return pending.flatMap(nodeId => {
        const node = state.nodes.get(nodeId);
        if (node?.type !== 'ECommerceImageSet' || node.enabled === false) return [];
        const settings = normalizeCommerceImageSetState(node.data?.commerceImageSet ?? node.commerceImageSet);
        const shots = settings.plan ? getRunnableCommerceImageSetShots(settings)
            : getSelectedCommerceImageSetShots(settings).filter(shot => !shot.customScene);
        const generatedShots = shots.filter(shot => shot.source === 'generate');
        const shotIds = new Set(shots.map(shot => shot.id));
        const completed = settings.results.filter(row => row.status === 'completed' && row.assetKey && shotIds.has(row.shotId))
            .map(row => row.shotId);
        const inputConnections = plan.inputConnectionsByNode?.[nodeId] || [];
        const references = projectImageReferences({ state, targetId: nodeId,
            connections: inputConnections.filter(edge => edge.to.port === REFERENCE_IMAGES_PORT) });
        const sources = references.groups.filter(group => group.enabled);
        const changingSources = new Set(sources.filter(group => referenceSourceMayChange(group.source, { state, plan, scope })));
        const upstreamWillRun = changingSources.size > 0;
        const retainedSources = sources.filter(group => !changingSources.has(group) && !group.running);
        const retainedReferenceCount = retainedSources.reduce((count, group) => count + group.count, 0);
        const missingImages = retainedSources.some(group => !group.count || group.missing || group.missingPositions.length
            || references.slots.some(slot => slot.connection === group.connection && slot.missing));
        let issue = null;
        const panelAction = plan.commerceNodeId === nodeId && plan.commerceAction;
        if (!panelAction) {
            if (!settings.plan || settings.plan.stale) {
                issue = { action: 'plan', message: settings.plan ? '套图方案已过期，请重新规划并确认。' : '请先规划电商套图。' };
            } else if (!settings.plan.confirmed) {
                issue = { action: 'confirm', message: '请先在电商套图参数区确认方案。' };
            } else if (!sources.length || missingImages || retainedReferenceCount > 5) {
                issue = { action: 'references', message: retainedReferenceCount > 5
                    ? '套图最多使用 5 张商品参考图，请调整输入。' : '请连接 1 至 5 张可读取的商品参考图。' };
            } else {
                const missingPrompt = generatedShots.find(shot => !shot.prompt);
                if (missingPrompt) issue = { action: 'prompt', message: `「${missingPrompt.label}」缺少生图提示词。` };
                else if (generatedShots.length) {
                    const message = getImageConfigurationIssue(state, node, settings, generatedShots, retainedReferenceCount);
                    if (message) issue = { action: 'configure', message };
                }
            }
        }
        return [{ nodeId, issue, shotCount: shots.length, generateCount: generatedShots.length,
            referenceCount: shots.length - generatedShots.length, upstreamWillRun,
            hasCompleted: completed.length > 0, unfinishedCount: getUnfinishedCommerceImageSetShots(settings).length,
            approvalKey: JSON.stringify([settings.plan?.sourceKey || '', settings.imageModelId, settings.imageProviderId,
                shots.map(shot => [shot.id, shot.source, shot.aspect, shot.prompt, shot.headline, shot.body]), completed]) }];
    });
}

export function getCommerceRunBlocker({ state, plan }) {
    const blocked = getCommerceRunPreflight({ state, plan }).find(row => row.issue);
    if (!blocked) return null;
    const node = state.nodes.get(blocked.nodeId);
    const error = `「${node.customTitle || '电商套图'}」${blocked.issue.message}`;
    return { started: false, executed: false, reason: 'commerce-preflight', nodeId: blocked.nodeId, error };
}
