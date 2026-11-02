import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

test('canvas edits autosave, new workflows require a name, copies activate and closing the last workflow creates no file', { timeout: 60000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://example.test', apikey: 'test' }],
        nodes: [{ id: 'text', type: 'Text', x: 100, y: 100, text: 'before' }], connections: []
    }, async app => {
        assert.equal(await app.evaluate("Boolean(document.getElementById('btn-save') || document.getElementById('btn-save-workflow'))"), false);
        const original = await app.evaluate("document.getElementById('toolbar-workflow-name').textContent");
        await app.evaluate("(()=>{const input=document.querySelector('#text textarea');input.value='autosaved text';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()");
        await app.waitFor(`fetch('/api/workflows/'+encodeURIComponent(${JSON.stringify(original)})).then(r=>r.json()).then(data=>data.nodes?.[0]?.text==='autosaved text')`);
        assert.equal(await app.evaluate("document.getElementById('toolbar-workflow-status').hidden"), true);
        await reloadAppBrowser(app);
        assert.equal(await app.evaluate("document.querySelector('#text textarea').value"), 'autosaved text');
        await app.evaluate("window.autosaveNativeFetch=window.fetch;window.fetch=(url,options={})=>String(url).startsWith('/api/workflows/')&&options.method==='POST'?Promise.resolve(new Response(JSON.stringify({error:'controlled save failure'}),{status:500,headers:{'Content-Type':'application/json'}})):autosaveNativeFetch(url,options);const input=document.querySelector('#text textarea');input.value='retained after failure';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))");
        await app.waitFor("[...document.querySelectorAll('.toast button')].some(button=>button.textContent==='重试')");
        assert.equal(await app.evaluate("[...document.querySelectorAll('.toast')].some(toast=>toast.textContent.includes('自动保存失败') && toast.textContent.includes('controlled save failure'))"), true);
        await app.evaluate(`document.getElementById('workflow-context-menu').dataset.targetName=${JSON.stringify(original)};document.getElementById('menu-close-workflow').click()`);
        await app.waitFor("!document.body.inert");
        assert.equal(await app.evaluate("document.querySelector('#text textarea').value"), 'retained after failure');
        await app.evaluate("window.fetch=autosaveNativeFetch;[...document.querySelectorAll('.toast button')].find(button=>button.textContent==='重试').click()");
        await app.waitFor(`fetch('/api/workflows/'+encodeURIComponent(${JSON.stringify(original)})).then(r=>r.json()).then(data=>data.nodes?.[0]?.text==='retained after failure')`);
        await app.evaluate("document.getElementById('btn-toggle-workflow').click();document.getElementById('btn-new-workflow').click()");
        await app.waitFor("Boolean(document.getElementById('workflow-name-input'))");
        await app.evaluate("document.getElementById('workflow-name-input').value='Named autosave';document.getElementById('workflow-name-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
        await app.waitFor("document.getElementById('toolbar-workflow-name').textContent==='Named autosave'");
        await app.evaluate("const menu=document.getElementById('workflow-context-menu');menu.dataset.targetName='Named autosave';document.getElementById('menu-copy-workflow').click()");
        await app.waitFor("Boolean(document.getElementById('workflow-name-input'))");
        await app.evaluate("document.getElementById('workflow-name-input').value='Experiment copy';document.getElementById('workflow-name-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
        await app.waitFor("document.getElementById('toolbar-workflow-name').textContent==='Experiment copy'");
        await app.evaluate("document.getElementById('btn-close-other-workflows').click()");
        await app.waitFor("document.querySelectorAll('.workflow-item.is-open').length===1");
        const files = await app.evaluate("fetch('/api/workflows').then(r=>r.json()).then(data=>data.workflows)");
        await app.evaluate("document.getElementById('workflow-context-menu').dataset.targetName='Experiment copy';document.getElementById('menu-close-workflow').click()");
        await app.waitFor("document.getElementById('toolbar-workflow-name').textContent==='未打开工作流'");
        assert.deepEqual(await app.evaluate("fetch('/api/workflows').then(r=>r.json()).then(data=>data.workflows)"), files);
    });
});
