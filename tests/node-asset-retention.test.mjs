import assert from 'node:assert/strict';
import test from 'node:test';
import { collectRetainedNodeAssetIds } from '../js/features/media/node-asset-retention.js';

test('startup cleanup retains connected recoverable node assets in active and inactive workflows', () => {
    const retained = collectRetainedNodeAssetIds({
        nodes: new Map([
            ['preview', { id: 'preview', type: 'ImagePreview', data: { imageAssetKey: 'preview:current' } }],
            ['generate', { id: 'generate', type: 'ImageGenerate', data: { imageAssetKey: 'generate:legacy' } }]
        ]),
        workflowTabs: [{
            name: 'inactive',
            data: {
                nodes: [{ id: 'resize', type: 'ImageResize', imageAssetKey: 'resize:current' }],
                connections: [{ to: { nodeId: 'resize', port: 'image' } }]
            }
        }],
        activeWorkflowName: 'active'
    });

    assert.deepEqual(retained, new Set(['preview', 'preview:current', 'resize', 'resize:current']));
});

test('startup cleanup retains imported assets but not transient generator assets', () => {
    const retained = collectRetainedNodeAssetIds({
        nodes: new Map([
            ['import', { id: 'import', type: 'ImageInput', imageImportAssetKey: 'image-import:source' }],
            ['generate', { id: 'generate', type: 'ImageGenerate', data: { imageAssetKey: 'generate:legacy' } }]
        ]),
        workflowTabs: [],
        activeWorkflowName: 'active'
    });

    assert.deepEqual(retained, new Set(['image-import:source']));
});
