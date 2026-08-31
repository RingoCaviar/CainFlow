import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const settingsSurfaceRoles = [
    '--settings-dialog-panel-bg',
    '--settings-dialog-panel-border',
    '--settings-dialog-panel-shadow',
    '--settings-dialog-divider',
    '--settings-dialog-section-bg',
    '--settings-dialog-section-border',
    '--settings-dialog-text',
    '--settings-dialog-muted-text',
];

test('the settings surface contract maps feature roles to the shared panel palette', async () => {
    const stylesheet = await readFile(
        new URL('../css/features/settings.css', import.meta.url),
        'utf8',
    );

    for (const role of settingsSurfaceRoles) {
        assert.match(
            stylesheet,
            new RegExp(`${role.replaceAll('-', '\\-')}\\s*:\\s*var\\(--(?:panel|text)-`),
            `${role} must map to the shared semantic palette`,
        );
    }
});

test('the settings feature skin consumes the surface semantic roles', async () => {
    const stylesheet = await readFile(
        new URL('../css/features/settings-theme-skin.css', import.meta.url),
        'utf8',
    );

    assert.match(stylesheet, /#settings-modal\s+\.modal-panel\s*\{[\s\S]*?background:\s*var\(--settings-dialog-panel-bg\)/);
    assert.match(stylesheet, /#settings-modal\s+\.modal-panel\s*\{[\s\S]*?border(?:-color)?:[^;}]*var\(--settings-dialog-panel-border\)/);
    assert.match(stylesheet, /#settings-modal\s+:is\(\.modal-header,\s*\.modal-tabs\)[\s\S]*?var\(--settings-dialog-divider\)/);
    assert.match(stylesheet, /#settings-modal\s+:is\(\.api-config-card,\s*\.general-settings-card\),[\s\S]*?var\(--settings-dialog-section-bg\)/);
    assert.match(stylesheet, /#settings-modal\s+:is\(\.api-config-card,\s*\.general-settings-card\),[\s\S]*?border-color:\s*var\(--settings-dialog-panel-border\)/);
    assert.match(stylesheet, /#settings-modal\s+:is\(\.endpoint-preview,\s*\.footer-left,\s*\.footer-left span\)[\s\S]*?var\(--settings-dialog-muted-text\)/);
});

test('the settings feature skin owns input and select interaction states', async () => {
    const stylesheet = await readFile(
        new URL('../css/features/settings-theme-skin.css', import.meta.url),
        'utf8',
    );

    for (const state of ['hover', 'focus', 'disabled', 'error']) {
        assert.match(stylesheet, new RegExp(`--settings-input-${state}-`));
    }

    assert.match(stylesheet, /input:not\(\[type\]\)/);
    for (const type of ['text', 'password', 'number', 'email', 'url', 'search', 'tel']) {
        assert.match(stylesheet, new RegExp(`\\[type="${type}"\\]`));
    }
    for (const type of ['checkbox', 'range', 'radio', 'file', 'hidden', 'color', 'date']) {
        assert.doesNotMatch(stylesheet, new RegExp(`input[^,{]*\\[type="${type}"\\]`));
    }
    assert.match(stylesheet, /:is\(:hover, \.is-hovered\)/);
    assert.match(stylesheet, /:is\(:focus-visible, \.is-focused\)/);
    assert.match(stylesheet, /:is\(:disabled, \[aria-disabled="true"\]\)/);
    assert.match(stylesheet, /:is\(\[aria-invalid="true"\], \.is-invalid\)/);
});

test('the migrated control state layer only consumes semantic values', async () => {
    const stylesheet = await readFile(
        new URL('../css/features/settings-theme-skin.css', import.meta.url),
        'utf8',
    );
    const controlLayer = stylesheet.slice(stylesheet.indexOf('html:root #settings-modal.modal-overlay :is(input'));
    assert.doesNotMatch(controlLayer, /!important/);
    assert.doesNotMatch(controlLayer, /#[0-9a-f]{3,8}\b|rgba?\s*\(/i);
});

test('real settings controls and body copy do not bypass the semantic skin inline', async () => {
    const sources = await Promise.all([
        '../js/features/settings/model-settings.js',
        '../js/features/settings/provider-settings.js',
        '../index.html',
    ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
    const source = sources.join('\n');
    assert.doesNotMatch(source, /class="card-name"[^>]*style=/);
    assert.doesNotMatch(source, /class="endpoint-preview"[^>]*style="[^"]*(?:color|opacity)\s*:/);
    assert.doesNotMatch(source, /class="footer-left"[\s\S]{0,160}<span[^>]*style="[^"]*(?:color|opacity)\s*:/);
    const featureStylesheet = await readFile(new URL('../css/features/settings.css', import.meta.url), 'utf8');
    assert.doesNotMatch(featureStylesheet, /\.card-name[^{}]*\{[^{}]*color\s*:[^;}]*!important/);
});

test('theme files cannot restyle migrated settings text inputs or selects', async () => {
    for (const themeId of ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink']) {
        const stylesheet = await readFile(
            new URL(`../css/themes/${themeId}.css`, import.meta.url),
            'utf8',
        );
        const migratedRules = [...stylesheet.matchAll(/([^{}]*(?:#settings-modal|\.(?:api-config-card|general-settings-card))[^{}]*(?:input|select)[^{}]*)\{/g)]
            .map((match) => match[1].trim())
            .filter((selector) => /(?:^|[\s>])(?:input|select)(?:\b|[.#:\[])/.test(selector))
            .filter((selector) => !/type="(?:checkbox|range)"|notification-volume-slider|retry-input-group|toggle-switch/.test(selector));
        const cardNameRules = [...stylesheet.matchAll(/([^{}]*#settings-modal[^{}]*\.card-name[^{}]*)\{/g)]
            .map((match) => match[1].trim());
        assert.deepEqual(
            [...migratedRules, ...cardNameRules],
            [],
            `${themeId} must leave migrated settings controls to settings-theme-skin.css`,
        );
    }
});
