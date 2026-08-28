import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const controller = await readFile(new URL('../js/features/ui/theme-controller.js', import.meta.url), 'utf8');
const themeEntry = await readFile(new URL('../css/themes.css', import.meta.url), 'utf8');
const paper = await readFile(new URL('../css/themes/paper.css', import.meta.url), 'utf8');

test('Paper is registered as a light theme and included in the theme bundle', () => {
    assert.match(controller, /PAPER:\s*'paper'/);
    assert.match(controller, /id:\s*THEME_IDS\.PAPER,[\s\S]*?label:\s*'Paper',[\s\S]*?colorScheme:\s*'light'/);
    assert.match(themeEntry, /@import '\.\/themes\/paper\.css';/);
});

test('Paper keeps the warm paper palette flat and layout-neutral', () => {
    assert.match(paper, /--bg-canvas:\s*#eeece7/);
    assert.match(paper, /--bg-node:\s*#fbfaf7/);
    assert.match(paper, /--accent-primary:\s*#4e7669/);
    assert.match(paper, /--workflow-card-shadow:\s*none/);
    assert.match(paper, /--canvas-bg-layers:\s*none/);
    assert.doesNotMatch(paper, /\b(?:width|height|display|position|grid-template|padding|margin):/);
});

test('Paper component styling consumes its semantic palette tokens', () => {
    const componentOverrides = paper.slice(paper.indexOf('html[data-app-theme="paper"]'));

    for (const paletteLiteral of ['#eeece7', '#fbfaf7', '#f6f4ef', '#f2f0eb', '#4e7669']) {
        assert.doesNotMatch(componentOverrides, new RegExp(paletteLiteral, 'i'));
    }
    assert.match(componentOverrides, /var\(--bg-node\)/);
    assert.match(componentOverrides, /var\(--accent-primary\)/);
});
