import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaControllerApi } from '../js/features/media/media-controller.js';

test('workflow run readiness waits for the current ImageImport Media write', async () => {
    const node = {
        id: 'import', type: 'ImageImport', importMode: 'upload', enabled: true,
        imageImportAssetKey: 'media:old',
        data: { imageImportAssetKey: 'media:old', mediaAssetKeys: ['media:old'], image: 'data:image/png;base64,T0xE' }
    };
    const nodes = new Map([[node.id, node]]);
    let finishWrite;
    const pendingWrite = new Promise((resolve) => { finishWrite = resolve; });
    const api = createMediaControllerApi({
        state: { nodes, connections: [], selectedNodes: new Set(), runningNodeIds: new Set() },
        getNodeById: (id) => nodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        saveWorkflowImportMediaAsset: async () => {
            await pendingWrite;
            return { asset_key: 'media:new', mediaOperationId: 'operation-new' };
        },
        getImageAsset: async () => null,
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0,
        getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {},
        refreshDependentImageResizePreviews: async () => {}
    });

    const importing = api.loadImageData(node.id, 'data:image/png;base64,TkVX');
    await Promise.resolve();
    let runReady = false;
    const readiness = api.waitForPendingImageImports().then(() => { runReady = true; });
    await Promise.resolve();

    assert.equal(runReady, false);
    assert.equal(node.data.image, 'data:image/png;base64,TkVX');
    assert.equal(node.imageImportAssetKey, undefined);
    assert.equal(node.data.imageImportAssetKey, undefined);
    assert.equal(node.data.mediaAssetKeys, undefined);

    finishWrite();
    await Promise.all([importing, readiness]);

    assert.equal(runReady, true);
    assert.equal(node.imageImportAssetKey, 'media:new');
    assert.equal(node.data.imageImportAssetKey, 'media:new');
    assert.deepEqual(node.data.mediaAssetKeys, ['media:new']);
});

test('a late previous ImageImport write cannot replace the newest imported image', async () => {
    const node = { id: 'import', type: 'ImageImport', importMode: 'upload', enabled: true, data: {} };
    const nodes = new Map([[node.id, node]]);
    const writes = [];
    const released = [];
    const api = createMediaControllerApi({
        state: { nodes, connections: [], selectedNodes: new Set(), runningNodeIds: new Set() },
        getNodeById: (id) => nodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        saveWorkflowImportMediaAsset: (imageData) => new Promise((resolve) => {
            writes.push({ imageData, resolve });
        }),
        removeMediaReference: async (...args) => { released.push(args); return true; },
        getImageAsset: async () => null,
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0,
        getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });

    const first = api.loadImageData(node.id, 'data:image/png;base64,RklSU1Q=');
    const second = api.loadImageData(node.id, 'data:image/png;base64,U0VDT05E');
    assert.equal(writes.length, 2);

    writes[1].resolve({ asset_key: 'media:second', mediaTemporaryOwnerId: 'owner:second' });
    await second;
    writes[0].resolve({ asset_key: 'media:first', mediaTemporaryOwnerId: 'owner:first' });
    await first;
    await api.waitForPendingImageImports();

    assert.equal(node.data.image, 'data:image/png;base64,U0VDT05E');
    assert.equal(node.imageImportAssetKey, 'media:second');
    assert.deepEqual(node.data.mediaAssetKeys, ['media:second']);
    assert.deepEqual(released, [['workflow-operation', 'owner:first', 'media:first']]);
});

test('workflow run readiness waits for every overlapping ImageImport write', async () => {
    const node = { id: 'import', type: 'ImageImport', importMode: 'upload', enabled: true, data: {} };
    const nodes = new Map([[node.id, node]]);
    const writes = [];
    const api = createMediaControllerApi({
        state: { nodes, connections: [], selectedNodes: new Set(), runningNodeIds: new Set() },
        getNodeById: (id) => nodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        saveWorkflowImportMediaAsset: () => new Promise((resolve) => { writes.push({ resolve }); }),
        removeMediaReference: async () => true,
        getImageAsset: async () => null,
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0,
        getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });

    const first = api.loadImageData(node.id, 'data:image/png;base64,RklSU1Q=');
    const second = api.loadImageData(node.id, 'data:image/png;base64,U0VDT05E');
    let runReady = false;
    const readiness = api.waitForPendingImageImports().then(() => { runReady = true; });

    writes[1].resolve({ asset_key: 'media:second', mediaTemporaryOwnerId: 'owner:second' });
    await second;
    await Promise.resolve();
    assert.equal(runReady, false);

    writes[0].resolve({ asset_key: 'media:first', mediaTemporaryOwnerId: 'owner:first' });
    await Promise.all([first, readiness]);
    assert.equal(runReady, true);
    assert.equal(node.imageImportAssetKey, 'media:second');
});
