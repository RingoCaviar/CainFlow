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
        { id: 'compare-card', type: 'ImageCompare', x: 620, y: 40, width: 400, height: 350, userResized: true, customTitle: '保留对比标题' }
    ],
    connections: [
        { id: 'a-edge', from: { nodeId: 'source-a', port: 'image' }, to: { nodeId: 'compare-card', port: 'imageA' }, type: 'image' },
        { id: 'b-edge', from: { nodeId: 'source-b', port: 'image' }, to: { nodeId: 'compare-card', port: 'imageB' }, type: 'image' }
    ]
};

async function open(app) {
    await app.evaluate("document.getElementById('compare-card').click()");
    await app.waitFor("document.getElementById('image-parameter-panel')?.dataset.nodeId==='compare-card' && !document.getElementById('image-parameter-panel').hidden");
}

async function upload(app, id, color) {
    await app.evaluate(`(async()=>{const blob=await fetch('/tests/fixtures/reference-${color}.png').then(response=>response.blob()),transfer=new DataTransfer();transfer.items.add(new File([blob],'${color}.png',{type:'image/png'}));const input=document.getElementById('${id}-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await app.waitFor(`document.querySelector('#${id}-drop img')?.naturalWidth>0`);
}

async function pointer(app, type, point, count = 1) {
    await app.send('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: count });
}

async function point(app, portion = 0.5) {
    return app.evaluate(`(()=>{const rect=document.getElementById('compare-card-compare').getBoundingClientRect();return {x:rect.x+rect.width*${portion},y:rect.y+rect.height/2}})()`);
}

test('comparison retains its original image surface, advanced operation and old geometry with an editable A/B input detail', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        assert.equal(await app.evaluate("document.getElementById('compare-card').classList.contains('image-first-card')"), true);
        await open(app);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#compare-card .node-port[data-direction=input]')].filter(port=>port.getClientRects().length).map(port=>port.dataset.port)"), ['auto']);
        assert.equal(await app.evaluate("document.getElementById('compare-card').contains(document.getElementById('compare-card-compare')) && document.getElementById('compare-card').contains(document.getElementById('compare-card-advanced-compare'))"), true);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-input-detail')?.getAttribute('aria-label')"), '输入明细');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-input-action=swap]')?.textContent"), '交换 A/B');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-input-action=swap]').disabled"), false);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').textContent"), '更新对比');
        assert.deepEqual(await app.evaluate("(()=>{const card=document.getElementById('compare-card');return [card.style.left,card.style.top,card.offsetWidth,card.offsetHeight,getComputedStyle(card.querySelector('.node-body')).paddingLeft]})()"), ['620px', '40px', 400, 350, '0px']);
        assert.equal(await app.evaluate("document.getElementById('compare-card-compare').offsetHeight>240"), true);
        const editorSize = () => app.evaluate("(()=>{const panel=document.getElementById('image-parameter-panel'),button=panel.querySelector('[data-input-action=swap]');return [panel.getBoundingClientRect().width,getComputedStyle(button).fontSize]})()");
        const readable = await editorSize();
        await app.evaluate("document.querySelector('#canvas-navigation .canvas-zoom-menu>summary').click();document.querySelector('#canvas-navigation [data-zoom=\"0.5\"]').click()");
        await app.waitFor("document.getElementById('zoom-level').textContent==='50%'");
        assert.deepEqual(await editorSize(), readable, 'A/B controls remain readable at low canvas zoom');
        assert.deepEqual(await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections)"), session.connections);
        await reloadAppBrowser(app);
        await open(app);
        assert.deepEqual(await app.evaluate("(()=>{const card=document.getElementById('compare-card');return [card.style.left,card.style.top,card.offsetWidth,card.offsetHeight]})()"), ['620px', '40px', 400, 350]);
    });
});

test('comparison divider hover remains local while click, double click and the original advanced action stay distinct', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        assert.equal(await app.evaluate("document.getElementById('compare-card').classList.contains('image-first-card')"), true);
        await upload(app, 'source-a', 'red');
        await upload(app, 'source-b', 'blue');
        await app.waitFor("document.querySelector('#compare-card-compare .image-compare-a')?.naturalWidth>0 && document.querySelector('#compare-card-compare .image-compare-b')?.naturalWidth>0");
        await open(app);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
        const position = await point(app, 0.27);
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position, button: 'none', buttons: 0 });
        await app.waitFor("document.getElementById('compare-card-compare').classList.contains('is-comparing')");
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true);
        assert.ok(Math.abs(Number.parseFloat(await app.evaluate("document.getElementById('compare-card-compare').style.getPropertyValue('--compare-x')")) - 27) < 2);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#compare-card-compare img')].map(image=>getComputedStyle(image).objectFit)"), ['contain', 'contain']);
        await pointer(app, 'mousePressed', position); await pointer(app, 'mouseReleased', position);
        await app.waitFor("!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId==='compare-card'");
        assert.equal(await app.evaluate("!!document.querySelector('.fullscreen-overlay')"), false);
        await pointer(app, 'mousePressed', position, 2); await pointer(app, 'mouseReleased', position, 2);
        await app.waitFor("!!document.querySelector('.fullscreen-overlay img')");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("!document.querySelector('.fullscreen-overlay')");
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click();document.getElementById('compare-card-advanced-compare').click()");
        await app.waitFor("!!document.querySelector('.image-compare-advanced-overlay')");
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true);
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("!document.querySelector('.image-compare-advanced-overlay')");
        await reloadAppBrowser(app);
        assert.ok(Math.abs(Number.parseFloat(await app.evaluate("document.getElementById('compare-card-compare').style.getPropertyValue('--compare-x')")) - 27) < 2, 'divider position survives reopening');
    });
});
