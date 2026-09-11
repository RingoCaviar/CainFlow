import test from 'node:test';
import assert from 'node:assert/strict';

import { createMissingMediaActionCoordinator, validateRecoveryBlob } from '../js/features/media/missing-media-actions.js';

function fixture(overrides = {}) {
    const state = {
        workflowId: 'workflow-a', nodeId: 'node-a', documentRevision: 4, ownerGeneration: 2,
        storageEpoch: 'epoch-1',
        running: false, mediaType: 'image', assetKeys: ['media:old', 'media:missing', 'media:shared']
    };
    const commits = [];
    const materialized = [];
    const coordinator = createMissingMediaActionCoordinator({
        confirm: async () => true,
        getContext: async () => ({ ...state, assetKeys: state.assetKeys.slice() }),
        recoverRemote: async (request) => (materialized.push(request), {
            assetKey: request.expectedAssetKey, mediaType: 'image', digest: request.expectedDigest || 'missing'
        }),
        recoverTask: async (request) => (materialized.push(request), {
            assetKey: request.expectedAssetKey, mediaType: 'image', digest: request.expectedDigest || 'missing'
        }),
        recoverLocal: async (request) => (materialized.push(request), {
            assetKey: request.expectedAssetKey, mediaType: 'image', digest: request.expectedDigest
        }),
        materializeReplacement: async (request) => (materialized.push(request), {
            assetKey: 'media:new', mediaType: 'image', digest: 'new'
        }),
        commitReferenceList: async (request) => {
            commits.push(request);
            state.assetKeys = request.assetKeys.slice();
            state.documentRevision += 1;
            state.ownerGeneration += 1;
            return { status: 'committed', documentRevision: state.documentRevision };
        },
        ...overrides
    });
    return { coordinator, state, commits, materialized };
}

test('confirmed HTTP recovery restores the original identity through a fenced reference-first commit', async () => {
    const { coordinator, commits } = fixture();
    const result = await coordinator.run({
        kind: 'remote-recover', workflowId: 'workflow-a', nodeId: 'node-a', position: 1,
        expectedAssetKey: 'media:missing', expectedDocumentRevision: 4, expectedOwnerGeneration: 2,
        source: { url: 'https://example.test/result.png', persisted: true }, expectedDigest: 'missing'
    });
    assert.equal(result.status, 'committed');
    assert.deepEqual(commits[0].assetKeys, ['media:old', 'media:missing', 'media:shared']);
    assert.equal(commits[0].intent, 'recover');
});

test('remote recovery rejects unpersisted, ambiguous, and non-HTTP sources before network access', async () => {
    let networkCalls = 0;
    const { coordinator } = fixture({ recoverRemote: async () => { networkCalls += 1; } });
    for (const source of [{ url: 'file:///secret', persisted: true }, { url: 'https://x', persisted: false }, {}]) {
        await assert.rejects(coordinator.run({
            kind: 'remote-recover', workflowId: 'workflow-a', nodeId: 'node-a', position: 1,
            expectedAssetKey: 'media:missing', expectedDocumentRevision: 4, expectedOwnerGeneration: 2, source
        }));
    }
    assert.equal(networkCalls, 0);
});

test('a persisted task identity uses the task recovery adapter', async () => {
    const { coordinator, materialized } = fixture();
    const result = await coordinator.run({
        kind: 'remote-recover', workflowId: 'workflow-a', nodeId: 'node-a', position: 1,
        expectedAssetKey: 'media:missing', expectedDocumentRevision: 4, expectedOwnerGeneration: 2,
        source: { taskId: 'task-1', persisted: true }
    });
    assert.equal(result.status, 'committed');
    assert.equal(materialized[0].source.taskId, 'task-1');
});

test('cancel and materialization failures preserve the original ordered references', async () => {
    const cancelled = fixture({ confirm: async () => false });
    assert.equal((await cancelled.coordinator.run({
        kind: 'remove', workflowId: 'workflow-a', nodeId: 'node-a', positions: [1],
        expectedDocumentRevision: 4, expectedOwnerGeneration: 2
    })).status, 'cancelled');
    assert.deepEqual(cancelled.state.assetKeys, ['media:old', 'media:missing', 'media:shared']);

    const failed = fixture({ recoverRemote: async () => { throw new Error('network unavailable'); } });
    await assert.rejects(failed.coordinator.run({
        kind: 'remote-recover', workflowId: 'workflow-a', nodeId: 'node-a', position: 1,
        expectedAssetKey: 'media:missing', expectedDocumentRevision: 4, expectedOwnerGeneration: 2,
        source: { url: 'https://example.test/result.png', persisted: true }
    }), /network unavailable/);
    assert.deepEqual(failed.state.assetKeys, ['media:old', 'media:missing', 'media:shared']);
});

test('local recovery requires matching media type and digest while replacement creates a new identity', async () => {
    const { coordinator, commits } = fixture();
    await assert.rejects(coordinator.run({
        kind: 'local-recover', workflowId: 'workflow-a', nodeId: 'node-a', position: 1,
        expectedAssetKey: 'media:missing', expectedDocumentRevision: 4, expectedOwnerGeneration: 2,
        expectedDigest: 'missing', localFile: { type: 'video/mp4' }
    }), /media type/i);
    const replaced = await coordinator.run({
        kind: 'replace', workflowId: 'workflow-a', nodeId: 'node-a', position: 1,
        expectedAssetKey: 'media:missing', expectedDocumentRevision: 4, expectedOwnerGeneration: 2,
        localFile: { type: 'image/png' }
    });
    assert.equal(replaced.status, 'committed');
    assert.deepEqual(commits.at(-1).assetKeys, ['media:old', 'media:new', 'media:shared']);
});

test('remove changes only selected positions, defaults to none, and Undo restores identities in order', async () => {
    const { coordinator, commits } = fixture();
    assert.equal((await coordinator.run({
        kind: 'remove', workflowId: 'workflow-a', nodeId: 'node-a', positions: [],
        expectedDocumentRevision: 4, expectedOwnerGeneration: 2
    })).status, 'no-selection');
    const removed = await coordinator.run({
        kind: 'remove', workflowId: 'workflow-a', nodeId: 'node-a', positions: [1],
        expectedDocumentRevision: 4, expectedOwnerGeneration: 2
    });
    assert.deepEqual(commits[0].assetKeys, ['media:old', 'media:shared']);
    const undone = await coordinator.undo(removed.undo);
    assert.equal(undone.status, 'committed');
    assert.deepEqual(commits[1].assetKeys, ['media:old', 'media:missing', 'media:shared']);
    assert.equal(undone.mediaStillMissing, true);
});

test('running or revised consumers stop safely and duplicate clicks share one operation', async () => {
    const running = fixture();
    running.state.running = true;
    await assert.rejects(running.coordinator.run({
        kind: 'remove', workflowId: 'workflow-a', nodeId: 'node-a', positions: [1],
        expectedDocumentRevision: 4, expectedOwnerGeneration: 2
    }), /running/i);

    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const duplicate = fixture({ recoverRemote: async () => { calls += 1; await pending; return { assetKey: 'media:missing', mediaType: 'image' }; } });
    const request = {
        operationId: 'recover-1', kind: 'remote-recover', workflowId: 'workflow-a', nodeId: 'node-a', position: 1,
        expectedAssetKey: 'media:missing', expectedDocumentRevision: 4, expectedOwnerGeneration: 2,
        source: { url: 'https://example.test/a', persisted: true }
    };
    const first = duplicate.coordinator.run(request);
    const second = duplicate.coordinator.run(request);
    assert.equal(first, second);
    release();
    await first;
    assert.equal(calls, 1);
});

test('recovery content must be non-empty, bounded, correctly typed and decodable', async () => {
    await assert.rejects(validateRecoveryBlob(new Blob([], { type: 'image/png' }), 'image'), /empty/);
    await assert.rejects(validateRecoveryBlob(new Blob(['x'], { type: 'text/html' }), 'image'), /type/);
    await assert.rejects(validateRecoveryBlob(new Blob(['xx'], { type: 'image/png' }), 'image', { maxBytes: 1 }), /size/);
    await assert.rejects(validateRecoveryBlob(new Blob(['x'], { type: 'image/png' }), 'image', {
        decodeImage: async () => false
    }), /decode/);
    assert.equal((await validateRecoveryBlob(new Blob(['x'], { type: 'image/png' }), 'image')).size, 1);
});
