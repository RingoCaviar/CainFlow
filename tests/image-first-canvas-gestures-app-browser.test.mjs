import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, delay, reloadAppBrowser } from './helpers/app-browser.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] }
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

test('parameter overlay follows a held canvas pan and clamps before release without replacing controls', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate("document.getElementById('gesture-image').click()");
        await app.waitFor("!document.getElementById('image-parameter-panel').hidden");
        const snapshot = () => app.evaluate(`(()=>{
            const panel=document.getElementById('image-parameter-panel'), rect=panel.getBoundingClientRect();
            const node=document.getElementById('gesture-image').getBoundingClientRect();
            return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,nodeLeft:node.left,
                width:innerWidth,height:innerHeight};
        })()`);
        await app.evaluate(`window.panPrompt=document.getElementById('gesture-image-prompt');
            panPrompt.value='retained draft';panPrompt.focus();panPrompt.setSelectionRange(2,5);`);
        const before = await snapshot();
        const start = { x: 850, y: 180 };
        const pan = async (type, x, y) => app.send('Input.dispatchMouseEvent', {
            type, x, y, button: type === 'mouseMoved' ? 'none' : 'middle',
            buttons: type === 'mouseReleased' ? 0 : 4, clickCount: 1
        });
        await pan('mousePressed', start.x, start.y);
        try {
            await pan('mouseMoved', start.x + 60, start.y + 40);
            await app.waitFor(`document.getElementById('gesture-image').getBoundingClientRect().left > ${before.nodeLeft + 30}`);
            await delay(80);
            const during = await snapshot();
            assert.ok(Math.abs(during.left - before.left - 60) < 2, 'overlay moves while middle button remains held');
            await pan('mouseMoved', start.x + 300, start.y + 1000);
            await delay(80);
            const edge = await snapshot();
            assert.ok(edge.left >= 0 && edge.right <= edge.width && edge.bottom <= edge.height,
                'overlay stays in the viewport before releasing the mouse');
            assert.deepEqual(await app.evaluate(`({same:panPrompt===document.getElementById('gesture-image-prompt'),
                value:panPrompt.value,start:panPrompt.selectionStart,end:panPrompt.selectionEnd})`),
                { same: true, value: 'retained draft', start: 2, end: 5 });
        } finally {
            await pan('mouseReleased', start.x + 300, start.y + 1000);
        }
    });
});

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
        assert.deepEqual(await evaluate(`(()=>{const node=document.getElementById('gesture-image');return {
            global:document.body.classList.contains('is-interacting'),local:node.classList.contains('is-interacting'),
            childOffset:getComputedStyle(node.querySelector('.node-header')).getPropertyValue('--node-drag-x').trim(),
            transform:getComputedStyle(node).transform};})()`), {
            global:false,local:true,childOffset:'0px',transform:'matrix(1, 0, 0, 1, 80, 50)'
        }, 'drag transforms stay on the node without invalidating the whole canvas or inheriting into controls');
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
