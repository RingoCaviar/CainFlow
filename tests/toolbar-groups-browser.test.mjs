import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('canvas toolbar keeps action groups together across themes and wrapped widths', { timeout: 60000 }, async () => {
    await withAppBrowser({ models: [
        { id: 'chat', modelId: 'chat', name: '布局测试', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }
    ], providers: [{ id: 'p', name: '测试', endpoint: 'https://example.test/v1', apikey: 'test' }] }, async ({ evaluate, send, waitFor }) => {
        await evaluate("document.body.classList.add('toolbar-pinned')");
        for (const theme of ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink']) {
            await evaluate(`document.documentElement.dataset.appTheme = '${theme}'`);
            for (const width of [1424, 1100, 700, 480]) {
                await send('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false });
                const layout = await evaluate(`(() => {
                    const groups = [...document.querySelectorAll('#toolbar .toolbar-action-group')];
                    return groups.map(group => {
                        const groupRect = group.getBoundingClientRect();
                        const children = [...group.children].filter(child => child.tagName !== 'INPUT');
                        return { left: groupRect.left, right: groupRect.right, top: groupRect.top,
                            childRows: [...new Set(children.map(child => Math.round(child.getBoundingClientRect().top)))] };
                    });
                })()`);
                assert.equal(layout.length, 4);
                if (width > 520) assert.ok(layout.every(group => group.childRows.length === 1), `${theme} at ${width}px split a group`);
                assert.ok(layout.every(group => group.left >= 0 && group.right <= width + 1), `${theme} at ${width}px overflows`);
                assert.ok(layout.every((group, index) => index === 0 || group.top >= layout[index - 1].top), `${theme} at ${width}px reordered groups`);
                if (width === 1100) assert.ok(layout.every(group => group.top === layout[0].top), `${theme} should fit the unified toolbar on one row`);
                if (width === 480) assert.ok(layout[3].top > layout[0].top, `${theme} should wrap a complete group`);
            }
        }

        assert.equal(await evaluate("document.querySelector('#side-bar, #btn-undo, #btn-redo') === null"), true);
        assert.equal(await evaluate("document.querySelector('#toolbar #toggle-retry, #toolbar #toggle-notifications, #toolbar #btn-theme-toggle') === null"), true);
        for (const id of ['btn-toggle-workflow', 'btn-run', 'btn-stop', 'btn-save', 'btn-history', 'btn-prompt-agent', 'btn-settings']) {
            assert.equal(await evaluate(`Boolean(document.querySelector('#toolbar > .toolbar-action-group > #${id}'))`), true, `${id} must remain directly accessible`);
        }
        await evaluate("document.querySelector('#toolbar-workflow-more summary').click()");
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-more').open"), true);
        assert.equal(await evaluate("document.getElementById('btn-clear').getClientRects().length > 0"), true);
        assert.equal(await evaluate(`(() => {
            const menu = document.querySelector('.toolbar-more-menu').getBoundingClientRect();
            return menu.left >= 0 && menu.right <= innerWidth && menu.bottom <= innerHeight;
        })()`), true);
        await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-more').open"), false);
        await evaluate("document.querySelector('#toolbar-workflow-more summary').click(); document.body.click()");
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-more').open"), false);
        await evaluate("document.querySelector('#toolbar-workflow-more summary').click(); document.getElementById('btn-help').click()");
        assert.equal(await evaluate("document.getElementById('help-panel').classList.contains('active')"), true);
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-more').open"), false);
        await waitFor("getComputedStyle(document.getElementById('help-panel')).left === '0px'");
        assert.equal(await evaluate("getComputedStyle(document.getElementById('help-panel')).left"), '0px');
        assert.equal(await evaluate("parseFloat(getComputedStyle(document.getElementById('floating-notices-container')).left) >= document.getElementById('help-panel').offsetWidth"), true);
        await evaluate("document.querySelector('#toolbar-workflow-more summary').click(); document.querySelector('#toolbar-workflow-more summary').focus(); document.querySelector('#toolbar-workflow-more summary').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-more').open"), false);
        assert.equal(await evaluate("document.getElementById('help-panel').classList.contains('active')"), true, 'Escape should dismiss More before the drawer behind it');
        await evaluate("document.getElementById('btn-close-help').click()");
        await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 240, deviceScaleFactor: 1, mobile: false });
        assert.equal(await evaluate(`(() => {
            const trigger = document.querySelector('#toolbar-workflow-more summary');
            const rect = trigger.getBoundingClientRect();
            return trigger.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        })()`), true, 'canvas navigation must not cover the toolbar in a short window');
        await evaluate("document.querySelector('#toolbar-workflow-more summary').click()");
        assert.equal(await evaluate(`(() => {
            const menu = document.querySelector('.toolbar-more-menu');
            const rect = menu.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && menu.clientHeight >= 100;
        })()`), true, 'a short window must have a usable scrollable menu');
        await evaluate("document.querySelector('.toolbar-more-menu').scrollTop = 10000; document.getElementById('btn-clear').focus()");
        assert.equal(await evaluate("document.activeElement.id"), 'btn-clear');
        await evaluate("document.getElementById('toolbar-workflow-more').open = false");
        await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
        await evaluate("document.getElementById('btn-settings').click(); document.querySelector('[data-tab=general]').click()");
        assert.equal(await evaluate("document.querySelector('#settings-tab-general #btn-theme-toggle').getClientRects().length > 0"), true);
        assert.equal(await evaluate("Boolean(document.querySelector('#settings-tab-general #toggle-retry')) && Boolean(document.querySelector('#settings-tab-general #toggle-notifications'))"), true);
        assert.equal(await evaluate("document.getElementById('setting-sidebar-pinned') === null"), true);
        await evaluate("document.getElementById('btn-theme-toggle').click()");
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(await evaluate("!document.getElementById('theme-menu').closest('[inert]') && !document.getElementById('theme-menu').classList.contains('hidden')"), true);
        assert.equal(await evaluate("Number(getComputedStyle(document.getElementById('theme-menu')).zIndex) > Number(getComputedStyle(document.getElementById('settings-modal')).zIndex)"), true);
        await evaluate("document.querySelector('[data-theme-id=paper]').click()");
        assert.equal(await evaluate("document.documentElement.dataset.appTheme"), 'paper');
        await evaluate("document.getElementById('settings-close').click()");
        await evaluate("document.body.classList.add('workspace-mode-conversation')");
        assert.equal(await evaluate("[...document.querySelectorAll('#toolbar .toolbar-action-group')].every(group => getComputedStyle(group).display === 'none')"), true);
    });
});
