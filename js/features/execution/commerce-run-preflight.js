import { resolveVisualStyle, visualStyleKey } from '../visual-style/visual-style.js';
import { resolveCommerceImageSetStyle } from '../ecommerce-image-set/commerce-art-direction.js';
import { projectImageOutput } from '../../nodes/image-output-projection.js';
import { resolveImageGenerationInputContract } from '../../nodes/universal-input-policy.js';
import {
    COMMERCE_REFERENCE_CHANGED_MESSAGE, getCommerceReferenceRevision, hasCommerceNodeReferenceChange,
    hasCommerceReferenceChange, projectCommerceReferences
} from '../ecommerce-image-set/commerce-reference-revision.js';
import {
    getGeneratableCommerceImageSetShots, getRunnableCommerceImageSetShots, getSelectedCommerceImageSetShots,
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

export function getCommerceImageConfigurationIssue({ state, node, settings, generatedShots, referenceCount }) {
    if (!generatedShots.length) return '';
    let imageSettings;
    try {
        imageSettings = resolveCommerceImageGenerationSettings({ state, settings, generatedShots });
    } catch (error) {
        return error.message;
    }
    const contract = resolveImageGenerationInputContract(state, { ...node, apiConfigId: imageSettings.apiConfigId });
    if (contract.error) return contract.error;
    if (!contract.supportsReferences || !contract.maxReferences) return '当前生图模型不支持商品参考图，请选择兼容模型。';
    const designReferenceCount = Math.max(0, ...generatedShots.map(shot => settings.shotReferences?.[shot.id]?.length || 0));
    const maximum = Math.min(5, contract.maxReferences);
    if (referenceCount + designReferenceCount > maximum) {
        return designReferenceCount ? `商品原图与图位设计参考合计最多 ${maximum} 张，请减少对应图位的参考图。`
            : `当前生图模型最多接收 ${maximum} 张参考图。`;
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

export function usesCommerceRunReferences(node, plan) {
    if (node?.type !== 'ECommerceImageSet') return true;
    const action = plan?.commerceNodeId === node.id ? plan.commerceAction : 'generate';
    if (action === 'select-candidate') return false;
    if (action !== 'generate') return true;
    const settings = node.data?.commerceImageSet ?? node.commerceImageSet;
    return !getRunnableCommerceImageSetShots(settings).length || getGeneratableCommerceImageSetShots(settings).length > 0;
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
        const runnableShots = settings.plan ? getRunnableCommerceImageSetShots(settings)
            : getSelectedCommerceImageSetShots(settings).filter(shot => !shot.customScene);
        const shots = settings.plan ? getGeneratableCommerceImageSetShots(settings) : runnableShots;
        const finalizedCount = runnableShots.length - shots.length;
        const reusesFinalized = finalizedCount > 0 && shots.length === 0;
        const generatedShots = shots.filter(shot => shot.source === 'generate');
        const candidateCount = generatedShots.length ? (settings.candidateCount ?? 1) : 0;
        const shotIds = new Set(runnableShots.map(shot => shot.id));
        const completed = settings.results.filter(row => row.status === 'completed' && row.assetKey && shotIds.has(row.shotId));
        const inputConnections = plan.inputConnectionsByNode?.[nodeId] || [];
        const references = projectCommerceReferences(state, nodeId, inputConnections);
        const sources = references.groups.filter(group => group.enabled);
        const changingSources = new Set(sources.filter(group => referenceSourceMayChange(group.source, { state, plan, scope })));
        const upstreamWillRun = !reusesFinalized && changingSources.size > 0;
        const retainedSources = sources.filter(group => !changingSources.has(group) && !group.running);
        const retainedReferenceCount = retainedSources.reduce((count, group) => count + group.count, 0);
        const missingImages = retainedSources.some(group => !group.count || group.missing || group.missingPositions.length
            || references.slots.some(slot => slot.connection === group.connection && slot.missing));
        let issue = null;
        const panelAction = plan.commerceNodeId === nodeId && plan.commerceAction;
        let styleChanged = false;
        try { styleChanged = !!settings.plan && visualStyleKey(settings.plan.visualStyle) !== visualStyleKey(resolveCommerceImageSetStyle(settings, resolveVisualStyle(state, nodeId))); }
        catch { styleChanged = true; }
        if (!['plan', 'analyze', 'select-candidate'].includes(panelAction) && styleChanged) {
            issue = { action: 'plan', message: '画面风格已更新，请重新规划并确认。' };
        } else if (panelAction !== 'plan' && panelAction !== 'analyze' && hasCommerceReferenceChange(settings, references)) {
            issue = { action: 'plan', message: COMMERCE_REFERENCE_CHANGED_MESSAGE };
        } else if (!panelAction && !reusesFinalized) {
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
                    const message = getCommerceImageConfigurationIssue({ state, node, settings, generatedShots, referenceCount: retainedReferenceCount });
                    if (message) issue = { action: 'configure', message };
                }
            }
        }
        return [{ nodeId, issue, shotCount: runnableShots.length, generateCount: generatedShots.length * candidateCount, candidateCount,
            referenceCount: shots.length - generatedShots.length, finalizedCount, upstreamWillRun,
            hasCompleted: completed.length > 0, unfinishedCount: getUnfinishedCommerceImageSetShots(settings).length,
            approvalKey: JSON.stringify([settings.plan?.sourceKey || '', getCommerceReferenceRevision(references),
                settings.imageModelId, settings.imageProviderId, candidateCount,
                shots.map(shot => [shot.id, shot.source, shot.aspect, shot.prompt, shot.headline, shot.body]),
                completed.map(row => [row.shotId, row.assetKey, row.finalized === true])]) }];
    });
}

export function getCommerceRunBlocker({ state, plan }) {
    const blocked = getCommerceRunPreflight({ state, plan }).find(row => row.issue)
        || getReusedCommerceReferenceBlocker(state, plan);
    if (!blocked) return null;
    const node = state.nodes.get(blocked.nodeId);
    const error = `「${node.customTitle || '电商套图'}」${blocked.issue.message}`;
    return { started: false, executed: false, reason: 'commerce-preflight', nodeId: blocked.nodeId, error };
}

function getReusedCommerceReferenceBlocker(state, plan) {
    const pending = plan?.executionOrder || plan?.nodeIds || [];
    const scope = plan?.scopeNodeSet || new Set(pending);
    for (const nodeId of pending) {
        const consumer = state.nodes.get(nodeId);
        if (!consumer || consumer.enabled === false || !usesCommerceRunReferences(consumer, plan)) continue;
        for (const edge of plan.inputConnectionsByNode?.[nodeId] || []) {
            const sourceId = edge.from?.nodeId;
            if (edge.from?.port !== 'image' || scope.has(sourceId)) continue;
            if (hasCommerceNodeReferenceChange(state, state.nodes.get(sourceId))) {
                return { nodeId: sourceId, issue: { action: 'plan', message: COMMERCE_REFERENCE_CHANGED_MESSAGE } };
            }
        }
    }
    return null;
}
