import assert from 'node:assert/strict';
import test from 'node:test';
import { createGlobalInteractionsApi } from '../js/features/ui/global-interactions.js';

function createPasteHarness({ preferInternal = false } = {}) {
    const handlers = new Map();
    const imported = [];
    let nextId = 0;
    const canvasContainer = { addEventListener() {}, contains: () => true, closest: () => null, nodeType: 1 };
    const documentRef = {
        activeElement: null,
        addEventListener(type, handler) { handlers.set(type, handler); },
        querySelectorAll() { return []; },
        getElementById() { return null; }
    };
    const state = {
        nodes: new Map(), selectedNodes: new Set(), runningNodeIds: new Set(),
        isMouseOverCanvas: true, mouseCanvas: { x: 10, y: 20 }, canvas: { x: 0, y: 0, zoom: 1 }
    };
    const api = createGlobalInteractionsApi({
        state, canvasContainer, documentRef,
        windowRef: { addEventListener() {}, innerWidth: 100, innerHeight: 100 },
        clipboardControllerApi: { shouldPreferInternalClipboard: () => preferInternal, hasClipboardNodes: () => preferInternal },
        addNode: () => `node-${++nextId}`,
        loadImageFile: (id, file) => imported.push([id, file]),
        pasteNode: () => imported.push(['internal']),
        showToast() {}, scheduleSave() {}
    });
    api.initGlobalInteractions();
    return {
        imported,
        paste(file, { useFiles = false, omitItemType = false, omitFileType = false } = {}) {
            const clipboardFile = omitFileType ? new Blob([file], { type: '' }) : file;
            const clipboardData = {
                items: useFiles ? [] : [{ kind: 'file', type: omitItemType ? '' : file.type, getAsFile: () => clipboardFile }],
                files: useFiles ? [clipboardFile] : [],
                getData: () => ''
            };
            handlers.get('paste')({ target: canvasContainer, clipboardData, preventDefault() {}, stopImmediatePropagation() {} });
        }
    };
}

test('two deliberate image paste events both import images', () => {
    const harness = createPasteHarness();
    harness.paste(new Blob(['first'], { type: 'image/png' }));
    harness.paste(new Blob(['second'], { type: 'image/png' }));
    assert.equal(harness.imported.length, 2);
});

test('actual clipboard image wins over an older internal node clipboard', () => {
    const harness = createPasteHarness({ preferInternal: true });
    harness.paste(new Blob(['pixels'], { type: 'image/png' }));
    assert.equal(harness.imported.length, 1);
    assert.notEqual(harness.imported[0][0], 'internal');
});

test('image paste accepts a WebView file when clipboard items are empty', () => {
    const harness = createPasteHarness();
    harness.paste(new Blob(['pixels'], { type: 'image/png' }), { useFiles: true });
    assert.equal(harness.imported.length, 1);
});

test('image paste accepts a file item whose MIME type exists only on the file', () => {
    const harness = createPasteHarness();
    harness.paste(new Blob(['pixels'], { type: 'image/png' }), { omitItemType: true });
    assert.equal(harness.imported.length, 1);
});

test('image paste accepts a file item whose MIME type exists only on the clipboard item', () => {
    const harness = createPasteHarness();
    harness.paste(new Blob(['pixels'], { type: 'image/png' }), { omitFileType: true });
    assert.equal(harness.imported.length, 1);
});

test('internal node paste still works when the native event has no image', () => {
    const harness = createPasteHarness({ preferInternal: true });
    harness.paste({ type: 'text/plain' });
    assert.deepEqual(harness.imported, [['internal']]);
});
