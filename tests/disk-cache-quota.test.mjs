import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiskStorageApi } from '../js/services/storage-disk.js';

test('directory originals remain independent from disposable thumbnail cache', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push(url);
        if (url === '/api/storage/library') return new Response(JSON.stringify({item:{id:1}}));
        return new Response('{}', {status:507});
    };
    try {
        const result = await createDiskStorageApi(() => ({})).saveHistoryEntry({
            mediaAssetKey:'media:original',image:'data:image/png;base64,aGVsbG8='
        });
        assert.deepEqual(result,{success:true,assetKey:'media:original',fileId:1});
        assert.deepEqual(calls,['/api/storage/library']);
    } finally { globalThis.fetch=originalFetch; }
});

test('manual asset cleanup can return retained-media details without changing boolean callers', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        success: true, assetsDeleted: 0, orphanFilesDeleted: 0,
        gcSuspended: true, candidatesRetained: 2
    }), { status: 200 });
    try {
        const storage = createDiskStorageApi(() => ({}));
        assert.equal(await storage.clearOrphanedNodeAssets(new Set()), true);
        assert.deepEqual(await storage.clearOrphanedNodeAssets(new Set(), { detailed: true }), {
            success: true, assetsDeleted: 0, orphanFilesDeleted: 0,
            gcSuspended: true, candidatesRetained: 2
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});
