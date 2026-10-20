import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('scene reference picker uses production markup and keeps numbered selections usable across themes and panel widths', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-reference-picker.html');
    assert.equal(result.error, undefined);
    assert.deepEqual(result.selected, ['1', '2']);
    assert.deepEqual(result.sent, ['1', '2']);
    for (const sample of result.samples) {
        assert.ok(sample.pickerFits && sample.composerFits && sample.galleryFits && sample.hiddenCancel, JSON.stringify(sample));
        assert.notEqual(sample.selectedBorder, sample.unselectedBorder, JSON.stringify(sample));
    }
});
