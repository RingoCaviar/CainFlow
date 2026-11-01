import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('directory images remain visible before idle thumbnail work runs', {timeout:30000}, async () => {
    await withAppBrowser({autoCheckUpdatesOnLoad:false,models:[{id:'chat',modelId:'chat',name:'test',protocol:'openai',taskType:'chat',providerIds:['p']}],providers:[{id:'p',name:'test',endpoint:'https://controlled.test/v1',apikey:'test'}],nodes:[],connections:[]}, async app => {
        await app.evaluate('window.requestIdleCallback=()=>1');
        const image = await readFile(new URL('./fixtures/reference-red.png', import.meta.url));
        await writeFile(join(app.server.dataDir, 'exports', 'external.png'), image);
        await app.evaluate("document.getElementById('btn-history').click()");
        await app.waitFor("document.querySelectorAll('#history-list .history-card').length===1");
        await app.waitFor("document.querySelector('#history-list .history-card img')?.complete");
        assert.equal(await app.evaluate("document.querySelector('#history-list .history-card img').naturalWidth > 1"), true, 'a real original must appear instead of a transparent pixel');
    });
});
