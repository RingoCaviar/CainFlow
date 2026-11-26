import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('text context menu edits and copies text across modals and modeless editors', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [], connections: [] }, async app => {
        const origin = await app.evaluate('location.origin');
        await app.send('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
        await app.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        const menu = "document.querySelector('.text-context-menu')";
        const action = name => app.evaluate(`[...${menu}.querySelectorAll('button')].find(button => button.textContent === '${name}').click()`);
        const open = async selector => {
            const point = await app.evaluate(`(() => {
                const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
                return { x: rect.right - 2, y: rect.top + rect.height / 2 };
            })()`);
            await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'right', buttons: 2, clickCount: 1 });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'right', buttons: 0, clickCount: 1 });
        };
        const press = async (key, windowsVirtualKeyCode, modifiers = 0) => {
            await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode, modifiers });
            await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode, modifiers });
        };
        await app.evaluate(`(() => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.innerHTML = '<div class="modal-content"><input id="menu-field" value="alpha beta"><input id="menu-password" type="password" value="hidden"><input id="menu-number" type="number" value="3"><div id="menu-output" style="user-select:text">copyable report</div></div>';
            document.body.append(overlay);
            const field = document.querySelector('#menu-field');
            window.menuInputEvents = 0;
            field.addEventListener('input', () => window.menuInputEvents++);
            field.focus();
            field.setSelectionRange(6, 10);
        })()`);
        await open('#menu-field');
        assert.equal(await app.evaluate(`${menu}?.getAttribute('role')`), 'menu');
        assert.equal(await app.evaluate('document.activeElement.id'), 'menu-field');
        assert.equal(await app.evaluate(`(() => {
            const rect = ${menu}.getBoundingClientRect();
            const item = ${menu}.querySelector('button').getBoundingClientRect();
            return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
                && ${menu}.contains(document.elementFromPoint(item.x + item.width / 2, item.y + item.height / 2));
        })()`), true);
        await action('复制');
        assert.equal(await app.evaluate('navigator.clipboard.readText()'), 'beta');
        await open('#menu-field');
        await action('剪切');
        await app.waitFor("document.querySelector('#menu-field').value === 'alpha '");
        await app.evaluate("navigator.clipboard.writeText('替换')");
        await open('#menu-field');
        await action('粘贴');
        await app.waitFor("document.querySelector('#menu-field').value === 'alpha 替换'");
        assert.equal(await app.evaluate('window.menuInputEvents'), 2);

        await open('#menu-password');
        assert.deepEqual(await app.evaluate(`[...${menu}.querySelectorAll('button')].map(button => button.textContent)`), ['粘贴', '全选']);
        await action('全选');
        assert.equal(await app.evaluate("document.querySelector('#menu-password').selectionEnd"), 6);

        await open('#menu-number');
        await action('全选');
        await app.evaluate("navigator.clipboard.writeText('42')");
        await press('F10', 121, 8);
        await action('粘贴');
        await app.waitFor("document.querySelector('#menu-number').value === '42'");

        await app.evaluate("getSelection().selectAllChildren(document.querySelector('#menu-output'))");
        // Invoke inside the selected report text so the native right-click preserves it.
        await app.evaluate(`document.querySelector('#menu-output').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
        await action('复制');
        assert.equal(await app.evaluate('navigator.clipboard.readText()'), 'copyable report');

        await app.evaluate("document.querySelector('#menu-field').closest('.modal-overlay').remove(); document.querySelector('#btn-prompt-agent').click()");
        await app.waitFor("document.querySelector('#prompt-agent-panel').classList.contains('active')");
        await app.evaluate("document.querySelector('#prompt-agent-input').focus()");
        await press('F10', 121, 8);
        assert.equal(await app.evaluate(`${menu}.querySelector('.is-focused').textContent`), '粘贴');
        await press('ArrowDown', 40);
        assert.equal(await app.evaluate(`${menu}.querySelector('.is-focused').textContent`), '全选');
        await press('Escape', 27);
        assert.equal(await app.evaluate(`Boolean(${menu})`), false);
        assert.equal(await app.evaluate("document.querySelector('#prompt-agent-panel').classList.contains('active')"), true);
    });
});
