import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('compact Agent settings and global width survive resizing, workflow changes and reconstruction', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-compact.html');
    assert.equal(result.error, undefined);
    assert.equal(Object.keys(result).length, 20);
    assert.ok(Object.values(result).every(value => value === true));
});
