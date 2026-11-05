import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'resize-card', type: 'ImageResize', x: 80, y: 40, width: 330, height: 520, userResized: true,
            resizeMode: 'dimensions', scalePercent: 62, targetWidth: 320, targetHeight: 180, keepAspect: false, quality: 83 },
        { id: 'color-card', type: 'ColorReset', x: 530, y: 40, width: 340, height: 350, userResized: true,
            whiteBalanceMode: 'custom', whiteBalanceGains: { r: 1.1, g: 1, b: 0.9 },
            temperature: 12, tint: -8, vibrance: 19, saturation: -3 }
    ],
    connections: []
};

async function open(app, id) {
    await app.evaluate(`document.getElementById('${id}').click()`);
    await app.waitFor(`document.getElementById('image-parameter-panel')?.dataset.nodeId==='${id}' && !document.getElementById('image-parameter-panel').hidden`);
}

async function field(app, id, value) {
    await app.evaluate(`(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

async function layout(app) {
    return app.evaluate(`['resize-card','color-card'].map(id=>{const node=document.getElementById(id);return {id,x:node.style.left,y:node.style.top,width:node.offsetWidth,height:node.offsetHeight}})`);
}

async function clickImage(app, selector, count = 1) {
    const point = await app.evaluate(`(()=>{const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: count });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: count });
}

test('resize and color cards preserve their original image surfaces and complete controls in one screen-space editor', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        assert.equal(await app.evaluate("document.getElementById('resize-card').classList.contains('image-first-card')"), true);
        const initial = await layout(app);
        assert.deepEqual(initial, [{ id: 'resize-card', x: '80px', y: '40px', width: 330, height: 520 },
            { id: 'color-card', x: '530px', y: '40px', width: 340, height: 350 }]);
        for (const [id, surface, fields, action] of [
            ['resize-card', 'resize-preview', ['resize-mode', 'scale-percent', 'target-width', 'target-height', 'keep-aspect', 'quality'], '处理图片'],
            ['color-card', 'color-preview', ['white-balance', 'white-balance-picker', 'temperature', 'tint', 'vibrance', 'saturation'], '应用调色']
        ]) {
            await open(app, id);
            assert.equal(await app.evaluate(`document.getElementById('${id}').contains(document.getElementById('${id}-${surface}'))`), true);
            assert.deepEqual(await app.evaluate(`${JSON.stringify(fields)}.map(suffix=>document.getElementById('image-parameter-panel').contains(document.getElementById('${id}-'+suffix)))`), fields.map(() => true));
            assert.equal(await app.evaluate(`document.querySelector('#${id} .node-body').querySelectorAll('input,select').length`), 0);
            assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').textContent"), action);
            assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('#${id} .node-port[data-direction=input]')].filter(port=>port.getClientRects().length).map(port=>port.dataset.port)`), ['auto']);
            const surfaceGeometry = await app.evaluate(`(()=>{const card=document.getElementById('${id}'),surface=document.getElementById('${id}-${surface}');return {padding:getComputedStyle(card.querySelector('.node-body')).paddingLeft,height:surface.offsetHeight,header:getComputedStyle(card.querySelector('.node-header')).position,top:document.getElementById('image-parameter-panel').getBoundingClientRect().top,bottom:card.getBoundingClientRect().bottom}})()`);
            assert.equal(surfaceGeometry.padding, '0px', 'processing thumbnails meet the card edge without a decorative mat');
            assert.equal(surfaceGeometry.header, 'absolute');
            assert.ok(surfaceGeometry.height > 240, 'user-sized image area remains substantial: ' + id + ' ' + JSON.stringify(surfaceGeometry));
            const editor = await app.evaluate("(()=>{const panel=document.getElementById('image-parameter-panel'),r=panel.getBoundingClientRect(),s=panel.querySelector('.image-parameter-scroll');return {top:r.top,bottom:r.bottom,viewport:innerHeight,content:s.scrollHeight,available:s.clientHeight}})()");
            assert.ok(editor.top >= 12 && editor.bottom <= editor.viewport - 12, 'editor stays inside the viewport: ' + JSON.stringify(editor));
            assert.ok(editor.content <= editor.available + 1, 'ordinary processing parameters fit without unnecessary scrolling: ' + JSON.stringify(editor));
        }
        await open(app, 'resize-card');
        await field(app, 'resize-card-target-width', '300');
        await field(app, 'resize-card-quality', '77');
        await open(app, 'color-card');
        await field(app, 'color-card-temperature', '24');
        await field(app, 'color-card-vibrance', '31');
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
        assert.equal(await app.evaluate("document.querySelectorAll('[id=resize-card-target-width]').length"), 1);
        assert.equal(await app.evaluate("document.querySelectorAll('[id=color-card-temperature]').length"), 1);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='resize-card')?.quality===77 && document.value?.nodes.find(node=>node.id==='color-card')?.temperature===24)");
        assert.deepEqual(await layout(app), initial);
        await reloadAppBrowser(app);
        await open(app, 'resize-card');
        assert.deepEqual(await app.evaluate("['resize-mode','scale-percent','target-width','target-height','quality'].map(suffix=>document.getElementById('resize-card-'+suffix).value)"), ['dimensions', '62', '300', '180', '77']);
        assert.equal(await app.evaluate("document.getElementById('resize-card-keep-aspect').checked"), false);
        await open(app, 'color-card');
        assert.deepEqual(await app.evaluate("['white-balance','temperature','tint','vibrance','saturation'].map(suffix=>document.getElementById('color-card-'+suffix).value)"), ['custom', '24', '-8', '31', '-3']);
        assert.deepEqual(await layout(app), initial);
    });
});

test('processing clone settings stay read-only after moving to the shared editor', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [session.nodes[0], { ...session.nodes[0], id: 'resize-clone', x: 500, isClone: true, cloneSourceId: 'resize-card' }] }, async app => {
        assert.equal(await app.evaluate("document.getElementById('resize-clone').classList.contains('image-first-card')"), true);
        await open(app, 'resize-clone');
        assert.deepEqual(await app.evaluate("['scale-percent','target-width','target-height','keep-aspect','quality'].map(suffix=>document.getElementById('resize-clone-'+suffix).disabled)"), [true, true, true, true, true]);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').textContent"), '处理图片');
    });
});

test('processing pictures select parameters on one click, open originals on double click and preserve eyedropper priority', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...session, nodes: [
        { id: 'processing-import', type: 'ImageImport', x: 20, y: 40, width: 260, height: 270, userResized: true },
        { id: 'resize-card', type: 'ImageResize', x: 350, y: 40, width: 300, height: 350, userResized: true },
        { id: 'color-card', type: 'ColorReset', x: 750, y: 40, width: 300, height: 350, userResized: true }
    ], connections: ['resize-card', 'color-card'].map(id => ({ id: `import-${id}`, from: { nodeId: 'processing-import', port: 'image' }, to: { nodeId: id, port: 'image' }, type: 'image' })) }, async app => {
        await app.evaluate(`(async()=>{const canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;const context=canvas.getContext('2d');context.fillStyle='rgb(180,150,120)';context.fillRect(0,0,96,64);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png')),files=new DataTransfer();files.items.add(new File([blob],'neutral-reference.png',{type:'image/png'}));const input=document.getElementById('processing-import-file');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await app.waitFor("document.querySelector('#resize-card-resize-preview img')?.naturalWidth>0 && document.querySelector('#color-card-color-preview img')?.naturalWidth>0");
        for (const [id, surface] of [['resize-card', '#resize-card-resize-preview img'], ['color-card', '#color-card-color-preview img']]) {
            await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
            await clickImage(app, surface);
            await app.waitFor(`!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId==='${id}'`);
            assert.equal(await app.evaluate("!!document.querySelector('.fullscreen-overlay')"), false, 'a real picture click opens parameters without opening the original');
            assert.equal(await app.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(surface)})).objectFit`), 'contain');
            await clickImage(app, surface, 2);
            await app.waitFor("!!document.querySelector('.fullscreen-overlay img')");
            await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
            await app.waitFor("!document.querySelector('.fullscreen-overlay')");
        }
        await open(app, 'color-card');
        await app.evaluate("document.getElementById('color-card-white-balance-picker').click()");
        await app.waitFor("document.getElementById('color-card-color-preview').classList.contains('is-picking')");
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
        const before = await layout(app);
        await clickImage(app, '#color-card-color-preview img');
        await clickImage(app, '#color-card-color-preview img', 2);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='color-card')?.whiteBalanceSamplePoint)");
        assert.equal(await app.evaluate("!!document.querySelector('.fullscreen-overlay')"), false, 'a sampling double click does not open an original');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true, 'sampling does not reopen a deliberately closed editor');
        assert.deepEqual(await layout(app), before, 'sampling does not drag or resize the picture card');
        assert.equal(await app.evaluate("document.getElementById('color-card-white-balance').value"), 'custom');
    });
});
