import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'source', type: 'ImageImport', x: 60, y: 320 }],
    connections: []
};

async function point(app, selector) {
    // Only the outside half of each port dot is visible and accepts pointer input.
    return app.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect(),direction=el.closest('.node-port')?.dataset.direction;return {x:r.x+r.width*(direction==='output'?0.75:direction==='input'?0.25:0.5),y:r.y+r.height/2}})()`);
}

async function click(app, selector) {
    const p = await point(app, selector);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
}

async function dragFromPort(app, selector, destination) {
    const from = await point(app, selector);
    assert.ok(await app.evaluate(`!!document.elementFromPoint(${from.x},${from.y})?.closest('.node-port')`), `port is reachable at ${JSON.stringify(from)}: ${await app.evaluate(`document.elementFromPoint(${from.x},${from.y})?.outerHTML.slice(0,700)`)}`);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 30, y: from.y + 20, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...destination, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...destination, button: 'left', clickCount: 1 });
    await app.waitFor("!document.getElementById('connection-create-popup').classList.contains('hidden')");
}

async function assertConnected(app, fromId, toId, toPort) {
    const expression = `(()=>{
        const path=document.querySelector('#connections-svg path[data-conn-id]');
        const from=document.querySelector('#${fromId} .node-port[data-direction="output"] .port-dot');
        const to=document.querySelector('#${toId} .node-port[data-direction="input"][data-port="${toPort}"] .port-dot');
        if(!path?.getAttribute('d') || !from || !to) return false;
        const matrix=path.getScreenCTM(),start=path.getPointAtLength(0).matrixTransform(matrix),end=path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
        const a=from.getBoundingClientRect(),b=to.getBoundingClientRect();
        return Math.hypot(start.x-a.x-a.width/2,start.y-a.y-a.height/2)<2 && Math.hypot(end.x-b.x-b.width/2,end.y-b.y-b.height/2)<2;
    })()`;
    await app.waitFor(expression);
    assert.equal(await app.evaluate(expression), true, 'a visible path must reach both connected port dots without moving or zooming');
}

async function savedConnections(app) {
    await app.waitFor("(async()=>{const saved=await fetch('/api/storage/documents/session').then(r=>r.json());return saved.value?.connections?.length===1})()");
    return app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(saved=>saved.value.connections.map(({from,to})=>({from,to})))");
}

test('dragging an image output onto blank canvas creates a node with an immediately visible reference connection', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await dragFromPort(app, '#source .node-port[data-direction="output"] .port-dot', { x: 620, y: 200 });
        await click(app, '#connection-create-popup [data-popup-node-type="ImageGenerate"]');
        await app.waitFor("document.querySelectorAll('.node-generate').length===1");
        await app.waitFor("document.querySelectorAll('.image-reference-group').length===1");
        const target = await app.evaluate("document.querySelector('.node-generate').id");
        await assertConnected(app, 'source', target, 'referenceImages');
        assert.deepEqual(await savedConnections(app), [{ from: { nodeId: 'source', port: 'image' }, to: { nodeId: target, port: 'referenceImages' } }]);

        await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
        await app.waitFor("document.querySelectorAll('#connections-svg path[data-conn-id]').length===0 && document.querySelectorAll('.image-reference-group').length===0 && [...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('已撤回上一步操作'))");
        await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))");
        await app.waitFor("document.querySelectorAll('.image-reference-group').length===1");
        await assertConnected(app, 'source', target, 'referenceImages');
        await savedConnections(app);

        const previous = await app.evaluate('performance.timeOrigin');
        await app.send('Page.reload', { ignoreCache: true });
        await app.waitFor(`performance.timeOrigin!==${previous} && window.__cainflowAppReady===true && document.querySelectorAll('.image-reference-group').length===1`);
        await app.waitFor("Boolean(document.querySelector('#connections-svg path[data-conn-id]')?.getAttribute('d'))");
        await assertConnected(app, 'source', target, 'referenceImages');
    });
});

test('dragging an image output to create a chat node connects its current multi-reference input', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await dragFromPort(app, '#source .node-port[data-direction="output"] .port-dot', { x: 620, y: 200 });
        await click(app, '#connection-create-popup [data-popup-node-type="TextChat"]');
        await app.waitFor("document.querySelectorAll('.node-chat').length===1");
        const target = await app.evaluate("document.querySelector('.node-chat').id");
        await assertConnected(app, 'source', target, 'referenceImages');
        assert.deepEqual(await savedConnections(app), [{ from: { nodeId: 'source', port: 'image' }, to: { nodeId: target, port: 'referenceImages' } }]);
    });
});

test('dragging a reference input to create an image source keeps the connection direction', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [{ id: 'target', type: 'ImageGenerate', x: 620, y: 320 }] }, async app => {
        await dragFromPort(app, '#target .node-port[data-port="referenceImages"] .port-dot', { x: 200, y: 260 });
        await click(app, '#connection-create-popup [data-popup-node-type="ImageImport"]');
        await app.waitFor("document.querySelectorAll('.node-import').length===1");
        const source = await app.evaluate("document.querySelector('.node-import').id");
        await assertConnected(app, source, 'target', 'referenceImages');
        assert.deepEqual(await savedConnections(app), [{ from: { nodeId: source, port: 'image' }, to: { nodeId: 'target', port: 'referenceImages' } }]);
    });
});

for (const [type, port] of [['Text', 'prompt'], ['CameraControl', 'camera_prompt']]) {
    test(`dragging ${type} output to create an image node retains the preferred text input`, { timeout: 30000 }, async () => {
        await withAppBrowser({ ...session, nodes: [{ id: 'source', type, x: 60, y: 320 }] }, async app => {
            await dragFromPort(app, '#source .node-port[data-direction="output"] .port-dot', { x: 620, y: 200 });
            await click(app, '#connection-create-popup [data-popup-node-type="ImageGenerate"]');
            await app.waitFor("document.querySelectorAll('.node-generate').length===1");
            const target = await app.evaluate("document.querySelector('.node-generate').id");
            await assertConnected(app, 'source', target, port);
            assert.deepEqual(await savedConnections(app), [{ from: { nodeId: 'source', port: 'text' }, to: { nodeId: target, port } }]);
        });
    });
}
