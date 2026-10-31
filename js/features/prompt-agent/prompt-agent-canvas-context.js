import { agentNodeDefinition as getNodeDefinition } from './prompt-agent-reference-inputs.js';

export const CANVAS_FIELDS = Object.freeze({
    ImageImport: [], ImageGenerate: ['prompt', 'aspect', 'resolution', 'customWidth', 'customHeight', 'quality', 'moderation', 'background', 'generationCount'],
    ImageResize: ['resizeMode', 'scalePercent', 'targetWidth', 'targetHeight', 'keepAspect', 'quality'],
    ImageMerge: ['inputCount'], ImagePreview: [], ImageCompare: [], Text: ['text']
});
export const CANVAS_TYPES = Object.keys(CANVAS_FIELDS);
export const cloneCanvasValue = value => JSON.parse(JSON.stringify(value));

// Explicit field projection: never serialize providers, arbitrary node data or URLs.
export function projectCanvasNode(node, running = false) {
    const definition = getNodeDefinition(node.type);
    const parameters = Object.fromEntries((CANVAS_FIELDS[node.type] || ['prompt', 'text']).filter(key =>
        ['string', 'number', 'boolean'].includes(typeof node[key])).map(key => [key, node[key]]));
    return {
        id: node.id, type: node.type, name: node.customTitle || definition?.title || node.type,
        position: { x: Number(node.x) || 0, y: Number(node.y) || 0, width: Number(node.width) || definition?.defaultWidth || 0, height: Number(node.height) || definition?.defaultHeight || 0 },
        enabled: node.enabled !== false, running, editable: CANVAS_TYPES.includes(node.type) && node.isClone !== true, parameters,
        ...(node.type === 'ImageImport' && node.data?.imageDescription ? { imageDescription: String(node.data.imageDescription).slice(0, 2000) } : {}),
        inputs: definition?.inputs || [], outputs: definition?.outputs || [],
        assets: node.mediaAssetKeys?.length ? node.mediaAssetKeys.filter(key => typeof key === 'string' && key.startsWith('media:')) : [...new Set([node.imageImportAssetKey, node.imageAssetKey].filter(key => typeof key === 'string' && key.startsWith('media:')))],
        thinking: node.thinking ? cloneCanvasValue(node.thinking) : null,
        providerId: node.providerId || null,
        missing: node.mediaIntegrity?.state === 'missing', modelId: node.apiConfigId || null
    };
}

export function createCanvasContext({ workflowId, nodes, connections, selectedIds = [], mentionedIds = [], runningIds = [], getGenerationContext = null }) {
    const projected = nodes.map(node => projectCanvasNode(node, runningIds.includes(node.id)));
    const links = connections.map(link => ({ id: link.id, ...(Number.isInteger(link.order)?{order:link.order}:{}), from: { nodeId: link.from?.nodeId, port: link.from?.port }, to: { nodeId: link.to?.nodeId, port: link.to?.port } }));
    for (const node of projected.filter(node => node.type === 'ImageGenerate')) {
        const actual = getGenerationContext?.(node.id);
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
            for (const [key, value] of Object.entries(safe.parameters)) if (typeof value === 'string' && value.length > 2000) {
                safe.parameters[key] = value.slice(textOffset, textOffset + 2000); safe.parameterTextOmitted = true;
                (safe.parameterTextRanges ||= {})[key] = { offset: textOffset, total: value.length, nextOffset: textOffset + 2000 < value.length ? textOffset + 2000 : null };
            }
            for (const [owner, key, name] of [[safe, 'effectivePrompt', 'effectivePrompt'], [safe.promptSource, 'text', 'promptSource.text']]) {
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
    return { workflowId, nodes: projected, connections: links, read,
        summary: { workflowId, totalNodes: projected.length, totalConnections: links.length,
            types: projected.reduce((counts, node) => ({ ...counts, [node.type]: (counts[node.type] || 0) + 1 }), {}),
            selectedIds, mentionedIds, page: read(), readOnlyTool: 'canvasRead: {offset?:number,nodeIds?:string[],connectionOffset?:number,textOffset?:number,assetOffset?:number,images?:{nodeId:string,index:number}[]}',
            editableTypes: CANVAS_TYPES, unread: read().nextOffset !== null || read().connectionsOmitted > 0 } };
}

export function canvasBaseline(context, ids, ignoreOutputIds = []) {
    const relevant = new Set(ids);
    return JSON.stringify({ nodes: context.nodes.filter(node => relevant.has(node.id)).map(({ running, position, effectivePrompt, promptSource, ...node }) =>
        ignoreOutputIds.includes(node.id) ? { ...node, assets: [], missing: false } : node),
        connections: context.connections.filter(link => relevant.has(link.to.nodeId) || relevant.has(link.from.nodeId)) });
}


export function canvasPlanExecutionNodeIds(plan) {
    return plan.steps.filter(step => step.execute !== false).map(step => plan.bindings?.[step.id]).filter(Boolean);
}
