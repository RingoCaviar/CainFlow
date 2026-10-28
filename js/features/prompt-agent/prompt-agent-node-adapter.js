import { resolveAgentSize, sizeFields } from './prompt-agent-size.js';
import { resolveAgentProvider } from './prompt-agent-provider.js';
import { getEffectiveProtocol, getGenerationInputProtocolId, getModelProviders, getModelsForTask, getResolvedProviderForModel } from '../execution/provider-request-utils.js';
import { getModelProtocolConfig } from '../execution/model-protocol-registry.js';
import { normalizeImageSizeControls } from '../execution/image-generation-size.js';
import { normalizePromptAgentParameters, readPromptAgentParameterSchema, getPromptAgentControl } from './prompt-agent-parameters.js';
import { getCanonicalImageList, getImageImportMediaAssetReferences, getPrimaryTextInput } from '../execution/execution-data-utils.js';
import { projectImageOutput } from '../../nodes/image-output-projection.js';
import { projectImageReferences } from '../../nodes/image-reference-projection.js';
import { validateUniversalImageInputs } from '../../nodes/universal-input-policy.js';
import { getProtocol } from '../execution/protocols/index.js';
import { projectPlanConnections } from './prompt-agent-reference-inputs.js';
import { getImageDescription, setImageDescription } from '../execution/reference-image-description.js';

export function getAvailablePromptAgentImageModels(models = [], providers = []) {
    return getModelsForTask(models, 'image').filter((model) =>
        model?.id && String(model.modelId || '').trim()
        && getModelProtocolConfig(model.protocol)?.defaultTaskTypes.includes('image')
        && getModelProviders(model, providers).some((provider) => String(provider.endpoint || '').trim())
    );
}

function readValue(documentRef, id, fallback = '') {
    const value = documentRef.getElementById(id)?.value;
    return value === undefined || value === null ? fallback : value;
}

function writeValue(documentRef, id, value, createEvent) {
    const control = documentRef.getElementById(id);
    if (!control || value === undefined || value === null) return false;
    control.value = String(value);
    control.dispatchEvent?.(createEvent('input'));
    control.dispatchEvent?.(createEvent('change'));
    return true;
}

function readBoolean(documentRef, id, fallback = false) {
    const control = documentRef.getElementById(id);
    return control ? control.checked === true : fallback === true;
}

function writeBoolean(documentRef, id, value, createEvent) {
    const control = documentRef.getElementById(id);
    if (!control || value === undefined || value === null) return false;
    control.checked = value === true;
    control.dispatchEvent?.(createEvent('change'));
    return true;
}

function getReferenceImageDescriptor(state, connection, projected = null) {
    const sourceNode = projected?.source || state.nodes?.get(connection.from?.nodeId);
    const { images: originals, assets: assetKeys, count } = projected || projectImageOutput(sourceNode, getCanonicalImageList(sourceNode));
    const images = Math.max(originals.length, assetKeys.length) < count
        ? Array.from({ length: count }, (_, index) => originals[index] || '') : originals;
    const descriptions = Array.from({ length: count }, (_, index) => getImageDescription(sourceNode, index));
    return {
        sourceNodeId: connection.from?.nodeId || '',
        name: sourceNode?.customTitle || sourceNode?.type || '来源已不存在',
        sourcePort: connection.from?.port || '',
        targetPort: connection.to.port,
        assetKeys,
        images,
        ...(getImageDescription(sourceNode) ? { description: getImageDescription(sourceNode) } : {}),
        ...(descriptions.some(Boolean) ? { descriptions } : {})
    };
}

export function createPromptAgentNodeAdapter({
    state,
    documentRef = document,
    scheduleSave = () => {},
    commitReferenceConnections = (connections) => { state.connections = connections; },
    createImageNode = () => null,
    getNodeImages = async (node) => getCanonicalImageList(node),
    getCachedOutputValue = (node, port) => port === 'text' ? node?.data?.texts || node?.data?.text || node?.text : undefined,
    resolveImageSource = async (source) => source,
    createEvent = (type) => new Event(type, { bubbles: true })
} = {}) {
    const controlDocument = { getElementById(id) {
        const node = [...(state?.nodes?.values() || [])].filter(node => id === node.id || id.startsWith(`${node.id}-`))
            .sort((left, right) => right.id.length - left.id.length)[0];
        return getPromptAgentControl(documentRef, node, id);
    } };

    function getSceneReferenceImages() {
        const references = [];
        let importIndex = 0;
        for (const node of state?.nodes?.values() || []) {
            if (node.type !== 'ImageImport') continue;
            importIndex += 1;
            const mode = readValue(controlDocument, `${node.id}-import-mode`, node.importMode || 'upload');
            const url = readValue(controlDocument, `${node.id}-url-input`, node.imageUrl || '');
            const images = mode === 'url' ? (url ? [url] : []) : getCanonicalImageList(node);
            const assets = mode === 'url' ? [] : (node.data?.mediaAssetKeys?.length
                ? node.data.mediaAssetKeys : getImageImportMediaAssetReferences(node).slice(0, 1));
            const count = Math.max(images.length, assets.length);
            for (let index = 0; index < count; index += 1) {
                references.push({
                    referenceId: JSON.stringify([node.id, index, mode, assets[index] || (mode === 'url' ? url : '')]),
                    sourceNodeId: node.id,
                    sourceImageIndex: index,
                    name: `${node.customTitle || `图片导入 ${importIndex}`}${count > 1 ? ` · ${index + 1}` : ''}`,
                    description: getImageDescription(node, index),
                    previewUrl: images[index] || (index === 0 ? node.data?.imagePreviewThumbnail || '' : '')
                });
            }
        }
        return references;
    }

    async function readSceneReferenceImage(reference) {
        const node = state?.nodes?.get(reference?.sourceNodeId);
        if (node?.type !== 'ImageImport' || !getSceneReferenceImages().some((item) => item.referenceId === reference.referenceId)) {
            throw new Error('该图片已不在当前场景，请重新选择。');
        }
        const mode = readValue(controlDocument, `${node.id}-import-mode`, node.importMode || 'upload');
        const images = mode === 'url'
            ? [readValue(controlDocument, `${node.id}-url-input`, node.imageUrl || '')]
            : await getNodeImages(node);
        const source = images?.[reference.sourceImageIndex];
        if (!source) throw new Error('无法读取原图，请先在图片导入节点恢复图片。');
        const dataUrl = await resolveImageSource(source);
        if (state?.nodes?.get(node.id) !== node
            || !getSceneReferenceImages().some((item) => item.referenceId === reference.referenceId)) {
            throw new Error('图片或工作流已变化，请重新选择。');
        }
        if (!/^data:image\/[^;]+;base64,/i.test(String(dataUrl || ''))) throw new Error('无法读取此参考图，请检查图片来源。');
        return {
            referenceId: reference.referenceId, sourceNodeId: node.id, sourceImageIndex: reference.sourceImageIndex,
            name: reference.name, description: getImageDescription(node, reference.sourceImageIndex), dataUrl, type: dataUrl.slice(5, dataUrl.indexOf(';'))
        };
    }

    function setSceneReferenceDescription(reference, description) {
        const node = state?.nodes?.get(reference?.sourceNodeId);
        if (node?.type !== 'ImageImport') return false;
        setImageDescription(node, description, reference.sourceImageIndex || 0);
        scheduleSave();
        return true;
    }

    function getSelectedNode() {
        const selectedIds = Array.from(state?.selectedNodes || []);
        if (selectedIds.length !== 1) return null;
        const node = state?.nodes?.get(selectedIds[0]);
        return node?.type === 'ImageGenerate' ? node : null;
    }

    function getContext(nodeId) {
        const node = state?.nodes?.get(nodeId);
        if (node?.type !== 'ImageGenerate') return null;
        const referenceImages = projectImageReferences({ state, targetId: node.id }).groups
            .filter(group => group.enabled && !group.running && group.count > 0)
            .map(group => getReferenceImageDescriptor(state, group.connection, group));
        const protocolParams = { ...(node.data?.protocolParams || {}) };
        const modelId = readValue(controlDocument, `${node.id}-apiconfig`, node.apiConfigId || '');
        const model = state.models?.find((candidate) => candidate.id === modelId);
        const output = getReferenceImageDescriptor(state, { from: { nodeId: node.id, port: 'image' }, to: { port: '' } });
        const localPrompt = readValue(controlDocument, `${node.id}-prompt`, node.data?.prompt ?? '');
        const promptSource = getPromptSource(node);
        return {
            nodeId: node.id,
            prompt: promptSource?.active ? promptSource.text : protocolParams.prompt || localPrompt,
            localPrompt,
            promptSource,
            negativePrompt: readValue(controlDocument, `${node.id}-param-negative_prompt`, protocolParams.negative_prompt || node.data?.promptAgentNegativePrompt || ''),
            parameterSchema: readPromptAgentParameterSchema(documentRef, node.id, node),
            model: model ? { modelId: model.modelId, protocol: model.protocol } : null,
            parameters: {
                aspectRatio: readValue(controlDocument, `${node.id}-aspect`, node.data?.aspect || ''),
                resolution: readValue(controlDocument, `${node.id}-resolution`, node.data?.resolution || ''),
                customWidth: readValue(controlDocument, `${node.id}-custom-resolution-width`, node.data?.customWidth || ''),
                customHeight: readValue(controlDocument, `${node.id}-custom-resolution-height`, node.data?.customHeight || ''),
                quality: readValue(controlDocument, `${node.id}-quality`, node.data?.quality || ''),
                moderation: readValue(controlDocument, `${node.id}-moderation`, node.data?.moderation || ''),
                background: readValue(controlDocument, `${node.id}-background`, node.data?.background || ''),
                search: readBoolean(controlDocument, `${node.id}-search`, node.data?.search),
                count: Math.max(1, parseInt(readValue(controlDocument, `${node.id}-generation-count`, node.data?.generationCount || '1'), 10) || 1),
                protocolParams
            },
            referenceImages,
            outputImages: output.images.length || output.assetKeys.length ? [output] : []
        };
    }

    function getSelectedContext() {
        return getContext(getSelectedNode()?.id);
    }

    function isRunning(node) {
        return Boolean(node && (state?.runningNodeIds?.has(node.id) || node.el?.classList?.contains('running')));
    }

    function getPromptSource(node) {
        const connection = state.connections?.find(edge => edge.to.nodeId === node.id && edge.to.port === 'prompt');
        if (!connection) return null;
        const source = state.nodes.get(connection.from.nodeId), port = connection.from.port;
        let text = '', reason;
        if (!source) reason = 'missing';
        else if (source.enabled === false) reason = 'disabled';
        else {
            try { text = getPrimaryTextInput(getCachedOutputValue(source, port)); }
            catch { reason = 'unavailable'; }
            if (!text && !reason) reason = 'empty';
        }
        const editable = source?.type === 'Text' && port === 'text' && source.enabled !== false && !source.isClone && !isRunning(source);
        if (!reason && !editable) reason = isRunning(source) ? 'running' : source?.isClone ? 'readonly'
            : source?.type === 'CameraControl' ? 'derived' : 'unsupported';
        return { nodeId: connection.from.nodeId, port, type: source?.type || '', name: source?.customTitle || source?.type || '来源已不存在',
            text, editable, active: !!text, connected: true, ...(reason ? { reason } : {}) };
    }

    function preflightPromptChange(node, plan) {
        if (node.isClone) throw new Error('克隆节点的参数只读，请明确修改可编辑的原节点。');
        const source = getPromptSource(node);
        if (source?.active && typeof plan.prompt === 'string' && plan.prompt.trim() !== source.text.trim()) {
            throw new Error(`主提示词来自「${source.name}」，请在方案中明确修改支持的真实来源；不能只修改无效的本地稿。`);
        }
        return source;
    }

    function configureTarget(node, model, provider) {
        const modelChanged = readValue(controlDocument, `${node.id}-apiconfig`, node.apiConfigId || '') !== model.id
            || (node.apiConfigId && node.apiConfigId !== model.id);
        const providerChanged = readValue(controlDocument, `${node.id}-provider`, node.providerId || '') !== provider.id;
        const dataChanged = node.apiConfigId !== model.id || node.providerId !== provider.id;
        // The normal node change handlers rebuild protocol controls before the
        // plan is validated against the selected model's actual parameters.
        if (modelChanged) writeValue(controlDocument, `${node.id}-apiconfig`, model.id, createEvent);
        if (modelChanged || providerChanged) writeValue(controlDocument, `${node.id}-provider`, provider.id, createEvent);
        node.apiConfigId = model.id;
        node.providerId = provider.id;
        node.data ||= {};
        node.data.apiConfigId = model.id;
        node.data.providerId = provider.id;
        if (modelChanged || providerChanged || dataChanged) scheduleSave();
    }

    function ensureTarget(plan = {}, { modelId, providerId } = {}) {
        if (state?.isRunStarting) throw new Error('工作流正在启动，请稍后再应用或生成。');
        const node = plan.targetNodeId ? state?.nodes?.get(plan.targetNodeId) : null;
        if (node?.type === 'ImageGenerate') preflightPromptChange(node, plan);
        if ((!node || plan.prompt !== undefined) && (typeof plan.prompt !== 'string' || !plan.prompt.trim())) {
            throw new Error('方案缺少可用的提示词，请先整理生图方案。');
        }
        if (plan.targetNodeId && node?.type !== 'ImageGenerate') {
            throw new Error('目标生图节点已不存在，请重新整理生图方案。');
        }
        if (node && isRunning(node)) throw new Error('目标生图节点正在运行，请等待完成或停止后再应用方案。');
        if (plan.negativePrompt != null && typeof plan.negativePrompt !== 'string') {
            throw new Error('方案的负面提示词无效，请重新整理生图方案。');
        }
        if (!modelId) throw new Error('请先在 Agent 面板选择生图模型，再应用或生成。');
        const model = getAvailablePromptAgentImageModels(state?.models || [], state?.providers || [])
            .find((candidate) => candidate.id === modelId);
        if (!model) throw new Error('所选生图模型已不可用，请在 Agent 面板重新选择或检查模型与 Provider 配置。');
        const provider = resolveAgentProvider(model, state?.providers || [], providerId);
        if (Object.keys(sizeFields(plan.parameters)).length) resolveAgentSize({ protocol: getEffectiveProtocol(model, provider), current: node && readValue(controlDocument, `${node.id}-apiconfig`, node.apiConfigId || '') === model.id ? getContext(node.id)?.parameters : {}, parameters: plan.parameters });
        if (node) {
            configureTarget(node, model, provider);
            return plan;
        }
        const created = createImageNode({ model, provider, prompt: plan.prompt.trim() });
        const nodeId = typeof created === 'string' ? created : created?.id;
        if (!nodeId || state?.nodes?.get(nodeId)?.type !== 'ImageGenerate') {
            throw new Error('无法创建生图节点，请重试。');
        }
        configureTarget(state.nodes.get(nodeId), model, provider);
        return { ...plan, targetNodeId: nodeId };
    }

    function applyPromptPlan(plan = {}) {
        if (state?.isRunStarting) return false;
        const node = state?.nodes?.get(plan.targetNodeId);
        if (node?.type !== 'ImageGenerate' || isRunning(node)) return false;
        if (plan.prompt !== undefined && (typeof plan.prompt !== 'string' || !plan.prompt.trim())) return false;
        const promptSource = preflightPromptChange(node, plan);
        // Validate before any writes, including plans restored from workflows
        // or created before the user changed this node's model.
        let parameters;
        try {
            parameters = normalizePromptAgentParameters(plan.parameters || {}, readPromptAgentParameterSchema(documentRef, node.id, node));
        } catch {
            return false;
        }
        if (plan.negativePrompt != null && typeof plan.negativePrompt !== 'string') return false;
        const sizeContext = getContext(node.id);
        const sizeModel = state.models?.find(model => model.id === (node.apiConfigId || node.data?.apiConfigId));
        const sizeProtocol = getEffectiveProtocol(sizeModel, getResolvedProviderForModel(sizeModel, state.providers, node.providerId));
        if (Object.keys(sizeFields(parameters)).length) resolveAgentSize({ protocol: sizeProtocol, current: sizeContext?.parameters, parameters });
        // Resolve all references before changing any graph or prompt state.
        // An explicit reference list is authoritative; unrelated input ports survive.
        if (Array.isArray(plan.referenceImages)) {
            const sources = [];
            for (const reference of plan.referenceImages) {
                const source = state.nodes.get(reference.sourceNodeId);
                if (!source || source.id === node.id || source.enabled === false || isRunning(source)) {
                    throw new Error('方案参考图来源已删除、禁用或正在运行，请重新选择参考图。');
                }
                const port = reference.sourcePort || 'image';
                if (port !== 'image' || (reference.sourceImageIndex || 0) !== 0) {
                    throw new Error('此参考图不能通过原节点完整输出，请将该图片单独导入后重新选择。');
                }
                if (reference.referenceId && !getSceneReferenceImages().some((item) => item.referenceId === reference.referenceId)) {
                    throw new Error('方案参考图已变化，请重新选择参考图并整理方案。');
                }
                const images = getCanonicalImageList(source);
                const assets = source.type === 'ImageImport' ? getImageImportMediaAssetReferences(source) : (source.data?.mediaAssetKeys || []);
                if (!images.length && !assets.length && !(source.importMode === 'url' && source.imageUrl)) {
                    throw new Error('方案参考图原图不可用，请先恢复图片。');
                }
                if (!reference.referenceId && reference.dataUrl && images.length && source.importMode !== 'url' && reference.dataUrl !== images[0]) {
                    throw new Error('方案参考图内容已变化，请重新选择参考图。');
                }
                if (reference.assetKeys?.length && reference.assetKeys.some((key) => !assets.includes(key))) {
                    throw new Error('方案参考图资产已变化，请重新选择参考图。');
                }
                if (!sources.some((item) => item.nodeId === source.id && item.port === port)) sources.push({ nodeId: source.id, port });
            }
            const isImageInput = (connection) => connection.to.nodeId === node.id
                && (connection.to.port === 'referenceImages' || /^image(?:_\d+)?$/.test(connection.to.port));
            const previous = (state.connections || []).filter(isImageInput);
            if (previous.some((connection) => isRunning(state.nodes.get(connection.from.nodeId)))) {
                throw new Error('参考图输入节点正在运行，暂不能修改连线。');
            }
            const next = projectPlanConnections({ steps: [{ id: node.id, type: 'ImageGenerate' }],
                connections: sources.map((from, order) => ({ from: { ref: from.nodeId, port: from.port }, to: { ref: node.id, port: 'referenceImages' }, type: 'image', order })),
                disconnects: sources.length ? [] : [{ ref: node.id, port: 'referenceImages' }] }, state.connections || [], id => id)
                .map(link => !link.id && !(state.connections || []).includes(link) ? { ...link, id: `c_agent_${globalThis.crypto.randomUUID()}` } : link);
            assertReferenceCompatibility(node, next, sizeModel);
            if (JSON.stringify(state.connections) !== JSON.stringify(next)) commitReferenceConnections(next);
        } else {
            assertReferenceCompatibility(node, state.connections || [], sizeModel);
        }
        plan = { ...plan, parameters };
        node.data ||= {};
        const writeLocalPrompt = !promptSource?.active && plan.prompt !== undefined;
        if (writeLocalPrompt) node.data.prompt = plan.prompt;
        node.data.protocolParams = {
            ...(node.data.protocolParams || {}),
            ...(parameters.protocolParams || {}),
            ...(typeof plan.negativePrompt === 'string' ? { negative_prompt: plan.negativePrompt } : {})
        };
        if (writeLocalPrompt) writeValue(controlDocument, `${node.id}-prompt`, plan.prompt, createEvent);
        if (typeof plan.negativePrompt === 'string') {
            writeValue(controlDocument, `${node.id}-param-negative_prompt`, plan.negativePrompt, createEvent);
        }
        const sizePlan = plan.parameters || {};
        for (const [field, key] of Object.entries({ quality: 'quality', moderation: 'moderation', background: 'background', search: 'search', count: 'generationCount' })) {
            if (sizePlan[field] !== undefined) node.data[key] = sizePlan[field];
        }
        const hasSizeChange = ['aspectRatio', 'resolution', 'customWidth', 'customHeight']
            .some((key) => sizePlan[key] !== undefined && sizePlan[key] !== null);
        if (hasSizeChange) {
            const modelId = readValue(controlDocument, `${node.id}-apiconfig`, node.apiConfigId || '');
            const model = state.models?.find((candidate) => candidate.id === modelId);
            const providerId = readValue(controlDocument, `${node.id}-provider`, node.providerId || '');
            const provider = getResolvedProviderForModel(model, state.providers, providerId);
            const protocol = getEffectiveProtocol(model, provider);
            const currentResolution = readValue(controlDocument, `${node.id}-resolution`, node.data?.resolution || '');
            const requestedResolution = sizePlan.resolution ?? currentResolution;
            const controls = normalizeImageSizeControls({
                resolution: requestedResolution,
                aspect: sizePlan.aspectRatio ?? readValue(controlDocument, `${node.id}-aspect`, node.data?.aspect || ''),
                customWidth: sizePlan.customWidth ?? readValue(controlDocument, `${node.id}-custom-resolution-width`, node.data?.customWidth || ''),
                customHeight: sizePlan.customHeight ?? readValue(controlDocument, `${node.id}-custom-resolution-height`, node.data?.customHeight || '')
            }, protocol);
            Object.assign(node.data, controls);
            writeValue(controlDocument, `${node.id}-resolution`, controls.resolution, createEvent);
            writeValue(controlDocument, `${node.id}-aspect`, controls.aspect, createEvent);
            writeValue(controlDocument, `${node.id}-custom-resolution-width`, controls.customWidth, createEvent);
            writeValue(controlDocument, `${node.id}-custom-resolution-height`, controls.customHeight, createEvent);
        }
        writeValue(controlDocument, `${node.id}-quality`, plan.parameters?.quality, createEvent);
        writeValue(controlDocument, `${node.id}-moderation`, plan.parameters?.moderation, createEvent);
        writeValue(controlDocument, `${node.id}-background`, plan.parameters?.background, createEvent);
        writeBoolean(controlDocument, `${node.id}-search`, plan.parameters?.search, createEvent);
        Object.entries(plan.parameters?.protocolParams || {}).forEach(([paramId, value]) => {
            if (typeof value === 'boolean') writeBoolean(controlDocument, `${node.id}-param-${paramId}`, value, createEvent);
            else writeValue(controlDocument, `${node.id}-param-${paramId}`, value, createEvent);
        });
        writeValue(controlDocument, `${node.id}-generation-count`, plan.parameters?.count, createEvent);
        scheduleSave();
        return true;
    }

    function assertReferenceCompatibility(node, connections, model) {
        if (!model || !getProtocol(getGenerationInputProtocolId(model))) return;
        const reason = validateUniversalImageInputs({ state: { ...state, connections }, node });
        if (reason) throw new Error(reason);
    }

    function getTargetConfiguration(nodeId) {
        const node = state.nodes.get(nodeId);
        if (!node) return null;
        return { modelId: readValue(controlDocument, `${nodeId}-apiconfig`, node.apiConfigId || ''),
            providerId: readValue(controlDocument, `${nodeId}-provider`, node.providerId || '') };
    }
    function getReferenceSnapshot(id) {
        const { groups, slots } = projectImageReferences({ state, targetId: id });
        if (groups.some(group => !group.source || (group.enabled && group.running))) {
            throw new Error('参考图来源已删除、禁用或正在运行。');
        }
        if (slots.some(slot => slot.missing)) throw new Error('参考图原图存在缺失，请恢复完整批次后重试。');
        const references = getContext(id)?.referenceImages || [];
        for (const ref of references) {
            const source=state.nodes.get(ref.sourceNodeId);
            if(!source || source.enabled===false || isRunning(source)) throw new Error('参考图来源已删除、禁用或正在运行。');
        }
        return references;
    }
    return { getReferenceSnapshot, getContext, getSelectedContext, getTargetConfiguration, ensureTarget, applyPromptPlan, getSceneReferenceImages, readSceneReferenceImage, setSceneReferenceDescription };
}
