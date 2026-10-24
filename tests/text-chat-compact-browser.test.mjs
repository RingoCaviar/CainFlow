import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('chat cards keep optional instructions and empty results compact without losing saved content or dimensions', async () => {
    const result = await runUiFixture('tests/fixtures/text-chat-compact.html');
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.themes.length, 7);
    for (const item of result.themes) {
        assert.ok(item.systemCollapsed && item.systemSummary, item.theme);
        assert.ok(item.emptyHeight <= 44, JSON.stringify(item));
        assert.ok(item.systemExpandedHeight > item.closedHeight + 70, JSON.stringify(item));
        assert.equal(item.savedSystemHeight, 104, item.theme);
        assert.equal(item.savedResponseHeight, 220, item.theme);
        assert.equal(item.savedSystem, '新的系统提示语，请先分析再回答。', item.theme);
        assert.ok(item.responseHeight >= 218 && item.copyWorks, JSON.stringify(item));
        assert.ok(item.previewWorks && item.previewEscape && item.previewReturnsFocus, JSON.stringify(item));
        assert.ok(item.fontSize >= 14 && item.helpSize >= 12, JSON.stringify(item));
        assert.ok(item.instructionsHidden && item.longInstructionsAvailable, item.theme);
        assert.ok(item.restoredText && item.restoredSystemHeight && item.restoredResponseHeight, JSON.stringify(item));
    }
    assert.ok(result.cloneReadOnly && result.cloneCanReadResult, JSON.stringify(result));
    assert.ok(result.loadingCompact && result.loadingActionsDisabled && result.savedResponseWhileLoading === 220, JSON.stringify(result));
    assert.ok(result.resultReturnsToSavedHeight, JSON.stringify(result));
});
