import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'source', type: 'ImageGenerate', x: 40, y: 40, apiConfigId: 'image', providerId: 'p', prompt: 'shared draft' },
        { id: 'clone', type: 'ImageGenerate', x: 500, y: 40, apiConfigId: 'image', providerId: 'p', prompt: 'shared draft', isClone: true, cloneSourceId: 'source' }
    ],
    connections: []
};

test('making an image generation clone independent unlocks its detached parameter controls', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate("document.querySelector('#clone .image-first-placeholder button').click()");
        await app.waitFor("document.getElementById('image-parameter-panel').dataset.nodeId==='clone'");
        assert.equal(await app.evaluate("document.getElementById('clone-prompt').disabled"), true);
        assert.equal(await app.evaluate("document.getElementById('clone-apiconfig').disabled"), true);
        await app.evaluate("document.getElementById('clone').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:100}));document.getElementById('context-menu-detach-clone-node').click()");
        assert.equal(await app.evaluate("document.getElementById('clone').classList.contains('node-clone')"), false);
        assert.equal(await app.evaluate("document.getElementById('clone-prompt').disabled"), false);
        assert.equal(await app.evaluate("document.getElementById('clone-prompt').readOnly"), false);
        assert.equal(await app.evaluate("document.getElementById('clone-apiconfig').disabled"), false);
        await app.evaluate("(()=>{const input=document.getElementById('clone-prompt');input.value='independent draft';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()");
        await app.waitFor("(async()=>{const response=await fetch('/api/storage/documents/session').then(r=>r.json());return response.value?.nodes?.find(n=>n.id==='clone')?.prompt==='independent draft'})()");
        const graph = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value)");
        assert.equal(graph.nodes.find(node => node.id === 'source').prompt, 'shared draft');
        assert.notEqual(graph.nodes.find(node => node.id === 'clone').isClone, true);
        assert.deepEqual(graph.connections, []);
    });
});

test('a user-sized image card retains its preview height when opening, editing and reopening', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [{ ...session.nodes[0], width: 460, height: 640, userResized: true }] }, async app => {
        const measurements = () => app.evaluate("(()=>{const node=document.getElementById('source'),preview=node.querySelector('.image-first-placeholder');return {x:node.style.left,y:node.style.top,width:node.offsetWidth,height:node.offsetHeight,previewHeight:preview.offsetHeight}})()");
        const original = await measurements();
        const { previewHeight, ...layout } = original;
        assert.deepEqual(layout, { x: '40px', y: '40px', width: 460, height: 640 });
        assert.ok(previewHeight >= 400, 'the restored image preview keeps a substantial user-sized area');
        await app.evaluate("document.querySelector('#source .image-first-placeholder button').click();document.querySelector('#image-parameter-panel [data-parameter-group-toggle=size]').click()");
        await app.evaluate("(()=>{const input=document.getElementById('source-resolution');input.value='1024x1024';input.dispatchEvent(new Event('change',{bubbles:true}));})()");
        assert.deepEqual(await measurements(), original, 'editing parameters must not shrink the explicitly sized preview');
        await app.waitFor("(async()=>{const response=await fetch('/api/storage/documents/session').then(r=>r.json());const node=response.value?.nodes?.find(n=>n.id==='source');return node?.height===640 && node?.userResized===true})()");
        await reloadAppBrowser(app);
        assert.deepEqual(await measurements(), original);
    });
});
