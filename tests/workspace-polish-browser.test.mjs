import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('workflow title follows edits and explicit saving while zoom presets stay accessible', { timeout: 60000 }, async () => {
    await withAppBrowser({ models: [{ id: 'chat', modelId: 'chat', name: '示例对话模型', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', name: '示例服务', endpoint: 'https://example.test/v1', apikey: 'test' }] }, async ({ evaluate, send, waitFor }) => {
        await waitFor("window.__cainflowAppReady === true");
        await evaluate("document.body.classList.add('toolbar-pinned')");
        await waitFor("document.getElementById('toolbar-workflow-name').textContent !== '未打开工作流'");
        const name = await evaluate("document.getElementById('toolbar-workflow-name').textContent");
        assert.ok(name);
        await evaluate("document.getElementById('canvas-container').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:360,clientY:180})); document.getElementById('context-menu-search-nodes').click()");
        await evaluate("document.querySelector('.node-picker-result[data-type=TextChat]').click()");
        await waitFor("Boolean(document.querySelector('#nodes-layer .node textarea[id$=\"-prompt\"]'))");
        await waitFor("document.getElementById('toolbar-workflow-status').dataset.state === 'modified'");
        await evaluate("document.getElementById('btn-save').click()");
        await waitFor("document.getElementById('toolbar-workflow-status').dataset.state === 'saved'");
        await evaluate("const prompt=document.querySelector('#nodes-layer textarea[id$=\"-prompt\"]'); prompt.value='为新的创作整理灵感与提示词'; prompt.dispatchEvent(new Event('input',{bubbles:true}))");
        await waitFor("document.getElementById('toolbar-workflow-status').dataset.state === 'modified'");
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-name').textContent"), name);
        await evaluate("document.getElementById('btn-save').click()");
        await waitFor("document.getElementById('toolbar-workflow-status').dataset.state === 'saved'");
        await evaluate("document.getElementById('btn-toggle-workflow').click()");
        await waitFor("Boolean(document.querySelector('.workflow-item.is-active'))");
        await evaluate("document.querySelector('.workflow-item.is-active').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:220})); document.getElementById('menu-rename-workflow').click()");
        await waitFor("Boolean(document.getElementById('workflow-rename-input'))");
        await evaluate("document.getElementById('workflow-rename-input').value='UI体验优化'; document.querySelector('#workflow-rename-dialog [data-dialog-style-1-action=confirm]').click()");
        await waitFor("document.getElementById('toolbar-workflow-name').textContent === 'UI体验优化'");
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-status').dataset.state"), 'saved');
        await evaluate("document.getElementById('btn-close-workflow').click()");
        for (const [width, height] of [[1424, 900], [480, 720], [320, 240]]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            await evaluate("document.querySelector('.canvas-zoom-menu summary').click()");
            await waitFor("document.querySelector('.canvas-zoom-menu').open");
            if (width === 1424) {
                await send('Emulation.setDeviceMetricsOverride', { width: 480, height: 200, deviceScaleFactor: 1, mobile: false });
                await waitFor("document.querySelector('.canvas-zoom-options').getBoundingClientRect().top >= 0");
                assert.equal(await evaluate("document.querySelector('.canvas-zoom-menu').open"), true);
                await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            }
            assert.equal(await evaluate("(() => { const r=document.querySelector('.canvas-zoom-options').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight; })()"), true, `zoom menu bounds at ${width}x${height}`);
            await evaluate("document.querySelector('.canvas-zoom-options [data-zoom=\"0.5\"]').click()");
            assert.equal(await evaluate("document.getElementById('zoom-level').textContent"), '50%');
            assert.equal(await evaluate("document.querySelector('.canvas-zoom-menu').open"), false);
        }
        if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
            await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR, { recursive: true });
            await send('Emulation.setDeviceMetricsOverride', { width: 1424, height: 900, deviceScaleFactor: 1, mobile: false });
            for (const theme of ['dark', 'paper']) {
                await evaluate(`document.querySelector('.canvas-zoom-menu summary').click(); document.querySelector('[data-zoom="1"]').click(); document.getElementById('btn-settings').click(); document.querySelector('.modal-tab-btn[data-tab=general]').click(); document.getElementById('btn-theme-toggle').click(); document.querySelector('#theme-menu [data-theme-id="${theme}"]').click(); document.getElementById('settings-close').click()`);
                await new Promise(resolve => setTimeout(resolve, 350));
                const shot = await send('Page.captureScreenshot', { format: 'png' });
                await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, `workspace-${theme}.png`), Buffer.from(shot.data, 'base64'));
            }
            await evaluate("document.getElementById('btn-settings').click(); document.querySelector('.modal-tab-btn[data-tab=general]').click()");
            for (const category of ['canvas', 'generation']) {
                await evaluate(`document.querySelector('[data-settings-category="${category}"]').click()`);
                await new Promise(resolve => setTimeout(resolve, 150));
                const shot = await send('Page.captureScreenshot', { format: 'png' });
                await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, `settings-${category}-paper.png`), Buffer.from(shot.data, 'base64'));
            }
        }
    });
});
