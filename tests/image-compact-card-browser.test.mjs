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
    assert.ok(bound.afterModelSwitchHeight < bound.beforeModelSwitchHeight - 30, JSON.stringify(bound));
    assert.ok(bound.afterModelSwitchMinimum < bound.beforeModelSwitchMinimum - 30, JSON.stringify(bound));
    assert.equal(bound.afterModelSwitchWidth, 460);
    assert.ok(bound.restoredModelHeight > bound.afterModelSwitchHeight + 30, JSON.stringify(bound));
    assert.ok(bound.afterProviderSwitchHeight < bound.beforeProviderSwitchHeight - 15, JSON.stringify(bound));
    assert.ok(bound.restoredProviderHeight > bound.afterProviderSwitchHeight + 15, JSON.stringify(bound));
    assert.ok(bound.geometry > 0);
    assert.match(bound.summary, /背景：透明/);
    assert.ok(bound.hiddenOther && bound.restored);
    assert.equal(bound.saved, 'transparent');
    assert.equal(bound.persisted, 'transparent');
    assert.deepEqual(bound.initialSize, {
        resolution: '', aspectDisabled: true, aspectLabel: '由模型决定', requested: '自动（由模型决定）'
    });
    assert.deepEqual(bound.autoAspectDropdown, { triggerDisabled: true, expanded: 'false', panelHidden: true, enabledOptionCount: 0 });
    assert.deepEqual(bound.presetSize, {
        resolution: '2K', aspect: '16:9', requested: '2048 × 1152 px', readonly: true, customHidden: true
    });
    assert.equal(bound.noAutoAspectOption, true);
    assert.equal(bound.presetDropdownOpened, true);
    assert.deepEqual(bound.squareAspectSize, {
        resolution: '2K', aspect: '1:1', requested: '2048 × 2048 px', savedResolution: '2K'
    });
    assert.deepEqual(bound.restoredAspectSize, {
        resolution: '2K', aspect: '16:9', requested: '2048 × 1152 px', savedResolution: '2K'
    });
    assert.deepEqual(bound.aspectFirst, { resolution: '1K', requested: '1536 × 864 px' });
    assert.deepEqual(bound.seededCustom, { width: '2048', height: '1152' });
    assert.deepEqual(bound.customSize, {
        editable: true, outputHidden: true, aspectDisabled: true, aspectLabel: '由自定义宽高决定', hint: ''
    });
    assert.deepEqual(bound.customAspectDropdown, { triggerDisabled: true, expanded: 'false', panelHidden: true, enabledOptionCount: 0 });
    assert.deepEqual(bound.otherModelSize, {
        resolution: '', customAvailable: false, aspectDisabled: false, autoAspectAvailable: true, requested: '默认（未指定）',
        triggerDisabled: false, dropdownOpened: true
    });
});
