import { canvasPlanExecutionNodeIds } from './prompt-agent-canvas-context.js';
import { assertCanvasPlanCurrent } from './prompt-agent-canvas-plan.js';
import { batchBaseline } from './prompt-agent-canvas-batches.js';

// Only deletion of nodes created by this plan may bypass the ordinary stale-plan guard.
export function prepareCanvasPlanRecreation(plan, context) {
    const present = new Set(context.nodes.map(node => node.id));
    const missingIds = new Set(plan.steps.filter(step => !step.nodeId && step.execute !== false
        && plan.bindings?.[step.id] && !present.has(plan.bindings[step.id])).map(step => plan.bindings[step.id]));
    if (!missingIds.size || plan.workflowId !== context.workflowId) {
        assertCanvasPlanCurrent(plan, context);
        return { missingIds, connections: context.connections, affectedSteps: [] };
    }
    let saved;
    try { saved = JSON.parse(plan.baseline); } catch { assertCanvasPlanCurrent(plan, context); }
    const incident = edge => missingIds.has(edge.from.nodeId) || missingIds.has(edge.to.nodeId);
    const remaining = { nodes: saved.nodes.filter(node => !missingIds.has(node.id)), connections: saved.connections.filter(edge => !incident(edge)) };
    const validEndpoints = saved.connections.filter(incident).every(edge =>
        [edge.from.nodeId, edge.to.nodeId].every(id => present.has(id) || missingIds.has(id)));
    if (!validEndpoints || [...missingIds].some(id => !saved.nodes.some(node => node.id === id))
        || JSON.stringify(remaining) !== batchBaseline(plan, context, canvasPlanExecutionNodeIds(plan))) {
        assertCanvasPlanCurrent(plan, context);
    }
    // Reinsert deleted incident edges in their original order, retaining live edge objects.
    const connections = [...context.connections];
    const key = edge => JSON.stringify([edge.from, edge.to]);
    saved.connections.forEach((edge, index) => {
        if (!incident(edge)) return;
        const next = saved.connections.slice(index + 1).find(candidate => !incident(candidate));
        const before = next ? connections.findIndex(candidate => key(candidate) === key(next)) : -1;
        const type = saved.nodes.find(node => node.id === edge.from.nodeId)?.outputs.find(port => port.name === edge.from.port)?.type;
        connections.splice(before < 0 ? connections.length : before, 0, { ...edge, ...(type ? { type } : {}) });
    });
    // A recreated upstream also invalidates successful downstream results for partial retry.
    const affected = new Set(missingIds);
    let grew = true;
    while (grew) {
        grew = false;
        for (const edge of saved.connections) if (affected.has(edge.from.nodeId) && !affected.has(edge.to.nodeId)) {
            affected.add(edge.to.nodeId); grew = true;
        }
    }
    return { missingIds, connections, affectedSteps: plan.steps.filter(step => affected.has(plan.bindings?.[step.id])).map(step => step.id) };
}
