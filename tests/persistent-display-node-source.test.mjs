import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createWorkflowRunnerApi } from '../js/features/execution/workflow-runner.js';
import { commerceImageSetSourceKey } from '../js/features/ecommerce-image-set/commerce-image-set-plan.js';
import { applyImageSaveMediaState } from '../js/features/workflow/workflow-runtime-manager.js';
import { createNodeElement as element } from './helpers/node-element-fixture.mjs';

function documentRef() {
    return {
        defaultView: { requestAnimationFrame: (callback) => callback(), addEventListener() {}, removeEventListener() {} },
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement: () => element(),
        addEventListener() {},
        removeEventListener() {},
        body: element()
    };
}

function createRunner({ nodes, connections, executeNode, getCachedOutputValue, getImageAsset, selectedNodeIds }) {
    const mode = selectedNodeIds ? 'selected-only' : 'all';
    const nodeIds = selectedNodeIds ?? nodes.map(node => node.id);
    const state = {
        nodes: new Map(nodes.map((node) => [node.id, node])),
        connections,
        providers: [], models: [], selectedNodes: new Set(selectedNodeIds),
        runningNodeIds: new Set(), runningNodeCancelHandlers: new Map()
    };
    const inputs = Object.fromEntries(nodes.map((node) => [
        node.id,
        connections.filter((connection) => connection.to.nodeId === node.id)
    ]));
    const incoming = Object.fromEntries(nodeIds.map(id => [id, inputs[id].filter(edge => nodeIds.includes(edge.from.nodeId))]));
    return createWorkflowRunnerApi({
        state,
        nodeConfigs: Object.fromEntries(nodes.map((node) => [node.type, {
            title: node.type,
            outputs: node.type === 'ImageSave'
                ? [{ name: 'image', type: 'image' }, { name: 'video', type: 'video' }]
                : [{ name: 'image', type: 'image' }]
        }])),
        documentRef: documentRef(),
        confirmRef: () => true,
        resolveExecutionPlan: () => ({
            mode, nodeIds, executionOrder: nodeIds, scopeNodeSet: new Set(nodeIds), inputConnectionsByNode: inputs,
            incomingConnectionsByNode: incoming, externalInputsByNode: {}
        }),
        normalizeRunOptions: () => ({ mode, selectedNodeIds }),
        getCachedOutputValue,
        getImageAsset,
        executeNode,
        addNode: () => null,
        generateId: () => 'unused',
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {},
        updateAllConnections: () => {}, updatePortStyles: () => {},
        getAbortMessage: () => 'stopped', playNotificationSound: () => {}
    });
}

test('preview with no current input keeps its image batch available to downstream nodes', async () => {
    const preview = {
        id: 'preview', type: 'ImagePreview', enabled: true, el: element(),
        data: { imageList: ['image-one', 'image-two'], imageAssetKey: 'preview', imageCount: 2, imageAssetReady: true }
    };
    const downstream = { id: 'downstream', type: 'ImageSave', enabled: true, el: element(), data: {} };
    const received = [];
    const runner = createRunner({
        nodes: [preview, downstream],
        connections: [{ id: 'image', type: 'image', from: { nodeId: 'preview', port: 'image' }, to: { nodeId: 'downstream', port: 'image' } }],
        getCachedOutputValue: (node, port) => port === 'image' ? node.data.imageList : undefined,
        executeNode: async (node, inputs) => { if (node.id === 'downstream') received.push(inputs.image); }
    });

    const result = await runner.runWorkflow();

    assert.equal(result.reason, 'finished');
    assert.deepEqual(preview.data.imageList, ['image-one', 'image-two']);
    assert.equal(preview.data.imageAssetKey, 'preview');
    assert.deepEqual(received, [['image-one', 'image-two']]);
});

test('a downstream-only run restores every commerce output in order from its retained media keys', async () => {
    const assets = new Map([['media:one', 'image-one'], ['media:two', 'image-two']]);
    for (const imageList of [[], ['image-two']]) {
        const commerce = { id: 'commerce', type: 'ECommerceImageSet', enabled: true, el: element(),
            data: { imageList, imageAssetKey: 'media:one', mediaAssetKeys: ['media:one', 'media:two'], imageCount: 2 } };
        const downstream = { id: 'downstream', type: 'ImageSave', enabled: true, el: element(), data: {} };
        const received = [];
        const runner = createRunner({
            nodes: [commerce, downstream], selectedNodeIds: [downstream.id],
            connections: [{ id: 'image', type: 'image', from: { nodeId: commerce.id, port: 'image' },
                to: { nodeId: downstream.id, port: 'image' } }],
            getCachedOutputValue: (node, port) => port === 'image' ? node.data.imageList : undefined,
            getImageAsset: async key => assets.get(key),
            executeNode: async (node, inputs) => {
                assert.equal(node.id, downstream.id);
                received.push(inputs.image);
            }
        });

        assert.equal((await runner.runWorkflow()).reason, 'finished');
        assert.deepEqual(received, [['image-one', 'image-two']]);
    }
});

test('downstream-only reuse verifies legacy commerce output against the connected product reference', async () => {
    const original = 'data:image/png;base64,AAAA';
    const replacement = 'data:image/png;base64,AAAB';
    const reference = { id: 'reference', type: 'ImageImport', enabled: true,
        data: { mediaAssetKeys: ['media:source'], imageCount: 1 } };
    const commerce = { id: 'commerce', type: 'ECommerceImageSet', enabled: true, el: element(),
        data: { imageList: ['suite-image'], mediaAssetKeys: ['media:result'], imageCount: 1,
            commerceImageSet: { platformId: 'amazon', selectedShotIds: ['main'], plan: {} } } };
    const settings = commerce.data.commerceImageSet;
    settings.plan.sourceKey = await commerceImageSetSourceKey({ settings, references: [original] });
    const downstream = { id: 'downstream', type: 'ImageSave', enabled: true, el: element(), data: {} };
    const received = [];
    let referenceImage = original;
    const runner = createRunner({
        nodes: [reference, commerce, downstream], selectedNodeIds: [downstream.id],
        connections: [
            { id: 'source', type: 'image', from: { nodeId: reference.id, port: 'image' },
                to: { nodeId: commerce.id, port: 'referenceImages' } },
            { id: 'output', type: 'image', from: { nodeId: commerce.id, port: 'image' },
                to: { nodeId: downstream.id, port: 'image' } }
        ],
        getCachedOutputValue: () => undefined,
        getImageAsset: async key => key === 'media:source' ? referenceImage : '',
        executeNode: async (_node, inputs) => { received.push(inputs.image); }
    });

    assert.equal((await runner.runWorkflow()).reason, 'finished');
    assert.deepEqual(received, ['suite-image']);
    for (const unapproved of [replacement, '']) {
        referenceImage = unapproved;
        await assert.rejects(runner.runWorkflow(), /参考图.*变更.*重新规划/);
    }
    settings.plan = null;
    settings.previousExportResults = [{ outputKey: 'media:result', referenceRevision: 'v1:["media:source"]' }];
    reference.data.mediaAssetKeys = [];
    await assert.rejects(runner.runWorkflow(), /参考图.*变更.*重新规划/);
    assert.deepEqual(received, ['suite-image']);
});

test('save node with no current input keeps its video available to downstream nodes', async () => {
    const video = { id: 'video-result', url: '/api/storage/assets/media%3Avideo', assetKey: 'media:video' };
    const saved = { id: 'saved', type: 'ImageSave', enabled: true, el: element(), data: { video } };
    const downstream = { id: 'downstream', type: 'ImageSave', enabled: true, el: element(), data: {} };
    const received = [];
    const runner = createRunner({
        nodes: [saved, downstream],
        connections: [{ id: 'video', type: 'video', from: { nodeId: 'saved', port: 'video' }, to: { nodeId: 'downstream', port: 'video' } }],
        getCachedOutputValue: (node, port) => port === 'video' ? node.data.video : undefined,
        executeNode: async (node, inputs) => { if (node.id === 'downstream') received.push(inputs.video); }
    });

    const result = await runner.runWorkflow();

    assert.equal(result.reason, 'finished');
    assert.deepEqual(saved.data.video, video);
    assert.deepEqual(received, [video]);
});

test('empty preview and save inputs do not clear media already held by the node', async () => {
    const preview = { id: 'preview', type: 'ImagePreview', data: { imageList: ['old-image'] } };
    const saved = { id: 'saved', type: 'ImageSave', data: { imageList: ['old-image'] } };
    const cleared = [];
    const api = createExecutionCoreApi({
        state: { nodes: new Map([[preview.id, preview], [saved.id, saved]]), connections: [], models: [], providers: [] },
        nodeConfigs: {}, documentRef: documentRef(), windowRef: documentRef().defaultView,
        syncImagePreviewNode: async (_id, images) => { if (images.length === 0) cleared.push('preview'); },
        syncImageSaveNode: async (_id, value) => { if ((value.images || []).length === 0 && !value.video) cleared.push('save'); },
        refreshDependentImageResizePreviews: async () => {}, fitNodeToContent: () => {}
    });

    await api.nodeHandlers.ImagePreview(preview, {});
    await api.nodeHandlers.ImageSave(saved, {});

    assert.deepEqual(cleared, []);
    assert.deepEqual(preview.data.imageList, ['old-image']);
    assert.deepEqual(saved.data.imageList, ['old-image']);
});

test('non-empty display-node inputs replace old media and become the public output', async () => {
    const preview = { id: 'preview', type: 'ImagePreview', data: { imageList: ['old-image'] } };
    const saved = { id: 'saved', type: 'ImageSave', data: { video: { id: 'old-video', url: 'old.mp4' } } };
    const api = createExecutionCoreApi({
        state: { nodes: new Map([[preview.id, preview], [saved.id, saved]]), connections: [], models: [], providers: [] },
        nodeConfigs: {}, documentRef: documentRef(), windowRef: documentRef().defaultView,
        syncImagePreviewNode: async (_id, images) => { preview.data.imageList = images.slice(); },
        syncImageSaveNode: async (_id, value) => {
            saved.data.videos = value.videos.slice();
            saved.data.video = value.video;
        },
        autoSaveToDir: async () => {},
        refreshDependentImageResizePreviews: async () => {}, fitNodeToContent: () => {}
    });
    const newVideos = [
        { id: 'video-one', assetKey: 'media:one' },
        { id: 'video-two', assetKey: 'media:two' }
    ];

    await api.nodeHandlers.ImagePreview(preview, { image: ['new-one', 'new-two'] });
    await api.nodeHandlers.ImageSave(saved, { video: newVideos });

    assert.deepEqual(api.getCachedOutputValue(preview, 'image'), ['new-one', 'new-two']);
    assert.deepEqual(api.getCachedOutputValue(saved, 'video'), newVideos);
});

test('background save-node synchronization retains the complete ordered video batch', () => {
    const saved = { id: 'saved', type: 'ImageSave', data: {} };
    const videos = [
        { id: 'first', url: 'first.mp4', assetKey: 'media:first' },
        { id: 'second', url: 'second.mp4', assetKey: 'media:second' }
    ];

    const result = applyImageSaveMediaState(saved, { videos, video: videos[1] });

    assert.deepEqual(saved.data.videos, videos);
    assert.deepEqual(saved.data.video, videos[1]);
    assert.deepEqual(result.videos, videos);
    assert.deepEqual(result.video, videos[1]);
});
