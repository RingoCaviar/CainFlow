import test from 'node:test';
import assert from 'node:assert/strict';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

for (const windowSize of ['1280,960', '640,720']) test(`all main panels, nested windows and Agent search configuration have isolated lifecycles (${windowSize})`, async () => {
    const result = await runUiFixture('tests/fixtures/surface-coordinator.html', { windowSize });
    assert.equal(result.error, undefined);
    assert.equal(result.panelPairs, 42);
    assert.equal(result.themes, 7);
    assert.equal(result.passed, true);
});
