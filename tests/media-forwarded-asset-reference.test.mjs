import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaControllerApi } from '../js/features/media/media-controller.js';

test('preview forwards its upstream Media asset to its workflow-node owner without a node image copy', async () => {
    const source = { id: 'source', type: 'ImageGenerate', data: { mediaAssetKeys: ['media:source'] } };
    const preview = { id: 'preview', type: 'ImagePreview', data: {} };
    const nodes = new Map([[source.id, source], [preview.id, preview]]);
    const references = [];
    let legacySaves = 0;
    const api = createMediaControllerApi({
        state: { nodes, connections: [{ from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'preview', port: 'image' } }] },
        getNodeById: (id) => nodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        referenceMediaAsset: async (...args) => { references.push(args); return true; },
        removeMediaReference: async () => true,
        saveImageAsset: async () => { legacySaves += 1; return true; },
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0,
        getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });

    await api.syncImagePreviewNode('preview', 'data:image/png;base64,cHJldmlldw==');

    assert.deepEqual(references, [['workflow-node', 'workflow-a:preview', 'media:source']]);
    assert.deepEqual(preview.data.mediaAssetKeys, ['media:source']);
    assert.equal(legacySaves, 0);
});

test('display node restores an ordered Media asset reference list without a legacy node asset', async () => {
    const preview = { id: 'preview', type: 'ImagePreview', data: { mediaAssetKeys: ['media:first', 'media:second'], imageCount: 2 } };
    const nodes = new Map([[preview.id, preview]]);
    const reads = [];
    const api = createMediaControllerApi({
        state: { nodes, connections: [] }, getNodeById: (id) => nodes.get(id),
        getImageAsset: async (key) => { reads.push(key); return `data:image/png;base64,${key.slice(6)}`; },
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });

    assert.deepEqual((await api.getNodeFullscreenImageContext('preview')).images, [
        'data:image/png;base64,first', 'data:image/png;base64,second'
    ]);
    assert.deepEqual(reads, ['media:first', 'media:second']);
});

test('preview releases its previous forwarded owner when the next upstream has no Media asset', async () => {
    const source = { id: 'source', type: 'ImageGenerate', data: {} };
    const preview = { id: 'preview', type: 'ImagePreview', data: { mediaAssetKeys: ['media:previous'] } };
    const nodes = new Map([[source.id, source], [preview.id, preview]]);
    const releases = [];
    const api = createMediaControllerApi({
        state: { nodes, connections: [{ from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'preview', port: 'image' } }] },
        getNodeById: (id) => nodes.get(id), getActiveWorkflowId: () => 'workflow-a',
        referenceMediaAsset: async () => true,
        removeMediaReference: async (...args) => { releases.push(args); return true; },
        saveImageAsset: async () => true,
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });
    await api.syncImagePreviewNode('preview', 'data:image/png;base64,bGVnYWN5');
    assert.deepEqual(releases, [['workflow-node', 'workflow-a:preview', 'media:previous']]);
    assert.equal('mediaAssetKeys' in preview.data, false);
});
