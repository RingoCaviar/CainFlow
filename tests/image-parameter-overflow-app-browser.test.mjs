import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('parameter editor uses viewport space and preserves scrolling without overlapping actions', { timeout: 60000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }, { id: 'image', modelId: 'gpt-image-1', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        nodes: [{ id: 'image', type: 'ImageGenerate', x: 400, y: 230, width: 320, apiConfigId: 'image', providerId: 'p', prompt: 'A cat under an umbrella.\n'.repeat(6) }], connections: []
    }, async app => {
        await app.evaluate("document.getElementById('image').click()");
        await app.waitFor("document.getElementById('image-parameter-panel')?.hidden===false");
        const settle = () => app.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        await settle();
        const fits = await app.evaluate("(()=>{const s=document.querySelector('.image-parameter-scroll');return {content:s.scrollHeight,available:s.clientHeight}})()");
        assert.ok(fits.content <= fits.available + 1, JSON.stringify(fits));
        const origin = await app.evaluate("(()=>{const r=document.getElementById('image-parameter-panel').getBoundingClientRect();return {left:r.left,top:r.top}})()");
        for (const group of ['model', 'size', 'advanced', 'advanced']) {
            await app.evaluate(`document.querySelector('[data-parameter-group-toggle=${group}]').click()`);
            await settle();
            assert.deepEqual(await app.evaluate("(()=>{const r=document.getElementById('image-parameter-panel').getBoundingClientRect();return {left:r.left,top:r.top}})()"), origin, `opening ${group} keeps the editor anchored`);
        }
        await app.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 260, deviceScaleFactor: 1, mobile: false });
        await settle();
        await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop=40");
        const before = await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop");
        assert.ok(before > 0, 'short viewport genuinely requires scrolling');
        await app.evaluate("document.querySelector('.image-parameter-scroll').dispatchEvent(new Event('input',{bubbles:true}))");
        await settle();
        assert.equal(await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop"), before, 'layout refresh preserves scroll offset');
        assert.ok(await app.evaluate("(()=>{const f=document.querySelector('.image-parameter-footer');return f.getBoundingClientRect().top>=f.previousElementSibling.getBoundingClientRect().bottom-1})()"), 'footer does not cover preceding parameters');
        await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop=10000");
        const button = await app.evaluate("(()=>{const r=document.querySelector('.generation-count-btn[data-delta=\"1\"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
        const offset = await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop");
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...button, button: 'left', clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...button, button: 'left', clickCount: 1 });
        await settle();
        assert.equal(await app.evaluate("document.getElementById('image-generation-count').value"), '2', 'count click reaches its control');
        assert.equal(await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop"), offset, 'clicking count retains the scroll position');
    });
});
