import { VISUAL_STYLE_FIELDS, VISUAL_STYLE_PRESETS, VISUAL_STYLE_DETAIL_LEVELS, normalizeVisualStyleDetailLevel, normalizeVisualStyle } from '../visual-style/visual-style.js';
import { agentNodeDefinition as getNodeDefinition } from './prompt-agent-reference-inputs.js';
import { publicImageProtocolFields } from './prompt-agent-parameters.js';
import { listNodeDefinitions } from '../../nodes/registry.js';
import { getDynamicNodePorts } from '../../nodes/node-view-factory.js';
import { DOUBAO_VIDEO_RATIO_OPTIONS } from '../execution/provider-request-utils.js';
import { hasCommerceReferenceChange, needsCommerceReferenceVerification, projectCommerceReferences } from '../ecommerce-image-set/commerce-reference-revision.js';
import {
    COMMERCE_IMAGE_SET_COPY_LANGUAGES, getCommerceProductInfo, getRunnableCommerceImageSetShots,
    isCommerceShotFinalized, normalizeCommerceImageSetCopyLanguage, normalizeCommerceImageSetState
} from '../ecommerce-image-set/commerce-image-set-plan.js';

const colorAdjustment = { type: 'integer', min: -100, max: 100 };
export const CANVAS_SCALAR_RULES = Object.freeze({
    VisualStyle: { styleDetailLevel: { enum: Object.keys(VISUAL_STYLE_DETAIL_LEVELS) }, preset: { enum: Object.keys(VISUAL_STYLE_PRESETS) }, ...Object.fromEntries(Object.keys(VISUAL_STYLE_FIELDS).map(key => [key, { type: 'string' }])) },
    TextChat: { prompt: { type: 'string' }, sysprompt: { type: 'string' }, fixed: { type: 'boolean' } },
    VideoGenerate: { prompt: { type: 'string' }, aspect: { enum: DOUBAO_VIDEO_RATIO_OPTIONS.map(option => option.value) },
        generationCount: { type: 'integer', min: 1 } },
    ColorReset: { whiteBalanceMode: { enum: ['original', 'auto'] }, temperature: colorAdjustment, tint: colorAdjustment,
        vibrance: colorAdjustment, saturation: colorAdjustment },
    ECommerceImageSet: { copyLanguage: { enum: Object.keys(COMMERCE_IMAGE_SET_COPY_LANGUAGES) } },
    TextSplit: { previewEnabled: { type: 'boolean' } }
});

export const CANVAS_FIELDS = Object.freeze({
    ImageImport: [], ImageGenerate: ['prompt', 'aspect', 'resolution', 'customWidth', 'customHeight', 'quality', 'moderation', 'background', 'generationCount', 'search', 'protocolParams'],
    ImageResize: ['resizeMode', 'scalePercent', 'targetWidth', 'targetHeight', 'keepAspect', 'quality'],
    ImageMerge: ['inputCount'], ImagePreview: [], ImageCompare: [], Text: ['text'],
    ...Object.fromEntries(Object.entries(CANVAS_SCALAR_RULES).map(([type, fields]) => [type, Object.keys(fields)])),
    ECommerceImageSet: ['productInfo', ...Object.keys(CANVAS_SCALAR_RULES.ECommerceImageSet)]
});
export const CANVAS_TYPES = Object.keys(CANVAS_FIELDS);
export const CANVAS_CREATABLE_TYPES = listNodeDefinitions().map(node => node.type);
export const CANVAS_NODE_PATCH_FIELDS = Object.freeze(['title', 'x', 'y', 'enabled']);
export const cloneCanvasValue = value => JSON.parse(JSON.stringify(value));
const isParameterValue = value => ['string', 'number', 'boolean'].includes(typeof value);
const generationAliases = { aspect: 'aspectRatio', generationCount: 'count' };

// Explicit field projection: never serialize providers, arbitrary node data or URLs.
export function projectCanvasNode(node, running = false) {
    const definition = getNodeDefinition(node.type);
    const fields = Object.hasOwn(CANVAS_FIELDS, node.type) ? CANVAS_FIELDS[node.type] : ['prompt', 'text'];
    const readableFields = node.type === 'TextSplit' ? [...fields, 'text'] : fields;
    const parameters = Object.fromEntries(readableFields.filter(key =>
        isParameterValue(node[key])).map(key => [key, node[key]]));
    if (node.type === 'VisualStyle') {
        const { version, ...style } = normalizeVisualStyle(node.visualStyle ?? node.data?.visualStyle);
        Object.assign(parameters, style, { styleDetailLevel: normalizeVisualStyleDetailLevel(node.styleDetailLevel ?? node.data?.styleDetailLevel) });
    }
    if (node.type === 'ECommerceImageSet') {
        parameters.copyLanguage = normalizeCommerceImageSetCopyLanguage(node.commerceImageSet?.copyLanguage);
        const productInfo = Object.fromEntries(Object.entries(getCommerceProductInfo(node.commerceImageSet))
            .filter(([, value]) => value.length));
        if (Object.keys(productInfo).length) parameters.productInfo = productInfo;
    }
    // URL mode may retain old upload keys for switching back, but those are not its current output.
    const assetKeys = node.type === 'ImageImport' && node.importMode === 'url' ? []
        : node.mediaAssetKeys?.length ? node.mediaAssetKeys : [node.imageImportAssetKey, node.imageAssetKey];
    return {
        id: node.id, type: node.type, name: node.customTitle || definition?.title || node.type,
        position: { x: Number(node.x) || 0, y: Number(node.y) || 0, width: Number(node.width) || definition?.defaultWidth || 0, height: Number(node.height) || definition?.defaultHeight || 0 },
        enabled: node.enabled !== false, running, editable: CANVAS_TYPES.includes(node.type) && node.isClone !== true,
        patchable: definition?.type === node.type && node.isClone !== true, parameters,
        ...(node.type === 'ImageImport' && node.data?.imageDescription ? { imageDescription: String(node.data.imageDescription).slice(0, 2000) } : {}),
        ...(node.type === 'TextChat' && node.isClone !== true ? { supportsSystemPrompt: true } : {}),
        inputs: getDynamicNodePorts(node.type, 'inputs', node) || definition?.inputs || [],
        outputs: getDynamicNodePorts(node.type, 'outputs', node) || definition?.outputs || [],
        assets: (node.mediaAssetKeys?.length ? assetKeys : [...new Set(assetKeys)])
            .filter(key => typeof key === 'string' && key.startsWith('media:')),
        ...(Number.isSafeInteger(node.imageCount) && node.imageCount > 0 ? { imageCount: node.imageCount } : {}),
        thinking: node.thinking ? cloneCanvasValue(node.thinking) : null,
        providerId: node.providerId || null,
        missing: node.mediaIntegrity?.state === 'missing', modelId: node.apiConfigId || null
    };
}

export function createCanvasContext({ workflowId, nodes, connections, selectedIds = [], mentionedIds = [], runningIds = [], getGenerationContext = null,
    getVideoAspects = null }) {
    const runningNodeIds = new Set(runningIds);
    const commerceWithReferences = nodes.filter(node => {
        if (node.type !== 'ECommerceImageSet') return false;
        const settings = node.commerceImageSet ?? node.data?.commerceImageSet;
        return settings?.plan?.sourceKey || (!settings?.plan && settings?.previousExportResults?.some(row => row?.referenceRevision));
    });
    const unavailableCommerceOutputs = new Set();
    if (commerceWithReferences.length) {
        // The shared reference projection accepts live nodes. Serialized snapshots keep media fields at the top level.
        const referenceState = { connections, runningNodeIds, nodes: new Map(nodes.map(node => [node.id, { ...node, data: {
            ...node.data, mediaAssetKeys: node.mediaAssetKeys ?? node.data?.mediaAssetKeys,
            imageAssetKey: node.imageAssetKey ?? node.data?.imageAssetKey,
            imageCount: node.imageCount ?? node.data?.imageCount, mediaIntegrity: node.mediaIntegrity ?? node.data?.mediaIntegrity
        } }])) };
        for (const node of commerceWithReferences) {
            const settings = node.commerceImageSet ?? node.data.commerceImageSet;
            const references = projectCommerceReferences(referenceState, node.id);
            if (hasCommerceReferenceChange(settings, references) || needsCommerceReferenceVerification(settings, references)) {
                unavailableCommerceOutputs.add(node.id);
            }
        }
    }
    const projected = nodes.map(node => {
        const output = projectCanvasNode(node, runningNodeIds.has(node.id));
        if (unavailableCommerceOutputs.has(node.id)) {
            output.assets = [];
            delete output.imageCount;
        }
        return output;
    });
    const commerceRunSettings = nodes.flatMap(node => {
        if (node.type !== 'ECommerceImageSet') return [];
        const settings = normalizeCommerceImageSetState(node.commerceImageSet ?? node.data?.commerceImageSet);
        const candidateCount = settings.candidateCount ?? 1;
        const finalizedShotIds = getRunnableCommerceImageSetShots(settings)
            .filter(shot => shot.source === 'generate' && isCommerceShotFinalized(settings, shot.id))
            .map(shot => shot.id);
        if (settings.shotReferences || settings.styleReferenceTypes) {
            return [[node.id, candidateCount, finalizedShotIds, settings.shotReferences || {}, settings.styleReferenceTypes || {}]];
        }
        return candidateCount > 1 || finalizedShotIds.length ? [[node.id, candidateCount, finalizedShotIds]] : [];
    });
    const links = connections.map(link => ({ id: link.id, ...(Number.isInteger(link.order)?{order:link.order}:{}), from: { nodeId: link.from?.nodeId, port: link.from?.port }, to: { nodeId: link.to?.nodeId, port: link.to?.port } }));
    for (const node of projected) {
        const fields = CANVAS_SCALAR_RULES[node.type];
        const options = Object.fromEntries(Object.entries(fields || {}).filter(([, rule]) => rule.enum)
            .map(([field, rule]) => [field, rule.enum]));
        if (node.type === 'VideoGenerate') {
            const aspects = getVideoAspects?.(node.id);
            if (aspects?.length) options.aspect = aspects;
        }
        if (Object.keys(options).length) node.parameterOptions = options;
    }
    for (const node of projected.filter(node => node.type === 'ImageGenerate')) {
        const actual = getGenerationContext?.(node.id);
        const protocolSchema = actual?.parameterSchema?.protocolParams?.properties || {};
        if (protocolSchema.systemPrompt?.type === 'string') node.supportsSystemPrompt = true;
        const protocolParams = Object.fromEntries(Object.entries(actual?.parameters?.protocolParams || {}).filter(([key, value]) =>
            publicImageProtocolFields.has(key) && Object.hasOwn(protocolSchema, key) && isParameterValue(value)));
        if (Object.keys(protocolParams).length) node.parameters.protocolParams = protocolParams;
        if (actual?.parameterSchema) {
            const options = CANVAS_FIELDS.ImageGenerate.flatMap(key => {
                const definition = actual.parameterSchema[generationAliases[key] || key];
                return definition?.enum ? [[key, definition.enum]] : [];
            });
            for (const [key, definition] of Object.entries(protocolSchema)) {
                if (publicImageProtocolFields.has(key) && definition.enum) options.push([`protocolParams.${key}`, definition.enum]);
            }
            if (options.length) node.parameterOptions = Object.fromEntries(options);
        }
        const input = links.filter(link => link.to.nodeId === node.id && link.to.port === 'prompt').at(-1);
        const source = projected.find(candidate => candidate.id === input?.from.nodeId);
        const text = source?.enabled && !source.running ? String(source.parameters.text || '') : '';
        node.effectivePrompt = actual?.prompt ?? (text.trim() ? text : node.parameters.prompt || '');
        node.promptSource = actual?.promptSource ?? (input ? { nodeId: input.from.nodeId, port: input.from.port,
            type: source?.type || '', name: source?.name || input.from.nodeId, text, connected: true, active: Boolean(text.trim()),
            editable: source?.type === 'Text' && source.editable && source.enabled && !source.running } : null);
    }
    const read = ({ offset = 0, nodeIds = [], connectionOffset = 0, textOffset = 0, assetOffset = 0 } = {}) => {
        if (![offset, connectionOffset, textOffset, assetOffset].every(value => Number.isInteger(value) && value >= 0) || !Array.isArray(nodeIds)) throw new Error('画布读取参数无效');
        const candidates = nodeIds.length ? projected.filter(node => nodeIds.includes(node.id)) : projected;
        const page = []; let size = 0;
        for (const node of candidates.slice(offset, offset + 40)) {
            const safe = cloneCanvasValue(node);
            safe.assetCount = safe.assets.length;
            safe.assets = safe.assets.slice(assetOffset, assetOffset + 50);
            safe.nextAssetOffset = assetOffset + 50 < safe.assetCount ? assetOffset + 50 : null;
            const fields = [
                ...Object.keys(safe.parameters).map(key => [safe.parameters, key, key]),
                ...Object.keys(safe.parameters.protocolParams || {}).map(key => [safe.parameters.protocolParams, key, `protocolParams.${key}`]),
                ...Object.keys(safe.parameters.productInfo || {}).map(key => [safe.parameters.productInfo, key, `productInfo.${key}`]),
                [safe, 'effectivePrompt', 'effectivePrompt'], [safe.promptSource, 'text', 'promptSource.text']
            ];
            for (const [owner, key, name] of fields) {
                const value = owner?.[key];
                if (typeof value !== 'string' || value.length <= 2000) continue;
                owner[key] = value.slice(textOffset, textOffset + 2000); safe.parameterTextOmitted = true;
                (safe.parameterTextRanges ||= {})[name] = { offset: textOffset, total: value.length, nextOffset: textOffset + 2000 < value.length ? textOffset + 2000 : null };
            }
            const textSize = JSON.stringify(safe).length;
            if (page.length && size + textSize > 14000) break;
            page.push(safe); size += textSize;
        }
        const ids = new Set(page.map(node => node.id));
        const related = links.filter(link => ids.has(link.from.nodeId) || ids.has(link.to.nodeId));
        return { nodes: page, connections: related.slice(connectionOffset, connectionOffset + 120), connectionsOmitted: Math.max(0, related.length - connectionOffset - 120),
            nextConnectionOffset: connectionOffset + 120 < related.length ? connectionOffset + 120 : null,
            missingIds: nodeIds.filter(id => !projected.some(node => node.id === id)),
            total: candidates.length, nextOffset: offset + page.length < candidates.length ? offset + page.length : null };
    };
    return { workflowId, nodes: projected, connections: links, read, commerceRunSettings,
        summary: { workflowId, totalNodes: projected.length, totalConnections: links.length,
            types: projected.reduce((counts, node) => ({ ...counts, [node.type]: (counts[node.type] || 0) + 1 }), {}),
            selectedIds, mentionedIds, page: read(), readOnlyTool: 'canvasRead: {offset?:number,nodeIds?:string[],connectionOffset?:number,textOffset?:number,assetOffset?:number,images?:{nodeId:string,index:number}[]}',
            editableTypes: CANVAS_TYPES, editableFields: CANVAS_FIELDS, creatableTypes: CANVAS_CREATABLE_TYPES,
            nodePatchFields: CANVAS_NODE_PATCH_FIELDS, unread: read().nextOffset !== null || read().connectionsOmitted > 0 } };
}

export function canvasBaseline(context, ids, ignoreOutputIds = []) {
    const relevant = new Set(ids);
    return JSON.stringify({ nodes: context.nodes.filter(node => relevant.has(node.id)).map(({ running, position, effectivePrompt, promptSource, parameterOptions, supportsSystemPrompt, patchable, imageCount, ...node }) => {
        // Keep the persisted v1 baseline independent of protocol controls projected from the live UI.
        const { protocolParams, ...parameters } = node.parameters;
        // The automatic language is the behavior of workflows saved before this field existed.
        if (node.type === 'ECommerceImageSet' && parameters.copyLanguage === 'auto') delete parameters.copyLanguage;
        // Stored v1 baselines use the registry's static declarations. A new plan that
        // edits custom sockets checks their live shape separately.
        const defaults = getNodeDefinition(node.type);
        const inputs = defaults?.inputs || [];
        // The new style input is visible in the live canvas. Its actual edges are compared below.
        const baselineInputs = node.type === 'ECommerceImageSet' ? inputs.filter(port => port.name !== 'styleReferenceImages') : inputs;
        return { ...node, parameters, inputs: baselineInputs, outputs: defaults?.outputs || [],
            ...(ignoreOutputIds.includes(node.id) ? { assets: [], missing: false } : {}) };
    }),
        connections: context.connections.filter(link => relevant.has(link.to.nodeId) || relevant.has(link.from.nodeId)) });
}


export function canvasPlanExecutionNodeIds(plan) {
    return plan.steps.filter(step => step.execute !== false).map(step => plan.bindings?.[step.id]).filter(Boolean);
}
