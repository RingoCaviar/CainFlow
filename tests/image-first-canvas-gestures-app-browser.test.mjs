import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, delay, reloadAppBrowser } from './helpers/app-browser.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'gesture-image', type: 'ImageGenerate', x: 150, y: 120, apiConfigId: 'image', providerId: 'p', prompt: 'gesture image' }],
    connections: []
};

async function pointer(app, type, point, clickCount = 1) {
    await app.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left',
        buttons: type === 'mouseReleased' ? 0 : 1, clickCount });
}

async function clickPreview(app, clickCount = 1) {
    const point = await app.evaluate(`(()=>{const rect=document.querySelector('#gesture-image .image-node-result-preview').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
    await pointer(app, 'mousePressed', point, clickCount);
    await pointer(app, 'mouseReleased', point, clickCount);
}

test('image card supports drag to move, single click parameters and double click original preview', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        const { evaluate, send, waitFor } = app;
        await send('Page.addScriptToEvaluateOnNewDocument', { source: `const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{
            if(String(url)==='/proxy' && typeof JSON.parse(options.body).prompt==='string') return new Response(JSON.stringify({data:[{b64_json:'${png}'}]}),{headers:{'Content-Type':'application/json'}});
            return nativeFetch(url,options);
        };` });
        await reloadAppBrowser(app);
        await evaluate("document.getElementById('btn-run').click()");
        await waitFor("Boolean(document.querySelector('#gesture-image .image-node-result-preview')) && !document.getElementById('gesture-image-prompt').disabled");
        assert.equal(await evaluate("document.querySelector('#gesture-image [data-result-action=preview]').checkVisibility()"), false);
        const initial = await evaluate(`(()=>{const node=document.getElementById('gesture-image'),rect=node.querySelector('.image-node-result-preview').getBoundingClientRect();return {left:parseFloat(node.style.left),top:parseFloat(node.style.top),x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
        await pointer(app, 'mousePressed', initial);
        await pointer(app, 'mouseMoved', { x: initial.x + 80, y: initial.y + 50 });
        await pointer(app, 'mouseReleased', { x: initial.x + 80, y: initial.y + 50 });
        const moved = await evaluate(`(()=>{const node=document.getElementById('gesture-image');return {left:parseFloat(node.style.left),top:parseFloat(node.style.top),fullscreen:Boolean(document.querySelector('.fullscreen-overlay'))}})()`);
        assert.ok(moved.left > initial.left + 40 && moved.top > initial.top + 20, 'dragging the picture moves the node');
        assert.equal(moved.fullscreen, false, 'dragging does not open the original preview');
        await evaluate("document.querySelector('[data-parameter-action=close]').click()");
        await delay(150);
        const returnPoint = await evaluate(`(()=>{const rect=document.querySelector('#gesture-image .image-node-result-preview').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
        await pointer(app, 'mousePressed', returnPoint, 2);
        await pointer(app, 'mouseMoved', { x: returnPoint.x + 40, y: returnPoint.y + 25 });
        await pointer(app, 'mouseMoved', returnPoint);
        await pointer(app, 'mouseReleased', returnPoint, 2);
        await delay(100);
        assert.equal(await evaluate("Boolean(document.querySelector('.fullscreen-overlay'))"), false, 'a drag returning to its starting point is not a double click');
        await clickPreview(app);
        await waitFor("!document.getElementById('image-parameter-panel').hidden");
        assert.equal(await evaluate("document.querySelector('#gesture-image [data-result-action=preview]').checkVisibility()"), false);
        assert.equal(await evaluate("document.querySelector('#gesture-image [data-result-action=reference]').checkVisibility()"), true);
        assert.equal(await evaluate("Boolean(document.querySelector('.fullscreen-overlay'))"), false, 'single click opens parameters only');
        await clickPreview(app, 2);
        await waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
        assert.equal(await evaluate("document.querySelector('.fullscreen-overlay img').src"), `data:image/png;base64,${png}`, 'double click opens the original result');
    });
});
