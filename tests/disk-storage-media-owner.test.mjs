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

test('saving generated node images scopes one temporary owner to the operation', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (options.method === 'POST') return new Response(JSON.stringify({
            success: true, assets: [{ asset_key: 'media:first' }, { asset_key: 'media:second' }]
        }), { status: 200 });
        return new Response(JSON.stringify({ asset: { asset_key: 'media:shared-image' } }), { status: 200 });
    };

    try {
        const storage = createDiskStorageApi(() => ({}));
        const assets = await storage.saveWorkflowNodeMediaAssets([
            'data:image/png;base64,aGVsbG8=', 'data:image/png;base64,d29ybGQ='
        ], 'workflow-a', 'node-a', 'operation-a');

        const mediaWrites = requests.filter(({ url }) => url === '/api/storage/media-assets');
        assert.equal(mediaWrites.length, 1);
        assert.deepEqual(JSON.parse(mediaWrites[0].options.body), {
            action: 'materialize-owner-list', ownerType: 'workflow-operation',
            ownerId: '["workflow-a","node-a","operation-a"]',
            values: ['data:image/png;base64,aGVsbG8=', 'data:image/png;base64,d29ybGQ=']
        });
        assert.ok(assets.every((asset) => asset.mediaTemporaryOwnerId === '["workflow-a","node-a","operation-a"]'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('cancelling a node generation persists its structured operation owner', async () => {
    const originalFetch = globalThis.fetch;
    let request = null;
    globalThis.fetch = async (url, options = {}) => {
        request = { url, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({ success: true, cancelled: true }), { status: 200 });
    };
    try {
        const storage = createDiskStorageApi(() => ({}));
        assert.equal(await storage.cancelWorkflowNodeMediaOperation('workflow-a', 'node-a', 'operation-a'), true);
        assert.equal(request.url, '/api/storage/media-assets');
        assert.deepEqual(request.body, {
            action: 'cancel-operation-owner',
            ownerId: '["workflow-a","node-a","operation-a"]'
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('a failed Media operation cancellation remains durable and retries on startup', async () => {
    const originalFetch = globalThis.fetch;
    const originalStorage = globalThis.localStorage;
    const values = new Map();
    globalThis.localStorage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value))
    };
    let fail = true;
    globalThis.fetch = async () => {
        if (fail) throw new Error('offline');
        return new Response(JSON.stringify({ success: true, cancelled: true }), { status: 200 });
    };
    try {
        const storage = createDiskStorageApi(() => ({}));
        assert.equal(await storage.cancelWorkflowNodeMediaOperation('workflow-a', 'node-a', 'operation-a'), false);
        assert.deepEqual(JSON.parse(values.get('cainflow_pending_media_operation_cancellations')),
            ['["workflow-a","node-a","operation-a"]']);

        fail = false;
        createDiskStorageApi(() => ({}));
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(JSON.parse(values.get('cainflow_pending_media_operation_cancellations')), []);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.localStorage = originalStorage;
    }
});

test('a failed atomic multi-image materialization publishes no client-side partial list', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        return new Response('', { status: 500 });
    };

    try {
        const storage = createDiskStorageApi(() => ({}));
        assert.deepEqual(await storage.saveWorkflowNodeMediaAssets([
            'data:image/png;base64,aGVsbG8=', 'data:image/png;base64,d29ybGQ='
        ], 'workflow-a', 'node-a', 'operation-a'), []);
        assert.equal(requests.length, 1);
        assert.equal(JSON.parse(requests[0].options.body).action, 'materialize-owner-list');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('late operation assets can compensate their own temporary owner through the release seam', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    try {
        const storage = createDiskStorageApi(() => ({}));
        assert.equal(await storage.releaseWorkflowNodeMediaAssets([{
            asset_key: 'media:late', mediaTemporaryOwnerId: 'workflow:node:operation'
        }], 'workflow', 'node'), true);
        assert.deepEqual(JSON.parse(requests[0].options.body), {
            action: 'unreference', ownerType: 'workflow-operation',
            ownerId: 'workflow:node:operation', assetKey: 'media:late'
        });
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
        assert.equal(mediaWrite.options.headers['X-CainFlow-Media-Owner-Type'], 'workflow-operation');
        assert.deepEqual(JSON.parse(mediaWrite.options.headers['X-CainFlow-Media-Owner-Id']).slice(0, 2), ['workflow-a', 'import-a']);
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
