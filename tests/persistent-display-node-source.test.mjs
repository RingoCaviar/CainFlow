import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createWorkflowRunnerApi } from '../js/features/execution/workflow-runner.js';
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

function createRunner({ nodes, connections, executeNode, getCachedOutputValue }) {
    const state = {
        nodes: new Map(nodes.map((node) => [node.id, node])),
        connections,
        providers: [], models: [], selectedNodes: new Set(),
        runningNodeIds: new Set(), runningNodeCancelHandlers: new Map()
    };
    const inputs = Object.fromEntries(nodes.map((node) => [
        node.id,
        connections.filter((connection) => connection.to.nodeId === node.id)
    ]));
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
            mode: 'all', nodeIds: nodes.map((node) => node.id), executionOrder: nodes.map((node) => node.id),
            scopeNodeSet: new Set(nodes.map((node) => node.id)), inputConnectionsByNode: inputs,
            incomingConnectionsByNode: inputs, externalInputsByNode: {}
        }),
        normalizeRunOptions: () => ({ mode: 'all' }),
        getCachedOutputValue,
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
