import test from 'node:test';
import assert from 'node:assert/strict';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('project dialogs wait for a decision, cancel safely and preserve input defaults', async () => {
    const result = await runUiFixture('tests/fixtures/app-dialogs.html');
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.pending, true);
    assert.equal(result.cancelled, false);
    assert.equal(result.confirmed, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.defaultValue, 'my-protocol-copy');
    assert.equal(result.inputLabel, '输入 ID');
    assert.equal(result.input, 'new-protocol');
    assert.equal(result.cancelledInput, null);
    assert.equal(result.escaped, true);
    assert.equal(result.danger, true);
    assert.equal(result.longContentFits, true);
    assert.equal(result.themes.length, 7);
    assert.ok(new Set(result.themes.map(theme => theme.background)).size >= 4);
    assert.ok(result.themes.every(theme => theme.background !== 'rgba(0, 0, 0, 0)' && theme.color !== theme.background));
});
