import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('short parameter fields share rows while custom dimensions and long text keep their space', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id: 'image', modelId: 'gpt-image-1', name: 'A deliberately long model name for compact selectors', protocol: 'openai', taskType: 'image', providerIds: ['p'] },
            { id: 'google', modelId: 'gemini-3.1-flash-image-preview', name: 'Gemini Image', protocol: 'google', taskType: 'image', providerIds: ['p'], thinking: { profile: 'google-image' } }],
        providers: [{ id: 'p', name: 'A deliberately long provider name', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        nodes: [{ id: 'paired', type: 'ImageGenerate', x: 180, y: 60, apiConfigId: 'image', providerId: 'p' }], connections: []
    }, async app => {
        await app.evaluate("document.getElementById('paired').click()");
        const settle = () => app.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        const group = async name => { await app.evaluate(`document.querySelector('[data-parameter-group-toggle=${name}]').click()`); await settle(); };
        const rect = suffix => app.evaluate(`(() => { const r=document.getElementById('paired-${suffix}').closest('.node-field').getBoundingClientRect(); return {top:r.top,left:r.left,right:r.right,width:r.width}; })()`);
        const paired = async (first, second) => {
            const a = await rect(first), b = await rect(second);
            assert.ok(Math.abs(a.top-b.top)<1 && a.right<=b.left && Math.abs(a.width-b.width)<1, `${first}/${second} must share an equal-width row: ${JSON.stringify({a,b})}`);
        };
        for (const width of [1280, 390, 320, 280]) {
            await app.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
            await group('model');
            await paired('apiconfig', 'provider');
            await group('size');
            await paired('aspect', 'resolution');
            assert.equal(await app.evaluate("document.getElementById('paired-quality').closest('.node-field').checkVisibility()"), false, 'size entry excludes quality');
            await app.evaluate("(()=>{const select=document.getElementById('paired-resolution');select.value='custom';select.dispatchEvent(new Event('change',{bubbles:true}))})()");
            await settle();
            assert.ok(await app.evaluate("document.getElementById('paired-custom-resolution-field').checkVisibility()"), 'custom dimensions are genuinely open');
            assert.ok((await rect('custom-resolution-width')).width > (await rect('resolution')).width*1.8, 'custom dimensions retain a full row');
            await app.evaluate("(()=>{const select=document.getElementById('paired-resolution');select.value='';select.dispatchEvent(new Event('change',{bubbles:true}))})()");
            await group('more');
            await paired('quality', 'background');
            await paired('background', 'moderation');
            assert.ok((await rect('param-systemPrompt')).width > (await rect('moderation')).width*1.8, 'long text remains full width');
            assert.ok(await app.evaluate("document.querySelector('.image-parameter-settings-popup').offsetWidth<=400"), 'more settings use a content-sized popup');
            const textLayout = await app.evaluate(`(()=>{const t=document.getElementById('paired-param-systemPrompt'),field=t.closest('.node-field'),grid=document.querySelector('.image-parameter-output-options');return {gap:field.getBoundingClientRect().top-grid.getBoundingClientRect().bottom,height:t.offsetHeight,line:parseFloat(getComputedStyle(t).lineHeight),border:parseFloat(getComputedStyle(t).borderTopWidth)}})()`);
            assert.ok(textLayout.gap>=10 && textLayout.border>=1, 'system prompt has deliberate spacing and a visible input border');
            assert.ok(textLayout.height<textLayout.line*3+16, 'empty system prompt starts at two lines');
            await app.evaluate("(()=>{const t=document.getElementById('paired-param-systemPrompt');t.value='长系统提示词\\n'.repeat(9);t.dispatchEvent(new Event('input',{bubbles:true}))})()");
            await settle();
            assert.ok(await app.evaluate("document.getElementById('paired-param-systemPrompt').offsetHeight")>textLayout.height, 'system prompt grows as content is entered');
            await app.evaluate("(()=>{const t=document.getElementById('paired-param-systemPrompt');t.value='';t.dispatchEvent(new Event('input',{bubbles:true}))})()");
            await settle();
            assert.ok(await app.evaluate("[...document.querySelectorAll('.image-parameter-settings-popup,.image-parameter-settings-popup .node-field')].filter(e=>e.checkVisibility()).every(e=>e.scrollWidth<=e.clientWidth+1)"), `${width}px fields have no horizontal overflow`);
        }
        await app.evaluate("(()=>{const s=document.getElementById('paired-apiconfig');s.value='google';s.dispatchEvent(new Event('change',{bubbles:true}))})()");
        await settle();
        await app.evaluate("(()=>{const p=document.querySelector('#image-parameter-panel .image-parameter-settings-popup');if(!p.matches(':popover-open'))document.querySelector('[data-parameter-group-toggle=more]').click()})()");
        await app.waitFor("document.querySelector('#image-parameter-panel .thinking-control')?.checkVisibility()");
        await app.evaluate("document.querySelector('#image-parameter-panel .thinking-control > summary').click()");
        await settle();
        const supported = await app.evaluate(`(()=>{const t=document.querySelector('#image-parameter-panel .thinking-control'),search=document.getElementById('paired-search'),track=search.nextElementSibling,options=document.querySelector('.image-parameter-output-options');return {thinkingHeight:t.querySelector('select').offsetHeight,noteFont:parseFloat(getComputedStyle(t.querySelector('small')).fontSize),switchHeight:search.parentElement.offsetHeight,trackBorder:parseFloat(getComputedStyle(track).borderTopWidth),searchWidth:search.closest('.node-field').offsetWidth,optionsWidth:options.clientWidth}})()`);
        assert.equal(supported.thinkingHeight, 38, 'expanded thinking retains the full popup control height');
        assert.ok(supported.noteFont>=12 && supported.switchHeight>=24 && supported.trackBorder>=1, 'thinking notes and the search off state stay readable and reachable');
        assert.equal(supported.searchWidth, supported.optionsWidth, 'a model with search only does not leave empty option columns');
        assert.ok(await app.evaluate("[...document.querySelector('#image-parameter-panel .thinking-control select').options].some(option=>option.value==='level:high')"), 'switching models refreshes the detached thinking control options');
        await app.evaluate("(()=>{const s=document.getElementById('paired-apiconfig');s.value='image';s.dispatchEvent(new Event('change',{bubbles:true}))})()");
        await app.waitFor("document.querySelector('#image-parameter-panel .thinking-control').hidden===true");
    });
});

test('parameter editor uses viewport space and preserves scrolling without overlapping actions', { timeout: 60000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }, { id: 'image', modelId: 'gpt-image-1', protocol: 'openai', taskType: 'image', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        nodes: [{ id: 'image', type: 'ImageGenerate', x: 400, y: 230, width: 320, apiConfigId: 'image', providerId: 'p', prompt: 'A cat under an umbrella.\n'.repeat(6) }], connections: []
    }, async app => {
        await app.evaluate("document.getElementById('image').click()");
        await app.waitFor("document.getElementById('image-parameter-panel')?.hidden===false");
        const settle = () => app.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        await settle();
        const fits = await app.evaluate("(()=>{const s=document.querySelector('.image-parameter-scroll');return {horizontal:s.scrollWidth-s.clientWidth,available:s.clientHeight}})()");
        assert.ok(fits.horizontal <= 1 && fits.available >= 120, JSON.stringify(fits));
        const origin = await app.evaluate("(()=>{const r=document.getElementById('image-parameter-panel').getBoundingClientRect();return {left:r.left,top:r.top}})()");
        for (const group of ['model', 'size', 'more', 'more']) {
            await app.evaluate(`document.querySelector('[data-parameter-group-toggle=${group}]').click()`);
            await settle();
            const position = await app.evaluate("(()=>{const r=document.getElementById('image-parameter-panel').getBoundingClientRect();return {left:r.left,top:r.top}})()");
            assert.ok(Math.abs(position.left-origin.left)<=0.5 && Math.abs(position.top-origin.top)<=0.5,
                `opening ${group} keeps the editor anchored within subpixel layout rounding`);
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
        await app.waitFor("!document.querySelector('.toast')", 15000);
        await app.evaluate("document.querySelector('[data-parameter-group-toggle=more]').click();document.querySelector('#image-parameter-panel .image-parameter-settings-popup').scrollTop=10000");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await settle();
        const button = await app.evaluate("(()=>{const r=document.querySelector('.generation-count-btn[data-delta=\"1\"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
        const offset = await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop");
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...button, button: 'left', clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...button, button: 'left', clickCount: 1 });
        await settle();
        assert.equal(await app.evaluate("document.getElementById('image-generation-count').value"), '2', 'count click reaches its control');
        assert.equal(await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop"), offset, 'clicking count retains the scroll position');
        for (const width of [280, 320, 390, 1280]) {
            await app.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
            await settle();
            const layout = await app.evaluate(`(() => {
                const panel = document.getElementById('image-parameter-panel');
                const footer = panel.querySelector('.image-parameter-footer');
                const controls = ['.image-parameter-settings-entry', '.image-parameter-model-entry', '.image-parameter-more-entry', '.generation-count-control', '[data-parameter-action=generate]'].map(selector => {
                    const element = footer.querySelector(selector), r = element.getBoundingClientRect();
                    return { top:r.top, bottom:r.bottom, left:r.left, right:r.right, width:r.width, height:r.height, font:parseFloat(getComputedStyle(element).fontSize) };
                });
                const prompt = panel.querySelector('.image-node-prompt-field textarea');
                const border = getComputedStyle(prompt);
                return { controls, promptWidth:prompt.getBoundingClientRect().width, fieldWidth:prompt.closest('.image-node-prompt-field').getBoundingClientRect().width, overflow:footer.scrollWidth-footer.clientWidth, borderWidth:parseFloat(border.borderTopWidth), borderStyle:border.borderTopStyle, borderColor:border.borderTopColor };
            })()`);
            assert.ok(layout.overflow <= 1, `${width}px footer must not overflow`);
            assert.ok(layout.controls.every(r => Math.abs(r.top-layout.controls[0].top)<1 && Math.abs(r.height-32)<1 && r.font===13), `${width}px controls stay compact and aligned on one row: ${JSON.stringify(layout.controls)}`);
            assert.ok(layout.controls.every((r,index)=>!index || Math.abs(r.left-layout.controls[index-1].right-6)<1), `${width}px footer gaps keep the shared 6px rhythm`);
            assert.equal(layout.controls[2].width, 32, 'More remains square');
            assert.equal(layout.controls[3].width, 82, 'count retains its three-digit input space even in a narrow window');
            if (width>=320) assert.ok(layout.controls[4].width>=72 && layout.controls[4].width<=82, 'generate keeps its compact minimum while fitting a three-digit batch label');
            for (const count of [1, 10, 100]) {
                await app.evaluate(`(()=>{const input=document.getElementById('image-generation-count');input.value='${count}';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
                assert.deepEqual(await app.evaluate("(()=>{const i=document.getElementById('image-generation-count');return {value:i.value,width:i.offsetWidth,max:i.getAttribute('max')}})()"), {value:String(count),width:32,max:null});
            }
            if (width===1280) assert.ok(layout.controls[0].width<=124 && layout.controls[0].width<layout.controls[1].width, 'short size summary uses compact width rather than an equal share');
            assert.ok(layout.controls.every((r, index) => r.left>=0 && r.right<=width && (!index || r.left>=layout.controls[index-1].right)), 'all five controls remain on screen without overlap');
            assert.ok(Math.abs(layout.promptWidth-layout.fieldWidth)<1, 'More no longer takes width from the prompt');
            assert.ok(layout.borderWidth>0 && layout.borderStyle==='solid' && !['transparent','rgba(0, 0, 0, 0)'].includes(layout.borderColor), 'prompt keeps a visible border');
        }
    });
});
