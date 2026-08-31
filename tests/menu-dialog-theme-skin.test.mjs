import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('migrated menu rules cannot return and dialog rules stay frozen', async () => {
    const baselines = new Map([
        ['dark', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
        ['pro', 'e49df380ab18d7f4c7fbf1b1cb5cb896d84e59bd899f90be54ba7ecc7343269c'],
        ['paper', 'bd9862f5c536cd72ee646506499a7ba868a66dd4b0e80b9c9be6631fa170669c'],
        ['light', 'd945eb8cb631cc46c15328fb2380b9ac5680d2e7ccac3db5b46a4cc79aa638ca'],
        ['glass-light', '7bf6335030a9b4c4c3f49aa913007b52064652fe8ca8b7f263288ad447507262'],
        ['glass-dark', 'bfde8b83a871b09b16e7dbc5e8041e061367a9a4f32b8259f0b21dceb5996218'],
        ['pink', '3432568211c2bb285dee3547866293671c5671e0c4980dcf6159adb3e6eb330c'],
    ]);
    for (const [themeId, expected] of baselines) {
        const stylesheet = await readFile(new URL(`../css/themes/${themeId}.css`, import.meta.url), 'utf8');
        assert.doesNotMatch(stylesheet, /html\[data-app-theme=[^\]]+\][^{}]*(?:[.](?:context-menu[\w-]*|theme-menu[\w-]*)|#(?:workflow-(?:folder-)?context-menu|context-menu))/);
        const legacyRules = [...stylesheet.matchAll(/([^{}]*[.](?:modal[\w-]*|help-panel[\w-]*|provider-models[\w-]*|api-settings-help[\w-]*)[^{}]*\{[^{}]*\})/g)]
            .map((match) => match[1].replace(/\s+/g, ' ').trim())
            .sort()
            .join('\n');
        assert.equal(createHash('sha256').update(legacyRules).digest('hex'), expected, `${themeId} dialog rules are frozen until the dialog contract ticket`);
    }
    const shared = await readFile(new URL('../css/themes/shared.css', import.meta.url), 'utf8');
    assert.doesNotMatch(shared, /html\[data-app-theme=[^\]]+\][^{}]*[.]theme-menu/);
});
