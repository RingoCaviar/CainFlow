import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser, delay } from './helpers/app-browser.mjs';

const reference = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] },
        { id: 'image-other', modelId: 'gpt-image-1', name: '另一个图片模型', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'first', type: 'ImageGenerate', x: 40, y: 40, width: 320, height: 300, userResized: true, apiConfigId: 'image', providerId: 'p', prompt: 'first original draft' },
        { id: 'second', type: 'ImageGenerate', x: 720, y: 80, width: 320, height: 300, userResized: true, apiConfigId: 'image', providerId: 'p', prompt: 'second original draft' }
    ],
    connections: []
};
const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value)");
const panelRect = app => app.evaluate("document.getElementById('image-parameter-panel').getBoundingClientRect().toJSON()");
const canvasView = app => app.evaluate("({transform:document.getElementById('nodes-layer').style.transform,zoom:document.getElementById('zoom-level').textContent,nodes:[...document.querySelectorAll('#nodes-layer>.node')].map(node=>({id:node.id,left:node.style.left,top:node.style.top,width:node.offsetWidth,height:node.offsetHeight}))})");

async function open(app, id = 'first') {
    await app.evaluate("document.querySelectorAll('.notice-close').forEach(button=>button.click())");
    await app.evaluate(`document.querySelector('#${id} .image-first-placeholder button').click()`);
    await app.waitFor(`!document.getElementById('image-parameter-panel').hidden&&document.getElementById('image-parameter-panel').dataset.nodeId==='${id}'`);
}

async function expand(app) {
    await app.waitFor("Boolean(document.querySelector('#image-parameter-panel [data-parameter-action=expand]'))");
    await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').click()");
    await app.waitFor("document.getElementById('image-parameter-panel').classList.contains('is-expanded')");
}

async function change(app, id, value) {
    await app.evaluate(`(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

async function point(app, selector) {
    return app.evaluate(`(()=>{const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
}

async function click(app, selector) {
    const position = await point(app, selector);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
    const hit = await app.evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)}),hit=document.elementFromPoint(${position.x},${position.y});return {reachable:target.contains(hit),hit:hit?.outerHTML.slice(0,240),point:${JSON.stringify(position)},rect:target.getBoundingClientRect().toJSON()}})()`);
    assert.ok(hit.reachable, `the user can reach ${selector}: ${JSON.stringify(hit)}`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });
}

async function gesture(app, selector, dx, dy) {
    const position = await point(app, selector);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
    const hit = await app.evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)}),hit=document.elementFromPoint(${position.x},${position.y});return {reachable:target.contains(hit),hit:hit?.outerHTML.slice(0,240),point:${JSON.stringify(position)},rect:target.getBoundingClientRect().toJSON()}})()`);
    assert.ok(hit.reachable, `the user can reach ${selector}: ${JSON.stringify(hit)}`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: position.x + dx, y: position.y + dy, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: position.x + dx, y: position.y + dy, button: 'left', clickCount: 1 });
}

async function key(app, key, code = key, modifiers = 0, windowsVirtualKeyCode) {
    const options = { key, code, modifiers, ...(windowsVirtualKeyCode ? { windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode } : {}) };
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', ...options });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...options });
}

async function clickVisibleSurface(app, id) {
    const position = await app.evaluate(`(()=>{const root=document.getElementById(${JSON.stringify(id)}),rect=root.getBoundingClientRect();for(const y of [rect.top+60,rect.top+rect.height/2,rect.bottom-30])for(const x of [rect.left+8,rect.right-8,rect.left+rect.width/2]){const hit=document.elementFromPoint(x,y);if(root.contains(hit)&&!hit.closest('button,input,textarea,select,[role=separator]'))return {x,y}}return null})()`);
    assert.ok(position, `a visible part of ${id} can be clicked`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });
}

async function overlapOwner(app) {
    return app.evaluate("(()=>{const a=document.getElementById('image-parameter-panel').getBoundingClientRect(),b=document.getElementById('prompt-agent-panel').getBoundingClientRect(),x=(Math.max(a.left,b.left)+Math.min(a.right,b.right))/2,y=(Math.max(a.top,b.top)+Math.min(a.bottom,b.bottom))/2;return document.elementFromPoint(x,y)?.closest('#image-parameter-panel,#prompt-agent-panel')?.id})()");
}

async function controlledAgent(app) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.expandedAgentRequests=[];window.expandedAgentPending=false;window.expandedAgentAborted=false;const nativeFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);if(body.messages){expandedAgentRequests.push(body);expandedAgentPending=true;options.signal?.addEventListener('abort',()=>window.expandedAgentAborted=true);await new Promise(resolve=>window.releaseExpandedAgent=resolve);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'chat',message:'受控回复已完成，原草稿保持'})}}]}),{headers:{'Content-Type':'application/json'}});}}return nativeFetch(url,options)};" });
    await reloadAppBrowser(app);
}

async function attach(app, name) {
    await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(${JSON.stringify(reference)})).blob()],${JSON.stringify(name)},{type:'image/png'}));document.getElementById('prompt-agent-form').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);
    await app.waitFor("document.querySelectorAll('#prompt-agent-references img').length===1&&!document.querySelector('#prompt-agent-references .is-loading')");
}

async function panTo(app, targetTop) {
    for (let attempt = 0; attempt < 12; attempt++) {
        const remaining = targetTop - (await panelRect(app)).top;
        if (Math.abs(remaining) < 2) return;
        const distance = Math.max(-90, Math.min(90, remaining)), y = distance < 0 ? 350 : 260;
        const origin = await app.evaluate(`(()=>{for(const x of [4,innerWidth-4]){const hit=document.elementFromPoint(x,${y});if(hit?.closest('#canvas-container')&&!hit.closest('.node,#image-parameter-panel,#canvas-navigation'))return {x,y:${y}}}return null})()`);
        assert.ok(origin, 'manual navigation begins on reachable blank canvas below the toolbar');
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...origin });
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...origin, button: 'middle', buttons: 4, clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: origin.x, y: origin.y + distance, button: 'middle', buttons: 4 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: origin.x, y: origin.y + distance, button: 'middle', buttons: 0, clickCount: 1 });
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    }
    assert.ok(Math.abs((await panelRect(app)).top - targetTop) < 2, 'deliberate panning reaches the chosen lower-panel position');
}

test('enlarging reuses the original controls, supports dragging and bidirectional resizing, and restores the current lower anchor and preferred width', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async app => {
        await open(app);
        await app.evaluate("document.querySelector('#image-parameter-panel [role=separator]').focus({preventScroll:true})");
        for (let step = 0; step < 3; step++) {
            await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
            await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' });
        }
        assert.equal((await panelRect(app)).width, 510);
        const before = await canvasView(app);
        await app.evaluate("window.originalFirstPrompt=document.getElementById('first-prompt');window.originalFirstForm=originalFirstPrompt.closest('.image-first-parameter-content')");
        await change(app, 'first-prompt', 'first edited without recreating the form');
        await expand(app);
        const enlarged = await panelRect(app);
        assert.ok(Math.abs(enlarged.x + enlarged.width / 2 - 550) < 2 && Math.abs(enlarged.y + enlarged.height / 2 - 410) < 2, 'the initial enlarged window is centered in the actual viewport');
        assert.equal(await app.evaluate("originalFirstPrompt===document.getElementById('first-prompt')&&originalFirstForm.contains(originalFirstPrompt)&&document.getElementById('image-parameter-panel').contains(originalFirstForm)"), true);
        await app.evaluate("document.querySelector('[data-parameter-resize=height]').focus({preventScroll:true})");
        for (let step = 0; step < 8; step++) await key(app, 'ArrowUp');
        assert.ok((await panelRect(app)).height < enlarged.height - 50, 'the height edge is keyboard operable as well as pointer operable');
        await gesture(app, '.image-parameter-drag-handle', -35, -40);
        const moved = await panelRect(app);
        const toolbarBottom = await app.evaluate("document.getElementById('toolbar').offsetHeight+12");
        assert.ok(Math.abs(moved.x - enlarged.x + 35) < 2 && moved.top >= toolbarBottom - 1 && moved.top <= enlarged.top, 'dragging moves the window while keeping its header outside the revealing toolbar');
        await gesture(app, '[data-parameter-resize=both]', -65, -45);
        const shrunk = await panelRect(app);
        assert.ok(shrunk.width < moved.width - 50 && shrunk.height < moved.height - 30);
        await gesture(app, '[data-parameter-resize=both]', 45, 30);
        const grown = await panelRect(app);
        assert.ok(grown.width > shrunk.width + 30 && grown.height > shrunk.height + 20);
        await open(app, 'second');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').classList.contains('is-expanded')"), true);
        assert.deepEqual(await panelRect(app), grown, 'switching the edited node preserves this enlarged rectangle');
        await change(app, 'second-prompt', 'second independent draft');
        await open(app);
        assert.equal(await app.evaluate("document.getElementById('first-prompt')===originalFirstPrompt&&document.getElementById('first-prompt').value==='first edited without recreating the form'"), true);
        await open(app, 'second');
        await click(app, '#image-parameter-panel [data-parameter-action=expand]');
        const normal = await panelRect(app), anchor = await app.evaluate("document.getElementById('second').getBoundingClientRect().bottom");
        assert.equal(normal.width, 510, 'expanded resizing never replaces the normal width preference');
        assert.ok(Math.abs(normal.top - anchor - 50) < 2, 'restoring follows the current node below its card');
        await expand(app);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
        await open(app);
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').classList.contains('is-expanded')"), false);
        assert.equal((await panelRect(app)).width, 510);
        assert.deepEqual(await canvasView(app), before, 'window operations never pan or rewrite the canvas');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='second')?.prompt==='second independent draft')");
        await reloadAppBrowser(app); await open(app);
        assert.equal((await panelRect(app)).width, 510);
        assert.equal(await app.evaluate("document.getElementById('first-prompt').value"), 'first edited without recreating the form');
        assert.equal(await app.evaluate("document.getElementById('second-prompt').value"), 'second independent draft');
        assert.deepEqual(await canvasView(app), before);
    });
});

test('overlapping parameter and Agent windows can both be recovered without losing drafts, original attachments, models or the held real request', { timeout: 90000 }, async () => {
    await withAppBrowser(session, async app => {
        await controlledAgent(app); await open(app);
        await change(app, 'first-prompt', 'edited while reading the assistant');
        await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        await app.waitFor("document.getElementById('prompt-agent-panel').classList.contains('active')");
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), false, 'opening Agent keeps the parameter editor open');
        await app.evaluate("document.querySelector('#prompt-agent-model + button').click();document.querySelector('#prompt-agent-model-menu [data-model-id=chat][data-provider-id=p]').click();document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=image-other][data-provider-id=p]').click()");
        await change(app, 'prompt-agent-input', 'send this conversation with its original attachment');
        await attach(app, 'submitted-original.png');
        await app.evaluate("document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
        await app.waitFor('expandedAgentPending===true');
        await change(app, 'prompt-agent-input', 'keep this next draft while the previous request runs');
        await attach(app, 'next-original.png');
        const graph = await saved(app), referenceSource = await app.evaluate("document.querySelector('#prompt-agent-references img').src");
        await expand(app);
        assert.equal(await overlapOwner(app), 'image-parameter-panel');
        await clickVisibleSurface(app, 'prompt-agent-panel');
        assert.equal(await overlapOwner(app), 'prompt-agent-panel', 'clicking the visible assistant surface raises it');
        await clickVisibleSurface(app, 'image-parameter-panel');
        assert.equal(await overlapOwner(app), 'image-parameter-panel', 'clicking the visible parameter surface raises it');
        const initial = await panelRect(app);
        await gesture(app, '[data-parameter-resize=both]', 320 - initial.width, 250 - initial.height);
        const small = await panelRect(app), agent = await app.evaluate("document.getElementById('prompt-agent-panel').getBoundingClientRect().toJSON()");
        assert.ok(agent.width > small.width + 12, 'the native Agent is wide enough to cover the resized parameter window');
        const toolbarBottom = await app.evaluate("document.getElementById('toolbar').offsetHeight+12");
        await gesture(app, '.image-parameter-drag-handle', agent.left + 6 - small.left, Math.max(agent.top + 70, toolbarBottom) + 12 - small.top);
        const covered = await panelRect(app);
        assert.ok(covered.left >= agent.left && covered.right <= agent.right && covered.top >= agent.top && covered.bottom <= agent.bottom, `the entire parameter window is inside the assistant rectangle: ${JSON.stringify({ covered, agent })}`);
        await click(app, '[data-parameter-action=front-agent]');
        assert.equal(await overlapOwner(app), 'prompt-agent-panel');
        await click(app, '[data-parameter-action=front-parameters]');
        assert.equal(await overlapOwner(app), 'image-parameter-panel', 'the explicit control recovers a fully covered parameter window');
        await click(app, '[data-parameter-action=front-agent]');
        await click(app, '#btn-close-prompt-agent');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), false);
        await click(app, '[data-parameter-action=front-agent]');
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-input').value"), 'keep this next draft while the previous request runs');
        assert.deepEqual(await app.evaluate("['prompt-agent-model','prompt-agent-image-model'].map(id=>document.getElementById(id).value)"), ['chat', 'image-other']);
        assert.equal(await app.evaluate("document.querySelector('#prompt-agent-references img').src"), referenceSource);
        assert.equal(await app.evaluate('expandedAgentAborted'), false);
        assert.equal(await app.evaluate('expandedAgentRequests.length'), 1);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-cancel').hidden"), false);
        await app.evaluate('releaseExpandedAgent()');
        await app.waitFor("document.getElementById('prompt-agent-cancel').hidden&&document.getElementById('prompt-agent-messages').textContent.includes('受控回复已完成')");
        assert.ok((await app.evaluate('expandedAgentRequests[0].messages')).some(message => JSON.stringify(message.content).includes('data:image/')), 'the actual request keeps its original reference image');
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-input').value"), 'keep this next draft while the previous request runs');
        assert.equal(await app.evaluate("document.querySelectorAll('#prompt-agent-references img').length"), 1);
        assert.equal(await app.evaluate("document.getElementById('first-prompt').value"), 'edited while reading the assistant');
        const after = await saved(app);
        assert.deepEqual(after.connections, graph.connections);
        assert.deepEqual(after.nodes.map(node => ({ id: node.id, x: node.x, y: node.y, mediaAssetKeys: node.mediaAssetKeys })), graph.nodes.map(node => ({ id: node.id, x: node.x, y: node.y, mediaAssetKeys: node.mediaAssetKeys })));
    });
});

test('native text undo and panel buttons never undo or delete graph nodes, and Escape handles popups and true modals before modeless windows', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async app => {
        const cloneDialog = "document.getElementById('first').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:160}));document.getElementById('context-menu-clone-node').click()";
        await app.evaluate(cloneDialog);
        await app.evaluate("document.getElementById('clone-node-count-input').value='1';document.getElementById('btn-confirm-clone-node-count').click()");
        await app.waitFor("document.querySelectorAll('#nodes-layer>.node').length===3");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===3)");
        await open(app); await expand(app);
        const before = await canvasView(app);
        await app.evaluate("document.getElementById('first-prompt').focus({preventScroll:true});document.getElementById('first-prompt').select()");
        await app.send('Input.insertText', { text: 'a native editable draft with undo history' });
        assert.equal(await app.evaluate("document.getElementById('first-prompt').value"), 'a native editable draft with undo history');
        await key(app, 'z', 'KeyZ', 2, 90);
        assert.equal(await app.evaluate("document.getElementById('first-prompt').value"), 'first original draft', 'Ctrl+Z invokes native textarea undo');
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer>.node').length"), 3, 'native text undo does not consume graph history');
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=expand]').focus({preventScroll:true})");
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 600 });
        await key(app, 'z', 'KeyZ', 2, 90); await key(app, 'Delete', 'Delete', 0, 46);
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer>.node').length"), 3, 'a focused parameter tool also excludes canvas undo and deletion');
        await app.evaluate("document.getElementById('btn-prompt-agent').click();document.getElementById('prompt-agent-add-reference').focus({preventScroll:true})");
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 600 });
        await key(app, 'z', 'KeyZ', 2, 90); await key(app, 'Delete', 'Delete', 0, 46);
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer>.node').length"), 3, 'Agent buttons retain their own keyboard context even with the mouse over the canvas');
        await app.evaluate(cloneDialog);
        await app.waitFor("!document.getElementById('clone-node-count-dialog').classList.contains('hidden')");
        assert.equal(await app.evaluate("Boolean(document.getElementById('image-parameter-panel').closest('[inert]'))&&Boolean(document.getElementById('prompt-agent-panel').closest('[inert]'))"), true, 'a real modal masks both modeless windows');
        assert.equal(await app.evaluate("Boolean(document.activeElement.closest('#clone-node-count-dialog'))"), true);
        await key(app, 'Escape');
        await app.waitFor("document.getElementById('clone-node-count-dialog').classList.contains('hidden')");
        assert.equal(await app.evaluate("!document.getElementById('image-parameter-panel').hidden&&document.getElementById('prompt-agent-panel').classList.contains('active')"), true);
        await click(app, '[data-parameter-action=front-agent]');
        await click(app, '#prompt-agent-model + button');
        await app.waitFor("Boolean(document.getElementById('prompt-agent-model-menu'))");
        await key(app, 'Escape');
        assert.equal(await app.evaluate("Boolean(document.getElementById('prompt-agent-model-menu'))"), false);
        assert.equal(await app.evaluate("!document.getElementById('image-parameter-panel').hidden&&document.getElementById('prompt-agent-panel').classList.contains('active')"), true, 'Escape closes the owned model popup first');
        await key(app, 'Escape');
        await app.waitFor("!document.getElementById('prompt-agent-panel').classList.contains('active')");
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), false, 'only the front modeless window closes');
        await key(app, 'Escape');
        await app.waitFor("document.getElementById('image-parameter-panel').hidden");
        assert.equal(await app.evaluate('document.activeElement?.id'), 'first', 'closing returns keyboard focus to the original node without scrolling');
        assert.deepEqual(await canvasView(app), before);
        await open(app); await expand(app);
        await app.evaluate("document.getElementById('btn-prompt-agent').click();document.getElementById('btn-history').click()");
        await app.waitFor("document.getElementById('history-sidebar').classList.contains('active')");
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden&&!document.getElementById('prompt-agent-panel').classList.contains('active')"), true, 'other primary panels retain mutual exclusion with both modeless windows');
        await app.evaluate("document.getElementById('btn-close-history').click()");
        assert.equal(await app.evaluate("document.getElementById('first-prompt').value"), 'first original draft');
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===3)");
        const graph = await saved(app);
        assert.equal(graph.nodes.length, 3); assert.deepEqual(graph.connections, []);
    });
});

test('a narrow low viewport and low canvas zoom constrain temporary window bounds without overwriting normal width or automatically moving the canvas', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async app => {
        await open(app);
        await app.evaluate("document.querySelector('#image-parameter-panel [role=separator]').focus({preventScroll:true})");
        for (let step = 0; step < 3; step++) await key(app, 'ArrowRight');
        const initial = await canvasView(app), width = (await panelRect(app)).width;
        assert.equal(width, 510);
        await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 420, deviceScaleFactor: 1, mobile: false });
        await app.evaluate("document.querySelectorAll('.notice-close').forEach(button=>button.click())");
        await app.waitFor("document.getElementById('image-parameter-panel').getBoundingClientRect().width<=336");
        const constrained = await panelRect(app), bottom = await app.evaluate("document.getElementById('first').getBoundingClientRect().bottom");
        assert.ok(Math.abs(constrained.top - bottom - 50) < 2 && constrained.bottom > 420, 'normal mode stays below the node even when that position extends outside the low viewport');
        assert.deepEqual(await canvasView(app), initial, 'viewport constraints do not pan, zoom, or rearrange the graph');
        await expand(app);
        const enlarged = await panelRect(app);
        assert.ok(enlarged.left >= 8 && enlarged.top >= 8 && enlarged.right <= 352 && enlarged.bottom <= 412, 'active enlargement keeps its window controls in the narrow viewport');
        assert.ok(enlarged.top >= await app.evaluate("document.getElementById('toolbar').offsetHeight+12") - 1, 'the enlarged header stays below the complete native toolbar footprint');
        const recovery = await point(app, '[data-parameter-action=front-parameters]');
        assert.ok(recovery.x >= enlarged.left && recovery.x <= enlarged.right && recovery.y >= enlarged.top && recovery.y <= enlarged.bottom, 'the enlarged window physically covers the recovery control location');
        await click(app, '[data-parameter-action=front-parameters]');
        assert.ok(await app.evaluate("(()=>{const panel=document.getElementById('image-parameter-panel'),scroll=panel.querySelector('.image-parameter-scroll');return scroll.scrollWidth<=scroll.clientWidth+1&&parseFloat(getComputedStyle(document.getElementById('first-prompt')).fontSize)>=13})()"));
        await click(app, '#image-parameter-panel [data-parameter-action=expand]');
        assert.ok(Math.abs((await panelRect(app)).top - bottom - 50) < 2);
        await app.evaluate("document.querySelector('#canvas-navigation .canvas-zoom-menu>summary').click();document.querySelector('#canvas-navigation [data-zoom=\"0.5\"]').click()");
        await app.waitFor("document.getElementById('zoom-level').textContent==='50%'");
        assert.equal((await panelRect(app)).width, constrained.width);
        await panTo(app, await app.evaluate("document.getElementById('toolbar').offsetHeight+24"));
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), false, 'deliberate panning preserves the editor');
        await click(app, '#first-prompt');
        await app.send('Input.insertText', { text: 'readable narrow-screen edit at fifty percent zoom' });
        assert.match(await app.evaluate("document.getElementById('first-prompt').value"), /readable narrow-screen edit/);
        await panTo(app, 80);
        const footer = await point(app, '#image-parameter-panel [data-parameter-action=generate]');
        assert.ok(footer.y > 0 && footer.y < 420);
        assert.equal(await app.evaluate(`document.elementFromPoint(${footer.x},${footer.y})?.closest('[data-parameter-action=generate]')!==null`), true, 'the primary action is reachable after manual navigation');
        const navigated = await canvasView(app);
        await app.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
        await app.waitFor(`document.getElementById('image-parameter-panel').getBoundingClientRect().width===${width}`);
        assert.deepEqual(await canvasView(app), navigated, 'restoring viewport size preserves the manually chosen canvas view');
        assert.deepEqual(navigated.nodes, initial.nodes);
        assert.equal(await app.evaluate('window.scrollX===0&&window.scrollY===0'), true);
    });
});
