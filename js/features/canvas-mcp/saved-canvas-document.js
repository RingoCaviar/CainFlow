import { getNodeDefinition } from '../../nodes/registry.js';
import { readImageGenerationSettings } from '../../nodes/image-generation-settings.js';
import { createCanvasContext } from '../prompt-agent/prompt-agent-canvas-context.js';
import { createPrepareApplyPrompt, isPromptLibraryWrite, validatePromptLibraryWrite } from '../prompt-agent/prompt-agent-apply-library-prompt.js';
import { getAvailablePromptAgentImageModels } from '../prompt-agent/prompt-agent-node-adapter.js';
import { imageParameterCapabilities } from '../prompt-agent/prompt-agent-model.js';
import { resolveAgentParameterPatch } from '../prompt-agent/prompt-agent-parameters.js';
import { resolveDraftImageSize } from '../prompt-agent/prompt-agent-size.js';
import { projectPlanConnections } from '../prompt-agent/prompt-agent-reference-inputs.js';
import { getImageAspectOptionsForProtocol, getImageResolutionOptionsForProtocol } from '../execution/image-generation-size.js';
import { getEffectiveProtocol, getModelProviders } from '../execution/provider-request-utils.js';
import { normalizeVisualStyle } from '../visual-style/visual-style.js';
import { normalizeCommerceImageSetState, updateCommerceImageSetCopyLanguage, updateCommerceProductInfoField } from '../ecommerce-image-set/commerce-image-set-plan.js';
import { createCanvasMcpActions } from './canvas-mcp-actions.js';
import { createCainflowAppActions, resolveCanvasRunInput } from './cainflow-app-actions.js';
import { createHistoryCanvasImporter } from './canvas-history-import.js';

function configuredImages(models, providers) {
    return getAvailablePromptAgentImageModels(models, providers).map(model => ({
        id: model.id, name: model.name, modelId: model.modelId,
        providers: getModelProviders(model, providers)
            .filter(provider => String(provider.endpoint || '').trim() && String(provider.apikey || '').trim())
            .map(provider => {
                const protocol = getEffectiveProtocol(model, provider);
                const { parameters: { count, ...parameters }, maxReferences } = imageParameterCapabilities(model, provider);
                return {
                    id: provider.id, name: provider.name, maxReferences,
                    parameters: {
                        ...parameters, generationCount: count,
                        aspect: { type: 'string', enum: getImageAspectOptionsForProtocol(protocol, model.modelId).map(option => option.value) },
                        resolution: { type: 'string', enum: getImageResolutionOptionsForProtocol(protocol, model.modelId).map(option => option.value) }
                    }
                };
            })
    })).filter(model => model.providers.length);
}

function assertAcyclic(connections, touched) {
    const parents = new Map();
    for (const { from, to } of connections) {
        if (!parents.has(to.nodeId)) parents.set(to.nodeId, []);
        parents.get(to.nodeId).push(from.nodeId);
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = id => {
        if (visiting.has(id)) throw new Error('方案与已有画布形成循环依赖');
        if (visited.has(id)) return;
        visiting.add(id);
        for (const parent of parents.get(id) || []) visit(parent);
        visiting.delete(id);
        visited.add(id);
    };
    for (const id of touched) visit(id);
}

function newNode(step, id, index) {
    const definition = getNodeDefinition(step.type);
    return {
        id, type: step.type, customTitle: step.title, enabled: true,
        x: 80 + (index % 5) * 360, y: 80 + Math.floor(index / 5) * 360,
        width: definition.defaultWidth, height: definition.defaultHeight
    };
}

function applyImageParameters(node, parameters, plan, step, models, providers) {
    const modelId = plan.modelOverrides?.[step.id] || (node.apiConfigId ?? node.data?.apiConfigId);
    const model = models.find(item => item.id === modelId);
    const providerId = plan.providerOverrides?.[step.id]?.[modelId] || (node.providerId ?? node.data?.providerId);
    const provider = model && getModelProviders(model, providers).find(item => item.id === providerId);
    const { aspect, generationCount, prompt, resolution, customWidth, customHeight, ...other } = parameters;
    const hasSettings = Object.keys(parameters).length || plan.modelOverrides?.[step.id];
    if (!hasSettings) return;
    if (!model || !provider) throw new Error('生图节点需要已配置的模型和供应商');
    const capabilities = imageParameterCapabilities(model, provider);
    if (plan.imageBatch && capabilities.maxReferences === 0) throw new Error('当前生图模型不支持参考图输入');
    const fields = { ...other, ...(generationCount === undefined ? {} : { count: generationCount }) };
    const sources = Object.fromEntries([...Object.keys(fields), ...Object.keys(fields.protocolParams || {}).map(key => `protocolParams.${key}`)]
        .map(key => [key, '本轮设置']));
    const current = readImageGenerationSettings({ ...node, data: { ...node.data, ...node } });
    const validated = resolveAgentParameterPatch(fields, sources, capabilities.parameters, {}, current);
    const { count, protocolParams, ...settings } = validated;
    Object.assign(node, settings, { apiConfigId: modelId, providerId });
    if (prompt !== undefined) node.prompt = prompt;
    if (count !== undefined) node.generationCount = count;
    const size = Object.fromEntries(Object.entries({ aspectRatio: aspect, resolution, customWidth, customHeight })
        .filter(([, value]) => value !== undefined));
    if (Object.keys(size).length) {
        const { patch } = resolveDraftImageSize({
            protocol: getEffectiveProtocol(model, provider), modelId: model.modelId,
            current: { ...current, aspectRatio: current.aspect }, parameters: size,
            sources: Object.fromEntries(Object.keys(size).map(key => [key, '本轮设置']))
        });
        const { aspectRatio, ...dimensions } = patch;
        Object.assign(node, dimensions);
        if (aspectRatio !== undefined) node.aspect = aspectRatio;
    }
    if (protocolParams) node.protocolParams = { ...(node.protocolParams ?? node.data?.protocolParams), ...protocolParams };
}

export function createSavedCanvasDocument({ document = { nodes: [], connections: [] }, revision, models = [], providers = [],
    runningIds = [], rpc }) {
    let updatedDocument = null;
    const context = () => createCanvasContext({
        workflowId: document.workflowId,
        nodes: document.nodes.map(node => ({ ...node.data, ...node })),
        connections: document.connections,
        runningIds,
        getGenerationContext(id) {
            const node = document.nodes.find(item => item.id === id);
            const model = models.find(item => item.id === (node.apiConfigId ?? node.data?.apiConfigId));
            const provider = model && getModelProviders(model, providers).find(item => item.id === (node.providerId ?? node.data?.providerId));
            if (!model || !provider) return null;
            const protocol = getEffectiveProtocol(model, provider);
            return {
                parameterSchema: {
                    ...imageParameterCapabilities(model, provider).parameters,
                    aspectRatio: { enum: getImageAspectOptionsForProtocol(protocol, model.modelId).map(option => option.value) },
                    resolution: { enum: getImageResolutionOptionsForProtocol(protocol, model.modelId).map(option => option.value) }
                },
                parameters: { protocolParams: node.protocolParams ?? node.data?.protocolParams }
            };
        }
    });
    const getImageModels = () => configuredImages(models, providers);
    const canvasAdapter = {
        context,
        async apply(plan, _model, _onChange, isCurrent, { stagedImports = new Map() } = {}) {
            if (!isCurrent()) throw new Error('工作流版本已变化');
            const before = context();
            const next = structuredClone(document);
            const deleted = new Set(plan.deletes.map(item => item.nodeId));
            const bindings = Object.fromEntries(plan.steps.map(step => [
                step.id, step.nodeId || stagedImports.get(step.id)?.nodeId || `node_${crypto.randomUUID()}`
            ]));
            const positions = new Map(next.nodes.map(node => [node.id, node]));
            for (const [index, step] of plan.steps.entries()) {
                const id = bindings[step.id];
                const node = positions.get(id) || newNode(step, id, next.nodes.length + index);
                if (!step.nodeId) next.nodes.push(node);
                const parameters = step.parameters;
                if (isPromptLibraryWrite(plan, step)) {
                    const { control, content } = validatePromptLibraryWrite(plan, step, before);
                    if (control === 'param-systemPrompt') {
                        node.protocolParams = { ...(node.protocolParams ?? node.data?.protocolParams), systemPrompt: content };
                    } else {
                        node[control] = content;
                        if (control === 'prompt' && node.type === 'ImageGenerate') {
                            node.protocolParams = { ...(node.protocolParams ?? node.data?.protocolParams) };
                            delete node.protocolParams.prompt;
                        }
                    }
                } else if (step.type === 'ImageGenerate') {
                    applyImageParameters(node, parameters, plan, step, models, providers);
                } else if (step.type === 'VisualStyle') {
                    const { styleDetailLevel, ...style } = parameters;
                    if (styleDetailLevel !== undefined) node.styleDetailLevel = styleDetailLevel;
                    const base = Object.keys(style).length === 1 && Object.hasOwn(style, 'description') ? {}
                        : Object.hasOwn(style, 'preset') ? normalizeVisualStyle({ preset: style.preset }) : node.visualStyle ?? node.data?.visualStyle;
                    node.visualStyle = normalizeVisualStyle({ ...base, ...style });
                } else if (step.type === 'ECommerceImageSet') {
                    node.commerceImageSet = normalizeCommerceImageSetState(node.commerceImageSet ?? node.data?.commerceImageSet);
                    if (Object.hasOwn(parameters, 'copyLanguage')) updateCommerceImageSetCopyLanguage(node.commerceImageSet, parameters.copyLanguage);
                    for (const [field, value] of Object.entries(parameters.productInfo || {})) {
                        updateCommerceProductInfoField(node.commerceImageSet, field, value);
                    }
                } else {
                    Object.assign(node, parameters);
                }
                if (step.patch) {
                    const { title, ...patch } = step.patch;
                    Object.assign(node, patch);
                    if (title !== undefined) node.customTitle = title;
                }
                if (step.assetKey) {
                    if (step.nodeId || step.type !== 'ImageImport') throw new Error('素材键只能用于新建图片导入节点');
                    const staged = stagedImports.get(step.id);
                    if (!staged && !await rpc('hasMedia', { assetKey: step.assetKey })) throw new Error('本地原图已不可用');
                    Object.assign(node, {
                        importMode: 'upload', imageImportAssetKey: step.assetKey, mediaAssetKeys: [step.assetKey],
                        imageAssetReady: true, imageCount: 1
                    });
                    if (staged) {
                        node.agentReferenceSource = { historyId: staged.id, historyVersion: staged.fileVersion, assetKey: step.assetKey };
                    }
                }
            }
            next.nodes = next.nodes.filter(node => !deleted.has(node.id));
            const identity = ref => Object.hasOwn(bindings, ref) ? bindings[ref] : ref;
            const connections = projectPlanConnections(plan, next.connections, identity);
            assertAcyclic(connections, Object.values(bindings));
            next.connections = connections.map(link => ({ ...link, id: link.id || `conn_${crypto.randomUUID()}` }));
            document = next;
            updatedDocument = next;
            return { bindings, steps: plan.steps };
        }
    };

    const promptLibrary = () => ({ getPrompt: args => rpc('getPrompt', args) });
    const appActions = createCainflowAppActions({
        promptLibrary,
        prepareApplyPrompt: createPrepareApplyPrompt({ promptLibrary }),
        applyCanvasPlan: (plan, isCurrent) => canvasAdapter.apply(plan, '', undefined, isCurrent),
        importHistory: createHistoryCanvasImporter({
            canvasAdapter, listHistoryImages: args => rpc('listHistory', args),
            getHistoryImageBlob: async (id, { fileVersion }) => {
                const data = await rpc('historyMedia', { id, fileVersion });
                return new Blob([Buffer.from(data.body, 'base64')], { type: data.mimeType });
            },
            saveWorkflowNodeMediaAsset: async (blob, _workflowId, nodeId) => {
                const dataUrl = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
                const staged = await rpc('stageMedia', { nodeId, dataUrl });
                return { asset_key: staged.assetKeys[0], mediaTemporaryOwnerId: staged.ownerId };
            },
            // Publication and rollback are coordinated by the server after the document returns.
            cancelWorkflowNodeMediaOperation: async () => {}
        })
    });

    const actions = createCanvasMcpActions({
        canvasAdapter, getSavedRevision: () => revision, getImageModels, appActions,
        getImageDefaults: () => {
            const available = getImageModels();
            const model = available.find(item => item.providers.length === 1);
            return model ? { modelId: model.id, providerIds: { [model.id]: model.providers[0].id } } : {};
        }
    });
    return {
        async dispatch(method, args) {
            if (method === 'validate_run') return { result: { input: resolveCanvasRunInput(context(), args) } };
            const result = await actions.dispatch(method, args);
            return { result, ...(updatedDocument ? { document: updatedDocument } : {}) };
        }
    };
}
