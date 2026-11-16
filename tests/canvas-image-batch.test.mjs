import assert from 'node:assert/strict';
import test from 'node:test';
import { canvasBaseline, createCanvasContext } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';
import { buildCanvasImageBatch, selectedCanvasImageBatchSources } from '../js/features/prompt-agent/prompt-agent-canvas-image-batch.js';
import { normalizeCanvasPlan } from '../js/features/prompt-agent/prompt-agent-canvas-plan.js';

const contextFor = (nodes, selectedIds = nodes.map(node => node.id)) =>
    createCanvasContext({ workflowId: 'work', nodes, selectedIds, connections: [] });
const source = (id, type = 'ImageImport', assets = [`media:${id}`]) => ({ id, type, mediaAssetKeys: assets });

test('one prompt connects to every selected original with a separate generation and preview for each', () => {
    const originals = Array.from({ length: 15 }, (_, index) => source(`picture-${index}`));
    const context = contextFor([source('old-output', 'ImageGenerate'), ...originals, { id: 'notes', type: 'Text' },
        source('preview', 'ImagePreview', ['media:picture-0']), source('unselected')], ['old-output', ...originals.map(node => node.id), 'notes', 'preview']);
    const sourceNodeIds = selectedCanvasImageBatchSources(context);
    const proposal = buildCanvasImageBatch(context, { prompt: '换成浅灰背景', parameters: { aspect: '1:1' } });
    const plan = normalizeCanvasPlan(proposal, context, { batchSourceNodeIds: sourceNodeIds,
        referencePolicy: { intent: 'generate' } });
    const text = plan.steps.filter(step => step.type === 'Text');
    const generators = plan.steps.filter(step => step.type === 'ImageGenerate');
    assert.equal(text.length, 1);
    assert.equal(text[0].parameters.text, '换成浅灰背景');
    assert.equal(generators.length, 15);
    assert.equal(plan.steps.filter(step => step.type === 'ImagePreview').length, 15);
    for (const [index, generator] of generators.entries()) {
        assert.equal(generator.parameters.aspect, '1:1');
        const inputs = plan.connections.filter(link => link.to.ref === generator.id);
        assert.deepEqual(inputs.map(link => [link.from.ref, link.to.port]), [
            [text[0].id, 'prompt'], [`picture-${index}`, 'referenceImages']
        ]);
        assert.equal(plan.connections.filter(link => link.from.ref === generator.id).length, 1);
    }
    assert.equal(plan.steps.every(step => !step.nodeId), true);
    assert.throws(() => normalizeCanvasPlan(proposal, context, { referencePolicy: { intent: 'generate' } }), /明确指定/);
    assert.throws(() => normalizeCanvasPlan(proposal, context, { batchSourceNodeIds: sourceNodeIds.slice(1),
        referencePolicy: { intent: 'generate' } }), /明确指定/);
});

test('a selected multi-image output supplies one fixed asset per branch in saved order', () => {
    const context = contextFor([source('duplicate', 'ImageImport', ['media:second']),
        source('outputs', 'ImageGenerate', ['media:first', 'media:second'])]);
    const sourceNodeIds = ['outputs'];
    const raw = buildCanvasImageBatch(context, { sourceNodeIds, prompt: 'Make the edges smooth' });
    const plan = normalizeCanvasPlan(raw, context, { batchSourceNodeIds: sourceNodeIds, referencePolicy: { intent: 'generate' } });
    assert.deepEqual(plan.steps.filter(step => step.type === 'ImageImport')
        .map(step => [step.assetKey, step.assetSourceNodeId, step.execute]), [
        ['media:first', 'outputs', false], ['media:second', 'outputs', false]
    ]);
    assert.deepEqual(plan.dependencies, ['outputs']);
    assert.throws(() => buildCanvasImageBatch(context, { sourceNodeIds: ['missing'], prompt: 'a' }), /不存在/);
    assert.throws(() => buildCanvasImageBatch(context, { sourceNodeIds, prompt: 'a', parameters: { prompt: 'bad' } }), /提示词/);
    const empty = contextFor([source('empty', 'ImageImport', [])]);
    assert.throws(() => buildCanvasImageBatch(empty, { prompt: 'a' }), /原图/);
    const urlMode = contextFor([{ ...source('previous-upload'), importMode: 'url', imageUrl: 'https://example.test/original' }]);
    assert.throws(() => buildCanvasImageBatch(urlMode, { prompt: 'a' }), /原图/);
    assert.doesNotMatch(JSON.stringify(urlMode.read()), /example\.test/);
});

test('canvas reads expose supported public fields and page system prompt text without projecting other protocol data', () => {
    const graph = { workflowId: 'work', nodes: [{ id: 'generation', type: 'ImageGenerate', resolution: '2K' }], connections: [] };
    const context = createCanvasContext({
        ...graph,
        getGenerationContext: () => ({
            parameters: { protocolParams: { systemPrompt: 'a'.repeat(2050), output_format: 'png', endpoint: 'private' } },
            parameterSchema: { resolution: { enum: ['', '2K'] }, protocolParams: { properties: {
                systemPrompt: { type: 'string' }, output_format: { enum: ['', 'png'] }, endpoint: { type: 'string' }
            } } }
        })
    });
    const [first] = context.read().nodes;
    assert.deepEqual(first.parameterOptions, { resolution: ['', '2K'], 'protocolParams.output_format': ['', 'png'] });
    assert.deepEqual(first.parameters.protocolParams, { systemPrompt: 'a'.repeat(2000), output_format: 'png' });
    assert.equal(first.parameterTextRanges['protocolParams.systemPrompt'].nextOffset, 2000);
    assert.equal(context.read({ textOffset: 2000 }).nodes[0].parameters.protocolParams.systemPrompt.length, 50);
    assert.equal(canvasBaseline(context, ['generation']), canvasBaseline(createCanvasContext(graph), ['generation']));
});
