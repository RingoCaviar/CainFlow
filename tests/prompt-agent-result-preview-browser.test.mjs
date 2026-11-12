import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('restored Agent result thumbnails fit narrow and wide panels in every theme', async () => {
    for (const theme of ['light', 'dark', 'pink', 'paper', 'pro', 'glass-light', 'glass-dark']) {
        for (const width of [300, 612]) {
            const result = await runUiFixture(`tests/fixtures/prompt-agent-result-preview.html?theme=${theme}&width=${width}`);
            assert.equal(result.error, undefined);
            assert.ok(result.panelFits && result.clickOpens, `${theme} ${width}px`);
            assert.ok(result.selectedCorrectBatch && result.previousImage && result.zoomed && result.zoomButtons && result.folded && result.revealed && result.closed && result.nodeUnchanged);
        }
    }
});

test('an independent Agent batch previews the chosen image, supports zoom and navigation without changing its source node', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-result-preview.html');
    assert.equal(result.error, undefined);
    assert.deepEqual(result, {
        panelFits: true, clickOpens: true,
        selectedCorrectBatch: true, hasNodeEditor: false, thumbnails: 2,
        previousImage: true, zoomed: true, zoomButtons: true, folded: true, revealed: true, closed: true, nodeUnchanged: true
    });
});

test('the fullscreen thumbnail strip stays below the image and scrolls to the current thumbnail at desktop and narrow widths', async () => {
    for (const [windowSize, narrow] of [['1280,960', false], ['520,640', true]]) {
        const result = await runUiFixture('tests/fixtures/prompt-agent-result-preview.html?strip=1', { windowSize });
        assert.equal(result.error, undefined);
        assert.equal(result.viewportWidth < 768, narrow, `expected the ${windowSize} browser viewport`);
        assert.equal(result.stripBelowMain, true, `strip below the main image at ${windowSize}`);
        assert.equal(result.mainImageFits, true, `main image stays inside its own area at ${windowSize}`);
        assert.equal(result.zoomClearsStrip, true, `zoom controls stay above the strip at ${windowSize}`);
        assert.equal(result.horizontalOrder, true, `thumbnail buttons share a horizontal row at ${windowSize}`);
        assert.equal(result.horizontalOverflow, true, `long batches have horizontal scroll space at ${windowSize}`);
        assert.equal(result.wheelScrollsStrip, true, `wheel over the strip scrolls without zooming at ${windowSize}`);
        assert.equal(result.keyboardSelectsLast, true, `ArrowLeft wraps from the first image at ${windowSize}`);
        assert.equal(result.keyboardRevealsLast, true, `the active thumbnail scrolls fully into view at ${windowSize}`);
        assert.equal(result.singleImageHasNoStrip, true, `one image has no thumbnail strip at ${windowSize}`);
    }
});
