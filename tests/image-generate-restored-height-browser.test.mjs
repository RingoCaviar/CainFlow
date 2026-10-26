import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('restored image cards discard automatic card height while retaining saved editor heights', async () => {
    const result = await runUiFixture('tests/fixtures/image-generate-restored-height.html');
    assert.equal(result.error, undefined, result.error);
    assert.ok(result.legacy.height >= 1593, JSON.stringify(result));
    assert.ok(result.legacy.promptHeight >= 1593, JSON.stringify(result));
    assert.equal(result.legacy.savedPromptHeight, 1593, JSON.stringify(result));
    assert.equal(result.legacy.savedHeight, null, JSON.stringify(result));
    assert.ok(result.manual.height >= 1200, JSON.stringify(result));
    assert.ok(result.manual.savedPromptHeight >= 484, JSON.stringify(result));
    assert.ok(result.manual.savedHeight >= 1200, JSON.stringify(result));
    assert.equal(result.collapsed.expandedHeight, undefined, JSON.stringify(result));
    assert.equal(result.collapsed.savedExpandedHeight, undefined, JSON.stringify(result));
    assert.equal(result.collapsed.savedHeight, null, JSON.stringify(result));
});
