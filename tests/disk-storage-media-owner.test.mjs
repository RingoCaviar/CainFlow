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

test('a lost archive response preserves the durable original independently of cache owners', { timeout: 15000 }, async () => {
    const nativeFetch = globalThis.fetch;
    const server = await startCainflowServer();
    globalThis.fetch = async (url, options = {}) => {
        const response = await nativeFetch(new URL(url, server.baseUrl), options);
        if (url === '/api/storage/library' && options.method === 'POST') {
            assert.equal(response.status, 200);
            throw new TypeError('Controlled lost response after archive commit');
        }
        return response;
    };
    try {
        const storage = createDiskStorageApi(() => ({}));
        await assert.rejects(storage.saveHistoryEntry({image: 'data:image/png;base64,aGVsbG8='}), /Controlled lost response/);
        const { items } = await nativeFetch(`${server.baseUrl}/api/storage/library`).then(r => r.json());
        assert.equal(items.length, 1);
        assert.equal(await nativeFetch(new URL(items[0].fileUrl, server.baseUrl)).then(r => r.text()), 'hello');
        assert.deepEqual(historyOwnerRows(server), [], 'directory originals are not disposable cache owners');
    } finally { globalThis.fetch = nativeFetch; await server.stop(); }
});

test('a failed concurrent thumbnail update cannot discard the successful directory thumbnail or original', { timeout: 15000 }, async () => {
    const nativeFetch = globalThis.fetch;
    const server = await startCainflowServer();
    globalThis.fetch = (url, options = {}) => nativeFetch(new URL(url, server.baseUrl), options);
    try {
        const storage = createDiskStorageApi(() => ({}));
        await storage.saveHistoryEntry({videoBlob: new Blob(['video'], {type:'video/mp4'})});
        const entry = (await storage.getHistoryMetadata())[0];
        let writes = 0, finish;
        const committed = new Promise(resolve => { finish = resolve; });
        globalThis.fetch = async (url, options = {}) => {
            if (url === `/api/storage/library/${entry.id}/thumbnail`) {
                if (++writes === 1) {
                    const response = await nativeFetch(new URL(url, server.baseUrl), options);
                    assert.equal(response.status, 200); finish(); return response;
                }
                await committed; return new Response('', {status:503});
            }
            return nativeFetch(new URL(url, server.baseUrl), options);
        };
        const thumb = 'data:image/webp;base64,bmV3LXRodW1i';
        assert.deepEqual((await Promise.all([storage.updateHistoryThumb(entry.id, thumb, entry), storage.updateHistoryThumb(entry.id, thumb, entry)])).sort(), [false,true]);
        const updated = (await storage.getHistoryMetadata())[0];
        assert.equal(updated.thumb, thumb);
        assert.equal(await nativeFetch(new URL(updated.fileUrl, server.baseUrl)).then(r => r.text()), 'video');
        assert.deepEqual(historyOwnerRows(server), []);
    } finally { globalThis.fetch = nativeFetch; await server.stop(); }
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

test('saving generated-image history archives exact bytes and metadata without creating cache owners', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({url, options});
        return new Response(JSON.stringify({success:true, item:{id:42, fileVersion:'version'}}));
    };
    try {
        const storage = createDiskStorageApi(() => ({imageSaveUsePromptFilename:true}));
        assert.deepEqual(await storage.saveHistoryEntry({nodeId:'node-a', image:'data:image/png;base64,aGVsbG8=', mediaAssetKey:'media:shared'}), {success:true,assetKey:'media:shared',fileId:42});
        assert.equal(requests.length,1);
        assert.equal(requests[0].url,'/api/storage/library');
        const bytes=await requests[0].options.body.arrayBuffer();
        const length=new DataView(bytes).getUint32(0);
        const metadata=JSON.parse(new TextDecoder().decode(bytes.slice(4,4+length)));
        assert.equal(metadata.nodeId,'node-a'); assert.equal(metadata.usePromptFilename,true);
        assert.equal(metadata.mediaType,'image'); assert.equal(metadata.image,undefined);
        assert.equal(new TextDecoder().decode(bytes.slice(4+length)),'hello');
    } finally { globalThis.fetch=originalFetch; }
});

test('an optional thumbnail upload failure still commits the original directory image', async () => {
    const originalFetch=globalThis.fetch, OriginalImage=globalThis.Image, originalDocument=globalThis.document;
    const requests=[];
    globalThis.Image=class {set src(value){this.naturalWidth=32;this.naturalHeight=32;queueMicrotask(()=>this.onload());}};
    globalThis.document={createElement:()=>({getContext:()=>({drawImage(){}}),toDataURL:()=> 'data:image/webp;base64,dGh1bWI='})};
    globalThis.fetch=async (url,options={})=>{
        requests.push({url,options});
        return url==='/api/storage/library' ? new Response(JSON.stringify({item:{id:42,fileVersion:'v1'}})) : new Response('',{status:507});
    };
    try {
        const result=await createDiskStorageApi(()=>({})).saveHistoryEntry({image:'data:image/png;base64,aGVsbG8='});
        assert.deepEqual(result,{success:true,assetKey:'',fileId:42});
        assert.equal(requests[1].url,'/api/storage/library/42/thumbnail');
        assert.equal(JSON.parse(requests[1].options.body).fileVersion,'v1');
    } finally {globalThis.fetch=originalFetch;globalThis.Image=OriginalImage;globalThis.document=originalDocument;}
});

test('directory thumbnail updates bind the file version and report failed writes without releasing shared cache owners',async()=>{
    const originalFetch=globalThis.fetch;const requests=[];
    globalThis.fetch=async(url,options)=>{requests.push({url,options});return new Response('',{status:409});};
    try {
        assert.equal(await createDiskStorageApi(()=>({})).updateHistoryThumb(10,'data:image/webp;base64,dGh1bWI=',{fileVersion:'old'}),false);
        assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/storage/library/10/thumbnail');
        assert.deepEqual(JSON.parse(requests[0].options.body),{thumb:'data:image/webp;base64,dGh1bWI=',fileVersion:'old'});
    } finally {globalThis.fetch=originalFetch;}
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

test('failed directory persistence rejects generation without releasing shared workflow media',async()=>{
    const originalFetch=globalThis.fetch;const requests=[];
    globalThis.fetch=async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({error:'controlled disk full'}),{status:507});};
    try {
        await assert.rejects(createDiskStorageApi(()=>({})).saveHistoryEntry({image:'data:image/png;base64,aGVsbG8=',mediaAssetKey:'media:shared'}),/controlled disk full/);
        assert.deepEqual(requests.map(r=>r.url),['/api/storage/library']);
    }finally{globalThis.fetch=originalFetch;}
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
