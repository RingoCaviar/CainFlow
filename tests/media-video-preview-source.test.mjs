import assert from 'node:assert/strict';
import test from 'node:test';
import { getVideoPreviewSource } from '../js/features/media/media-controller.js';

test('saved video preview uses its local Media asset instead of the provider URL', () => {
    assert.equal(
        getVideoPreviewSource({ assetKey: 'media:abc/中文', url: 'https://provider.example/video.mp4' }),
        '/api/storage/assets/media%3Aabc%2F%E4%B8%AD%E6%96%87'
    );
});

test('legacy video has no automatic remote source when its Media asset is absent', () => {
    assert.equal(getVideoPreviewSource({ url: 'https://provider.example/video.mp4' }), '');
});
