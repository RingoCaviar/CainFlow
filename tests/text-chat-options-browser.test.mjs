import test from 'node:test';
import assert from 'node:assert/strict';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('chat options explain their behavior, remain usable at narrow widths, and preserve search preference across interfaces', async () => {
    const result = await runUiFixture('tests/fixtures/text-chat-options.html');
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.themes.length, 7);
    for (const theme of result.themes) {
        assert.equal(theme.namedSwitches, true, theme.theme);
        assert.equal(theme.visibleDescriptions, true, theme.theme);
        assert.equal(theme.contained, true, theme.theme);
        assert.equal(theme.labelTogglesSwitch, true, theme.theme);
        assert.equal(theme.focusVisible, true, theme.theme);
    }
    assert.deepEqual(result.initial, { disabled: false, checked: true, help: '查询网页补充回答，需接口支持' });
    assert.deepEqual(result.openaiOff, { disabled: false, checked: false, saved: false });
    assert.deepEqual(result.openaiOn, { disabled: false, checked: true, saved: true });
    assert.deepEqual(result.google, { disabled: false, checked: true, saved: true });
    assert.deepEqual(result.openai, { disabled: false, checked: true, saved: true, help: '查询网页补充回答，需接口支持' });
    assert.deepEqual(result.restoredGoogle, { disabled: false, checked: true, saved: true });
    assert.deepEqual(result.offPreference, { disabled: false, checked: false, saved: false });
    assert.deepEqual(result.googleProvider, { disabled: false, checked: true, saved: true });
    assert.deepEqual(result.openaiProvider, { disabled: false, checked: true, saved: true });
    assert.equal(result.runningLockDisabled, true);
    assert.equal(result.unlockedSearchEnabled, true);
    assert.equal(result.cloneSearchDisabled, true);
});
