import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeForwardedMediaReferenceApi } from '../js/features/workflow/workflow-runtime-manager.js';
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
