import { nodeBounds, findNearbyNodePosition } from '../execution/node-placement.js';
import { canvasBaseline, cloneCanvasValue } from './prompt-agent-canvas-context.js';
import { normalizePlanInputs, projectPlanConnections } from './prompt-agent-reference-inputs.js';

export function batchBaseline(plan, context, ignoreOutputs = []) {
    const ids = new Set(plan.dependencies);
    return canvasBaseline(plan.templateId ? { ...context, connections: context.connections.filter(edge => ids.has(edge.to.nodeId)) } : context,
        plan.dependencies, ignoreOutputs);
}

// A proposal is a reusable recipe. Its instances own all mutable graph/run state.
export function instantiateCanvasPlan(template, current) {
    const saved = JSON.parse(template.baseline);
    const originalIds = template.steps.map(step => step.nodeId).filter(Boolean);
    const ids = new Set(template.dependencies);
    const comparable = context => canvasBaseline({ ...context, connections: context.connections.filter(edge => ids.has(edge.to.nodeId)) }, [...ids], originalIds);
    if (template.workflowId !== current.workflowId || comparable(saved) !== comparable(current)) throw new Error('方案来源已变化，请根据当前画布重新生成方案');
    if (!template.steps.length) throw new Error('此方案没有可创建的节点');
    const originals = new Map(template.steps.filter(step => step.nodeId).map(step => [step.nodeId, step.id]));
    const identity = ref => template.steps.find(step => step.id === ref)?.nodeId || `new:${ref}`;
    const targets = new Map(template.steps.map(step => [identity(step.id), step.id]));
    const links = projectPlanConnections(template, saved.connections, ref => targets.has(ref) ? ref : template.steps.some(step => step.id === ref) ? identity(ref) : ref);
    const connections = links.filter(edge => targets.has(edge.to.nodeId)).map(edge => ({
        from: { ref: originals.get(edge.from.nodeId) || edge.from.nodeId, port: edge.from.port },
        to: { ref: targets.get(edge.to.nodeId), port: edge.to.port }, type: edge.type,
        ...(Number.isInteger(edge.order) ? { order: edge.order } : {})
    }));
    for (const edge of connections) if (edge.from.ref.startsWith('new:')) edge.from.ref = edge.from.ref.slice(4);
    const steps = template.steps.map(step => {
        const source = saved.nodes.find(node => node.id === step.nodeId);
        const copy = cloneCanvasValue(step); delete copy.nodeId;
        const inherited = { ...source?.parameters };
        if (copy.type === 'ImageGenerate' && inherited.resolution !== 'custom') {
            delete inherited.customWidth; delete inherited.customHeight;
        }
        copy.parameters = { ...inherited, ...copy.parameters };
        copy.inheritedFields = Object.keys(inherited).filter(key => !Object.hasOwn(step.parameters || {}, key));
        if (copy.execute === false && source?.assets?.length && copy.type === 'ImageGenerate') {
            copy.cachedAssetKeys = [...source.assets];
            copy.cachedModelId = source.modelId; copy.cachedProviderId = source.providerId;
            copy.parameters.prompt = current.nodes.find(node => node.id === source.id)?.effectivePrompt || copy.parameters.prompt;
        }
        if (copy.type === 'ImageImport' && !copy.assetKey) copy.assetKey = source?.assets?.[0];
        return copy;
    });
    const cached = new Set(steps.filter(step => step.cachedAssetKeys).map(step => step.id));
    const instanceConnections = connections.filter(edge => !cached.has(edge.to.ref));
    const internal = new Set(steps.map(step => step.id));
    const dependencies = [...new Set(instanceConnections.filter(edge => !internal.has(edge.from.ref)).map(edge => edge.from.ref))];
    const instance = normalizePlanInputs({ version: 1, id: crypto.randomUUID(), templateId: template.id, workflowId: template.workflowId,
        steps, connections: instanceConnections, order: [...template.order], dependencies, disconnects: [], deletes: [], bindings: {}, runs: [],
        retainedDisabledSources: dependencies.filter(id => saved.nodes.find(node => node.id === id)?.enabled === false),
        ...Object.fromEntries(['modelOverrides','providerOverrides','thinkingOverrides','agentSizes','agentProviders','newCreativeTask'].filter(key => template[key] !== undefined).map(key => [key, cloneCanvasValue(template[key])])) });
    instance.baseline = batchBaseline(instance, current);
    return instance;
}

// Pack unrelated new nodes as a single block so obstacles cannot fragment a batch.
export function layoutIndependentCanvasNodes(nodes, { x, y, occupied = [], zoom = 1, gap = 40 }) {
    if (nodes.length < 2) return;
    const boxes = nodes.map(node => nodeBounds(node, zoom));
    const columns = Math.ceil(Math.sqrt(nodes.length));
    const rows = Math.ceil(nodes.length / columns);
    const width = Math.max(...boxes.map(box => box.width));
    const height = Math.max(...boxes.map(box => box.height));
    const start = findNearbyNodePosition({ x, y, width: columns * (width + gap) - gap,
        height: rows * (height + gap) - gap, occupied, gap });
    nodes.forEach((node, index) => {
        node.x = start.x + (index % columns) * (width + gap);
        node.y = start.y + Math.floor(index / columns) * (height + gap);
        if (node.el) {
            node.el.style.left = `${node.x}px`;
            node.el.style.top = `${node.y}px`;
        }
    });
}
