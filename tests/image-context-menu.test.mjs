import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createContextMenuControllerApi, isImageContextTarget } from '../js/features/ui/context-menu-controller.js';

function previewTarget({ image = null } = {}) {
    const previewContainer = {
        querySelector: (selector) => selector === 'img' ? image : null
    };
    return { closest: () => previewContainer };
}

test('recognizes only a displayed image as an image context-menu target', () => {
    const image = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };

    assert.equal(isImageContextTarget(previewTarget({ image }), { clientX: 50, clientY: 50 }), true);
    assert.equal(isImageContextTarget(previewTarget(), { clientX: 50, clientY: 50 }), false);
});

test('rejects letterbox space around a contained image', () => {
    const image = {
        naturalWidth: 100,
        naturalHeight: 100,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 })
    };

    assert.equal(isImageContextTarget(previewTarget({ image }), { clientX: 100, clientY: 50 }), true);
    assert.equal(isImageContextTarget(previewTarget({ image }), { clientX: 25, clientY: 50 }), false);
});

test('rejects node titles and video preview surfaces', () => {
    const titleTarget = { closest: () => null };
    const videoPreviewTarget = previewTarget();

    assert.equal(isImageContextTarget(titleTarget, { clientX: 10, clientY: 10 }), false);
    assert.equal(isImageContextTarget(videoPreviewTarget, { clientX: 10, clientY: 10 }), false);
});

test('fullscreen preview handles a right-click with an image copy action', async () => {
    const media = await readFile(new URL('../js/features/media/media-controller.js', import.meta.url), 'utf8');

    assert.match(media, /overlay\.addEventListener\('contextmenu'/);
    assert.match(media, /复制图片/);
});

test('node image context menu shows and copies the original image from the pointer gesture', () => {
    const listeners = new Map();
    const copyCalls = [];
    const classList = { add() {}, remove() {}, contains() { return false; } };
    const image = {
        dataset: { originalSrc: 'data:image/png;base64,b3JpZ2luYWw=' },
        src: 'data:image/png;base64,dGh1bWI=',
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 })
    };
    const nodeEl = { id: 'image-1', classList };
    const surface = { querySelector: (selector) => selector === 'img' ? image : null };
    const target = {
        matches: () => false,
        closest: (selector) => selector === '.node' ? nodeEl : surface
    };
    const menuItem = {
        id: 'context-menu-copy-image', dataset: {}, style: {}, classList,
        closest: () => menuItem,
        getAttribute: () => null
    };
    const contextMenu = {
        classList, style: {}, contains: () => true, querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 200, height: 200 }),
        addEventListener: (type, handler) => listeners.set(`menu:${type}`, handler)
    };
    const canvasContainer = { addEventListener: (type, handler) => listeners.set(`canvas:${type}`, handler) };
    const documentRef = {
        defaultView: { innerWidth: 1000, innerHeight: 800 },
        querySelectorAll: () => [],
        getElementById: (id) => id === 'context-menu-copy-image' ? menuItem : null,
        addEventListener() {}
    };
    const state = {
        nodes: new Map([['image-1', { id: 'image-1', type: 'ImagePreview', el: nodeEl }]]),
        selectedNodes: new Set(), connections: []
    };
    createContextMenuControllerApi({
        state, canvasContainer, contextMenu, documentRef,
        viewportApi: {}, copyNodeImageToClipboard: (...args) => copyCalls.push(args)
    }).initContextMenu();

    listeners.get('canvas:contextmenu')({ target, clientX: 50, clientY: 50, preventDefault() {} });
    assert.equal(menuItem.style.display, 'flex');
    listeners.get('menu:pointerdown')({
        target: menuItem, preventDefault() {}, stopPropagation() {}
    });
    assert.deepEqual(copyCalls, [['image-1', image.dataset.originalSrc]]);
});
