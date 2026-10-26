import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('resizing an image generation card keeps progress with its run actions near the bottom edge', async () => {
    const result = await runUiFixture('tests/fixtures/generation-progress-resize.html');
    assert.equal(result.error, undefined, result.error);
    assert.ok(result.during.cardHeight >= result.before.cardHeight + 175, JSON.stringify(result));
    assert.ok(result.during.promptHeight >= result.before.promptHeight + 175, JSON.stringify(result));
    assert.ok(result.shrunk.cardHeight <= result.after.cardHeight - 150, JSON.stringify(result));
    for (const phase of ['before', 'during', 'after', 'shrunk']) {
        const { bottomGap, progressToActionsGap } = result[phase];
        assert.ok(bottomGap >= 3 && bottomGap <= 20, `${phase}: run feedback is ${bottomGap}px from the card edge`);
        assert.ok(progressToActionsGap >= 0 && progressToActionsGap <= 16,
            `${phase}: progress and run actions have a ${progressToActionsGap}px gap`);
    }
});
