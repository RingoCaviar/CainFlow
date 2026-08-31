import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { composite, contrastRatio, parseColor, renderComputedFixture } from './helpers/browser-theme-fixture.mjs';

test('Glass and Pink themes declare their approved ordinary interaction families', async () => {
    const themes = await Promise.all(['glass-light', 'glass-dark', 'pink'].map(async (theme) => [theme, await readFile(new URL(`../css/themes/${theme}.css`, import.meta.url), 'utf8')]));
    const expected = {
        'glass-light': /--accent-primary:\s*#0e7490/,
        'glass-dark': /--accent-primary:\s*#7dd3fc/,
        pink: /--accent-primary:\s*#ec4899/,
    };

    for (const [theme, stylesheet] of themes) {
        assert.match(stylesheet, expected[theme], `${theme} declares its ordinary interaction family`);
        assert.match(stylesheet, /--accent-green:/, `${theme} preserves success semantics`);
        assert.match(stylesheet, /--accent-orange:/, `${theme} preserves warning semantics`);
        assert.match(stylesheet, /--accent-red:/, `${theme} preserves failure semantics`);
        assert.match(stylesheet, /--port-image:/, `${theme} preserves image-port semantics`);
    }

    const glassLight = themes.find(([theme]) => theme === 'glass-light')[1];
    for (const legacyColor of ['rgba(37, 99, 235', '#2563eb', '#1d4ed8']) {
        assert.equal(glassLight.includes(legacyColor), false, `${legacyColor} must not return to Glass Light ordinary interactions`);
    }
});

test('Glass and Pink themes render readable selected and focused interaction states', () => {
    const fixture = new URL('./fixtures/menu-dialog-theme-surface.html', import.meta.url);
    const results = renderComputedFixture(fixture, 'cainflow-theme66-').filter(({ themeId }) => ['glass-light', 'glass-dark', 'pink'].includes(themeId));

    for (const result of results) {
        const background = composite(parseColor(result.menu.background), [255, 255, 255, 1]);
        const active = result.states.find(({ state }) => state === 'open');
        const focus = result.states.find(({ state }) => state === 'focus');
        const focusColor = parseColor(focus.outline.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i)[0]);
        assert.ok(contrastRatio(composite(parseColor(active.color), background), background) >= 4.5, `${result.themeId} active text meets WCAG AA`);
        assert.ok(contrastRatio(composite(focusColor, background), background) >= 3, `${result.themeId} focus ring meets non-text contrast`);
    }
});
