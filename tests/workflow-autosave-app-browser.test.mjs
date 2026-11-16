import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

test('the shared new-workflow action creates a persisted blank graph and preserves the old unsaved canvas', { timeout: 45000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        nodes: [{ id: 'text', type: 'Text', x: 100, y: 100, text: 'before' }],
        connections: []
    }, async app => {
        const result = await app.evaluate(`(async () => {
            const { bootstrapCainFlowApp } = await import('/js/app/bootstrap.js');
            const manager = (await bootstrapCainFlowApp()).workflowManagerApi;
            const original = manager.getActiveWorkflow();
            const input = document.getElementById('text-text');
            input.value = 'still here';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));

            const creation = manager.createEmptyWorkflow();
            let busy;
            try { await manager.createEmptyWorkflow({ name: 'Second in flight' }); }
            catch (error) { busy = error.message; }
            const created = await creation;
            const persisted = await fetch('/api/workflows/' + encodeURIComponent(created.name)).then(response => response.json());
            const visible = manager.getActiveWorkflow();
            const activeGraph = manager.getActiveWorkflowSnapshot();
            const reject = async name => {
                try { await manager.createEmptyWorkflow({ name }); return ''; }
                catch (error) { return error.message; }
            };
            const duplicate = await reject(created.name);
            const invalid = await reject('../outside');
            const reserved = await reject('NUL');
            await manager.openWorkflow(original.label);
            const preserved = manager.getActiveWorkflowSnapshot();
            let current = true;
            let abandoned;
            const nativeFetch = window.fetch;
            window.fetch = async (url, options) => {
                const response = await nativeFetch(url, options);
                if (url === '/api/workflows/Saved%20without%20switching' && options?.method === 'POST') current = false;
                return response;
            };
            try {
                await manager.createEmptyWorkflow({ name: 'Saved without switching', isCurrent: () => current });
            } catch (error) { abandoned = error.message; }
            finally { window.fetch = nativeFetch; }
            const stillVisible = manager.getActiveWorkflow();
            const abandonedFile = await fetch('/api/workflows/Saved%20without%20switching').then(response => response.json());
            return { original, created, persisted, activeGraph, visible, duplicate, invalid, reserved, busy, preserved,
                abandoned, stillVisible, abandonedFile };
        })()`);
        assert.match(result.created.name, /^未命名工作流(?: \d+)?$/);
        assert.notEqual(result.created.workflowId, result.original.workflowId);
        assert.equal(result.visible.workflowId, result.created.workflowId);
        assert.equal(result.persisted.workflowId, result.created.workflowId);
        assert.deepEqual(result.persisted.nodes, []);
        assert.deepEqual(result.persisted.connections, []);
        assert.deepEqual(result.activeGraph.nodes, []);
        assert.equal(result.preserved.nodes[0].text, 'still here');
        assert.match(result.duplicate, /已存在/);
        assert.match(result.invalid, /有效/);
        assert.match(result.reserved, /有效/);
        assert.match(result.busy, /正在/);
        assert.match(result.abandoned, /已保存/);
        assert.deepEqual(result.abandonedFile.nodes, []);
        assert.equal(result.stillVisible.workflowId, result.original.workflowId);
    });
});

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
