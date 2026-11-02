import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const edges = ['first', 'second'].map((id, order) => ({ id: `edge-${id}`, from: { nodeId: id, port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' }, type: 'image', order })).concat({ id: 'saved-output', from: { nodeId: 'target', port: 'image' }, to: { nodeId: 'sink', port: 'image' }, type: 'image' });
const session = { autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', autoCompactTokenLimit: 100000, protocol: 'openai', taskType: 'chat', providerIds: ['p'] }, { id: 'image', modelId: 'gpt-image-1', name: '受控生图', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }],
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
        await app.evaluate("document.getElementById('target').click();document.getElementById('target-assistant').click();document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click();document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=image][data-provider-id=p]').click();document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await app.waitFor("document.querySelectorAll('.prompt-agent-message-context-images img').length===2 && document.querySelector('.prompt-agent-canvas-plan')");
        const originals = await thumbnails(app);
        assert.equal(originals.length, 2);
        assert.notEqual(originals[0], originals[1]);
        assert.deepEqual(await app.evaluate("thumbnailRequests[0].messages.at(-1).content.filter(p=>p.type==='image_url').map(p=>p.image_url.url)"), originals);
        assert.equal(await app.evaluate("JSON.parse(thumbnailRequests[0].messages.at(-1).content.find(p=>p.type==='text').text).images.some(i=>i.origins.includes('本轮附件'))"), false);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.prompt-agent-message-context-images .prompt-agent-reference-number')].map(e=>e.textContent)"), ['1','2']);
        await app.evaluate("document.querySelector('.prompt-agent-message-context-images img').click()");
        await app.waitFor("!!document.querySelector('.fullscreen-overlay img')");
        assert.equal(await app.evaluate("document.querySelector('.fullscreen-overlay img').src"), originals[0]);
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("!document.querySelector('.fullscreen-overlay')");
        await app.evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(button=>button.textContent==='仅应用').click()");
        await app.waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已应用并保存')");
        assert.equal(await app.evaluate("thumbnailRequests.length"), 1, 'only applying does not generate or resend the model request');
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.find(n=>n.id==='target').prompt.endsWith('optimized prompt'))");
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.workflowTabs?.find(tab=>tab.name==='Snapshot')?.data?.promptAgent?.messages?.[0]?.contextImages?.length===2)");
        assert.deepEqual(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.connections)"), edges);
        await reloadAppBrowser(app);
        await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        await app.waitFor("document.querySelectorAll('.prompt-agent-message-context-images img').length===2");
        assert.deepEqual(await thumbnails(app), originals);
        await upload(app, 'first', 'orange');
        assert.deepEqual(await thumbnails(app), originals, 'editing the live source cannot rewrite historical message images');
    }, { preserveRetiredSaveNodes: true });
});
