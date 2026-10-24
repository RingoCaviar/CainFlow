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
    assert.deepEqual(result.initial, { disabled: true, checked: true, help: '当前接口未接入联网搜索' });
    assert.deepEqual(result.google, { disabled: false, checked: true, saved: true });
    assert.deepEqual(result.openai, { disabled: true, checked: true, saved: true, help: '当前接口未接入联网搜索' });
    assert.deepEqual(result.restoredGoogle, { disabled: false, checked: true, saved: true });
    assert.deepEqual(result.offPreference, { disabled: false, checked: false, saved: false });
    assert.deepEqual(result.googleProvider, { disabled: false, checked: true, saved: true });
    assert.deepEqual(result.openaiProvider, { disabled: true, checked: true, saved: true });
    assert.equal(result.cloneSearchDisabled, true);
});
