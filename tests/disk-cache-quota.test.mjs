import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiskStorageApi } from '../js/services/storage-disk.js';

test('thumbnail quota rejection preserves history without a dangling thumbnail reference', async () => {
    const originalFetch = globalThis.fetch;
    let history;
    globalThis.fetch = async (url, options = {}) => {
        if (options.method === 'PUT') return new Response('{}', { status: 400 });
        if (url === '/api/storage/history') history = JSON.parse(options.body);
        return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    try {
        const storage = createDiskStorageApi(() => ({}));
        const result = await storage.saveHistoryEntry({
            mediaAssetKey: 'media:original', image: 'data:image/png;base64,aGVsbG8=',
            thumb: 'data:image/webp;base64,dGh1bWI='
        });
        assert.equal(result.success, true);
        assert.equal(history.imageAssetKey, 'media:original');
        assert.equal(history.thumbAssetKey, '');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
