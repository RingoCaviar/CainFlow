import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageResultReferenceIdentity } from '../js/features/prompt-agent/prompt-agent-result-reference.js';

const original = { workflowId: 'workflow-a', sourceNodeId: 'node-a', sourcePort: 'image', sourceImageIndex: 0, assetKey: 'media:identical-pixels' };
test('preparing the same result repeatedly is idempotent while distinct source slots retain their own references', () => {
    const first = createImageResultReferenceIdentity(original);
    assert.deepEqual(createImageResultReferenceIdentity({ ...original }), first);
    for (const patch of [{ sourceNodeId: 'node-b' }, { sourceImageIndex: 1 }, { sourcePort: 'another-image' },
        { workflowId: 'workflow-b' }, { assetKey: 'media:new-output' }]) {
        assert.notEqual(createImageResultReferenceIdentity({ ...original, ...patch }).referenceId, first.referenceId);
    }
    assert.notEqual(createImageResultReferenceIdentity({ ...original, historyId: 'shared-history' }).historyId,
        createImageResultReferenceIdentity({ ...original, historyId: 'shared-history', sourceImageIndex: 1 }).historyId);
});
test('history entries and Agent run positions remain distinct even when their original pixels share an asset', () => {
    const history = { historyId: 'history-a', assetKey: original.assetKey };
    assert.notEqual(createImageResultReferenceIdentity(history).referenceId,
        createImageResultReferenceIdentity({ ...history, historyId: 'history-b' }).referenceId);
    const result = { workflowId: 'workflow-a', runId: 'run-a', sourceImageIndex: 0, assetKey: original.assetKey };
    assert.notEqual(createImageResultReferenceIdentity(result).referenceId,
        createImageResultReferenceIdentity({ ...result, sourceImageIndex: 1 }).referenceId);
});
test('unowned originals use their actual content identity without merging it with a named source', () => {
    const first = createImageResultReferenceIdentity({}, { fallbackIdentity: 'sha256:first' });
    assert.deepEqual(createImageResultReferenceIdentity({}, { fallbackIdentity: 'sha256:first' }), first);
    assert.notEqual(createImageResultReferenceIdentity({}, { fallbackIdentity: 'sha256:second' }).referenceId, first.referenceId);
    assert.notEqual(createImageResultReferenceIdentity(original).referenceId, first.referenceId);
});
