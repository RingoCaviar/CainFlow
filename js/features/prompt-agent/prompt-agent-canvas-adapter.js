import { normalizeVisualStyle, normalizeVisualStyleDetailLevel } from '../visual-style/visual-style.js';
import { batchBaseline, instantiateCanvasPlan, layoutIndependentCanvasNodes } from './prompt-agent-canvas-batches.js';
import { prepareCanvasPlanRecreation } from './prompt-agent-canvas-recreation.js';
import { normalizePlanInputs, projectPlanConnections, referenceManifest, assertReferenceInputsPreserved, isReferencePort, assertPromptOnlyReferenceRecipe } from './prompt-agent-reference-inputs.js';
import { replaceAgentSizeFields, resolveDraftImageSize, sizeFields } from './prompt-agent-size.js';
import { imageParameterCapabilities } from './prompt-agent-model.js';
import { getPromptAgentControl, resolveAgentParameterPatch } from './prompt-agent-parameters.js';
import { getEffectiveProtocol } from '../execution/provider-request-utils.js';
import { resolveThinking } from '../execution/thinking-config.js';
import { createCanvasContext, canvasBaseline, cloneCanvasValue, canvasPlanExecutionNodeIds } from './prompt-agent-canvas-context.js';
import { assertCanvasPlanCurrent, assertCanvasPlanPromptInputs, assertCanvasMergeResize, canvasPlanDynamicPorts, canvasPlanPatchPositions,
    describeCanvasPlan, isCanvasGraphOnlyStep } from './prompt-agent-canvas-plan.js';
import { getAvailablePromptAgentImageModels } from './prompt-agent-node-adapter.js';
import { resolveAgentProvider } from './prompt-agent-provider.js';
import { nodeBounds, findNearbyNodePosition, findViewportNodePosition, setNodePosition } from '../execution/node-placement.js';
import { isPromptLibraryWrite, validatePromptLibraryWrite } from './prompt-agent-apply-library-prompt.js';
import { rememberWorkflowMediaOperation } from '../media/workflow-media-operation.js';
import { updateCommerceImageSetCopyLanguage, updateCommerceProductInfoField } from '../ecommerce-image-set/commerce-image-set-plan.js';

const controlFields = { text: 'text', filename: 'filename', resizeMode: 'resize-mode', scalePercent: 'scale-percent',
    targetWidth: 'target-width', targetHeight: 'target-height', keepAspect: 'keep-aspect', quality: 'quality',
    prompt: 'prompt', sysprompt: 'sysprompt', fixed: 'fixed', aspect: 'aspect', generationCount: 'generation-count',
    whiteBalanceMode: 'white-balance', temperature: 'temperature', tint: 'tint', vibrance: 'vibrance',
    saturation: 'saturation', previewEnabled: 'preview-enabled' };
const generationFields = { aspect: 'aspectRatio', generationCount: 'count', resolution: 'resolution', customWidth: 'customWidth', customHeight: 'customHeight', quality: 'quality', moderation: 'moderation', background: 'background', search: 'search', protocolParams: 'protocolParams' };

function generationParameters(step) {
    return { ...Object.fromEntries(Object.entries(step.parameters).filter(([key]) => Object.hasOwn(generationFields, key))
        .map(([key, value]) => [generationFields[key], value])), ...step.generationPatch };
}

function generationReferenceTargetIds(plan, recorded = []) {
    const previouslyRecorded = new Set(recorded.map(item => item.nodeId));
    return plan.steps.filter(step => step.type === 'ImageGenerate' && !isPromptLibraryWrite(plan, step)
        // Older plans also recorded nonexecuting generation nodes. Recheck every
        // recorded target during retry while keeping structural edits model-free.
        && (!isCanvasGraphOnlyStep(plan, step) || previouslyRecorded.has(plan.bindings[step.id])))
        .map(step => plan.bindings[step.id]);
}

export function createPromptAgentCanvasAdapter({ state, documentRef, serializeNodes, getWorkflowId, addNode, removeNode, onNodesRemoved = () => {},
    nodeAdapter, session, save, persistInPlace = save, graphChanged, origin, getImageAsset, runWorkflow, cancelNode, focusNode,
    renameNode, setNodesEnabled }) {
    const activePlans = new Map();
    const executionConfigs = new Map();
    const context = (mentionedIds = [], { includeSelection = true } = {}) => createCanvasContext({ workflowId: getWorkflowId(), nodes: serializeNodes(), connections: state.connections,
        selectedIds: includeSelection ? [...state.selectedNodes] : [], mentionedIds, runningIds: [...(state.runningNodeIds || [])],
        getGenerationContext: id => nodeAdapter?.getContext(id),
        getVideoAspects: id => Array.from((documentRef ? getPromptAgentControl(documentRef, state.nodes.get(id), `${id}-aspect`) : null)?.options || [])
            .filter(option => !option.disabled && !option.hidden).map(option => option.value) });
    function prepare(plan) {
        normalizePlanInputs(plan);
        return plan;
    }
    function modelsFor(plan, defaultModelId) {
        const models = getAvailablePromptAgentImageModels(state.models, state.providers);
        const existingNodes = plan.applyInPlace && plan.steps.some(step => step.type === 'ImageGenerate' && step.nodeId
            && !isCanvasGraphOnlyStep(plan, step) && !isPromptLibraryWrite(plan, step)) ? context().nodes : [];
        return Object.fromEntries(plan.steps.filter(step => step.type === 'ImageGenerate' && !step.cachedAssetKeys
            && !isCanvasGraphOnlyStep(plan, step) && !isPromptLibraryWrite(plan, step)).map(step => {
            const existing = existingNodes.find(node => node.id === step.nodeId);
            const id = plan.modelOverrides?.[step.id] || (existing ? existing.modelId : defaultModelId);
            const model = models.find(item => item.id === id);
            if (!model) throw new Error(`请为「${step.title}」手动选择可用的生图模型`);
            const providerId = plan.providerOverrides?.[step.id]?.[id] ?? (existing?.modelId === id ? existing.providerId : plan.agentProviders?.[id]);
            const provider = resolveAgentProvider(model, state.providers, providerId);
            if (!provider?.endpoint) throw new Error(`「${step.title}」的 Provider 不可用`);
            // Agent-level image thinking preferences are retired; only explicit per-step
            // overrides and the model/Provider defaults remain applicable.
            const thinking = resolveThinking({ model, provider, task: 'image', protocol: model.protocol },
                plan.thinkingOverrides?.[step.id]?.[id] ?? (existing?.modelId === id ? existing.thinking : undefined)).setting;
            return [step.id, { model, provider, thinking }];
        }));
    }
    function sizesFor(plan, defaultModelId, selected = modelsFor(plan, defaultModelId)) {
        return Object.fromEntries(plan.steps.filter(step => Object.hasOwn(selected, step.id)).map(step => {
            const config = selected[step.id];
            const targetId = step.nodeId || plan.bindings?.[step.id];
            const targetModel = documentRef?.getElementById(`${targetId}-apiconfig`)?.value || state.nodes?.get(targetId)?.apiConfigId;
            const current = !plan.newCreativeTask && targetModel === config.model.id ? nodeAdapter.getContext(targetId)?.parameters || {} : {};
            try {
                const proposed = generationParameters(step);
                const capabilities = imageParameterCapabilities(config.model, config.provider);
                if (plan.imageBatch && capabilities.maxReferences === 0) throw new Error('当前生图模型不支持参考图输入，请选择支持图生图的模型。');
                const parameters = sizeFields(proposed);
                const sources = { ...step.parameterSources };
                if (plan.explicitImageParameters) {
                    for (const key of Object.keys(proposed)) sources[key] = '本轮设置';
                    for (const key of Object.keys(proposed.protocolParams || {})) sources[`protocolParams.${key}`] = '本轮设置';
                }
                if (!step.parameterSources) for (const key of Object.keys(step.generationPatch || {})) {
                    sources[key] = '沿用任务';
                }
                const defaults = plan.agentSizes?.[config.model.id];
                for (const [key, value] of Object.entries(sizeFields(defaults))) {
                    if (sources[key] === '方案建议') { parameters[key] = value; sources[key] = '面板默认'; }
                }
                const size = resolveDraftImageSize({ protocol: getEffectiveProtocol(config.model, config.provider), modelId: config.model.modelId,
                    current, defaults, parameters, sizeIntent: step.sizeIntent, answer: step.sizeAnswer, sources });
                if (step.sizeIntent) for (const key of Object.keys(size.patch)) {
                    if (!Object.hasOwn(step.sizeAnswer || {}, key) && sources[key] !== '本轮设置') sources[key] = step.sizeIntent.referenceSize ? '参考图比例' : 'Agent 设置';
                }
                const patch = resolveAgentParameterPatch(proposed, sources,
                    capabilities.parameters, step.parameterAnswers, current);
                return [step.id, {...size, parameterPatch: replaceAgentSizeFields(patch, size.patch),
                    sources: Object.fromEntries(Object.keys(sizeFields(size.effective)).filter(key => size.effective[key] !== '').map(key => [key,
                        Object.hasOwn(step.sizeAnswer || {}, key) ? '已确认' : sources[key] || (Object.hasOwn(defaults || {}, key) ? '面板默认' : '节点或接口默认')]))}];
            } catch (error) { error.stepId = step.id; error.message = `「${step.title}」${error.message}`; throw error; }
        }));
    }
    function validateGraph(plan, connections = state.connections) {
        const ids = new Map(plan.steps.map(step => [step.id, step.nodeId || plan.bindings?.[step.id] || `new:${step.id}`]));
        assertReferenceInputsPreserved(plan, connections, ref => ids.get(ref) || ref);
        const links = projectPlanConnections(plan, connections, ref => ids.get(ref) || ref);
        assertCanvasMergeResize(plan.steps, links, ref => ids.get(ref) || ref);
        const enabledPatches = new Map(plan.steps.filter(step => step.patch?.enabled !== undefined)
            .map(step => [ids.get(step.id), step.patch.enabled]));
        for (const edge of links) {
            const source = state.nodes.get(edge.from.nodeId);
            if ((enabledPatches.get(edge.from.nodeId) ?? source?.enabled) === false && !state.connections.includes(edge)
                && !(plan.templateId && plan.retainedDisabledSources?.includes(edge.from.nodeId))) throw new Error('不能新增或改写已禁用来源的输入关系。');
        }
        const visited = new Set(), visiting = new Set();
        const visit = id => {
            if (visiting.has(id)) throw new Error('方案与已有画布形成循环依赖');
            if (visited.has(id)) return;
            visiting.add(id); links.filter(link => link.to.nodeId === id).forEach(link => visit(link.from.nodeId));
            visiting.delete(id); visited.add(id);
        };
        for (const id of ids.values()) visit(id);
        for (const step of plan.steps) {
            if (step.execute === false || !['ImageResize', 'ImagePreview', 'ImageCompare', 'ImageMerge', 'ImageSave'].includes(step.type)) continue;
            const inputs = links.filter(link => link.to.nodeId === ids.get(step.id));
            const hasRequiredInput = step.type === 'ImageCompare' ? inputs.some(link => link.to.port === 'imageB')
                : step.type === 'ImageSave' ? inputs.some(link => ['image', 'video'].includes(link.to.port))
                    : inputs.some(link => /^image/.test(link.to.port));
            if (!hasRequiredInput) throw new Error(`「${step.title}」缺少必要${step.type === 'ImageSave' ? '媒体' : '图片'}输入`);
        }
        return { ids, links };
    }
    const liveRecreationConnections = recreation => recreation.missingIds.size ? recreation.connections.map(edge =>
        state.connections.find(current => current.id && current.id === edge.id) || edge) : state.connections;
    function applyNodePatch(node, patch) {
        if (!node || node.isClone || state.runningNodeIds?.has(node.id)) throw new Error('目标节点已变化，无法修改');
        const { title, enabled, x, y } = patch;
        if (title !== undefined && title !== (node.customTitle || '') && !renameNode?.(node.id, title)) {
            throw new Error('无法修改节点名称');
        }
        if (enabled !== undefined && enabled !== (node.enabled !== false) && !setNodesEnabled?.([node.id], enabled)) {
            throw new Error('无法修改节点启用状态');
        }
        if (x !== undefined) {
            node.x = x;
            node.el.style.left = `${x}px`;
        }
        if (y !== undefined) {
            node.y = y;
            node.el.style.top = `${y}px`;
        }
    }
    function applyPromptLibraryField(plan, step) {
        const { control, content } = validatePromptLibraryWrite(plan, step, context());
        const node = state.nodes.get(step.nodeId);
        const field = getPromptAgentControl(documentRef, node, `${node.id}-${control}`);
        if (field?.tagName !== 'TEXTAREA' || field.disabled || control !== 'text' && field.readOnly) {
            throw new Error('目标提示词当前不可编辑');
        }
        // Some old workflows stored a second value in the protocol parameters.
        // The normal prompt textarea becomes the effective source after this edit.
        if (control === 'prompt' && node.type === 'ImageGenerate' && node.data?.protocolParams) delete node.data.protocolParams.prompt;
        field.value = content;
        field.dispatchEvent(new documentRef.defaultView.Event('input', { bubbles: true }));
        field.dispatchEvent(new documentRef.defaultView.Event('change', { bubbles: true }));
    }
    async function apply(plan, defaultModelId, onPlanChange = () => {}, isCurrent = () => true, {
        stagedImports = new Map(), persist = plan.applyInPlace ? persistInPlace : save
    } = {}) {
        if (!isCurrent()) throw new Error('方案所属会话已变化');
        if (activePlans.size && !plan.templateId) throw new Error('另一个画布方案正在执行');
        const initialContext = context();
        const recreation = prepareCanvasPlanRecreation(plan, initialContext);
        const connectionBase = liveRecreationConnections(recreation);
        assertCanvasPlanPromptInputs(plan, initialContext);
        const libraryStep = plan.steps.find(step => isPromptLibraryWrite(plan, step));
        if (plan.libraryPrompt && !libraryStep) throw new Error('提示词库操作缺少有效目标');
        const selected = modelsFor(plan, defaultModelId);
        const sizes = sizesFor(plan, defaultModelId, selected);
        const configurationSnapshot = cloneCanvasValue({ models: state.models, providers: state.providers });
        const proposed = validateGraph(plan, connectionBase);
        const signature = JSON.stringify({ sizes, steps: plan.steps, connections: plan.connections, disconnects: plan.disconnects || [], deletes: plan.deletes || [],
            models: Object.fromEntries(Object.entries(selected).map(([id, config]) => [id, { modelId: config.model.id, providerId: config.provider.id, thinking: config.thinking }])) });
        if (plan.appliedSignature === signature && plan.steps.every(step => state.nodes.has(plan.bindings?.[step.id]))) {
            const saved = await persist();
            if (saved?.publicationUnknown) throw new Error('无法确认画布保存结果，请重新打开工作流查看后再重试。');
            if (saved === false || saved?.committed === false) throw new Error('方案保存失败，请重试');
            executionConfigs.set(plan.id, configurationSnapshot);
            return plan;
        }
        if (libraryStep) validatePromptLibraryWrite(plan, libraryStep, initialContext);
        const workflowId = getWorkflowId();
        for (const step of plan.steps) {
            const staged = stagedImports.get(step.id);
            if (staged && (step.nodeId || step.type !== 'ImageImport' || step.assetKey !== staged.asset.asset_key || state.nodes.has(staged.nodeId))) {
                throw new Error('历史原图暂存与导入节点不匹配，请重新导入。');
            }
            if (step.assetKey && !staged && !await getImageAsset(step.assetKey)) throw new Error('本地原图缺失，不能应用方案');
        }
        if (!isCurrent()) throw new Error('读取素材期间会话已变化，未创建节点');
        if (getWorkflowId() !== workflowId) throw new Error('工作流已切换');
        if (JSON.stringify(configurationSnapshot) !== JSON.stringify({ models: state.models, providers: state.providers })) throw new Error('模型配置已变化，请检查模型后重新应用');
        const latestRecreation = prepareCanvasPlanRecreation(plan, context());
        if (JSON.stringify([...latestRecreation.missingIds]) !== JSON.stringify([...recreation.missingIds])) throw new Error('准备期间画布节点发生变化，请重试应用');
        const bindings = { ...(plan.bindings || {}) };
        const additive = plan.templateId && !(plan.deletes || []).length
            && plan.steps.every(step => !step.nodeId && !state.nodes.has(bindings[step.id]))
            && (plan.connections || []).every(edge => plan.steps.some(step => step.id === edge.to.ref))
            && (plan.disconnects || []).every(edge => plan.steps.some(step => step.id === edge.ref));
        const originalPlan = cloneCanvasValue(plan);
        const createdNodes = [];
        const locked = [...documentRef.body.children].map(element => [element, element.inert]);
        locked.forEach(([element]) => { element.inert = true; });
        try {
            const result = await session().applyCanvasBatch(async () => {
                const currentRecreation = prepareCanvasPlanRecreation(plan, context());
                if (JSON.stringify([...currentRecreation.missingIds]) !== JSON.stringify([...recreation.missingIds])) throw new Error('准备期间画布节点发生变化，请重试应用');
                const currentConnections = liveRecreationConnections(currentRecreation);
                validateGraph(plan, currentConnections);
                const promptTargets = new Set((plan.promptInputChange?.targetNodeIds || []).filter(nodeId => {
                    const before = state.connections.filter(edge => edge.to.nodeId === nodeId && edge.to.port === 'prompt').at(-1);
                    const after = proposed.links.filter(edge => edge.to.nodeId === nodeId && edge.to.port === 'prompt').at(-1);
                    return before && (!after || before.from.nodeId !== after.from.nodeId || before.from.port !== after.from.port);
                }));
                if (promptTargets.size) state.connections = state.connections.filter(edge => !(promptTargets.has(edge.to.nodeId) && edge.to.port === 'prompt'));
                const viewport = origin();
                const zoom = state.canvas?.zoom || 1;
                const occupied = [...state.nodes.values()].map(node => nodeBounds(node, zoom));
                const gridSteps = new Set(plan.steps.filter(step => {
                    const nodeId = step.nodeId || bindings[step.id];
                    return (!nodeId || recreation.missingIds.has(nodeId))
                        && !currentConnections.some(edge => edge.from.nodeId === nodeId || edge.to.nodeId === nodeId)
                        && !plan.connections.some(edge => edge.from.ref === step.id || edge.to.ref === step.id);
                }).map(step => step.id));
                if (gridSteps.size < 2) gridSteps.clear();
                for (const id of plan.order) {
                    const step = plan.steps.find(item => item.id === id);
                    let nodeId = step.nodeId || bindings[id];
                    if (!nodeId || recreation.missingIds.has(nodeId)) {
                        const config = selected[id];
                        const staged = stagedImports.get(id);
                        const parameters = config && step.type === 'ImageGenerate'
                            ? { prompt: step.parameters.prompt } : step.type === 'VisualStyle' ? { visualStyle: normalizeVisualStyle(step.parameters), styleDetailLevel: normalizeVisualStyleDetailLevel(step.parameters.styleDetailLevel) } : step.parameters;
                        nodeId = addNode(step.type, viewport.x, viewport.y, { ...parameters, customTitle: step.title,
                            ...(staged ? { id: staged.nodeId, agentReferenceSource: {
                                historyId: staged.id, historyVersion: staged.fileVersion, assetKey: step.assetKey
                            } } : {}),
                            ...(config ? { apiConfigId: config.model.id, providerId: config.provider.id } : {}),
                            ...(step.assetKey ? { mediaAssetKeys: step.cachedAssetKeys || [step.assetKey], imageImportAssetKey: step.assetKey, imageAssetReady: true } : {}),
                            ...(step.cachedAssetKeys ? { mediaAssetKeys: [...step.cachedAssetKeys], imageAssetKey: step.cachedAssetKeys[0], imageAssetReady: true,
                                imageCount: step.cachedAssetKeys.length, apiConfigId: step.cachedModelId || '', providerId: step.cachedProviderId || '' } : {}),
                            ...(step.autoAddedForGeneration ? { autoAddedForGeneration: true } : {}) }, true);
                        if (!nodeId || !state.nodes.has(nodeId)) throw new Error('节点创建失败');
                        if (staged && (nodeId !== staged.nodeId || !rememberWorkflowMediaOperation(state.nodes.get(nodeId), [staged.asset]))) {
                            throw new Error('无法登记历史原图的保存记录，请重新导入。');
                        }
                        createdNodes.push({ nodeId, type: step.type, autoAdded: step.autoAddedForGeneration });
                        if (!gridSteps.has(id)) {
                            const node = state.nodes.get(nodeId);
                            const { width, height } = nodeBounds(node, zoom);
                            const parents = plan.connections.filter(link => link.to.ref === id).map(link =>
                                state.nodes.get(bindings[link.from.ref] || plan.steps.find(item => item.id === link.from.ref)?.nodeId || link.from.ref)).filter(Boolean);
                            parents.sort((a, b) => b.x - a.x);
                            const batchParent = parents.find(parent => createdNodes.some(item => item.nodeId === parent.id));
                            const anchor = batchParent || parents[0];
                            const bounds = anchor && nodeBounds(anchor, zoom);
                            const beside = bounds && { x: bounds.x + bounds.width + 80, y: bounds.y };
                            let position;
                            if (batchParent) {
                                position = findNearbyNodePosition({ ...beside, width, height,
                                    occupied: viewport.blockedSpan ? [...occupied, viewport.blockedSpan] : occupied });
                            } else {
                                position = findViewportNodePosition({ viewport, width, height, occupied, preferredPosition: beside });
                            }
                            setNodePosition(node, position);
                            occupied.push({ ...position, width, height });
                        }
                    }
                    if (!state.nodes.has(nodeId)) throw new Error('方案绑定节点已删除，请刷新方案');
                    bindings[id] = nodeId;
                    if (step.patch) applyNodePatch(state.nodes.get(nodeId), step.patch);
                    if (step.cachedAssetKeys || isCanvasGraphOnlyStep(plan, step)) continue;
                    if (isPromptLibraryWrite(plan, step)) {
                        applyPromptLibraryField(plan, step);
                    } else if (step.type === 'ImageGenerate') {
                        const inheritedInput = step.inheritedFields?.includes('prompt') && plan.connections.some(edge => edge.to.ref === id && edge.to.port === 'prompt');
                        const prompt = inheritedInput && !String(step.parameters.prompt || '').trim() ? undefined : step.parameters.prompt ?? nodeAdapter.getContext(nodeId)?.prompt;
                        const patch = { targetNodeId: nodeId, prompt, ...(typeof step.negativePrompt === 'string' ? { negativePrompt: step.negativePrompt } : {}),
                            parameters: { ...sizes[id].parameterPatch } };
                        nodeAdapter.ensureTarget(patch, { modelId: selected[id].model.id, providerId: selected[id].provider.id });
                        const schema = step.inheritedFields?.length && nodeAdapter.getContext(nodeId)?.parameterSchema;
                        if (schema) for (const field of step.inheritedFields || []) {
                            const key = generationFields[field];
                            const rule = schema[key], value = patch.parameters[key];
                            const unsupported = !rule || (rule.enum && !rule.enum.includes(String(value))) || (rule.type === 'string' && typeof value !== 'string');
                            if (key && unsupported && !Object.hasOwn(step.generationPatch || {}, key)) delete patch.parameters[key];
                        }
                        state.nodes.get(nodeId).data.thinking = cloneCanvasValue(selected[id].thinking);
                        state.nodes.get(nodeId).el?._thinkingControl?.refresh();
                        if (!nodeAdapter.applyPromptPlan(patch)) throw new Error('生图参数不兼容');
                    } else if (step.type === 'VisualStyle') {
                        if (state.isRunning) throw new Error('请等待工作流运行结束后修改画面风格。');
                        const node = state.nodes.get(nodeId);
                        const { styleDetailLevel, ...styleParameters } = step.parameters;
                        if (styleDetailLevel !== undefined) node.data.styleDetailLevel = normalizeVisualStyleDetailLevel(styleDetailLevel);
                        const base = Object.keys(styleParameters).length === 1 && Object.hasOwn(styleParameters, 'description')
                            ? {} : Object.hasOwn(styleParameters, 'preset') ? normalizeVisualStyle({ preset: styleParameters.preset }) : node.data.visualStyle;
                        node.data.visualStyle = normalizeVisualStyle({ ...base, ...styleParameters });
                        node.refreshVisualStyle?.();
                    } else if (step.type === 'ECommerceImageSet') {
                        const node = state.nodes.get(nodeId);
                        if (Object.hasOwn(step.parameters, 'copyLanguage')) {
                            updateCommerceImageSetCopyLanguage(node.data.commerceImageSet, step.parameters.copyLanguage);
                        }
                        for (const [field, value] of Object.entries(step.parameters.productInfo || {})) {
                            updateCommerceProductInfoField(node.data.commerceImageSet, field, value);
                        }
                        documentRef.dispatchEvent(new documentRef.defaultView.CustomEvent('cainflow:commerce-image-set-updated',
                            { detail: { nodeId } }));
                    } else for (const [field, value] of Object.entries(step.parameters)) {
                        if (field === 'inputCount') {
                            if (step.nodeId) state.nodes.get(nodeId).data.inputCount = value;
                            continue;
                        }
                        const control = getPromptAgentControl(documentRef, state.nodes.get(nodeId), `${nodeId}-${controlFields[field]}`);
                        // A Text card stays read-only until direct keyboard editing begins.
                        if (!control || control.disabled || field !== 'text' && control.readOnly) throw new Error(`节点当前不可编辑参数 ${field}`);
                        if (control.options && ![...control.options].some(option => option.value === String(value) && !option.disabled)) throw new Error(`参数 ${field} 的值不受支持`);
                        if (control.type === 'checkbox') {
                            if (typeof value !== 'boolean') throw new Error(`${field} 必须是布尔值`);
                            control.checked = value;
                        } else {
                            if (control.type === 'number' && (!Number.isFinite(Number(value)) || (control.min && Number(value) < Number(control.min)) || (control.max && Number(value) > Number(control.max)))) throw new Error(`参数 ${field} 超出范围`);
                            control.value = String(value);
                        }
                        control.dispatchEvent(new documentRef.defaultView.Event('input', { bubbles: true }));
                        control.dispatchEvent(new documentRef.defaultView.Event('change', { bubbles: true }));
                    }
                }
                for (const item of plan.deletes || []) {
                    await removeNode(item.nodeId, { onlyId: true, skipHistory: true, showToast: false, notifyReferences: false });
                    if (state.nodes.has(item.nodeId)) throw new Error(`无法删除「${item.title}」，画布未修改`);
                }
                const replacementIds = new Map(plan.steps.filter(step => recreation.missingIds.has(plan.bindings?.[step.id]))
                    .map(step => [plan.bindings[step.id], bindings[step.id]]));
                const restoredConnections = recreation.missingIds.size ? currentConnections.map(edge => ({ ...edge,
                    from: { ...edge.from, nodeId: replacementIds.get(edge.from.nodeId) || edge.from.nodeId },
                    to: { ...edge.to, nodeId: replacementIds.get(edge.to.nodeId) || edge.to.nodeId }
                })) : state.connections;
                if (!libraryStep) {
                    state.connections = projectPlanConnections(plan, restoredConnections, ref => bindings[ref] || ref)
                        .map(link => ({ ...link, id: link.id || `conn_${crypto.randomUUID()}` }));
                }
                if (gridSteps.size) {
                    const gridNodes = [...gridSteps].map(id => state.nodes.get(bindings[id]));
                    const gridIds = new Set(gridNodes.map(node => node.id));
                    const gridObstacles = [...state.nodes.values()].filter(node => !gridIds.has(node.id))
                        .map(node => nodeBounds(node, zoom));
                    layoutIndependentCanvasNodes(gridNodes, { viewport, occupied: gridObstacles, zoom });
                }
                graphChanged();
                plan.completedSteps = (plan.completedSteps || []).filter(id => !recreation.affectedSteps.includes(id));
                for (const id of recreation.affectedSteps) delete plan.completedReferenceOutputs?.[id];
                plan.dependencies = plan.dependencies.filter(id => !recreation.missingIds.has(id));
                plan.bindings = bindings; plan.appliedSignature = signature; plan.appliedSizes = cloneCanvasValue(sizes);
                plan.completedDeletions = (plan.deletes || []).map(item => item.nodeId);
                const appliedContext = context();
                const executionIds = canvasPlanExecutionNodeIds(plan);
                plan.referenceManifest = referenceManifest(appliedContext.nodes, state.connections, generationReferenceTargetIds(plan), executionIds);
                plan.dependencies = [...new Set([...plan.dependencies, ...Object.values(bindings)])];
                plan.baseline = batchBaseline(plan, appliedContext, executionIds);
                if (plan.patchPositions) plan.patchPositions = canvasPlanPatchPositions(plan.steps, appliedContext);
                const dynamicPorts = canvasPlanDynamicPorts(plan, appliedContext);
                if (dynamicPorts.length) plan.dynamicPorts = dynamicPorts;
                onPlanChange();
                return {};
            }, persist, {
                persistCapturesWorkflow: persist !== save,
                ...(additive ? { rollbackAdditions: async () => {
                    for (const item of createdNodes) await removeNode(item.nodeId, { onlyId: true, skipHistory: true, showToast: false, notifyReferences: false });
                    graphChanged();
                } } : {})
            });
            plan.bindings = bindings; plan.historyId = result.historyId; plan.appliedSignature = signature;
            plan.dependencies = [...new Set([...plan.dependencies, ...Object.values(bindings)])];
            plan.baseline = batchBaseline(plan, context(), canvasPlanExecutionNodeIds(plan));
        } catch (error) {
            Object.keys(plan).forEach(key => delete plan[key]); Object.assign(plan, originalPlan); onPlanChange(); throw error;
        } finally { locked.forEach(([element, inert]) => { element.inert = inert; }); }
        if (plan.deletes?.length) onNodesRemoved(plan.deletes.map(item => item.nodeId));
        const target = createdNodes.find(node => node.type === 'ImageGenerate')
            || createdNodes.find(node => !node.autoAdded && node.type !== 'ImageImport')
            || createdNodes[0];
        if (target) {
            try { focusNode(target.nodeId); } catch (error) { console.warn('无法定位新建节点', error); }
        }
        executionConfigs.set(plan.id, configurationSnapshot);
        return plan;
    }
    function canUndo(plan) {
        if (activePlans.size || state.runningNodeIds?.size || state.canvasPlanApplying) return '有节点正在运行或应用';
        let latest; try { latest = JSON.parse(state.undoStack.at(-1) || '{}').historyId; } catch { /* old entry */ }
        return plan.historyId && latest === plan.historyId ? '' : '需先撤销后续修改，或本次撤销记录已不可用';
    }
    async function execute(plan, { retainResults, retry = false } = {}) {
        if (activePlans.has(plan.id) || (activePlans.size && !plan.templateId)) throw new Error('此批次正在运行');
        try {
        const validateInputs = () => {
            const currentCanvas = context();
            assertCanvasPlanCurrent(plan, currentCanvas);
            const recorded = plan.referenceManifest;
            if (!Array.isArray(recorded)) throw new Error('缺少已确认方案的参考图快照，请重新应用方案。');
            const targets = generationReferenceTargetIds(plan, recorded);
            const actual = referenceManifest(currentCanvas.nodes, state.connections, targets, canvasPlanExecutionNodeIds(plan));
            if (JSON.stringify(actual) !== JSON.stringify(recorded)) throw new Error('参考图输入与已确认方案不一致，请重新应用方案。');
            if (retry) {
                const skipped = new Set((plan.completedSteps || []).map(id => plan.bindings[id]));
                for (const input of actual.flatMap(target => target.inputs).filter(input => input.upstream && skipped.has(input.nodeId))) {
                    const step = plan.steps.find(step => plan.bindings[step.id] === input.nodeId);
                    const saved = plan.completedReferenceOutputs?.[step.id];
                    const current = currentCanvas.nodes.find(node => node.id === input.nodeId)?.assets;
                    if (!saved?.assets?.length || saved.nodeId !== input.nodeId || JSON.stringify(saved.assets) !== JSON.stringify(current)) {
                        throw new Error('已完成上游的参考图已变化或缺少原图快照，请重新应用并完整执行方案。');
                    }
                }
            }

        };
        validateInputs();
        const selectedNodeIds = plan.order.filter(id => plan.steps.find(step => step.id === id)?.execute !== false
            && (!retry || !plan.completedSteps?.includes(id))).map(id => plan.bindings[id]);
        if (!selectedNodeIds.length) throw new Error('没有待执行步骤');
        if (!retry) plan.completedReferenceOutputs = {};
        activePlans.set(plan.id, plan);
            const runMode = plan.imageBatch ? { imageBatch: true, requestSource: 'agent' } : { agentSequential: true };
            const completion = await runWorkflow({ mode: 'selected-only', selectedNodeIds, ...runMode }, { retainResults, configurationSnapshot: executionConfigs.get(plan.id), validateBeforeRun: validateInputs });
            plan.completedReferenceOutputs ||= {};
            const completed = (completion?.nodeResults || []).filter(entry => entry.succeeded);
            for (const entry of completed) {
                const step = plan.steps.find(step => plan.bindings[step.id] === entry.nodeId);
                if (!step) continue;
                const assets = entry.mediaAssetKeys?.length ? entry.mediaAssetKeys
                    : getWorkflowId() === plan.workflowId ? context().nodes.find(node => node.id === entry.nodeId)?.assets || [] : [];
                if (assets.length) plan.completedReferenceOutputs[step.id] = { nodeId: entry.nodeId, assets: [...assets] };
            }
            return completion;
        }
        finally { activePlans.delete(plan.id); executionConfigs.delete(plan.id); }
    }
    return { context, prepare, describe: (plan, defaultModelId) => {
            const lines = describeCanvasPlan(plan, context());
            if (defaultModelId) try {
                const selected = modelsFor(plan, defaultModelId);
                const label = value => !value || value.mode === 'default' ? '接口默认' : String(value.value ?? value.mode);
                for (const step of plan.steps.filter(item => Object.hasOwn(selected, item.id))) {
                    const before = state.nodes.get(step.nodeId || plan.bindings?.[step.id])?.data?.thinking;
                    const node = state.nodes.get(step.nodeId || plan.bindings?.[step.id]);
                    const oldProvider = state.providers.find(provider => provider.id === node?.data?.providerId);
                    lines.push(`${step.title} · 供应商：${oldProvider?.name || node?.data?.providerId || '未设置'} → ${selected[step.id].provider.name || selected[step.id].provider.id}`);
                    lines.push(`${step.title} · 思考设置：${label(before)} → ${label(selected[step.id].thinking)}`);
                }
            } catch (error) { lines.push(error.message); }
            try { for (const [id, size] of Object.entries(sizesFor(plan, defaultModelId))) lines.push(`${plan.steps.find(step => step.id === id).title} · 尺寸：${size.summary}`); }
            catch (error) { lines.push(error.message); }
            return lines;
        }, apply, execute, modelsFor, sizesFor, canUndo, instantiate: plan => instantiateCanvasPlan(plan, context()),
        discardExecutionConfig: plan => executionConfigs.delete(plan.id),
        readImage: getImageAsset,
        inputs: plan => {
            const current = context();
            const identity = ref => plan.steps.find(step => step.id === ref)?.nodeId || plan.bindings?.[ref] || ref;
            const links = projectPlanConnections(plan,current.connections,identity).map(link=>({...link,from:{ref:link.from.nodeId,port:link.from.port},to:{ref:link.to.nodeId,port:link.to.port}}));
            return links.filter(link => isReferencePort(link.to.port)
                && plan.steps.some(step => identity(step.id) === link.to.ref && step.type === 'ImageGenerate')).map(link => {
                const step = plan.steps.find(item => identity(item.id) === link.from.ref);
                const node = current.nodes.find(item => item.id === link.from.ref);
                return { name: step?.title || node?.name || link.from.ref,
                    assetKey: step?.assetKey || node?.assets?.[0], purpose: plan.steps.find(item => identity(item.id) === link.to.ref)?.title,
                    upstream: Boolean(step && step.type !== 'ImageImport') };
            });
        },
        isRunning: id => activePlans.has(id),
        isPreparing: () => state.isRunStarting === true || state.canvasPlanApplying === true,
        executionRecord: (plan, id) => {
            const nodeId = plan.bindings[id];
            return { referenceInputs: cloneCanvasValue(plan.referenceManifest?.find(item=>item.nodeId===nodeId)?.inputs || []), size: cloneCanvasValue(plan.appliedSizes?.[id]?.effective || null), thinking: cloneCanvasValue(state.nodes.get(nodeId)?.data?.thinking || { mode: 'default' }), modelId: documentRef.getElementById(`${nodeId}-apiconfig`)?.value || '', providerId: documentRef.getElementById(`${nodeId}-provider`)?.value || '' };
        },
        stepStatus: (plan, id) => {
            const node = state.nodes.get(plan.bindings?.[id]);
            if (node && plan.steps.find(step => step.id === id)?.cachedAssetKeys) return 'cached';
            if (activePlans.has(plan.id) && getWorkflowId() === plan.workflowId) {
                if (state.runningNodeIds?.has(node?.id) || node?.el?.classList.contains('running')) return 'running';
                if (node?.isSucceeded) return 'completed';
                if (node?.executionFailure) return 'failed';
            }
            return plan.runs?.at(-1)?.steps?.find(step => step.id === id)?.status || (plan.bindings?.[id] ? 'applied' : 'draft');
        },
        refresh: plan => {
            if (activePlans.size) throw new Error('请等待当前方案执行结束');
            if (plan.workflowId !== getWorkflowId() || plan.dependencies.some(id => !state.nodes.has(id)
                && !((plan.appliedSignature || plan.completedDeletions?.includes(id)) && plan.deletes?.some(item => item.nodeId === id)))) throw new Error('相关节点已删除或工作流已切换，请重新提出方案');
            validateGraph(plan);
            const current = context();
            assertPromptOnlyReferenceRecipe(plan, { ...cloneCanvasValue(plan), baseline: undefined, referenceManifest: undefined }, current);
            const deletedIds = new Set((plan.deletes || []).map(item => item.nodeId));
            const deletionsApplied = (plan.appliedSignature || [...deletedIds].every(id => plan.completedDeletions?.includes(id))) && deletedIds.size
                && [...deletedIds].every(id => !state.nodes.has(id));
            if (!deletionsApplied && deletedIds.size) {
                plan.deletes = plan.deletes.map(item => ({ ...item, title: current.nodes.find(node => node.id === item.nodeId).name }));
                plan.deletionConnections = current.connections.filter(link => deletedIds.has(link.from.nodeId) || deletedIds.has(link.to.nodeId));
                plan.dependencies = [...new Set([...plan.dependencies, ...plan.deletionConnections.flatMap(link => [link.from.nodeId, link.to.nodeId])])];
            }
            plan.baseline = canvasBaseline(current, plan.dependencies, canvasPlanExecutionNodeIds(plan));
            if (!deletionsApplied || plan.steps.length) delete plan.appliedSignature;
        },
        focus: focusNode, stop: plan => Object.values(plan.bindings || {}).forEach(cancelNode),
        undo: async plan => { const reason = canUndo(plan); if (reason) throw new Error(reason); await session().undo(); } };
}
