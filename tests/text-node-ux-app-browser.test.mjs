import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

const longText = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行 商品细节提示词`).join('\n');
const session = { autoCheckUpdatesOnLoad: false, nodes: [
    { id: 'empty-text', type: 'Text', x: 80, y: 80, width: 260, height: 240, text: '' },
    { id: 'batch-text', type: 'Text', customTitle: '商品文案', x: 420, y: 80, width: 260, height: 240, userResized: true, texts: [longText, '第二条：棚拍柔光背景'], textPreviewIndex: 0 }
], connections: [] };

const key = async (app, key, code = key) => {
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
};

test('text nodes execute in a windowless workflow document and publish their output to the visible card', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [
        { id: 'source-text', type: 'Text', x: 80, y: 80, text: '后台文本运行结果' },
        { id: 'sink-text', type: 'Text', x: 420, y: 80, text: '' }
    ], connections: [{ id: 'text-link', from: { nodeId: 'source-text', port: 'text' },
        to: { nodeId: 'sink-text', port: 'text' }, type: 'text' }] }, async app => {
        await app.evaluate(runWorkflowShortcut);
        await app.waitFor("document.getElementById('sink-text-text').value==='后台文本运行结果' && document.getElementById('btn-stop').disabled");
        assert.equal(await app.evaluate("document.getElementById('sink-text').querySelectorAll('.text-node-tools').length"), 1);
    });
});

test('text cards expose their identity and keyboard editing instructions without hover', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        const info = await app.evaluate(`(() => {
            const card = document.getElementById('batch-text');
            return { role: card.getAttribute('role'), title: document.getElementById(card.getAttribute('aria-labelledby'))?.textContent,
                hint: card.getAttribute('aria-describedby').split(' ').map(id => document.getElementById(id)?.textContent).join(' '),
                titleVisible: card.querySelector('.node-header').checkVisibility({ checkVisibilityCSS: true }),
                placeholder: document.getElementById('empty-text-text').placeholder };
        })()`);
        assert.equal(info.role, 'group');
        assert.match(info.title, /商品文案/);
        assert.ok(info.titleVisible, 'the node can be identified without hover');
        assert.match(info.hint, /Enter|F2/);
        assert.match(info.placeholder, /双击/);
        const point = await app.evaluate(`(() => { const r = document.getElementById('batch-text-text').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 40 }; })()`);
        for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
        await key(app, 'Enter');
        assert.equal(await app.evaluate('document.activeElement.id'), 'batch-text-text');
        assert.match(await app.evaluate("document.querySelector('#batch-text .text-node-mode').textContent"), /编辑|Esc/);
        await key(app, 'Escape');
        assert.equal(await app.evaluate('document.activeElement.id'), 'batch-text');
        assert.match(await app.evaluate("document.querySelector('#batch-text .text-node-mode').textContent"), /预览/);
    });
});

test('open readers follow Text execution results without disturbing unchanged reading selection', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate(runWorkflowShortcut);
        await app.waitFor("import('/js/app/bootstrap.js').then(m => m.bootstrapCainFlowApp()).then(app => !!app.registry.executionCoreApi)");
        await app.evaluate("document.getElementById('batch-text').focus(); document.querySelector('#batch-text .text-node-reader-open').click()");
        await app.waitFor("document.querySelector('#batch-text-text-reader').matches(':popover-open')");
        assert.match(await app.evaluate("document.querySelector('#batch-text-text-reader h3').textContent"), /商品文案/);
        const updated = longText.replaceAll('商品细节', '更新后的商品细节');
        await app.evaluate(`(async () => {
            const { bootstrapCainFlowApp } = await import('/js/app/bootstrap.js');
            window.textTestApp = await bootstrapCainFlowApp();
            await textTestApp.registry.executionCoreApi.nodeHandlers.Text(textTestApp.state.nodes.get('batch-text'), { text: [${JSON.stringify(updated)}, '新的第二条'] });
        })()`);
        assert.equal(await app.evaluate("document.querySelector('#batch-text-text-reader pre').textContent"), updated);
        await app.evaluate(`(() => {
            const pre = document.querySelector('#batch-text-text-reader pre'); pre.scrollTop = 200;
            const range = document.createRange(); range.setStart(pre.firstChild, 0); range.setEnd(pre.firstChild, 5);
            getSelection().removeAllRanges(); getSelection().addRange(range);
            window.retainedReaderNode = pre.firstChild; window.retainedScroll = pre.scrollTop;
        })()`);
        await app.evaluate(`textTestApp.registry.executionCoreApi.nodeHandlers.Text(textTestApp.state.nodes.get('batch-text'), { text: [${JSON.stringify(updated)}, '新的第二条'] })`);
        assert.ok(await app.evaluate("document.querySelector('#batch-text-text-reader pre').firstChild === window.retainedReaderNode"), 'unchanged output retains the text node and selection');
        assert.equal(await app.evaluate('getSelection().toString()'), updated.slice(0, 5));
        assert.ok(await app.evaluate("document.querySelector('#batch-text-text-reader pre').scrollTop === window.retainedScroll"));
    });
});

test('clone text cards explain why editing is unavailable', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [...session.nodes, { id: 'clone-text', type: 'Text', x: 80, y: 400, width: 260, height: 190, isClone: true, cloneSourceId: 'batch-text' }] }, async app => {
        const mode = await app.evaluate("document.querySelector('#clone-text .text-node-mode').textContent");
        assert.match(mode, /克隆|只读/);
        assert.doesNotMatch(mode, /双击|F2/);
        await app.evaluate("document.getElementById('clone-text').focus()");
        await key(app, 'Enter');
        assert.notEqual(await app.evaluate('document.activeElement.id'), 'clone-text-text');
    });
});

test('text tools remain reachable across their hover gap and near the viewport bottom', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate(`document.querySelector('#canvas-navigation [data-zoom="0.5"]').click()`);
        const from = await app.evaluate(`(() => { const r = document.getElementById('batch-text').getBoundingClientRect(); return { x: r.left + 30, y: r.bottom - 4 }; })()`);
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
        const to = await app.evaluate(`(() => { const r = document.querySelector('#batch-text .text-node-reader-open').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, height: r.height }; })()`);
        assert.ok(to.height >= 31, 'low zoom keeps a screen-sized reader entry');
        for (let step = 1; step <= 20; step++) await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * step / 20, y: from.y + (to.y - from.y) * step / 20 });
        for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: to.x, y: to.y, button: 'left', clickCount: 1 });
        await app.waitFor("document.querySelector('#batch-text-text-reader').matches(':popover-open')");
        await key(app, 'Escape');
        await app.evaluate(`(() => { const card = document.getElementById('batch-text'); const r = card.getBoundingClientRect(); card.style.top = (parseFloat(card.style.top) + (innerHeight - 12 - r.bottom) / .5) + 'px'; card.focus(); document.dispatchEvent(new CustomEvent('cainflow:canvas-transform')); })()`);
        await app.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
        assert.ok(await app.evaluate(`(() => { const b = document.querySelector('#batch-text .text-node-reader-open').getBoundingClientRect(); return b.bottom <= innerHeight && b.top >= 0; })()`), 'bottom edge does not clip the entry');
    });
});

test('full text reader stays readable at half zoom and closes back to its opener', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate(`document.querySelector('#canvas-navigation [data-zoom="0.5"]').click()`);
        await app.evaluate(`window.readerOpener = [...document.querySelectorAll('#batch-text .text-node-tools button')].find(b => /全文/.test(b.textContent)); window.readerOpener.focus(); window.readerOpener.click()`);
        await app.waitFor("document.querySelector('#batch-text-text-reader')?.matches(':popover-open')");
        const info = await app.evaluate(`(() => {
            const reader = document.querySelector('#batch-text-text-reader');
            const content = reader.querySelector('textarea, pre');
            const rect = reader.getBoundingClientRect();
            return { value: content.value ?? content.textContent, readOnly: content.tagName !== 'TEXTAREA' || content.readOnly,
                fontSize: parseFloat(getComputedStyle(content).fontSize), width: rect.width,
                options: [...reader.querySelector('select').options].map(o => o.textContent) };
        })()`);
        assert.equal(info.value, longText);
        assert.ok(info.readOnly);
        assert.ok(info.fontSize >= 14 && info.width >= 320, 'reader dimensions do not inherit canvas scaling');
        assert.equal(info.options.length, 2);
        assert.match(info.options[1], /棚拍|第二条/);
        await app.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedReaderText = text; } } }); document.querySelector('#batch-text-text-reader .text-node-reader-copy').click()`);
        await app.waitFor(`window.copiedReaderText === ${JSON.stringify(longText)}`);
        await app.evaluate("document.querySelector('#batch-text-text-reader .text-node-reader-next').click()");
        assert.match(await app.evaluate("document.querySelector('#batch-text-text-reader pre').textContent"), /第二条/);
        await app.evaluate("document.querySelector('#batch-text-text-reader .text-node-reader-previous').click()");
        assert.equal(await app.evaluate("document.querySelector('#batch-text-text-reader pre').textContent"), longText);
        await app.evaluate(`navigator.clipboard.writeText = async () => { throw new Error('Denied'); }; document.querySelector('#batch-text-text-reader .text-node-reader-copy').click()`);
        await app.waitFor("document.querySelector('#batch-text-text-reader').textContent.includes('复制失败')");
        await app.evaluate(`const select = document.querySelector('#batch-text-text-reader select'); select.selectedIndex = 1; select.dispatchEvent(new Event('change', { bubbles: true }))`);
        assert.equal(await app.evaluate(`(() => { const e = document.querySelector('#batch-text-text-reader textarea, #batch-text-text-reader pre'); return e.value ?? e.textContent; })()`), '第二条：棚拍柔光背景');
        await app.evaluate("document.querySelector('#batch-text-text-reader pre').focus()");
        await key(app, 'Escape');
        await app.waitFor("!document.querySelector('#batch-text-text-reader')?.matches(':popover-open')");
        assert.ok(await app.evaluate('document.activeElement === window.readerOpener'), 'closing restores the exact opener');
    });
});
import { runWorkflowShortcut } from './helpers/workflow-run-shortcut.mjs';
