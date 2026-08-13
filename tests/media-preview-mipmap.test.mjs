import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaPreviewCache } from '../js/features/media/media-preview-cache.js';

test('display MIPmaps leave non-inline source images authoritative', async () => {
    const cache = createMediaPreviewCache({ getImageResolution: () => '', documentRef: {}, windowRef: {} });
    const source = 'https://example.test/original.png';
    const mipmap = await cache.createDisplayMipmap(source, 160);
    assert.equal(mipmap, source);
    assert.equal(source, 'https://example.test/original.png');
});
