import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';
test('Agent model menus, canvas dismissal and toolbar chrome coexist in all themes', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-interactions.html');
    assert.equal(result.error, undefined);
    assert.equal(Object.keys(result).length, 43);
    assert.ok(Object.values(result).every(value => value === true));
});
