import test from 'node:test';
import assert from 'node:assert/strict';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('Agent search menu, real citations, image preview/import and restoration work in all themes and narrow panels', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-search.html');
    assert.equal(result.error, undefined);
    assert.equal(result.passed, true);
    assert.equal(result.samples.length, 6);
});
