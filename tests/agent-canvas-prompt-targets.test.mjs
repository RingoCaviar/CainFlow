import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasContext } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';
import { normalizeCanvasPlan, describeCanvasPlan } from '../js/features/prompt-agent/prompt-agent-canvas-plan.js';

const connection = { id: 'prompt-source', from: { nodeId: 'source', port: 'text' }, to: { nodeId: 'target', port: 'prompt' } };
const context = (source = {}) => createCanvasContext({ workflowId: 'workflow-a', nodes: [
    { id: 'source', type: 'Text', customTitle: '真正提示词来源', text: 'effective source', ...source },
    { id: 'target', type: 'ImageGenerate', prompt: 'preserved local draft' }
], connections: [connection] });
const editTarget = () => ({ version: 1, steps: [{ id: 'generate', type: 'ImageGenerate', nodeId: 'target', parameters: { prompt: 'ineffective local optimization' } }] });

test('canvas context identifies the real upstream prompt and refuses a successful-looking local rewrite', () => {
    const scene = context(), target = scene.nodes.find(node => node.id === 'target');
    assert.equal(target.effectivePrompt, 'effective source');
    assert.equal(target.parameters.prompt, 'preserved local draft');
    assert.equal(target.promptSource.nodeId, 'source');
    assert.equal(target.promptSource.editable, true);
    assert.throws(() => normalizeCanvasPlan(editTarget(), scene, { mentionedIds: ['target'] }), /上游|来源/);
});
test('an explicitly authorized Text source is previewed and applied before its connected generation step', () => {
    const scene = context();
    const plan = normalizeCanvasPlan({ version: 1, steps: [
        { id: 'generate', type: 'ImageGenerate', nodeId: 'target', parameters: { quality: 'high' } },
        { id: 'source_edit', type: 'Text', nodeId: 'source', parameters: { text: 'optimized actual source' } }
    ] }, scene, { mentionedIds: ['target', 'source'] });
    assert.deepEqual(plan.order, ['source_edit', 'generate']);
    assert.ok(describeCanvasPlan(plan, scene).some(line => line.includes('optimized actual source')));
    assert.throws(() => normalizeCanvasPlan({ version: 1, steps: [
        { id: 'source_edit', type: 'Text', nodeId: 'source', parameters: { text: 'unmentioned source edit' } }
    ] }, scene, { mentionedIds: ['target'] }), /@节点/);
});
test('clones and derived Camera text remain read-only and optimization cannot disconnect an upstream prompt', () => {
    const clone = context({ isClone: true });
    assert.equal(clone.nodes[0].editable, false);
    assert.throws(() => normalizeCanvasPlan({ version: 1, steps: [
        { id: 'source_edit', type: 'Text', nodeId: 'source', parameters: { text: 'overwrite clone' } }
    ] }, clone, { mentionedIds: ['source'] }), /只读|克隆/);
    const camera = context({ type: 'CameraControl' });
    assert.equal(camera.nodes[1].promptSource.editable, false);
    assert.throws(() => normalizeCanvasPlan(editTarget(), camera, { mentionedIds: ['target'] }), /上游|来源/);
    const disconnect = editTarget(); disconnect.disconnects = [{ ref: 'generate', port: 'prompt' }];
    assert.throws(() => normalizeCanvasPlan(disconnect, context(), { message: '优化提示词，保留来源', mentionedIds: ['target'] }), /断开|上游|来源/);
});

test('only an explicit prompt disconnection authorizes changing that input, including for historical plan previews', () => {
    const proposal = editTarget(); proposal.disconnects = [{ ref: 'generate', port: 'prompt' }];
    for (const message of ['优化提示词', '不要断开提示词输入', '不断开提示词输入', '保留来源，不许替换提示词']) {
        assert.throws(() => normalizeCanvasPlan(proposal, context(), { message, mentionedIds: ['target'] }), /断开|上游|来源/);
    }
    const plan = normalizeCanvasPlan(proposal, context(), { message: '断开提示词输入，改用本地稿', mentionedIds: ['target'] });
    assert.deepEqual(plan.promptInputChange.targetNodeIds, ['target']);
    const other = context(); other.nodes.push({ ...other.nodes[1], id: 'other', name: '其他生图' });
    assert.throws(() => normalizeCanvasPlan(proposal, other, {
        message: '断开提示词输入 @其他生图[other]；优化 @当前目标[target]', mentionedIds: ['target', 'other']
    }), /断开|上游|来源/);
    const historical = { steps: [{ id: 'source_edit', nodeId: 'source', title: '泛化的文本标题', parameters: { text: 'new source' } }], connections: [] };
    assert.ok(describeCanvasPlan(historical, context()).some(line => line.includes('真正提示词来源')));
});

test('derived prompt context follows the existing paged text boundary without truncating the authoritative context', () => {
    const text = 'x'.repeat(6000), scene = context({ text });
    const target = scene.nodes.find(node => node.id === 'target');
    assert.equal(target.effectivePrompt.length, 6000);
    const page = scene.read({ nodeIds: ['target'], textOffset: 2000 }).nodes[0];
    assert.equal(page.effectivePrompt, text.slice(2000, 4000));
    assert.equal(page.promptSource.text, text.slice(2000, 4000));
    assert.equal(page.parameterTextRanges['promptSource.text'].nextOffset, 4000);
});
