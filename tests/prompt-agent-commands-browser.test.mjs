import assert from 'node:assert/strict';
import test from 'node:test';

import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('Agent slash commands support keyboard selection, model-free clear and durable compaction in the production panel', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-commands.html');

    assert.equal(result.error, undefined);
    assert.ok(result.keyboardAndClick);
    assert.ok(result.clearedWithoutModel);
    assert.ok(result.continuedFromSummary);
    assert.ok(result.historyRetained);
    assert.ok(result.failurePreservedContext);
    assert.equal(result.compactionCount, 2);
    assert.equal(result.samples.length, 6);
    for (const sample of result.samples) {
        const context = `${sample.theme} at ${sample.width}px`;
        assert.ok(sample.menuFits, `command menu must stay inside panel: ${context}`);
        assert.ok(sample.optionsFit, `command labels must fit without horizontal scrolling: ${context}`);
        assert.ok(sample.composerFits, `composer must remain usable: ${context}`);
        assert.notEqual(sample.selectedBorder, sample.unselectedBorder, `active command must be visible: ${context}`);
        assert.notEqual(sample.descriptionColor, 'rgba(0, 0, 0, 0)', `description must be visible: ${context}`);
        assert.notEqual(sample.background, 'rgba(0, 0, 0, 0)', `menu must have an opaque surface: ${context}`);
    }
});
