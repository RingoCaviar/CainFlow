import test from 'node:test';
import assert from 'node:assert/strict';
import { readColorResetConfig } from '../js/features/media/color-reset-config.js';
import { createMediaControllerApi } from '../js/features/media/media-controller.js';

function element(value = '') {
    const listeners = new Map();
    const classes = new Set();
    return {
        value, checked: true, dataset: {}, innerHTML: '', textContent: '',
        style: { setProperty() {}, removeProperty() {} },
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
        addEventListener(name, handler) { listeners.set(name, [...(listeners.get(name) || []), handler]); },
        async fire(name, event = {}) { for (const handler of listeners.get(name) || []) await handler(event); },
        querySelector() { return null; }, querySelectorAll() { return []; }, setAttribute() {}
    };
}

function harness(type, data = {}, fields = {}, dependencies = {}) {
    const controls = new Map(Object.entries(fields).map(([name, value]) => [`#process-${name}`, element(value)]));
    const root = element();
    root.id = 'process';
    root.querySelector = selector => controls.get(selector) || null;
    const node = { id: 'process', type, el: root, data, ...data };
    const state = { nodes: new Map([[node.id, node]]), connections: [], selectedNodeIds: new Set() };
    const timers = new Map();
    const documentRef = { activeElement: null, addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
        getElementById: id => controls.get(`#${id}`) || null };
    const api = createMediaControllerApi({ state, getNodeById: id => state.nodes.get(id), documentRef,
        windowRef: { setTimeout(callback) { timers.set(timers.size + 1, callback); return timers.size; }, clearTimeout(id) { timers.delete(id); }, requestAnimationFrame() { return 1; } },
        detectOutputFormat: () => 'image/png', estimateDataUrlSize: () => 1, getImageResolution: async () => '',
        scheduleSave() {}, showToast() {}, addLog() {}, ...dependencies });
    return { api, node, root, controls, timers, state };
}

test('ColorReset reads portalled controls and ignores another workflow with the same node ID', () => {
    const node = { id: 'same-id', data: { whiteBalanceMode: 'custom', temperature: 23, saturation: -4 },
        el: { querySelector: () => null },
        parameterRoot: { querySelector: selector => selector === '#same-id-temperature' ? { value: '37' } : null } };
    const foreignDocument = { getElementById: () => ({ value: '99' }) };
    assert.equal(readColorResetConfig(node, foreignDocument).temperature, 37);
    assert.equal(readColorResetConfig(node, foreignDocument).saturation, -4);
    delete node.el;
    delete node.parameterRoot;
    assert.equal(readColorResetConfig(node, foreignDocument).temperature, 23);
});

test('resize and color input edits update the existing node state before preview debounce', async () => {
    const resize = harness('ImageResize', {}, { 'resize-mode': 'scale', 'scale-percent': '100', quality: '92', 'target-width': '', 'target-height': '', 'keep-aspect': '' });
    resize.api.setupImageResize('process', resize.root);
    resize.controls.get('#process-scale-percent').value = '43';
    await resize.controls.get('#process-scale-percent').fire('input');
    assert.equal(resize.node.scalePercent, 43);
    assert.equal(resize.node.data.scalePercent, 43);
    resize.controls.get('#process-quality').value = '77';
    await resize.controls.get('#process-quality').fire('input');
    assert.equal(resize.node.data.quality, 77);

    const color = harness('ColorReset', {}, { 'white-balance': 'original', temperature: '0', 'temperature-value': '0', tint: '0', 'tint-value': '0', vibrance: '0', 'vibrance-value': '0', saturation: '0', 'saturation-value': '0' });
    color.api.setupColorReset('process', color.root);
    color.controls.get('#process-temperature').value = '31';
    await color.controls.get('#process-temperature').fire('input');
    assert.equal(color.node.temperature, 31);
    assert.equal(color.node.data.temperature, 31);
    color.controls.get('#process-white-balance').value = 'auto';
    await color.controls.get('#process-white-balance').fire('change');
    assert.equal(color.node.data.whiteBalanceMode, 'auto');
});

test('missing upstream input preserves each processing node retained image and media identity', async () => {
    for (const type of ['ImageResize', 'ColorReset']) {
        const retained = 'data:image/png;base64,retained';
        const { api, node } = harness(type, { image: retained, mediaAssetKeys: ['media:retained'], imageAssetKey: 'media:retained', imageAssetReady: true });
        node.imageData = retained;
        if (type === 'ImageResize') await api.refreshImageResizePreview(node.id);
        else await api.refreshColorResetPreview(node.id);
        assert.equal(node.data.image, retained, type);
        assert.deepEqual(node.data.mediaAssetKeys, ['media:retained'], type);
        assert.equal(node.data.imageAssetKey, 'media:retained', type);
        assert.equal(node.data.imageAssetReady, true, type);
    }
});

test('an unmounted resize preview uses its persisted settings instead of a same-ID workflow control', async () => {
    const received = [];
    const { api, node } = harness('ImageResize', {
        resizeMode: 'dimensions', scalePercent: 43, targetWidth: '73', targetHeight: '42', keepAspect: false, quality: 77
    }, { 'resize-mode': 'scale', 'scale-percent': '99', quality: '99' }, {
        resizeImageData: async (_source, config) => {
            received.push(config);
            return { dataUrl: 'data:image/png;base64,result', outputWidth: 73, outputHeight: 42, outputFormat: 'image/png', estimatedBytes: 12 };
        }
    });
    delete node.el;
    await api.refreshImageResizePreview(node.id, { sourceImage: 'data:image/png;base64,source' });
    assert.deepEqual(received, [{ mode: 'dimensions', scalePercent: 43, targetWidth: '73', targetHeight: '42', keepAspect: false, quality: 77, format: 'image/png' }]);
    assert.equal(node.data.outputFormat, 'image/png');
    assert.equal(node.outputWidth, 73);
});

test('a missing input invalidates a previously pending color preview without overwriting its retained result', async () => {
    let finishProcessing;
    const retained = 'data:image/png;base64,retained';
    const { api, node } = harness('ColorReset', { image: retained }, {}, {
        processColorResetImage: () => new Promise(resolve => { finishProcessing = resolve; })
    });
    const pending = api.refreshColorResetPreview(node.id, { sourceImage: 'data:image/png;base64,previous-source' });
    await Promise.resolve();
    await api.refreshColorResetPreview(node.id);
    finishProcessing({ dataUrl: 'data:image/png;base64,stale-result' });
    assert.equal(await pending, null);
    assert.equal(node.data.image, retained);
});

test('processing parameter events respect clone, disabled and running locks', async () => {
    for (const lock of ['clone', 'disabled', 'running']) {
        const { api, node, root, controls, state } = harness('ImageResize', { scalePercent: 100 }, { 'resize-mode': 'scale', 'scale-percent': '100' });
        api.setupImageResize(node.id, root);
        if (lock === 'clone') node.isClone = true;
        if (lock === 'disabled') node.enabled = false;
        if (lock === 'running') state.runningNodeIds = new Set([node.id]);
        controls.get('#process-scale-percent').value = '17';
        await controls.get('#process-scale-percent').fire('input');
        assert.equal(node.data.scalePercent, 100, lock);
    }
});

test('color preview keeps formal media identity and its operation protection after persistence', async () => {
    const { api, node } = harness('ColorReset', { mediaAssetKeys: ['media:previous'], imageAssetKey: 'media:previous' }, {}, {
        getActiveWorkflowId: () => 'workflow-a',
        processColorResetImage: async () => ({ dataUrl: 'data:image/png;base64,result' }),
        saveWorkflowNodeMediaAsset: async () => ({ asset_key: 'media:result', mediaTemporaryOwnerId: 'operation-a' })
    });
    await api.refreshColorResetPreview(node.id, { sourceImage: 'data:image/png;base64,source' });
    await node.colorResetAssetWrite;
    assert.deepEqual(node.data.mediaAssetKeys, ['media:result']);
    assert.equal(node.data.imageAssetKey, 'media:result');
    assert.equal(node.data.imageAssetReady, true);
    assert.deepEqual(node.data.mediaOwnershipTemporaryOwners, [{ ownerId: 'operation-a', assetKeys: ['media:result'] }]);
});

test('dependent processing previews consume the first source image while preserving the full source batch', async () => {
    for (const type of ['ImageResize', 'ColorReset']) {
        const received = [];
        const process = async source => { received.push(source); return { dataUrl: source }; };
        const { api, node, state } = harness(type, {}, {}, { resizeImageData: process, processColorResetImage: process });
        const images = ['data:image/png;base64,first', 'data:image/png;base64,last'];
        const source = { id: 'source', type: 'ImageGenerate', imagePreviewIndex: 1, data: { imageList: images } };
        state.nodes.set(source.id, source);
        state.connections.push({ from: { nodeId: source.id, port: 'image' }, to: { nodeId: node.id, port: 'image' } });
        await api.refreshDependentImageResizePreviews(source.id);
        assert.deepEqual(received, [images[0]], type);
        assert.deepEqual(source.data.imageList, images, type);
        await api.refreshDependentImageResizePreviews(source.id, { sourceImage: [null, images[1]] });
        assert.equal(received.length, 1, 'a missing first source slot never selects a later image');
        source.data.mediaIntegrity = { missingItems: [{ position: 0 }] };
        await api.refreshDependentImageResizePreviews(source.id);
        assert.equal(received.length, 1, 'a known missing original never falls back to its displayed batch item');
    }
});

