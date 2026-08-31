import assert from 'node:assert/strict';
import test from 'node:test';
import { composite, contrastRatio, parseColor, renderComputedFixture } from './helpers/browser-theme-fixture.mjs';

function renderFixture() {
    return renderComputedFixture(new URL('./fixtures/menu-dialog-theme-surface.html', import.meta.url), 'cainflow-menu-dialog-');
}

test('menu and dialog semantic states render in all supported themes', () => {
    const results = renderFixture();
    assert.equal(results.length, 7);
    for (const result of results) {
        assert.ok(Object.values(result.semantic).every(Boolean), `${result.themeId} must resolve every menu/dialog role`);
        assert.equal(result.states.length, 6);
        assert.deepEqual(parseColor(result.menu.background), parseColor(result.semantic['--menu-surface']));
        assert.deepEqual(parseColor(result.menu.border), parseColor(result.semantic['--menu-border']));
        assert.deepEqual(parseColor(result.dialog.panel.background), parseColor(result.semantic['--dialog-surface']));
        assert.deepEqual(parseColor(result.dialog.panel.border), parseColor(result.semantic['--dialog-border']));
        assert.deepEqual(parseColor(result.states.find(({ state }) => state === 'hover').background), parseColor(result.semantic['--menu-hover-bg']));
        assert.deepEqual(parseColor(result.states.find(({ state }) => state === 'open').background), parseColor(result.semantic['--menu-active-bg']));
        assert.deepEqual(parseColor(result.states.find(({ state }) => state === 'danger').color), parseColor(result.semantic['--menu-danger-text']));
        assert.notEqual(result.states.find(({ state }) => state === 'focus').outline, 'none');
        assert.equal(result.themeMenuStates.length, 3);
        assert.deepEqual(parseColor(result.themeMenuStates.find(({ state }) => state === 'focus').background), parseColor(result.semantic['--menu-hover-bg']));
        assert.deepEqual(parseColor(result.themeMenuStates.find(({ state }) => state === 'active').background), parseColor(result.semantic['--menu-active-bg']));
        assert.ok(Number(result.actualLayers.modal) > Number(result.actualLayers.menu));
        assert.equal(result.actualLayers.menu, result.layers.menu);
        assert.equal(Number(result.actualLayers.submenu), Number(result.layers.menu) + 1);
        assert.equal(result.actualLayers.modal, result.layers.modal);
        assert.equal(result.actualLayers.provider, result.layers.popover);
        assert.equal(result.actualLayers.settingsHelp, result.layers.popover);
        assert.equal(result.actualLayers.help, result.layers.drawer);
        assert.ok(Number(result.layers.drawer) < Number(result.layers.menu));
        assert.ok(Number(result.layers.menu) < Number(result.layers.modal));
        assert.ok(Number(result.layers.modal) < Number(result.layers.popover));
        for (const [kind, dialog] of Object.entries(result.auxiliaryDialogs)) {
            assert.deepEqual(parseColor(dialog.panel.background), parseColor(result.semantic['--dialog-surface']), `${result.themeId} ${kind} dialog must use the semantic surface`);
            assert.deepEqual(parseColor(dialog.panel.border), parseColor(result.semantic['--dialog-border']), `${result.themeId} ${kind} dialog must use the semantic border`);
            assert.deepEqual(parseColor(dialog.header.border), parseColor(result.semantic['--dialog-divider']), `${result.themeId} ${kind} header must use the dialog divider`);
            if (dialog.close) {
                assert.deepEqual(parseColor(dialog.close.color), parseColor(result.semantic['--dialog-muted-text']), `${result.themeId} ${kind} close must use muted dialog text`);
            }
        }
        const normal = result.states.find(({ state }) => state === 'normal');
        const menuBackground = composite(parseColor(result.menu.background), [255, 255, 255, 1]);
        const dialogBackground = composite(parseColor(result.dialog.panel.background), [255, 255, 255, 1]);
        assert.ok(contrastRatio(composite(parseColor(normal.color), menuBackground), menuBackground) >= 4.5, `${result.themeId} menu text must meet WCAG AA`);
        assert.ok(contrastRatio(composite(parseColor(result.dialog.body.color), dialogBackground), dialogBackground) >= 4.5, `${result.themeId} dialog text must meet WCAG AA`);
        const focus = result.states.find(({ state }) => state === 'focus');
        const focusColor = parseColor(focus.outline.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i)[0]);
        assert.ok(contrastRatio(composite(focusColor, menuBackground), menuBackground) >= 3, `${result.themeId} menu focus ring must meet 3:1`);
    }
});
