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

test('node drag release does not open parameters and the next genuine click still works', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]')?.click()");
        const start = await app.evaluate(`(()=>{const r=document.querySelector('#gesture-image .image-first-placeholder').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await pointer(app, 'mousePressed', start);
        await pointer(app, 'mouseMoved', { x: start.x + 80, y: start.y + 50 });
        await pointer(app, 'mouseReleased', { x: start.x + 80, y: start.y + 50 });
        await delay(100);
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true,
            'releasing a moved node must not be treated as a click opening its parameters');
        const moved = await app.evaluate(`(()=>{const r=document.querySelector('#gesture-image .image-first-placeholder').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        assert.ok(moved.x > start.x + 40, 'the gesture really moved the node');
        await pointer(app, 'mousePressed', moved);
        await pointer(app, 'mouseReleased', moved);
        await app.waitFor("!document.getElementById('image-parameter-panel').hidden");
    });
});

test('a node drag returning to its origin is not a double click and an immediate fresh click opens parameters', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]')?.click()");
        const start = await app.evaluate("(()=>{const r=document.querySelector('#gesture-image .image-first-placeholder').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
        await pointer(app, 'mousePressed', start, 2);
        await pointer(app, 'mouseMoved', { x: start.x + 55, y: start.y + 30 });
        await pointer(app, 'mouseMoved', start);
        await pointer(app, 'mouseReleased', start, 2);
        assert.deepEqual(await app.evaluate("({hidden:document.getElementById('image-parameter-panel').hidden,fullscreen:!!document.querySelector('.fullscreen-overlay')})"),
            { hidden: true, fullscreen: false }, 'crossing the drag threshold remains a drag even after returning to the initial position');
        // Do not sleep through the former 100ms suppression window: the next
        // independent pointer gesture must be usable immediately.
        await pointer(app, 'mousePressed', start);
        await pointer(app, 'mouseReleased', start);
        await app.waitFor("!document.getElementById('image-parameter-panel').hidden");
        assert.equal(await app.evaluate("!!document.querySelector('.fullscreen-overlay')"), false);
    });
});

test('a held marquee keeps parameters closed through single and multiple selection, release, and a fresh click', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [
        { ...session.nodes[0], x: 200, y: 180, width: 240, height: 220, userResized: true },
        { ...session.nodes[0], id: 'gesture-second', x: 550, y: 180, width: 240, height: 220, userResized: true }
    ] }, async app => {
        await app.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]')?.click()");
        const [first, second] = await app.evaluate("['gesture-image','gesture-second'].map(id=>document.getElementById(id).getBoundingClientRect().toJSON())");
        const from = { x: first.left - 20, y: first.top - 25 };
        const overFirst = { x: first.right + 10, y: first.bottom + 10 };
        const overBoth = { x: second.right + 10, y: second.bottom + 10 };
        const frame = () => app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const selection = () => app.evaluate("['gesture-image','gesture-second'].map(id=>document.getElementById(id).classList.contains('selected'))");
        const hidden = () => app.evaluate("document.getElementById('image-parameter-panel').hidden");
        let release = overFirst;
        await pointer(app, 'mousePressed', from);
        try {
            await pointer(app, 'mouseMoved', overFirst);
            await frame();
            assert.deepEqual(await selection(), [true, false], 'the still-held marquee has selected only the first node');
            assert.equal(await hidden(), true,
                'the first node becoming selected during a held marquee must not open its parameters');
            for (const [point, expected] of [[overBoth, [true, true]], [overFirst, [true, false]], [overBoth, [true, true]]]) {
                release = point;
                await pointer(app, 'mouseMoved', point);
                await frame();
                assert.deepEqual(await selection(), expected);
                assert.equal(await hidden(), true, 'growing or shrinking the held selection must not open parameters');
            }
        } finally {
            await pointer(app, 'mouseReleased', release);
        }
        await frame();
        assert.deepEqual(await selection(), [true, true]);
        assert.equal(await hidden(), true, 'releasing the multiple selection leaves parameters closed');

        await pointer(app, 'mousePressed', from);
        await pointer(app, 'mouseMoved', overFirst);
        await frame();
        assert.deepEqual(await selection(), [true, false]);
        assert.equal(await hidden(), true, 'a separate single-node marquee also stays closed while held');
        await pointer(app, 'mouseReleased', overFirst);
        await frame();
        assert.equal(await hidden(), true, 'releasing a single-node marquee must not queue an opening');
        const center = await app.evaluate("(()=>{const r=document.querySelector('#gesture-image .image-first-placeholder').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
        await pointer(app, 'mousePressed', center);
        await pointer(app, 'mouseReleased', center);
        await app.waitFor("!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId==='gesture-image'");
    });
});

test('a quick marquee released before the next frame does not open parameters later', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]')?.click()");
        const rect = await app.evaluate("document.getElementById('gesture-image').getBoundingClientRect().toJSON()");
        const from = { x: rect.left - 20, y: rect.top - 25 };
        const to = { x: rect.right + 10, y: rect.bottom + 10 };
        await app.evaluate(`window.quickMarqueeReleased=false;window.quickMarqueeFramedWhileHeld=false;
            document.addEventListener('mousedown',()=>requestAnimationFrame(()=>{
                if(!window.quickMarqueeReleased)window.quickMarqueeFramedWhileHeld=true;
            }),{once:true});
            document.addEventListener('mouseup',()=>{window.quickMarqueeReleased=true},{once:true});`);
        await app.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
        // Queue the entire native gesture before resuming the frame clock: a
        // paused renderer can hold the CDP input acknowledgement until resumed.
        const gesture = Promise.all([
            pointer(app, 'mousePressed', from),
            pointer(app, 'mouseMoved', to),
            pointer(app, 'mouseReleased', to)
        ]);
        const frames = app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await app.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 100 });
        await gesture;
        await frames;
        assert.equal(await app.evaluate("document.getElementById('gesture-image').classList.contains('selected')"), true,
            'the native quick marquee selected the node before the pending frame can run');
        assert.equal(await app.evaluate('window.quickMarqueeFramedWhileHeld'), false,
            'this gesture releases before its first scheduled animation frame');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true,
            'a queued selection refresh after release must not reopen parameters');
    });
});

test('marquee-selected nodes stay selected after dragging and an already open editor retains its controls', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [
        { ...session.nodes[0], x: 200, y: 180, width: 240, height: 220, userResized: true },
        { ...session.nodes[0], id: 'gesture-second', x: 550, y: 180, width: 240, height: 220, userResized: true }
    ] }, async app => {
        await app.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]')?.click()");
        const nodes = () => app.evaluate("['gesture-image','gesture-second'].map(id=>{const el=document.getElementById(id),r=el.getBoundingClientRect();return {id,x:r.x,y:r.y,right:r.right,bottom:r.bottom,selected:el.classList.contains('selected')}})");
        const before = await nodes();
        const from = { x: Math.min(...before.map(node => node.x)) - 20, y: Math.min(...before.map(node => node.y)) - 25 };
        const to = { x: Math.max(...before.map(node => node.right)) + 20, y: Math.max(...before.map(node => node.bottom)) + 20 };
        await pointer(app, 'mousePressed', from);
        await pointer(app, 'mouseMoved', to);
        await pointer(app, 'mouseReleased', to);
        assert.deepEqual((await nodes()).map(node => node.selected), [true, true], 'the native marquee selected both nodes');
        const center = () => app.evaluate("(()=>{const r=document.querySelector('#gesture-image .image-first-placeholder').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
        const start = await center();
        await pointer(app, 'mousePressed', start);
        await pointer(app, 'mouseMoved', { x: start.x + 60, y: start.y + 25 });
        await pointer(app, 'mouseReleased', { x: start.x + 60, y: start.y + 25 });
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const after = await nodes();
        assert.deepEqual(after.map(node => node.selected), [true, true], 'release does not narrow the selection to the pressed node');
        for (let index = 0; index < after.length; index++) {
            assert.ok(Math.abs(after[index].x - before[index].x - 60) < 2);
            assert.ok(Math.abs(after[index].y - before[index].y - 25) < 2);
        }
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true);

        const selected = await center();
        await pointer(app, 'mousePressed', selected);
        await pointer(app, 'mouseReleased', selected);
        await app.waitFor("!document.getElementById('image-parameter-panel').hidden");
        await app.evaluate("window.retainedDragPrompt=document.getElementById('gesture-image-prompt');retainedDragPrompt.value='preserve the open editor draft'");
        const dragStart = await center();
        await pointer(app, 'mousePressed', dragStart);
        await pointer(app, 'mouseMoved', { x: dragStart.x + 35, y: dragStart.y + 20 });
        await pointer(app, 'mouseReleased', { x: dragStart.x + 35, y: dragStart.y + 20 });
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert.deepEqual(await app.evaluate("({hidden:document.getElementById('image-parameter-panel').hidden,same:document.getElementById('gesture-image-prompt')===retainedDragPrompt,value:retainedDragPrompt.value})"),
            { hidden: false, same: true, value: 'preserve the open editor draft' }, 'dragging the current node preserves its already open editor');
        const other = await app.evaluate("(()=>{const r=document.querySelector('#gesture-second .image-first-placeholder').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
        await pointer(app, 'mousePressed', other);
        await pointer(app, 'mouseMoved', { x: other.x + 25, y: other.y + 20 });
        await pointer(app, 'mouseReleased', { x: other.x + 25, y: other.y + 20 });
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true,
            'dragging another node closes the stale editor without opening a replacement');
        assert.deepEqual((await nodes()).map(node => node.selected), [false, true]);
        await app.evaluate("document.getElementById('gesture-second').click()");
        await app.waitFor("!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId==='gesture-second'");
    });
});

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
