import test from 'node:test';
import assert from 'node:assert/strict';

import { createMissingMediaBrowserActions } from '../js/features/media/missing-media-action-browser.js';

function browserFixture({ downloadRemoteMedia = async () => { throw new Error('network failed'); } } = {}) {
    const node = {
        id: 'node-a', type: 'ImageGenerate',
        data: {
            mediaAssetKeys: ['media:first', 'media:missing', 'media:shared'],
            imageTaskUrl: 'https://example.test/result.png',
            mediaIntegrity: { state: 'missing', mediaType: 'image', missingItems: [{ position: 1, assetKey: 'media:missing' }] }
        }
    };
    const state = { nodes: new Map([[node.id, node]]), runningNodeIds: new Set() };
    let revision = 4;
    let undoCount = 0;
    const expectations = [];
    const notices = [];
    const workflowManager = {
        getActiveWorkflowId: () => 'workflow-a',
        getActiveWorkflowSnapshot: () => ({ workflowId: 'workflow-a', mediaOwnershipRevision: revision }),
        expectNextMediaOwnerGeneration: (value) => expectations.push(value),
        clearExpectedMediaOwnerGeneration() {},
        saveActiveWorkflow: async () => { revision += 1; return true; }
    };
    const handle = createMissingMediaBrowserActions({
        state, workflowManager,
        getMediaOwnerReferenceList: async () => ({ generation: 2 }),
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        saveWorkflowNodeMediaAsset: async () => null,
        downloadRemoteMedia,
        pushHistory: () => { undoCount += 1; return 'undo-1'; },
        showToast: (...args) => notices.push(args),
        windowRef: { confirm: () => true },
        documentRef: { createElement: () => ({}) },
        FileReaderRef: class {}, createImageBitmapRef: async () => ({ close() {} }),
        URLRef: { createObjectURL: () => '', revokeObjectURL() {} }
    });
    return { handle, node, expectations, notices, getUndoCount: () => undoCount };
}

test('browser batch removal starts with explicit selections and records application Undo', async () => {
    const fixture = browserFixture();
    await fixture.handle({ action: 'remove-selected', node: fixture.node, positions: [1] });
    assert.deepEqual(fixture.node.data.mediaAssetKeys, ['media:first', 'media:shared']);
    assert.equal(fixture.getUndoCount(), 1);
    assert.equal(fixture.expectations[0].storageEpoch, 'epoch-1');
    assert.deepEqual(fixture.notices.at(-1), ['媒体操作已提交', 'success']);
});

test('browser remote failure retains the missing reference and does not touch shared owners', async () => {
    const fixture = browserFixture();
    await fixture.handle({
        action: 'remote-recover', node: fixture.node,
        item: { position: 1, assetKey: 'media:missing' }
    });
    assert.deepEqual(fixture.node.data.mediaAssetKeys, ['media:first', 'media:missing', 'media:shared']);
    assert.match(fixture.notices.at(-1)[0], /network failed/);
    assert.equal(fixture.expectations.length, 0);
});
