import assert from 'node:assert/strict';
import test from 'node:test';

import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('Prompt Agent panel does not force toolbar expansion or reserve hidden toolbar space at regular and narrow widths', async () => {
    const samples = await runUiFixture('tests/fixtures/prompt-agent-layout.html');
    assert.ok(samples[1].toolbarHeight > samples[0].toolbarHeight);
    for (const sample of samples) {
        assert.equal(sample.panelTop, 12);
        assert.ok(sample.toolbarHidden, JSON.stringify(sample));
        assert.ok(sample.panelBottom <= sample.viewportHeight, JSON.stringify(sample));
    }
});
