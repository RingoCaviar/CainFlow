import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaControllerApi } from '../js/features/media/media-controller.js';

function control(value = '') {
    const listeners = new Map(), classes = new Set();
    return {
        value, checked: true, dataset: {}, innerHTML: '', textContent: '',
        style: { setProperty() {}, removeProperty() {} },
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
            toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
        addEventListener(name, handler) { listeners.set(name, [...(listeners.get(name) || []), handler]); },
        async fire(name, event = {}) { for (const handler of listeners.get(name) || []) await handler(event); },
        querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
        setAttribute() {}, focus() {}
    };
}

function resizeNode(width, height) {
    const controls = new Map(Object.entries({ 'resize-mode': 'dimensions', 'scale-percent': '100', quality: '92',
        'target-width': width, 'target-height': height, 'keep-aspect': '' }).map(([key, value]) => [key, control(value)]));
    const root = control(); root.id = 'same';
    root.querySelector = selector => controls.get(selector.replace('#same-', '')) || null;
    return { node: { id: 'same', type: 'ImageResize', el: root, data: { targetWidth: width, targetHeight: height } }, controls };
}

function harness(current, dependencies = {}) {
    const state = { nodes: new Map([[current.node.id, current.node]]), connections: [], selectedNodeIds: new Set() };
    let saves = 0;
    const documentRef = { activeElement: null, addEventListener() {}, removeEventListener() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        getElementById(id) { return state.nodes.get('same')?.el?.querySelector?.(`#${id}`) || null; } };
    const api = createMediaControllerApi({ state, getNodeById: id => state.nodes.get(id), documentRef,
        windowRef: { setTimeout() { return 1; }, clearTimeout() {}, requestAnimationFrame() { return 1; } },
        detectOutputFormat: () => 'image/png', estimateDataUrlSize: () => 1, getImageResolution: async () => '',
        scheduleSave() { saves++; }, showToast() {}, addLog() {}, ...dependencies });
    return { api, state, saves: () => saves };
}

function deferred() {
    let resolve;
    const promise = new Promise(finish => { resolve = finish; });
    return { promise, resolve };
}

test('a delayed resize aspect lookup cannot edit another workflow with the same node ID', async () => {
    const a = resizeNode('100', '50'), b = resizeNode('999', '777');
    const resolution = deferred(), started = deferred();
    const { api, state } = harness(a, { getImageResolution: () => { started.resolve(); return resolution.promise; } });
    const source = { id: 'source', type: 'ImageGenerate', data: { imageList: ['data:image/png;base64,c291cmNl'] } };
    state.nodes.set(source.id, source);
    state.connections.push({ from: { nodeId: source.id, port: 'image' }, to: { nodeId: a.node.id, port: 'image' } });
    api.setupImageResize(a.node.id, a.node.el);
    const editing = a.controls.get('target-width').fire('input');
    await started.promise;
    state.nodes.set(b.node.id, b.node);
    resolution.resolve('200x100');
    await editing;
    assert.equal(b.controls.get('target-height').value, '777');
    assert.equal(a.node.data.targetWidth, '100');
    assert.equal(a.node.data.targetHeight, '50');
});

test('a delayed resize aspect lookup cannot overwrite a newer dimension edit', async () => {
    const current = resizeNode('100', '50');
    const resolutions = [deferred(), deferred()], starts = [deferred(), deferred()];
    let reads = 0;
    const { api, state } = harness(current, { getImageResolution: () => {
        const index = reads++; starts[index].resolve(); return resolutions[index].promise;
    } });
    const source = { id: 'source', type: 'ImageGenerate', data: { imageList: ['data:image/png;base64,b2xk'] } };
    state.nodes.set(source.id, source);
    state.connections.push({ from: { nodeId: source.id, port: 'image' }, to: { nodeId: current.node.id, port: 'image' } });
    api.setupImageResize(current.node.id, current.node.el);
    const oldEdit = current.controls.get('target-width').fire('input');
    await starts[0].promise;
    source.data.imageList = ['data:image/png;base64,bmV3'];
    current.controls.get('target-height').value = '200';
    const newEdit = current.controls.get('target-height').fire('input');
    await starts[1].promise;
    resolutions[1].resolve('100x200');
    await newEdit;
    resolutions[0].resolve('200x100');
    await oldEdit;
    assert.equal(current.controls.get('target-width').value, '100');
    assert.equal(current.controls.get('target-height').value, '200');
    assert.equal(current.node.data.targetHeight, '200');
});

test('a delayed resize aspect lookup is discarded after replacing its input source', async () => {
    const current = resizeNode('200', '777'), resolution = deferred(), started = deferred();
    let reads = 0;
    const { api, state, saves } = harness(current, { getImageResolution: () => {
        if (++reads === 1) { started.resolve(); return resolution.promise; }
        return Promise.resolve('100x200');
    } });
    const a = { id: 'source-a', type: 'ImageGenerate', data: { imageList: ['data:image/png;base64,b2xk'] } };
    const b = { id: 'source-b', type: 'ImageGenerate', data: { imageList: ['data:image/png;base64,bmV3'] } };
    state.nodes.set(a.id, a); state.nodes.set(b.id, b);
    state.connections.push({ id: 'input', from: { nodeId: a.id, port: 'image' }, to: { nodeId: current.node.id, port: 'image' } });
    api.setupImageResize(current.node.id, current.node.el);
    const oldEdit = current.controls.get('target-width').fire('input');
    await started.promise;
    state.connections[0] = { ...state.connections[0], from: { nodeId: b.id, port: 'image' } };
    const before = saves();
    resolution.resolve('200x100');
    await oldEdit;
    assert.equal(current.controls.get('target-height').value, '777');
    assert.equal(current.node.data.targetHeight, '777');
    assert.equal(saves(), before, 'the discarded source lookup must not schedule a save');
    await current.controls.get('target-width').fire('input');
    assert.equal(current.controls.get('target-height').value, '400', 'a new edit uses the current source aspect');
});

test('a delayed resize original read is discarded when the same source receives a new asset', async () => {
    const current = resizeNode('200', '777'), pixels = deferred(), started = deferred();
    const oldImage = 'data:image/png;base64,b2xk', newImage = 'data:image/png;base64,bmV3';
    let dimensionReads = 0;
    const { api, state, saves } = harness(current, {
        getImageAsset: async () => { started.resolve(); await pixels.promise; return oldImage; },
        getImageResolution: async image => { dimensionReads++; return image === oldImage ? '200x100' : '100x200'; }
    });
    const source = { id: 'source', type: 'ImageGenerate', data: {
        imageCount: 1, imageAssetKey: 'media:old', mediaAssetKeys: ['media:old']
    } };
    state.nodes.set(source.id, source);
    state.connections.push({ from: { nodeId: source.id, port: 'image' }, to: { nodeId: current.node.id, port: 'image' } });
    api.setupImageResize(current.node.id, current.node.el);
    const oldEdit = current.controls.get('target-width').fire('input');
    await started.promise;
    source.data.mediaAssetKeys = ['media:new'];
    source.data.imageAssetKey = 'media:new';
    const before = saves();
    pixels.resolve();
    await oldEdit;
    assert.equal(current.controls.get('target-height').value, '777');
    assert.equal(saves(), before);
    assert.equal(dimensionReads, 0, 'a stale original must be rejected before reading its dimensions');
    source.data.imageList = [newImage];
    await current.controls.get('target-width').fire('input');
    assert.equal(current.controls.get('target-height').value, '400');
});

test('delayed save keyboard navigation cannot change or save another workflow with the same node ID', async () => {
    function saveNode() {
        const preview = control(); delete preview.querySelector;
        const root = control(); root.id = 'same';
        root.querySelector = selector => selector === '#same-save-preview' ? preview : null;
        return { node: { id: 'same', type: 'ImageSave', el: root, imagePreviewIndex: 0,
            data: { imageCount: 2, imageAssetKey: 'media:first', mediaAssetKeys: ['media:first', 'media:second'] } }, preview };
    }
    const a = saveNode(), b = saveNode(), pixels = deferred(), started = deferred();
    const { api, state, saves } = harness(a, { getImageAsset: key => {
        started.resolve();
        return pixels.promise.then(() => key === 'media:first' ? 'data:image/png;base64,Zmlyc3Q=' : 'data:image/png;base64,c2Vjb25k');
    } });
    api.setupImageSave(a.node.id, a.node.el);
    await a.preview.fire('keydown', { key: 'ArrowRight', target: a.preview, preventDefault() {}, stopPropagation() {} });
    await started.promise;
    state.nodes.set(b.node.id, b.node);
    const before = saves();
    pixels.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(b.node.imagePreviewIndex, 0);
    assert.equal(a.node.imagePreviewIndex, 0);
    assert.equal(saves(), before, 'a discarded navigation must not save the newly active workflow');
});
