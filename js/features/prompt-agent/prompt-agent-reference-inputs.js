import { applyReferenceImagePorts } from '../../nodes/reference-image-ports.js';
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
    return targets.map(target=>({nodeId:target,inputs:connections.filter(link=>link.to.nodeId===target&&isReferencePort(link.to.port))
        .sort((a,b)=>(a.order ?? (Number(a.to.port.split('_')[1])||0))-(b.order ?? (Number(b.to.port.split('_')[1])||0)))
        .map(link=>{
            const node=lookup(link.from.nodeId);
            if(!node||node.enabled===false||node.missing||node.running)throw new Error('参考图来源已删除、禁用、缺失或正在运行，请刷新方案。');
            const upstream=internalIds.includes(node.id)&&node.type!=='ImageImport';
            if(!upstream&&!node.assets?.length)throw new Error('参考图原图尚未保存，请恢复原图后重新应用方案。');
            return {nodeId:node.id,port:link.from.port,assets:upstream?[]:[...node.assets],upstream};
        })}));
}
