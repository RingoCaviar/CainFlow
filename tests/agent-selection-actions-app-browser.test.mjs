import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';

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

test('Agent applies and runs an explicit shared-prompt image batch using the selection captured at Send', { timeout: 60000 }, async () => {
    const workflowId = 'agent-shared-image-batch';
    const sources = ['red', 'blue'];
    const images = await Promise.all(sources.map(async color =>
        (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
    const nodes = [...sources.map((id, index) => ({ id, type: 'ImageImport', x: 100, y: 100 + index * 300 })),
        { id: 'example', type: 'Text', text: '保持商品细节，换成中性背景', x: 400, y: 100 },
        { id: 'old-generation', type: 'ImageGenerate', prompt: '旧生成', x: 700, y: 100 }];
    const data = { workflowId, nodes, connections: [] };
    const fixture = { ...session, ...data, activeWorkflowName: 'Batch', activeWorkflowId: workflowId,
        workflowTabs: [{ name: 'Batch', workflowId, data }],
        models: [...session.models, { id: 'gemini', modelId: 'gemini-3-pro-image-preview', name: '受控生图',
            taskType: 'image', protocol: 'google', providerIds: ['p'] }] };
    const prompt = '保持商品细节，换成中性背景';
    const initScript = `window.batchChat=[];window.batchImages=[];const originalFetch=window.fetch;
            window.fetch=async (url,options={})=>{
                if(String(url)==='/proxy'&&options.body){
                    const body=JSON.parse(options.body);
                    if(body.messages){
                        batchChat.push(body);
                        if(batchChat.length===1)await new Promise(resolve=>window.resumeBatchChat=resolve);
                        const reply=batchChat.length===1?{intent:'clarify',message:'请明确指定方案使用的画布参考图'}:
                            {intent:'generate',canvasBatch:{prompt:${JSON.stringify(prompt)}}};
                        return Response.json({choices:[{message:{content:JSON.stringify(reply)}}]});
                    }
                    batchImages.push(body);
                    return Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:${JSON.stringify(images[0])}}}]}}]});
                }
                return originalFetch(url,options);
            };`;
    await withAppBrowser(fixture, async app => {
        for (const [index, id] of sources.entries()) await uploadImageOriginal(app, id, `data:image/png;base64,${images[index]}`);
        await app.evaluate(`
            document.getElementById('btn-prompt-agent').click();
            document.querySelector('#prompt-agent-model + button').click();
            document.querySelector('#prompt-agent-model-menu [data-provider-id=p]').click();
            document.querySelector('#prompt-agent-image-model + button').click();
            document.querySelector('#prompt-agent-image-model-menu [data-provider-id=p]').click();`);
        await select(app, 'red');
        await select(app, 'blue', true);
        await select(app, 'example', true);
        await select(app, 'old-generation', true);
        await app.evaluate(`document.getElementById('prompt-agent-input').value='按选中的配置自己写一个提示词，逐张处理选中的原图，统一16:9和2K，连好后直接跑批处理';document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
        await app.waitFor('Boolean(window.resumeBatchChat)');
        await app.evaluate("(async()=>{const { state }=await import('/js/app/bootstrap.js').then(m=>m.bootstrapCainFlowApp());(await import('/js/canvas/selection.js')).createSelectionApi({state}).clearSelection()})()");
        assert.equal(await app.evaluate("document.getElementById('blue').classList.contains('selected')"), false);
        await app.evaluate('window.resumeBatchChat()');
        await app.waitFor(`(${lastCard})?.querySelector('[role=status]')?.textContent.includes('执行结束')`);
        assert.equal(await app.evaluate('batchChat.length'), 2);
        const requests = await app.evaluate('batchImages');
        assert.equal(requests.length, 2, 'run starts without a second user action');
        assert.deepEqual(requests.map(request => request.contents[0].parts.filter(part => part.inlineData).map(part => part.inlineData.data)).flat().sort(), [...images].sort());
        for (const request of requests) {
            assert.ok(request.contents[0].parts.some(part => part.text?.includes(prompt)));
            assert.equal(request.generationConfig.imageConfig.aspectRatio, '16:9');
            assert.equal(request.generationConfig.imageConfig.imageSize, '2K');
        }
        const applied = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value)");
        assert.equal(applied.nodes.filter(node => node.type === 'Text' && node.text === prompt).length, 2);
        assert.equal(applied.connections.filter(link => link.to.port === 'prompt').length, 2);
        assert.deepEqual(applied.connections.filter(link => link.to.port === 'referenceImages').map(link => link.from.nodeId).sort(), sources.slice().sort());
        assert.ok(applied.nodes.some(node => node.id === 'old-generation' && node.prompt === '旧生成'));
    }, { initScript });
});

test('Agent uses send-time selection to revise, create or delete through reversible previewed actions without an insert button', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await prepareAgent(app);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-insert-node-context')"), null);
        await select(app, 'target');
        const first = await request(app, '优化选中画面的提示词', { version: 1, steps: [{ id: 'revise', nodeId: 'source', type: 'Text', parameters: { text: 'optimized' } }], connections: [] });
        assert.deepEqual(first.canvas.selectedIds, ['target']);
        assert.deepEqual(first.canvas.mentionedIds, []);
        assert.equal((await graph(app)).nodes.find(node => node.id === 'source').text, 'before', 'a model reply only previews');
        assert.equal(await app.evaluate(`[...(${lastCard}).querySelectorAll('button')].find(b=>b.textContent==='运行').hidden`), true);
        await action(app, '仅应用');
        await app.waitFor(`(${lastCard}).querySelector('[role=status]').textContent.includes('已应用并保存')`);
        assert.equal(await app.evaluate("document.getElementById('source-text').value"), 'optimized');
        assert.equal((await graph(app)).nodes.length, 3);
        assert.equal((await graph(app)).nodes.find(node => node.id === 'other').text, 'unchanged');
        assert.deepEqual((await graph(app)).connections, session.connections);

        await select(app, 'target');
        const second = await request(app, '另外新建一个文本节点', { version: 1, steps: [{ id: 'new_note', type: 'Text', title: '新建记录', parameters: { text: 'independent' }, execute: false }], connections: [] });
        assert.deepEqual(second.canvas.selectedIds, ['target']);
        await action(app, '仅应用');
        await app.waitFor(`(${lastCard}).querySelector('[role=status]').textContent.includes('已应用并保存')`);
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer>.node').length"), 4);
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.length===4)");
        const created = (await graph(app)).nodes.find(node => node.text === 'independent').id;
        assert.equal((await graph(app)).nodes.find(node => node.id === 'target').prompt, 'local draft');
        await select(app, 'source');
        await select(app, created, true);
        const deletion = await request(app, '删除选中的这两个节点', { version: 1, steps: [], deletes: [{ nodeId: 'source' }, { nodeId: created }], connections: [] });
        assert.deepEqual(new Set(deletion.canvas.selectedIds), new Set(['source', created]));
        const beforeDelete = await graph(app);
        assert.equal(beforeDelete.nodes.length, 4);
        assert.match(await app.evaluate(`(${lastCard}).textContent`), /删除 真实提示词 \[source\]/);
        assert.match(await app.evaluate(`(${lastCard}).textContent`), /移除连线/);
        assert.equal(await app.evaluate(`[...(${lastCard}).querySelectorAll('button')].find(b=>b.textContent==='运行').hidden`), true);
        await app.evaluate('failSelectionSave=true');
        await action(app, '仅应用');
        await app.waitFor(`(${lastCard}).querySelector('[role=status]').textContent.includes('保存失败')`);
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer>.node').length"), 4, 'failed persistence restores every deleted node');
        assert.deepEqual((await graph(app)).connections, session.connections, 'failed persistence restores the existing edge');
        await action(app, '仅应用');
        await app.waitFor("!document.getElementById('source')&&document.querySelectorAll('#nodes-layer>.node').length===2");
        await app.waitFor(`(${lastCard}).querySelector('[role=status]').textContent.includes('已应用并保存')`);
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.length===2)");
        assert.deepEqual((await graph(app)).connections, []);
        await action(app, '仅应用');
        await app.waitFor(`(${lastCard}).querySelector('[role=status]').textContent.includes('已应用并保存')`);
        await action(app, '撤销本次画布操作');
        await app.waitFor("document.querySelectorAll('#nodes-layer>.node').length===4");
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.length===4)");
        assert.deepEqual((await graph(app)).connections, session.connections);
        assert.equal((await graph(app)).nodes.find(node => node.id === 'source').text, 'optimized');
        await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))");
        await app.waitFor("document.querySelectorAll('#nodes-layer>.node').length===2");
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

test('Agent previews clearing the selected reference inputs in place and undo restores just those edges', { timeout: 45000 }, async () => {
    const nodes = [
        ...session.nodes,
        { id: 'original', type: 'ImageImport', x: 40, y: 280 },
        { id: 'second', type: 'ImageGenerate', customTitle: '第二个目标', prompt: 'second draft', x: 750, y: 100 },
        { id: 'untouched', type: 'ImageGenerate', customTitle: '选区外目标', prompt: 'leave me', x: 750, y: 390 }
    ];
    const connections = [...session.connections, ...['target', 'second', 'untouched'].map(nodeId => ({
        id: `reference-${nodeId}`, type: 'image', order: 0,
        from: { nodeId: 'original', port: 'image' }, to: { nodeId, port: 'referenceImages' }
    }))];
    const data = { workflowId: session.activeWorkflowId, nodes, connections };
    const fixture = { ...session, ...data, workflowTabs: [{ name: 'Selection', workflowId: data.workflowId, data }] };
    await withAppBrowser(fixture, async app => {
        const liveGraph = () => app.evaluate("import('/js/app/bootstrap.js').then(m=>m.bootstrapCainFlowApp()).then(a=>a.workflowManagerApi.getActiveWorkflowSnapshot())");
        await prepareAgent(app);
        await select(app, 'target');
        await select(app, 'second', true);
        const before = await liveGraph();
        assert.deepEqual(before.connections.map(link => link.id), connections.map(link => link.id));
        await app.evaluate(`selectionReply={intent:'generate',canvasPlan:{version:1,steps:[],connections:[]}};
            document.getElementById('prompt-agent-input').value='把我选中节点的参考图都移除';
            document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
        await app.waitFor(`Boolean(${lastCard}) || document.getElementById('prompt-agent-messages').textContent.includes('画布方案必须为 v1')`);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-messages').textContent.includes('画布方案必须为 v1')"), false);
        assert.equal(await app.evaluate('selectionRequests.length'), 0);
        assert.deepEqual((await liveGraph()).connections, before.connections);

        const preview = await app.evaluate(`(${lastCard}).textContent`);
        assert.match(preview, /移除连线.+当前画面/);
        assert.match(preview, /移除连线.+第二个目标/);
        assert.doesNotMatch(preview, /选区外目标|选择可用的生图模型/);
        assert.equal(await app.evaluate(`[...(${lastCard}).querySelectorAll('button')].find(b=>b.textContent==='运行').hidden`), true);
        await select(app, 'untouched');
        await action(app, '仅应用');
        await app.waitFor(`(${lastCard}).querySelector('[role=status]').textContent.includes('已应用并保存')`);
        const after = await app.evaluate("fetch('/api/workflows/Selection').then(r=>r.json())");
        const promptsByNode = graph => Object.fromEntries(graph.nodes.map(({ id, prompt }) => [id, prompt]));
        assert.deepEqual(promptsByNode(after), promptsByNode(before));
        assert.deepEqual(after.connections, before.connections.filter(link => ['prompt-edge', 'reference-untouched'].includes(link.id)));
        await action(app, '撤销本次画布操作');
        await app.waitFor(async () => (await liveGraph()).connections.length === 4);
        assert.deepEqual((await liveGraph()).connections, before.connections);
    });
});
