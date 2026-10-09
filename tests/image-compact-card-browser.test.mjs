import test from 'node:test';
import assert from 'node:assert/strict';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('image card retains editable advanced values and primary controls across seven themes', async () => {
    const results = await runUiFixture('tests/fixtures/image-compact-card.html');
    assert.equal(results.length, 8, JSON.stringify(results));
    for (const result of results.slice(0, 7)) {
        assert.equal(result.collapsed, true, result.theme);
        assert.equal(result.expanded, true, result.theme);
        assert.equal(result.saved, 'opaque');
        assert.ok(result.quality && result.prompt && result.progress);
        assert.equal(result.ports, 6);
        assert.ok(result.expandedHeight > result.height + 30, `${result.theme}: local collapse must visibly reduce card height`);
    }
    const bound = results[7];
    assert.ok(bound.openHeight > bound.compactHeight + 30, JSON.stringify(bound));
    assert.ok(bound.closedHeight < bound.openHeight - 30, JSON.stringify(bound));
    assert.ok(bound.geometry > 0);
    assert.match(bound.summary, /背景：透明/);
    assert.ok(bound.hiddenOther && bound.restored);
    assert.equal(bound.saved, 'transparent');
    assert.equal(bound.persisted, 'transparent');
});
