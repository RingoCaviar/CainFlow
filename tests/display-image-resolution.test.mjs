import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createDisplayImageRenderer } from '../js/features/media/display-image-renderer.js';
import { TRANSPARENT_PREVIEW_PIXEL } from '../js/features/media/media-preview-cache.js';
import { syncNodeMediaAspect } from '../js/nodes/node-media-aspect.js';

const controllerSource = await readFile(
    new URL('../js/features/media/media-controller.js', import.meta.url),
    'utf8'
);

test('preview and save renderers refresh the current image resolution badge', () => {
    const previewRenderer = controllerSource.match(/function renderImagePreviewImage\([\s\S]*?function renderImageSavePreview/)?.[0] || '';
    const saveRenderer = controllerSource.match(/function renderImageSavePreview\([\s\S]*?function renderVideoSavePreview/)?.[0] || '';

    assert.match(previewRenderer, /const rendered = renderDisplayImagePreview\([\s\S]*?void showResolutionBadge\(nodeId, rendered\.image\)/);
    assert.match(saveRenderer, /const rendered = renderDisplayImagePreview\([\s\S]*?void showResolutionBadge\(nodeId, rendered\.image\)/);
});

function displayImage() {
    return { dataset: {}, style: { removeProperty() {} }, isConnected: true, src: '', getAttribute() { return this.src; } };
}

function controlledPreviewRenderer() {
    let notifyVisibility;
    const observing = new Set();
    const requests = [];
    const resolutions = [];
    const cached = new Map();
    const renderer = createDisplayImageRenderer({
        documentRef: { defaultView: { IntersectionObserver: class {
            constructor(callback) { notifyVisibility = callback; }
            observe(image) { observing.add(image); }
            unobserve(image) { observing.delete(image); }
        } } },
        previewCache: {
            getCachedPreviewThumbnail(source, edge) { return cached.get(`${source}@${edge}`); },
            createPreviewThumbnail(source, maxEdge, { priority, isCurrent } = {}) {
                return new Promise((resolve, reject) => { requests.push({ source, maxEdge, priority, isCurrent, resolve, reject }); });
            },
            resolveImageResolution(source, { priority, isCurrent } = {}) {
                return new Promise(resolve => { resolutions.push({ source, priority, isCurrent, resolve }); });
            }
        }
    });
    return {
        ...renderer, requests, resolutions, cached, observing,
        setVisibility(target, isIntersecting) { notifyVisibility([{ target, isIntersecting }]); }
    };
}

const original = 'data:image/png;base64,b3JpZ2luYWw=';
const replacement = 'data:image/png;base64,bmV3';
const thumbnail = 'data:image/webp;base64,cHJldmlldw==';

const sourceFor = (type, bytes) => `data:image/${type};base64,${btoa(bytes)}`;
const webpSource = flags => sourceFor('webp', `RIFF\x16\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00${String.fromCharCode(flags)}\x00\x00\x00`);
function pngSource(animated) {
    const block = (name, data) => String.fromCharCode(0, 0, data.length >> 8, data.length & 255) + name + data + '\x00'.repeat(4);
    return sourceFor('png', '\x89PNG\r\n\x1a\n' + block('IHDR', '\x00'.repeat(13)) + block('tEXt', 'x'.repeat(5000)) +
        (animated ? block('acTL', '\x00'.repeat(8)) : '') + block('IDAT', ''));
}

test('eager canvas previews wait for the bounded image queue before showing animated originals', async () => {
    const renderer = controlledPreviewRenderer();
    const sources = [sourceFor('gif', 'GIF89a'), sourceFor('apng', '\x89PNG'), sourceFor('avif', 'ftypavis'),
        sourceFor('svg+xml', '<svg/>'), webpSource(2), pngSource(true)];
    for (const source of sources) {
        const img = displayImage();
        renderer.setImageElementSource(img, source, '原图', { preferImmediateSrc: true });
        assert.equal(img.src, TRANSPARENT_PREVIEW_PIXEL);
        const queued = renderer.resolutions.at(-1);
        assert.equal(queued?.source, source);
        renderer.setVisibility(img, true);
        assert.equal(queued.priority.value, 1);
        queued.resolve('640 × 480');
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(img.src, source);
    }
    assert.equal(renderer.requests.length, 0);
});

test('still PNG and WebP previews and non-eager animated thumbnails keep using the thumbnail queue', () => {
    const renderer = controlledPreviewRenderer();
    for (const source of [webpSource(16), pngSource(false)]) {
        renderer.setImageElementSource(displayImage(), source, '静态图片', { preferImmediateSrc: true });
    }
    renderer.setImageElementSource(displayImage(), webpSource(2), '缩略图');
    assert.equal(renderer.requests.length, 3);
    assert.equal(renderer.resolutions.length, 0);
});

test('a deferred import uses the decoded preview ratio when the actual image arrives', () => {
    const ratio = new Map();
    const list = () => {
        const entries = new Set();
        return { contains: name => entries.has(name), add: name => entries.add(name), remove: name => entries.delete(name) };
    };
    const surface = { classList: list(), style: {
        getPropertyValue: name => ratio.get(name), setProperty: (name, value) => ratio.set(name, value)
    } };
    const image = { tagName: 'IMG', dataset: { originalSrc: original }, src: TRANSPARENT_PREVIEW_PIXEL,
        naturalWidth: 1, naturalHeight: 1, getAttribute() { return this.src; },
        getClientRects: () => [{}], closest: selector => selector === '[hidden], .hidden' ? null : surface };
    const node = { type: 'ImageImport', el: { classList: list(), querySelectorAll: () => [image] } };

    assert.equal(syncNodeMediaAspect(node), null);
    assert.equal(ratio.has('--node-media-aspect'), false);
    Object.assign(image, { src: thumbnail, naturalWidth: 480, naturalHeight: 270 });
    assert.equal(syncNodeMediaAspect(node), surface);
    assert.equal(ratio.get('--node-media-aspect'), '480 / 270');
});

test('an eager canvas preview shows the queued thumbnail and keeps its authoritative original', async () => {
    const renderer = controlledPreviewRenderer();
    const img = displayImage();
    renderer.setImageElementSource(img, original, '本地原图', { preferImmediateSrc: true });
    assert.equal(img.src, TRANSPARENT_PREVIEW_PIXEL);
    assert.equal(img.dataset.originalSrc, original);
    assert.equal(img.loading, 'eager');

    renderer.setImageElementSource(img, original, '本地原图', { preferImmediateSrc: true });
    assert.equal(renderer.requests.length, 1);
    renderer.requests[0].resolve(thumbnail);
    await Promise.resolve();
    assert.equal(img.src, thumbnail);
    assert.equal(img.dataset.originalSrc, original);
    assert.equal(renderer.observing.has(img), false);
});

test('warming a visible preview promotes it without measuring the DOM or starting another request', () => {
    const renderer = controlledPreviewRenderer();
    const img = displayImage();
    img.getBoundingClientRect = () => assert.fail('visibility cannot synchronously measure each image');
    img.isConnected = false;
    renderer.setImageElementSource(img, original, '等待插入画布');
    const [{ priority }] = renderer.requests;
    assert.equal(priority.value, 0);
    img.isConnected = true;
    renderer.setVisibility(img, true);
    assert.equal(priority.value, 1);
    renderer.setVisibility(img, false);
    assert.equal(priority.value, 0);
    assert.equal(renderer.requests.length, 1);
});

test('cached display tiers bypass generation and explicitly original loads bypass the preview cache', () => {
    const renderer = controlledPreviewRenderer();
    const img = displayImage();
    renderer.cached.set(`${original}@96`, thumbnail);
    renderer.setImageElementSource(img, original, '缩略图', { thumbnailMaxEdge: 96 });
    assert.equal(img.src, thumbnail);
    assert.equal(renderer.requests.length, 0);
    renderer.setImageElementSource(img, original, '原图', { useThumbnail: false });
    assert.equal(img.src, original);
    assert.equal(img.dataset.originalSrc, undefined);
    assert.equal(renderer.requests.length, 0);
});

test('obsolete and detached previews ignore stale results and failed thumbnails fall back to the current image', async () => {
    const renderer = controlledPreviewRenderer();
    const img = displayImage();
    renderer.setImageElementSource(img, original, '旧图');
    renderer.setImageElementSource(img, replacement, '新图');
    assert.equal(renderer.requests[0].isCurrent(), false);
    renderer.requests[0].resolve(thumbnail);
    await Promise.resolve();
    assert.equal(img.src, TRANSPARENT_PREVIEW_PIXEL);
    assert.equal(renderer.observing.has(img), true);
    renderer.requests[1].reject(new Error('thumbnail unavailable'));
    await Promise.resolve();
    assert.equal(img.src, replacement);

    renderer.setImageElementSource(img, original, '等待载入');
    img.isConnected = false;
    assert.equal(renderer.requests[2].isCurrent(), false);
    renderer.requests[2].resolve(thumbnail);
    await Promise.resolve();
    assert.equal(img.src, TRANSPARENT_PREVIEW_PIXEL);
    assert.equal(renderer.observing.has(img), false);
});

test('a deferred preview cannot reinstate original pixels after intermediate memory is released', async () => {
    const renderer = controlledPreviewRenderer();
    const img = displayImage();
    renderer.setImageElementSource(img, original, '计算结果');
    delete img.dataset.originalSrc;
    renderer.requests[0].reject(new Error('thumbnail unavailable'));
    await Promise.resolve();
    assert.equal(img.src, TRANSPARENT_PREVIEW_PIXEL);
    assert.equal(renderer.observing.has(img), false);
});

test('a cached workflow can receive its completed preview while detached from the active canvas', async () => {
    const renderer = controlledPreviewRenderer();
    const img = displayImage();
    img.parentNode = {};
    img.closest = () => ({ dataset: { renderProjection: 'full' } });
    renderer.setImageElementSource(img, original, '工作流缩略图');
    assert.equal(renderer.requests[0].priority.value, 1, 'known canvas projection seeds the request before observer delivery');
    img.isConnected = false;
    renderer.setVisibility(img, false);
    assert.equal(renderer.requests[0].priority.value, 0);
    assert.equal(renderer.requests[0].isCurrent(), true);
    renderer.requests[0].resolve(thumbnail);
    await Promise.resolve();
    assert.equal(img.src, thumbnail);
});

test('releasing original pixels still allows a derived thumbnail, and drops pending animation work', async () => {
    const renderer = controlledPreviewRenderer();
    const still = displayImage();
    renderer.setImageElementSource(still, original, '等待缩略图');
    delete still.dataset.originalSrc;
    assert.equal(renderer.requests[0].isCurrent(), true);
    renderer.requests[0].resolve(thumbnail);
    await Promise.resolve();
    assert.equal(still.src, thumbnail);

    const animated = displayImage();
    renderer.setImageElementSource(animated, sourceFor('gif', 'GIF89a'), '等待动图', { preferImmediateSrc: true });
    delete animated.dataset.originalSrc;
    assert.equal(renderer.resolutions[0].isCurrent(), false);
    renderer.resolutions[0].resolve('640 × 480');
    await Promise.resolve();
    assert.equal(animated.src, TRANSPARENT_PREVIEW_PIXEL);
});
