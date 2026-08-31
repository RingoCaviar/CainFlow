import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const themes = ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink'];

test('menu and dialog skin is loaded after theme styles', async () => {
    const entry = await readFile(new URL('../index.css', import.meta.url), 'utf8');
    assert.ok(entry.indexOf('menu-dialog-theme-skin.css') > entry.indexOf('themes.css'));
});

test('menu and dialog skin exposes the semantic contract and representative states', async () => {
    const skin = await readFile(new URL('../css/features/menu-dialog-theme-skin.css', import.meta.url), 'utf8');
    for (const role of [
        'menu-surface', 'menu-border', 'menu-text', 'menu-muted-text', 'menu-hover-bg',
        'menu-active-bg', 'menu-danger-text', 'menu-focus-ring', 'dialog-backdrop',
        'dialog-surface', 'dialog-border', 'dialog-divider', 'dialog-shadow',
    ]) {
        assert.match(skin, new RegExp(`--${role}:\\s*var\\(--`), `--${role} must map to the semantic palette`);
    }
    assert.match(skin, /[.]context-menu-item[^{}]*:is\(:hover, :focus-visible, [.]is-hovered, [.]is-focused\)/);
    assert.match(skin, /[.]context-menu-item[.]is-open/);
    assert.match(skin, /aria-disabled="true"/);
    assert.match(skin, /[.]context-menu-item[.]delete/);
    assert.match(skin, /[.]provider-models-panel/);
    assert.match(skin, /[.]api-settings-help-panel/);
    assert.doesNotMatch(skin, /data-app-theme|#[0-9a-f]{3,8}\b|rgba?\s*\(/i);
});

test('every supported theme supplies the shared palette consumed by menu and dialog skin', async () => {
    for (const themeId of themes) {
        const theme = await readFile(new URL(`../css/themes/${themeId}.css`, import.meta.url), 'utf8');
        for (const role of ['panel-bg-strong', 'panel-border-strong', 'panel-shadow-soft', 'panel-shadow-strong', 'panel-hover-bg', 'panel-active-bg']) {
            assert.match(theme, new RegExp(`--${role}:`), `${themeId} must provide --${role}`);
        }
    }
});

test('migrated menu and dialog theme-qualified rules cannot return', async () => {
    for (const themeId of themes) {
        const stylesheet = await readFile(new URL(`../css/themes/${themeId}.css`, import.meta.url), 'utf8');
        assert.doesNotMatch(stylesheet, /html\[data-app-theme=[^\]]+\][^{}]*(?:[.](?:context-menu[\w-]*|theme-menu[\w-]*|modal[\w-]*|update-modal[\w-]*|help-(?:panel|close-btn)[\w-]*|provider-models[\w-]*|api-settings-help[\w-]*)|#(?:workflow-(?:folder-)?context-menu|context-menu))/);
    }
    const shared = await readFile(new URL('../css/themes/shared.css', import.meta.url), 'utf8');
    assert.doesNotMatch(shared, /html\[data-app-theme=[^\]]+\][^{}]*[.]theme-menu/);
});
