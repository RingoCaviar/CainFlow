import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasContext } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';
import { assertCanvasPlanCurrent, describeCanvasPlan, normalizeCanvasPlan } from '../js/features/prompt-agent/prompt-agent-canvas-plan.js';
import { projectPlanConnections } from '../js/features/prompt-agent/prompt-agent-reference-inputs.js';

test('an exact disconnect removes only the named edge and retains ordered neighboring inputs', () => {
    const context = contextForExactDisconnect();
    const raw = {
        version: 1,
        steps: [{ id: 'edit', type: 'ImageGenerate', nodeId: 'generator', execute: false }],
        disconnects: [{ ref: 'edit', port: 'referenceImages', connectionId: 'reference-b' }]
    };
    const wiring = plan => projectPlanConnections(plan, context.connections, ref => ref === 'edit' ? 'generator' : ref);
    const plan = normalizeCanvasPlan(raw, context, { message: '把选中节点的第2张参考图断开' });
    assert.deepEqual(wiring(plan).map(edge => edge.id), ['reference-a', 'reference-c', 'prompt']);
    assert.equal(wiring(plan)[1].order, 7);
    assert.deepEqual(describeCanvasPlan(plan, context), ['移除连线 局部图 · 图片 → 生成图 · 参考图']);
    assert.throws(() => normalizeCanvasPlan(raw, context, { message: '断开生成图到局部图的连线' }));
    assert.deepEqual(wiring(normalizeCanvasPlan(raw, context, { message: '断开局部图到生成图的连线' })).map(edge => edge.id),
        ['reference-a', 'reference-c', 'prompt']);
    assert.throws(() => normalizeCanvasPlan(raw, context, { message: '移除选中节点的第1张参考图' }));
    assert.throws(() => normalizeCanvasPlan(raw, context, { message: '不要断开连线 [reference-b]' }));
    assert.throws(() => normalizeCanvasPlan({ ...raw, disconnects: [
        { ref: 'edit', port: 'prompt', connectionId: 'reference-b' }
    ] }, context, { explicitInputChanges: true }));
    assert.throws(() => normalizeCanvasPlan({ ...raw, disconnects: [
        ...raw.disconnects, { ref: 'edit', port: 'referenceImages' }
    ] }, context, { explicitInputChanges: true }));

    const multi = contextForExactDisconnect();
    multi.nodes.find(node => node.id === 'b').assets.push('media:b2');
    assert.throws(() => normalizeCanvasPlan(raw, multi, { message: '把选中节点的第2张参考图断开' }));
    assert.deepEqual(wiring(normalizeCanvasPlan(raw, multi, { message: '断开连线 [reference-b]' })).map(edge => edge.id),
        ['reference-a', 'reference-c', 'prompt']);
});

test('typed exact prompt disconnection leaves reference inputs and grants no whole-port permission', () => {
    const context = contextForExactDisconnect();
    const plan = normalizeCanvasPlan({
        version: 1,
        steps: [{ id: 'edit', type: 'ImageGenerate', nodeId: 'generator', execute: false }],
        disconnects: [{ ref: 'edit', port: 'prompt', connectionId: 'prompt' }]
    }, context, { explicitInputChanges: true });
    assert.equal(plan.promptInputChange, null);
    assert.equal(plan.referenceInputChange, null);
    assert.deepEqual(projectPlanConnections(plan, context.connections, ref => ref === 'edit' ? 'generator' : ref).map(edge => edge.id),
        ['reference-a', 'reference-b', 'reference-c']);
});

test('reference ordinals count images held in a legacy multi-image asset', () => {
    const legacy = { type: 'ImageGenerate', mediaAssetKeys: [], imageAssetKey: 'media:legacy', imageCount: 2 };
    const context = contextForExactDisconnect(legacy);
    const command = connectionId => ({ version: 1,
        steps: [{ id: 'edit', type: 'ImageGenerate', nodeId: 'generator', execute: false }],
        disconnects: [{ ref: 'edit', port: 'referenceImages', connectionId }]
    });
    assert.throws(() => normalizeCanvasPlan(command('reference-a'), context, { message: '把选中节点的第1张参考图断开' }));
    assert.throws(() => normalizeCanvasPlan(command('reference-b'), context, { message: '把选中节点的第2张参考图断开' }));
    const plan = normalizeCanvasPlan(command('reference-b'), context, { message: '把选中节点的第3张参考图断开' });
    assertCanvasPlanCurrent(plan, context);
    assert.throws(() => assertCanvasPlanCurrent(plan, contextForExactDisconnect({ ...legacy, imageCount: 3 })), /画布内容已变化/);
    assert.doesNotThrow(() => normalizeCanvasPlan(command('reference-a'), context, { message: '断开连线 [reference-a]' }));
});

function contextForExactDisconnect(firstSource = {}) {
    return createCanvasContext({
        workflowId: 'workflow',
        nodes: [
            { id: 'a', type: 'ImageImport', customTitle: '商品图', mediaAssetKeys: ['media:a'], ...firstSource },
            { id: 'b', type: 'ImageImport', customTitle: '局部图', mediaAssetKeys: ['media:b'] },
            { id: 'c', type: 'ImageImport', customTitle: '背景图', mediaAssetKeys: ['media:c'] },
            { id: 'words', type: 'Text', text: '提示词' },
            { id: 'generator', type: 'ImageGenerate', customTitle: '生成图' }
        ],
        connections: [
            { id: 'reference-a', from: { nodeId: 'a', port: 'image' }, to: { nodeId: 'generator', port: 'referenceImages' }, order: 1 },
            { id: 'reference-b', from: { nodeId: 'b', port: 'image' }, to: { nodeId: 'generator', port: 'referenceImages' }, order: 4 },
            { id: 'reference-c', from: { nodeId: 'c', port: 'image' }, to: { nodeId: 'generator', port: 'referenceImages' }, order: 7 },
            { id: 'prompt', from: { nodeId: 'words', port: 'text' }, to: { nodeId: 'generator', port: 'prompt' } }
        ],
        selectedIds: ['generator']
    });
}

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
