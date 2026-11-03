import test from 'node:test';
import assert from 'node:assert/strict';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('completed desktop updates offer restart, retain a later entry and browser updates stay manual', async () => {
    const result = await runUiFixture('tests/fixtures/update-restart.html');
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.afterLater, 0);
    assert.deepEqual(result.restarts, ['ready-job']);
    assert.equal(result.retainedAfterFailure, true);
    assert.equal(result.browserManual, true);
});
