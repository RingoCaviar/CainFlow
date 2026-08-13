import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const menu = await readFile(new URL('../js/features/ui/context-menu-controller.js', import.meta.url), 'utf8');
const clipboard = await readFile(new URL('../js/features/ui/clipboard-controller.js', import.meta.url), 'utf8');
const interactions = await readFile(new URL('../js/features/ui/global-interactions.js', import.meta.url), 'utf8');
const historyUtils = await readFile(new URL('../js/features/history/history-utils.js', import.meta.url), 'utf8');

test('canvas context menu exposes copy, paste, and delete actions', () => {
    for (const id of ['context-menu-copy-nodes', 'context-menu-paste-nodes', 'context-menu-delete-nodes']) {
        assert.match(html, new RegExp(`id="${id}"`));
        assert.match(menu, new RegExp(`'${id}'`));
    }
    assert.match(menu, /const position = viewportApi\.screenToCanvas\(state\.contextMenu\.x, state\.contextMenu\.y\)/);
});

test('context-menu paste uses the explicit pointer position', () => {
    assert.match(clipboard, /const mousePos = options\.position[\s\S]*?\? options\.position[\s\S]*?: state\.mouseCanvas/);
});

test('history-image drops only create a new import node on the canvas', () => {
    assert.match(interactions, /if \(!e\.target\.closest\?\.\('#canvas-container'\)\) return;/);
    assert.match(interactions, /\}, \{ forceCreate: true \}\);/);
});

test('history thumbnail drag starts from the draggable card rather than the native image', () => {
    assert.match(historyUtils, /<img class="\$\{imageClass\}"[^>]*draggable="false"/);
});
