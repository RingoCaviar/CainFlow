import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('notifications avoid the Agent during width changes and return on close', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-toast.html');
    for (const sample of result.samples) {
        assert.ok(sample.toastRight <= sample.panelLeft - 8, JSON.stringify(sample));
        assert.ok(sample.toastLeft >= 16, JSON.stringify(sample));
        assert.equal(sample.overflow, false);
    }
    assert.equal(result.closedRight, result.viewport - 20);
});
