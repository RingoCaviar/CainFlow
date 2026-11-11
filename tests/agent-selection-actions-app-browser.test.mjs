import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'source', type: 'Text', customTitle: '真实提示词', text: 'before', x: 40, y: 100 },
        { id: 'target', type: 'ImageGenerate', customTitle: '当前画面', prompt: 'local draft', x: 420, y: 100, width: 320 },
        { id: 'other', type: 'Text', customTitle: '保留节点', text: 'unchanged', x: 40, y: 500 }],
    connections: [{ id: 'prompt-edge', from: { nodeId: 'source', port: 'text' }, to: { nodeId: 'target', port: 'prompt' }, type: 'text', order: 7 }]
};
session.activeWorkflowName = 'Selection';
session.activeWorkflowId = 'selection-workflow';
session.workflowTabs = [{ name: 'Selection', workflowId: 'selection-workflow', data: { workflowId: 'selection-workflow', nodes: session.nodes, connections: session.connections } }];
const graph = app => app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>({nodes:r.value.nodes,connections:r.value.connections}))");
const lastCard = "[...document.querySelectorAll('.prompt-agent-canvas-plan')].at(-1)";
const action = (app, text) => app.evaluate(`[...(${lastCard}).querySelectorAll('.prompt-agent-canvas-actions button')].find(button=>button.textContent===${JSON.stringify(text)}).click()`);
async function select(app, id, ctrlKey = false) {
    await app.evaluate(`(()=>{const node=document.getElementById(${JSON.stringify(id)}),r=node.getBoundingClientRect();node.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:r.left+15,clientY:r.top+15,ctrlKey:${ctrlKey}}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}))})()`);
}
async function request(app, text, plan) {
    const count = await app.evaluate("document.querySelectorAll('.prompt-agent-canvas-plan').length");
    await app.evaluate(`selectionReply=${JSON.stringify({ intent: 'generate', message: '请检查画布变更', canvasPlan: plan })};document.getElementById('prompt-agent-input').value=${JSON.stringify(text)};document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
    await app.waitFor(`document.querySelectorAll('.prompt-agent-canvas-plan').length===${count + 1}`);
    return app.evaluate("(()=>{const c=selectionRequests.at(-1).messages.at(-1).content;return JSON.parse(typeof c==='string'?c:c.find(p=>p.type==='text').text)})()");
}
async function prepareAgent(app) {
    await app.evaluate(`window.selectionRequests=[];window.selectionReply=null;window.failSelectionSave=false;const originalFetch=window.fetch;window.fetch=async(url,options={})=>{if(failSelectionSave&&String(url).startsWith('/api/workflows/')&&options.method==='POST'){failSelectionSave=false;return new Response(JSON.stringify({error:'controlled save failure'}),{status:500,headers:{'Content-Type':'application/json'}})}if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);if(body.messages){selectionRequests.push(body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(selectionReply)}}]}),{headers:{'Content-Type':'application/json'}})}}return originalFetch(url,options)};document.getElementById('btn-prompt-agent').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-provider-id=p]').click()`);
}

test('Agent uses send-time selection to revise, create or delete through reversible previewed actions without an insert button', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await prepareAgent(app);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-insert-node-context')"), null);
        await select(app, 'target');
        const first = await request(app, '优化选中画面的提示词', { version: 1, steps: [{ id: 'revise', nodeId: 'source', type: 'Text', parameters: { text: 'optimized' }, execute: false }], connections: [] });
        assert.deepEqual(first.canvas.selectedIds, ['target']);
        assert.deepEqual(first.canvas.mentionedIds, []);
        assert.equal((await graph(app)).nodes.find(node => node.id === 'source').text, 'before', 'a model reply only previews');
        await action(app, '仅应用');
        await app.waitFor(`(${lastCard}).querySelector('[role=status]').textContent.includes('已应用并保存')`);
        assert.equal(await app.evaluate("document.getElementById('source-text').value"), 'before');
        assert.deepEqual((await graph(app)).connections, session.connections);

        await select(app, 'target');
        const second = await request(app, '另外新建一个文本节点', { version: 1, steps: [{ id: 'new_note', type: 'Text', title: '新建记录', parameters: { text: 'independent' }, execute: false }], connections: [] });
        assert.deepEqual(second.canvas.selectedIds, ['target']);
        await action(app, '仅应用');
        await app.waitFor(`(${lastCard}).querySelector('[role=status]').textContent.includes('已应用并保存')`);
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer>.node').length"), 5);
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.length===5)");
        const created = (await graph(app)).nodes.find(node => node.text === 'independent').id;
        assert.equal((await graph(app)).nodes.find(node => node.id === 'target').prompt, 'local draft');
        await select(app, 'source');
        await select(app, created, true);
        const deletion = await request(app, '删除选中的这两个节点', { version: 1, steps: [], deletes: [{ nodeId: 'source' }, { nodeId: created }], connections: [] });
        assert.deepEqual(new Set(deletion.canvas.selectedIds), new Set(['source', created]));
        const beforeDelete = await graph(app);
        assert.equal(beforeDelete.nodes.length, 5);
        assert.match(await app.evaluate(`(${lastCard}).textContent`), /删除 真实提示词 \[source\]/);
        assert.match(await app.evaluate(`(${lastCard}).textContent`), /移除连线/);
        assert.equal(await app.evaluate(`[...(${lastCard}).querySelectorAll('button')].find(b=>b.textContent==='运行').hidden`), true);
        await app.evaluate('failSelectionSave=true');
        await action(app, '仅应用');
        await app.waitFor(`(${lastCard}).querySelector('[role=status]').textContent.includes('保存失败')`);
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer>.node').length"), 5, 'failed persistence restores every deleted node');
        assert.deepEqual((await graph(app)).connections, session.connections, 'failed persistence restores the existing edge');
        await action(app, '仅应用');
        await app.waitFor("!document.getElementById('source')&&document.querySelectorAll('#nodes-layer>.node').length===3");
        await app.waitFor(`(${lastCard}).querySelector('[role=status]').textContent.includes('已应用并保存')`);
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.length===3)");
        assert.deepEqual((await graph(app)).connections, []);
        await action(app, '仅应用');
        await app.waitFor(`(${lastCard}).querySelector('[role=status]').textContent.includes('已应用并保存')`);
        await action(app, '撤销本次画布操作');
        await app.waitFor("document.querySelectorAll('#nodes-layer>.node').length===5");
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.length===5)");
        assert.deepEqual((await graph(app)).connections, session.connections);
        assert.equal((await graph(app)).nodes.find(node => node.id === 'source').text, 'before', 'one undo restores the deletion, not the preceding edit');
        await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))");
        await app.waitFor("document.querySelectorAll('#nodes-layer>.node').length===3");
        assert.equal(await app.evaluate('selectionRequests.length'), 3, 'redo does not call a model');
        // Clearing the canvas selection must reach the next request as none.
        await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:1000,clientY:650}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}))");
        const last = await request(app, '新建一个空白记录', { version: 1, steps: [{ id: 'empty_note', type: 'Text', parameters: { text: '' }, execute: false }], connections: [] });
        assert.deepEqual(last.canvas.selectedIds, []);
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value?.workflowTabs?.some(tab=>tab.data?.promptAgent?.messages?.some(m=>m.canvasPlan?.deletes?.length===2)))");
        await reloadAppBrowser(app);
        await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        assert.ok(await app.evaluate("[...document.querySelectorAll('.prompt-agent-canvas-plan')].some(card=>card.textContent.includes('删除 真实提示词 [source]')&&card.textContent.includes('移除连线'))"), 'the deletion and connection impact survive reopening');
    });
});

test('an empty selected generation node can be deleted without reference pixels', async () => {
    const nodes = [{ id: 'source', type: 'ImageImport', x: 40, y: 100 }, { id: 'target', type: 'ImageGenerate', x: 420, y: 100, width: 320 }];
    const connections = [{ id: 'unfilled-reference', from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order: 3 }];
    const fixture = { ...session, nodes, connections, workflowTabs: [{ name: 'Selection', workflowId: 'selection-workflow', data: { workflowId: 'selection-workflow', nodes, connections } }] };
    await withAppBrowser(fixture, async app => {
        await prepareAgent(app);
        await select(app, 'target');
        const input = await request(app, '删除选中的空节点', { version: 1, steps: [], deletes: [{ nodeId: 'target' }], connections: [] });
        assert.deepEqual(input.canvas.selectedIds, ['target']);
        assert.ok(input.images.every(image => !image.visionAvailable));
        await action(app, '仅应用');
        await app.waitFor(`(${lastCard}).querySelector('[role=status]').textContent.includes('已应用并保存')`);
        assert.ok(await app.evaluate("!!document.getElementById('source')&&!document.getElementById('target')"));
        await action(app, '撤销本次画布操作');
        await app.waitFor("!!document.getElementById('target')");
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.connections.length===1)");
        assert.deepEqual((await graph(app)).connections, connections);
        assert.equal(await app.evaluate('selectionRequests.length'), 1);
    });
});
