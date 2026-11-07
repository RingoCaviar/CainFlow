import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

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
        assert.equal(await evaluate("document.querySelector('#toolbar #toggle-retry, #toolbar #toggle-notifications') === null"), true);
        assert.equal(await evaluate(`(() => {
            const theme = document.getElementById('btn-theme-toggle').closest('.theme-menu-shell');
            return document.querySelectorAll('#btn-theme-toggle').length === 1
                && theme.parentElement.classList.contains('toolbar-global-group')
                && theme.previousElementSibling.id === 'toolbar-workflow-more'
                && theme.nextElementSibling.id === 'btn-settings';
        })()`), true, 'theme selection stays directly between More and Settings');
        for (const id of ['btn-toggle-workflow', 'btn-run', 'btn-stop', 'btn-history', 'btn-prompt-agent', 'btn-settings']) {
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
        await waitFor("Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toolbar-height'))-document.getElementById('toolbar').offsetHeight)<1");
        const shortWindowHit = await evaluate(`(() => {
            const trigger = document.querySelector('#toolbar-workflow-more summary');
            const rect = trigger.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return { reachable: trigger.contains(hit), trigger: rect.toJSON(), hitId: hit?.id, hitClass: hit?.className,
                hitAction: hit?.closest('[data-parameter-action]')?.dataset.parameterAction,
                toolbar: document.getElementById('toolbar').getBoundingClientRect().toJSON(),
                navigation: document.getElementById('canvas-navigation').getBoundingClientRect().toJSON(),
                switcher: document.querySelector('.image-panel-switcher')?.getBoundingClientRect().toJSON() };
        })()`);
        assert.equal(shortWindowHit.reachable, true, `floating canvas controls must not cover the toolbar in a short window: ${JSON.stringify(shortWindowHit)}`);
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
        assert.equal(await evaluate("document.querySelector('#settings-tab-general #btn-theme-toggle') === null"), true);
        assert.equal(await evaluate("Boolean(document.querySelector('#settings-tab-general #toggle-retry')) && Boolean(document.querySelector('#settings-tab-general #toggle-notifications'))"), true);
        assert.equal(await evaluate("document.getElementById('setting-sidebar-pinned') === null"), true);
        await evaluate("document.getElementById('settings-close').click(); document.getElementById('btn-theme-toggle').click()");
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(await evaluate("!document.getElementById('theme-menu').closest('[inert]') && !document.getElementById('theme-menu').classList.contains('hidden')"), true);
        await evaluate("document.querySelector('#theme-menu [data-theme-id=paper]').click()");
        assert.equal(await evaluate("document.documentElement.dataset.appTheme"), 'paper');
        await evaluate("document.body.classList.add('workspace-mode-conversation')");
        assert.equal(await evaluate("[...document.querySelectorAll('#toolbar .toolbar-action-group')].every(group => getComputedStyle(group).display === 'none')"), true);
    });
});

test('toolbar themes switch directly, remain reachable, and preserve the selected theme after reload', { timeout: 45000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, themeId: 'paper',
        nodes: [{ id: 'theme-note', type: 'Text', x: 160, y: 260, text: '保留画布内容' }], connections: []
    }, async app => {
        const { evaluate, send, waitFor } = app;
        const themes = [['dark', '深色'], ['pro', '专业深色'], ['paper', '纸张'], ['light', '浅色'],
            ['glass-light', '浅色玻璃'], ['glass-dark', '深色玻璃'], ['pink', '粉色']];
        const key = async (key, code, windowsVirtualKeyCode) => {
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
                ...(key === 'Enter' ? { text: '\r' } : {}) });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
        };
        await evaluate("document.body.classList.add('toolbar-pinned')");
        const widths = [];
        for (const [id, label] of themes) {
            await evaluate("document.getElementById('btn-theme-toggle').click()");
            assert.deepEqual(await evaluate("[...document.querySelectorAll('#theme-menu [role=menuitemradio]')].map(item=>item.dataset.themeId)"), themes.map(([id]) => id));
            assert.equal(await evaluate(`(() => {
                const items = [...document.querySelectorAll('#theme-menu [role=menuitemradio]')];
                return items.every(item => {
                    const swatch = item.querySelector('.theme-menu-swatch');
                    return !swatch;
                }) && items.filter(item => item.getAttribute('aria-checked') === 'true').length === 1;
            })()`), true, 'theme names have no decorative swatches and exactly one theme is checked');
            await evaluate(`document.querySelector('#theme-menu [data-theme-id="${id}"]').click()`);
            assert.deepEqual(await evaluate(`({theme:document.documentElement.dataset.appTheme,
                label:document.querySelector('#btn-theme-toggle [data-role=theme-toggle-label]').textContent.trim(),
                closed:document.getElementById('theme-menu').classList.contains('hidden'),
                expanded:document.getElementById('btn-theme-toggle').getAttribute('aria-expanded'),
                checked:[...document.querySelectorAll('#theme-menu [aria-checked=true]')].map(item=>item.dataset.themeId)})`),
                { theme: id, label, closed: true, expanded: 'false', checked: [id] });
            const size = await evaluate(`(() => {
                const button=document.getElementById('btn-theme-toggle').getBoundingClientRect();
                const settings=document.getElementById('btn-settings').getBoundingClientRect();
                return {width:button.width,height:button.height,settingsHeight:settings.height};
            })()`);
            assert.equal(size.height, size.settingsHeight, `${id} theme control matches its neighbors`);
            assert.ok(size.width < 144, `${id} theme control removes the former oversized settings width`);
            widths.push(size.width);
        }
        assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, 'switching names does not shift neighboring toolbar controls');

        await evaluate("document.getElementById('btn-theme-toggle').click(); document.body.classList.remove('toolbar-pinned','toolbar-peek-active'); document.activeElement?.blur()");
        const menuPoint = await evaluate("(()=>{const r=document.querySelector('#theme-menu [data-theme-id=paper]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...menuPoint });
        await new Promise(resolve => setTimeout(resolve, 450));
        assert.equal(await evaluate("document.getElementById('toolbar').getBoundingClientRect().top >= -1 && !document.getElementById('theme-menu').classList.contains('hidden')"), true,
            'moving from the trigger into the open theme menu keeps the unpinned toolbar visible');
        await key('Escape', 'Escape', 27);
        assert.equal(await evaluate("document.activeElement.id"), 'btn-theme-toggle');
        assert.equal(await evaluate("document.getElementById('theme-menu').classList.contains('hidden')"), true);
        await key('ArrowDown', 'ArrowDown', 40);
        await waitFor("!document.getElementById('theme-menu').classList.contains('hidden') && document.activeElement.matches('#theme-menu [role=menuitemradio]')");
        await key('End', 'End', 35);
        assert.equal(await evaluate("document.activeElement.dataset.themeId"), 'pink');
        await key('Home', 'Home', 36);
        assert.equal(await evaluate("document.activeElement.dataset.themeId"), 'dark');
        await key('ArrowDown', 'ArrowDown', 40);
        assert.equal(await evaluate("document.activeElement.dataset.themeId"), 'pro');
        await key('Enter', 'Enter', 13);
        await waitFor("document.documentElement.dataset.appTheme==='pro' && document.getElementById('theme-menu').classList.contains('hidden')");
        await waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.themeId==='pro')");
        await reloadAppBrowser(app);
        assert.equal(await evaluate("document.documentElement.dataset.appTheme"), 'pro');
        assert.equal(await evaluate("document.querySelector('#btn-theme-toggle [data-role=theme-toggle-label]').textContent.trim()"), '专业深色');

        await evaluate("document.body.classList.add('toolbar-pinned')");
        for (const [width, height] of [[480, 720], [320, 240]]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            await evaluate("document.getElementById('btn-theme-toggle').click()");
            assert.equal(await evaluate(`(() => {
                const menu=document.getElementById('theme-menu'),r=menu.getBoundingClientRect();
                return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;
            })()`), true, `theme menu stays in the ${width}x${height} viewport`);
            await key('End', 'End', 35);
            assert.equal(await evaluate(`(() => {
                const item=document.activeElement,r=item.getBoundingClientRect();
                return item.dataset.themeId==='pink' && r.top>=0 && r.bottom<=innerHeight;
            })()`), true, 'the final theme remains reachable by keyboard in a short window');
            await key('Escape', 'Escape', 27);
        }
    });
});

test('focused theme controls isolate canvas shortcuts while the pointer remains over the canvas', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, themeId: 'paper',
        nodes: [
            { id: 'theme-selected', type: 'Text', x: 160, y: 260, text: '保持选中' },
            { id: 'theme-unselected', type: 'Text', x: 520, y: 260, text: '保持未选中' }
        ], connections: []
    }, async ({ evaluate, send, waitFor }) => {
        const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers,
                ...(key === 'Enter' ? { text: '\r' } : {}) });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
        };
        const assertCanvasUnchanged = async context => {
            assert.deepEqual(await evaluate(`({
                nodes: [...document.querySelectorAll('.node')].map(node => node.id).sort(),
                selected: [...document.querySelectorAll('.node.selected')].map(node => node.id)
            })`), { nodes: ['theme-selected', 'theme-unselected'], selected: ['theme-selected'] }, context);
        };
        const pressSpace = async context => {
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
            assert.equal(await evaluate("document.getElementById('canvas-container').classList.contains('space-pan-active')"), false,
                `${context}: holding Space does not start canvas panning`);
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
        };

        await evaluate("document.body.classList.add('toolbar-pinned')");
        const nodeCorner = await evaluate(`(() => {
            const rect = document.getElementById('theme-selected').getBoundingClientRect();
            return { x: rect.left, y: rect.top };
        })()`);
        // Select only the first node with a native marquee, then leave the
        // pointer on canvas while reaching the theme button with Shift+Tab.
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nodeCorner.x - 12, y: nodeCorner.y - 12,
            button: 'left', buttons: 1, clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodeCorner.x + 5, y: nodeCorner.y + 5, buttons: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nodeCorner.x + 5, y: nodeCorner.y + 5,
            button: 'left', buttons: 0, clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 880, y: 600 });
        await evaluate("document.getElementById('btn-settings').focus()");
        await key('Tab', 'Tab', 9, 8);
        assert.equal(await evaluate('document.activeElement.id'), 'btn-theme-toggle');
        await assertCanvasUnchanged('the fixture begins with exactly one selected node');

        await key('Delete', 'Delete', 46);
        await assertCanvasUnchanged('Delete on the theme button must not remove the selected node');
        await key('a', 'KeyA', 65, 2);
        await assertCanvasUnchanged('Ctrl+A on the theme button must not expand the canvas selection');
        await pressSpace('theme button');
        await waitFor("!document.getElementById('theme-menu').classList.contains('hidden') && document.activeElement.matches('#theme-menu [role=menuitemradio]')");

        await key('Delete', 'Delete', 46);
        await assertCanvasUnchanged('Delete in the theme menu must not remove the selected node');
        await key('a', 'KeyA', 65, 2);
        await assertCanvasUnchanged('Ctrl+A in the theme menu must not expand the canvas selection');
        await pressSpace('theme menu');
        await waitFor("document.getElementById('theme-menu').classList.contains('hidden') && document.activeElement.id==='btn-theme-toggle'");

        await key('ArrowDown', 'ArrowDown', 40);
        await key('End', 'End', 35);
        await key('ArrowUp', 'ArrowUp', 38);
        assert.equal(await evaluate('document.activeElement.dataset.themeId'), 'glass-dark');
        await key('Enter', 'Enter', 13);
        await waitFor("document.documentElement.dataset.appTheme==='glass-dark' && document.getElementById('theme-menu').classList.contains('hidden')");
        await assertCanvasUnchanged('normal keyboard theme selection still leaves the canvas intact');
    });
});
