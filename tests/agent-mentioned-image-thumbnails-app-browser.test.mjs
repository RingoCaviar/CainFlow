import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const edges = ['first', 'second'].map((id, order) => ({ id: `edge-${id}`, from: { nodeId: id, port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order })).concat({ id: 'saved-output', from: { nodeId: 'target', port: 'image' }, to: { nodeId: 'sink', port: 'image' }, type: 'image' });
const session = { autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', autoCompactTokenLimit: 100000, protocol: 'openai', taskType: 'chat', providerIds: ['p'] }, { id: 'image', modelId: 'gpt-image-1', name: '受控生图', protocol: 'openai', taskType: 'image', providerIds: ['p'] }],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test', apikey: 'test' }],
    nodes: [{ id: 'first', type: 'ImageImport', x: 20, y: 40 }, { id: 'second', type: 'ImageImport', x: 20, y: 400 },
        { id: 'target', type: 'ImageGenerate', apiConfigId: 'image', providerId: 'p', x: 500, y: 40, prompt: 'original prompt' }, { id: 'sink', type: 'ImageSave', x: 950, y: 40 }], connections: edges };
session.activeWorkflowName = 'Snapshot';
session.activeWorkflowId = 'snapshot-workflow';
session.workflowTabs = [{ name: 'Snapshot', workflowId: 'snapshot-workflow', data: { workflowId: 'snapshot-workflow', nodes: session.nodes, connections: edges } }];
const thumbnails = app => app.evaluate("[...document.querySelectorAll('.prompt-agent-message-user .prompt-agent-message-context-images img')].map(img=>img.src)");
async function upload(app, id, color) {
    await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch('/tests/fixtures/reference-${color}.png')).blob()],'${color}.png',{type:'image/png'}));const input=document.getElementById('${id}-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await app.waitFor(`fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.find(n=>n.id==='${id}')?.mediaAssetKeys?.length===1)`);
}

test('mentioned node thumbnails retain the actual reference order, preview originals and survive reopening without adding attachments', async () => {
    await withAppBrowser(session, async app => {
        await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `const nativeFetch=fetch;window.thumbnailRequests=[];window.fetch=async(url,options={})=>{if(String(url)==='/proxy'){const request=JSON.parse(options.body);thumbnailRequests.push(request);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'refine',targetSelection:{mode:'prompt-only',evidence:'优化'},message:'已优化提示词',promptPlan:{prompt:'optimized prompt',imageRoles:[]}})}}]}),{headers:{'Content-Type':'application/json'}})}return nativeFetch(url,options)};` });
        await reloadAppBrowser(app);
        await app.evaluate("document.getElementById('btn-settings').click()");
        await app.waitFor("!!document.getElementById('setting-agent-auto-compact-tokens')");
        await app.evaluate("(()=>{const field=document.getElementById('setting-agent-auto-compact-tokens');field.value='1000000';field.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('settings-close').click()})()");
        await upload(app, 'first', 'red'); await upload(app, 'second', 'blue');
        await app.evaluate("document.getElementById('target').click();(id=>{if(!document.getElementById('prompt-agent-panel').classList.contains('active'))document.getElementById('btn-prompt-agent').click();const input=document.getElementById('prompt-agent-input');if(!input.value.includes('['+id+']')){input.value+=(input.value?'\\n':'')+'@';input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));const option=[...document.querySelectorAll('.prompt-agent-node-mentions [role=option]')].find(b=>b.textContent.endsWith(' · '+id));if(!option)throw new Error('Missing node mention '+id);option.click()}})(\"target\");document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click();document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=image][data-provider-id=p]').click();(()=>{const input=document.getElementById('prompt-agent-input');input.value+=' 优化提示词';input.dispatchEvent(new Event('input',{bubbles:true}))})();document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await app.waitFor("document.querySelectorAll('.prompt-agent-message-context-images img').length===2 && document.querySelector('.prompt-agent-canvas-plan')");
        const originals = await thumbnails(app);
        assert.equal(originals.length, 2);
        assert.notEqual(originals[0], originals[1]);
        assert.equal(await app.evaluate("document.querySelector('.prompt-agent-message-context-images summary').textContent"), 'Agent 自动读取的上下文 · 2 张');
        assert.equal(await app.evaluate("document.querySelector('.prompt-agent-message-context-images details').open"), false);
        assert.match(await app.evaluate("document.querySelector('.prompt-agent-message-context-images').textContent"), /本次生图使用的参考图以方案为准/);
        assert.equal(await app.evaluate("document.querySelector('.prompt-agent-message-user [aria-label=\"你发送的图片\"]') === null"), true);
        assert.match(await app.evaluate("document.querySelector('.prompt-agent-plan-inputs').textContent"), /本次生图参考图/);
        assert.deepEqual(await app.evaluate("thumbnailRequests[0].messages.at(-1).content.filter(p=>p.type==='image_url').map(p=>p.image_url.url)"), originals);
        assert.equal(await app.evaluate("JSON.parse(thumbnailRequests[0].messages.at(-1).content.find(p=>p.type==='text').text).images.some(i=>i.origins.includes('本轮附件'))"), false);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.prompt-agent-message-context-images .prompt-agent-reference-number')].map(e=>e.textContent)"), ['1','2']);
        await app.evaluate("document.querySelector('.prompt-agent-message-context-images summary').click();document.querySelector('.prompt-agent-message-context-images img').click()");
        await app.waitFor("!!document.querySelector('.fullscreen-overlay img')");
        assert.equal(await app.evaluate("document.querySelector('.fullscreen-overlay img').src"), originals[0]);
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("!document.querySelector('.fullscreen-overlay')");
        await app.evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(button=>button.textContent==='仅应用').click()");
        await app.waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已应用并保存')");
        assert.equal(await app.evaluate("thumbnailRequests.length"), 1, 'only applying does not generate or resend the model request');
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.some(n=>n.id!=='target'&&n.prompt?.endsWith('optimized prompt')))");
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.workflowTabs?.find(tab=>tab.name==='Snapshot')?.data?.promptAgent?.messages?.[0]?.contextImages?.length===2)");
        const applied = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value)");
        assert.deepEqual(applied.connections.filter(edge=>edges.some(original=>original.id===edge.id)), edges);
        const copy = applied.nodes.find(node=>node.id!=='target'&&node.prompt?.endsWith('optimized prompt'));
        assert.equal(applied.nodes.find(node=>node.id==='target').prompt,'original prompt');
        assert.deepEqual(applied.connections.filter(edge=>edge.to.nodeId===copy.id).map(edge=>edge.from.nodeId), edges.filter(edge=>edge.to.nodeId==='target').map(edge=>edge.from.nodeId));
        await reloadAppBrowser(app);
        await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        await app.waitFor("document.querySelectorAll('.prompt-agent-message-context-images img').length===2");
        assert.deepEqual(await thumbnails(app), originals);
        assert.equal(await app.evaluate("document.querySelector('.prompt-agent-message-context-images summary').textContent"), 'Agent 自动读取的上下文 · 2 张');
        assert.equal(await app.evaluate("document.querySelector('.prompt-agent-message-context-images details').open"), false);
        await upload(app, 'first', 'orange');
        assert.deepEqual(await thumbnails(app), originals, 'editing the live source cannot rewrite historical message images');
    }, { preserveRetiredSaveNodes: true });
});
