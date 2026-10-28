import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUniversalInput, getUniversalInputRoles, planCompareInputSwap } from '../js/nodes/universal-input-policy.js';
import { shouldRunNodeForEachInput, buildInputBatches } from '../js/features/execution/workflow-runner.js';
import { createNodeSerializer } from '../js/nodes/node-serializer.js';
import { serializeConnection } from '../js/canvas/connection-snapshot.js';
import { readPrimaryImageOutput } from '../js/nodes/image-output-projection.js';

test('Compare allocates the first empty durable role without reinterpreting loaded connections', () => {
    const targetNode = { id: 'compare', type: 'ImageCompare', data: {} };
    const sourceNode = { id: 'source', type: 'ImageGenerate', data: { imageList: ['first', 'second'] } };
    const state = { nodes: new Map([[targetNode.id, targetNode], [sourceNode.id, sourceNode]]), connections: [] };
    const args = { state, targetNode, sourceNode, sourcePort: 'image' };
    assert.deepEqual(getUniversalInputRoles(targetNode).map(role => role[0]), ['imageA', 'imageB']);
    assert.equal(resolveUniversalInput(args).port, 'imageA');
    const old = { id: 'old', from: { nodeId: 'old-source', port: 'image' }, to: { nodeId: targetNode.id, port: 'imageB' }, type: 'image', order: 9 };
    state.connections.push(old);
    assert.equal(resolveUniversalInput(args).port, 'imageA');
    assert.deepEqual(state.connections, [old]);
    state.connections.push({ ...old, id: 'a', to: { nodeId: targetNode.id, port: 'imageA' } });
    assert.match(resolveUniversalInput(args).error, /占用|已满/);
    assert.equal(resolveUniversalInput({ ...args, role: 'imageB', ignoreConnectionId: old.id }).error, '');
    assert.match(resolveUniversalInput({ ...args, sourceNode: { id: 'text', type: 'Text' }, sourcePort: 'text' }).error, /不兼容/);
    assert.deepEqual(sourceNode.data.imageList, ['first', 'second']);
});

test('Compare consumes the primary A/B inputs once while retaining both complete source batches', () => {
    const node = { type: 'ImageCompare' }, inputs = { imageA: ['a1', 'a2'], imageB: ['b1', 'b2', 'b3'] };
    assert.equal(shouldRunNodeForEachInput(node, inputs), false);
    assert.deepEqual(buildInputBatches(node, inputs), [inputs]);
    assert.deepEqual(inputs.imageB, ['b1', 'b2', 'b3']);
});

test('Compare divider endpoints and JSON edge extensions survive snapshots without aliasing', () => {
    for (const comparePosition of [0, 23, 100]) {
        const node = { id: 'compare', type: 'ImageCompare', data: { comparePosition } };
        const [saved] = createNodeSerializer({ state: { nodes: new Map([[node.id, node]]), connections: [], canvas: {} },
            documentRef: { getElementById: () => null, querySelectorAll: () => [] } }).serializeNodes();
        assert.equal(saved.comparePosition, comparePosition);
    }
    const edge = { id: 'b', from: { nodeId: 'source', port: 'image', extension: 'source' },
        to: { nodeId: 'compare', port: 'imageB' }, type: 'image', order: 4, extension: { nested: ['keep'] } };
    const snapshot = serializeConnection(edge);
    assert.deepEqual(snapshot, edge);
    snapshot.extension.nested.push('snapshot');
    assert.deepEqual(edge.extension.nested, ['keep']);
});

test('Compare swap validates the complete graph before changing any connection', () => {
    const node = { id: 'compare', type: 'ImageCompare' };
    const a = { id: 'a', type: 'ImageImport' }, b = { id: 'b', type: 'ImageGenerate' };
    const edges = ['a', 'b'].map((id, index) => ({ id: `edge-${id}`, from: { nodeId: id, port: 'image' },
        to: { nodeId: node.id, port: index ? 'imageB' : 'imageA', extra: 'keep' }, type: 'image', order: 9 - index, extension: { keep: id } }));
    const other = { id: 'unrelated', from: { nodeId: a.id, port: 'image' }, to: { nodeId: 'preview', port: 'image' }, type: 'image' };
    const state = { nodes: new Map([node, a, b].map(item => [item.id, item])), connections: [edges[0], other, edges[1]], runningNodeIds: new Set() };
    const planned = planCompareInputSwap({ state, node });
    assert.equal(planned.error, '');
    assert.deepEqual(planned.connections.map(edge => edge.to.port), ['imageB', 'image', 'imageA']);
    assert.equal(planned.connections[1], other);
    assert.deepEqual(state.connections.map(edge => edge.to.port), ['imageA', 'image', 'imageB']);
    assert.deepEqual(planned.connections[0], { ...edges[0], to: { ...edges[0].to, port: 'imageB' } });
    state.runningNodeIds.add(b.id);
    assert.match(planCompareInputSwap({ state, node }).error, /运行/);
    state.runningNodeIds.clear(); state.historyTransitionInProgress = true;
    assert.match(planCompareInputSwap({ state, node }).error, /修改|切换/);
    state.historyTransitionInProgress = false; b.type = 'Text';
    assert.match(planCompareInputSwap({ state, node }).error, /输出|类型/);
    assert.deepEqual(state.connections, [edges[0], other, edges[1]]);
});

test('primary processors resolve durable slot zero without substituting a compacted later image', async () => {
    const node = { type: 'ImageGenerate', data: { mediaAssetKeys: ['media:first', 'media:second'], imageCount: 2, imageList: ['later'],
        mediaIntegrity: { missingItems: [{ position: 0 }] } } };
    assert.equal(await readPrimaryImageOutput(node, node.data.imageList, async () => 'later'), null);
    node.data.mediaIntegrity.missingItems = [{ position: 1 }];
    const reads = [];
    assert.equal(await readPrimaryImageOutput(node, node.data.imageList, async key => { reads.push(key); return 'first'; }), 'first');
    assert.deepEqual(reads, ['media:first']);
    assert.deepEqual(node.data.imageList, ['later']);
    assert.equal(await readPrimaryImageOutput({ data: { imageList: [null, 'later'] } }, ['later']), null);
});
