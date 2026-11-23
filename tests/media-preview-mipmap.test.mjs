import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaPreviewCache, createPreviewPriority } from '../js/features/media/media-preview-cache.js';

const source = (id) => `data:image/png;base64,${id}`;

function createPreviewHarness({ asyncEncoding = false, ...options } = {}) {
    const frames = [];
    const decodes = [];
    const encodes = [];
    const sizes = [];
    let synchronousEncodes = 0;
    class PreviewImage {
        set src(value) { this.source = value; decodes.push(this); }
        load(width = 1200, height = 800) {
            this.naturalWidth = width;
            this.naturalHeight = height;
            this.onload();
        }
        removeAttribute() {}
    }
    class PreviewFileReader {
        readAsDataURL(blob) { this.result = blob.dataUrl; this.onload(); }
    }
    const cache = createMediaPreviewCache({
        getImageResolution: () => assert.fail('inline metadata must share the preview decoder'),
        windowRef: {
            Image: PreviewImage, FileReader: PreviewFileReader,
            requestAnimationFrame(callback) { frames.push(callback); }
        },
        documentRef: { createElement() {
            const canvas = {
                getContext() { return { drawImage(_img, _x, _y, width, height) { sizes.push([width, height]); } }; },
                toDataURL() { synchronousEncodes += 1; return source(`thumbnail-${synchronousEncodes}`); }
            };
            if (asyncEncoding) canvas.toBlob = (callback) => encodes.push(callback);
            return canvas;
        } },
        ...options
    });
    return {
        cache, decodes, encodes, sizes, frames,
        frame() { assert.ok(frames.length > 0, 'queued previews schedule the next frame'); frames.shift()(); },
        get synchronousEncodes() { return synchronousEncodes; }
    };
}

test('display MIPmaps leave non-inline source images authoritative', async () => {
    const cache = createMediaPreviewCache({ getImageResolution: () => '', documentRef: {}, windowRef: {} });
    const source = 'https://example.test/original.png';
    const mipmap = await cache.createDisplayMipmap(source, 160);
    assert.equal(mipmap, source);
    assert.equal(source, 'https://example.test/original.png');
});

test('GIF and SVG previews retain animation and vector data instead of rasterizing a frame', async () => {
    const { cache, frames, decodes, sizes } = createPreviewHarness();
    const originals = ['data:image/gif;base64,R0lGODlh', 'data:image/svg+xml;base64,PHN2Zz4='];
    const previews = originals.map(original => cache.createDisplayMipmap(original, 16));
    assert.equal(frames.length, 0);
    assert.deepEqual(await Promise.all(previews), originals);
    assert.deepEqual(decodes, []);
    assert.deepEqual(sizes, []);
});

test('a burst waits for a frame, starts two images, and prefers a promoted pending preview', async () => {
    const harness = createPreviewHarness();
    const { cache, decodes } = harness;
    const inputs = Array.from({ length: 8 }, (_, index) => source(index));
    const visible = createPreviewPriority();
    const previews = inputs.map(input => cache.createPreviewThumbnail(input));
    assert.equal(cache.createPreviewThumbnail(inputs.at(-1), 480, { priority: visible }), previews.at(-1));
    assert.equal(decodes.length, 0);

    visible.set(1);
    harness.frame();
    assert.deepEqual(decodes.map(image => image.source), [inputs[7], inputs[0]]);
    assert.equal(harness.frames.length, 0, 'in-flight decodes prevent further starts');

    decodes[0].load();
    decodes[1].load();
    await Promise.all([previews[0], previews[7]]);
    harness.frame();
    assert.deepEqual(decodes.slice(2).map(image => image.source), [inputs[1], inputs[2]]);
});

test('metadata and both thumbnail sizes share an original decode with asynchronous encoding', async () => {
    const harness = createPreviewHarness({ asyncEncoding: true });
    const { cache, decodes, encodes, sizes } = harness;
    const original = source('shared-original');
    const dimensions = cache.resolveImageResolution(original);
    const card = cache.createDisplayMipmap(original, 480, { priority: 1 });
    const reference = cache.createPreviewThumbnail(original, 96);

    harness.frame();
    assert.equal(decodes.length, 1);
    decodes[0].load();
    assert.equal(await dimensions, '1200 × 800');
    assert.equal(encodes.length, 1);
    assert.equal(harness.synchronousEncodes, 0);
    assert.deepEqual(sizes, [[480, 320]]);

    encodes.shift()({ dataUrl: source('card') });
    assert.equal(await card, source('card'));
    assert.deepEqual(sizes, [[480, 320], [96, 64]]);
    encodes.shift()({ dataUrl: source('reference') });
    assert.equal(await reference, source('reference'));
    assert.equal(cache.getCachedPreviewThumbnail(original, 96), source('reference'));
    assert.equal(await cache.resolveImageResolution(original), '1200 × 800');
    assert.equal(decodes.length, 1);
});

test('an image requested for visible metadata shares the same priority and decode limits', async () => {
    const { cache, decodes, frame } = createPreviewHarness();
    const first = source('first');
    cache.createPreviewThumbnail(first);
    cache.createPreviewThumbnail(source('second'));
    const animated = source('animated');
    const dimensions = cache.resolveImageResolution(animated, { priority: 1 });
    frame();
    assert.deepEqual(decodes.map(image => image.source), [animated, first]);
    decodes[0].load(320, 180);
    assert.equal(await dimensions, '320 × 180');
});

test('demotion retains another visible consumer of the same source', async () => {
    const { cache, decodes, frame } = createPreviewHarness();
    const demoted = createPreviewPriority(1);
    const active = createPreviewPriority();
    const first = source('oldest');
    const second = source('shared-visibility');
    cache.createPreviewThumbnail(first);
    const shared = cache.createPreviewThumbnail(second, 480, { priority: demoted });
    assert.equal(cache.createPreviewThumbnail(second, 480, { priority: active }), shared);
    active.set(1);
    demoted.set(0);
    frame();
    assert.deepEqual(decodes.map(image => image.source), [second, first]);
    decodes[0].load();
    assert.equal(await shared, source('thumbnail-1'));
});

test('obsolete queued views do not decode an old image or cancel work shared by a live view', async () => {
    const { cache, decodes, frame } = createPreviewHarness();
    const discarded = source('discarded');
    const shared = source('shared');
    let attached = true;
    const old = cache.createPreviewThumbnail(discarded, 480, { priority: 1, isCurrent: () => attached });
    const dimensions = cache.resolveImageResolution(discarded, { isCurrent: () => attached });
    const oldShared = cache.createPreviewThumbnail(shared, 480, { isCurrent: () => attached });
    const liveShared = cache.createPreviewThumbnail(shared, 480);
    assert.equal(oldShared, liveShared);

    attached = false;
    frame();
    assert.deepEqual(decodes.map(image => image.source), [shared]);
    assert.equal(await old, discarded);
    assert.equal(await dimensions, '');
    decodes[0].load();
    assert.equal(await liveShared, source('thumbnail-1'));
});

test('a completed entry limit does not evict pending requests', async () => {
    const { cache, decodes, frame } = createPreviewHarness({ previewThumbnailCacheLimit: 1 });
    const first = source('first');
    const second = source('second');
    const firstPreview = cache.createPreviewThumbnail(first);
    const secondPreview = cache.createPreviewThumbnail(second);
    assert.equal(cache.createPreviewThumbnail(first), firstPreview);
    frame();
    decodes[0].load(320, 160);
    decodes[1].load();
    assert.equal(await firstPreview, first);
    assert.equal(await secondPreview, source('thumbnail-1'));
    assert.equal(await cache.createPreviewThumbnail(first), first, 'known small originals need no resize');
    assert.equal(decodes.length, 2);
});

test('clearing a preview cache does not let an older encode poison a newer request', async () => {
    const { cache, decodes, encodes, frame } = createPreviewHarness({ asyncEncoding: true });
    const original = source('stale');
    const oldPreview = cache.createPreviewThumbnail(original);
    frame();
    decodes[0].load();
    await cache.resolveImageResolution(original);
    const oldEncode = encodes.shift();

    cache.clearPreviewThumbnailCache();
    const newPreview = cache.createPreviewThumbnail(original);
    frame();
    decodes[1].load();
    oldEncode({ dataUrl: source('old') });
    assert.equal(await oldPreview, source('old'));
    assert.equal(cache.getCachedPreviewThumbnail(original), '');
    encodes.shift()({ dataUrl: source('new') });
    assert.equal(await newPreview, source('new'));
    assert.equal(cache.getCachedPreviewThumbnail(original), source('new'));
});

test('failed asynchronous encoding falls back to the source without caching it as a thumbnail', async () => {
    const { cache, decodes, encodes, frame } = createPreviewHarness({ asyncEncoding: true });
    const original = source('fallback');
    const preview = cache.createPreviewThumbnail(original);
    frame();
    decodes[0].load();
    await cache.resolveImageResolution(original);
    encodes.shift()(null);
    assert.equal(await preview, original);
    assert.equal(cache.getCachedPreviewThumbnail(original), '');
});
