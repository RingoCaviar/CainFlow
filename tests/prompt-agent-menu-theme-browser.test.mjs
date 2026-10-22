import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';
import { parseColor, composite, contrastRatio } from './helpers/browser-theme-fixture.mjs';

const themes = ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink'];
test('Agent network select shares themed menus and preserves parent, keyboard and settings contracts', { timeout: 60000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, models: [{ id: 'chat', modelId: 'test', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }], providers: [{ id: 'p', name: 'Controlled', endpoint: 'https://controlled.test/v1', apikey: 'test' }] }, async ({ evaluate, send }) => {
        await send('Emulation.setDeviceMetricsOverride', { width: 640, height: 720, deviceScaleFactor: 1, mobile: false });
        await delay(250);
        await evaluate(`document.getElementById('btn-prompt-agent').click(); document.getElementById('prompt-agent-panel').style.width='300px'; document.getElementById('prompt-agent-search-button').click()`);
        assert.ok(await evaluate(`Boolean(document.querySelector('#prompt-agent-search-mode + .prompt-agent-model-trigger'))`), 'network mode must use the shared themed select instead of an OS popup');
        await evaluate(`window.modeChanges=0; document.getElementById('prompt-agent-search-mode').addEventListener('change',()=>modeChanges++); document.querySelector('#prompt-agent-search-mode + button').click()`);
        for (const theme of themes) {
            await evaluate(`document.documentElement.dataset.appTheme='${theme}'`); await delay(200);
            const rows = await evaluate(`(()=>{const menu=document.getElementById('prompt-agent-search-mode-menu'); return [...menu.querySelectorAll('button')].map(e=>{const s=getComputedStyle(e),m=getComputedStyle(menu);return {color:s.color,bg:s.backgroundColor,surface:m.backgroundColor,image:m.backgroundImage,canvas:getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas'), outline:s.outlineColor,focused:e===document.activeElement,rect:menu.getBoundingClientRect().toJSON(),hit:e.contains(document.elementFromPoint(e.getBoundingClientRect().x+10,e.getBoundingClientRect().y+10))};});})()`);
            assert.equal(rows.length, 2);
            for (const row of rows) {
                let surface = composite(parseColor(row.surface), parseColor(row.canvas));
                const overlay = row.image.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/)?.[0];
                if (overlay) surface = composite(parseColor(overlay), surface);
                const bg = composite(parseColor(row.bg), surface);
                assert.ok(contrastRatio(parseColor(row.color), bg) >= 4.5, `${theme} option text`);
                if (row.focused) assert.ok(contrastRatio(parseColor(row.outline), bg) >= 3, `${theme} focus ring`);
                assert.ok(row.hit, `${theme} click target`);
                assert.ok(row.rect.left >= 0 && row.rect.right <= 640 && row.rect.top >= 0 && row.rect.bottom <= 720);
            }
            if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
                await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR, { recursive: true });
                const shot = await send('Page.captureScreenshot', { format: 'png' });
                await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, `network-${theme}.png`), Buffer.from(shot.data, 'base64'));
            }
        }
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' });
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
        assert.deepEqual(await evaluate(`({value:document.getElementById('prompt-agent-search-mode').value,changes:modeChanges,parent:!document.getElementById('prompt-agent-search-menu').hidden,disabled:document.querySelector('#prompt-agent-search-model + button').disabled})`), { value: 'off', changes: 1, parent: true, disabled: true });
        await evaluate(`document.querySelector('#prompt-agent-search-mode + button').click()`);
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        assert.ok(await evaluate(`!document.getElementById('prompt-agent-search-mode-menu') && !document.getElementById('prompt-agent-search-menu').hidden && document.activeElement===document.querySelector('#prompt-agent-search-mode + button')`));
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        assert.ok(await evaluate(`document.getElementById('prompt-agent-search-menu').hidden`));
        assert.equal(await evaluate('modeChanges'), 1);
        const lifecycle = await evaluate(`(async()=>{
            const {createPromptAgentModelMenus}=await import('/js/features/prompt-agent/prompt-agent-model-menu.js');
            const select=document.createElement('select'); select.id='qa-step-model'; select.setAttribute('aria-label','步骤模型'); select.innerHTML='<option value="">继承面板模型</option><option value="b">第二个模型</option>'; document.body.append(select);
            let changes=0; select.addEventListener('change',()=>changes++);
            const adapter=createPromptAgentModelMenus({documentRef:document,selects:[select],placeholder:'请选择'});
            select.value='b'; adapter.refresh(); const restored=select.nextElementSibling.textContent==='第二个模型'&&changes===0;
            select.nextElementSibling.click(); select.options[1].disabled=true; await new Promise(r=>setTimeout(r,0));
            const invalid=!document.getElementById('qa-step-model-menu')&&select.value==='b';
            select.disabled=true; adapter.refresh(); const disabled=select.nextElementSibling.disabled;
            select.disabled=false; adapter.refresh(); select.nextElementSibling.click(); adapter.destroy();
            const destroyed=!document.getElementById('qa-step-model-menu')&&!select.classList.contains('prompt-agent-model-native')&&!select.hasAttribute('aria-hidden')&&!select.hasAttribute('tabindex');
            select.remove(); return {restored,invalid,disabled,destroyed,changes};
        })()`);
        assert.deepEqual(lifecycle, { restored: true, invalid: true, disabled: true, destroyed: true, changes: 0 });
    });
});

