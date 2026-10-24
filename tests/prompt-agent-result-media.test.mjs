import assert from 'node:assert/strict';
import test from 'node:test';
import { createPromptAgentResultMediaAdapter } from '../js/features/prompt-agent/prompt-agent-result-media.js';

const images = ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg=='];

test('Agent retains a complete ordered batch under a distinct per-run temporary owner', async () => {
    const calls = [];
    const service = createPromptAgentResultMediaAdapter({
        saveWorkflowNodeMediaAssets: async (values, workflowId, consumer, operationId) => {
            calls.push({ values, workflowId, consumer, operationId });
            return values.map((_, i) => ({ asset_key: `media:${i}`, mediaTemporaryOwnerId: JSON.stringify([workflowId, consumer, operationId]) }));
        }
    });
    const result = await service.retain({ workflowId: 'wf', runId: 'run', images });
    assert.deepEqual(calls, [{ values: images, workflowId: 'wf', consumer: 'prompt-agent-result:run', operationId: 'run' }]);
    assert.deepEqual(result, {
        mediaAssetKeys: ['media:0', 'media:1'],
        mediaOwnershipTemporaryOwners: [{ ownerId: '["wf","prompt-agent-result:run","run"]', assetKeys: ['media:0', 'media:1'] }],
        persistenceStatus: 'retained'
    });
});

test('keys-only retention never skips a missing image position or makes a partial batch', async () => {
    let materializations = 0;
    const service = createPromptAgentResultMediaAdapter({
        getImageAsset: async (key) => key === 'media:a' ? images[0] : '',
        saveWorkflowNodeMediaAssets: async () => { materializations++; return []; }
    });
    const result = await service.retain({ workflowId: 'wf', runId: 'run', mediaAssetKeys: ['media:a', 'media:missing'] });
    assert.equal(result.persistenceStatus, 'failed');
    assert.match(result.persistenceError, /完整读取/);
    assert.equal(materializations, 0);
});

test('remote and released previews retain the complete authoritative local batch without a remote request', async () => {
    const reads = [];
    const writes = [];
    const service = createPromptAgentResultMediaAdapter({
        getImageAsset: async (key) => { reads.push(key); return images[key === 'media:a' ? 0 : 1]; },
        saveWorkflowNodeMediaAssets: async (values, workflowId, consumer, operationId) => {
            writes.push(values);
            return values.map((_, i) => ({ asset_key: `media:${i}`, mediaTemporaryOwnerId: JSON.stringify([workflowId, consumer, operationId]) }));
        }
    });
    const result = await service.retain({ workflowId: 'wf', runId: 'run',
        images: ['https://expired.example/image.png'], mediaAssetKeys: ['media:a', 'media:b'] });
    assert.equal(result.persistenceStatus, 'retained');
    assert.deepEqual(reads, ['media:a', 'media:b']);
    assert.deepEqual(writes, [images]);
});

test('save failure stays retryable with the same operation identity and does not regenerate', async () => {
    const operations = [];
    const service = createPromptAgentResultMediaAdapter({
        saveWorkflowNodeMediaAssets: async (values, workflowId, consumer, operationId) => {
            operations.push(operationId);
            if (operations.length === 1) throw new Error('disk full');
            return values.map((_, i) => ({ asset_key: `media:${i}`, mediaTemporaryOwnerId: JSON.stringify([workflowId, consumer, operationId]) }));
        }
    });
    assert.equal((await service.retain({ workflowId: 'wf', runId: 'run', images })).persistenceStatus, 'failed');
    assert.equal((await service.retain({ workflowId: 'wf', runId: 'run', images })).persistenceStatus, 'retained');
    assert.deepEqual(operations, ['run', 'run']);
});

test('release fences only this run, never its source node or another workflow', async () => {
    const calls = [];
    const service = createPromptAgentResultMediaAdapter({ cancelWorkflowNodeMediaOperation: async (...args) => (calls.push(args), true) });
    await service.release({ workflowId: 'wf', runId: 'run', mediaOwnershipTemporaryOwners: [{ ownerId: '["other","node","op"]', assetKeys: ['media:other'] }] });
    assert.deepEqual(calls, [['wf', 'prompt-agent-result:run', 'run']]);
});
