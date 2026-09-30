import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHistoryImageContextMenu } from '../js/features/history/history-image-context-menu.js';

test('history image right click offers copy and invokes the current image source', async () => {
    const listeners = new Map();
    const copied = [];
    const menu = {
        className: '', style: {}, children: [],
        setAttribute() {}, appendChild(child) { this.children.push(child); },
        getBoundingClientRect: () => ({ width: 140, height: 38 }),
        contains(target) { return target === this || this.children.includes(target); },
        remove() {}
    };
    const action = {
        className: '', style: {}, setAttribute() {},
        addEventListener(type, handler) { listeners.set(type, handler); }
    };
    const documentRef = {
        body: { appendChild() {} },
        createElement: (tag) => tag === 'button' ? action : menu,
        addEventListener() {}, removeEventListener() {}
    };
    const contextMenu = createHistoryImageContextMenu({ documentRef, windowRef: { innerWidth: 800, innerHeight: 600, setTimeout() {} } });
    contextMenu.open({ clientX: 20, clientY: 30 }, () => copied.push('full-image'));
    assert.equal(action.textContent, '复制图片');
    listeners.get('pointerdown')({ preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(copied, ['full-image']);
});

test('history preview connects image right click to the image clipboard API', async () => {
    const [preview, bootstrap] = await Promise.all([
        readFile(new URL('../js/features/history/history-preview.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/app/bootstrap/history-bootstrap.js', import.meta.url), 'utf8')
    ]);
    assert.match(preview, /addEventListener\('contextmenu'/);
    assert.match(preview, /copyImageToClipboard\(/);
    assert.match(bootstrap, /copyImageToClipboard/);
});
