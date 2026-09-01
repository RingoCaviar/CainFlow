import assert from 'node:assert/strict';
import test from 'node:test';
import { composite, contrastRatio, parseColor, renderComputedFixture, renderHoveredFixture } from './helpers/browser-theme-fixture.mjs';

test('all themes render a continuous node-state border surface', () => {
    const fixture = new URL('./fixtures/node-theme-surface.html', import.meta.url);
    const stateSignature = (state) => [state.border, state.width, state.nodeShadow].join('|');
    const results = renderComputedFixture(fixture, 'cainflow-node-theme-');
    for (const [themeId, result] of Object.entries(results)) {
        for (const state of ['normal', 'selected', 'running', 'error', 'disabled'].map((stateId) => result[stateId])) {
            assert.notEqual(state.border, 'rgba(0, 0, 0, 0)', `${themeId} must render a visible node border`);
            assert.ok(Number.parseFloat(state.width) >= 1, `${themeId} must retain a physical node border`);
        }
        assert.notEqual(stateSignature(result.selected), stateSignature(result.normal), `${themeId} selection must be distinguishable`);
        assert.notEqual(stateSignature(result.running), stateSignature(result.normal), `${themeId} running state must be distinguishable`);
        assert.notEqual(stateSignature(result.error), stateSignature(result.normal), `${themeId} error state must be distinguishable`);
        assert.ok(Number.parseFloat(result.disabled.opacity) < 1, `${themeId} disabled nodes must be visibly subdued`);
        assert.notEqual(result.focusedControl.border, 'rgba(0, 0, 0, 0)', `${themeId} focused controls must retain a visible border`);
    }
});

test('glass node material is isolated to glass themes and disables compositing while interacting', () => {
    const fixture = new URL('./fixtures/node-theme-surface.html', import.meta.url);
    const resting = renderComputedFixture(fixture, 'cainflow-node-glass-rest-');
    for (const themeId of ['dark', 'pro', 'paper', 'light', 'pink']) {
        assert.equal(resting[themeId].normal.backdropFilter, 'none', `${themeId} must not apply glass compositing`);
    }
    for (const themeId of ['glass-light', 'glass-dark']) {
        assert.notEqual(resting[themeId].normal.backdropFilter, 'none', `${themeId} must retain its glass material at rest`);
    }
    assert.notEqual(resting['glass-light'].normal.backgroundImage, resting['glass-dark'].normal.backgroundImage, 'glass themes must retain distinct material treatments');

    const interacting = renderComputedFixture(new URL(`${fixture}?interaction=zoom`), 'cainflow-node-glass-interacting-');
    for (const themeId of ['glass-light', 'glass-dark']) {
        assert.equal(interacting[themeId].normal.backdropFilter, 'none', `${themeId} must disable glass compositing while zooming`);
    }
});

test('all themes expose a real hovered node surface', async () => {
    const fixture = new URL('./fixtures/node-theme-surface.html', import.meta.url);
    for (const themeId of ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink']) {
        const hovered = await renderHoveredFixture(new URL(`${fixture}?theme=${themeId}`), `cainflow-node-hover-${themeId}-`);
        assert.equal(hovered.matchesHover, true, `${themeId} must apply the real :hover pseudo-class`);
        assert.notEqual(`${hovered.border}|${hovered.shadow}`, `${hovered.normal.border}|${hovered.normal.shadow}`, `${themeId} hover must change the node shell feedback`);
    }
});

test('all themes render error popovers above node content with readable text', () => {
    const fixture = new URL('./fixtures/node-theme-surface.html', import.meta.url);
    const results = renderComputedFixture(fixture, 'cainflow-node-popup-');
    for (const [themeId, result] of Object.entries(results)) {
        assert.equal(result.errorPopover.topmostAtOverlap, 'error-popover', `${themeId} error popover must layer above the node`);
        const surface = composite(parseColor(result.errorPopover.surfaceColor), parseColor(result.errorPopover.canvasColor));
        assert.ok(contrastRatio(parseColor(result.errorPopover.textColor), surface) >= 4.5, `${themeId} error popover text must meet AA contrast`);
    }
});

test('all themes render distinguishable connection-gesture node feedback', () => {
    const fixture = new URL('./fixtures/node-theme-surface.html', import.meta.url);
    const results = renderComputedFixture(fixture, 'cainflow-node-gesture-');
    for (const [themeId, result] of Object.entries(results)) {
        const normal = `${result.normal.border}|${result.normal.nodeShadow}`;
        for (const [stateId, state] of Object.entries(result.connectionGestures)) {
            assert.notEqual(state.border, 'rgba(0, 0, 0, 0)', `${themeId} ${stateId} must retain a visible border`);
            assert.notEqual(`${state.border}|${state.nodeShadow}`, normal, `${themeId} ${stateId} must be distinguishable from a normal node`);
        }
    }
});

test('all themes visibly subdue batch-connection dimmed nodes', () => {
    const fixture = new URL('./fixtures/node-theme-surface.html', import.meta.url);
    const results = renderComputedFixture(fixture, 'cainflow-node-batch-dimmed-');
    for (const [themeId, result] of Object.entries(results)) {
        assert.ok(Number.parseFloat(result.batchDimmed.opacity) < Number.parseFloat(result.normal.opacity), `${themeId} must visibly subdue batch-connection dimmed nodes`);
        assert.notEqual(result.batchDimmed.filter, 'none', `${themeId} must retain the dimmed-state filter`);
    }
});
