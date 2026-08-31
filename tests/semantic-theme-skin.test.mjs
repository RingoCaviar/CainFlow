import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('the settings feature skin owns button and toggle interaction states', async () => {
    const stylesheet = await readFile(new URL('../css/features/settings-theme-skin.css', import.meta.url), 'utf8');
    for (const role of ['secondary', 'primary', 'danger', 'focus-ring']) {
        assert.match(stylesheet, new RegExp(`--settings-action-${role}`));
    }
    for (const role of ['off-bg', 'on-bg', 'thumb']) {
        assert.match(stylesheet, new RegExp(`--settings-toggle-${role}`));
    }
    assert.match(stylesheet, /\.btn-danger[^{}]*:is\(:hover, \.is-hovered\)/);
    assert.match(stylesheet, /:is\(:focus-visible, \.is-focused\)/);
    assert.match(stylesheet, /\.toggle-switch input:checked \+ \.toggle-slider/);
    assert.match(stylesheet, /\.toggle-switch input:disabled \+ \.toggle-slider/);
    assert.match(stylesheet, /\.card-btn-delete/);
    assert.match(stylesheet, /\.btn-delete-protocol/);
});

test('legacy theme button and toggle overrides cannot grow during migration', async () => {
    const baselines = new Map([
        ['dark', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
        ['pro', '3ed8fbffba6ee68f6f4d4b1f201f66aafb8f8b22e4bc9d1a88e86540b528d64e'],
        ['paper', '499ee269eb79212df71619205e852efad588f71c11435cf1ed521b2a682a7df5'],
        ['light', '686872947e390de885495f96ef0d9409f14925cb952f33ad2cedb5dbb7264730'],
        ['glass-light', '92623c50d537044cf48d4222e41e1a3819ee46642c786e7be3f51a497150b37a'],
        ['glass-dark', '121cf92fc3899f98ab8788ad49c2d0ed4a6a829a90a5b925c1264a82143572f5'],
        ['pink', 'e01fa9ce6b7c5eab74c0fb022d59b61a6bd221bff69b25241eba495ba26e4488'],
    ]);
    for (const [themeId, expected] of baselines) {
        const stylesheet = await readFile(new URL(`../css/themes/${themeId}.css`, import.meta.url), 'utf8');
        const legacyRules = [...stylesheet.matchAll(/([^{}]*(?:[.]btn-(?:primary|secondary|danger|ghost|accent)|[.]card-btn-fetch-models|[.]toggle-slider|[.]toggle-switch)[^{}]*\{[^{}]*\})/g)]
            .map((match) => match[1].replace(/\s+/g, ' ').trim())
            .sort()
            .join('\n');
        assert.equal(createHash('sha256').update(legacyRules).digest('hex'), expected, `${themeId} legacy action overrides may only shrink in #57`);
    }
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
