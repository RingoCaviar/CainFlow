import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, delay, waitForAutosave } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';

const images = await Promise.all(['red', 'blue'].map(async color =>
    'data:image/png;base64,' + (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
const session = { autoCheckUpdatesOnLoad: false,
    nodes: [{ id: 'original', type: 'ImageImport', x: 40, y: 100 }], connections: [],
    models: [{ id: 'chat', modelId: 'chat', name: 'Controlled', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', name: 'Controlled', endpoint: 'https://controlled.test/v1', apikey: 'test' }] };

test('replacement upload cannot finish on an existing original while the new write is held', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await uploadImageOriginal(app, 'original', images[0]);
        await app.evaluate(`window.uploadHeld=false;const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{
            if(String(url)==='/api/storage/media-assets'&&options.method==='PUT') {
                window.uploadHeld=true;await new Promise(resolve=>window.releaseUpload=resolve);
            }return nativeFetch(url,options);
        }`);
        let finished = false;
        const uploading = uploadImageOriginal(app, 'original', images[1]).then(() => { finished = true; });
        try {
            await app.waitFor('window.uploadHeld');
            await delay(250); // Deliberate held response: old persisted data must never satisfy this operation.
            assert.equal(finished, false);
        } finally {
            await app.evaluate('window.releaseUpload()');
            await uploading;
        }
        const bytes = await app.evaluate(`(async()=>{const saved=await fetch('/api/storage/documents/session').then(r=>r.json());const key=saved.value.nodes.find(n=>n.id==='original').mediaAssetKeys[0];return Array.from(new Uint8Array(await(await fetch('/api/storage/assets/'+encodeURIComponent(key))).arrayBuffer()))})()`);
        assert.deepEqual(Buffer.from(bytes), Buffer.from(images[1].split(',')[1], 'base64'));
    });
});

test('operation failures report HTTP, network and terminal business causes without waiting for success', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await assert.rejects(() => app.step('archive batch', async () => {
            await app.evaluate("fetch('/api/storage/library?token=private-test-value',{method:'POST',body:'bad'}).then(r=>r.text())");
            await app.waitFor('false');
        }, { failOnRequests: ['/api/storage/library'] }), error => {
            assert.match(error.message, /archive batch/);
            assert.match(error.message, /HTTP 400/);
            assert.match(error.message, /媒体保存请求不完整/);
            assert.doesNotMatch(error.message, /Timed out|private-test-value/);
            return true;
        });
        // Previous expected failures must not contaminate a later operation.
        await app.step('next operation', () => app.waitFor('true'), { failOnRequests: ['/api/storage/library'] });
        await app.step('workflow reconciliation reaches its terminal success', async () => {
            const statuses = await app.evaluate(`(async()=>{
                const post=revision=>fetch('/api/workflows/diagnostic-reconciliation',{method:'POST',
                    headers:{'Content-Type':'application/json','x-cainflow-expected-media-ownership-revision':String(revision)},
                    body:JSON.stringify({nodes:[],connections:[],mediaOwnershipRevision:1})}).then(async response=>{await response.text();return response.status});
                return [await post(999),await post(0)];
            })()`);
            assert.deepEqual(statuses, [409, 200]);
            await app.waitFor('true');
        }, { failOnRequests: ['/api/storage/library', '/api/storage/media-assets'] });
        await assert.rejects(() => app.step('workflow terminal failure', () => app.waitFor('false'), {
            failure: "'方案保存失败，请重试应用'"
        }), /workflow terminal failure.*方案保存失败/s);
        await assert.rejects(() => app.step('completed batch', () => app.waitFor('false'), {
            failure: "'批次已结束，只有 2/3 张图片'"
        }), /completed batch.*批次已结束/s);
        await app.send('Network.setBlockedURLs', { urls: ['*/api/storage/media-assets*'] });
        try {
            await assert.rejects(() => app.step('upload original', async () => {
                await app.evaluate("fetch('/api/storage/media-assets',{method:'PUT',body:'original'}).catch(()=>null)");
                await app.waitFor('false');
            }, { failOnRequests: ['/api/storage/media-assets'] }), error => {
                assert.match(error.message, /upload original/);
                assert.match(error.message, /ERR_|blocked/i);
                assert.doesNotMatch(error.message, /Timed out/);
                return true;
            });
        } finally { await app.send('Network.setBlockedURLs', { urls: [] }); }
    });
});


test('save waiting returns when clean, waits for the current disk write and reports its failure', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [{ id: 'text', type: 'Text', x: 100, y: 100, text: 'before' }], connections: [] }, async app => {
        await waitForAutosave(app);
        const started = Date.now();
        await waitForAutosave(app);
        assert.ok(Date.now() - started < 2000, 'a clean session must not sleep through the 3-second debounce');
        await app.evaluate(`window.saveNativeFetch=window.fetch;window.fetch=async(url,options={})=>{
            if(String(url)==='/api/storage/documents/session'&&options.method==='PUT'){
                window.sessionWriteHeld=true;await new Promise(resolve=>window.releaseSessionWrite=resolve);
                if(window.failSessionWrite)return new Response(JSON.stringify({error:'controlled session write failure'}),{status:503});
            }return saveNativeFetch(url,options);
        };`);
        const changeCache = () => app.evaluate("import('/js/app/bootstrap.js').then(m=>m.bootstrapCainFlowApp()).then(app=>{app.state.canvas.x+=17;app.registry.sessionManagerApi.scheduleSave({dirty:false})})");
        await changeCache();
        let finished = false;
        const waiting = waitForAutosave(app).then(() => { finished = true; });
        await app.waitFor('window.sessionWriteHeld===true');
        assert.equal(finished, false, 'the previous clean disk version cannot satisfy a held new write');
        await app.evaluate('window.releaseSessionWrite()'); await waiting;
        await app.evaluate('window.sessionWriteHeld=false;window.failSessionWrite=true');
        await changeCache();
        const failure = assert.rejects(waitForAutosave(app), /保存 session 失败|HTTP 503/);
        await app.waitFor('window.sessionWriteHeld===true');
        await app.evaluate('window.releaseSessionWrite()'); await failure;
    });
});
