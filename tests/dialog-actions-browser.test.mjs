import test from 'node:test';
import assert from 'node:assert/strict';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('update downloads and workflow imports wait for explicit project-dialog confirmation', async () => {
    const result = await runUiFixture('tests/fixtures/dialog-actions.html');
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.downloadsBeforeConfirm, 0);
    assert.equal(result.downloadsAfterCancel, 0);
    assert.equal(result.downloadsAfterConfirm, 1);
    assert.equal(result.importsBeforeConfirm, 0);
    assert.equal(result.importsAfterCancel, 0);
    assert.equal(result.importsAfterConfirm, 1);
});
