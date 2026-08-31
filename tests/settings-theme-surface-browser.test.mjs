import assert from 'node:assert/strict';
import test from 'node:test';
import { composite, contrastRatio, parseColor, renderComputedFixture, verifyScreenshotMatrix } from './helpers/browser-theme-fixture.mjs';

const fixturePath = new URL('./fixtures/settings-theme-surface.html', import.meta.url);
const themeIds = ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink'];

function opaquePageBackground(measurement) {
    const browserCanvas = [255, 255, 255, 1];
    const root = composite(parseColor(measurement.actual.rootBackground), browserCanvas);
    return composite(parseColor(measurement.actual.pageBackground), root);
}

function firstShadowColor(shadow) {
    const color = shadow.match(/rgba?\([^)]*\)/)?.[0];
    assert.ok(color, `focus shadow must expose a computed color: ${shadow}`);
    return parseColor(color);
}

function renderFixture() {
    return renderComputedFixture(fixturePath, 'cainflow-settings-theme-');
}

test('settings surfaces render from the semantic palette in every supported theme', () => {
    const measurements = renderFixture();
    assert.equal(measurements.length, 7);

    for (const measurement of measurements) {
        const {
            rootBackground: _rootBackground,
            pageBackground: _pageBackground,
            overlayBackground: _overlayBackground,
            ...surfaceActual
        } = measurement.actual;
        assert.deepEqual(
            surfaceActual,
            measurement.semantic,
            `${measurement.themeId} settings surfaces must render from the semantic palette`,
        );
        assert.equal(
            measurement.semanticRolesPresent,
            true,
            `${measurement.themeId} must provide the shared panel and text roles`,
        );
        assert.equal(measurement.controlStates.length, 10);
        const pageBackground = opaquePageBackground(measurement);
        const overlayBackground = composite(parseColor(measurement.actual.overlayBackground), pageBackground);
        const panelBackground = composite(parseColor(measurement.actual.panelBackground), overlayBackground);
        const cardBackground = composite(parseColor(measurement.actual.cardBackground), panelBackground);
        const bodyText = composite(parseColor(measurement.actual.bodyTextColor), cardBackground);
        const bodyRatio = contrastRatio(bodyText, cardBackground);
        assert.ok(
            bodyRatio >= 4.5,
            `${measurement.themeId} settings body text contrast ${bodyRatio.toFixed(2)} must meet WCAG AA`,
        );
        for (const control of measurement.controlStates) {
            assert.deepEqual(
                control.actual,
                control.semantic,
                `${measurement.themeId} ${control.kind} ${control.state} must use the semantic state`,
            );
            if (control.state !== 'disabled') {
                const controlBackground = composite(parseColor(control.actual.background), cardBackground);
                const foreground = composite(parseColor(control.actual.color), controlBackground);
                const ratio = contrastRatio(foreground, controlBackground);
                assert.ok(
                    ratio >= 4.5,
                    `${measurement.themeId} ${control.kind} ${control.state} contrast ${ratio.toFixed(2)} must meet WCAG AA`,
                );
            }
        }
        assert.equal(measurement.actionStates.length, 12);
        for (const action of measurement.actionStates) {
            assert.deepEqual({ actual: action.actual, outline: action.outline }, action.semantic, `${measurement.themeId} ${action.kind} ${action.state} must consume semantic action roles`);
            assert.notEqual(action.actual.background, 'rgba(0, 0, 0, 0)', `${measurement.themeId} ${action.kind} ${action.state} needs a semantic surface`);
            assert.ok(action.actual.border, `${measurement.themeId} ${action.kind} ${action.state} needs a semantic border`);
            if (action.state !== 'disabled') {
                const actionBackground = composite(parseColor(action.actual.background), cardBackground);
                const actionText = composite(parseColor(action.actual.color), actionBackground);
                const actionRatio = contrastRatio(actionText, actionBackground);
                assert.ok(actionRatio >= 4.5, `${measurement.themeId} ${action.kind} ${action.state} contrast ${actionRatio.toFixed(2)} must meet WCAG AA: ${JSON.stringify(action.actual)}`);
            }
        }
        for (const focusedAction of measurement.actionStates.filter((action) => action.state === 'focus')) {
            assert.notEqual(focusedAction.outline, 'none', `${measurement.themeId} ${focusedAction.kind} focused action needs a visible outline`);
            const outlineColor = parseColor(focusedAction.outline.match(/rgba?\([^)]*\)/)[0]);
            assert.ok(contrastRatio(outlineColor, cardBackground) >= 3, `${measurement.themeId} ${focusedAction.kind} focus outline must meet 3:1`);
        }
        assert.equal(measurement.toggleStates.length, 4);
        assert.ok(Number(measurement.actual.overlayZIndex) >= Number(measurement.actual.modalLayer), `${measurement.themeId} settings modal must occupy the modal layer`);
        assert.ok(Number(measurement.actual.overlayZIndex) > Number(measurement.actual.toolbarLayer), `${measurement.themeId} settings modal must cover the toolbar layer`);
        assert.ok(Number(measurement.actual.overlayZIndex) > Number(measurement.actual.menuLayer), `${measurement.themeId} settings modal must cover ordinary menus`);
        assert.notDeepEqual(
            measurement.toggleStates[0].actual,
            measurement.toggleStates[1].actual,
            `${measurement.themeId} toggle on and off states must be distinct`,
        );
        assert.notEqual(measurement.toggleStates[2].outline, 'none', `${measurement.themeId} toggle focus must be visible`);
        assert.notEqual(measurement.toggleStates[3].opacity, measurement.toggleStates[0].opacity, `${measurement.themeId} disabled toggle must be visually distinct`);
        for (const kind of ['input', 'select']) {
            const normal = measurement.controlStates.find((control) => control.kind === kind && control.state === 'normal');
            const focus = measurement.controlStates.find((control) => control.kind === kind && control.state === 'focus');
            assert.notEqual(focus.actual.shadow, 'none', `${measurement.themeId} ${kind} focus ring must be visible`);
            assert.notDeepEqual(
                { border: focus.actual.border, shadow: focus.actual.shadow },
                { border: normal.actual.border, shadow: normal.actual.shadow },
                `${measurement.themeId} ${kind} focus must be visually distinct from normal`,
            );
            const focusRing = composite(firstShadowColor(focus.actual.shadow), cardBackground);
            const focusRatio = contrastRatio(focusRing, cardBackground);
            assert.ok(
                focusRatio >= 3,
                `${measurement.themeId} ${kind} focus ring contrast ${focusRatio.toFixed(2)} must meet WCAG 2.2 non-text contrast`,
            );
        }
    }
});

test('seven-theme settings state matrix produces distinct browser screenshots', () => {
    verifyScreenshotMatrix({
        fixtureUrl: fixturePath,
        baselineDirectoryUrl: new URL('./visual-baselines/settings-theme-surface/', import.meta.url),
        profilePrefix: 'cainflow-settings-screenshots-',
        themeIds,
    });
});
