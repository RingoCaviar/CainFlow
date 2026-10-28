import test from 'node:test';
import assert from 'node:assert/strict';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('registered modeless surfaces alternate above their own menus and remain below real modal windows', async () => {
    const result = await runUiFixture('tests/fixtures/modeless-surface-coordination.html');
    assert.equal(result.error, undefined);
    assert.equal(result.passed, true);
});

test('the original Agent surface and pending conversation coexist with parameter drafts and recover without closing', async () => {
    const result = await runUiFixture('tests/fixtures/agent-parameter-surfaces.html');
    assert.equal(result.error, undefined);
    assert.equal(result.passed, true);
});
