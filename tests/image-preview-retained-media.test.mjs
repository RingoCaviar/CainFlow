import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaControllerApi } from '../js/features/media/media-controller.js';

function mediaHarness(nodes, documentRef = {}, overrides = {}) {
    const state = { nodes: new Map(nodes.map(node => [node.id,node])), connections: [], selectedNodes: new Set(), runningNodeIds: new Set() };
    const operations = [];
    const api = createMediaControllerApi({ state, getNodeById: id => state.nodes.get(id),
        documentRef: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, ...documentRef },
        windowRef: { requestAnimationFrame: callback => callback(), setTimeout: () => 1, clearTimeout() {}, addEventListener() {} },
        getActiveWorkflowId: () => 'workflow',
        removeMediaReference: async (...args) => { operations.push(['release',...args]); return true; },
        saveWorkflowNodeMediaAsset: async (...args) => { operations.push(['save',...args]); return null; },
        getImageAsset: async (...args) => { operations.push(['read',...args]); return null; },
        showToast() {}, addLog() {}, scheduleSave() {}, estimateDataUrlSize: () => 0, getImageResolution: async () => null,
        ...overrides
    });
    return { state, api, operations };
}

test('empty preview input retains the complete current-session media and browse position without changing ownership', async () => {
    const node = { id: 'preview', type: 'ImagePreview', previewZoom: 1.75, imagePreviewIndex: 1,
        data: { imageList: ['first','second'], mediaAssetKeys: ['media:first','media:second'], imageAssetKey: 'media:first', imageCount: 2, imageAssetReady: true } };
    const { api, operations } = mediaHarness([node]);
    await api.syncImagePreviewNode(node.id, []);
    assert.deepEqual(node.data.imageList, ['first','second']);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:first','media:second']);
    assert.equal(node.imagePreviewIndex, 1);
    assert.equal(node.previewZoom, 1.75);
    assert.equal(node.previewInputState, 'stale');
    assert.deepEqual(operations, [], 'missing input does not release, read or persist a replacement image');
});

test('a first-use preview with no input stays empty', async () => {
    const node = { id: 'preview', type: 'ImagePreview', data: {} };
    const { api, operations } = mediaHarness([node]);
    await api.syncImagePreviewNode(node.id, []);
    assert.equal(node.previewInputState, 'empty');
    assert.equal(node.data.imageList, undefined);
    assert.deepEqual(operations, []);
});

test('import mode synchronization reaches its own portalled controls without writing another workflow with the same node ID', async () => {
    const mode = { value: 'upload' }, foreignMode = { value: 'foreign' }, url = { value: '', addEventListener() {} };
    const classes = new Set(['hidden']);
    const urlFields = { hidden: true, dataset: { imageImportMode: 'url' }, classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } } };
    const ownControls = new Map([['#import-import-mode',mode],['#import-url-input',url]]);
    const cardControls = new Map(['file','drop','select-btn'].map(suffix => [`#import-${suffix}`, { style: {}, addEventListener() {} }]));
    const node = { id: 'import', type: 'ImageImport', importMode: 'url', imageUrl: 'https://images.test/current.png', data: {},
        el: { id: 'import', querySelector: selector => cardControls.get(selector) || null, querySelectorAll: () => [] },
        parameterRoot: { querySelector: selector => ownControls.get(selector) || null,
            querySelectorAll: selector => selector.includes('data-image-import-mode') ? [urlFields] : [] } };
    const { api } = mediaHarness([node], { getElementById: id => id === 'import-import-mode' ? foreignMode : null });
    api.setupImageImport(node.id, node.el);
    await Promise.resolve();
    assert.equal(mode.value, 'url');
    assert.equal(foreignMode.value, 'foreign');
    assert.equal(url.value, node.imageUrl);
    assert.equal(urlFields.hidden, false);
    assert.equal(classes.has('hidden'), false);
});

test('refreshing an unchanged preview batch keeps the existing image index and local zoom', async () => {
    const images = ['first','second'];
    const node = { id: 'preview', type: 'ImagePreview', imagePreviewIndex: 1, previewZoom: 1.75, data: { imageList: images, imageCount: 2 } };
    const { api } = mediaHarness([node]);
    await api.syncImagePreviewNode(node.id, images);
    assert.equal(node.imagePreviewIndex, 1);
    assert.equal(node.previewZoom, 1.75);
    assert.deepEqual(node.data.imageList, images);
});

test('preview fullscreen context preserves a missing first slot instead of shifting later originals', async () => {
    const node = { id: 'preview', type: 'ImagePreview', imagePreviewIndex: 1,
        data: { imageList: ['second','third'], mediaAssetKeys: ['media:first','media:second','media:third'], imageCount: 3,
            mediaIntegrity: { missingItems: [{ position: 0 }] } } };
    const { api } = mediaHarness([node]);
    const context = await api.getNodeFullscreenImageContext(node.id);
    assert.deepEqual(context.images, ['','second','third']);
    assert.equal(context.index, 1);
    assert.equal(context.images[context.index], 'second');
});

test('a delayed preview original read cannot mark a replacement batch as missing', async () => {
    const node = { id: 'preview', type: 'ImagePreview', imagePreviewIndex: 0,
        data: { imageList: ['old-second'], mediaAssetKeys: ['media:old-first','media:old-second'], imageCount: 2 } };
    const reads = [];
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const { api } = mediaHarness([node], {}, { getImageAsset: () => new Promise(resolve => {
        reads.push(resolve);
        if (reads.length === 2) ready();
    }) });
    const reading = api.getNodeFullscreenImageContext(node.id);
    await started;
    node.data.imageList = ['new-first','new-second'];
    node.data.mediaAssetKeys = ['media:new-first','media:new-second'];
    reads.forEach((resolve,index) => resolve(index ? 'old-second' : null));
    const context = await reading;
    assert.equal(node.data.mediaIntegrity, undefined);
    assert.deepEqual(context.images, [], 'a changed batch does not open an outdated original');
    assert.equal(context.cancelled, true);
});
