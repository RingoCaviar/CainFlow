import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { composite, contrastRatio, parseColor, renderComputedFixture } from './helpers/browser-theme-fixture.mjs';

test('Dark, Pro, and Paper declare their approved ordinary interaction families', async () => {
    const themes = await Promise.all(['dark', 'pro', 'paper'].map(async (theme) => [theme, await readFile(new URL(`../css/themes/${theme}.css`, import.meta.url), 'utf8')]));
    const expected = {
        dark: /--accent-primary:\s*#0e7490/,
        pro: /--accent-primary:\s*#5d7cff/,
        paper: /--accent-primary:\s*#4e7669/,
    };

    for (const [theme, stylesheet] of themes) {
        assert.match(stylesheet, expected[theme], `${theme} must declare its ordinary interaction family`);
        assert.match(stylesheet, /--accent-green:/, `${theme} preserves success semantics`);
        assert.match(stylesheet, /--accent-orange:/, `${theme} preserves warning semantics`);
        assert.match(stylesheet, /--accent-red:/, `${theme} preserves failure semantics`);
        assert.match(stylesheet, /--port-image:/, `${theme} preserves image-port semantics`);
    }
});

test('Dark, Pro, and Paper render readable selected and focused interaction states', () => {
    const fixture = new URL('./fixtures/menu-dialog-theme-surface.html', import.meta.url);
    const results = renderComputedFixture(fixture, 'cainflow-theme65-').filter(({ themeId }) => ['dark', 'pro', 'paper'].includes(themeId));

    for (const result of results) {
        const background = composite(parseColor(result.menu.background), [255, 255, 255, 1]);
        const active = result.states.find(({ state }) => state === 'open');
        const focus = result.states.find(({ state }) => state === 'focus');
        const focusColor = parseColor(focus.outline.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i)[0]);
        assert.ok(contrastRatio(composite(parseColor(active.color), background), background) >= 4.5, `${result.themeId} active text meets WCAG AA`);
        assert.ok(contrastRatio(composite(focusColor, background), background) >= 3, `${result.themeId} focus ring meets non-text contrast`);
    }
});
