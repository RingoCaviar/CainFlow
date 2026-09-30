import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaControllerApi } from '../js/features/media/media-controller.js';

for (const mediaType of ['image', 'video']) test(`ImageSave button hands ${mediaType} to the desktop save bridge when WebView ignores synthetic downloads`, async () => {
    const saved = [];
    const video = { url: '/api/storage/assets/media%3Avideo-1' };
    const image = 'data:image/png;base64,AAAA';
    const node = { id: 'save-1', type: 'ImageSave', data: mediaType === 'video' ? { video } : { image } };
    const listeners = new Map();
    const elements = {
        '#save-1-save-preview': { dataset: {}, addEventListener(type, handler) { listeners.set(`preview:${type}`, handler); } },
        '#save-1-manual-save': { addEventListener(type, handler) { listeners.set(`save:${type}`, handler); } },
        '#save-1-filename': { value: 'video' },
        '#save-1-view-full': { addEventListener() {} }
    };
    const documentRef = {
        addEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getElementById() { return null; },
        createElement() { return { click() {}, set href(value) { this._href = value; } }; },
        body: { appendChild() {}, removeChild() {} }
    };
    const windowRef = {
        location: { href: 'http://localhost/' },
        __cainflowDesktop: { saveFile: async (...args) => { saved.push(args); return 'C:/exports/video.mp4'; } }
    };
    const api = createMediaControllerApi({
        state: { nodes: new Map([[node.id, node]]), connections: [] },
        getNodeById: () => node,
        showToast() {}, addLog() {}, scheduleSave() {},
        dataURLtoBlob: () => new Blob(['image'], { type: 'image/png' }), estimateDataUrlSize: () => 0,
        documentRef, windowRef
    });
    api.setupImageSave(node.id, { querySelector: (selector) => elements[selector] });

    await listeners.get('save:click')();

    assert.equal(saved.length, 1);
    assert.equal(saved[0][2], mediaType === 'video' ? video.url : image);
});
