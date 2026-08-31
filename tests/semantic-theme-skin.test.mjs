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
