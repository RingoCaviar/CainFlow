import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceImageCatalog } from '../js/features/media/reference-image-catalog.js';

const red = 'data:image/png;base64,cmVk';
const blue = 'data:image/png;base64,Ymx1ZQ==';
const yellow = 'data:image/png;base64,eWVsbG93';
const remote = 'https://example.invalid/reference.png';
const stateFor = (nodes, connections = []) => ({ nodes: new Map(nodes.map(node => [node.id, node])), connections });
const edge = (id, from, to, port, order) => ({ id, from: { nodeId: from, port: 'image' }, to: { nodeId: to, port }, order });

test('upstream candidates follow connected frame and batch order, excluding missing positions', async () => {
    const frame = { id: 'frame', type: 'ImageImport', importMode: 'url', imageUrl: remote };
    const batch = { id: 'batch', type: 'ImageGenerate', customTitle: '商品图', data: {
        mediaAssetKeys: ['media:a', 'media:b', 'media:c'], imageList: [blue, yellow],
        imagePreviewThumbnail: yellow, mediaIntegrity: { state: 'missing', missingItems: [{ position: 0 }] }
    } };
    const disabled = { id: 'disabled', type: 'ImageImport', enabled: false, data: { image: red } };
    const target = { id: 'target', type: 'VideoGenerate' };
    const state = stateFor([frame, batch, disabled, target], [
        edge('last', 'disabled', 'target', 'referenceImages', 2),
        edge('batch', 'batch', 'target', 'referenceImages', 1),
        edge('first', 'frame', 'target', 'image_1')
    ]);
    const catalog = createReferenceImageCatalog({ state, getImageAsset: async key => key === 'media:b' ? blue : yellow });
    const items = catalog.getUpstream('target');
    assert.deepEqual(items.map(({ connectionId, targetPort, referenceNumber, name, assetKey }) => (
        [connectionId, targetPort, referenceNumber, name, assetKey]
    )), [
        ['first', 'image_1', 1, 'reference.png', undefined],
        ['batch', 'referenceImages', 3, '商品图 · 2', 'media:b'],
        ['batch', 'referenceImages', 4, '商品图 · 3', 'media:c']
    ]);
    assert.equal(items[0].imageUrl, remote);
    assert.equal(await catalog.readImage(items[1]), blue);
    assert.equal(await catalog.readThumbnail(items[1]), blue, 'a batch slot never shows the thumbnail of a different image');
    assert.ok(catalog.getCanvas().some(item => item.id === items[1].sourceId));
});

test('scene candidates include imports, canvas output and directory history without eagerly reading originals', async () => {
    const imported = { id: 'import', type: 'ImageImport', imageImportFileName: 'product.png',
        data: { imageImportAssetKey: 'media:import', imagePreviewThumbnail: red } };
    const derived = { id: 'derived', type: 'ColorReset', colorResetPreviewData: blue };
    const video = { id: 'video', type: 'VideoGenerate', data: { videoAssetKey: 'media:video', mediaAssetKeys: ['media:video'] } };
    const readAssets = [];
    const readHistory = [];
    const catalog = createReferenceImageCatalog({ state: stateFor([imported, derived, video]),
        getHistoryMetadata: async options => {
            assert.equal(options.thumbnailUrls, true);
            return [
                { id: 23, mediaType: 'video', relativePath: 'motion.mp4' },
                { id: 12, mediaType: 'image', relativePath: 'backdrops/studio.png', prompt: '柔和棚拍',
                    thumbUrl: '/api/storage/library/12/thumbnail?v=8:91', fileVersion: '8:91' },
                { id: -8, mediaType: 'image', relativePath: 'old.png', fileUrl: '/api/storage/library/-8/file', fileVersion: '5:20' }
            ];
        },
        getHistoryEntry: async (id, options) => {
            readHistory.push([id, options.fileVersion]);
            return { mediaType: 'image', image: red, fileVersion: id === '12' ? '8:91' : '' };
        },
        getImageAsset: async key => { readAssets.push(key); return red; }
    });
    const [first, second, history, older] = await catalog.getScene();
    assert.deepEqual([first, second, history, older].map(({ kind, name }) => [kind, name]), [
        ['import', 'product.png'], ['canvas', '复位颜色'], ['history', 'studio.png'], ['history', 'old.png']
    ]);
    assert.match(history.searchText, /柔和棚拍/);
    assert.deepEqual(readAssets, []);
    assert.deepEqual(readHistory, []);
    assert.equal(await catalog.readThumbnail(first), red);
    assert.equal(await catalog.readThumbnail(history), '/api/storage/library/12/thumbnail?v=8:91');
    assert.equal(await catalog.readThumbnail(older), '/api/storage/library/-8/file?v=5%3A20');
    assert.deepEqual(readAssets, []);
    assert.deepEqual(readHistory, []);
    assert.equal(await catalog.readImage({ historyId: history.historyId, historyVersion: history.historyVersion }), red);
    assert.deepEqual(readHistory, [['12', '8:91']]);
});

test('reference originals are fenced against replaced files and changed raw node outputs', async () => {
    const raw = { id: 'raw', type: 'ImageGenerate', data: { image: red } };
    const state = stateFor([raw]);
    const catalog = createReferenceImageCatalog({ state,
        getHistoryEntry: async () => ({ mediaType: 'image', image: blue, fileVersion: 'new' }) });
    const [image] = catalog.getCanvas();
    const saved = { sourceNodeId: image.sourceNodeId, sourceImageIndex: image.sourceImageIndex, imageFingerprint: image.imageFingerprint };
    assert.equal(await catalog.readImage(saved), red);
    assert.equal(await catalog.readImage(saved, { state: stateFor([{ ...raw, data: { image: red } }]) }), red);
    raw.data.image = blue;
    assert.equal(await catalog.readImage(saved), '');
    assert.equal(await catalog.readImage(image), '');
    assert.equal(await catalog.readImage({ historyId: '12', historyVersion: 'old' }), '');
});

test('legacy image-list assets resolve the original at each requested position', async () => {
    const node = { id: 'legacy', type: 'ImagePreview', data: { imageAssetKey: 'legacy', imageCount: 2 } };
    const catalog = createReferenceImageCatalog({ state: stateFor([node]), getImageAssetList: async () => [red, blue] });
    const items = catalog.getCanvas();
    assert.equal(items.length, 2);
    assert.equal(await catalog.readImage(items[1]), blue);
    assert.equal(await catalog.readImage({ assetKey: items[0].assetKey, legacyAssetIndex: items[0].legacyAssetIndex }), red);
});

test('a history failure keeps canvas resources available and reports that the list is partial', async () => {
    const catalog = createReferenceImageCatalog({ state: stateFor([{ id: 'import', type: 'ImageImport', data: { image: red } }]),
        getHistoryMetadata: async () => { throw new Error('directory unavailable'); } });
    const items = await catalog.getScene();
    assert.equal(items[0].sourceNodeId, 'import');
    assert.match(items.warning, /目录历史读取失败/);
});

test('a saved camera view can be referenced independently of its input image', async () => {
    const camera = { id: 'camera', type: 'CameraControl', data: { image: red, cameraPreviewImage: blue } };
    const catalog = createReferenceImageCatalog({ state: stateFor([camera]) });
    const [image] = catalog.getCanvas();
    assert.equal(image.name, '视角控制 · 视角预览');
    assert.equal(await catalog.readImage(image), blue);
    assert.equal(await catalog.readThumbnail(image), blue);
});

test('a full canvas candidate stops resolving when its node output changes during an asset read', async () => {
    const imported = { id: 'import', type: 'ImageImport', data: { imageImportAssetKey: 'media:before' } };
    let resolveAsset;
    const catalog = createReferenceImageCatalog({ state: stateFor([imported]),
        getImageAsset: () => new Promise(resolve => { resolveAsset = resolve; }) });
    const pending = catalog.readImage(catalog.getCanvas()[0]);
    imported.data.imageImportAssetKey = 'media:after';
    resolveAsset(red);
    assert.equal(await pending, '');
});
