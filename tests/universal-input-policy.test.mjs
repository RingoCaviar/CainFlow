import test from 'node:test';
import assert from 'node:assert/strict';
import { isUniversalInputNode, resolveUniversalInput, validateUniversalImageInputs } from '../js/nodes/universal-input-policy.js';
import '../js/features/execution/protocols/openai.js';
import '../js/features/execution/protocols/google.js';
import { registerProtocol } from '../js/features/execution/protocols/index.js';
import { serializeConnection } from '../js/canvas/connection-snapshot.js';
import { projectImageOutput } from '../js/nodes/image-output-projection.js';

function setup() {
    const targetNode = { id: 'target', type: 'ImageGenerate', apiConfigId: 'image', data: {} };
    const state = { nodes: new Map([[targetNode.id, targetNode]]), connections: [],
        models: [{ id: 'image', modelId: 'gpt-image-1', protocol: 'openai' }] };
    return { state, targetNode };
}

for (const type of ['ImagePreview', 'ImageResize', 'ColorReset']) test(`${type} accepts one image source with its whole batch and refuses occupied or incompatible inputs`, () => {
    const targetNode = { id: 'preview', type, data: {} };
    const sourceNode = { id: 'source', type: 'ImageGenerate', data: { imageList: ['first', 'second'] } };
    const state = { nodes: new Map([[targetNode.id, targetNode], [sourceNode.id, sourceNode]]), connections: [], models: [] };
    const args = { state, targetNode, sourceNode, sourcePort: 'image' };
    const resolved = resolveUniversalInput(args);
    assert.equal(resolved.error, '');
    assert.equal(resolved.port, 'image');
    assert.equal(resolved.multiple, false);
    assert.deepEqual(sourceNode.data.imageList, ['first', 'second']);
    state.connections.push({ id: 'old', from: { nodeId: 'old-source', port: 'image' }, to: { nodeId: 'preview', port: 'image' }, type: 'image' });
    assert.match(resolveUniversalInput(args).error, /占用/);
    assert.equal(resolveUniversalInput({ ...args, ignoreConnectionId: 'old' }).error, '');
    assert.match(resolveUniversalInput({ ...args, sourceNode: { id: 'text', type: 'Text' }, sourcePort: 'text' }).error, /不兼容/);
    assert.equal(validateUniversalImageInputs({ state, node: targetNode, inputs: { image: ['first', 'second'] } }), '', 'preview requires no generation model');
    assert.equal(isUniversalInputNode({ type: 'ImageImport' }), false);
});

test('URL sources use their current URL output and target protocol while retaining inactive upload drafts', () => {
    const context = setup();
    const sourceNode = { id: 'url', type: 'ImageImport', importMode: 'url', imageUrl: 'https://example.test/image.png',
        data: { imageList: ['old-a', 'old-b'], mediaAssetKeys: ['media:old-a', 'media:old-b'], imageCount: 2 } };
    context.state.nodes.set(sourceNode.id, sourceNode);
    const args = { ...context, sourceNode, sourcePort: 'image' };
    assert.equal(resolveUniversalInput(args).error, '');
    assert.equal(resolveUniversalInput({ ...args, role: 'mask' }).error, '', 'the existing OpenAI editor accepts a single URL mask');
    const output = projectImageOutput(sourceNode, sourceNode.data.imageList);
    assert.deepEqual(output.images, [sourceNode.imageUrl]);
    assert.equal(output.count, 1);
    assert.deepEqual(output.assets, []);
    assert.deepEqual(sourceNode.data.mediaAssetKeys, ['media:old-a', 'media:old-b']);
    context.state.models[0].protocol = 'google';
    assert.match(resolveUniversalInput(args).error, /URL.*不支持/);
    context.targetNode.type = 'ImagePreview';
    assert.equal(resolveUniversalInput(args).error, '', 'the existing preview accepts URL images');
});

test('universal generation input resolves the actual source output to a durable logical role', () => {
    const context = setup();
    for (const [type, sourcePort, port, expectedType] of [
        ['ImageImport','image','referenceImages','image'], ['Text','text','prompt','text'],
        ['CameraControl','text','camera_prompt','text'], ['CustomParams','params','params','params']
    ]) {
        const sourceNode = { id: type, type, data: {} };
        context.state.nodes.set(sourceNode.id, sourceNode);
        const result = resolveUniversalInput({ ...context, sourceNode, sourcePort });
        assert.equal(result.error, '');
        assert.deepEqual({ port: result.port, type: result.type, multiple: result.multiple },
            { port, type: expectedType, multiple: expectedType === 'image' });
    }
    assert.equal(isUniversalInputNode(context.targetNode), true);
    assert.equal(isUniversalInputNode({ type: 'VideoGenerate' }), false);
    const sourceNode = context.state.nodes.get('ImageImport');
    assert.match(resolveUniversalInput({ ...context, sourceNode, sourcePort: 'video' }).error, /输出/);
    assert.match(resolveUniversalInput({ ...context, sourceNode, sourcePort: 'image', sourceType: 'text' }).error, /类型/);
});

test('universal input rejects occupied roles, duplicates, cycles and running endpoints without changing the graph', () => {
    const context = setup(), sourceNode = { id: 'source', type: 'Text', data: {} };
    context.state.nodes.set(sourceNode.id, sourceNode);
    const args = { ...context, sourceNode, sourcePort: 'text' };
    const edge = { id: 'existing', from: { nodeId: 'other', port: 'text' }, to: { nodeId: 'target', port: 'prompt' }, type: 'text' };
    context.state.connections.push(edge);
    assert.match(resolveUniversalInput(args).error, /已占用/);
    assert.equal(resolveUniversalInput({ ...args, ignoreConnectionId: 'existing' }).error, '');
    edge.from.nodeId = sourceNode.id;
    assert.match(resolveUniversalInput(args).error, /重复/);
    assert.equal(context.state.connections[0], edge);
    context.state.connections = [{ id: 'back', from: { nodeId: 'target', port: 'image' }, to: { nodeId: 'source', port: 'text' }, type: 'image' }];
    assert.match(resolveUniversalInput(args).error, /循环/);
    context.state.connections = [];
    context.state.runningNodeIds = new Set(['source']);
    assert.match(resolveUniversalInput(args).error, /运行/);
    context.state.runningNodeIds.clear();
    assert.match(resolveUniversalInput({ ...context, sourceNode: context.targetNode, sourcePort: 'image' }).error, /自身/);
});

test('reference capacity counts complete enabled batches and follows the exact protocol variant', () => {
    const context = setup();
    const previous = { id: 'previous', type: 'ImageGenerate', data: { imageList: ['a','b','c'] } };
    const sourceNode = { id: 'source', type: 'ImageGenerate', data: { mediaAssetKeys: ['media:d','media:e','media:f'], imageCount: 3 } };
    context.state.nodes.set(previous.id, previous);
    context.state.nodes.set(sourceNode.id, sourceNode);
    context.state.connections.push({ id: 'old', from: { nodeId: previous.id, port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image' });
    const args = { ...context, sourceNode, sourcePort: 'image' };
    assert.match(resolveUniversalInput(args).error, /最多.*5.*6/);
    previous.enabled = false;
    assert.equal(resolveUniversalInput(args).error, '', 'disabled sources retain their edge without consuming capacity');
    registerProtocol({ id: 'universal-input-capacity-test', taskTypes: ['image'], parameters: {
        prompt: { id: 'prompt', inputPort: true, portType: 'text' }
    }, variants: { small: { referenceImage: { maxCount: 2 }, parameters: {
        referenceImages: { id: 'referenceImages', inputPort: true, portType: 'image', portCount: 2 }
    } }, textOnly: {} } });
    context.state.models[0] = { id: 'image', modelId: 'small', protocol: 'universal-input-capacity-test' };
    assert.match(resolveUniversalInput(args).error, /最多.*2.*3/);
    context.state.models[0].modelId = 'textOnly';
    assert.match(resolveUniversalInput(args).error, /不支持.*参考/);
    context.state.models[0].modelId = 'unknown';
    assert.match(resolveUniversalInput(args).error, /变体/);
    assert.equal(context.state.connections[0].id, 'old');
});

test('full reference capacity rejects a pending new source and dynamic text split outputs retain their actual type', () => {
    const context = setup(), full = { id: 'full', type: 'ImageGenerate', data: { imageList: ['1','2','3','4','5'] } };
    context.state.nodes.set(full.id, full);
    context.state.connections = [{ id: 'full-edge', from: { nodeId: full.id, port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image' }];
    const pending = { id: 'pending', type: 'ImageGenerate', data: {} };
    assert.match(resolveUniversalInput({ ...context, sourceNode: pending, sourcePort: 'image' }).error, /最多.*5/);
    context.state.connections = [];
    const sourceNode = { id: 'split', type: 'TextSplit', data: { outputCount: 3 } };
    context.state.nodes.set(sourceNode.id, sourceNode);
    assert.equal(resolveUniversalInput({ ...context, sourceNode, sourcePort: 'part_3' }).port, 'prompt');
    assert.match(resolveUniversalInput({ ...context, sourceNode, sourcePort: 'part_4' }).error, /输出/);
    sourceNode.data.mergeOutputEnabled = true;
    assert.equal(resolveUniversalInput({ ...context, sourceNode, sourcePort: 'text' }).port, 'prompt');
    assert.match(resolveUniversalInput({ ...context, sourceNode, sourcePort: 'part_1' }).error, /输出/);
});

test('new mask connections require one original and persist their consumption rule separately from legacy masks', () => {
    const context = setup(), sourceNode = { id: 'source', type: 'ImageGenerate', data: { imageList: ['first','second'] } };
    context.state.nodes.set(sourceNode.id, sourceNode);
    const args = { ...context, sourceNode, sourcePort: 'image', role: 'mask' };
    assert.match(resolveUniversalInput(args).error, /单图/);
    sourceNode.data.imageList = [];
    assert.match(resolveUniversalInput(args).error, /单图/);
    sourceNode.data.imageList = ['first'];
    assert.equal(resolveUniversalInput(args).maskConsumption, 'single');
    const edge = { id: 'mask', from: { nodeId: sourceNode.id, port: 'image' }, to: { nodeId: 'target', port: 'mask' }, type: 'image' };
    assert.equal(serializeConnection(edge).maskConsumption, 'legacy-first');
    assert.equal(serializeConnection({ ...edge, maskConsumption: 'single' }).maskConsumption, 'single');
    assert.equal(edge.maskConsumption, undefined, 'saving does not mutate the loaded legacy graph');
});

test('execution rechecks full batches and preserves single mask safeguards after saving and reopening', () => {
    const { state, targetNode: node } = setup();
    const source = { id: 'source', type: 'ImageGenerate', data: { imageList: ['first','second'] } };
    state.nodes.set(source.id, source);
    const edge = { id: 'mask', from: { nodeId: source.id, port: 'image' }, to: { nodeId: node.id, port: 'mask' }, type: 'image', maskConsumption: 'single' };
    state.connections = [JSON.parse(JSON.stringify(serializeConnection(edge)))];
    assert.match(validateUniversalImageInputs({ state, node, inputs: { mask: ['first','second'] } }), /单图.*2/);
    state.connections[0].maskConsumption = 'legacy-first';
    assert.equal(validateUniversalImageInputs({ state, node, inputs: { mask: ['first','second'] } }), '', 'legacy mask continues to consume its first original');
    state.models[0].protocol = 'google';
    assert.equal(validateUniversalImageInputs({ state, node, inputs: { mask: ['first','second'] } }), '', 'unsupported legacy mask keeps its original ignored behavior');
    state.models[0].protocol = 'openai';
    state.connections[0].to.port = 'referenceImages';
    delete state.connections[0].maskConsumption;
    assert.match(validateUniversalImageInputs({ state, node, inputs: { referenceImages: ['1','2','3','4','5','6'] } }), /最多.*5.*6/);
    source.data.mediaIntegrity = { missingItems: [{ position: 0 }] };
    assert.match(validateUniversalImageInputs({ state, node, inputs: { referenceImages: ['second'] } }), /原图.*缺失/);
    delete source.data.mediaIntegrity;
    source.data.mediaAssetKeys = ['media:first','media:second'];
    source.data.imageList = ['second'];
    assert.match(validateUniversalImageInputs({ state, node, inputs: { referenceImages: ['second'] } }), /原图.*缺失/, 'a compacted legacy list cannot silently shift a missing original');
    source.enabled = false;
    assert.equal(validateUniversalImageInputs({ state, node, inputs: {} }), '');
});
