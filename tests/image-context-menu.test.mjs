import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { isImageContextTarget } from '../js/features/ui/context-menu-controller.js';

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
