import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasContext } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';
import { normalizeCanvasPlan } from '../js/features/prompt-agent/prompt-agent-canvas-plan.js';
import { projectPlanConnections } from '../js/features/prompt-agent/prompt-agent-reference-inputs.js';

test('restating a retained disabled reference preserves its edge without authorizing a new disabled input', () => {
    const edge = (id, source, order) => ({ id, order, from: { nodeId: source, port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' } });
    const context = createCanvasContext({ workflowId: 'workflow-a', nodes: [
        { id: 'disabled', type: 'ImageImport', enabled: false, mediaAssetKeys: ['media:disabled'] },
        { id: 'active', type: 'ImageImport', mediaAssetKeys: ['media:active'] },
        { id: 'other-disabled', type: 'ImageImport', enabled: false },
        { id: 'target', type: 'ImageGenerate', prompt: 'original' }
    ], connections: [edge('disabled-edge', 'disabled', 4), edge('active-edge', 'active', 9)] });
    const proposal = { version: 1, steps: [{ id: 'edit', type: 'ImageGenerate', nodeId: 'target', parameters: { prompt: 'optimized' } }],
        connections: ['disabled', 'active'].map((ref, index) => ({ from: { ref, port: 'image' }, to: { ref: 'edit', port: 'referenceImages' }, order: index })) };
    const plan = normalizeCanvasPlan(proposal, context, { mentionedIds: ['target'] });
    assert.deepEqual(projectPlanConnections(plan, context.connections, ref => ref === 'edit' ? 'target' : ref), context.connections);
    const added = structuredClone(proposal); added.connections.push({ from: { ref: 'other-disabled', port: 'image' }, to: { ref: 'edit', port: 'referenceImages' }, order: 2 });
    assert.throws(() => normalizeCanvasPlan(added, context, { mentionedIds: ['target'] }), /禁用/);
    const reordered = structuredClone(proposal); reordered.connections.reverse(); reordered.connections.forEach((link, index) => { link.order = index; });
    assert.throws(() => normalizeCanvasPlan(reordered, context, { mentionedIds: ['target'] }), /禁用|顺序/);
});
