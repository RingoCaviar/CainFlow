import assert from 'node:assert/strict';
import test from 'node:test';

import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('Prompt Agent panel clears the expanded toolbar at regular and narrow widths', async () => {
    const samples = await runUiFixture('tests/fixtures/prompt-agent-layout.html');
    assert.ok(samples[1].toolbarHeight > samples[0].toolbarHeight);
    for (const sample of samples) {
        assert.ok(sample.gap >= 7 && sample.gap <= 9, JSON.stringify(sample));
        assert.ok(sample.panelBottom <= sample.viewportHeight, JSON.stringify(sample));
    }
});
