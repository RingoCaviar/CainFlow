import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaControllerApi } from '../js/features/media/media-controller.js';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';

function harness(data = {}, dependencies = {}) {
    const node = { id: 'merge', type: 'ImageMerge', data, imagePreviewIndex: 1, el: { id: 'merge', querySelector: () => null } };
    const state = { nodes: new Map([[node.id, node]]), connections: [], selectedNodeIds: new Set() };
    const documentRef = { activeElement: null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
    const api = createMediaControllerApi({ state, getNodeById: id => state.nodes.get(id), documentRef,
        windowRef: { requestAnimationFrame: () => 1, setTimeout: () => 1, clearTimeout() {} },
        getActiveWorkflowId: () => 'workflow-a', referenceMediaAsset: async () => true, removeMediaReference: async () => true,
        getImageResolution: async () => '', estimateDataUrlSize: () => 10, scheduleSave() {}, showToast() {}, addLog() {}, ...dependencies });
    const addSource = (id, port, images, keys, missing = []) => {
        const source = { id, type: 'ImageGenerate', data: { imageList: images, mediaAssetKeys: keys, imageAssetReady: true,
            ...(missing.length ? { mediaIntegrity: { state: 'missing', missingItems: missing.map(position => ({ position, assetKey: keys[position] })) } } : {}) } };
        state.nodes.set(id, source); state.connections.push({ id, from: { nodeId: id, port: 'image' }, to: { nodeId: node.id, port } });
        return source;
    };
    return { api, node, state, documentRef, addSource };
}

test('merge expands complete sources by numeric image_N order and preserves browsing independently', async () => {
    const { api, node, addSource } = harness();
    const ten = addSource('ten', 'image_10', ['ten-a', 'ten-b'], ['media:ten-a', 'media:ten-b']);
    const two = addSource('two', 'image_2', ['two-a', 'two-b'], ['media:two-a', 'media:two-b']);
    await api.syncImageMergeNode(node.id);
    assert.deepEqual(node.data.imageList, ['two-a', 'two-b', 'ten-a', 'ten-b']);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:two-a', 'media:two-b', 'media:ten-a', 'media:ten-b']);
    assert.equal(node.imagePreviewIndex, 1);
    assert.deepEqual(ten.data.imageList, ['ten-a', 'ten-b']);
    assert.deepEqual(two.data.imageList, ['two-a', 'two-b']);
});

test('merge with no current inputs keeps its complete retained output and media identity', async () => {
    const { api, node } = harness({ imageList: ['previous-a', 'previous-b'], mediaAssetKeys: ['media:a', 'media:b'], imageCount: 2, imageAssetReady: true });
    await api.syncImageMergeNode(node.id);
    assert.deepEqual(node.data.imageList, ['previous-a', 'previous-b']);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:a', 'media:b']);
    assert.equal(node.imagePreviewIndex, 1);
    assert.equal(node.mergeInputState, 'stale');
});

test('merge retains missing source positions in its ordered media reference list', async () => {
    const { api, node, addSource } = harness();
    node.imagePreviewIndex = 3;
    addSource('two', 'image_2', ['two-a', 'two-c'], ['media:two-a', 'media:two-b', 'media:two-c'], [1]);
    addSource('ten', 'image_10', ['ten-a'], ['media:ten-a']);
    await api.syncImageMergeNode(node.id);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:two-a', 'media:two-b', 'media:two-c', 'media:ten-a']);
    assert.equal(node.data.imageCount, 4);
    assert.deepEqual(node.data.mediaIntegrity.missingItems.map(item => item.position), [1]);
    assert.deepEqual(node.data.imageList, ['two-a', 'two-c', 'ten-a']);
    assert.equal(node.mergeInputState, 'stale');
    assert.equal(node.imagePreviewIndex, 3, 'the last real slot remains selected after a missing middle slot');
});

test('merge execution preserves the browsing index while delivering all sources in numeric order', async () => {
    const { node, state, documentRef } = harness();
    const received = [];
    const api = createExecutionCoreApi({ state: { ...state, models: [], providers: [] }, nodeConfigs: {}, documentRef, windowRef: { requestAnimationFrame: () => 1 },
        syncImageMergeNode: async (_id, images) => received.push(images), refreshDependentImageResizePreviews: async () => {} });
    await api.nodeHandlers.ImageMerge(node, { image_10: ['ten-a', 'ten-b'], image_2: ['two-a', 'two-b'] });
    assert.deepEqual(node.data.imageList, ['two-a', 'two-b', 'ten-a', 'ten-b']);
    assert.equal(node.imagePreviewIndex, 1);
    assert.deepEqual(received, [node.data.imageList]);
});

test('merge persists its exact batch through the existing asset writer if forwarded references cannot be acquired', async () => {
    const writes = [];
    const { api, node, addSource } = harness({}, {
        referenceMediaAsset: async () => false,
        saveWorkflowNodeMediaAssets: async images => { writes.push(images); return images.map(image => ({ asset_key: `media:${image}`, mediaTemporaryOwnerId: 'merge-operation' })); }
    });
    addSource('one', 'image_1', ['one', 'two'], ['media:one', 'media:two']);
    await api.syncImageMergeNode(node.id);
    assert.deepEqual(writes, [['one', 'two']]);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:one', 'media:two']);
    assert.equal(node.data.imageAssetReady, true);
});

test('merge execution rejects a missing slot while retaining the previous complete batch', async () => {
    const { api: media, node, state, documentRef } = harness({ imageList: ['old-a', 'old-b'], mediaAssetKeys: ['media:old-a', 'media:old-b'] });
    const api = createExecutionCoreApi({ state: { ...state, models: [], providers: [] }, nodeConfigs: {}, documentRef, windowRef: { requestAnimationFrame: () => 1 }, syncImageMergeNode: media.syncImageMergeNode });
    await assert.rejects(api.nodeHandlers.ImageMerge(node, { image_2: ['one', null, 'three'] }), error => error.inputPort === 'image_2');
    assert.deepEqual(node.data.imageList, ['old-a', 'old-b']);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:old-a', 'media:old-b']);
    assert.equal(node.mergeInputState, 'stale');
});

test('merge never pairs a pending source preview with its superseded media identity', async () => {
    const { api, node, addSource } = harness({}, {
        saveWorkflowNodeMediaAsset: async image => ({ asset_key: `media:${image}`, mediaTemporaryOwnerId: 'merge-operation' })
    });
    const source = addSource('source', 'image_1', ['current'], ['media:previous']);
    delete source.data.imageAssetReady;
    await api.syncImageMergeNode(node.id);
    assert.deepEqual(node.data.imageList, ['current']);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:current']);
    assert.deepEqual(source.data.mediaAssetKeys, ['media:previous'], 'the source persistence attempt retains its own authority');
});
