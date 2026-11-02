import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';

const image = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-orange.png', import.meta.url))).toString('base64');
const configuration = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
};
async function point(app, selector) {
    return app.evaluate(`(()=>{const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
}
async function pointer(app, type, location, clickCount = 1) {
    await app.send('Input.dispatchMouseEvent', { type, x: location.x, y: location.y,
        button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount });
}
async function click(app, selector, count = 1) {
    await app.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...await point(app, selector)});
    await app.waitFor(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`);
    const location = await point(app, selector);
    await pointer(app, 'mousePressed', location, count); await pointer(app, 'mouseReleased', location, count);
}
async function closeParameters(app) {
    await app.evaluate("document.querySelector('#image-parameter-panel:not([hidden]) [data-parameter-action=close]')?.click()");
}
async function importImage(app) {
    await app.evaluate(`(()=>{const input=document.getElementById('media-import-file'),files=new DataTransfer();files.items.add(new File([Uint8Array.from(atob(${JSON.stringify(image.split(',')[1])}),character=>character.charCodeAt(0))],'orange.png',{type:'image/png'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await app.waitFor("document.querySelector('#media-import-drop img')?.naturalWidth>0");
}

test('an empty import card opens parameters while its explicit file button remains available', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [{ id: 'media-import', type: 'ImageImport', x: 100, y: 90 }], connections: [] }, async app => {
        await app.waitFor("document.getElementById('media-import').classList.contains('image-first-card')");
        await app.send('Page.setInterceptFileChooserDialog', { enabled: true });
        await app.evaluate("window.importPickerClicks=0;document.getElementById('media-import-file').addEventListener('click',()=>window.importPickerClicks++)");
        await closeParameters(app); await click(app, '#media-import-drop');
        await app.waitFor("!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId==='media-import'");
        assert.equal(await app.evaluate('importPickerClicks'), 0, 'clicking the image area does not unexpectedly open a file picker');
        assert.equal(await app.evaluate("Boolean(document.querySelector('.fullscreen-overlay'))"), false);
        await app.evaluate("document.getElementById('media-import-select-btn').click()");
        assert.equal(await app.evaluate('importPickerClicks'), 1, 'the explicit upload action still selects a file');
    });
});

test('import and preview picture gestures distinguish node dragging, parameter selection and original viewing', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...configuration, nodes: [
        { id: 'media-import', type: 'ImageImport', x: 90, y: 90, width: 410, height: 350, userResized: true },
        { id: 'preview', type: 'ImagePreview', x: 620, y: 90, width: 410, height: 350, userResized: true }
    ], connections: [{ id: 'image-edge', from: { nodeId: 'media-import', port: 'image' }, to: { nodeId: 'preview', port: 'image' }, type: 'image' }] }, async app => {
        await app.waitFor("document.getElementById('media-import').classList.contains('image-first-card') && document.getElementById('preview').classList.contains('image-first-card')");
        await importImage(app);
        await app.evaluate("document.getElementById('btn-run').click()");
        await app.waitFor("document.querySelector('#preview-preview img')?.naturalWidth>0");
        await app.waitFor("!document.getElementById('btn-run').disabled && !document.getElementById('media-import').classList.contains('running') && !document.getElementById('preview').classList.contains('running') && !document.getElementById('media-import-file').disabled");
        for (const [id, surface] of [['media-import', '#media-import-drop'], ['preview', '#preview-preview']]) {
            await closeParameters(app);
            const before = await app.evaluate(`(()=>{const element=document.getElementById('${id}');return {x:parseFloat(element.style.left),y:parseFloat(element.style.top)}})()`);
            const start = await point(app, surface);
            await pointer(app, 'mousePressed', start);
            await pointer(app, 'mouseMoved', { x: start.x + 44, y: start.y + 25 });
            await pointer(app, 'mouseReleased', { x: start.x + 44, y: start.y + 25 });
            const after = await app.evaluate(`(()=>{const element=document.getElementById('${id}');return {x:parseFloat(element.style.left),y:parseFloat(element.style.top)}})()`);
            assert.ok(after.x > before.x + 20 && after.y > before.y + 10, `${id} moves by dragging its picture`);
            assert.equal(await app.evaluate("Boolean(document.querySelector('.fullscreen-overlay'))"), false);
            await delay(100); await closeParameters(app);
            const returnPoint = await point(app, surface);
            await pointer(app, 'mousePressed', returnPoint, 2);
            await pointer(app, 'mouseMoved', { x: returnPoint.x + 35, y: returnPoint.y + 20 });
            await pointer(app, 'mouseMoved', returnPoint);
            await pointer(app, 'mouseReleased', returnPoint, 2);
            await delay(100);
            assert.equal(await app.evaluate("Boolean(document.querySelector('.fullscreen-overlay'))"), false, 'a drag returning to its start does not open the original');
            assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true, 'a drag returning to its start does not reopen parameters');
            await click(app, surface);
            await app.waitFor(`!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId==='${id}'`);
            assert.equal(await app.evaluate("Boolean(document.querySelector('.fullscreen-overlay'))"), false);
            if (id === 'preview') assert.equal(await app.evaluate('document.activeElement?.id'), 'preview-preview', 'picture selection preserves the preview keyboard navigation focus');
            await click(app, surface, 2);
            await app.waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
            assert.equal(await app.evaluate("document.querySelector('.fullscreen-overlay img').src"), image);
            await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
            await app.waitFor("!document.querySelector('.fullscreen-overlay')");
        }
        await closeParameters(app);
        await app.evaluate("document.querySelector('[data-nav=fit]').click()");
        assert.ok(await app.evaluate("(()=>{const node=document.getElementById('preview').getBoundingClientRect(),controls=document.getElementById('preview-controls').getBoundingClientRect();return controls.bottom<=node.bottom-4})()"), 'aspect-sized preview contains its controls above the bottom resize handle');
        await click(app, '#preview-zoom-in');
        assert.equal(await app.evaluate("document.querySelector('#preview-preview img').style.transform"), 'scale(1.25)');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true);
        assert.equal(await app.evaluate("Boolean(document.querySelector('.fullscreen-overlay'))"), false);
        await click(app, '#preview-zoom-reset');
        assert.equal(await app.evaluate("document.querySelector('#preview-preview img').style.transform"), 'scale(1)');
        await click(app, '#preview-fullscreen');
        await app.waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
        assert.equal(await app.evaluate("document.querySelector('.fullscreen-overlay img').src"), image);
    });
});
