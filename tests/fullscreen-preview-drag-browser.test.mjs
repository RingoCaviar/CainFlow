import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

for (const source of ['Agent', 'ImageSave', 'ImagePreview']) {
    test(`${source}: dragging never becomes a blank close click, and subsequent actions work`, async () => {
        const result = await runUiFixture(`tests/fixtures/fullscreen-preview-drag.html?source=${source}`);
        assert.equal(result.error, undefined);
        assert.equal(Object.keys(result).length, 27);
        assert.ok(Object.values(result).every(value => value === true));
    });
}
