import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeLifecycleApi } from '../js/nodes/node-lifecycle.js';
import { imageGenerateNode } from '../js/nodes/types/image-generate.js';

const images = ['red', 'orange', 'blue'].map(value => `data:image/png;base64,${Buffer.from(value).toString('base64')}`);
function fixture({ missingFirst = false } = {}) {
    const children = [], nodesLayer = { children, appendChild(element) { children.push(element); } };
    const documentRef = { defaultView: { setTimeout: () => 0, clearTimeout: () => {}, requestAnimationFrame: callback => setTimeout(callback, 0) },
        createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
            querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, remove() {} }),
        getElementById: id => id === 'nodes-layer' ? nodesLayer : null, querySelectorAll: () => [] };
    const state = { nodes: new Map(), connections: [], selectedNodes: new Set(), nodeDefaults: {}, canvas: { zoom: 1, x: 0, y: 0 } };
    const lifecycle = createNodeLifecycleApi({ state, documentRef, nodesLayer, nodeConfigs: { ImageGenerate: imageGenerateNode },
        createNodeMarkup: () => '<div></div>', generateId: () => 'source', getImageAsset: async key => missingFirst && key.endsWith('0') ? null : images[Number(key.at(-1))], getImageAssetList: async () => images,
        bindNodeInteractions() {}, pushHistory() {}, scheduleSave() {}, showToast() {}, onConnectionsChanged() {}, updateAllConnections() {}, updatePortStyles() {}, getCacheSidebarActive: () => false, updateCacheUsage() {} });
    return { state, lifecycle };
}
for (const index of [0, 1]) test(`restoring a durable generated batch retains its explicit viewing index ${index}`, async () => {
    const { state, lifecycle } = fixture();
    lifecycle.addNode('ImageGenerate', 10, 20, { id: 'source', imagePreviewIndex: index, imageCount: 3, imageAssetKey: 'media:slot-0',
        mediaAssetKeys: ['media:slot-0', 'media:slot-1', 'media:slot-2'], imageAssetReady: true }, true);
    await lifecycle.waitForImageRestores();
    assert.equal(state.nodes.get('source').imagePreviewIndex, index);
    assert.deepEqual(state.nodes.get('source').data.mediaAssetKeys, ['media:slot-0', 'media:slot-1', 'media:slot-2']);
});
test('a missing first original does not move the saved third viewing slot forward', async () => {
    const { state, lifecycle } = fixture({ missingFirst: true });
    lifecycle.addNode('ImageGenerate', 10, 20, { id: 'source', imagePreviewIndex: 2, imageCount: 3, imageAssetKey: 'media:slot-0',
        mediaAssetKeys: ['media:slot-0', 'media:slot-1', 'media:slot-2'], imageAssetReady: true,
        mediaIntegrity: { state: 'missing', missingItems: [{ position: 0, assetKey: 'media:slot-0' }] } }, true);
    await lifecycle.waitForImageRestores();
    assert.equal(state.nodes.get('source').imagePreviewIndex, 2);
    assert.deepEqual(state.nodes.get('source').data.mediaAssetKeys, ['media:slot-0', 'media:slot-1', 'media:slot-2']);
});
test('an inline generated batch keeps its saved viewing index while legacy batches without an index keep the last-image default', async () => {
    for (const index of [1, undefined]) {
        const { state, lifecycle } = fixture();
        lifecycle.addNode('ImageGenerate', 10, 20, { id: 'source', imageList: images, ...(index !== undefined ? { imagePreviewIndex: index } : {}) }, true);
        await lifecycle.waitForImageRestores();
        assert.equal(state.nodes.get('source').imagePreviewIndex, index ?? 2);
    }
});
