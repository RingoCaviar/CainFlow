import { applyReferenceImagePorts, orderInputConnections } from '../../nodes/reference-image-ports.js';
import { getNodeDefinition } from '../../nodes/registry.js';
export const isReferencePort = port => port === 'referenceImages' || /^image(?:_\d+)?$/.test(port);
export const agentNodeDefinition = type => applyReferenceImagePorts(getNodeDefinition(type), {type});
// Legacy plans are accepted, but all new graph mutations use the visible multi-input socket.
export function normalizePlanInputs(plan) {
    const targets = new Set(plan.steps.filter(s=>s.type==='ImageGenerate').map(s=>s.id));
    const counts = new Map(), sources = new Set();
    const ranked = plan.connections.map((link,index)=>({link,index})).sort((a,b)=>{
        if(a.link.to.ref!==b.link.to.ref) return String(a.link.to.ref).localeCompare(String(b.link.to.ref));
        if(!targets.has(a.link.to.ref)) return a.index-b.index;
        const rank=x=>Number.isFinite(x.link.order)?x.link.order:(/^image_\d+$/.test(x.link.to.port)?Number(x.link.to.port.slice(6))-1:x.index);
        return rank(a)-rank(b);
    });
    for(const {link} of ranked) if(targets.has(link.to.ref)&&isReferencePort(link.to.port)) {
        const key=JSON.stringify([link.to.ref,link.from.ref,link.from.port]);
        if(sources.has(key))throw new Error('方案参考图重复，请检查输入清单。');
        sources.add(key);
        if((counts.get(link.to.ref)||0)>=64)throw new Error('参考图最多支持64项。');
        link.to.port='referenceImages';link.order=counts.get(link.to.ref)||0;counts.set(link.to.ref,link.order+1);
    }
    for(const item of plan.disconnects||[]) if(targets.has(item.ref)&&isReferencePort(item.port)) item.port='referenceImages';
    return plan;
}
export function projectPlanConnections(plan, connections, identity) {
    const targets=new Set(plan.steps.filter(s=>s.type==='ImageGenerate').map(s=>identity(s.id)));
    const port=(id,name)=>targets.has(id)&&isReferencePort(name)?'referenceImages':name;
    const removed=[...(plan.disconnects||[]),...plan.connections.map(link=>link.to)].map(item=>({id:identity(item.ref),port:port(identity(item.ref),item.port)}));
    const retained=connections.filter(link=>!removed.some(item=>item.id===link.to.nodeId&&item.port===port(item.id,link.to.port)));
    return [...retained,...plan.connections.map(link=>({type:link.type,order:link.order,
        from:{nodeId:identity(link.from.ref),port:link.from.port},to:{nodeId:identity(link.to.ref),port:port(identity(link.to.ref),link.to.port)}}))];
}
export function referenceManifest(nodes, connections, targets, internalIds=[]) {
    const lookup=id=>nodes.find(n=>n.id===id);
    return targets.map(target=>({nodeId:target,inputs:orderInputConnections('ImageGenerate',connections.filter(link=>link.to.nodeId===target&&isReferencePort(link.to.port)&&lookup(link.from.nodeId)?.enabled!==false))
        .map(link=>{
            const node=lookup(link.from.nodeId);
            if(!node||node.missing||node.running)throw new Error('参考图来源已删除、缺失或正在运行，请刷新方案。');
            const upstream=internalIds.includes(node.id)&&node.type!=='ImageImport';
            if(!upstream&&!node.assets?.length)throw new Error('参考图原图尚未保存，请恢复原图后重新应用方案。');
            return {nodeId:node.id,port:link.from.port,assets:upstream?[]:[...node.assets],upstream};
        })}));
}


export function assertReferenceInputsPreserved(plan, connections, identity) {
    const targets = new Set(plan.steps.filter(step => step.type === 'ImageGenerate').map(step => identity(step.id)));
    const projected = projectPlanConnections(plan, connections, identity);
    for (const target of targets) {
        const permission = plan.referenceInputChange;
        if (['clear', 'replace'].includes(permission?.mode) && permission.targetNodeIds?.includes(target)) continue;
        const inputs = links => orderInputConnections('ImageGenerate', links.filter(link => link.to.nodeId === target && isReferencePort(link.to.port)));
        const previous = inputs(connections), next = inputs(projected);
        if (!previous.every((link, index) => next[index]?.from.nodeId === link.from.nodeId && next[index]?.from.port === link.from.port)) {
            throw new Error('方案试图断开已有参考图或改变输入顺序，但本轮没有明确要求；请重新生成保留参考图的方案。');
        }
    }
}


// Recover every confirmed source slot, including edges retained implicitly by a plan.
export function canvasPlanReferenceImages(plan, currentContext = null, targetNodeId = null) {
    let snapshot = currentContext || { nodes: [], connections: [] };
    if (plan.baseline) {
        try { const saved = JSON.parse(plan.baseline); if (Array.isArray(saved.nodes) && Array.isArray(saved.connections)) snapshot = saved; }
        catch { /* Historical plans without a baseline use the current context. */ }
    }
    const identity = ref => plan.steps.find(step => step.id === ref)?.nodeId || plan.bindings?.[ref] || ref;
    const sourceStep = id => plan.steps.find(step => identity(step.id) === id);
    const targets = plan.steps.filter(step => step.type === 'ImageGenerate' && (!targetNodeId || identity(step.id) === targetNodeId));
    if (targets.length > 1) return [{ referenceUnavailable: 'multiple-targets' }];
    if (!targets.length) return [];

    const node = id => snapshot.nodes.find(item => item.id === id);
    let groups;
    if (Array.isArray(plan.referenceManifest)) groups = plan.referenceManifest.filter(target => target.nodeId === identity(targets[0].id)).flatMap(target => target.inputs);
    else {
        const links = projectPlanConnections(plan, snapshot.connections, identity);
        groups = targets.flatMap(target =>
            orderInputConnections('ImageGenerate', links.filter(link => link.to.nodeId === identity(target.id) && isReferencePort(link.to.port)))
                .filter(link => node(link.from.nodeId)?.enabled !== false)
                .map(link => ({ nodeId: link.from.nodeId, port: link.from.port,
                    upstream: Boolean(sourceStep(link.from.nodeId) && sourceStep(link.from.nodeId).type !== 'ImageImport' && sourceStep(link.from.nodeId).execute !== false),
                    assets: sourceStep(link.from.nodeId)?.assetKey ? [sourceStep(link.from.nodeId).assetKey] : node(link.from.nodeId)?.assets || [] })));
    }
    return groups.flatMap(input => {
        const step = sourceStep(input.nodeId);
        const assets = input.upstream ? plan.completedReferenceOutputs?.[step?.id]?.assets || [] : input.assets;
        const reference = { sourceNodeId: input.nodeId, sourcePort: input.port || 'image',
            name: step?.title || node(input.nodeId)?.name || input.nodeId, role: 'reference' };
        if (!assets?.length) return [{ ...reference, referenceUnavailable: true }];
        return assets.map((assetKey, index) => ({ ...reference, referenceId: `plan:${plan.id}:${input.nodeId}:${index}:${assetKey}`,
            assetKey, sourceImageIndex: index }));
    });
}


export function assertPromptOnlyReferenceRecipe(previous, next, context, requestedTarget = null) {
    const identity = (plan, step) => step.nodeId || plan.bindings?.[step.id] || step.id;
    const priorTargets = previous.steps.filter(step => step.type === 'ImageGenerate');
    const targets = next.steps.filter(step => step.type === 'ImageGenerate');
    for (const target of targets) {
        const before = requestedTarget && targets.length === 1 ? priorTargets.find(step => identity(previous, step) === requestedTarget)
            : priorTargets.find(step => identity(previous, step) === identity(next, target))
                || (priorTargets.length === 1 && targets.length === 1 ? priorTargets[0] : null);
        if (!before) throw new Error('仅改提示词时参考图目标不明确，请保留完整方案或指定目标节点。');
        const beforeNodeId = before.nodeId || previous.bindings?.[before.id];
        const afterNodeId = target.nodeId || next.bindings?.[target.id];
        const sameTarget = Boolean(beforeNodeId && beforeNodeId === afterNodeId);
        const recipe = (plan, step) => {
            const result = [];
            for (const image of canvasPlanReferenceImages(plan, context, identity(plan, step))) {
                const source = plan.steps.find(item => identity(plan, item) === image.sourceNodeId);
                const pipeline = source && source.type !== 'ImageImport' && source.execute !== false;
                const entry = pipeline ? ['pipeline', identity(plan, source), image.sourcePort]
                    : sameTarget ? ['asset', image.sourceNodeId, image.sourcePort, image.sourceImageIndex, image.assetKey]
                        : ['asset', image.assetKey];
                if (pipeline && JSON.stringify(result.at(-1)) === JSON.stringify(entry)) continue;
                if (!pipeline && !image.assetKey) throw new Error('上一方案参考原图不可用，请恢复原图或保留完整多步骤方案。');
                result.push(entry);
            }
            return result;
        };
        if (JSON.stringify(recipe(previous, before)) !== JSON.stringify(recipe(next, target))) {
            throw new Error('仅改提示词时参考图原图、来源或顺序发生变化，请根据当前画布重新生成方案。');
        }
    }
}
