import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';
import { parseColor, composite, contrastRatio } from './helpers/browser-theme-fixture.mjs';

const themes = ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink'];

test('unchanged Agent model refresh preserves native options and labels while real configuration changes remain visible', { timeout: 30000 }, async () => {
    const image = { id: 'image-a', modelId: 'gpt-image-1', name: '图片甲', protocol: 'openai', taskType: 'image', providerIds: ['p', 'q'] };
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', name: '对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }, image],
        providers: [
            { id: 'p', name: '供应商甲', endpoint: 'https://controlled.test/v1', apikey: 'test' },
            { id: 'q', name: '供应商乙', endpoint: 'https://controlled.test/v1', apikey: 'test' }
        ],
        nodes: [{ id: 'unrelated-a', type: 'Text', x: 80, y: 80, text: '甲' }, { id: 'unrelated-b', type: 'Text', x: 400, y: 80, text: '乙' }],
        connections: []
    }, async app => {
        await app.evaluate(`(async () => {
            const { state, registry } = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
            const controller = registry.promptAgentController;
            const select = document.getElementById('prompt-agent-image-model');
            select.value = 'image-a'; select.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const trigger = select.nextElementSibling;
            const mutations = [];
            const observer = new MutationObserver(records => mutations.push(...records.map(record => record.type + ':' + (record.attributeName || 'children'))));
            for (const element of [select, trigger, document.getElementById('prompt-agent-image-model-hint'),
                document.getElementById('prompt-agent-image-model-status'), document.getElementById('prompt-agent-add-image-model')]) {
                observer.observe(element, { subtree: true, childList: true, attributes: true, characterData: true });
            }
            window.modelRefresh = { state, controller, select, trigger, mutations, observer, options: [...select.options], label: trigger.textContent };
        })()`);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-panel').classList.contains('active')"), false);
        await app.evaluate(`(async () => {
            for (const id of ['unrelated-a', 'unrelated-b']) {
                const header = document.querySelector('#' + id + ' .node-header'), rect = header.getBoundingClientRect();
                const point = { bubbles: true, cancelable: true, button: 0, clientX: rect.left + 25, clientY: rect.top + rect.height / 2 };
                header.dispatchEvent(new MouseEvent('mousedown', { ...point, buttons: 1 }));
                document.dispatchEvent(new MouseEvent('mouseup', { ...point, buttons: 0 }));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }
            modelRefresh.controller.refreshActionStates();
            modelRefresh.controller.refreshActionStates();
            await Promise.resolve();
        })()`);
        assert.deepEqual(await app.evaluate(`({
            stableOptions: modelRefresh.select.options.length === modelRefresh.options.length &&
                [...modelRefresh.select.options].every((option, index) => option === modelRefresh.options[index]),
            label: modelRefresh.trigger.textContent,
            originalLabel: modelRefresh.label,
            mutations: modelRefresh.mutations,
            selectedNode: [...modelRefresh.state.selectedNodes][0]
        })`), {
            stableOptions: true, label: '图片甲 · 供应商甲', originalLabel: '图片甲 · 供应商甲', mutations: [], selectedNode: 'unrelated-b'
        });

        await app.evaluate(`(() => {
            document.getElementById('btn-prompt-agent').click();
            modelRefresh.trigger.click();
            const menu = document.getElementById(modelRefresh.select.id + '-menu');
            const search = menu.querySelector('input[type="search"]');
            search.value = '供应商甲';
            search.dispatchEvent(new Event('input', { bubbles: true }));
            const mutations = [];
            const observer = new MutationObserver(records => mutations.push(...records.map(record => record.type)));
            observer.observe(menu, { subtree: true, childList: true, attributes: true, characterData: true });
            observer.observe(modelRefresh.trigger, { subtree: true, childList: true, attributes: true });
            modelRefresh.open = { menu, search, mutations, observer };
            modelRefresh.controller.refreshActionStates();
            modelRefresh.controller.refreshModels();
        })()`);
        assert.deepEqual(await app.evaluate(`({
            sameMenu: document.getElementById(modelRefresh.select.id + '-menu') === modelRefresh.open.menu,
            query: modelRefresh.open.search.value,
            focused: document.activeElement === modelRefresh.open.search,
            mutations: modelRefresh.open.mutations
        })`), { sameMenu: true, query: '供应商甲', focused: true, mutations: [] },
        'an unchanged refresh preserves an open menu, its search and focus without DOM writes');
        await app.evaluate('modelRefresh.open.observer.disconnect()');

        await app.evaluate(`(() => {
            const { controller, state } = modelRefresh;
            state.models.push({ ...state.models.find(model => model.id === 'image-a'), id: 'image-b', name: '图片乙' });
            controller.refreshModels();
        })()`);
        assert.equal(await app.evaluate("document.getElementById(modelRefresh.select.id + '-menu') === null"), true,
            'changed options invalidate the open list instead of offering stale choices');
        assert.deepEqual(await app.evaluate('[...modelRefresh.select.options].map(option => option.value)'), ['', 'image-a', 'image-b']);
        await app.evaluate(`(() => {
            const { controller, select } = modelRefresh;
            modelRefresh.options = [...select.options];
            controller.syncWorkflowState({ ...controller.snapshotWorkflow(), imageModelId: 'image-b' });
        })()`);
        assert.deepEqual(await app.evaluate(`({ value: modelRefresh.select.value, label: modelRefresh.trigger.textContent,
            stableOptions: [...modelRefresh.select.options].every((option, index) => option === modelRefresh.options[index]) })`),
        { value: 'image-b', label: '图片乙 · 供应商甲', stableOptions: true });

        await app.evaluate(`(() => {
            const { controller } = modelRefresh, snapshot = controller.snapshotWorkflow();
            controller.syncWorkflowState({ ...snapshot, providerSettings: { ...snapshot.providerSettings,
                image: { ...snapshot.providerSettings.image, 'image-b': 'q' } } });
        })()`);
        assert.equal(await app.evaluate('modelRefresh.trigger.textContent'), '图片乙 · 供应商乙',
            'a provider-only change updates the trigger without rebuilding native options');
        assert.equal(await app.evaluate('[...modelRefresh.select.options].every((option, index) => option === modelRefresh.options[index])'), true);

        await app.evaluate(`modelRefresh.state.models = modelRefresh.state.models.filter(model => model.taskType !== 'image'); modelRefresh.controller.refreshModels()`);
        assert.deepEqual(await app.evaluate('({value:modelRefresh.select.value,disabled:modelRefresh.select.disabled,triggerDisabled:modelRefresh.trigger.disabled})'),
            { value: 'image-b', disabled: true, triggerDisabled: true });
        assert.match(await app.evaluate("document.getElementById('prompt-agent-image-model-status').textContent"), /不可用/);
        await app.evaluate('modelRefresh.observer.disconnect()');
    });
});

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
