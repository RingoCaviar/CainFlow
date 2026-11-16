import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('directory images remain visible before idle thumbnail work runs', {timeout:30000}, async () => {
    await withAppBrowser({autoCheckUpdatesOnLoad:false,models:[{id:'chat',modelId:'chat',name:'test',protocol:'openai',taskType:'chat',providerIds:['p']}],providers:[{id:'p',name:'test',endpoint:'https://controlled.test/v1',apikey:'test'}],nodes:[],connections:[]}, async app => {
        await app.evaluate(`const requestIdle = window.requestIdleCallback.bind(window);
            window.requestIdleCallback = (callback, options) => {
                // Hold history's idle task without interfering with the startup cache tasks.
                if (options?.timeout !== 1000) return requestIdle(callback, options);
                window.thumbnailJob = callback;
                return 1;
            };
            window.historyListRequests=0;
            const originalFetch=window.fetch;
            window.fetch=(url,...args)=>{
                if(String(url).startsWith('/api/storage/library?') && new URL(url, location.href).searchParams.get('limit') === '100') {
                    window.historyListRequests++;
                }
                return originalFetch(url,...args);
            };`);
        const image = await readFile(new URL('./fixtures/reference-red.png', import.meta.url));
        await writeFile(join(app.server.dataDir, 'exports', 'external.png'), image);
        await app.evaluate("document.getElementById('btn-history').click()");
        await app.waitFor("document.querySelectorAll('#history-list .history-card').length===1");
        await app.waitFor("typeof window.thumbnailJob === 'function' && document.querySelector('#history-list .history-card img')?.complete");
        assert.equal(await app.evaluate('window.historyListRequests'), 1, 'sidebar gets its page and total in one request');
        assert.equal(await app.evaluate("document.querySelector('#history-list .history-card img').naturalWidth > 1"), true, 'a real original must appear instead of a transparent pixel');
        await app.evaluate(`window.hydrationFileReads=0;
            const fetchBeforeHydration=window.fetch;
            window.fetch=(url,...args)=>{if(String(url).endsWith('/file'))hydrationFileReads++;return fetchBeforeHydration(url,...args)};
            // Startup work may also request an idle slot after the history card is visible.
            window.requestIdleCallback(() => {}, { timeout: 6000 });
            window.thumbnailJob({timeRemaining:()=>0});`);
        await app.waitFor("document.querySelector('#history-list .history-card img')?.src.startsWith('data:image/webp')");
        assert.equal(await app.evaluate('window.hydrationFileReads'),0,'loaded directory preview is reused');
    });
});


test('saved images already have thumbnails and thumbnail failure keeps the original', {timeout:30000}, async () => {
    await withAppBrowser({autoCheckUpdatesOnLoad:false,models:[{id:'chat',modelId:'chat',name:'test',protocol:'openai',taskType:'chat',providerIds:['p']}],providers:[{id:'p',name:'test',endpoint:'https://controlled.test/v1',apikey:'test'}],nodes:[],connections:[]}, async app => {
        const image = await readFile(new URL('./fixtures/reference-red.png', import.meta.url));
        const result = await app.evaluate(`(async()=>{
            const {createDiskStorageApi}=await import('/js/services/storage-disk.js');
            const api=createDiskStorageApi(()=>({}));
            const image='data:image/png;base64,${image.toString('base64')}';
            const first=await api.saveHistoryEntry({image});
            const entries=await api.getHistoryMetadata();
            const fetchOriginal=window.fetch;
            let fileRequests=0;
            window.fetch=(url,...args)=>{if(String(url).endsWith('/file'))fileRequests++;return fetchOriginal(url,...args)};
            document.getElementById('btn-history').click();
            await new Promise(r=>setTimeout(r,300));
            const reads=fileRequests;
            window.fetch=(url,...args)=>String(url).endsWith('/thumbnail')?Promise.reject(new Error('thumbnail unavailable')):fetchOriginal(url,...args);
            const second=await api.saveHistoryEntry({image});
            window.fetch=fetchOriginal;
            return {thumb:entries[0].thumb,reads,second,original:(await api.getHistoryEntry(second.fileId)).image};
        })()`);
        assert.match(result.thumb, /^data:image\/webp;base64,/);
        assert.equal(result.reads,0);
        assert.equal(result.second.success,true);
        assert.ok(result.original);
    });
});

test('history preview edits and clears an image note without changing the original prompt or bytes', {timeout:30000}, async () => {
    await withAppBrowser({autoCheckUpdatesOnLoad:false,nodes:[],connections:[]}, async app => {
        const image = await readFile(new URL('./fixtures/reference-red.png', import.meta.url));
        const id = await app.evaluate(`(async () => {
            const { createDiskStorageApi } = await import('/js/services/storage-disk.js');
            window.noteHistory = createDiskStorageApi(() => ({}));
            const image = 'data:image/png;base64,${image.toString('base64')}';
            return (await noteHistory.saveHistoryEntry({image,prompt:'原始提示词'})).fileId;
        })()`);
        await app.evaluate("document.getElementById('btn-history').click()");
        const card = `#history-list .history-card[data-id="${id}"]`;
        await app.waitFor(`Boolean(document.querySelector('${card}'))`);
        await app.evaluate(`document.querySelector('${card}').click()`);
        await app.waitFor("document.getElementById('history-preview-img').naturalWidth > 1");
        await app.evaluate(`(() => {
            const note = document.getElementById('preview-note');
            note.focus();
            note.value = '参考说明 <b>原样</b>';
            note.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
            document.getElementById('btn-save-note').click();
        })()`);
        await app.waitFor(`document.querySelector('${card} .history-card-note')?.textContent === '参考说明 <b>原样</b>'`);
        const saved = await app.evaluate(`(async () => ({
            prompt: document.getElementById('preview-prompt').textContent,
            safeText: !document.querySelector('${card} .history-card-note b'),
            page: await noteHistory.listHistoryImages({id:${id}}),
            entry: await noteHistory.getHistoryEntry(${id})
        }))()`);
        assert.equal(saved.prompt, '原始提示词');
        assert.equal(saved.safeText, true);
        assert.deepEqual(saved.page.items.map(item => item.id), [id]);
        assert.equal(saved.page.items[0].note, '参考说明 <b>原样</b>');
        assert.equal(saved.page.items[0].fileUrl, undefined);
        assert.equal(saved.page.items[0].directory, undefined);
        assert.equal(saved.entry.image, `data:image/png;base64,${image.toString('base64')}`);
        await app.evaluate("document.getElementById('btn-close-preview').click()");
        await app.evaluate(`document.querySelector('${card}').click()`);
        assert.equal(await app.evaluate("document.getElementById('preview-note').value"), '参考说明 <b>原样</b>');
        await app.evaluate("document.getElementById('preview-note').value = ''; document.getElementById('btn-save-note').click()");
        await app.waitFor(`!document.querySelector('${card} .history-card-note')`);
        assert.equal(await app.evaluate(`noteHistory.listHistoryImages({id:${id}}).then(page => page.items[0].note)`), '');
    });
});
