import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseColor, renderComputedFixture } from './helpers/browser-theme-fixture.mjs';

test('Light ordinary interaction roles resolve to the approved teal family', async () => {
    const stylesheet = await readFile(new URL('../css/themes/light.css', import.meta.url), 'utf8');

    for (const role of ['--accent-primary', '--accent-purple', '--accent-blue', '--accent-cyan', '--panel-accent-text', '--panel-primary-action-bg']) {
        assert.match(stylesheet, new RegExp(`${role}:\\s*(?:#0f766e|#0e7490|#115e59)`), `${role} must resolve to the Light teal interaction family`);
    }

    for (const legacyColor of ['rgba(109, 40, 217', 'rgba(67, 56, 202', 'rgba(79, 70, 229', 'rgba(37, 99, 235', '#2563eb', '#1d4ed8', '#1e40af']) {
        assert.equal(stylesheet.includes(legacyColor), false, `${legacyColor} must not return to ordinary Light interactions`);
    }
    assert.match(stylesheet, /--port-image:\s*#7c3aed/, 'image ports remain a distinct type semantic');
    assert.match(stylesheet, /--accent-green:\s*#059669/, 'success remains a state semantic');
    assert.match(stylesheet, /--accent-orange:\s*#d97706/, 'warning remains a state semantic');
    assert.match(stylesheet, /--accent-red:\s*#dc2626/, 'failure remains a state semantic');
});

test('Light renders ordinary menu and dialog interactions from the teal family', () => {
    const fixture = new URL('./fixtures/menu-dialog-theme-surface.html', import.meta.url);
    const light = renderComputedFixture(fixture, 'cainflow-light-interaction-').find(({ themeId }) => themeId === 'light');

    assert.deepEqual(parseColor(light.semantic['--panel-accent-text']), [15, 118, 110, 1]);
    assert.deepEqual(parseColor(light.semantic['--panel-accent-bg']), [15, 118, 110, 0.08]);
    assert.deepEqual(parseColor(light.semantic['--menu-active-bg']), [15, 118, 110, 0.1]);
    assert.deepEqual(parseColor(light.states.find(({ state }) => state === 'open').background), [15, 118, 110, 0.1]);
});
