import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser } from './helpers/app-browser.mjs';
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
    assert.ok(Math.abs(result.inputPort.borderOffset) <= 1, `input port is ${result.inputPort.borderOffset}px from the border`);
    assert.ok(Math.abs(result.outputPort.borderOffset) <= 1, `output port is ${result.outputPort.borderOffset}px from the border`);
    assert.ok(Math.abs(result.inputPort.edgeOffset) <= 0.5, `input port overlaps the card by ${result.inputPort.edgeOffset}px`);
    assert.ok(Math.abs(result.outputPort.edgeOffset) <= 0.5, `output port overlaps the card by ${result.outputPort.edgeOffset}px`);
    assert.equal(result.inputPort.clipPath, 'path("M 18.2 0 A 18.2 18.2 0 0 0 18.2 36.4 Z")');
    assert.equal(result.outputPort.clipPath, 'path("M 18.2 0 A 18.2 18.2 0 0 1 18.2 36.4 Z")');
    assert.equal(result.inputPort.outerHit, true);
    assert.equal(result.outputPort.outerHit, true);
    assert.equal(result.inputPort.seamHit, false);
    assert.equal(result.outputPort.seamHit, false);
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
