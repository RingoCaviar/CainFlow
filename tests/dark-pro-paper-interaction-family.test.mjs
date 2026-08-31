import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
