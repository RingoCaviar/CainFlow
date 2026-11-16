import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import {withAppBrowser, delay} from './helpers/app-browser.mjs';
import { nativeClick } from './helpers/image-first-integrated-fixture.mjs';
const session={autoCheckUpdatesOnLoad:false,models:[{id:'chat',modelId:'chat',name:'chat',protocol:'openai',taskType:'chat',providerIds:['p']},{id:'image',modelId:'gpt-image-1',name:'image',protocol:'openai',taskType:'image',providerIds:['p']}],providers:[{id:'p',name:'p',endpoint:'https://controlled.test/v1',apikey:'test'}]};
async function point(app,selector){return app.evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(selector)}),r=p.getBoundingClientRect();return {x:r.x+r.width*(p.closest('.node-port').dataset.direction==='input'?.25:.75),y:r.y+r.height/2}})()`)}
async function drag(app,from,to){const start=await point(app,from),end=await point(app,to);for(const event of [{type:'mouseMoved',...start},{type:'mousePressed',...start,button:'left',clickCount:1},{type:'mouseMoved',x:start.x+30,y:start.y+20,button:'left',buttons:1},{type:'mouseMoved',...end,button:'left',buttons:1},{type:'mouseReleased',...end,button:'left',clickCount:1}])await app.send('Input.dispatchMouseEvent',event)}
async function graph(app){return app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value)")}

test('wire inspection widens picking without widening destructive double-click or taking a port gesture', { timeout: 30000 }, async () => {
    const nodes = [
        { id: 'start', type: 'Text', x: 30, y: 90, customTitle: '原始文案' },
        { id: 'draft', type: 'Text', x: 400, y: 90, customTitle: '文案初稿' },
        { id: 'prompt', type: 'Text', x: 775, y: 90, customTitle: '主图提示词' },
        { id: 'generate', type: 'ImageGenerate', x: 1150, y: 65, customTitle: '生成主图', apiConfigId: 'image', providerId: 'p' },
        { id: 'preview', type: 'ImagePreview', x: 1615, y: 65 },
        { id: 'last', type: 'ImagePreview', x: 1980, y: 65 },
        { id: 'other', type: 'Text', x: 40, y: 530 },
        { id: 'unrelated', type: 'Text', x: 435, y: 530 }
    ];
    const edge = (id, from, to, toPort = 'text', type = 'text') => ({ id,
        from: { nodeId: from, port: type }, to: { nodeId: to, port: toPort }, type });
    const connections = [edge('up-one', 'start', 'draft'), edge('up-two', 'draft', 'prompt'),
        edge('main', 'prompt', 'generate', 'prompt'), edge('down-one', 'generate', 'preview', 'image', 'image'),
        edge('down-two', 'preview', 'last', 'image', 'image'), edge('unrelated', 'other', 'unrelated')];
    const sendClick = async (app, at, count = 1, button = 'left') => {
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button, clickCount: count });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button, clickCount: count });
    };
    await withAppBrowser({ ...session, nodes, connections, canvas: { x: 0, y: 50, zoom: 0.7 } }, async app => {
        await app.send('Emulation.setDeviceMetricsOverride', { width: 1660, height: 900, deviceScaleFactor: 1, mobile: false });
        await app.waitFor("document.querySelector('[data-conn-id=main]')?.getAttribute('d')");
        const details = '.canvas-connection-details';
        const measure = offset => app.evaluate(`(() => {
            const path = document.querySelector('[data-conn-id=main]');
            const center = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM());
            return { x: center.x, y: center.y + ${offset} };
        })()`);
        const near = await measure(6);
        assert.equal(await app.evaluate(`document.elementFromPoint(${near.x}, ${near.y}).id`), 'canvas-container');
        const other = await app.evaluate("(() => {const r=document.getElementById('other').getBoundingClientRect();return {x:r.left+4,y:r.top+8}})()");
        await sendClick(app, other);
        await app.waitFor("document.getElementById('other').classList.contains('selected')");
        await sendClick(app, near);
        await app.waitFor(`!!document.querySelector('${details}')`);
        assert.equal(await app.evaluate("document.querySelector('[data-connection-endpoints]').textContent"), '主图提示词 → 生成主图');
        assert.equal(await app.evaluate("document.querySelector('[data-connection-role]').textContent"), '接入 · 主提示词');
        assert.equal(await app.evaluate("document.getElementById('other').classList.contains('selected')"), true);
        assert.equal(await app.evaluate(`document.activeElement.matches('${details}')`), true);
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete' });
        assert.equal(await app.evaluate("document.getElementById('other').classList.contains('selected')"), true);
        assert.equal(await app.evaluate("document.querySelectorAll('.connection-inspected').length"), 1);
        assert.equal(await app.evaluate("document.querySelectorAll('path[data-conn-id]').length"), connections.length);

        const trace = async (direction, expected) => {
            await app.evaluate(`document.querySelector('[data-trace-direction=${direction}]').click()`);
            assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.connection-traced')].map(path=>path.dataset.connId).sort()"), expected);
        };
        await trace('upstream', ['up-one', 'up-two']);
        await trace('downstream', ['down-one', 'down-two']);
        if (process.env.CAINFLOW_WIRE_INSPECTION_SCREENSHOT) {
            const { data } = await app.send('Page.captureScreenshot', { format: 'png' });
            await writeFile(process.env.CAINFLOW_WIRE_INSPECTION_SCREENSHOT, Buffer.from(data, 'base64'));
        }
        await app.evaluate("document.getElementById('btn-theme-toggle').focus();document.getElementById('btn-theme-toggle').click()");
        await app.waitFor("!document.getElementById('theme-menu').classList.contains('hidden')");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("document.getElementById('theme-menu').classList.contains('hidden') && !!document.querySelector('.canvas-connection-details')");
        await app.evaluate("document.querySelector('[data-trace-direction=downstream]').focus()");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("!document.querySelector('.canvas-connection-details, .connection-traced, .connection-inspected')");
        assert.deepEqual((await graph(app)).connections, connections);

        const measureElement = selector => app.evaluate(`(() => {
            const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        assert.equal(await app.evaluate("document.getElementById('generate').classList.contains('selected')"), false);
        await sendClick(app, await measureElement('#generate'), 1, 'right');
        await app.waitFor("document.getElementById('context-menu-trace-upstream').checkVisibility()");
        await app.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        assert.equal(await app.evaluate("document.getElementById('context-menu-trace-upstream').checkVisibility()"), true);
        await nativeClick(app, '#context-menu-trace-upstream');
        await app.waitFor("document.querySelector('[aria-label=连线路径] [data-trace-direction=upstream]')?.getAttribute('aria-pressed') === 'true'");
        assert.equal(await app.evaluate("document.activeElement.dataset.traceDirection"), 'upstream');
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.connection-traced')].map(path=>path.dataset.connId).sort()"),
            ['main', 'up-one', 'up-two']);
        await trace('downstream', ['down-one', 'down-two']);
        await sendClick(app, { x: 100, y: 830 });
        await app.waitFor("!document.querySelector('.canvas-connection-details, .connection-traced')");
        assert.deepEqual((await graph(app)).connections, connections);

        await sendClick(app, near);
        await sendClick(app, near, 2);
        assert.equal(await app.evaluate("document.querySelectorAll('path[data-conn-id]').length"), connections.length);
        await sendClick(app, await point(app, '#prompt .node-port.output .port-dot'));
        assert.equal(await app.evaluate(`!!document.querySelector('${details}')`), false);
        assert.equal(await app.evaluate("!!document.querySelector('.connection-target-available')"), true);
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });

        const precise = await measure(0);
        assert.equal(await app.evaluate(`document.elementFromPoint(${precise.x}, ${precise.y}).dataset.connId`), 'main');
        await sendClick(app, precise);
        await sendClick(app, precise, 2);
        await app.waitFor("!document.querySelector('[data-conn-id=main]')");
        assert.equal(await app.evaluate("document.querySelectorAll('path[data-conn-id]').length"), connections.length - 1);
    });
});

test('releasing near a moved port uses its current position ahead of an already nearby target', { timeout: 30000 }, async () => {
    const sourcePort = '#source .node-port[data-direction=output] .port-dot';
    const targetPort = '#target .universal-input .port-dot';
    await withAppBrowser({
        ...session,
        nodes: [
            { id: 'source', type: 'ImageImport', x: 60, y: 160 },
            { id: 'target', type: 'ImageGenerate', x: 540, y: 160, apiConfigId: 'image', providerId: 'p' },
            { id: 'other', type: 'ImageGenerate', x: 568, y: 286, apiConfigId: 'image', providerId: 'p' }
        ],
        connections: []
    }, async app => {
        const start = await point(app, sourcePort);
        const oldTarget = await point(app, targetPort);
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...oldTarget, buttons: 1 });
        await app.waitFor("Boolean(document.querySelector('#target .connection-target-nearest'))");

        const otherDistance = await app.evaluate(`(() => {
            const target = document.getElementById('target');
            target.style.top = '260px';
            const { x, y, width, height } = document.querySelector(${JSON.stringify(targetPort)}).getBoundingClientRect();
            const clientX = x + width / 2 + 16, clientY = y + height / 2;
            const other = document.querySelector('#other .universal-input .port-dot').getBoundingClientRect();
            document.getElementById('canvas-container').dispatchEvent(new MouseEvent('mouseup', {
                bubbles: true, cancelable: true, button: 0, clientX, clientY
            }));
            return Math.hypot(clientX - other.left - other.width / 2, clientY - other.top - other.height / 2);
        })()`);
        assert.ok(otherDistance > 16 && otherDistance <= 32, 'the stationary port remains a valid fallback within the snap radius');

        await app.waitFor("fetch('/api/storage/documents/session').then(r => r.json()).then(r => r.value.connections.length === 1)");
        const [edge] = (await graph(app)).connections;
        assert.deepEqual(edge.from, { nodeId: 'source', port: 'image' });
        assert.deepEqual(edge.to, { nodeId: 'target', port: 'referenceImages' });
        assert.equal(await app.evaluate("Boolean(document.querySelector('.connection-target-nearest'))"), false);
    });
});

test('a universal input refuses an occupied prompt and preserves the exact existing edge and history', {timeout:30000},async()=>{
 const edge={id:'retained-prompt',from:{nodeId:'old',port:'text'},to:{nodeId:'target',port:'prompt'},type:'text'};
 const seeded={...session,nodes:[{id:'old',type:'Text',x:30,y:60,text:'old'},{id:'next',type:'Text',x:30,y:430,text:'new'},{id:'target',type:'ImageGenerate',x:620,y:230,apiConfigId:'image',providerId:'p'}],connections:[edge]};
 await withAppBrowser(seeded,async app=>{
  await app.waitFor("Boolean(document.getElementById('target'))");
  const input=await app.evaluate("document.querySelector('#target .node-port[data-port=auto]') ? 'auto' : 'prompt'");
  await drag(app,'#next .node-port[data-direction=output] .port-dot',`#target .node-port[data-port=${input}] .port-dot`);
  await delay(700);
  assert.deepEqual((await graph(app)).connections,[edge], 'automatic connection cannot replace an occupied prompt');
  await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
  await delay(100);
  assert.deepEqual((await graph(app)).connections,[edge]);
 });
});

test('preview input refuses automatic replacement and applies an explicit source replacement as one reversible edit', {timeout:30000},async()=>{
 const edge={id:'retained-preview',from:{nodeId:'old-image',port:'image'},to:{nodeId:'preview',port:'image'},type:'image'};
 await withAppBrowser({...session,nodes:[{id:'old-image',type:'ImageImport',x:30,y:50},{id:'next-image',type:'ImageImport',x:30,y:410},{id:'preview',type:'ImagePreview',x:620,y:230}],connections:[edge]},async app=>{
  await app.waitFor("Boolean(document.querySelector('#preview .universal-input'))");
  await drag(app,'#next-image .node-port[data-direction=output] .port-dot','#preview .universal-input .port-dot');
  await delay(600);
  assert.deepEqual((await graph(app)).connections,[edge]);
  await app.evaluate("document.getElementById('preview').click();document.querySelector('[data-input-connection-id=retained-preview] [data-input-action=replace]').click()");
  await app.evaluate(`(()=>{const input=document.querySelector('[data-input-replacement-source]');input.value=${JSON.stringify(JSON.stringify({nodeId:'next-image',port:'image'}))};input.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-input-action=confirm-replace]').click()})()`);
  const changed={...edge,from:{nodeId:'next-image',port:'image'}};
  await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.connections[0]?.from.nodeId==='next-image')");
  assert.deepEqual((await graph(app)).connections,[changed]);
  await app.evaluate("window.previewUndoToastSeen=false;window.previewUndoToastObserver=new MutationObserver(()=>{if([...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('已撤回上一步操作'))){window.previewUndoToastSeen=true;window.previewUndoToastObserver.disconnect()}});previewUndoToastObserver.observe(document.getElementById('toast-container'),{childList:true,subtree:true})");
  await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
  await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.connections[0]?.from.nodeId==='old-image')");
  await app.waitFor("window.previewUndoToastSeen===true");
  await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))");
  await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.connections[0]?.from.nodeId==='next-image')");
  assert.deepEqual((await graph(app)).connections,[changed]);
 });
});
