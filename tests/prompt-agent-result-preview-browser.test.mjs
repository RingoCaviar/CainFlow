import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('restored Agent result thumbnails fit narrow and wide panels in every theme', async () => {
    for (const theme of ['light', 'dark', 'pink']) {
        for (const width of [300, 612]) {
            const result = await runUiFixture(`tests/fixtures/prompt-agent-result-preview.html?theme=${theme}&width=${width}`);
            assert.equal(result.error, undefined);
            assert.ok(result.panelFits && result.clickOpens, `${theme} ${width}px`);
            assert.ok(result.selectedCorrectBatch && result.previousImage && result.zoomed && result.closed && result.nodeUnchanged);
        }
    }
});

test('an independent Agent batch previews the chosen image, supports zoom and navigation without changing its source node', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-result-preview.html');
    assert.equal(result.error, undefined);
    assert.deepEqual(result, {
        panelFits: true, clickOpens: true,
        selectedCorrectBatch: true, hasNodeEditor: false, thumbnails: 2,
        previousImage: true, zoomed: true, closed: true, nodeUnchanged: true
    });
});
