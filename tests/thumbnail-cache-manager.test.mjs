import test from 'node:test';
import assert from 'node:assert/strict';
import { createThumbnailCacheManager } from '../js/features/media/state/thumbnail-cache-manager.js';

const first = 'data:image/png;base64,first';
const second = 'data:image/png;base64,second';

function setup() {
    const node = { id: 'import', data: {} };
    const pending = [];
    let saves = 0;
    const api = createThumbnailCacheManager({
        previewCache: {
            createPreviewThumbnail(source) {
                return new Promise(resolve => pending.push({ source, resolve }));
            }
        },
        getNodeById: id => id === node.id ? node : null,
        PERSISTED_PREVIEW_THUMBNAIL_MAX_LENGTH: 0,
        scheduleSave() { saves += 1; }
    });
    return { api, node, pending, saves: () => saves };
}

test('clearing an import while its first preview is pending cannot bring the old thumbnail back', async () => {
    const { api, node, pending, saves } = setup();
    const request = api.cacheNodePreviewThumbnail(node.id, first);
    await Promise.resolve();
    assert.equal(api.clearNodePreviewThumbnail(node.id), false);
    pending[0].resolve('old thumbnail');

    assert.equal(await request, '');
    assert.equal(node.data.imagePreviewThumbnail, undefined);
    assert.equal(saves(), 0);
});

test('repeated renders share the pending thumbnail and an older result cannot replace the newer image', async () => {
    const { api, node, pending, saves } = setup();
    const request = api.cacheNodePreviewThumbnail(node.id, first);
    const repeated = api.cacheNodePreviewThumbnail(node.id, first);
    await Promise.resolve();
    const latest = api.cacheNodePreviewThumbnail(node.id, second);
    await Promise.resolve();
    assert.deepEqual(pending.map(item => item.source), [first, second]);
    pending[1].resolve('new thumbnail');
    pending[0].resolve('old thumbnail');

    assert.equal(await latest, 'new thumbnail');
    assert.equal(await request, '');
    assert.equal(await repeated, '');
    assert.equal(node.data.imagePreviewThumbnail, 'new thumbnail');
    assert.equal(saves(), 1);
});
