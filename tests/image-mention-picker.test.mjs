import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('the shared image mention picker shows originals as thumbnails, filters sources, and edits prompts with native undo', async () => {
    const result = await runUiFixture('tests/fixtures/image-mention-picker.html', {
        screenshotPath: process.env.CAINFLOW_MENTION_SCREENSHOT || null,
        windowSize: '620,760'
    });
    assert.equal(result.error, undefined);
    assert.equal(result.first.mode, 'true');
    assert.equal(result.first.active, 'product');
    assert.deepEqual(result.first.ids, ['product', 'lighting']);
    assert.equal(result.first.layout.thumbs, 2);
    assert.equal(result.keyboard, 'lighting');
    assert.deepEqual(result.inserted, { value: '保持主体，@图片2  不改变背景', caret: 10, closed: true, inputEvents: 2 });
    assert.equal(result.undo, '保持主体，@ 不改变背景');
    assert.deepEqual(result.search.ids, ['snow']);
    assert.match(result.search.source, /雪地构图\s+目录历史/);
    assert.equal(result.search.thumbnailReads, 1);
    assert.deepEqual(result.escape, { closed: true, value: '调整@雪地', focused: true });
    assert.deepEqual(result.extraAfterRace, { ids: ['generate'], noImageForNode: true });
    assert.ok(result.nested && result.nestedEscape);
    assert.ok(result.first.layout.above && result.first.layout.visible && result.final.above && result.final.visible);
    assert.equal(result.final.thumbs, 4);
});
