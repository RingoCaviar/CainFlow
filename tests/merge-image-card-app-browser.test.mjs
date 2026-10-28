import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'source-a', type: 'ImageImport', x: 30, y: 40, width: 240, height: 280, userResized: true },
        { id: 'source-b', type: 'ImageImport', x: 310, y: 40, width: 240, height: 280, userResized: true },
        { id: 'merge-card', type: 'ImageMerge', x: 620, y: 40, width: 400, height: 350, userResized: true, customTitle: '保留合并标题', inputCount: 11 }
    ],
    connections: [
        { id: 'edge-tenth', from: { nodeId: 'source-b', port: 'image' }, to: { nodeId: 'merge-card', port: 'image_10' }, type: 'image' },
        { id: 'edge-second', from: { nodeId: 'source-a', port: 'image' }, to: { nodeId: 'merge-card', port: 'image_2' }, type: 'image' }
    ]
};
const inputOrder = app => app.evaluate("[...document.querySelectorAll('#image-parameter-panel [data-input-connection-id]')].map(row=>row.dataset.inputConnectionId)");
const geometry = app => app.evaluate("(()=>{const node=document.getElementById('merge-card');return [node.style.left,node.style.top,node.offsetWidth,node.offsetHeight]})()");
async function open(app) {
    await app.evaluate("document.getElementById('merge-card').click()");
    await app.waitFor("document.getElementById('image-parameter-panel')?.dataset.nodeId==='merge-card' && !document.getElementById('image-parameter-panel').hidden");
}
async function upload(app, id, color) {
    await app.evaluate(`(async()=>{const blob=await fetch('/tests/fixtures/reference-${color}.png').then(response=>response.blob()),files=new DataTransfer();files.items.add(new File([blob],'${color}.png',{type:'image/png'}));const input=document.getElementById('${id}-file');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await app.waitFor(`document.querySelector('#${id}-drop img')?.naturalWidth>0`);
}
async function clickPreview(app, count = 1) {
    const point = await app.evaluate("(()=>{const rect=document.getElementById('merge-card-merge-preview').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()");
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: count });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: count });
}

test('merge shows numeric dynamic-source order in the lower editor and keeps one input anchor and the saved image-card geometry', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.waitFor("!!document.getElementById('merge-card')");
        assert.equal(await app.evaluate("document.getElementById('merge-card').classList.contains('image-first-card')"), true);
        await open(app);
        assert.deepEqual(await inputOrder(app), ['edge-second', 'edge-tenth']);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#merge-card .node-port[data-direction=input]')].filter(port=>port.getClientRects().length).map(port=>port.dataset.port)"), ['auto']);
        assert.equal(await app.evaluate("document.getElementById('merge-card').contains(document.getElementById('merge-card-merge-preview')) && document.getElementById('merge-card').contains(document.getElementById('merge-card-merge-summary'))"), true);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').textContent"), '更新合并');
        assert.deepEqual(await geometry(app), ['620px', '40px', 400, 350]);
        assert.ok(await app.evaluate("document.getElementById('merge-card-merge-preview').offsetHeight>220"));
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#image-parameter-panel [data-input-connection-id]')].map(row=>[row.querySelector('[data-input-action=move-up]').disabled,row.querySelector('[data-input-action=move-down]').disabled])"), [[true, false], [false, true]]);
        const editorMetrics = () => app.evaluate("(()=>{const panel=document.getElementById('image-parameter-panel');return [panel.getBoundingClientRect().width,getComputedStyle(panel.querySelector('[data-input-action=move-down]')).fontSize]})()");
        const readable = await editorMetrics();
        await app.evaluate("document.querySelector('#canvas-navigation .canvas-zoom-menu>summary').click();document.querySelector('#canvas-navigation [data-zoom=\"0.5\"]').click()");
        await app.waitFor("document.getElementById('zoom-level').textContent==='50%'");
        assert.deepEqual(await editorMetrics(), readable, 'numeric source ordering stays readable at low canvas zoom');
        await app.evaluate("document.querySelector('#image-parameter-panel [data-input-connection-id=edge-second] [data-input-action=move-down]').click()");
        await app.waitFor("document.querySelector('#image-parameter-panel [data-input-connection-id]')?.dataset.inputConnectionId==='edge-tenth'");
        assert.deepEqual(await inputOrder(app), ['edge-tenth', 'edge-second']);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#merge-card .node-port[data-direction=input]')].filter(port=>port.getClientRects().length).map(port=>port.dataset.port)"), ['auto']);
        await reloadAppBrowser(app);
        await open(app);
        assert.deepEqual(await inputOrder(app), ['edge-tenth', 'edge-second']);
        assert.deepEqual(await geometry(app), ['620px', '40px', 400, 350]);
    });
});

test('merge result browsing keeps the complete output while picture clicks and original viewing remain distinct', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.waitFor("!!document.getElementById('merge-card')");
        assert.equal(await app.evaluate("document.getElementById('merge-card').classList.contains('image-first-card')"), true);
        await upload(app, 'source-a', 'red');
        await upload(app, 'source-b', 'blue');
        await open(app);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').click()");
        await app.waitFor("document.querySelector('#merge-card-merge-preview img')?.naturalWidth>0");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='merge-card')?.mediaAssetKeys?.length===2)");
        const original = await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.nodes.find(node=>node.id==='merge-card').mediaAssetKeys)");
        const before = await geometry(app);
        assert.equal(await app.evaluate("getComputedStyle(document.querySelector('#merge-card-merge-preview img')).objectFit"), 'contain');
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
        await clickPreview(app);
        await app.waitFor("!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId==='merge-card'");
        assert.equal(await app.evaluate("!!document.querySelector('.fullscreen-overlay')"), false);
        await clickPreview(app, 2);
        await app.waitFor("!!document.querySelector('.fullscreen-overlay img')");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("!document.querySelector('.fullscreen-overlay')");
        await app.evaluate("document.querySelector('#merge-card-merge-preview .image-save-preview-counter').click()");
        await app.waitFor("document.querySelector('#merge-card-merge-preview [data-preview-batch-index=\"1\"]')?.getClientRects().length>0");
        await app.evaluate("document.querySelector('#merge-card-merge-preview [data-preview-batch-index=\"1\"]').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value?.nodes.find(node=>node.id==='merge-card')?.imagePreviewIndex===1 && document.querySelector('#merge-card-merge-preview .image-save-preview-counter')?.textContent==='2/2')");
        await app.evaluate("document.getElementById('merge-card-merge-preview').focus({preventScroll:true})");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft' });
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value?.nodes.find(node=>node.id==='merge-card')?.imagePreviewIndex===0 && document.querySelector('#merge-card-merge-preview .image-save-preview-counter')?.textContent==='1/2')");
        assert.deepEqual(await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.nodes.find(node=>node.id==='merge-card').mediaAssetKeys)"), original);
        assert.deepEqual(await geometry(app), before);
        const snapshot = () => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>{const node=document.value.nodes.find(node=>node.id==='merge-card');return {index:node.imagePreviewIndex,keys:node.mediaAssetKeys,counter:window.document.querySelector('#merge-card-merge-preview .image-save-preview-counter')?.textContent}})");
        const beforeReload = await snapshot();
        assert.equal(beforeReload.index, 0, 'the browsed index is still saved immediately before reload: ' + JSON.stringify(beforeReload));
        await reloadAppBrowser(app);
        assert.deepEqual(await geometry(app), before);
        await app.waitFor("document.querySelector('#merge-card-merge-preview img')?.naturalWidth>0");
        const afterReload = await snapshot();
        assert.equal(afterReload.index, 0, 'reopening keeps the same viewing position: ' + JSON.stringify({ beforeReload, afterReload }));
    });
});
