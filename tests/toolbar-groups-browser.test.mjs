import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('canvas toolbar keeps action groups together across themes and wrapped widths', { timeout: 60000 }, async () => {
    await withAppBrowser({ models: [
        { id: 'chat', modelId: 'chat', name: '布局测试', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }
    ], providers: [{ id: 'p', name: '测试', endpoint: 'https://example.test/v1', apikey: 'test' }] }, async ({ evaluate, send }) => {
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
                if (width === 1100) assert.ok(layout[3].top > layout[0].top, `${theme} should wrap a complete group`);
            }
        }

        await evaluate("document.querySelector('#toolbar-workflow-more summary').click()");
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-more').open"), true);
        assert.equal(await evaluate("document.getElementById('btn-clear').getClientRects().length > 0"), true);
        await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-more').open"), false);
        await evaluate("document.querySelector('#toolbar-workflow-more summary').click(); document.body.click()");
        assert.equal(await evaluate("document.getElementById('toolbar-workflow-more').open"), false);
        await evaluate("document.body.classList.add('workspace-mode-conversation')");
        assert.equal(await evaluate("[...document.querySelectorAll('#toolbar .toolbar-action-group')].every(group => getComputedStyle(group).display === 'none')"), true);
    });
});
