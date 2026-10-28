import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisplayImageMemoryManager } from '../js/features/media/display-image-memory-manager.js';

function fixture() {
    const nodes = Array.from({ length: 6 }, (_, index) => ({ id: `merge-${index}`, type: 'ImageMerge', x: 6000, y: index * 10,
        imagePreviewIndex: 17, data: { imageList: Array.from({ length: 64 }, (_, slot) => `original-${slot}`),
            mediaAssetKeys: Array.from({ length: 64 }, (_, slot) => `media:original-${slot}`), imageCount: 64, imageAssetReady: true },
        el: { classList: { contains: () => false }, querySelector: () => ({ getAttribute: () => 'visible-preview' }) } }));
    const state = { nodes: new Map(nodes.map(node => [node.id, node])), connections: [], canvas: { x: 0, y: 0, zoom: 1 }, selectedNodes: new Set(), runningNodeIds: new Set() };
    const reads = [], released = [];
    const api = createDisplayImageMemoryManager({ state, getNodeById: id => state.nodes.get(id),
        normalizeImageList: value => Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [],
        documentRef: { getElementById: () => null }, windowRef: { setTimeout() {} },
        canvasContainer: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
        restoreImageMergePreview: async node => { reads.push(node.data.mediaAssetKeys[node.imagePreviewIndex]); return true; },
        releaseImageMergePreview: node => released.push(node.id),
        getImageAsset: async () => { throw new Error('a preview sweep must not hydrate a complete canonical batch'); } });
    return { nodes, state, api, reads, released };
}

test('Merge shares the existing offscreen release and four-node restore budget without dropping references or hydrating full batches', async () => {
    const { nodes, api, reads, released } = fixture();
    const originalKeys = nodes.map(node => node.data.mediaAssetKeys.slice());
    assert.equal((await api.sweep()).released, 6);
    assert.equal(released.length, 6);
    for (const [index, node] of nodes.entries()) {
        assert.equal(node.data.imageMemoryReleased, true); assert.equal(node.data.imageList, undefined);
        assert.deepEqual(node.data.mediaAssetKeys, originalKeys[index]); assert.equal(node.imagePreviewIndex, 17);
        node.x = 10;
    }
    assert.equal((await api.sweep()).restored, api.maxRestorePerSweep);
    assert.equal(reads.length, 4); assert.ok(reads.every(key => key === 'media:original-17'));
    assert.equal((await api.sweep()).restored, 2);
    assert.equal(reads.length, 6);
    for (const [index, node] of nodes.entries()) {
        assert.deepEqual(node.data.mediaAssetKeys, originalKeys[index]); assert.equal(node.data.imageList, undefined);
        assert.equal(node.data.imageCount, 64); assert.equal(node.data.imageMemoryReleased, undefined);
    }
});

test('selected, running and fullscreen Merge previews retain their current pixels under the existing protection rules', async () => {
    const { nodes, state, api, released } = fixture();
    state.selectedNodes.add(nodes[0].id); state.runningNodeIds.add(nodes[1].id); api.beginFullscreenPreview(nodes[2].id);
    assert.equal((await api.sweep()).released, 3);
    for (const node of nodes.slice(0, 3)) assert.equal(node.data.imageList.length, 64);
    assert.deepEqual(released.sort(), nodes.slice(3).map(node => node.id));
});

test('a compacted legacy Merge derives its full preview count from durable references even without a redundant saved count', () => {
    const { nodes, api } = fixture();
    delete nodes[0].data.imageList; delete nodes[0].data.imageCount;
    assert.equal(api.getStoredImageCount(nodes[0]), 64);
});
