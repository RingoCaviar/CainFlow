import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['provider'] },
        { id: 'image', modelId: 'gpt-image-2', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['provider'] }
    ],
    providers: [{ id: 'provider', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'editor-first', type: 'ImageGenerate', x: 80, y: 40, width: 420,
            apiConfigId: 'image', providerId: 'provider', prompt: 'first local draft' },
        { id: 'editor-second', type: 'ImageGenerate', x: 590, y: 40, width: 420,
            apiConfigId: 'image', providerId: 'provider', prompt: 'second local draft' }
    ],
    connections: []
};

async function openNode(app, id) {
    await app.evaluate(`document.querySelector('#${id} .image-first-placeholder').click()`);
    await app.waitFor(`document.getElementById('image-parameter-panel')?.hidden===false && document.getElementById('image-parameter-panel').dataset.nodeId==='${id}'`);
}

async function changeField(app, id, value) {
    await app.evaluate(`(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

async function geometry(app) {
    return app.evaluate(`['editor-first','editor-second'].map(id=>{const element=document.getElementById(id);return {id,left:element.style.left,top:element.style.top,width:element.offsetWidth}})`);
}

async function nativeClick(app, selector) {
    const point = await app.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

async function clickParameterRun(app) {
    await app.waitFor("(()=>{const button=document.querySelector('#image-parameter-panel [data-parameter-action=generate]'),r=button.getBoundingClientRect();return !button.disabled&&button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()");
    await nativeClick(app, '#image-parameter-panel [data-parameter-action=generate]');
}

const cachedReferenceImages = await Promise.all(['red', 'blue'].map(async color =>
    (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
const cachedReferenceConnection = { id: 'cached-reference', from: { nodeId: 'editor-first', port: 'image' }, to: { nodeId: 'editor-second', port: 'referenceImages' }, type: 'image', order: 0 };

async function controlCurrentNodeRequests(app) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.currentNodeRequests=[];
        const currentNodeFetch=window.fetch;
        const outputs=${JSON.stringify(cachedReferenceImages)};
        window.fetch=async(url,options={})=>{
            if(String(url)==='/proxy'&&options.body){
                const form=options.body instanceof FormData;
                const body=form?Object.fromEntries(options.body.entries()):JSON.parse(options.body);
                if(typeof body.prompt==='string'){
                    const images=body.images||body.image||[];
                    const references=form
                        ? await Promise.all(options.body.getAll('image[]').concat(options.body.getAll('image')).map(async file=>btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))))
                        : (Array.isArray(images)?images:[images]).map(image=>String(image).split(',').at(-1));
                    currentNodeRequests.push({prompt:body.prompt,references});
                    return new Response(JSON.stringify({data:[{b64_json:outputs[(currentNodeRequests.length-1)%outputs.length]}]}),{headers:{'Content-Type':'application/json'}});
                }
            }
            return currentNodeFetch(url,options);
        };` });
    await reloadAppBrowser(app);
}

test('parameter run executes only its current node and reuses cached upstream images', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...session, nodes: session.nodes.map((node,index)=>index===0?{...node,generationCount:2}:node), connections: [cachedReferenceConnection] }, async app => {
        await controlCurrentNodeRequests(app);
        await app.evaluate("document.getElementById('editor-first').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('context-menu-run-to-here').click()");
        await app.waitFor("document.getElementById('editor-first-run-status').textContent==='完成'&&document.getElementById('btn-stop').disabled");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.find(node=>node.id==='editor-first').mediaAssetKeys?.length===2)");
        const sourceKeys = await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.find(node=>node.id==='editor-first').mediaAssetKeys)");
        assert.equal(sourceKeys.length, 2, 'the complete upstream batch is genuinely generated and durably cached before clicking the parameter action');
        await reloadAppBrowser(app);

        await openNode(app, 'editor-second');
        await app.evaluate('window.currentNodeRequests=[]');
        await clickParameterRun(app);
        await app.waitFor('currentNodeRequests.length===1');
        await app.waitFor("document.getElementById('editor-second-run-status').textContent==='完成'&&document.getElementById('btn-stop').disabled");
        assert.deepEqual(await app.evaluate('currentNodeRequests.map(request=>request.prompt)'), ['second local draft'], 'the parameter action must not send another provider request for its cached upstream node');
        assert.deepEqual(await app.evaluate('currentNodeRequests[0].references'), cachedReferenceImages, 'the request reopens every cached upstream original in order');

        await changeField(app, 'editor-second-generation-count', '2');
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await app.evaluate('window.currentNodeRequests=[]');
        await clickParameterRun(app);
        await app.waitFor('currentNodeRequests.length===2');
        await app.waitFor("document.getElementById('editor-second-run-status').textContent==='完成'&&document.getElementById('btn-stop').disabled");
        assert.deepEqual(await app.evaluate('currentNodeRequests.map(request=>request.prompt)'), ['second local draft', 'second local draft'], 'batch count repeats only the current node');
        assert.deepEqual(await app.evaluate('currentNodeRequests.map(request=>request.references)'), [cachedReferenceImages,cachedReferenceImages]);
        assert.deepEqual(await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.find(node=>node.id==='editor-first').mediaAssetKeys)"), sourceKeys, 'running the current node preserves ownership of the cached upstream original');
    });
});

test('parameter run with missing upstream cache fails without generation while explicit run-to-here still includes upstream', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...session, connections: [cachedReferenceConnection] }, async app => {
        await controlCurrentNodeRequests(app);
        await openNode(app, 'editor-second');
        await clickParameterRun(app);
        await app.waitFor("document.getElementById('editor-second-run-status').textContent==='失败'&&document.getElementById('btn-stop').disabled");
        assert.deepEqual(await app.evaluate('currentNodeRequests'), [], 'missing cached inputs must never cause an upstream request or a reference-free current request');
        assert.equal(await app.evaluate("document.getElementById('editor-first-run-status').textContent"), '待运行');
        assert.match(await app.evaluate("document.getElementById('editor-second-error').textContent"), /参考图输入.*未读取到图片数据/);

        await app.evaluate("document.getElementById('editor-second').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('context-menu-run-to-here').click()");
        await app.waitFor('currentNodeRequests.length===2');
        await app.waitFor("document.getElementById('editor-second-run-status').textContent==='完成'&&document.getElementById('btn-stop').disabled");
        assert.deepEqual(await app.evaluate('currentNodeRequests.map(request=>request.prompt)'), ['first local draft','second local draft']);
    });
});

test('parameter run rejects a missing source alongside a cached source on the shared reference input', { timeout: 45000 }, async () => {
    const missingSource = { ...session.nodes[0], id: 'uncached-source', x: 80, y: 500, prompt: 'must not run' };
    const missingConnection = { ...cachedReferenceConnection, id: 'uncached-reference', from: { nodeId: missingSource.id, port: 'image' }, order: 1 };
    await withAppBrowser({ ...session, nodes: [...session.nodes,missingSource], connections: [cachedReferenceConnection,missingConnection] }, async app => {
        await controlCurrentNodeRequests(app);
        await app.evaluate("document.getElementById('editor-first').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('context-menu-run-to-here').click()");
        await app.waitFor("document.getElementById('editor-first-run-status').textContent==='完成'&&document.getElementById('btn-stop').disabled");
        await openNode(app, 'editor-second');
        await app.evaluate('window.currentNodeRequests=[]');
        await clickParameterRun(app);
        await app.waitFor("document.getElementById('editor-second-run-status').textContent==='失败'&&document.getElementById('btn-stop').disabled");
        assert.deepEqual(await app.evaluate('currentNodeRequests'), [], 'one cached connection cannot hide the missing source or trigger automatic upstream generation');
        assert.match(await app.evaluate("document.getElementById('editor-second-error').textContent"), /已连接 1 个参考图输入.*未读取到图片数据/);
        assert.equal(await app.evaluate("document.getElementById('uncached-source-run-status').textContent"), '待运行');
    });
});

test('parameter run reuses an unfixed upstream text reply as its effective prompt', { timeout: 30000 }, async () => {
    const cachedPrompt = 'cached upstream prompt';
    const textSource = { ...session.nodes[0], type: 'TextChat', apiConfigId: 'chat', fixed: false,
        isSucceeded: true, lastText: cachedPrompt, lastResponse: cachedPrompt };
    const connection = { id: 'cached-prompt', from: { nodeId: 'editor-first', port: 'text' }, to: { nodeId: 'editor-second', port: 'prompt' }, type: 'text' };
    await withAppBrowser({ ...session, nodes: [textSource,session.nodes[1]], connections: [connection] }, async app => {
        await controlCurrentNodeRequests(app);
        await openNode(app, 'editor-second');
        await clickParameterRun(app);
        await app.waitFor('currentNodeRequests.length===1');
        await app.waitFor("document.getElementById('editor-second-run-status').textContent==='完成'&&document.getElementById('btn-stop').disabled");
        assert.deepEqual(await app.evaluate('currentNodeRequests.map(request=>request.prompt)'), [cachedPrompt]);
        assert.equal(await app.evaluate("document.getElementById('editor-first-response').textContent.trim()"), cachedPrompt);
    });
});

test('prompt grows from two to six lines, then scrolls and shrinks again without a dirty status row', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [{...session.nodes[0], textareaHeights: {prompt: 400}}] }, async app => {
        await openNode(app, 'editor-first');
        const measures = [];
        for (const lines of [1, 4, 12, 20, 1]) {
            await changeField(app, 'editor-first-prompt', Array(lines).fill('short line').join('\n'));
            await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
            measures.push(await app.evaluate("(()=>{const p=document.getElementById('editor-first-prompt'),s=getComputedStyle(p);return {h:p.offsetHeight,line:parseFloat(s.lineHeight),extra:parseFloat(s.paddingTop)+parseFloat(s.paddingBottom)+parseFloat(s.borderTopWidth)+parseFloat(s.borderBottomWidth),scroll:p.scrollHeight,client:p.clientHeight}})()"));
        }
        assert.ok(Math.abs(measures[0].h-(measures[0].line*2+measures[0].extra))<=2, JSON.stringify(measures));
        assert.ok(measures[1].h>measures[0].h);
        assert.ok(Math.abs(measures[2].h-(measures[2].line*6+measures[2].extra))<=2);
        assert.equal(measures[2].h, measures[3].h);
        assert.ok(measures[3].scroll>measures[3].client);
        assert.equal(measures[4].h, measures[0].h);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-image-generation-dirty]')"), null);
    });
});

test('parameter dropdowns escape scrolling containers and keep every option reachable', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, models: session.models.map(model => model.id === 'image' ? {...model, modelId: 'gemini-image', protocol: 'google'} : model) }, async app => {
        await app.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 540, deviceScaleFactor: 1, mobile: false });
        await openNode(app, 'editor-first');
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await nativeClick(app, '#image-parameter-panel .image-parameter-settings-entry');
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        for (const id of ['aspect', 'resolution']) {
            await app.evaluate(`document.getElementById('editor-first-${id}').nextElementSibling.scrollIntoView({block:'nearest'})`);
            await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
            await nativeClick(app, `#editor-first-${id} + .node-select .node-select-trigger`);
            await app.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 380, deviceScaleFactor: 1, mobile: false });
            await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
            const result = await app.evaluate(`(()=>{const p=document.querySelector('#editor-first-${id} + .node-select .node-select-panel'),r=p.getBoundingClientRect(),items=[...p.querySelectorAll('button')];items.at(-1).scrollIntoView({block:'nearest'});const b=items.at(-1).getBoundingClientRect();return {classes:p.className,open:p.matches(':popover-open'),parentOpen:p.closest('.image-parameter-settings-popup').matches(':popover-open'),style:p.style.cssText,bounds:r.toJSON(),reachable:items.at(-1).contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))}})()`);
            assert.ok(result.bounds.top>=8&&result.bounds.bottom<=372&&result.reachable, `${id}: ${JSON.stringify(result)}`);
            await nativeClick(app, `#editor-first-${id} + .node-select .node-select-option:last-child`);
        }
    });
});

test('native model and provider selectors remain inside the open settings submenu', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await openNode(app, 'editor-first');
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await nativeClick(app, '#image-parameter-panel .image-parameter-model-entry');
        await nativeClick(app, '#editor-first-parameter-settings [data-parameter-group=model] .node-select-trigger');
        assert.ok(await app.evaluate("document.getElementById('editor-first-parameter-settings').matches(':popover-open')"), 'opening model options must not close their parent');
        assert.ok(await app.evaluate("document.querySelector('#editor-first-parameter-settings .node-select-option').checkVisibility()"));
        await nativeClick(app, '#editor-first-parameter-settings .node-select-option');
        await nativeClick(app, '#editor-first-provider-field .node-select-trigger');
        assert.ok(await app.evaluate("document.querySelector('#editor-first-provider-field .node-select-option').checkVisibility()"));
        await nativeClick(app, '#editor-first-provider-field .node-select-option');
        assert.equal(await app.evaluate("document.getElementById('editor-first-provider').value"), 'provider');
    });
});

test('model entry restores its fields after Escape and reopening', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await openNode(app, 'editor-first');
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        for (let i = 0; i < 3; i++) {
            await nativeClick(app, '#image-parameter-panel .image-parameter-model-entry');
            assert.ok(await app.evaluate("document.querySelector('#editor-first-parameter-settings [data-parameter-group=model]').checkVisibility()"), `model fields visible on open ${i+1}`);
            await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
            await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
        }
    });
});

test('footer entries toggle their menus and size entry reports current settings', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await openNode(app, 'editor-first');
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-parameter-settings-entry').textContent"), '自动 · 自动');
        const modelEntry = '#image-parameter-panel .image-parameter-model-entry';
        await nativeClick(app, modelEntry); await nativeClick(app, modelEntry);
        assert.equal(await app.evaluate("document.getElementById('editor-first-parameter-settings').matches(':popover-open')"), false, 'second model click closes menu');
        await nativeClick(app, modelEntry);
        assert.ok(await app.evaluate("document.querySelector('#editor-first-parameter-settings [data-parameter-group=model]').checkVisibility()"));
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
        await nativeClick(app, '#image-parameter-panel .image-parameter-settings-entry');
        assert.ok(await app.evaluate("document.querySelector('#editor-first-parameter-settings [data-parameter-group=size]').checkVisibility()"), 'size summary opens size settings directly');
        await nativeClick(app, modelEntry);
        assert.ok(await app.evaluate("document.querySelector('#editor-first-parameter-settings [data-parameter-group=model]').checkVisibility()&&!document.querySelector('#editor-first-parameter-settings [data-parameter-group=size]').checkVisibility()"), 'one pointer click switches directly from size to model');
        await nativeClick(app, '#image-parameter-panel .image-parameter-more-entry');
        assert.ok(await app.evaluate("document.getElementById('editor-first-quality').closest('.node-field').checkVisibility()&&!document.querySelector('#editor-first-parameter-settings [data-parameter-group=model]').checkVisibility()"), 'More owns quality and excludes model settings');
        await nativeClick(app, '#image-parameter-panel .image-parameter-settings-entry');
        assert.ok(await app.evaluate("document.querySelector('#editor-first-parameter-settings [data-parameter-group=size]').checkVisibility()"), 'size entry switches directly from More without an extra close click');
        assert.equal(await app.evaluate("document.querySelector('#editor-first-parameter-settings [data-parameter-group-toggle]')"), null, 'dedicated popup contains no category switches');
        await changeField(app, 'editor-first-aspect', '3:4');
        await changeField(app, 'editor-first-resolution', '1K');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-parameter-settings-entry').textContent"), '3:4 · 1K');
        await changeField(app, 'editor-first-aspect', ''); await changeField(app, 'editor-first-resolution', '');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-parameter-settings-entry').textContent"), '自动 · 自动');
    });
});

test('an already open submenu follows viewport constraints when the window shrinks', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await openNode(app, 'editor-first');
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await nativeClick(app, '#image-parameter-panel .image-parameter-settings-entry');
        await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 300, deviceScaleFactor: 1, mobile: false });
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const bounds = await app.evaluate("document.getElementById('editor-first-parameter-settings').getBoundingClientRect().toJSON()");
        assert.ok(bounds.left>=12&&bounds.right<=348&&bounds.top>=12&&bounds.bottom<=288, JSON.stringify(bounds));
        await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 420, deviceScaleFactor: 1, mobile: false });
        // Focusing a transformed canvas item can scroll its containing layout;
        // the editor still belongs to the screen rather than that clipped area.
        await app.evaluate("document.getElementById('main-layout').scrollLeft=100;window.dispatchEvent(new Event('resize'));new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        assert.ok(await app.evaluate("document.getElementById('canvas-container').getBoundingClientRect().right<innerWidth-60"), 'the fixture reproduces a canvas partly outside the window');
        const clippedLayout = await app.evaluate("(()=>{const panel=document.getElementById('image-parameter-panel'),r=panel.getBoundingClientRect(),buttons=[...panel.querySelectorAll('.image-parameter-settings-entry,.image-parameter-model-entry,.image-parameter-more-entry,[data-parameter-action=generate]')].map(el=>el.getBoundingClientRect());return {panel:r.toJSON(),fits:panel.scrollWidth<=panel.clientWidth+1,readable:buttons.every(box=>box.width>=32),aligned:buttons.every(box=>Math.abs(box.top-buttons[0].top)<1)}})()");
        assert.ok(clippedLayout.panel.width>=280&&clippedLayout.panel.left>=12&&clippedLayout.panel.right<=348, JSON.stringify(clippedLayout));
        assert.ok(clippedLayout.fits&&clippedLayout.readable&&clippedLayout.aligned, 'a shifted canvas cannot squeeze the single-row controls into unreadable slivers');
    });
});

test('generation keeps prompt above one footer row and reuses settings through a dismissible submenu', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await openNode(app, 'editor-first');
        assert.ok(await app.evaluate("!document.querySelector('#editor-first-prompt-field>label')&&!document.getElementById('editor-first-assistant')"));
        assert.equal(await app.evaluate("document.getElementById('editor-first-prompt').getAttribute('aria-label')"), '提示词');
        const controls = await app.evaluate("(()=>{const f=document.querySelector('.image-parameter-footer'),m=f.querySelector('.image-parameter-model-entry').getBoundingClientRect(),g=f.querySelector('[data-parameter-action=generate]').getBoundingClientRect(),s=f.querySelector('.image-parameter-settings-entry').getBoundingClientRect();return {aligned:Math.abs(m.top-g.top)<2&&Math.abs(s.top-g.top)<2,width:m.width,ordered:s.right<m.left&&m.right<g.left}})()");
        assert.ok(controls.aligned&&controls.ordered, 'footer controls stay aligned and ordered');
        await nativeClick(app, '#image-parameter-panel .image-parameter-settings-entry');
        assert.ok(await app.evaluate("document.getElementById('editor-first-parameter-settings').matches(':popover-open')&&document.querySelector('.image-parameter-footer').contains(document.getElementById('editor-first-generation-count'))"));
        await changeField(app, 'editor-first-resolution', 'custom');
        await changeField(app, 'editor-first-custom-resolution-width', '1536');
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
        assert.equal(await app.evaluate("document.getElementById('editor-first-parameter-settings').matches(':popover-open')"), false);
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), false, 'Escape dismisses the submenu before the editor');
        await openNode(app, 'editor-second'); await openNode(app, 'editor-first');
        assert.equal(await app.evaluate("document.getElementById('editor-first-custom-resolution-width').value"), '1536');
        await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: false });
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await nativeClick(app, '#image-parameter-panel .image-parameter-settings-entry');
        const bounds = await app.evaluate("document.getElementById('editor-first-parameter-settings').getBoundingClientRect().toJSON()");
        assert.ok(bounds.left>=12&&bounds.right<=348&&bounds.top>=12);
    });
});

async function editorMeasurements(app, id) {
    return app.evaluate(`(()=>{const panel=document.getElementById('image-parameter-panel');return {panels:document.querySelectorAll('.image-parameter-panel:not([hidden])').length,width:panel.getBoundingClientRect().width,font:getComputedStyle(document.getElementById('${id}-prompt')).fontSize,ownsPrompt:panel.contains(document.getElementById('${id}-prompt'))}})()`);
}

test('ordinary parameters follow below their node and stop at the bottom instead of flipping above it', { timeout: 30000 }, async () => {
    const nodes = [-100, 300, 600].map((y,index)=>({ ...session.nodes[0], id:`anchor-${index}`, x:80, y }));
    await withAppBrowser({ ...session, nodes }, async app => {
        const measure = () => app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel'),r=p.getBoundingClientRect(),n=document.getElementById(p.dataset.nodeId).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,nodeBottom:n.bottom,viewport:innerHeight}})()");
        await openNode(app, 'anchor-0');
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const free = await measure();
        assert.ok(Math.abs(free.top-free.nodeBottom-12)<=1, 'available space places the editor directly below the node');
        await openNode(app, 'anchor-1');
        const edge = await measure();
        await openNode(app, 'anchor-2');
        const lower = await measure();
        assert.ok(Math.abs(edge.height-lower.height)<=1 && Math.abs(edge.top-lower.top)<=1,
            'moving the target farther down keeps the same lower-bound position instead of flipping above it');
        assert.ok(lower.top>=12 && lower.bottom<=lower.viewport-12);
    });
});

test('titleless parameter editor keeps execution reachable while long content scrolls in compact windows', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await openNode(app, 'editor-first');
        await changeField(app, 'editor-first-prompt', '需要保留和反复编辑的长提示词。\n'.repeat(80));
        await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 420, deviceScaleFactor: 1, mobile: false });
        await app.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        await app.waitFor("(()=>{const button=document.querySelector('#image-parameter-panel [data-parameter-action=generate]'),r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()");
        const measure = () => app.evaluate(`(()=>{
            const panel=document.getElementById('image-parameter-panel');
            const box=element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}};
            const reachable=selector=>{const element=panel.querySelector(selector),r=element.getBoundingClientRect();return element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
            return {header:box(panel.querySelector('header')),footer:box(panel.querySelector('footer')),
                title:panel.querySelector('h2').textContent,close:reachable('[data-parameter-action=close]'),run:reachable('[data-parameter-action=generate]'),
                overflow:panel.scrollWidth>panel.clientWidth};
        })()`);
        const before = await measure();
        assert.equal(before.title, '图片生成');
        assert.equal(before.close, false, 'corner close control is absent');
        assert.equal(before.run, true, 'generate stays directly clickable in a short window: '+JSON.stringify(await app.evaluate("(()=>{const panel=document.getElementById('image-parameter-panel'),button=panel.querySelector('[data-parameter-action=generate]'),r=button.getBoundingClientRect();return {panel:panel.getBoundingClientRect().toJSON(),button:r.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,400),toolbar:document.getElementById('toolbar')?.getBoundingClientRect().toJSON()}})()")));
        assert.equal(before.overflow, false);
        assert.ok(await app.evaluate("document.querySelector('.image-parameter-scroll').clientHeight >= 140"),
            'a collapsed toolbar leaves enough space for useful editing');
        await app.evaluate("document.getElementById('editor-first-prompt').focus();document.getElementById('editor-first-prompt').scrollIntoView({block:'nearest'})");
        assert.ok(await app.evaluate(`(()=>{const input=document.getElementById('editor-first-prompt').getBoundingClientRect(),scroll=document.querySelector('.image-parameter-scroll').getBoundingClientRect();return Math.min(input.bottom,scroll.bottom)-Math.max(input.top,scroll.top)>=60})()`),
            'several prompt lines remain visible when editing in a short window');
        await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop=10000");
        assert.deepEqual(await measure(), before, 'scrolling content leaves the editor header and action bar in place');
        assert.equal(await app.evaluate("document.getElementById('editor-first-prompt').value.split('\\n').length"), 81);
    });
});

test('one screen-space image editor follows selection and preserves edits, width and layout across closing, zoom and reload', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        const originalLayout = await geometry(app);
        assert.deepEqual(originalLayout, [
            { id: 'editor-first', left: '80px', top: '40px', width: 420 },
            { id: 'editor-second', left: '590px', top: '40px', width: 420 }
        ]);

        assert.equal(await app.evaluate("document.querySelector('#editor-first .image-first-placeholder button')"), null);
        await openNode(app, 'editor-first');
        assert.equal((await editorMeasurements(app, 'editor-first')).panels, 1);
        await changeField(app, 'editor-first-prompt', 'preserved first image prompt');
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-group-toggle=size]').click()");
        await changeField(app, 'editor-first-resolution', 'custom');
        await changeField(app, 'editor-first-custom-resolution-width', '1536');
        await changeField(app, 'editor-first-custom-resolution-height', '1024');

        // Use the editor's keyboard resize control, rather than modifying its
        // dimensions or reading its preference implementation directly.
        await app.evaluate("document.querySelector('#image-parameter-panel [role=separator]').focus({preventScroll:true})");
        for (let step = 0; step < 3; step += 1) {
            await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
            await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' });
        }
        const beforeZoom = await editorMeasurements(app, 'editor-first');
        assert.equal(beforeZoom.width, 590);
        assert.ok(Number.parseFloat(beforeZoom.font) >= 13, 'editor text retains the readable application font size');

        await openNode(app, 'editor-second');
        assert.deepEqual(await editorMeasurements(app, 'editor-second'), { ...beforeZoom, ownsPrompt: true });
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').contains(document.getElementById('editor-first-prompt'))"), false);
        await changeField(app, 'editor-second-prompt', 'preserved second image prompt');
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true);

        await openNode(app, 'editor-first');
        assert.equal(await app.evaluate("document.getElementById('editor-first-prompt').value"), 'preserved first image prompt');
        assert.deepEqual(await app.evaluate("['resolution','custom-resolution-width','custom-resolution-height'].map(suffix=>document.getElementById('editor-first-'+suffix).value)"), ['custom', '1536', '1024']);
        assert.deepEqual(await editorMeasurements(app, 'editor-first'), beforeZoom);

        await app.evaluate("document.querySelector('#canvas-navigation .canvas-zoom-menu>summary').click();document.querySelector('#canvas-navigation [data-zoom=\"0.5\"]').click()");
        await app.waitFor("document.getElementById('zoom-level').textContent==='50%'");
        assert.deepEqual(await editorMeasurements(app, 'editor-first'), beforeZoom, 'zoom changes the canvas, not the editor width, text size or ownership');
        assert.deepEqual(await geometry(app), originalLayout, 'selection, closing and canvas zoom do not rewrite graph coordinates or node widths');

        // The real application session document is the persisted graph boundary.
        // No private in-memory node state is read to prove that edits survived.
        await app.waitFor(`(async()=>{const response=await fetch('/api/storage/documents/session').then(r=>r.json());const nodes=response.value?.nodes||[];return nodes.find(n=>n.id==='editor-first')?.prompt==='preserved first image prompt' && nodes.find(n=>n.id==='editor-second')?.prompt==='preserved second image prompt'})()`);
        const saved = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>({nodes:r.value.nodes.map(n=>({id:n.id,x:n.x,y:n.y,width:n.width,prompt:n.prompt,resolution:n.resolution,customWidth:n.customWidth,customHeight:n.customHeight})),connections:r.value.connections}))");
        assert.deepEqual(saved.connections, []);
        assert.deepEqual(saved.nodes.find(node => node.id === 'editor-first'), {
            id: 'editor-first', x: 80, y: 40, width: 420, prompt: 'preserved first image prompt',
            resolution: 'custom', customWidth: '1536', customHeight: '1024'
        });
        assert.equal(saved.nodes.find(node => node.id === 'editor-second').prompt, 'preserved second image prompt');

        await reloadAppBrowser(app);
        await openNode(app, 'editor-second');
        assert.equal(await app.evaluate("document.getElementById('editor-second-prompt').value"), 'preserved second image prompt');
        assert.deepEqual(await editorMeasurements(app, 'editor-second'), beforeZoom);
        await openNode(app, 'editor-first');
        assert.deepEqual(await app.evaluate("['prompt','resolution','custom-resolution-width','custom-resolution-height'].map(suffix=>document.getElementById('editor-first-'+suffix).value)"), ['preserved first image prompt', 'custom', '1536', '1024']);
        assert.deepEqual(await geometry(app), originalLayout);
    });
});

test('cached workflows with the same node ID keep distinct editors when switching and deleting the other workflow node', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...session, nodes: [], connections: [] }, async app => {
        const documents = ['A', 'B'].map(name => ({
            name,
            graph: {
                workflowId: `image-editor-workflow-${name.toLowerCase()}`,
                nodes: [{ id: 'shared', type: 'ImageGenerate', x: 150, y: 40, width: 420,
                    apiConfigId: 'image', providerId: 'provider', prompt: `${name} original prompt` }],
                connections: []
            }
        }));
        for (const { name, graph } of documents) {
            assert.equal(await app.evaluate(`fetch('/api/workflows/${name}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(graph)})}).then(response=>response.ok)`), true);
        }

        async function activate(name, prompt) {
            await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
            await app.waitFor(`Boolean(document.querySelector('.workflow-item[data-name="${name}"]'))`);
            await app.evaluate(`document.querySelector('.workflow-item[data-name="${name}"]').click()`);
            await app.waitFor(`document.querySelector('.workflow-item[data-name="${name}"]')?.classList.contains('is-active')===true`);
            await app.evaluate("document.getElementById('btn-close-workflow').click()");
            await app.waitFor(`document.getElementById('shared-prompt')?.value===${JSON.stringify(prompt)}`);
            assert.equal(await app.evaluate("document.querySelectorAll('[id=\"shared-prompt\"]').length"), 1,
                'only the active workflow form participates in document-level control lookup');
            await openNode(app, 'shared');
            assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').contains(document.getElementById('shared-prompt'))"), true);
            assert.equal(await app.evaluate("document.getElementById('shared-prompt').value"), prompt);
        }

        await activate('A', 'A original prompt');
        await changeField(app, 'shared-prompt', 'A edited prompt');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes?.find(node=>node.id==='shared')?.prompt==='A edited prompt')");
        await activate('B', 'B original prompt');
        await activate('A', 'A edited prompt');
        await activate('B', 'B original prompt');

        await app.evaluate("document.getElementById('shared').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('context-menu-delete-nodes').click()");
        await app.waitFor("!document.getElementById('shared') && document.querySelectorAll('[id=\"shared-prompt\"]').length===0");
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true,
            'deleting the active node closes its editor');

        await activate('A', 'A edited prompt');
        assert.equal(await app.evaluate("document.querySelectorAll('.image-parameter-panel:not([hidden])').length"), 1);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes?.find(node=>node.id==='shared')?.prompt==='A edited prompt')");
    });
});
