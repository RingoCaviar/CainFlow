import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNodePersistenceExtensions, applyNodePersistenceExtensions, applyWorkflowPersistenceExtensions } from '../js/nodes/node-persistence-extensions.js';
import { createNodeSerializer } from '../js/nodes/node-serializer.js';
import { serializeRuntimeNode } from '../js/features/workflow/workflow-runtime-manager.js';

test('opaque JSON extensions keep falsy values and detach nested snapshots while known stale state cannot reappear', () => {
    const node = {}, source = { vendor: { nested: [0, false, null] }, zero: 0, no: false, empty: null,
        prompt: 'stale prompt', images: ['old original'], imageData: 'old base64', imageDataList: ['old original'], mediaAssetKeys: ['media:stale'], resizePreviewData: 'old preview', colorResetPreviewData: 'old preview',
        imageMergeInputCount: 7, textMergeInputCount: 9,
        generationRevision: { version: 1, dirty: true }, imageDescription: 'old annotation',
        data: { plugin: { values: [null, 0, false] }, image: 'old image', images: ['old original'], video: { assetKey: 'media:stale' },
            protocolParams: { old: true }, protocolVariantDrafts: { old: true }, generationRevision: { version: 1, dirty: true } } };
    captureNodePersistenceExtensions(node, source);
    source.vendor.nested.push('later mutation'); source.data.plugin.values[0] = 'later mutation';
    const current = { id: 'node', prompt: 'authoritative current prompt', generationRevision: { version: 1, dirty: false }, imageDescription: 'new annotation' };
    const serialized = applyNodePersistenceExtensions(node, current);
    assert.deepEqual(serialized, { vendor: { nested: [0, false, null] }, zero: 0, no: false, empty: null,
        ...current, data: { plugin: { values: [null, 0, false] } } });
    serialized.vendor.nested.push('snapshot mutation');
    assert.deepEqual(applyNodePersistenceExtensions(node, current).vendor.nested, [0, false, null]);
});

test('own JSON prototype-named keys remain data without changing object prototypes', () => {
    const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"marker":0}},"data":{"__proto__":{"flag":false}}}');
    const node = {}; captureNodePersistenceExtensions(node, source);
    const saved = applyNodePersistenceExtensions(node, { id: 'safe' });
    assert.equal(Object.getPrototypeOf(saved), Object.prototype);
    assert.equal(Object.hasOwn(saved, '__proto__'), true);
    assert.deepEqual(saved.__proto__, { polluted: true });
    assert.deepEqual(saved.data.__proto__, { flag: false });
    assert.equal(Object.prototype.polluted, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(saved)).constructor, { prototype: { marker: 0 } });
});

test('visible and detached node serialization share the same opaque extension boundary', () => {
    const node = { id: 'text', type: 'Text', x: 10, y: 20, width: 260, height: 220, userResized: true, enabled: true, data: {} };
    const restore = { vendor: { future: [false, 0, null] }, data: { plugin: { version: 8 } }, text: 'old known text', images: ['old known output'] };
    captureNodePersistenceExtensions(node, restore);
    const documentRef = { getElementById: id => id === 'text-text' ? { value: 'current text' } : null, querySelectorAll: () => [] };
    const visible = createNodeSerializer({ state: { nodes: new Map([[node.id, node]]) }, documentRef }).serializeNodes()[0];
    const detached = serializeRuntimeNode(node, documentRef);
    for (const saved of [visible, detached]) {
        assert.deepEqual(saved.vendor, restore.vendor); assert.deepEqual(saved.data, restore.data);
        assert.equal(saved.text, 'current text'); assert.equal(Object.hasOwn(saved, 'images'), false);
        const recreated = {}; captureNodePersistenceExtensions(recreated, saved);
        assert.deepEqual(applyNodePersistenceExtensions(recreated, { text: 'next revision' }).vendor, restore.vendor);
    }
});

test('non-JSON runtime objects and accessors never enter opaque persistence', () => {
    const source = { safe: [null, 0, false], runtime: new Map([['large', 'object']]), fn() {}, infinite: Infinity };
    const arrayAccessor = [0];
    Object.defineProperty(arrayAccessor, '0', { get() { throw new Error('must not execute array accessor'); } });
    source.arrayAccessor = arrayAccessor;
    Object.defineProperty(source, 'getter', { enumerable: true, get() { throw new Error('must not execute'); } });
    Object.defineProperty(source, 'data', { enumerable: true, get() { throw new Error('must not execute data accessor'); } });
    const node = {}; captureNodePersistenceExtensions(node, source);
    assert.deepEqual(applyNodePersistenceExtensions(node, {}), { safe: [null, 0, false] });
});

test('workflow and canvas extensions preserve own JSON while current graph state and private application settings stay authoritative', () => {
    const previous = JSON.parse('{"__proto__":{"rootFlag":false},"vendorWorkflow":[null,0,false],"canvas":{"x":88,"y":99,"zoom":2,"__proto__":{"viewportFlag":0},"vendorViewport":{"values":[0,false,null]}},"nodes":[{"id":"old"}],"connections":[{"id":"old-edge"}],"promptAgent":{"draft":"old chat"},"version":"old","providers":[{"apikey":"old-secret"}],"models":[{"id":"old-model"}],"apikey":"old-secret"}');
    const current = { canvas: { x: 1, y: 2, zoom: 0.75 }, nodes: [], connections: [], promptAgent: null, version: 'current' };
    const saved = applyWorkflowPersistenceExtensions(previous, current);
    assert.deepEqual(saved, { ...JSON.parse('{"__proto__":{"rootFlag":false}}'), vendorWorkflow: [null, 0, false], ...current,
        canvas: { ...JSON.parse('{"__proto__":{"viewportFlag":0}}'), vendorViewport: { values: [0, false, null] }, ...current.canvas } });
    saved.vendorWorkflow.push('snapshot mutation'); saved.canvas.vendorViewport.values.push('snapshot mutation');
    const next = applyWorkflowPersistenceExtensions(previous, current);
    assert.deepEqual(next.vendorWorkflow, [null, 0, false]);
    assert.deepEqual(next.canvas.vendorViewport.values, [0, false, null]);
    assert.equal(Object.getPrototypeOf(saved), Object.prototype);
    assert.equal(Object.hasOwn(saved, '__proto__'), true); assert.equal(Object.hasOwn(saved.canvas, '__proto__'), true);
    assert.equal(Object.prototype.rootFlag, undefined); assert.equal(Object.prototype.viewportFlag, undefined);
});
