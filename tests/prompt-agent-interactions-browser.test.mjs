import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser } from './helpers/app-browser.mjs';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';
test('Agent model menus, canvas dismissal and toolbar chrome coexist in all themes', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-interactions.html');
    assert.equal(result.error, undefined);
    assert.equal(Object.keys(result).length, 43);
    assert.ok(Object.values(result).every(value => value === true));
});

test('Agent popups expose valid controls and keep keyboard focus through attachment and request changes', { timeout: 30000 }, async () => {
    const session = {
        autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', name: '测试模型', protocol: 'openai', taskType: 'chat', providerIds: ['local'] }],
        providers: [{ id: 'local', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
    };
    await withAppBrowser(session, async ({ evaluate, send, waitFor }) => {
        const press = async (key, windowsVirtualKeyCode, extra = {}) => {
            const params = { key, code: key, windowsVirtualKeyCode, ...extra };
            await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
        };
        const focus = () => evaluate('document.activeElement.id');
        const ax = async () => (await send('Accessibility.getFullAXTree')).nodes;
        const property = (node, name) => node.properties?.find(item => item.name === name)?.value.value;
        await evaluate(`document.getElementById('btn-prompt-agent').click();
            document.getElementById('prompt-agent-add-reference').focus();`);
        await press('Enter', 13, { text: '\r' });
        assert.equal(await focus(), 'prompt-agent-tab-scene');
        assert.equal(await evaluate("document.getElementById('prompt-agent-reference-picker-list').childElementCount"), 0);
        await press('Tab', 9);
        assert.equal(await focus(), 'prompt-agent-reference-upload-button', 'Tab should reach upload with no canvas images');
        await evaluate("document.getElementById('prompt-agent-tab-scene').focus()");
        await press('End', 35);
        assert.equal(await focus(), 'prompt-agent-tab-history');
        assert.ok(await evaluate(`(() => {
            const scene = document.getElementById('prompt-agent-tab-scene');
            const history = document.getElementById('prompt-agent-tab-history');
            const content = document.getElementById(history.getAttribute('aria-controls'));
            return scene.tabIndex === -1 && history.tabIndex === 0 && history.getAttribute('aria-selected') === 'true'
                && document.getElementById(scene.getAttribute('aria-controls')).hidden
                && !content.hidden && content.getAttribute('aria-labelledby') === history.id
                && content.contains(document.getElementById('prompt-agent-reference-picker-list'));
        })()`));
        assert.ok((await ax()).some(node => node.role?.value === 'tabpanel' && node.name?.value === '历史'));
        await press('Home', 36);
        assert.equal(await focus(), 'prompt-agent-tab-scene');
        await press('Escape', 27);
        assert.equal(await focus(), 'prompt-agent-add-reference');

        await evaluate("document.querySelector('#prompt-agent-model + button').focus()");
        await press('Enter', 13, { text: '\r' });
        const modelNodes = await ax();
        const modelTrigger = modelNodes.find(node => node.role?.value === 'button' && node.name?.value.startsWith('Prompt Agent 对话模型'));
        assert.equal(property(modelTrigger, 'hasPopup'), 'dialog');
        assert.equal(property(modelTrigger, 'expanded'), true);
        assert.ok(modelNodes.some(node => node.role?.value === 'dialog' && node.name?.value === 'Prompt Agent 对话模型'));
        assert.ok(modelNodes.some(node => node.role?.value === 'searchbox' && property(node, 'focused') === true));
        await press('ArrowDown', 40);
        await press('Enter', 13, { text: '\r' });
        assert.equal(await evaluate("document.activeElement === document.querySelector('#prompt-agent-model + button')"), true);

        await evaluate("document.getElementById('prompt-agent-input').focus()");
        await send('Input.insertText', { text: '/' });
        const commandNodes = await ax();
        const inputNode = commandNodes.find(node => node.role?.value === 'textbox' && node.name?.value.startsWith('Prompt Agent 输入'));
        assert.equal(property(inputNode, 'hasPopup'), 'listbox');
        assert.ok(commandNodes.some(node => node.role?.value === 'listbox' && node.name?.value === 'Agent 命令'));
        assert.ok(commandNodes.some(node => node.role?.value === 'StaticText' && node.name?.value.includes('Agent 命令列表已展开')));
        const point = await evaluate(`(() => {
            const rect = document.activeElement.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
        assert.equal(await evaluate("document.getElementById('prompt-agent-command-menu').hidden"), false);
        await press('ArrowDown', 40);
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-activedescendant')"), 'prompt-agent-command-compact');
        await press('Tab', 9);
        assert.equal(await evaluate("document.getElementById('prompt-agent-command-menu').hidden"), true);
        assert.equal(await focus(), 'prompt-agent-input-resize', 'Tab should skip command options managed by the textarea');

        await evaluate(`const originalFetch = window.fetch.bind(window);
            window.fetch = (url, options) => String(url) === '/proxy'
                ? new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
                : originalFetch(url, options);
            const input = document.getElementById('prompt-agent-input');
            input.value = '等待回复'; input.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('prompt-agent-send').focus();`);
        await press('Enter', 13, { text: '\r' });
        await waitFor("!document.getElementById('prompt-agent-cancel').hidden");
        assert.equal(await focus(), 'prompt-agent-input');
        await evaluate("document.getElementById('prompt-agent-cancel').focus()");
        await press('Enter', 13, { text: '\r' });
        await waitFor("document.getElementById('prompt-agent-cancel').hidden");
        assert.equal(await focus(), 'prompt-agent-input');
    });
});
