import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser, delay, waitForAutosave } from './helpers/app-browser.mjs';

const reference = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] },
        { id: 'image-other', modelId: 'gpt-image-1', name: '另一个图片模型', protocol: 'openai', taskType: 'image', providerIds: ['p'] }
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
    await app.evaluate(`document.querySelector('#${id} .image-first-placeholder').click()`);
    await app.waitFor(`!document.getElementById('image-parameter-panel').hidden&&document.getElementById('image-parameter-panel').dataset.nodeId==='${id}'`);
}

async function change(app, id, value) {
    await app.evaluate(`(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

async function point(app, selector) {
    return app.evaluate(`(()=>{const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
}

async function click(app, selector) {
    await app.evaluate("document.querySelectorAll('.notice-close').forEach(button=>button.click())");
    await app.waitFor("!document.querySelector('.toast')", 15000);
    const position = await point(app, selector);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
    const hit = await app.evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)}),hit=document.elementFromPoint(${position.x},${position.y});return {reachable:target.contains(hit),hit:hit?.outerHTML.slice(0,240),point:${JSON.stringify(position)},rect:target.getBoundingClientRect().toJSON()}})()`);
    assert.ok(hit.reachable, `the user can reach ${selector}: ${JSON.stringify(hit)}`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });
}

async function clickToolbarAgent(app) {
    const x = await app.evaluate("(()=>{const r=document.getElementById('btn-prompt-agent').getBoundingClientRect();return r.left+r.width/2})()");
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 2 });
    await app.waitFor("document.getElementById('btn-prompt-agent').getBoundingClientRect().top>=0");
    await click(app, '#btn-prompt-agent');
}

async function gesture(app, selector, dx, dy) {
    await app.evaluate("document.querySelectorAll('.notice-close').forEach(button=>button.click())");
    await app.waitFor("!document.querySelector('.toast')", 15000);
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
    const position = await app.evaluate(`(()=>{const root=document.getElementById(${JSON.stringify(id)}),rect=root.getBoundingClientRect();for(const y of [rect.top+60,rect.top+rect.height/2,rect.bottom-30])for(const x of [rect.left+4,rect.right-4,rect.left+8,rect.right-8,rect.left+rect.width/2]){const hit=document.elementFromPoint(x,y);if(root.contains(hit)&&!hit.closest('button,input,textarea,select,[role=separator]'))return {x,y}}return null})()`);
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

test('overlapping editors raise and accept the first direct click without recovery buttons', { timeout: 40000 }, async () => {
    await withAppBrowser(session, async app => {
        await open(app);
        await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        await app.waitFor("document.getElementById('prompt-agent-panel').classList.contains('active')");
        assert.equal(await app.evaluate("document.querySelector('.image-panel-switcher')"), null);
        const original = await canvasView(app);
        for (const [width, height] of [[640, 720], [640, 400], [360, 420]]) {
            await app.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            await app.evaluate("document.getElementById('prompt-agent-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))");
            await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
            await clickVisibleSurface(app, 'prompt-agent-panel');
            await app.evaluate("document.querySelectorAll('.toast').forEach(toast=>toast.remove())");
            // Use the exposed left part of Size, rather than clicking a hidden
            // control through the Agent. This same click must open the menu.
            const size = await app.evaluate("(()=>{const r=document.querySelector('#image-parameter-panel .image-parameter-settings-entry').getBoundingClientRect();return {x:r.left+8,y:r.top+r.height/2}})()");
            assert.equal(await app.evaluate(`document.elementFromPoint(${size.x},${size.y})?.closest('button')?.classList.contains('image-parameter-settings-entry')`), true,
                JSON.stringify(await app.evaluate(`({viewport:[innerWidth,innerHeight],point:${JSON.stringify(size)},hit:document.elementFromPoint(${size.x},${size.y})?.outerHTML.slice(0,200),parameter:document.getElementById('image-parameter-panel').getBoundingClientRect().toJSON(),agent:document.getElementById('prompt-agent-panel').getBoundingClientRect().toJSON()})`)));
            await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...size });
            await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...size, button: 'left', clickCount: 1 });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...size, button: 'left', clickCount: 1 });
            await app.waitFor("document.querySelector('#image-parameter-panel .image-parameter-settings-popup').matches(':popover-open')");
            assert.equal(await overlapOwner(app), 'image-parameter-panel');
            // The Agent composer stays exposed below the compact parameter
            // editor. Clicking it also dismisses the other editor's popup.
            await click(app, '#prompt-agent-input');
            assert.equal(await app.evaluate('document.activeElement.id'), 'prompt-agent-input', `${width}x${height}: first click places the caret`);
            assert.equal(await app.evaluate("document.querySelector('.image-parameter-settings-popup:popover-open')"), null);
            assert.equal(await overlapOwner(app), 'prompt-agent-panel');
            await clickVisibleSurface(app, 'image-parameter-panel');
            assert.equal(await overlapOwner(app), 'image-parameter-panel');
            assert.equal(await app.evaluate("document.getElementById('first-prompt').value"), 'first original draft');
        }
        assert.deepEqual(await canvasView(app), original, 'raising editors does not move the canvas or edit the graph');
    });
});

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
    const bounds=await panelRect(app);
    assert.ok(bounds.top>=12&&bounds.bottom<=408,'manual panning preserves visible panel bounds');
}

test('native text undo and panel buttons never undo or delete graph nodes, and Escape handles popups and true modals before modeless windows', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async app => {
        const cloneDialog = "document.getElementById('first').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:160}));document.getElementById('context-menu-clone-node').click()";
        await app.evaluate(cloneDialog);
        await app.evaluate("document.getElementById('clone-node-count-input').value='1';document.getElementById('btn-confirm-clone-node-count').click()");
        await app.waitFor("document.querySelectorAll('#nodes-layer>.node').length===3");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.length===3)");
        await open(app);
        const before = await canvasView(app);
        await app.evaluate("document.getElementById('first-prompt').focus({preventScroll:true});document.getElementById('first-prompt').select()");
        await app.send('Input.insertText', { text: 'a native editable draft with undo history' });
        assert.equal(await app.evaluate("document.getElementById('first-prompt').value"), 'a native editable draft with undo history');
        await key(app, 'z', 'KeyZ', 2, 90);
        assert.equal(await app.evaluate("document.getElementById('first-prompt').value"), 'first original draft', 'Ctrl+Z invokes native textarea undo');
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer>.node').length"), 3, 'native text undo does not consume graph history');
        await app.evaluate("document.querySelector('#image-parameter-panel .image-parameter-settings-entry').focus({preventScroll:true})");
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
        await clickVisibleSurface(app, 'prompt-agent-panel');
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
        await open(app);
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


test('separated parameter and Agent windows remain accessible without losing drafts, original attachments, models or the held real request', { timeout: 90000 }, async () => {
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
        await waitForAutosave(app);
        const graph = await saved(app), referenceSource = await app.evaluate("document.querySelector('#prompt-agent-references img').src");

        const separated = async () => {
            await app.waitFor("document.getElementById('image-parameter-panel').getBoundingClientRect().right <= document.getElementById('prompt-agent-panel').getBoundingClientRect().left-8");
            const bounds=await panelRect(app); assert.ok(bounds.left>=12&&bounds.bottom<=808);
        };
        await separated();
        await clickVisibleSurface(app,'prompt-agent-panel'); await separated();
        await clickVisibleSurface(app,'image-parameter-panel'); await separated();
        await clickVisibleSurface(app, 'prompt-agent-panel'); await separated();
        await clickVisibleSurface(app, 'image-parameter-panel'); await separated();
        await clickVisibleSurface(app, 'prompt-agent-panel');
        await clickToolbarAgent(app);
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), false);
        await clickToolbarAgent(app);
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
