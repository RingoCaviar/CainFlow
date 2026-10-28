import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaControllerApi } from '../js/features/media/media-controller.js';
import { applyImageSaveMediaState, serializeRuntimeNode } from '../js/features/workflow/workflow-runtime-manager.js';

const images = ['data:image/png;base64,first', 'data:image/png;base64,second'];
const videos = [{ id: 'first', url: 'https://example.test/first.mp4', assetKey: 'media:v1' }, { id: 'second', url: 'https://example.test/second.mp4', assetKey: 'media:v2' }];
function harness(data = {}) {
    const node = { id: 'save', type: 'ImageSave', data, el: { id: 'save', querySelector: () => null }, imagePreviewIndex: 1 };
    const state = { nodes: new Map([[node.id, node]]), connections: [], selectedNodeIds: new Set() };
    const documentRef = { activeElement: null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
    const api = createMediaControllerApi({ state, getNodeById: id => state.nodes.get(id), documentRef,
        windowRef: { requestAnimationFrame: () => 1, setTimeout: () => 1, clearTimeout() {} },
        getActiveWorkflowId: () => 'workflow-a', referenceMediaAsset: async () => true, removeMediaReference: async () => true,
        saveWorkflowNodeMediaAssets: async values => values.map((_value, index) => ({ asset_key: `media:image-${index}`, mediaTemporaryOwnerId: 'save-operation' })),
        getImageResolution: async () => '', estimateDataUrlSize: () => 10, scheduleSave() {}, showToast() {}, addLog() {} });
    return { api, node, documentRef };
}

test('runtime save state preserves the complete video list when an image batch arrives', () => {
    const node = { data: { videos, video: videos[1] } };
    const payload = applyImageSaveMediaState(node, { images, videos, video: videos[1] });
    assert.deepEqual(node.data.videos, videos);
    assert.deepEqual(payload.videos, videos);
    assert.deepEqual(payload.images, images);
});

test('save synchronization retains both complete media lists and their independent browsing positions', async () => {
    const { api, node } = harness();
    await api.syncImageSaveNode(node.id, { images, videos });
    assert.deepEqual(node.data.imageList, images);
    assert.deepEqual(node.data.videos, videos);
    assert.deepEqual(node.data.video, videos[1]);
    assert.equal(node.imagePreviewIndex, 1);
});

test('single-media updates keep the other saved output and empty inputs retain readable previous media', async () => {
    const { api, node } = harness({ imageList: images, videos, video: videos[1], mediaAssetKeys: ['media:i1', 'media:i2'] });
    await api.syncImageSaveNode(node.id, images);
    assert.deepEqual(node.data.videos, videos);
    await api.syncImageSaveNode(node.id, { videos: videos.slice(0, 1) });
    assert.deepEqual(node.data.imageList, images);
    assert.deepEqual(node.data.videos, videos.slice(0, 1));
    const refs = node.data.mediaAssetKeys.slice();
    await api.syncImageSaveNode(node.id, { images: [], videos: [] });
    assert.deepEqual(node.data.imageList, images);
    assert.deepEqual(node.data.mediaAssetKeys, refs);
    assert.deepEqual(node.data.videos, videos.slice(0, 1));
    assert.equal(node.saveInputState, 'stale');
});

test('background serialization reads the scoped filename draft and keeps both viewing preferences', () => {
    const { node, documentRef } = harness({ filename: 'retained', videos, video: videos[1] });
    node.parameterRoot = { querySelector: selector => selector === '#save-filename' ? { value: 'portal-draft' } : null };
    node.videoPreviewIndex = 0;
    node.savePreviewMode = 'image';
    documentRef.getElementById = () => ({ value: 'another-workflow' });
    const snapshot = serializeRuntimeNode(node, documentRef);
    assert.equal(snapshot.filename, 'portal-draft');
    assert.equal(snapshot.videoPreviewIndex, 0);
    assert.equal(snapshot.savePreviewMode, 'image');
});

test('manual Save sends every image and local video to the desktop bridge with the portalled filename', async () => {
    const saved = [], listeners = new Map();
    const videoBytes = new Uint8Array(1024); videoBytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
    const controls = {
        '#save-save-preview': { dataset: {}, addEventListener() {} },
        '#save-manual-save': { addEventListener: (event, callback) => listeners.set(event, callback) },
        '#save-view-full': { addEventListener() {} }
    };
    const root = { id: 'save', querySelector: selector => controls[selector] || null };
    const node = { id: 'save', type: 'ImageSave', el: root, data: { imageList: images, videos, video: videos[1] }, parameterRoot: { querySelector: selector => selector === '#save-filename' ? { value: 'mixed-prefix' } : null } };
    const api = createMediaControllerApi({ state: { nodes: new Map([[node.id, node]]), connections: [] }, getNodeById: () => node,
        windowRef: { location: { href: 'http://localhost/' }, __cainflowDesktop: { saveFile: async (...args) => { saved.push(args); return 'C:/exports/result'; } } },
        documentRef: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
        fetchRef: async url => { assert.match(url, /^\/api\/storage\/assets\/media%3Av[12]$/); return new Response(videoBytes, { headers: { 'Content-Type': 'video/mp4' } }); },
        showToast() {}, addLog() {}, scheduleSave() {}, estimateDataUrlSize: () => 0 });
    api.setupImageSave(node.id, root);
    await listeners.get('click')();
    assert.equal(saved.length, 4);
    assert.deepEqual(saved.slice(0, 2).map(item => item[2]), images);
    assert.ok(saved.slice(2).every(item => item[2] instanceof Blob && item[1] === 'video/mp4' && item[2].size === 1024));
    assert.ok(saved.every(item => item[0].startsWith('mixed-prefix')));
});
