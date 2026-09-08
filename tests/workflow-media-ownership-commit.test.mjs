import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createWorkflowMediaOwnershipCommitter,
    prepareWorkflowMediaOwnershipCommit
} from '../js/features/media/workflow-media-ownership-commit.js';

test('a persisted Workflow commits complete ordered Media asset owner lists before promotion', async () => {
    const workflow = {
        workflowId: 'workflow-a',
        nodes: [
            { id: 'generate', type: 'ImageGenerate', data: { mediaAssetKeys: ['media:first', 'media:first', 'media:second'] } },
            { id: 'import', type: 'ImageImport', data: { mediaAssetKeys: ['media:imported'] } }
        ]
    };
    const prepared = prepareWorkflowMediaOwnershipCommit(workflow);
    const calls = [];
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        recordMediaWorkflowRevision: async (...args) => { calls.push(['record', ...args]); return true; },
        getMediaOwnerReferenceList: async (_workflowId, ownerType) => ({ generation: ownerType === 'workflow-node' ? 4 : 2 }),
        replaceMediaOwnerReferenceList: async (request) => { calls.push(['replace', request]); return { status: 'committed' }; }
    });

    assert.equal(await committer.commitPersistedWorkflow(prepared), true);
    assert.deepEqual(calls[0], ['record', 'workflow-a', 1, 'epoch-1', [
        { ownerType: 'workflow-node', ownerId: 'generate', assetKeys: ['media:first', 'media:first', 'media:second'] },
        { ownerType: 'workflow-import', ownerId: 'import', assetKeys: ['media:imported'] }
    ]]);
    assert.deepEqual(calls.slice(1).map((call) => ({
        ownerType: call[1].ownerType,
        ownerId: call[1].ownerId,
        expectedGeneration: call[1].expectedGeneration,
        documentRevision: call[1].documentRevision,
        storageEpoch: call[1].storageEpoch,
        assetKeys: call[1].assetKeys
    })), [
        { ownerType: 'workflow-node', ownerId: 'generate', expectedGeneration: 4, documentRevision: 1, storageEpoch: 'epoch-1', assetKeys: ['media:first', 'media:first', 'media:second'] },
        { ownerType: 'workflow-import', ownerId: 'import', expectedGeneration: 2, documentRevision: 1, storageEpoch: 'epoch-1', assetKeys: ['media:imported'] }
    ]);
});

test('a workflow operation temporary owner is released only after formal promotion', async () => {
    const calls = [];
    const workflow = prepareWorkflowMediaOwnershipCommit({
        workflowId: 'workflow-a',
        nodes: [{ id: 'node', type: 'ImagePreview', data: {
            mediaAssetKeys: ['media:first', 'media:second'],
            mediaOwnershipTemporaryOwners: [{
                ownerId: 'workflow-a:node:operation-a', assetKeys: ['media:first', 'media:second']
            }]
        } }]
    });
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        recordMediaWorkflowRevision: async () => (calls.push('document'), true),
        getMediaOwnerReferenceList: async () => ({ generation: 0 }),
        replaceMediaOwnerReferenceList: async () => (calls.push('promote'), { status: 'committed' }),
        removeMediaReference: async (_type, _owner, key) => (calls.push(`release:${key}`), true)
    });

    assert.equal(await committer.commitPersistedWorkflow(workflow), true);
    assert.deepEqual(calls, ['document', 'promote', 'release:media:first', 'release:media:second']);
    assert.equal(workflow.nodes[0].data.mediaOwnershipTemporaryOwners, undefined);
});

test('overlapping operation owners are all compensated after the newest formal list is promoted', async () => {
    const released = [];
    const workflow = prepareWorkflowMediaOwnershipCommit({
        workflowId: 'workflow-a', nodes: [{ id: 'node', type: 'ImagePreview', data: {
            mediaAssetKeys: ['media:new'], mediaOwnershipTemporaryOwners: [
                { ownerId: 'workflow-a:node:old', assetKeys: ['media:old'] },
                { ownerId: 'workflow-a:node:new', assetKeys: ['media:new'] }
            ]
        } }]
    });
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        recordMediaWorkflowRevision: async () => true,
        getMediaOwnerReferenceList: async () => ({ generation: 2 }),
        replaceMediaOwnerReferenceList: async () => ({ status: 'committed' }),
        removeMediaReference: async (_type, ownerId, assetKey) => (released.push([ownerId, assetKey]), true)
    });

    assert.equal(await committer.commitPersistedWorkflow(workflow), true);
    assert.deepEqual(released, [
        ['workflow-a:node:old', 'media:old'], ['workflow-a:node:new', 'media:new']
    ]);
});

test('a stale owner promotion leaves the persisted Workflow commit unresolved', async () => {
    const prepared = prepareWorkflowMediaOwnershipCommit({
        workflowId: 'workflow-a',
        nodes: [{ id: 'node-a', type: 'ImageGenerate', data: { mediaAssetKeys: ['media:first'] } }]
    });
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        recordMediaWorkflowRevision: async () => true,
        getMediaOwnerReferenceList: async () => ({ generation: 3 }),
        replaceMediaOwnerReferenceList: async () => ({ status: 'stale', generation: 4 })
    });

    assert.equal(await committer.commitPersistedWorkflow(prepared), false);
});

test('Save As prepares an independent Workflow identity and revision', () => {
    const source = { workflowId: 'source', mediaOwnershipRevision: 7, nodes: [] };
    const copy = { ...source, workflowId: 'copy' };

    const prepared = prepareWorkflowMediaOwnershipCommit(copy, { newWorkflowIdentity: true });

    assert.equal(prepared.workflowId, 'copy');
    assert.equal(prepared.mediaOwnershipRevision, 1);
    assert.equal(source.mediaOwnershipRevision, 7);
});

test('an empty Media asset reference list remains in the document manifest to release the previous owner', async () => {
    const prepared = prepareWorkflowMediaOwnershipCommit({
        workflowId: 'workflow-a', nodes: [{ id: 'preview', type: 'ImagePreview', data: {} }]
    });
    const replacements = [];
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        recordMediaWorkflowRevision: async (_workflowId, _revision, _epoch, owners) => {
            assert.deepEqual(owners, [{ ownerType: 'workflow-node', ownerId: 'preview', assetKeys: [] }]);
            return true;
        },
        getMediaOwnerReferenceList: async () => ({ generation: 2, assetKeys: ['media:old'] }),
        replaceMediaOwnerReferenceList: async (request) => (replacements.push(request), { status: 'committed' })
    });
    assert.equal(await committer.commitPersistedWorkflow(prepared), true);
    assert.deepEqual(replacements[0].assetKeys, []);
});

test('a legacy ImageImport reference participates in its workflow-import manifest', async () => {
    const prepared = prepareWorkflowMediaOwnershipCommit({
        workflowId: 'workflow-a',
        nodes: [{ id: 'import', type: 'ImageImport', imageImportAssetKey: 'media:imported', data: {} }]
    });
    let manifest = null;
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        recordMediaWorkflowRevision: async (_workflowId, _revision, _epoch, owners) => (manifest = owners, true),
        getMediaOwnerReferenceList: async () => null,
        replaceMediaOwnerReferenceList: async () => ({ status: 'committed' })
    });
    assert.equal(await committer.commitPersistedWorkflow(prepared), true);
    assert.deepEqual(manifest, [{ ownerType: 'workflow-import', ownerId: 'import', assetKeys: ['media:imported'] }]);
});

test('a persisted Workflow reopened after interruption retries the same ownership revision', async () => {
    const prepared = prepareWorkflowMediaOwnershipCommit({
        workflowId: 'workflow-a', mediaOwnershipRevision: 4,
        nodes: [{ id: 'preview', type: 'ImagePreview', data: { mediaAssetKeys: ['media:first'] } }]
    });
    const requests = [];
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        recordMediaWorkflowRevision: async (_workflowId, revision) => (requests.push(['record', revision]), true),
        getMediaOwnerReferenceList: async () => ({ generation: 3 }),
        replaceMediaOwnerReferenceList: async (request) => (requests.push(['replace', request.documentRevision]), { status: 'already-committed' })
    });
    assert.equal(await committer.commitPersistedWorkflow({ ...prepared, mediaOwnershipRevision: 4 }), true);
    assert.deepEqual(requests, [['record', 4], ['replace', 4]]);
});

test('recovery reuses the original generation for an owner already promoted at the document revision', async () => {
    const prepared = { workflowId: 'workflow-a', mediaOwnershipRevision: 5,
        nodes: [{ id: 'first', type: 'ImagePreview', data: { mediaAssetKeys: ['media:first'] } }] };
    let request = null;
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        recordMediaWorkflowRevision: async () => true,
        getMediaOwnerReferenceList: async () => ({ generation: 8, documentRevision: 5 }),
        replaceMediaOwnerReferenceList: async (value) => (request = value, { status: 'already-committed' })
    });
    assert.equal(await committer.commitPersistedWorkflow(prepared), true);
    assert.equal(request.expectedGeneration, 7);
});

test('deleting a node commits an empty list for its previous Media asset owner', async () => {
    const manifests = [];
    let transition = null;
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        listMediaOwnerReferenceLists: async () => [{ ownerType: 'workflow-node', ownerId: 'deleted', generation: 2 }],
        recordMediaWorkflowRevision: async (_workflowId, _revision, _epoch, owners) => (manifests.push(...owners), true),
        getMediaOwnerReferenceList: async () => ({ generation: 2, documentRevision: 1 }),
        replaceMediaOwnerReferenceList: async (request) => (transition = request, { status: 'committed' })
    });
    assert.equal(await committer.commitPersistedWorkflow({
        workflowId: 'workflow-a', mediaOwnershipRevision: 2, nodes: []
    }), true);
    assert.deepEqual(manifests, [{ ownerType: 'workflow-node', ownerId: 'deleted', assetKeys: [], deleted: true }]);
    assert.equal(transition.operationId, 'workflow-delete:2');
    assert.equal(transition.intent, 'delete');
});

test('restoring a tombstoned node uses an explicit workflow-undo transition', async () => {
    let transition = null;
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        listMediaOwnerReferenceLists: async () => [{
            ownerType: 'workflow-node', ownerId: 'node', generation: 2, documentRevision: 2, tombstoned: true
        }],
        recordMediaWorkflowRevision: async () => true,
        getMediaOwnerReferenceList: async () => ({ generation: 2, documentRevision: 2, tombstoned: true }),
        replaceMediaOwnerReferenceList: async (request) => (transition = request, { status: 'committed' })
    });
    assert.equal(await committer.commitPersistedWorkflow({
        workflowId: 'workflow-a', mediaOwnershipRevision: 3,
        mediaOwnershipRestoreOwnerIds: [{ ownerId: 'workflow-node:node', documentRevision: 3 }],
        nodes: [{ id: 'node', type: 'ImagePreview', data: { mediaAssetKeys: ['media:first'] } }]
    }), true);
    assert.equal(transition.operationId, 'workflow-undo:3');
    assert.equal(transition.intent, 'undo');
});

test('a restore marker from an older document revision cannot authorize a recreated node', async () => {
    let promoted = false;
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        listMediaOwnerReferenceLists: async () => [{ ownerType: 'workflow-node', ownerId: 'node', tombstoned: true }],
        recordMediaWorkflowRevision: async () => true,
        getMediaOwnerReferenceList: async () => ({ generation: 4, documentRevision: 4, tombstoned: true }),
        replaceMediaOwnerReferenceList: async () => (promoted = true, { status: 'committed' })
    });

    assert.equal(await committer.commitPersistedWorkflow({
        workflowId: 'workflow-a', mediaOwnershipRevision: 5,
        mediaOwnershipRestoreOwnerIds: [{ ownerId: 'workflow-node:node', documentRevision: 3 }],
        nodes: [{ id: 'node', type: 'ImagePreview', data: { mediaAssetKeys: ['media:first'] } }]
    }), false);
    assert.equal(promoted, false);
});

test('a recreated node id without explicit Undo cannot restore a tombstoned consumer', async () => {
    let promoted = false;
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        listMediaOwnerReferenceLists: async () => [{ ownerType: 'workflow-node', ownerId: 'node', tombstoned: true }],
        recordMediaWorkflowRevision: async () => true,
        getMediaOwnerReferenceList: async () => ({ generation: 2, documentRevision: 2, tombstoned: true }),
        replaceMediaOwnerReferenceList: async () => (promoted = true, { status: 'committed' })
    });
    assert.equal(await committer.commitPersistedWorkflow({
        workflowId: 'workflow-a', mediaOwnershipRevision: 3,
        nodes: [{ id: 'node', type: 'ImagePreview', data: { mediaAssetKeys: ['media:first'] } }]
    }), false);
    assert.equal(promoted, false);
});

test('a later save skips a consumer that is already tombstoned and still absent', async () => {
    let transitions = 0;
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        listMediaOwnerReferenceLists: async () => [{ ownerType: 'workflow-node', ownerId: 'deleted', tombstoned: true }],
        recordMediaWorkflowRevision: async (_workflowId, _revision, _epoch, owners) => (assert.deepEqual(owners, []), true),
        getMediaOwnerReferenceList: async () => null,
        replaceMediaOwnerReferenceList: async () => (transitions += 1, { status: 'committed' })
    });
    assert.equal(await committer.commitPersistedWorkflow({
        workflowId: 'workflow-a', mediaOwnershipRevision: 3, nodes: []
    }), true);
    assert.equal(transitions, 0);
});

test('an unavailable previous-owner inventory leaves the Workflow ownership commit retryable', async () => {
    let recorded = false;
    const committer = createWorkflowMediaOwnershipCommitter({
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
        listMediaOwnerReferenceLists: async () => null,
        recordMediaWorkflowRevision: async () => (recorded = true),
        getMediaOwnerReferenceList: async () => null,
        replaceMediaOwnerReferenceList: async () => ({ status: 'committed' })
    });
    assert.equal(await committer.commitPersistedWorkflow({
        workflowId: 'workflow-a', mediaOwnershipRevision: 2, nodes: []
    }), false);
    assert.equal(recorded, false);
});
