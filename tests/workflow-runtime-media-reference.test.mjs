import assert from 'node:assert/strict';
import test from 'node:test';
import { commercePlanningPublicationKey, createRuntimeForwardedMediaReferenceApi } from '../js/features/workflow/workflow-runtime-manager.js';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';

test('background ImageImport forwards its Media asset to a preview workflow-node owner', async () => {
    const imported = { id: 'import', type: 'ImageImport', imageImportAssetKey: 'media:imported', data: {} };
    const preview = { id: 'preview', type: 'ImagePreview', data: {} };
    const runtimeState = {
        nodes: new Map([[imported.id, imported], [preview.id, preview]]),
        connections: [{ from: { nodeId: 'import', port: 'image' }, to: { nodeId: 'preview', port: 'image' } }]
    };
    const references = [];
    const api = createRuntimeForwardedMediaReferenceApi({
        runtimeState, workflowId: 'background-workflow',
        referenceMediaAsset: async (...args) => { references.push(args); return true; },
        removeMediaReference: async () => true
    });

    assert.deepEqual(api.getForwardedKeys('preview'), ['media:imported']);
    assert.equal(await api.syncForwardedKeys(preview, api.getForwardedKeys('preview')), true);
    assert.deepEqual(references, [['workflow-node', 'background-workflow:preview', 'media:imported']]);
    assert.deepEqual(preview.data.mediaAssetKeys, ['media:imported']);
});

test('running ImageImport resolves the current imported Media asset instead of stale inline output', async () => {
    const node = {
        id: 'import', type: 'ImageImport', importMode: 'upload',
        imageImportAssetKey: 'media:new',
        data: { imageImportAssetKey: 'media:new', image: 'data:image/png;base64,OLD' }
    };
    const api = createExecutionCoreApi({
        state: { nodes: new Map([['import', node]]), connections: [], models: [], providers: [] },
        nodeConfigs: {},
        documentRef: { getElementById: () => null }, windowRef: {}, fetchRef: async () => ({ ok: false }),
        getImageAsset: async (key) => key === 'media:new' ? 'data:image/png;base64,NEW' : null,
        refreshDependentImageResizePreviews: async () => {}
    });
    await api.executeNode(node, {}, null);
    assert.equal(node.data.image, 'data:image/png;base64,NEW');
});

test('running ImageImport prefers its durable Media reference over a stale compatibility pointer', async () => {
    const node = {
        id: 'import', type: 'ImageImport', importMode: 'upload',
        imageImportAssetKey: 'media:old',
        data: {
            mediaAssetKeys: ['media:new'],
            imageImportAssetKey: 'media:new',
            image: 'data:image/png;base64,OLD'
        }
    };
    const requestedKeys = [];
    const api = createExecutionCoreApi({
        state: { nodes: new Map([['import', node]]), connections: [], models: [], providers: [] },
        nodeConfigs: {},
        documentRef: { getElementById: () => null }, windowRef: {}, fetchRef: async () => ({ ok: false }),
        getImageAsset: async (key) => {
            requestedKeys.push(key);
            return key === 'media:new' ? 'data:image/png;base64,NEW' : null;
        },
        refreshDependentImageResizePreviews: async () => {}
    });

    await api.executeNode(node, {}, null);

    assert.deepEqual(requestedKeys, ['media:new']);
    assert.equal(node.data.image, 'data:image/png;base64,NEW');
    assert.equal(node.imageImportAssetKey, 'media:new');
    assert.deepEqual(node.data.mediaAssetKeys, ['media:new']);
});

test('commerce publication follows source identity and order across visible and saved workflow snapshots', () => {
    const commerce = { id: 'commerce', type: 'ECommerceImageSet', enabled: true };
    const upload = { id: 'upload', type: 'ImageImport', importMode: 'upload', imageImportAssetKey: 'media:original' };
    const url = { id: 'url', type: 'ImageImport', importMode: 'url', imageUrl: 'https://example.test/product.png' };
    const links = [upload, url].map(({ id }, order) => ({
        from: { nodeId: id, port: 'image' }, to: { nodeId: commerce.id, port: 'referenceImages' }, order
    }));
    const key = (nodes, connections = links) => commercePlanningPublicationKey(commerce.id, connections, id => nodes.find(node => node.id === id));
    const initial = key([commerce, upload, url]);

    assert.equal(key([{ ...commerce, customTitle: '商品套图' }, { ...upload, imagePreviewIndex: 1 }, url], links.toReversed()), initial);
    assert.notEqual(key([commerce, { ...upload, imageImportAssetKey: 'media:replacement' }, url]), initial);
    assert.notEqual(key([commerce, upload, { ...url, imageUrl: 'https://example.test/updated.png' }]), initial);
    assert.notEqual(key([commerce, upload, { ...url, enabled: false }]), initial);
    assert.notEqual(key([commerce, upload, url], links.map(link => ({ ...link, order: 1 - link.order }))), initial);
    assert.notEqual(key([{ ...commerce, commerceImageSet: { productInfo: { name: '商品' } } }, upload, url]), initial);
    assert.equal(key([{ ...commerce, enabled: false }, upload, url]), null);
    assert.equal(key([upload, url]), null);
});
