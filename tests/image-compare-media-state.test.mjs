import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaControllerApi } from '../js/features/media/media-controller.js';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { serializeRuntimeNode } from '../js/features/workflow/workflow-runtime-manager.js';

function element(tagName = 'div') {
    const listeners = new Map(), values = new Map(), attributes = new Map();
    const el = { tagName: tagName.toUpperCase(), className: '', children: [], dataset: {}, isConnected: true,
        style: { setProperty: (key, value) => values.set(key, value), getPropertyValue: key => values.get(key) || '', removeProperty: key => values.delete(key) },
        classList: { contains: name => el.className.split(' ').includes(name), add(...names) { el.className = [...new Set([...el.className.split(' ').filter(Boolean), ...names])].join(' '); }, remove(...names) { el.className = el.className.split(' ').filter(name => !names.includes(name)).join(' '); }, toggle(name, active) { active ? this.add(name) : this.remove(name); } },
        appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
        append(...children) { children.forEach(child => el.appendChild(child)); },
        querySelector(selector) { return el.children.find(child => selector === 'img' ? child.tagName === 'IMG' : selector.startsWith('.') ? child.classList.contains(selector.slice(1)) : selector === `#${child.id}`) || null; },
        querySelectorAll(selector) { return selector.split(',').flatMap(part => el.children.filter(child => part.trim().startsWith('.') && child.classList.contains(part.trim().slice(1)))); },
        addEventListener(name, handler) { listeners.set(name, [...(listeners.get(name) || []), handler]); },
        async fire(name, event = {}) { for (const handler of listeners.get(name) || []) await handler({ preventDefault() {}, stopPropagation() {}, ...event }); },
        setAttribute: (key, value) => attributes.set(key, String(value)), getAttribute: key => attributes.get(key) || null,
        getBoundingClientRect: () => ({ left: 10, top: 10, width: 200, height: 100 }),
        remove() { el.parentNode.children = el.parentNode.children.filter(child => child !== el); }
    };
    Object.defineProperty(el, 'src', { get: () => attributes.get('src') || '', set: value => attributes.set('src', value) });
    return el;
}

function harness(data = {}, dependencies = {}) {
    const preview = element(), root = element(); root.id = 'compare';
    const map = new Map([['compare-compare', preview]]);
    root.querySelector = selector => map.get(selector.slice(1)) || null;
    const node = { id: 'compare', type: 'ImageCompare', el: root, data, compareImageA: data.compareImageA, compareImageB: data.compareImageB };
    const state = { nodes: new Map([[node.id, node]]), connections: [], selectedNodeIds: new Set() };
    const documentRef = { activeElement: null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: tag => element(tag), createElementNS: (_namespace, tag) => element(tag), getElementById: id => map.get(id) || null };
    const api = createMediaControllerApi({ state, getNodeById: id => state.nodes.get(id), documentRef,
        windowRef: { requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {}, Image: class { set src(_value) { queueMicrotask(() => this.onerror?.()); } } },
        getActiveWorkflowId: () => 'workflow-a', referenceMediaAsset: async () => true,
        removeMediaReference: async () => true, getImageResolution: async () => '', estimateDataUrlSize: () => 10,
        showToast() {}, addLog() {}, scheduleSave() {}, ...dependencies });
    return { api, node, preview, root, state, documentRef };
}

test('missing B keeps the retained compare image and media references readable with an explicit stale state', async () => {
    const retained = 'data:image/png;base64,retained';
    const { api, node, preview } = harness({ compareImageB: retained, image: retained, mediaAssetKeys: ['media:retained'], imageAssetKey: 'media:retained', imageAssetReady: true });
    api.setupImageCompare(node.id, node.el);
    await api.syncImageCompareNode(node.id, null, null);
    assert.equal(node.data.image, retained);
    assert.equal(node.compareImageB, retained);
    assert.deepEqual(node.data.mediaAssetKeys, ['media:retained']);
    assert.equal(preview.dataset.compareState, 'stale');
    assert.match(preview.dataset.compareMessage, /B.*未更新/);
    assert.ok(preview.querySelector('.image-compare-b'));
});

test('comparison divider state survives rendering and runtime serialization including the zero endpoint', async () => {
    const { api, node, preview, documentRef } = harness({ comparePosition: 23, compareImageA: 'data:image/png;base64,a', compareImageB: 'data:image/png;base64,b' });
    api.setupImageCompare(node.id, node.el);
    assert.equal(preview.style.getPropertyValue('--compare-x'), '23%');
    await preview.fire('mousemove', { clientX: 156 });
    assert.equal(node.comparePosition, 73);
    assert.equal(node.data.comparePosition, 73);
    const divider = preview.querySelector('.image-compare-divider');
    assert.equal(divider.getAttribute('role'), 'slider');
    await preview.fire('keydown', { key: 'End', target: { closest: () => divider } });
    assert.equal(node.comparePosition, 100);
    await preview.fire('keydown', { key: 'Home', target: { closest: () => divider } });
    assert.equal(node.comparePosition, 0);
    await preview.fire('mousemove', { clientX: 10 });
    assert.equal(node.comparePosition, 0);
    assert.equal(serializeRuntimeNode(node, documentRef).comparePosition, 0);
});

test('compare forwards only its primary B media identity and leaves both source batches intact', async () => {
    const { api, node, state } = harness();
    const images = ['data:image/png;base64,first', 'data:image/png;base64,second'];
    const keys = ['media:first', 'media:second'];
    const source = { id: 'source', type: 'ImageGenerate', data: { imageList: images, mediaAssetKeys: keys, imageAssetReady: true } };
    state.nodes.set(source.id, source);
    state.connections.push({ id: 'b', from: { nodeId: source.id, port: 'image' }, to: { nodeId: node.id, port: 'imageB' } });
    await api.syncImageCompareNode(node.id);
    assert.equal(node.data.image, images[0]);
    assert.deepEqual(node.data.mediaAssetKeys, [keys[0]]);
    assert.equal(node.data.imageCount, 1);
    assert.deepEqual(source.data.mediaAssetKeys, keys);
    assert.deepEqual(source.data.imageList, images);
});

test('compare rejects a missing primary B slot instead of selecting the next image', async () => {
    const node = { id: 'compare', type: 'ImageCompare', data: {} };
    const received = [];
    const api = createExecutionCoreApi({ state: { nodes: new Map([[node.id, node]]), connections: [], models: [], providers: [] }, nodeConfigs: {}, documentRef: { getElementById: () => null },
        windowRef: { requestAnimationFrame: () => 1 }, syncImageCompareNode: async (...args) => received.push(args), refreshDependentImageResizePreviews: async () => {} });
    await assert.rejects(api.nodeHandlers.ImageCompare(node, { imageB: [null, 'data:image/png;base64,later'] }), error => error.inputPort === 'imageB');
    assert.deepEqual(received, [[node.id, null, null]], 'the rejected run updates only the retained preview state');
});
