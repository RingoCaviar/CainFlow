import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryPanelApi } from '../js/features/history/history-panel.js';
import { buildHistoryCardMarkup } from '../js/features/history/history-utils.js';
import { createDiskStorageApi } from '../js/services/storage-disk.js';

function createPanelDocument() {
    const list = {
        innerHTML: '',
        replaceChildren() {},
        querySelectorAll() { return []; },
        ondragstart: null,
        ondragend: null,
        onclick: null
    };
    return {
        getElementById(id) {
            if (id === 'history-list') return list;
            return null;
        },
        querySelector() { return null; },
        list
    };
}

test('history sidebar hydrates a missing video thumbnail from the persisted video', async () => {
    const documentRef = createPanelDocument();
    let videoThumbnailCalls = 0;
    let savedThumbnail = '';
    const panel = createHistoryPanelApi({
        state: { selectedHistoryIds: new Set(), historySelectionMode: false },
        getHistoryMetadata: async () => [{
            id: 7,
            mediaType: 'video',
            hasVideo: true,
            model: 'video-model',
            timestamp: 1,
            thumb: ''
        }],
        getHistoryCount: async () => 1,
        getHistoryEntry: async () => ({ id: 7, mediaType: 'video', videoBlob: new Blob(['video']) }),
        createThumbnail: async () => {
            throw new Error('Image thumbnail generation must not receive a video');
        },
        createVideoThumbnail: async (video) => {
            videoThumbnailCalls += 1;
            assert.ok(video instanceof Blob);
            return 'data:image/webp;base64,video-thumb';
        },
        updateHistoryThumb: async (_id, thumb) => { savedThumbnail = thumb; },
        openHistoryPreview() {},
        deleteHistoryEntry: async () => {},
        documentRef,
        windowRef: {
            requestIdleCallback(callback) {
                queueMicrotask(() => callback({ timeRemaining: () => 16 }));
            }
        }
    });

    await panel.renderHistoryList();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(videoThumbnailCalls, 1);
    assert.equal(savedThumbnail, 'data:image/webp;base64,video-thumb');
});

test('video history thumbnail captures a stable pseudo-random frame away from the opening frame', async () => {
    const originalDocument = globalThis.document;
    const originalUrl = globalThis.URL;
    const originalRandom = Math.random;
    const capturedAt = [];

    const createVideo = () => ({
        duration: 10,
        muted: false,
        set src(_value) { queueMicrotask(() => this.onloadedmetadata?.()); },
        set currentTime(value) {
            capturedAt.push(value);
            queueMicrotask(() => this.onseeked?.());
        }
    });

    globalThis.document = {
        createElement(tag) {
            if (tag === 'video') return createVideo();
            if (tag === 'canvas') return {
                getContext: () => ({ drawImage() {} }),
                toDataURL: () => 'data:image/webp;base64,random-video-frame'
            };
            throw new Error(`unexpected element: ${tag}`);
        }
    };
    globalThis.URL = { createObjectURL: () => 'blob:video', revokeObjectURL() {} };
    Math.random = (() => {
        const values = [0.1, 0.9];
        return () => values.shift() ?? 0.5;
    })();

    try {
        const storage = createDiskStorageApi(() => ({}));
        const thumbnail = await Promise.race([
            Promise.all([
                storage.createVideoThumbnail(new Blob(['video'], { type: 'video/mp4' }), 256, 'media:video-1'),
                storage.createVideoThumbnail(new Blob(['video'], { type: 'video/mp4' }), 256, 'media:video-1')
            ]),
            new Promise((_, reject) => setTimeout(() => reject(new Error('thumbnail generation timed out')), 50))
        ]);
        assert.deepEqual(thumbnail, ['data:image/webp;base64,random-video-frame', 'data:image/webp;base64,random-video-frame']);
        assert.equal(capturedAt.length, 2);
        assert.equal(capturedAt[0], capturedAt[1]);
        assert.ok(capturedAt[0] > 1 && capturedAt[0] < 9);
    } finally {
        globalThis.document = originalDocument;
        globalThis.URL = originalUrl;
        Math.random = originalRandom;
    }
});

test('video history thumbnail waits for the rendered frame after seeking', async () => {
    const originalDocument = globalThis.document;
    const originalUrl = globalThis.URL;
    let frameReady = false;
    let drewBeforeFrameReady = false;

    const video = {
        duration: 8,
        set src(_value) { queueMicrotask(() => this.onloadedmetadata?.()); },
        set currentTime(_value) {
            queueMicrotask(() => this.onseeked?.());
        },
        requestVideoFrameCallback(callback) {
            queueMicrotask(() => {
                frameReady = true;
                callback();
            });
        }
    };

    globalThis.document = {
        createElement(tag) {
            if (tag === 'video') return video;
            if (tag === 'canvas') return {
                getContext: () => ({ drawImage() { if (!frameReady) drewBeforeFrameReady = true; } }),
                getImageData: () => ({ data: new Uint8ClampedArray([40, 20, 10, 255]) }),
                toDataURL: () => 'data:image/webp;base64,rendered-frame'
            };
            throw new Error(`unexpected element: ${tag}`);
        }
    };
    globalThis.URL = { createObjectURL: () => 'blob:video', revokeObjectURL() {} };

    try {
        const thumbnail = await createDiskStorageApi(() => ({})).createVideoThumbnail(new Blob(['video']), 256, 'media:video-2');
        assert.equal(thumbnail, 'data:image/webp;base64,rendered-frame');
        assert.equal(drewBeforeFrameReady, false);
    } finally {
        globalThis.document = originalDocument;
        globalThis.URL = originalUrl;
    }
});

test('video history thumbnail falls back when a paused video never invokes requestVideoFrameCallback', async () => {
    const originalDocument = globalThis.document;
    const originalUrl = globalThis.URL;
    const video = {
        duration: 8,
        set src(_value) { queueMicrotask(() => this.onloadedmetadata?.()); },
        set currentTime(_value) { queueMicrotask(() => this.onseeked?.()); },
        requestVideoFrameCallback() {}
    };

    globalThis.document = {
        createElement(tag) {
            if (tag === 'video') return video;
            if (tag === 'canvas') return {
                getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([40, 20, 10, 255]) }) }),
                toDataURL: () => 'data:image/webp;base64,fallback-frame'
            };
            throw new Error(`unexpected element: ${tag}`);
        }
    };
    globalThis.URL = { createObjectURL: () => 'blob:video', revokeObjectURL() {} };

    try {
        const thumbnail = await Promise.race([
            createDiskStorageApi(() => ({})).createVideoThumbnail(new Blob(['video']), 256, 'media:video-fallback'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('render-frame fallback timed out')), 250))
        ]);
        assert.equal(thumbnail, 'data:image/webp;base64,fallback-frame');
    } finally {
        globalThis.document = originalDocument;
        globalThis.URL = originalUrl;
    }
});

test('video history thumbnail rejects a black frame and captures its alternate frame', async () => {
    const originalDocument = globalThis.document;
    const originalUrl = globalThis.URL;
    let captureCount = 0;

    const video = {
        duration: 8,
        set src(_value) { queueMicrotask(() => this.onloadedmetadata?.()); },
        set currentTime(_value) { queueMicrotask(() => this.onseeked?.()); },
        requestVideoFrameCallback(callback) { queueMicrotask(callback); }
    };
    globalThis.document = {
        createElement(tag) {
            if (tag === 'video') return video;
            if (tag === 'canvas') return {
                getContext: () => ({
                    drawImage() { captureCount += 1; },
                    getImageData: () => ({ data: new Uint8ClampedArray(captureCount === 1 ? [0, 0, 0, 255] : [40, 20, 10, 255]) })
                }),
                toDataURL: () => 'data:image/webp;base64,alternate-frame'
            };
            throw new Error(`unexpected element: ${tag}`);
        }
    };
    globalThis.URL = { createObjectURL: () => 'blob:video', revokeObjectURL() {} };

    try {
        const thumbnail = await createDiskStorageApi(() => ({})).createVideoThumbnail(new Blob(['video']), 256, 'media:video-3');
        assert.equal(thumbnail, 'data:image/webp;base64,alternate-frame');
        assert.equal(captureCount, 2);
    } finally {
        globalThis.document = originalDocument;
        globalThis.URL = originalUrl;
    }
});

test('history sidebar repairs a tiny video thumbnail', async () => {
    const documentRef = createPanelDocument();
    let thumbnailCalls = 0;
    let savedThumbnail = '';
    const panel = createHistoryPanelApi({
        state: { selectedHistoryIds: new Set(), historySelectionMode: false },
        getHistoryMetadata: async () => [{ id: 9, mediaType: 'video', hasVideo: true, thumb: '/thumb.webp', thumbSizeBytes: 702, timestamp: 1 }],
        getHistoryCount: async () => 1,
        getHistoryEntry: async () => ({ id: 9, mediaType: 'video', videoBlob: new Blob(['video']), thumb: '/thumb.webp', thumbSizeBytes: 702 }),
        createThumbnail: async () => '',
        createVideoThumbnail: async () => { thumbnailCalls += 1; return 'data:image/webp;base64,repaired'; },
        updateHistoryThumb: async (_id, thumb) => { savedThumbnail = thumb; },
        openHistoryPreview() {}, deleteHistoryEntry: async () => {}, documentRef,
        windowRef: { requestIdleCallback(callback) { queueMicrotask(() => callback({ timeRemaining: () => 16 })); } }
    });

    await panel.renderHistoryList();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(thumbnailCalls, 1);
    assert.equal(savedThumbnail, 'data:image/webp;base64,repaired');
});

test('right-clicking a video history card suppresses the native context menu', async () => {
    const documentRef = createPanelDocument();
    const panel = createHistoryPanelApi({
        state: { selectedHistoryIds: new Set(), historySelectionMode: false },
        getHistoryMetadata: async () => [{ id: 10, mediaType: 'video', hasVideo: true, thumb: '', timestamp: 1 }],
        getHistoryCount: async () => 1,
        getHistoryEntry: async () => null,
        createThumbnail: async () => '', createVideoThumbnail: async () => '', updateHistoryThumb: async () => false,
        regenerateHistoryVideoThumbnail: async () => {},
        openHistoryPreview() {}, deleteHistoryEntry: async () => {}, documentRef,
        windowRef: { requestIdleCallback(callback) { queueMicrotask(() => callback({ timeRemaining: () => 16 })); } }
    });

    await panel.renderHistoryList();
    let prevented = false;
    await documentRef.list.oncontextmenu({
        target: { closest: () => ({ dataset: { mediaType: 'video', id: '10' } }) },
        preventDefault() { prevented = true; }, clientX: 0, clientY: 0
    });
    assert.equal(prevented, true);
});

test('video history without a thumbnail renders a VIDEO placeholder while hydration is pending', () => {
    const markup = buildHistoryCardMarkup({
        item: { id: 8, mediaType: 'video', hasVideo: true, thumb: '', timestamp: 1 },
        compact: true
    });

    assert.match(markup, /data:image\/svg\+xml/);
    assert.match(markup, /history-card-img-pending/);
});
