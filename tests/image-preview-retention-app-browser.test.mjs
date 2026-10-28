import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'retained-import', type: 'ImageImport', x: 60, y: 70, width: 280, height: 340, userResized: true },
        { id: 'retained-preview', type: 'ImagePreview', x: 500, y: 70, width: 310, height: 360, userResized: true }
    ],
    connections: [{ id: 'retained-edge', from: { nodeId: 'retained-import', port: 'image' }, to: { nodeId: 'retained-preview', port: 'image' }, type: 'image' }]
};

async function upload(app) {
    await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(${JSON.stringify(image)})).blob()],'reference.png',{type:'image/png'}));const input=document.getElementById('retained-import-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await app.waitFor("(async()=>{const saved=(await fetch('/api/storage/documents/session').then(r=>r.json())).value;return saved?.nodes?.find(n=>n.id==='retained-import')?.mediaAssetKeys?.length===1})()");
    await app.waitFor("document.querySelector('#retained-preview-preview img')?.naturalWidth>0");
}

const previewOwners = app => app.evaluate("(async()=>{const saved=(await fetch('/api/storage/documents/session').then(r=>r.json())).value;const owners=(await fetch('/api/storage/media-owners?workflowId='+encodeURIComponent(saved.activeWorkflowId)).then(r=>r.json())).owners;return owners.filter(owner=>owner.ownerId==='retained-preview').map(({ownerType,ownerId,assetKeys,tombstoned})=>({ownerType,ownerId,assetKeys,tombstoned}))})()");

test('disconnecting a preview retains the readable current-session image and zoom with an explicit stale state', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        const { evaluate, waitFor } = app;
        await upload(app);
        const beforeOwners = await previewOwners(app);
        await evaluate("document.getElementById('retained-preview-zoom-in').click();document.getElementById('retained-preview').click()");
        await waitFor("document.getElementById('image-parameter-panel')?.dataset.nodeId==='retained-preview'");
        await evaluate("(()=>{const toggle=document.querySelector('#image-parameter-panel [data-parameter-group-toggle=input]');if(toggle && toggle.getAttribute('aria-expanded')!=='true')toggle.click();document.querySelector('#image-parameter-panel [data-input-action=disconnect]').click()})()");
        await waitFor("document.getElementById('retained-preview').dataset.previewInputState==='stale'");
        assert.equal(await evaluate("document.querySelector('#retained-preview-preview img').naturalWidth"), 1);
        assert.equal(await evaluate("document.querySelector('#retained-preview-preview img').style.transform"), 'scale(1.25)');
        assert.match(await evaluate("document.querySelector('#retained-preview .image-preview-input-status').textContent"), /未更新.*当前无输入/);
        await waitFor("(async()=>{const saved=(await fetch('/api/storage/documents/session').then(r=>r.json())).value;return saved?.connections?.length===0})()");
        const saved = await evaluate("(async()=>{const saved=(await fetch('/api/storage/documents/session').then(r=>r.json())).value;return {source:saved.nodes.find(n=>n.id==='retained-import'),preview:saved.nodes.find(n=>n.id==='retained-preview')}})()");
        assert.equal(saved.source.mediaAssetKeys.length, 1);
        assert.deepEqual(saved.preview.mediaAssetKeys, saved.source.mediaAssetKeys, 'retaining the view does not create a copy of its source assets');
        assert.deepEqual(await previewOwners(app), beforeOwners, 'disconnecting a preview preserves the existing ownership contract without adding an owner');
        assert.deepEqual([saved.preview.width,saved.preview.height], [310,360]);
        await evaluate("document.getElementById('retained-preview-fullscreen').click()");
        await waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
        assert.equal(await evaluate("document.querySelector('.fullscreen-overlay img').src"), image, 'the retained preview opens its original without new generation');
    });
});

test('an old preview retains its explicit card size and zoom preference when the connected source is restored', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        const { evaluate, waitFor } = app;
        await upload(app);
        await evaluate("document.getElementById('retained-preview-zoom-in').click()");
        await waitFor("(async()=>{const saved=(await fetch('/api/storage/documents/session').then(r=>r.json())).value;return saved?.nodes?.find(n=>n.id==='retained-preview')?.previewZoom===1.25})()");
        await reloadAppBrowser(app);
        await waitFor("document.querySelector('#retained-preview-preview img')?.naturalWidth>0");
        assert.equal(await evaluate("document.querySelector('#retained-preview-preview img').style.transform"), 'scale(1.25)');
        assert.deepEqual(await evaluate("(()=>{const node=document.getElementById('retained-preview');return [parseFloat(node.style.width),parseFloat(node.style.height)]})()"), [310,360]);
    });
});
