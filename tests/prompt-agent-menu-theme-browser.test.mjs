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
            assert.equal(geometry.height,18,`${theme} switch track height`);
            assert.equal(geometry.width,30,`${theme} switch track width`);
            assert.equal(geometry.thumbCenter,geometry.height/2,`${theme} thumb vertically centered`);

        }
        await send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
        await evaluate("document.documentElement.classList.add('animations-disabled')");
        await delay(250);
        const animated = await evaluate(`(async()=>{
            const input=document.getElementById('prompt-agent-search-enabled');
            const slider=input.nextElementSibling;const x=()=>new DOMMatrix(getComputedStyle(slider,'::before').transform).m41;
            const start=x();input.click();await new Promise(resolve=>setTimeout(resolve,60));
            return {start,middle:x(),focused:input.isConnected,duration:getComputedStyle(slider,'::before').transitionDuration,property:getComputedStyle(slider,'::before').transitionProperty,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches};
        })()`);
        assert.equal(animated.start,12);
        assert.equal(await evaluate("document.getElementById('prompt-agent-search-availability')"), null);
        assert.ok(animated.middle>0&&animated.middle<12, 'switch must visibly animate between its positions: '+JSON.stringify(animated));
        assert.equal(await evaluate("document.getElementById('prompt-agent-search-enabled').checked"), false);
        assert.equal(await evaluate("document.querySelector('.prompt-agent-thinking-menu .thinking-control-status').textContent"), '');
        await send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape' });
        await evaluate("document.getElementById('prompt-agent-model').parentElement.querySelector('.thinking-control > summary').click()");
        await waitFor("!!document.querySelector('.prompt-agent-thinking-menu')");
        assert.equal(await evaluate("document.getElementById('prompt-agent-search-enabled').checked"), false);
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
