import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';
import { parseColor, composite, contrastRatio } from './helpers/browser-theme-fixture.mjs';

const themes = ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink'];
test('Agent search switch stays editable regardless of capability across themes', { timeout: 60000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, models: [{ id: 'chat', modelId: 'test', name: '受控对话', agentSearch: 'web', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }], providers: [{ id: 'p', name: 'Controlled', endpoint: 'https://controlled.test/v1', apikey: 'test' }] }, async ({ evaluate, send, waitFor }) => {
        await send('Emulation.setDeviceMetricsOverride', { width: 640, height: 720, deviceScaleFactor: 1, mobile: false });
        await evaluate(`document.getElementById('btn-prompt-agent').click(); document.getElementById('prompt-agent-panel').style.width='300px'; document.getElementById('prompt-agent-model').parentElement.querySelector('.thinking-control > summary').click()`);
        await waitFor("!!document.querySelector('.prompt-agent-thinking-menu #prompt-agent-search-enabled')");
        for (const theme of themes) {
            await evaluate(`document.documentElement.dataset.appTheme='${theme}'`);
            const state = await evaluate(`(()=>{const input=document.getElementById('prompt-agent-search-enabled'),slider=input.nextElementSibling;slider.scrollIntoView({block:'nearest'});const r=slider.getBoundingClientRect();return {disabled:input.disabled,hit:slider.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),inside:r.left>=0&&r.right<=640&&r.top>=0&&r.bottom<=720};})()`);
            assert.deepEqual(state, {disabled:false,hit:true,inside:true}, theme);
            const geometry = await evaluate(`(()=>{const input=document.getElementById('prompt-agent-search-enabled'),slider=input.nextElementSibling,r=slider.getBoundingClientRect(),s=getComputedStyle(slider,'::before');return {height:r.height,width:r.width,thumbCenter:parseFloat(s.top)+parseFloat(s.height)/2+new DOMMatrix(s.transform).m42+parseFloat(getComputedStyle(slider).borderTopWidth)||0};})()`);
            assert.equal(geometry.height,22,`${theme} switch track height`);
            assert.equal(geometry.width,38,`${theme} switch track width`);
            assert.ok(Math.abs(geometry.thumbCenter-geometry.height/2)<0.25,`${theme} thumb vertically centered: ${JSON.stringify(geometry)}`);

        }
        await send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
        await evaluate("document.documentElement.classList.add('animations-disabled')");
        await delay(250);
        const animated = await evaluate(`(async()=>{
            const input=document.getElementById('prompt-agent-search-enabled');
            const slider=input.nextElementSibling;const x=()=>new DOMMatrix(getComputedStyle(slider,'::before').transform).m41;
            const sample=()=>({x:x(),background:getComputedStyle(slider).backgroundColor});
            const beforeOff=sample();input.closest('label').click();await new Promise(resolve=>setTimeout(resolve,60));const duringOff=sample();
            await new Promise(resolve=>setTimeout(resolve,480));const afterOff=sample();
            input.closest('label').click();await new Promise(resolve=>setTimeout(resolve,60));const duringOn=sample();
            await new Promise(resolve=>setTimeout(resolve,480));const afterOn=sample();
            return {beforeOff,duringOff,afterOff,duringOn,afterOn,focused:input.isConnected,duration:getComputedStyle(slider,'::before').transitionDuration,trackDuration:getComputedStyle(slider).transitionDuration,property:getComputedStyle(slider,'::before').transitionProperty,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches};
        })()`);
        assert.equal(animated.beforeOff.x,16);
        assert.equal(await evaluate("document.getElementById('prompt-agent-search-availability')"), null);
        assert.ok(animated.duringOff.x>0&&animated.duringOff.x<16, 'switch must animate when turning off: '+JSON.stringify(animated));
        assert.equal(animated.afterOff.x,0);
        assert.ok(animated.duringOn.x>0&&animated.duringOn.x<16, 'switch must animate when turning on: '+JSON.stringify(animated));
        assert.equal(animated.afterOn.x,16);
        assert.notEqual(animated.beforeOff.background,animated.duringOff.background,'track must animate when turning off');
        assert.notEqual(animated.duringOff.background,animated.afterOff.background,'track must finish turning off');
        assert.notEqual(animated.afterOff.background,animated.duringOn.background,'track must animate when turning on');
        assert.notEqual(animated.duringOn.background,animated.afterOn.background,'track must finish turning on');
        assert.ok(parseFloat(animated.duration) >= 0.38, 'thumb motion should be noticeable in both directions: '+JSON.stringify(animated));
        assert.ok(parseFloat(animated.trackDuration) >= 0.38, 'track color should transition with the thumb: '+JSON.stringify(animated));
        assert.match(animated.property,/transform/);
        assert.equal(await evaluate("document.getElementById('prompt-agent-search-enabled').checked"), true);
        assert.equal(await evaluate("document.querySelector('.prompt-agent-thinking-menu .thinking-control-status').textContent"), '');
        await send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape' });
        await evaluate("document.getElementById('prompt-agent-model').parentElement.querySelector('.thinking-control > summary').click()");
        await waitFor("!!document.querySelector('.prompt-agent-thinking-menu')");
        assert.equal(await evaluate("document.getElementById('prompt-agent-search-enabled').checked"), true);
        await send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
        const reduced = await evaluate(`(async()=>{const input=document.getElementById('prompt-agent-search-enabled'),slider=input.nextElementSibling;
            const position=()=>new DOMMatrix(getComputedStyle(slider,'::before').transform).m41;
            const duration=getComputedStyle(slider,'::before').transitionDuration;
            input.closest('label').click();await new Promise(resolve=>setTimeout(resolve,60));
            const style=getComputedStyle(slider,'::before');
            return {duration,middle:position(),thumbCenter:parseFloat(style.top)+parseFloat(style.height)/2+new DOMMatrix(style.transform).m42,trackCenter:slider.getBoundingClientRect().height/2};})()`);
        assert.ok(parseFloat(reduced.duration)>=0.28 && reduced.middle>0 && reduced.middle<16,
            'reduced-motion setting should still show a short functional state change: '+JSON.stringify(reduced));
        assert.ok(Math.abs(reduced.thumbCenter-reduced.trackCenter)<0.25,
            'moving thumb should remain vertically centered: '+JSON.stringify(reduced));
        assert.equal(await evaluate("!!document.getElementById('prompt-agent-search-model')"), false);
        const disabled = await evaluate(`(async()=>{
            const {createAgentSearchMenu}=await import('/js/features/prompt-agent/prompt-agent-search-ui.js');
            const input=document.getElementById('prompt-agent-search-enabled');
            const adapter=createAgentSearchMenu({documentRef:document,getSettings:()=>({mode:'auto'}),getCurrentModel:()=>({protocol:'openai',agentSearch:'none'})});
            return {checked:input.checked,disabled:input.disabled};
        })()`);
        assert.deepEqual(disabled, {checked:true,disabled:false});
    });
});
