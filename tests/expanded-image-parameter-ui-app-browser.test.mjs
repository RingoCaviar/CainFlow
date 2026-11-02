import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'first', type: 'ImageGenerate', x: 80, y: 40, width: 420, height: 360, userResized: true, apiConfigId: 'image', providerId: 'p', prompt: 'first draft' },
        { id: 'second', type: 'ImageGenerate', x: 600, y: 40, width: 420, height: 360, userResized: true, apiConfigId: 'image', providerId: 'p', prompt: 'second draft' }],
    connections: []
};
async function open(app, id = 'first') {
    await app.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    await app.waitFor(`!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId===${JSON.stringify(id)}`);
}
const rect = app => app.evaluate("(()=>{const rect=document.getElementById('image-parameter-panel').getBoundingClientRect();return {left:rect.left,top:rect.top,width:rect.width,height:rect.height}})()");
async function point(app, selector) {
    return app.evaluate(`(()=>{const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
}
async function pointer(app, type, point) {
    await app.send('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
}
async function drag(app, selector, dx, dy) {
    const start = await point(app, selector);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
    const hit = await app.evaluate(`(()=>{const target=document.elementFromPoint(${start.x},${start.y});return {reachable:document.querySelector(${JSON.stringify(selector)}).contains(target),target:target?.outerHTML.slice(0,240),point:${JSON.stringify(start)}}})()`);
    assert.equal(hit.reachable, true, `the resize or drag handle is reachable: ${selector} ${JSON.stringify(hit)}`);
    await pointer(app, 'mousePressed', start);
    await pointer(app, 'mouseMoved', { x: start.x + dx, y: start.y + dy });
    await pointer(app, 'mouseReleased', { x: start.x + dx, y: start.y + dy });
}
async function key(app, selector, name) {
    await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus({preventScroll:true})`);
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name });
}

test('expanded parameters drag and resize without replacing forms or changing ordinary width and graph geometry', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await open(app);
        assert.equal(await app.evaluate("!!document.querySelector('#image-parameter-panel [data-parameter-action=expand]')"), true);
        await key(app, '[data-parameter-resize=width]', 'ArrowRight');
        await key(app, '[data-parameter-resize=width]', 'ArrowRight');
        await key(app, '[data-parameter-resize=width]', 'ArrowRight');
        assert.equal((await rect(app)).width, 510);
        await app.evaluate("window.originalPrompt=document.getElementById('first-prompt');document.querySelector('[data-parameter-action=expand]').click()");
        await app.waitFor("document.getElementById('image-parameter-panel').classList.contains('is-expanded')");
        const centered = await rect(app);
        assert.ok(Math.abs(centered.left + centered.width / 2 - 550) <= 2);
        assert.ok(Math.abs(centered.top + centered.height / 2 - 410) <= 2);
        await app.waitFor("!document.querySelector('.toast')", 15000);
        await app.evaluate("document.querySelectorAll('.notice-close').forEach(button=>button.click())");
        for (let step = 0; step < 10; step++) await key(app, '[data-parameter-resize=height]', 'ArrowUp');
        await drag(app, '.image-parameter-drag-handle', -80, 20);
        const moved = await rect(app);
        assert.ok(moved.left <= centered.left - 70 && moved.top >= centered.top + 10, JSON.stringify({ centered, moved }));
        await drag(app, '[data-parameter-resize=both]', 40, 30);
        const enlarged = await rect(app);
        assert.ok(enlarged.width >= moved.width + 25 && enlarged.height >= moved.height + 15, JSON.stringify({ moved, enlarged }));
        await key(app, '[data-parameter-resize=height]', 'ArrowUp');
        assert.ok((await rect(app)).height < enlarged.height);
        const beforeShrink = await rect(app);
        await drag(app, '[data-parameter-resize=both]', 320 - beforeShrink.width, 250 - beforeShrink.height);
        const shrunk = await rect(app);
        assert.deepEqual({ width: shrunk.width, height: shrunk.height }, { width: 320, height: 250 });
        await drag(app, '.image-parameter-drag-handle', 200, 30);
        const afterResizeDrag = await rect(app);
        assert.ok(afterResizeDrag.left >= shrunk.left + 190 && afterResizeDrag.top >= shrunk.top + 20, JSON.stringify({ shrunk, afterResizeDrag }));
        const remembered = await rect(app);
        await open(app, 'second');
        assert.deepEqual(await rect(app), remembered);
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').dataset.mode"), 'expanded');
        await open(app);
        assert.equal(await app.evaluate("document.getElementById('first-prompt')===originalPrompt && document.querySelectorAll('[id=first-prompt]').length===1"), true);
        await app.evaluate("document.querySelector('[data-parameter-action=expand]').click()");
        assert.equal((await rect(app)).width, 510);
        await app.evaluate("document.querySelector('#canvas-navigation .canvas-zoom-menu>summary').click();document.querySelector('#canvas-navigation [data-zoom=\"0.5\"]').click()");
        await app.waitFor("document.getElementById('zoom-level').textContent==='50%'");
        await app.waitFor("(()=>{const panel=document.getElementById('image-parameter-panel').getBoundingClientRect(),node=document.getElementById('first').getBoundingClientRect();return Math.abs(panel.left-node.left-node.width/2+panel.width/2)<=1})()");
        const placement = await app.evaluate("(()=>{const panel=document.getElementById('image-parameter-panel').getBoundingClientRect(),node=document.getElementById('first').getBoundingClientRect();return {left:panel.left,expected:node.left+node.width/2-panel.width/2,top:panel.top,bottom:node.bottom}})()");
        assert.ok(Math.abs(placement.left - placement.expected) <= 1, 'ordinary positioning follows its node without pulling the panel back into the viewport');
        assert.ok(placement.top > placement.bottom);
        await app.evaluate("document.querySelector('[data-parameter-action=expand]').click();document.querySelector('[data-parameter-action=close]').click()");
        await open(app);
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').dataset.mode"), 'normal');
        assert.equal((await rect(app)).width, 510);
        assert.deepEqual(await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.map(node=>({id:node.id,x:node.x,y:node.y,width:node.width,height:node.height})))"), session.nodes.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })));
    });
});

test('expanded controls remain reachable below the revealed toolbar in a low viewport', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await open(app);
        await app.evaluate("document.querySelectorAll('.notice-close').forEach(button=>button.click())");
        await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 420, deviceScaleFactor: 1, mobile: false });
        await app.evaluate("document.querySelector('[data-parameter-action=expand]').click();document.getElementById('btn-run').focus({preventScroll:true})");
        await app.waitFor("document.getElementById('toolbar').getBoundingClientRect().top>-1");
        const geometry = await app.evaluate("(()=>{const panel=document.getElementById('image-parameter-panel').getBoundingClientRect(),toolbar=document.getElementById('toolbar').getBoundingClientRect(),handle=document.querySelector('.image-parameter-drag-handle'),rect=handle.getBoundingClientRect();return {top:panel.top,bottom:panel.bottom,toolbarBottom:toolbar.bottom,reachable:handle.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))}})()");
        assert.ok(geometry.top >= geometry.toolbarBottom + 8 && geometry.bottom <= 408 && geometry.reachable, JSON.stringify(geometry));
        await drag(app, '.image-parameter-drag-handle', 0, -100);
        assert.ok((await rect(app)).top >= geometry.toolbarBottom + 8);
        await app.waitFor("!document.querySelector('.toast')", 15000);
        const recovery = await point(app, '[data-parameter-action=front-parameters]');
        assert.equal(await app.evaluate(`document.querySelector('[data-parameter-action=front-parameters]').contains(document.elementFromPoint(${recovery.x},${recovery.y}))`), true, await app.evaluate(`JSON.stringify({point:${JSON.stringify(recovery)},hit:document.elementFromPoint(${recovery.x},${recovery.y})?.outerHTML.slice(0,400)})`));
    });
});

test('persistent panel controls recover hidden parameters and raise either panel while cancelled gestures leave no active resize', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        await open(app);
        assert.equal(await app.evaluate("!!document.querySelector('[data-parameter-action=front-parameters]') && !!document.querySelector('[data-parameter-action=front-agent]')"), true);
        await app.evaluate("document.querySelector('[data-parameter-action=close]').click();document.querySelector('[data-parameter-action=front-parameters]').click()");
        await app.waitFor("!document.getElementById('image-parameter-panel').hidden");
        for (const cancellation of ["window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true}))",
            "window.dispatchEvent(new Event('blur'))", "document.querySelector('[data-parameter-resize=width]').dispatchEvent(new PointerEvent('lostpointercapture',{pointerId:1,bubbles:true}))"]) {
            const ordinary = await rect(app), start = await point(app, '[data-parameter-resize=width]');
            await pointer(app, 'mousePressed', start);
            await pointer(app, 'mouseMoved', { x: start.x + 35, y: start.y });
            await app.waitFor(`document.getElementById('image-parameter-panel').getBoundingClientRect().width > ${ordinary.width+20}`);
            assert.ok((await rect(app)).width > ordinary.width + 20, JSON.stringify({ordinary,after:await rect(app),start,hit:await app.evaluate(`document.elementFromPoint(${start.x},${start.y})?.outerHTML.slice(0,400)`)}));
            assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').classList.contains('is-resizing')"), true);
            await app.evaluate(cancellation);
            await pointer(app, 'mouseMoved', { x: start.x + 65, y: start.y });
            await app.waitFor("!document.getElementById('image-parameter-panel').classList.contains('is-resizing')");
            await pointer(app, 'mouseReleased', { x: start.x + 65, y: start.y });
            assert.equal((await rect(app)).width, ordinary.width, 'cancel, focus loss and lost capture discard a partial resize');
        }
        await app.evaluate("document.querySelector('[data-parameter-action=expand]').click();document.querySelector('[data-parameter-action=front-agent]').click()");
        await app.waitFor("document.getElementById('prompt-agent-panel').classList.contains('active')");
        const separated = () => app.evaluate("(()=>{const a=document.getElementById('image-parameter-panel').getBoundingClientRect(),b=document.getElementById('prompt-agent-panel').getBoundingClientRect();return a.right<=b.left-8&&a.left>=0})()");
        await app.waitFor("document.getElementById('image-parameter-panel').getBoundingClientRect().right <= document.getElementById('prompt-agent-panel').getBoundingClientRect().left-8");
        assert.equal(await separated(),true);
        await app.evaluate("document.querySelector('[data-parameter-action=front-parameters]').click()");
        assert.equal(await separated(),true,'raising parameters does not overlap the Agent');
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-panel').classList.contains('active')"), true);
        await app.evaluate("document.querySelector('[data-parameter-action=close]').click()");
        assert.equal(await app.evaluate("document.querySelector('[data-parameter-action=front-parameters]').getAttribute('aria-expanded')"), 'false');
        assert.equal(await app.evaluate("document.querySelector('[data-parameter-action=front-parameters]').disabled"), false);
    });
});
