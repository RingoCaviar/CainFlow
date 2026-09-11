import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createUiUtils } from '../js/features/ui/ui-utils.js';
import { getCurrentFullscreenImage } from '../js/features/media/media-controller.js';

test('copies image pixels through the native clipboard image API', async () => {
    const writes = [];
    const notices = [];
    class ClipboardItemMock {
        constructor(data) { this.data = data; }
    }
    const api = createUiUtils({
        showToast: (...args) => notices.push(args),
        documentRef: {},
        navigatorRef: { clipboard: { write: async (items) => writes.push(items) } },
        fetchRef: async () => ({ ok: true, blob: async () => new Blob(['pixels'], { type: 'image/png' }) }),
        clipboardItemCtor: ClipboardItemMock
    });

    assert.equal(await api.copyImageToClipboard('data:image/png;base64,cGl4ZWxz'), true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0].data['image/png'].type, 'image/png');
    assert.deepEqual(notices.at(-1), ['图片已复制到剪贴板', 'success']);
});

test('converts non-PNG images to PNG for clipboard compatibility', async () => {
    const writes = [];
    class ClipboardItemMock {
        constructor(data) { this.data = data; }
    }
    const image = {
        naturalWidth: 2,
        naturalHeight: 1,
        set src(_value) { queueMicrotask(() => this.onload()); }
    };
    const canvas = {
        getContext: () => ({ drawImage() {} }),
        toBlob: (callback) => callback(new Blob(['png-pixels'], { type: 'image/png' }))
    };
    const api = createUiUtils({
        showToast() {},
        documentRef: { createElement: (tagName) => tagName === 'img' ? image : canvas },
        navigatorRef: { clipboard: { write: async (items) => writes.push(items) } },
        fetchRef: async () => ({ ok: true, blob: async () => new Blob(['jpeg-pixels'], { type: 'image/jpeg' }) }),
        clipboardItemCtor: ClipboardItemMock,
        urlApi: { createObjectURL: () => 'blob:image', revokeObjectURL() {} }
    });

    assert.equal(await api.copyImageToClipboard('image.jpg'), true);
    assert.equal(writes[0][0].data['image/png'].type, 'image/png');
});

test('reports a clipboard write failure', async () => {
    const notices = [];
    class ClipboardItemMock {
        constructor(data) { this.data = data; }
    }
    const api = createUiUtils({
        showToast: (...args) => notices.push(args),
        documentRef: {},
        navigatorRef: { clipboard: { write: async () => { throw new Error('blocked'); } } },
        fetchRef: async () => ({ ok: true, blob: async () => new Blob(['pixels'], { type: 'image/png' }) }),
        clipboardItemCtor: ClipboardItemMock
    });

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        assert.equal(await api.copyImageToClipboard('data:image/png;base64,cGl4ZWxz'), false);
        assert.deepEqual(notices.at(-1), ['复制图片失败', 'error']);
    } finally {
        console.error = originalConsoleError;
    }
});

test('copies the currently selected fullscreen image', () => {
    assert.equal(getCurrentFullscreenImage(['first.png', 'second.png'], 1, 'fallback.png'), 'second.png');
    assert.equal(getCurrentFullscreenImage(['first.png'], 3, 'fallback.png'), 'first.png');
    assert.equal(getCurrentFullscreenImage([], 0, 'fallback.png'), 'fallback.png');
});

test('fullscreen preview and node context menu expose image copy actions', async () => {
    const [html, media, contextMenu] = await Promise.all([
        readFile(new URL('../index.html', import.meta.url), 'utf8'),
        readFile(new URL('../js/features/media/media-controller.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/features/ui/context-menu-controller.js', import.meta.url), 'utf8')
    ]);

    assert.match(html, /id="context-menu-copy-image"/);
    assert.match(media, /fullscreen-copy-btn/);
    assert.match(media, /copyImageToClipboard\(getCurrentFullscreenImage\(images, currentIndex, src\)\)/);
    assert.match(contextMenu, /copyNodeImageToClipboard/);
    assert.match(contextMenu, /state\.contextMenuHasImageTarget === true/);
    assert.match(contextMenu, /state\.contextMenuHasImageTarget = isImageContextTarget\(target, event\)/);
});
