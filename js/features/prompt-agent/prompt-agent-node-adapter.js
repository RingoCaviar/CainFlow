import { resolveAgentSize, sizeFields } from './prompt-agent-size.js';
import { resolveAgentProvider } from './prompt-agent-provider.js';
import { getEffectiveProtocol, getModelProviders, getModelsForTask, getResolvedProviderForModel } from '../execution/provider-request-utils.js';
import { getModelProtocolConfig } from '../execution/model-protocol-registry.js';
import { normalizeImageSizeControls } from '../execution/image-generation-size.js';
import { normalizePromptAgentParameters, readPromptAgentParameterSchema } from './prompt-agent-parameters.js';
import { getCanonicalImageList, getImageImportMediaAssetReferences } from '../execution/execution-data-utils.js';
import { MAX_REFERENCE_IMAGE_COUNT } from '../../nodes/reference-image-ports.js';

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

function getReferenceImageDescriptor(state, connection) {
    const sourceNode = state.nodes?.get(connection.from?.nodeId);
    const images = [
        ...(Array.isArray(sourceNode?.data?.images) ? sourceNode.data.images : []),
        ...(Array.isArray(sourceNode?.data?.imageList) ? sourceNode.data.imageList : []),
        ...(Array.isArray(sourceNode?.imageDataList) ? sourceNode.imageDataList : []),
        ...(Array.isArray(sourceNode?.generatedImages) ? sourceNode.generatedImages : []),
        sourceNode?.data?.image,
        sourceNode?.imageData,
        sourceNode?.resizePreviewData
    ].filter((value, index, values) => typeof value === 'string' && value && values.indexOf(value) === index);
    const assetKeys = [
        ...(Array.isArray(sourceNode?.data?.mediaAssetKeys) ? sourceNode.data.mediaAssetKeys : []),
        sourceNode?.data?.imageImportAssetKey,
        sourceNode?.data?.imageAssetKey
    ].filter((value, index, values) => typeof value === 'string' && value && values.indexOf(value) === index);
    return {
        sourceNodeId: connection.from?.nodeId || '',
        sourcePort: connection.from?.port || '',
        targetPort: connection.to.port,
        assetKeys,
        images
    };
}

export function createPromptAgentNodeAdapter({
    state,
    documentRef = document,
    scheduleSave = () => {},
    commitReferenceConnections = (connections) => { state.connections = connections; },
    createImageNode = () => null,
    getNodeImages = async (node) => getCanonicalImageList(node),
    resolveImageSource = async (source) => source,
    createEvent = (type) => new Event(type, { bubbles: true })
} = {}) {
    function getSceneReferenceImages() {
        const references = [];
        let importIndex = 0;
        for (const node of state?.nodes?.values() || []) {
            if (node.type !== 'ImageImport') continue;
            importIndex += 1;
            const mode = readValue(documentRef, `${node.id}-import-mode`, node.importMode || 'upload');
            const url = readValue(documentRef, `${node.id}-url-input`, node.imageUrl || '');
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
        const mode = readValue(documentRef, `${node.id}-import-mode`, node.importMode || 'upload');
        const images = mode === 'url'
            ? [readValue(documentRef, `${node.id}-url-input`, node.imageUrl || '')]
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
            name: reference.name, dataUrl, type: dataUrl.slice(5, dataUrl.indexOf(';'))
        };
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
        const referenceImages = (state.connections || [])
            .filter((connection) => connection?.to?.nodeId === node.id && /^(?:referenceImages|image|image_\d+)$/.test(connection?.to?.port || ''))
            .map((connection) => getReferenceImageDescriptor(state, connection));
        const protocolParams = { ...(node.data?.protocolParams || {}) };
        const modelId = readValue(documentRef, `${node.id}-apiconfig`, node.apiConfigId || '');
        const model = state.models?.find((candidate) => candidate.id === modelId);
        const output = getReferenceImageDescriptor(state, { from: { nodeId: node.id, port: 'image' }, to: { port: '' } });
        return {
            nodeId: node.id,
            prompt: readValue(documentRef, `${node.id}-prompt`, node.data?.prompt || ''),
            negativePrompt: readValue(documentRef, `${node.id}-param-negative_prompt`, protocolParams.negative_prompt || node.data?.promptAgentNegativePrompt || ''),
            parameterSchema: readPromptAgentParameterSchema(documentRef, node.id),
            model: model ? { modelId: model.modelId, protocol: model.protocol } : null,
            parameters: {
                aspectRatio: readValue(documentRef, `${node.id}-aspect`, node.data?.aspect || ''),
                resolution: readValue(documentRef, `${node.id}-resolution`, node.data?.resolution || ''),
                customWidth: readValue(documentRef, `${node.id}-custom-resolution-width`, node.data?.customWidth || ''),
                customHeight: readValue(documentRef, `${node.id}-custom-resolution-height`, node.data?.customHeight || ''),
                quality: readValue(documentRef, `${node.id}-quality`, node.data?.quality || ''),
                moderation: readValue(documentRef, `${node.id}-moderation`, node.data?.moderation || ''),
                background: readValue(documentRef, `${node.id}-background`, node.data?.background || ''),
                search: readBoolean(documentRef, `${node.id}-search`, node.data?.search),
                count: Math.max(1, parseInt(readValue(documentRef, `${node.id}-generation-count`, node.data?.generationCount || '1'), 10) || 1),
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

    function configureTarget(node, model, provider) {
        const modelChanged = readValue(documentRef, `${node.id}-apiconfig`, node.apiConfigId || '') !== model.id
            || (node.apiConfigId && node.apiConfigId !== model.id);
        const providerChanged = readValue(documentRef, `${node.id}-provider`, node.providerId || '') !== provider.id;
        const dataChanged = node.apiConfigId !== model.id || node.providerId !== provider.id;
        // The normal node change handlers rebuild protocol controls before the
        // plan is validated against the selected model's actual parameters.
        if (modelChanged) writeValue(documentRef, `${node.id}-apiconfig`, model.id, createEvent);
        if (modelChanged || providerChanged) writeValue(documentRef, `${node.id}-provider`, provider.id, createEvent);
        node.apiConfigId = model.id;
        node.providerId = provider.id;
        node.data ||= {};
        node.data.apiConfigId = model.id;
        node.data.providerId = provider.id;
        if (modelChanged || providerChanged || dataChanged) scheduleSave();
    }

    function ensureTarget(plan = {}, { modelId, providerId } = {}) {
        if (state?.isRunStarting) throw new Error('工作流正在启动，请稍后再应用或生成。');
        if (typeof plan.prompt !== 'string' || !plan.prompt.trim()) {
            throw new Error('方案缺少可用的提示词，请先整理生图方案。');
        }
        const node = plan.targetNodeId ? state?.nodes?.get(plan.targetNodeId) : null;
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
        if (Object.keys(sizeFields(plan.parameters)).length) resolveAgentSize({ protocol: getEffectiveProtocol(model, provider), current: node && readValue(documentRef, `${node.id}-apiconfig`, node.apiConfigId || '') === model.id ? getContext(node.id)?.parameters : {}, parameters: plan.parameters });
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
        if (typeof plan.prompt !== 'string' || !plan.prompt.trim()) return false;
        // Validate before any writes, including plans restored from workflows
        // or created before the user changed this node's model.
        let parameters;
        try {
            parameters = normalizePromptAgentParameters(plan.parameters || {}, readPromptAgentParameterSchema(documentRef, node.id));
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
            if (sources.length > MAX_REFERENCE_IMAGE_COUNT) throw new Error(`参考图最多支持 ${MAX_REFERENCE_IMAGE_COUNT} 张。`);
            const isImageInput = (connection) => connection.to.nodeId === node.id
                && (connection.to.port === 'referenceImages' || /^image(?:_\d+)?$/.test(connection.to.port));
            const previous = (state.connections || []).filter(isImageInput);
            if (previous.some((connection) => isRunning(state.nodes.get(connection.from.nodeId)))) {
                throw new Error('参考图输入节点正在运行，暂不能修改连线。');
            }
            const next = sources.map((from, order) => ({
                id: previous.find((connection) => connection.from.nodeId === from.nodeId && connection.from.port === from.port)?.id
                    || `c_agent_${globalThis.crypto.randomUUID()}`,
                from, to: { nodeId: node.id, port: 'referenceImages' }, type: 'image', order
            }));
            if (JSON.stringify(previous) !== JSON.stringify(next)) {
                commitReferenceConnections([...(state.connections || []).filter((connection) => !isImageInput(connection)), ...next]);
            }
        }
        plan = { ...plan, parameters };
        node.data ||= {};
        node.data.prompt = String(plan.prompt || '');
        node.data.protocolParams = {
            ...(node.data.protocolParams || {}),
            ...(parameters.protocolParams || {}),
            ...(typeof plan.negativePrompt === 'string' ? { negative_prompt: plan.negativePrompt } : {})
        };
        writeValue(documentRef, `${node.id}-prompt`, plan.prompt || '', createEvent);
        if (typeof plan.negativePrompt === 'string') {
            writeValue(documentRef, `${node.id}-param-negative_prompt`, plan.negativePrompt, createEvent);
        }
        const sizePlan = plan.parameters || {};
        const hasSizeChange = ['aspectRatio', 'resolution', 'customWidth', 'customHeight']
            .some((key) => sizePlan[key] !== undefined && sizePlan[key] !== null);
        if (hasSizeChange) {
            const modelId = readValue(documentRef, `${node.id}-apiconfig`, node.apiConfigId || '');
            const model = state.models?.find((candidate) => candidate.id === modelId);
            const providerId = readValue(documentRef, `${node.id}-provider`, node.providerId || '');
            const provider = getResolvedProviderForModel(model, state.providers, providerId);
            const protocol = getEffectiveProtocol(model, provider);
            const currentResolution = readValue(documentRef, `${node.id}-resolution`, node.data?.resolution || '');
            const requestedResolution = sizePlan.resolution ?? currentResolution;
            const controls = normalizeImageSizeControls({
                resolution: requestedResolution,
                aspect: sizePlan.aspectRatio ?? readValue(documentRef, `${node.id}-aspect`, node.data?.aspect || ''),
                customWidth: sizePlan.customWidth ?? readValue(documentRef, `${node.id}-custom-resolution-width`, node.data?.customWidth || ''),
                customHeight: sizePlan.customHeight ?? readValue(documentRef, `${node.id}-custom-resolution-height`, node.data?.customHeight || '')
            }, protocol);
            writeValue(documentRef, `${node.id}-resolution`, controls.resolution, createEvent);
            writeValue(documentRef, `${node.id}-aspect`, controls.aspect, createEvent);
            writeValue(documentRef, `${node.id}-custom-resolution-width`, controls.customWidth, createEvent);
            writeValue(documentRef, `${node.id}-custom-resolution-height`, controls.customHeight, createEvent);
        }
        writeValue(documentRef, `${node.id}-quality`, plan.parameters?.quality, createEvent);
        writeValue(documentRef, `${node.id}-moderation`, plan.parameters?.moderation, createEvent);
        writeValue(documentRef, `${node.id}-background`, plan.parameters?.background, createEvent);
        writeBoolean(documentRef, `${node.id}-search`, plan.parameters?.search, createEvent);
        Object.entries(plan.parameters?.protocolParams || {}).forEach(([paramId, value]) => {
            if (typeof value === 'boolean') writeBoolean(documentRef, `${node.id}-param-${paramId}`, value, createEvent);
            else writeValue(documentRef, `${node.id}-param-${paramId}`, value, createEvent);
        });
        writeValue(documentRef, `${node.id}-generation-count`, plan.parameters?.count, createEvent);
        scheduleSave();
        return true;
    }

    function getTargetConfiguration(nodeId) {
        const node = state.nodes.get(nodeId);
        if (!node) return null;
        return { modelId: readValue(documentRef, `${nodeId}-apiconfig`, node.apiConfigId || ''),
            providerId: readValue(documentRef, `${nodeId}-provider`, node.providerId || '') };
    }
    return { getContext, getSelectedContext, getTargetConfiguration, ensureTarget, applyPromptPlan, getSceneReferenceImages, readSceneReferenceImage };
}
