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
