import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('Agent scroll-to-bottom preserves reading position and fits a narrow panel in each theme', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-scroll.html');
    assert.deepEqual(result, { light: true, dark: true, pink: true });
});
