import assert from 'node:assert/strict';
import test from 'node:test';
import { reloadAppBrowser, withAppBrowser } from './helpers/app-browser.mjs';
import { nativeClick, persist } from './helpers/image-first-integrated-fixture.mjs';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('node edges expose the matching resize cursors without covering ports or controls', async () => {
    const result = await runUiFixture('tests/fixtures/node-edge-resize.html');
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(result.handles, [
        { edge: 'left', cursor: 'ew-resize', hit: true },
        { edge: 'right', cursor: 'ew-resize', hit: true },
        { edge: 'top', cursor: 'ns-resize', hit: true },
        { edge: 'bottom', cursor: 'ns-resize', hit: true },
        { edge: 'bottom-right', cursor: 'nwse-resize', hit: true }
    ]);
    assert.deepEqual(result.boundEdges, [
        { edge: 'left', bound: true },
        { edge: 'right', bound: true },
        { edge: 'top', bound: true },
        { edge: 'bottom', bound: true },
        { edge: 'bottom-right', bound: true }
    ]);
    assert.ok(Math.abs(result.inputPort.edgeGap - 4) <= 0.1, `input port gap: ${result.inputPort.edgeGap}px`);
    assert.ok(Math.abs(result.outputPort.edgeGap - 4) <= 0.1, `output port gap: ${result.outputPort.edgeGap}px`);
    assert.equal(result.inputPort.clipPath, 'path("M 18.2 0 A 18.2 18.2 0 0 0 18.2 36.4 Z")');
    assert.equal(result.outputPort.clipPath, 'path("M 18.2 0 A 18.2 18.2 0 0 1 18.2 36.4 Z")');
    assert.equal(result.inputPort.outerHit, true);
    assert.equal(result.outputPort.outerHit, true);
    assert.equal(result.inputPort.gapHit, false);
    assert.equal(result.outputPort.gapHit, false);
    assert.equal(result.inputPort.innerHit, false);
    assert.equal(result.outputPort.innerHit, false);
    assert.equal(result.deleteAccessible, true);
    assert.equal(result.activeCursor, 'ew-resize');
});

test('a connected node uses the final pointer on quick resize release and stays aligned', { timeout: 30000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test', apikey: 'test' }],
        nodes: [
            { id: 'source', type: 'Text', x: 100, y: 150, width: 240, height: 200, text: 'source' },
            { id: 'target', type: 'Text', x: 560, y: 150, width: 240, height: 200, text: 'target' }
        ],
        connections: [{ id: 'resized-edge', from: { nodeId: 'source', port: 'text' }, to: { nodeId: 'target', port: 'text' }, type: 'text' }]
    }, async app => {
        const readGeometry = `(() => {
            const path = document.querySelector('[data-conn-id=resized-edge]');
            if (!path?.getAttribute('d')) return null;
            const portCenter = (selector) => {
                const rect = document.querySelector(selector).getBoundingClientRect();
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            };
            const source = portCenter('#source .node-port.output .port-dot');
            const target = portCenter('#target .node-port.input .port-dot');
            const matrix = path.getScreenCTM();
            const start = path.getPointAtLength(0).matrixTransform(matrix);
            const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
            return { source, target,
                startOffset: Math.hypot(source.x - start.x, source.y - start.y),
                endOffset: Math.hypot(target.x - end.x, target.y - end.y) };
        })()`;
        await app.waitFor(`Boolean(${readGeometry})`);
        const before = await app.evaluate(readGeometry);
        const handle = await app.evaluate(`(() => {
            const rect = document.querySelector('#source [data-resize-edge=right]').getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + 30 };
        })()`);
        assert.equal(await app.evaluate(`document.elementFromPoint(${handle.x}, ${handle.y})?.dataset.resizeEdge`), 'right');
        const moved = { x: handle.x + 25, y: handle.y };
        const released = { x: handle.x + 80, y: handle.y };
        await app.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
        const gesture = Promise.all([
            app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...handle, button: 'left', clickCount: 1 }),
            app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...moved, buttons: 1 }),
            app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...released, button: 'left', clickCount: 1 })
        ]);
        const frames = app.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        await app.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 100 });
        await gesture;
        await frames;

        const after = await app.evaluate(readGeometry);
        assert.ok(Math.abs(after.source.x - before.source.x - 80) < 1, 'the port follows the release position');
        assert.deepEqual(after.target, before.target);
        assert.ok(after.startOffset < 1 && after.endOffset < 1, JSON.stringify(after));
    });
});

test('an empty image card can shrink on its first drag and stops at its manual minimum', { timeout: 30000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        nodes: [{ id: 'empty-image', type: 'ImageGenerate', x: 160, y: 110 }]
    }, async app => {
        const card = 'document.getElementById("empty-image")';
        const readHeight = `${card}.offsetHeight`;
        const before = await app.evaluate(readHeight);
        assert.equal(before, 348, 'the unresized placeholder starts at its automatic height');
        const handle = await app.evaluate(`(() => {
            const rect = ${card}.querySelector('[data-resize-edge=bottom]').getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`);
        assert.equal(await app.evaluate(`document.elementFromPoint(${handle.x}, ${handle.y})?.dataset.resizeEdge`), 'bottom');
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...handle, button: 'left', clickCount: 1 });
        for (const [dy, expectedHeight] of [[-32, 316], [-142, 248]]) {
            await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y + dy, buttons: 1 });
            await app.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            assert.equal(await app.evaluate(readHeight), expectedHeight, 'the first drag already uses the manual height range');
            if (dy === -32) {
                // Startup content checks can request a fit while the pointer is held.
                await app.evaluate(`(async () => {
                    const { bootstrapCainFlowApp } = await import('/js/app/bootstrap.js');
                    const { registry } = await bootstrapCainFlowApp();
                    registry.nodeLifecycleApi.fitNodeToContent('empty-image', { save: false });
                })()`);
                assert.equal(await app.evaluate(readHeight), expectedHeight, 'automatic fit does not interrupt manual resizing');
            }
        }
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x, y: handle.y - 142, button: 'left', clickCount: 1 });
        assert.equal(await app.evaluate(readHeight), 248, 'release keeps the manual minimum');
    });
});

test('clicking a resize edge without dragging keeps automatic sizing', { timeout: 30000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        nodes: [{ id: 'image', type: 'ImageGenerate', x: 140, y: 90 }]
    }, async app => {
        await nativeClick(app, '#image [data-resize-edge=bottom]');
        const node = (await persist(app)).nodes.find(node => node.id === 'image');
        assert.notEqual(node.userResized, true);
        assert.equal(await app.evaluate("document.getElementById('image').offsetHeight"), 348);
    });
});

test('a legacy image card keeps the fitted size when reopened', { timeout: 30000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        nodes: [{ id: 'image', type: 'ImageGenerate', x: 140, y: 90, width: 320, height: 200, userResized: true }]
    }, async app => {
        const size = () => app.evaluate("(() => { const card = document.getElementById('image'); return [card.offsetWidth, card.offsetHeight]; })()");
        assert.deepEqual(await size(), [320, 200]);
        await nativeClick(app, '#image .node-resize-handle--bottom-right', { count: 2 });
        const fitted = await size();
        assert.ok(fitted[0] >= 360 && fitted[1] === 348, `fitted card: ${fitted.join(' × ')}`);
        assert.equal((await persist(app)).nodes.find(node => node.id === 'image').userResized, false);
        await reloadAppBrowser(app);
        assert.deepEqual(await size(), fitted);
    });
});

test('a long text split preview scrolls inside its saved card', { timeout: 30000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        nodes: [{
            id: 'split', type: 'TextSplit', x: 140, y: 90, width: 370, height: 600, userResized: true,
            text: `短文|${'这是需要换行的一段文本。'.repeat(280)}|另一段`,
            delimiter: '|', outputCount: 3, previewEnabled: true
        }]
    }, async app => {
        const check = async () => {
            const layout = await app.evaluate(`(() => {
                const card = document.getElementById('split');
                const preview = document.querySelector('#split .text-split-preview');
                const rect = preview.getBoundingClientRect();
                return {
                    height: card.offsetHeight, items: preview.children.length,
                    x: rect.left + 12, y: rect.top + 24, renderedWidth: card.getBoundingClientRect().width
                };
            })()`);
            assert.equal(layout.height, 600);
            assert.equal(layout.items, 3);
            await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: layout.x, y: layout.y, deltaX: 0, deltaY: 180 });
            await app.waitFor("document.querySelector('#split .text-split-preview').scrollTop > 0");
            assert.equal(await app.evaluate("document.getElementById('split').getBoundingClientRect().width"), layout.renderedWidth);
        };
        await check();
        await reloadAppBrowser(app);
        await check();
    });
});
