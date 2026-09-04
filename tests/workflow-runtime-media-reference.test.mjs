import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeForwardedMediaReferenceApi } from '../js/features/workflow/workflow-runtime-manager.js';

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
