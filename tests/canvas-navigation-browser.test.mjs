import test from 'node:test';
import assert from 'node:assert/strict';
import {runUiFixture} from './helpers/ui-browser-fixture.mjs';
import {withAppBrowser} from './helpers/app-browser.mjs';
import {key, nativeClick, openParameters} from './helpers/image-first-integrated-fixture.mjs';
test('canvas navigation preserves zoom anchor and locates only current workflow nodes',async()=>{
 const r=await runUiFixture('tests/fixtures/canvas-navigation.html');
 assert.equal(r.plus,1.2);assert.equal(r.percent,'120%');assert.ok(r.anchorPreserved);
 assert.equal(r.preset,.5);assert.ok(r.presetAnchor);assert.ok(r.zoomKeyboard);
 assert.equal(r.reset,1);assert.equal(r.fitCount,2);assert.equal(r.focused,'b');
 assert.equal(r.found.length,2);assert.match(r.found[0],/运行中/);
 assert.deepEqual(r.current,['c']);assert.ok(r.shortcutSafe && r.closed);
 assert.ok(r.projectionKeptResults);assert.ok(r.renamedRunning);assert.ok(r.restoredResultFocus);
 assert.equal(r.wheels,0);assert.equal(r.maximum,5);assert.equal(r.minimum,.1);assert.ok(r.saves>0);
 for (const [bounds, height] of [[r.rapidResizeZoom, 190], [r.rapidResizeKeyboard, 210]]) {
  assert.ok(bounds.top >= 138 && bounds.bottom <= height && bounds.left >= 0 && bounds.right <= 320, JSON.stringify(bounds));
 }
});

test('canvas navigation menus fit below the toolbar and inside a narrowed canvas', { timeout: 30000 }, async () => {
    const nodes = [
        { id: 'commerce', type: 'ECommerceImageSet', x: 90, y: 170 },
        ...Array.from({ length: 20 }, (_, index) => ({
            id: `text-${index}`, type: 'Text', x: 310, y: 170 + 200 * index,
            customTitle: index === 0 ? 'LongUnbrokenNodeTitle'.repeat(5) : `参考节点 ${index}`
        }))
    ];
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes, connections: [] }, async app => {
        const resize = (width, height) => app.send('Emulation.setDeviceMetricsOverride', {
            width, height, deviceScaleFactor: 1, mobile: false
        });
        const search = '.canvas-node-search';
        const searchTrigger = '[data-nav=search]';
        const zoomTrigger = '.canvas-zoom-menu summary';
        const zoom = '.canvas-zoom-options';
        const markedPresets = `Array.from(document.querySelectorAll('${zoom} [aria-current="true"]'), button => button.dataset.zoom)`;
        const fits = popup => `(() => {
            const r = document.querySelector(${JSON.stringify(popup)}).getBoundingClientRect();
            const canvas = document.getElementById('canvas-container').getBoundingClientRect();
            const toolbar = document.getElementById('toolbar').getBoundingClientRect();
            return r.height > 0 && r.left >= canvas.left && r.right <= canvas.right
                && r.top >= toolbar.bottom + 7 && r.bottom <= canvas.bottom;
        })()`;
        const focused = selector => `document.activeElement === document.querySelector(${JSON.stringify(selector)})`;
        await app.evaluate("document.body.classList.add('toolbar-pinned'); document.getElementById('btn-prompt-agent').click()");
        await resize(760, 298);
        await nativeClick(app, searchTrigger);
        await app.waitFor(fits(search));
        assert.ok(await app.evaluate(focused(`${search} input`)));
        await key(app, 'Escape');
        assert.ok(await app.evaluate(focused(searchTrigger)));

        await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        await openParameters(app, 'commerce');
        await resize(410, 430);
        const toastHit = await app.evaluate(`(() => {
            const container = document.getElementById('toast-container');
            const existing = Array.from(container.childNodes);
            const status = document.createElement('div');
            status.className = 'toast toast-status';
            status.textContent = '已恢复';
            container.replaceChildren(status);
            const rect = container.getBoundingClientRect();
            const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            const passesThrough = Boolean(target && !container.contains(target));
            container.append(status.cloneNode(true));
            const stackEvents = getComputedStyle(container).pointerEvents;
            container.replaceChildren(...existing);
            return { passesThrough, stackEvents };
        })()`);
        assert.deepEqual(toastHit, { passesThrough: true, stackEvents: 'auto' });
        await nativeClick(app, searchTrigger);
        await app.waitFor(fits(search));
        await nativeClick(app, `${search} input`);
        for (let index = 0; index < 4; index++) await key(app, 'ArrowDown');
        assert.deepEqual(await app.evaluate(`(() => {
            const list = document.querySelector('.canvas-node-results');
            const canvas = document.getElementById('canvas-container');
            return [list.scrollTop > 0, list.scrollWidth === list.clientWidth, canvas.scrollLeft, canvas.scrollTop];
        })()`), [true, true, 0, 0]);
        await key(app, 'Escape');
        assert.ok(await app.evaluate(focused(searchTrigger)));

        await nativeClick(app, zoomTrigger);
        await app.waitFor(fits(zoom));
        await app.waitFor(`${markedPresets}.join(',') === '1'`);
        await resize(400, 300);
        await app.waitFor(fits(zoom));
        await nativeClick(app, `${zoom} button[data-zoom="0.25"]`);
        assert.equal(await app.evaluate("document.getElementById('zoom-level').textContent"), '25%');
        assert.ok(await app.evaluate(focused(zoomTrigger)));

        await nativeClick(app, zoomTrigger);
        await app.waitFor(`${markedPresets}.join(',') === '0.25'`);
        await app.evaluate("document.querySelector('#canvas-navigation [data-nav=plus]').click()");
        assert.equal(await app.evaluate("document.getElementById('zoom-level').textContent"), '30%');
        assert.equal(await app.evaluate("document.querySelector('.canvas-zoom-menu').open"), true);
        await app.waitFor(`${markedPresets}.length === 0`);
    });
});
