import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiskStorageApi } from '../js/services/storage-disk.js';

test('saving generated-image history creates the Media asset with the history owner', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url === '/api/storage/media-assets') {
            return new Response(JSON.stringify({ asset: { asset_key: 'media:shared-image' } }), { status: 200 });
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
        const storage = createDiskStorageApi(() => ({}));
        await storage.saveHistoryEntry({
            nodeId: 'node-a',
            image: 'data:image/png;base64,aGVsbG8=',
            thumb: 'data:image/webp;base64,dGh1bWI='
        });

        const mediaWrite = requests.find(({ url }) => url === '/api/storage/media-assets');
        assert.equal(mediaWrite.options.headers['X-CainFlow-Media-Owner-Type'], 'history');
        assert.notEqual(mediaWrite.options.headers['X-CainFlow-Media-Owner-Id'], 'node-a');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('saving a generated node image scopes its Media asset owner to the workflow identity', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        return new Response(JSON.stringify({ asset: { asset_key: 'media:shared-image' } }), { status: 200 });
    };

    try {
        const storage = createDiskStorageApi(() => ({}));
        await storage.saveWorkflowNodeMediaAsset('data:image/png;base64,aGVsbG8=', 'workflow-a', 'node-a');

        const mediaWrite = requests.find(({ url }) => url === '/api/storage/media-assets');
        assert.equal(mediaWrite.options.headers['X-CainFlow-Media-Owner-Type'], 'workflow-node');
        assert.equal(mediaWrite.options.headers['X-CainFlow-Media-Owner-Id'], 'workflow-a:node-a');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('saving an uploaded image scopes its Media asset owner to the workflow import', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        return new Response(JSON.stringify({ asset: { asset_key: 'media:imported-image' } }), { status: 200 });
    };
    try {
        const storage = createDiskStorageApi(() => ({}));
        await storage.saveWorkflowImportMediaAsset('data:image/png;base64,aGVsbG8=', 'workflow-a', 'import-a');
        const mediaWrite = requests.find(({ url }) => url === '/api/storage/media-assets');
        assert.equal(mediaWrite.options.headers['X-CainFlow-Media-Owner-Type'], 'workflow-import');
        assert.equal(mediaWrite.options.headers['X-CainFlow-Media-Owner-Id'], 'workflow-a:import-a');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('failed history persistence releases the provisional history owner', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url === '/api/storage/media-assets' && options.method === 'PUT') {
            return new Response(JSON.stringify({ asset: { asset_key: 'media:shared-image' } }), { status: 200 });
        }
        if (url === '/api/storage/history') return new Response('', { status: 500 });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
        const storage = createDiskStorageApi(() => ({}));
        assert.equal(await storage.saveHistoryEntry({
            image: 'data:image/png;base64,aGVsbG8=', thumb: 'data:image/webp;base64,dGh1bWI='
        }), false);
        const rollback = requests.find(({ url, options }) => (
            url === '/api/storage/media-assets' && options.method === 'POST'
        ));
        assert.equal(JSON.parse(rollback.options.body).action, 'unreference');
        assert.equal(JSON.parse(rollback.options.body).ownerType, 'history');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('versioned Media asset ownership methods map the workflow commit contract', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (String(url).startsWith('/api/storage/media-owner?')) {
            return new Response(JSON.stringify({ owner: { generation: 2, assetKeys: ['media:old'] } }), { status: 200 });
        }
        if (url === '/api/storage/safety-status') {
            return new Response(JSON.stringify({ safety: { storageEpoch: 'epoch-1' } }), { status: 200 });
        }
        return new Response(JSON.stringify({ success: true, status: 'committed', documentRevision: 5 }), { status: 200 });
    };

    try {
        const storage = createDiskStorageApi(() => ({}));
        assert.deepEqual(await storage.getStorageSafetyStatus(), { storageEpoch: 'epoch-1' });
        assert.deepEqual(await storage.getMediaOwnerReferenceList('workflow-a', 'workflow-node', 'node-a'), {
            generation: 2, assetKeys: ['media:old']
        });
        assert.equal(await storage.recordMediaWorkflowRevision('workflow-a', 5, 'epoch-1', [{
            ownerType: 'workflow-node', ownerId: 'node-a', assetKeys: ['media:new']
        }]), true);
        assert.deepEqual(await storage.replaceMediaOwnerReferenceList({
            workflowId: 'workflow-a', ownerType: 'workflow-node', ownerId: 'node-a',
            operationId: 'save-5', idempotencyKey: 'save-5:node-a', expectedGeneration: 2,
            documentRevision: 5, storageEpoch: 'epoch-1', assetKeys: ['media:new']
        }), { status: 'committed', documentRevision: 5 });

        assert.equal(JSON.parse(requests.at(-2).options.body).action, 'record-workflow-revision');
        assert.equal(JSON.parse(requests.at(-1).options.body).action, 'replace-owner-reference-list');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
