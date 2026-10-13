import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const mediaController = await readFile(
    new URL('../js/features/media/media-controller.js', import.meta.url),
    'utf8'
);
const nodeStyles = await readFile(
    new URL('../css/components/nodes.css', import.meta.url),
    'utf8'
);

test('advanced compare thumbnails expose right-click A and B actions', () => {
    assert.match(mediaController, /button\.addEventListener\('contextmenu'/);
    assert.match(mediaController, /image-compare-thumb-context-menu/);
    assert.match(mediaController, /data-role="A">设置为 A/);
    assert.match(mediaController, /data-role="B">设置为 B/);
    assert.match(mediaController, /setSelectedImage\(menuItem\.dataset\.role\)/);
});

test('advanced compare close button stays visible over image content', () => {
    assert.match(nodeStyles, /\.image-compare-advanced-close\s*\{[^}]*border:\s*2px solid/s);
    assert.match(nodeStyles, /\.image-compare-advanced-close\s*\{[^}]*background:\s*rgba\(8, 10, 14, 0\.92\)/s);
    assert.match(nodeStyles, /\.image-compare-advanced-close\s*\{[^}]*box-shadow:/s);
});
