import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createDiskStorageApi } from '../js/services/storage-disk.js';
import { startCainflowServer } from './helpers/browser-theme-fixture.mjs';

function historyOwnerRows(server) {
    const result = spawnSync(process.env.CAINFLOW_PYTHON || 'python', ['-c',
        "import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(json.dumps(db.execute(\"SELECT owner_type,owner_id,asset_key FROM media_asset_refs WHERE owner_type IN ('history','history-thumbnail') ORDER BY owner_type,owner_id,asset_key\").fetchall()))",
        join(server.dataDir, 'cainflow.db')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

test('a lost history commit response cannot release its durable original and thumbnail owners', { timeout: 15000 }, async () => {
    const nativeFetch = globalThis.fetch;
    const server = await startCainflowServer();
    globalThis.fetch = async (url, options = {}) => {
        const response = await nativeFetch(new URL(url, server.baseUrl), options);
        if (url === '/api/storage/history' && options.method === 'POST') {
            assert.equal(response.status, 200, 'the backend committed before the response was lost');
            throw new TypeError('Controlled lost response after history commit');
        }
        return response;
    };
    try {
        const storage = createDiskStorageApi(() => ({}));
        assert.equal(await storage.saveHistoryEntry({
            image: 'data:image/png;base64,aGVsbG8=', thumb: 'data:image/webp;base64,dGh1bWI='
        }), false);
        const entries = (await nativeFetch(`${server.baseUrl}/api/storage/history`).then(response => response.json())).items;
        assert.equal(entries.length, 1);
        const entry = entries[0];
        assert.deepEqual(historyOwnerRows(server), [
            ['history', String(entry.id), entry.imageAssetKey],
            ['history-thumbnail', String(entry.id), entry.thumbAssetKey]
        ]);
        assert.equal(await nativeFetch(`${server.baseUrl}/api/storage/assets/${encodeURIComponent(entry.imageAssetKey)}`).then(response => response.text()), 'hello');
        assert.equal(await nativeFetch(`${server.baseUrl}/api/storage/assets/${encodeURIComponent(entry.thumbAssetKey)}`).then(response => response.text()), 'thumb');
    } finally {
        globalThis.fetch = nativeFetch;
        await server.stop();
    }
});

test('a failed concurrent thumbnail update cannot release the successful update owner', { timeout: 15000 }, async () => {
    const nativeFetch = globalThis.fetch;
    const server = await startCainflowServer();
    globalThis.fetch = (url, options = {}) => nativeFetch(new URL(url, server.baseUrl), options);
    try {
        const storage = createDiskStorageApi(() => ({}));
        assert.ok(await storage.saveHistoryEntry({ videoBlob: new Blob(['video'], { type: 'video/mp4' }),
            thumb: 'data:image/webp;base64,b2xkLXRodW1i' }));
        const entry = (await nativeFetch(`${server.baseUrl}/api/storage/history`).then(response => response.json())).items[0];
        let reads = 0, commits = 0, releaseReads, committed;
        const bothReadOldEntry = new Promise(resolve => { releaseReads = resolve; });
        const successfulCommit = new Promise(resolve => { committed = resolve; });
        globalThis.fetch = async (url, options = {}) => {
            if (url === `/api/storage/history/${entry.id}`) {
                const response = await nativeFetch(new URL(url, server.baseUrl), options);
                assert.equal((await response.clone().json()).item.thumbAssetKey, entry.thumbAssetKey);
                if (++reads === 2) releaseReads();
                await bothReadOldEntry;
                return response;
            }
            if (url === '/api/storage/history' && options.method === 'POST') {
                if (++commits === 1) {
                    const response = await nativeFetch(new URL(url, server.baseUrl), options);
                    assert.equal(response.status, 200);
                    committed();
                    return response;
                }
                await successfulCommit;
                return new Response('', { status: 503 });
            }
            return nativeFetch(new URL(url, server.baseUrl), options);
        };
        assert.deepEqual((await Promise.all([
            storage.updateHistoryThumb(entry.id, 'data:image/webp;base64,bmV3LXRodW1i'),
            storage.updateHistoryThumb(entry.id, 'data:image/webp;base64,bmV3LXRodW1i')
        ])).sort(), [false, true]);
        const updated = (await nativeFetch(`${server.baseUrl}/api/storage/history/${entry.id}`).then(response => response.json())).item;
        assert.equal(updated.thumbAssetKey, `thumb:history:${entry.id}`);
        assert.deepEqual(historyOwnerRows(server), [
            ['history', String(entry.id), entry.videoAssetKey],
            ['history-thumbnail', String(entry.id), updated.thumbAssetKey]
        ]);
    } finally {
        globalThis.fetch = nativeFetch;
        await server.stop();
    }
});

test('binary node media is encoded for atomic owner materialization with its MIME, order and operation identity intact', async () => {
    const originalFetch = globalThis.fetch, originalReader = globalThis.FileReader;
    const requests = [];
    globalThis.FileReader = class {
        readAsDataURL(blob) { void blob.arrayBuffer().then(bytes => { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload?.(); }); }
    };
    globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(options.body); requests.push(request);
        return new Response(JSON.stringify({ success: true, assets: request.values.map((_value, index) => ({ asset_key: `media:${index}` })) }));
    };
    try {
        const api = createDiskStorageApi(() => ({}));
        const video = new Blob(['actual-binary'], { type: 'video/webm' });
        const image = 'data:image/png;base64,aW1hZ2U=';
        assert.equal((await api.saveWorkflowNodeMediaAsset(video, 'wf', 'single', 'one')).asset_key, 'media:0');
        const result = await api.saveWorkflowNodeMediaAssets([video, image, video], 'wf', 'batch', 'many');
        assert.equal(result.length, 3);
        assert.deepEqual(requests.map(request => request.values), [
            ['data:video/webm;base64,YWN0dWFsLWJpbmFyeQ=='],
            ['data:video/webm;base64,YWN0dWFsLWJpbmFyeQ==', image, 'data:video/webm;base64,YWN0dWFsLWJpbmFyeQ==']
        ]);
        assert.equal(requests[1].ownerId, '["wf","batch","many"]');
        assert.ok(result.every(asset => asset.mediaTemporaryOwnerId === requests[1].ownerId));
    } finally {
        globalThis.fetch = originalFetch;
        if (originalReader === undefined) delete globalThis.FileReader; else globalThis.FileReader = originalReader;
    }
});

test('history restore checks media metadata and treats transport errors as unknown', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url.endsWith('media%3Aavailable')) {
            return new Response(JSON.stringify({ asset: { asset_key: 'media:available' } }), { status: 200 });
        }
        return new Response('{}', { status: url.endsWith('media%3Amissing') ? 404 : 503 });
    };
    try {
        const storage = createDiskStorageApi(() => ({}));
        assert.equal(await storage.mediaAssetExists('media:available'), true);
        assert.equal(await storage.mediaAssetExists('media:missing'), false);
        await assert.rejects(storage.mediaAssetExists('media:unknown'), /HTTP 503/);
        assert.ok(requests.every(({ options }) => options.cache === 'no-store'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

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
        const thumbnailWrite = requests.find(({ url }) => url.startsWith('/api/storage/assets/thumb'));
        assert.equal(thumbnailWrite.options.headers['X-CainFlow-Media-Owner-Type'], 'history-thumbnail');
        assert.equal(thumbnailWrite.options.headers['X-CainFlow-Media-Owner-Id'], mediaWrite.options.headers['X-CainFlow-Media-Owner-Id']);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('an optional thumbnail upload failure still commits the original history image', async () => {
    const originalFetch = globalThis.fetch;
    let historyEntry;
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/storage/media-assets') return new Response(JSON.stringify({ asset: { asset_key: 'media:original' } }));
        if (url.startsWith('/api/storage/assets/')) return new Response('', { status: 507 });
        if (url === '/api/storage/history') historyEntry = JSON.parse(options.body);
        return new Response(JSON.stringify({ success: true }));
    };
    try {
        const storage = createDiskStorageApi(() => ({}));
        assert.deepEqual(await storage.saveHistoryEntry({
            image: 'data:image/png;base64,aGVsbG8=', thumb: 'data:image/webp;base64,dGh1bWI='
        }), { success: true, assetKey: 'media:original' });
        assert.equal(historyEntry.imageAssetKey, 'media:original');
        assert.equal(historyEntry.thumbAssetKey, '');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('history thumbnail updates protect the upload and retain an existing owner after a failed commit', async () => {
    const originalFetch = globalThis.fetch;
    try {
        for (const previousThumbKey of ['', 'thumb:history:10', 'thumb:older-thumbnail']) {
            const requests = [];
            globalThis.fetch = async (url, options = {}) => {
                requests.push({ url, options });
                if (url === '/api/storage/history/10') return new Response(JSON.stringify({ item: {
                    id: 10, mediaType: 'video', videoAssetKey: 'media:video',
                    thumbAssetKey: previousThumbKey
                } }));
                if (url === '/api/storage/history') return new Response('', { status: 500 });
                return new Response(JSON.stringify({ success: true }));
            };
            const storage = createDiskStorageApi(() => ({}));
            assert.equal(await storage.updateHistoryThumb(10, 'data:image/webp;base64,dGh1bWI='), false);
            const upload = requests.find(({ options }) => options.method === 'PUT');
            assert.equal(upload.options.headers['X-CainFlow-Media-Owner-Type'], 'history-thumbnail');
            assert.equal(upload.options.headers['X-CainFlow-Media-Owner-Id'], '10');
            const releases = requests.filter(({ url }) => url === '/api/storage/media-assets')
                .map(({ options }) => JSON.parse(options.body));
            assert.deepEqual(releases, previousThumbKey === 'thumb:history:10' ? [] : [{
                action: 'unreference', ownerType: 'history-thumbnail', ownerId: '10', assetKey: 'thumb:history:10'
            }]);
        }
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
        const releases = requests.filter(({ url, options }) => url === '/api/storage/media-assets' && options.method === 'POST')
            .map(({ options }) => JSON.parse(options.body));
        assert.deepEqual(releases.map(request => [request.ownerType, request.assetKey]), [
            ['history', 'media:shared-image'], ['history-thumbnail', 'thumb:media:shared-image']
        ]);
        assert.equal(releases[0].ownerId, releases[1].ownerId);
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

test('a null media ownership response fails the workflow save without throwing', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('null', { status: 200 });

    try {
        const storage = createDiskStorageApi(() => ({}));
        const saved = await storage.recordMediaWorkflowRevision('workflow-a', 5, 'epoch-1', []);
        assert.equal(saved, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
