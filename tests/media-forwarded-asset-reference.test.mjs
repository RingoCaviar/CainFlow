import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaControllerApi } from '../js/features/media/media-controller.js';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';

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

test('preview retains its previous durable owner until an unowned replacement is persisted', async () => {
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
    assert.deepEqual(releases, []);
    assert.deepEqual(preview.data.mediaAssetKeys, ['media:previous']);
});

test('preview retains repeated Media asset keys in its ordered reference list while creating one owner reference', async () => {
    const source = { id: 'source', type: 'ImageGenerate', data: { mediaAssetKeys: ['media:shared', 'media:shared'] } };
    const preview = { id: 'preview', type: 'ImagePreview', data: {} };
    const nodes = new Map([[source.id, source], [preview.id, preview]]);
    const references = [];
    const api = createMediaControllerApi({
        state: { nodes, connections: [{ from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'preview', port: 'image' } }] },
        getNodeById: (id) => nodes.get(id), getActiveWorkflowId: () => 'workflow-a',
        referenceMediaAsset: async (...args) => { references.push(args); return true; }, removeMediaReference: async () => true,
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null, showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });
    await api.syncImagePreviewNode('preview', ['data:image/png;base64,YQ==', 'data:image/png;base64,YQ==']);
    assert.deepEqual(preview.data.mediaAssetKeys, ['media:shared', 'media:shared']);
    assert.deepEqual(references, [['workflow-node', 'workflow-a:preview', 'media:shared']]);
});

test('preview persists an unowned in-memory image so it survives an app restart', async () => {
    const image = 'data:image/png;base64,cGVyc2lzdGVkLXByZXZpZXc=';
    const preview = { id: 'preview', type: 'ImagePreview', data: {} };
    const nodes = new Map([[preview.id, preview]]);
    const storedAssets = new Map();
    const api = createMediaControllerApi({
        state: { nodes, connections: [] },
        getNodeById: (id) => nodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        saveWorkflowNodeMediaAsset: async (value, workflowId, nodeId) => {
            assert.equal(workflowId, 'workflow-a');
            assert.equal(nodeId, 'preview');
            storedAssets.set('media:preview', value);
            return { asset_key: 'media:preview' };
        },
        getImageAsset: async (key) => storedAssets.get(key) || null,
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });

    await api.syncImagePreviewNode('preview', image);

    assert.deepEqual(preview.data.mediaAssetKeys, ['media:preview']);
    const sessionStorage = new Map();
    const workflowData = { workflowId: 'workflow-a', nodes: [preview], connections: [] };
    const sessionManager = createSessionManagerApi({
        state: {
            workflowTabs: [{ workflowId: 'workflow-a', name: 'Restart test', data: workflowData }],
            workflowOrder: [], workflowFolders: [], workflowSidebarWidth: 320,
            dragging: null, resizing: null, themeId: 'light', globalAnimationEnabled: true,
            undoStack: []
        },
        storageKey: 'session',
        nodeSerializer: { buildStatePayload: () => workflowData },
        localStorageRef: {
            getItem: (key) => sessionStorage.get(key) || null,
            setItem: (key, value) => sessionStorage.set(key, value)
        },
        documentRef: { getElementById: () => null },
        showToast: () => {}, addNode: () => {}, updateAllConnections: () => {}, updatePortStyles: () => {},
        getWorkflowSnapshot: () => ({
            active: { workflowId: 'workflow-a', label: 'Restart test' },
            open: [{ workflowId: 'workflow-a', label: 'Restart test', pendingExplicitSave: false, running: false }]
        })
    });
    assert.equal(sessionManager.saveState(), true);

    const restartedPreview = JSON.parse(sessionStorage.get('session')).workflowTabs[0].data.nodes[0];
    const restartedNodes = new Map([[restartedPreview.id, restartedPreview]]);
    const restartedApi = createMediaControllerApi({
        state: { nodes: restartedNodes, connections: [] },
        getNodeById: (id) => restartedNodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        getImageAsset: async (key) => storedAssets.get(key) || null,
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });
    const restored = await restartedApi.getNodeFullscreenImageContext(restartedPreview.id);
    assert.deepEqual(restored.images, [image]);
});

test('preview persists every unowned image in an ordered batch', async () => {
    const images = [
        'data:image/png;base64,Zmlyc3Q=',
        'data:image/png;base64,c2Vjb25k'
    ];
    const preview = { id: 'preview', type: 'ImagePreview', data: {} };
    const nodes = new Map([[preview.id, preview]]);
    const api = createMediaControllerApi({
        state: { nodes, connections: [] },
        getNodeById: (id) => nodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        saveWorkflowNodeMediaAssets: async (values) => values.map((_, index) => ({
            asset_key: `media:preview-${index + 1}`,
            mediaTemporaryOwnerId: 'preview-operation'
        })),
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });

    await api.syncImagePreviewNode('preview', images);

    assert.deepEqual(preview.data.mediaAssetKeys, ['media:preview-1', 'media:preview-2']);
    assert.deepEqual(preview.data.mediaOwnershipTemporaryOwners, [{
        ownerId: 'preview-operation',
        assetKeys: ['media:preview-1', 'media:preview-2']
    }]);
});

test('a stale preview write cannot replace the newest image restored after restart', async () => {
    const preview = { id: 'preview', type: 'ImagePreview', data: {} };
    const nodes = new Map([[preview.id, preview]]);
    const writes = new Map();
    const released = [];
    const api = createMediaControllerApi({
        state: { nodes, connections: [] }, getNodeById: (id) => nodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        saveWorkflowNodeMediaAsset: (image) => new Promise((resolve) => writes.set(image, resolve)),
        removeMediaReference: async (...args) => { released.push(args); return true; },
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });
    const firstImage = 'data:image/png;base64,Zmlyc3Q=';
    const secondImage = 'data:image/png;base64,c2Vjb25k';

    const firstSync = api.syncImagePreviewNode('preview', firstImage);
    const secondSync = api.syncImagePreviewNode('preview', secondImage);
    await new Promise((resolve) => setImmediate(resolve));
    writes.get(secondImage)({ asset_key: 'media:second', mediaTemporaryOwnerId: 'operation-second' });
    await secondSync;
    writes.get(firstImage)({ asset_key: 'media:first', mediaTemporaryOwnerId: 'operation-first' });
    await firstSync;

    assert.deepEqual(preview.data.mediaAssetKeys, ['media:second']);
    assert.deepEqual(released, [['workflow-operation', 'operation-first', 'media:first']]);
});

test('a stale rejected preview write cannot clear the newest persisted image', async () => {
    const preview = { id: 'preview', type: 'ImagePreview', data: {} };
    const nodes = new Map([[preview.id, preview]]);
    const writes = new Map();
    const notices = [];
    const api = createMediaControllerApi({
        state: { nodes, connections: [] }, getNodeById: (id) => nodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        saveWorkflowNodeMediaAsset: (image) => new Promise((resolve, reject) => writes.set(image, { resolve, reject })),
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        showToast: (...args) => notices.push(args), addLog: () => {}, scheduleSave: () => {}
    });
    const firstImage = 'data:image/png;base64,Zmlyc3Q=';
    const secondImage = 'data:image/png;base64,c2Vjb25k';

    const firstSync = api.syncImagePreviewNode('preview', firstImage);
    const secondSync = api.syncImagePreviewNode('preview', secondImage);
    await new Promise((resolve) => setImmediate(resolve));
    writes.get(secondImage).resolve({ asset_key: 'media:second' });
    await secondSync;
    writes.get(firstImage).reject(new Error('stale disk failure'));
    await firstSync;

    assert.equal(preview.data.imageAssetKey, 'media:second');
    assert.equal(preview.data.imageAssetReady, true);
    assert.deepEqual(notices, []);
});

test('preview keeps the in-memory image and warns when persistent storage rejects the write', async () => {
    const image = 'data:image/png;base64,dmlzaWJsZQ==';
    const preview = { id: 'preview', type: 'ImagePreview', data: {} };
    const nodes = new Map([[preview.id, preview]]);
    const notices = [];
    const api = createMediaControllerApi({
        state: { nodes, connections: [] }, getNodeById: (id) => nodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        saveWorkflowNodeMediaAsset: async () => { throw new Error('disk unavailable'); },
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        showToast: (...args) => notices.push(args), addLog: () => {}, scheduleSave: () => {}
    });

    await assert.doesNotReject(api.syncImagePreviewNode('preview', image));

    assert.deepEqual(preview.data.imageList, [image]);
    assert.equal(preview.data.imageAssetKey, undefined);
    assert.match(notices[0][0], /图片预览保存失败/);
});

test('an unconnected save node persists its image so it survives an app restart', async () => {
    const image = 'data:image/png;base64,c2F2ZS1ub2RlLXJlc3RhcnQ=';
    const saveNode = { id: 'save', type: 'ImageSave', data: {} };
    const nodes = new Map([[saveNode.id, saveNode]]);
    const storedAssets = new Map();
    const api = createMediaControllerApi({
        state: { nodes, connections: [] }, getNodeById: (id) => nodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        saveWorkflowNodeMediaAsset: async (value) => {
            storedAssets.set('media:save', value);
            return { asset_key: 'media:save' };
        },
        getImageAsset: async (key) => storedAssets.get(key) || null,
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });

    await api.syncImageSaveNode('save', image);

    assert.deepEqual(saveNode.data.mediaAssetKeys, ['media:save']);
    const sessionStorage = new Map();
    const workflowData = { workflowId: 'workflow-a', nodes: [saveNode], connections: [] };
    const sessionManager = createSessionManagerApi({
        state: {
            workflowTabs: [{ workflowId: 'workflow-a', name: 'Save restart', data: workflowData }],
            workflowOrder: [], workflowFolders: [], workflowSidebarWidth: 320,
            dragging: null, resizing: null, themeId: 'light', globalAnimationEnabled: true,
            undoStack: []
        },
        storageKey: 'session', nodeSerializer: { buildStatePayload: () => workflowData },
        localStorageRef: {
            getItem: (key) => sessionStorage.get(key) || null,
            setItem: (key, value) => sessionStorage.set(key, value)
        },
        documentRef: { getElementById: () => null },
        showToast: () => {}, addNode: () => {}, updateAllConnections: () => {}, updatePortStyles: () => {},
        getWorkflowSnapshot: () => ({
            active: { workflowId: 'workflow-a', label: 'Save restart' },
            open: [{ workflowId: 'workflow-a', label: 'Save restart', pendingExplicitSave: false, running: false }]
        })
    });
    assert.equal(sessionManager.saveState(), true);

    const restartedSaveNode = JSON.parse(sessionStorage.get('session')).workflowTabs[0].data.nodes[0];
    const restartedNodes = new Map([[restartedSaveNode.id, restartedSaveNode]]);
    const restartedApi = createMediaControllerApi({
        state: { nodes: restartedNodes, connections: [] }, getNodeById: (id) => restartedNodes.get(id),
        getActiveWorkflowId: () => 'workflow-a', getImageAsset: async (key) => storedAssets.get(key) || null,
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });
    const restored = await restartedApi.getNodeFullscreenImageContext(restartedSaveNode.id);
    assert.deepEqual(restored.images, [image]);
});

test('an unconnected save node keeps its previous durable image when replacement storage fails', async () => {
    const replacement = 'data:image/png;base64,bmV3LWltYWdl';
    const saveNode = {
        id: 'save', type: 'ImageSave',
        data: { mediaAssetKeys: ['media:previous'], imageAssetKey: 'media:previous', imageAssetReady: true }
    };
    const nodes = new Map([[saveNode.id, saveNode]]);
    const notices = [];
    const releases = [];
    const api = createMediaControllerApi({
        state: { nodes, connections: [] }, getNodeById: (id) => nodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        saveWorkflowNodeMediaAsset: async () => { throw new Error('disk unavailable'); },
        removeMediaReference: async (...args) => { releases.push(args); return true; },
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        showToast: (...args) => notices.push(args), addLog: () => {}, scheduleSave: () => {}
    });

    await api.syncImageSaveNode('save', replacement);

    assert.deepEqual(saveNode.data.mediaAssetKeys, ['media:previous']);
    assert.equal(releases.length, 0);
    assert.match(notices[0][0], /保存节点图片持久化失败/);
});

test('unowned save-node writes request independent storage operations', async () => {
    const saveNode = { id: 'save', type: 'ImageSave', activeMediaOperationId: 'shared-run', data: {} };
    const nodes = new Map([[saveNode.id, saveNode]]);
    const requestedOperationIds = [];
    const api = createMediaControllerApi({
        state: { nodes, connections: [] }, getNodeById: (id) => nodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        saveWorkflowNodeMediaAsset: async (_image, _workflowId, _nodeId, operationId) => {
            requestedOperationIds.push(operationId);
            return { asset_key: `media:${requestedOperationIds.length}` };
        },
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });

    await api.syncImageSaveNode('save', 'data:image/png;base64,b25l');
    await api.syncImageSaveNode('save', 'data:image/png;base64,dHdv');

    assert.deepEqual(requestedOperationIds, [undefined, undefined]);
});

test('an unconnected save node preserves the order of multiple persisted images', async () => {
    const images = ['data:image/png;base64,b25l', 'data:image/png;base64,dHdv'];
    const saveNode = { id: 'save', type: 'ImageSave', data: {} };
    const nodes = new Map([[saveNode.id, saveNode]]);
    const storedAssets = new Map();
    const api = createMediaControllerApi({
        state: { nodes, connections: [] }, getNodeById: (id) => nodes.get(id),
        getActiveWorkflowId: () => 'workflow-a',
        saveWorkflowNodeMediaAssets: async (values) => values.map((value, index) => {
            const key = `media:save-${index + 1}`;
            storedAssets.set(key, value);
            return { asset_key: key };
        }),
        getImageAsset: async (key) => storedAssets.get(key) || null,
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        windowRef: { requestAnimationFrame: (callback) => callback(), setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
        estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {}
    });

    await api.syncImageSaveNode('save', images);
    saveNode.data.imageList = undefined;

    assert.deepEqual((await api.getNodeFullscreenImageContext('save')).images, images);
    assert.deepEqual(saveNode.data.mediaAssetKeys, ['media:save-1', 'media:save-2']);
});
