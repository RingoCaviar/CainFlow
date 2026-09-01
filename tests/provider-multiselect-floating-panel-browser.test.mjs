import assert from 'node:assert/strict';
import test from 'node:test';
import { renderComputedFixture } from './helpers/browser-theme-fixture.mjs';

const fixturePath = new URL('./fixtures/provider-multiselect-floating-panel.html', import.meta.url);

test('floating provider menu keeps the settings panel surface when appended to document body', () => {
    const measurement = renderComputedFixture(fixturePath, 'cainflow-provider-menu-');
    assert.notEqual(measurement.panelBackground, 'rgba(0, 0, 0, 0)');
    assert.notEqual(measurement.panelBorder, 'rgba(0, 0, 0, 0)');
    assert.notEqual(measurement.optionBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(measurement.checkboxOpacity, '0');
});
