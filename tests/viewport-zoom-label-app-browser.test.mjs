import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('wheel zoom updates its percentage without replacing navigation children', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [], connections: [] }, async app => {
        await app.evaluate(`(async () => {
            const { state } = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
            const label = document.getElementById('zoom-level');
            window.zoomLabelProbe = { state, label, text: label.firstChild, replacements: 0 };
            const observer = new MutationObserver(records => {
                zoomLabelProbe.replacements += records.filter(record => record.type === 'childList').length;
            });
            observer.observe(label, { childList: true, subtree: true });
            for (const deltaY of [-40, -40, 20, 40]) {
                document.getElementById('canvas-container').dispatchEvent(new WheelEvent('wheel', {
                    bubbles: true, cancelable: true, clientX: 500, clientY: 400, deltaY
                }));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }
        })()`);
        const result = await app.evaluate(`({
            replacements: zoomLabelProbe.replacements,
            retained: zoomLabelProbe.label.firstChild === zoomLabelProbe.text,
            label: zoomLabelProbe.label.textContent,
            expected: Math.round(zoomLabelProbe.state.canvas.zoom * 100) + '%'
        })`);
        assert.notEqual(result.expected, '100%', 'the real wheel gesture changes zoom');
        assert.equal(result.label, result.expected, 'the percentage remains live and accurate');
        assert.equal(result.replacements, 0, 'zoom must not invalidate ancestor :has selectors through child replacement');
        assert.equal(result.retained, true);
    });
});
