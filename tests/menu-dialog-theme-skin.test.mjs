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

test('legacy menu and dialog rules are frozen during the expand phase', async () => {
    const baselines = new Map([
        ['dark', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
        ['pro', '226d4f2614b9f2ab317d134c28b0438371c95e0ba73778fac3e3e9c45ae404be'],
        ['paper', '2afc304abe575bf6cc75cf651d06d3dca2846cc1c1413dec0eb0843150d75491'],
        ['light', 'ea28d742d728891d233060c7452a2412f7b5991832dbeb4194ad25af7ce61a31'],
        ['glass-light', 'd4cac835ed378112586bddcd6fe929e72eee75a9d5b90e7a1f95bf9530ff5d57'],
        ['glass-dark', '0ed4cfe4d9ceb060c8d190c4b96e415c003b77c41d47b55b245dc58149fc43c3'],
        ['pink', 'd913178a1e4952618065e3afbcd87a6a72c0dff47e4d9ccc3ab57e88b34fbcba'],
        ['shared', 'fa60e5022e399bd21e0c6105c0b05666791bfd91b13d1cf13c51391823dff666'],
    ]);
    for (const [themeId, expected] of baselines) {
        const path = themeId === 'shared' ? '../css/themes/shared.css' : `../css/themes/${themeId}.css`;
        const stylesheet = await readFile(new URL(path, import.meta.url), 'utf8');
        const legacyRules = [...stylesheet.matchAll(/([^{}]*[.](?:context-menu[\w-]*|theme-menu[\w-]*|modal[\w-]*|help-panel[\w-]*|provider-models[\w-]*|api-settings-help[\w-]*)[^{}]*\{[^{}]*\})/g)]
            .map((match) => match[1].replace(/\s+/g, ' ').trim())
            .sort()
            .join('\n');
        assert.equal(createHash('sha256').update(legacyRules).digest('hex'), expected, `${themeId} legacy menu/dialog rules are frozen until the contract tickets`);
    }
});
