import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUniversalInput, getUniversalInputRoles, planMoveMergeInput, validateUniversalImageInputs } from '../js/nodes/universal-input-policy.js';
import { collectConnectionSnapshotsForNodes, appendMappedConnectionSnapshots } from '../js/canvas/connection-copy-utils.js';

function setup() {
    const node = { id: 'merge', type: 'ImageMerge', data: { inputCount: 1 } };
    const sources = ['a', 'b', 'c', 'new'].map(id => ({ id, type: 'ImageGenerate', data: { imageList: ['same', `${id}-second`] } }));
    const edge = (source, position) => ({ id: source, from: { nodeId: source, port: 'image' },
        to: { nodeId: node.id, port: `image_${position}`, extra: 'keep' }, type: 'image', order: position + 10, extension: { source } });
    const state = { nodes: new Map([node, ...sources].map(item => [item.id, item])), connections: [edge('c', 10), edge('a', 2), edge('b', 7)], runningNodeIds: new Set() };
    return { state, node, sources };
}

test('Merge allocates an append-only dynamic role without renumbering sparse existing inputs', () => {
    const { state, node, sources } = setup();
    const before = structuredClone(state.connections);
    const args = { state, sourceNode: sources[3], sourcePort: 'image', targetNode: node };
    assert.equal(resolveUniversalInput(args).port, 'image_11');
    assert.equal(resolveUniversalInput(args).multiple, false);
    assert.equal(getUniversalInputRoles(node, state).at(-1)[0], 'image_11');
    assert.match(resolveUniversalInput({ ...args, sourceNode: sources[0] }).error, /重复/);
    assert.match(resolveUniversalInput({ ...args, role: 'image_7' }).error, /占用/);
    assert.equal(resolveUniversalInput({ ...args, role: 'image_7', ignoreConnectionId: 'b' }).error, '');
    assert.match(resolveUniversalInput({ ...args, sourceNode: { id: 'text', type: 'Text' }, sourcePort: 'text' }).error, /不兼容/);
    assert.deepEqual(state.connections, before);
});

test('moving a Merge source swaps adjacent numeric slots atomically and preserves edge identity and extensions', () => {
    const { state } = setup(), before = structuredClone(state.connections);
    const plan = planMoveMergeInput({ state, connectionId: 'c', direction: -1 });
    assert.equal(plan.error, '');
    assert.deepEqual(plan.connections.map(edge => edge.to.port), ['image_7', 'image_2', 'image_10']);
    assert.deepEqual(plan.connections.map(edge => ({ ...edge, to: { ...edge.to, port: before.find(old => old.id === edge.id).to.port } })), before);
    assert.deepEqual(state.connections, before);
    assert.equal(planMoveMergeInput({ state, connectionId: 'a', direction: -1 }).connections, null);
    state.runningNodeIds.add('b');
    assert.match(planMoveMergeInput({ state, connectionId: 'c', direction: -1 }).error, /运行/);
    state.runningNodeIds.clear(); state.canvasPlanApplying = true;
    assert.match(planMoveMergeInput({ state, connectionId: 'c', direction: -1 }).error, /修改/);
    assert.deepEqual(state.connections, before);
});

test('copying Merge inputs preserves sparse roles and JSON edge and endpoint extensions independently', () => {
    const { state, node, sources } = setup();
    sources.forEach(source => { source.el = { classList: { contains: () => false }, querySelectorAll: () => [{ dataset: { port: 'image' } }] }; });
    const copied = { id: 'copy', type: 'ImageMerge', data: { inputCount: 11 }, el: { classList: { contains: () => false },
        querySelectorAll: () => getUniversalInputRoles(node, state).map(([port]) => ({ dataset: { port } })) } };
    state.nodes.set(copied.id, copied);
    const snapshot = collectConnectionSnapshotsForNodes(state, [node.id]);
    assert.deepEqual(snapshot.externalConnections, state.connections);
    const result = appendMappedConnectionSnapshots({ state, idMap: new Map([[node.id, copied.id]]), externalConnections: snapshot.externalConnections, includeExternalConnections: true });
    assert.equal(result.added, 3);
    for (const edge of state.connections.filter(edge => edge.to.nodeId === copied.id)) {
        const original = snapshot.externalConnections.find(item => item.from.nodeId === edge.from.nodeId);
        assert.deepEqual({ ...edge, id: original.id, to: { ...edge.to, nodeId: node.id } }, original);
        edge.extension.source = 'copy';
        assert.notEqual(original.extension.source, 'copy');
    }
});

test('Merge blocks incomplete enabled batches without shifting missing source slots', () => {
    const { state, node, sources } = setup();
    sources[0].data = { mediaAssetKeys: ['media:first', 'media:missing', 'media:last'], imageList: ['first', 'last'], imageCount: 3,
        mediaIntegrity: { missingItems: [{ position: 1 }] } };
    assert.match(validateUniversalImageInputs({ state, node, inputs: { image_2: ['first', 'last'], image_7: sources[1].data.imageList, image_10: sources[2].data.imageList } }), /缺失|完整/);
    sources[0].enabled = false;
    assert.equal(validateUniversalImageInputs({ state, node, inputs: { image_7: sources[1].data.imageList, image_10: sources[2].data.imageList } }), '');
    Object.assign(sources[1], { type: 'ImageImport', importMode: 'url', imageUrl: 'https://example.test/current.png' });
    assert.equal(validateUniversalImageInputs({ state, node, inputs: { image_7: [sources[1].imageUrl], image_10: sources[2].data.imageList } }), '', 'inactive upload drafts do not become active URL batch slots');
});
