import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('history image preview unfolds actions and zooms or fits using the lower-right controls', async () => {
    const result = await runUiFixture('tests/fixtures/history-preview-controls.html');
    assert.deepEqual(result, { folded: true, revealed: true, zoomIn: true, zoomOut: true, fit: true, closed: true });
});
