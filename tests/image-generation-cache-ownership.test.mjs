import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createWorkflowRunnerApi } from '../js/features/execution/workflow-runner.js';
import {
    getNodeImageResultPersistence,
    hasNodeCapability,
    IMAGE_RESULT_PERSISTENCE,
    NODE_CAPABILITIES
} from '../js/nodes/registry.js';
import { createNodeElement } from './helpers/node-element-fixture.mjs';

test('image generation is an image producer without display-image cache capabilities', () => {
    assert.equal(hasNodeCapability('ImageGenerate', NODE_CAPABILITIES.IMAGE_RESULT), true);
    assert.equal(hasNodeCapability('ImageGenerate', NODE_CAPABILITIES.CANONICAL_IMAGES), true);
    assert.equal(hasNodeCapability('ImageGenerate', NODE_CAPABILITIES.RECOVERABLE_IMAGE_ASSET), false);
    assert.equal(hasNodeCapability('ImageGenerate', NODE_CAPABILITIES.IMAGE_RESTORE), false);
    assert.equal(hasNodeCapability('ImageGenerate', NODE_CAPABILITIES.NODE_ID_IMAGE_ASSET), false);
    assert.equal(hasNodeCapability('ImageGenerate', NODE_CAPABILITIES.PREVIEW_THUMBNAIL_RESTORE), false);
});

test('node capabilities are the authority for image-result persistence', () => {
    assert.equal(getNodeImageResultPersistence('ImageGenerate'), IMAGE_RESULT_PERSISTENCE.TRANSIENT);
    assert.equal(getNodeImageResultPersistence('ImagePreview'), IMAGE_RESULT_PERSISTENCE.PERSISTENT);
    assert.equal(getNodeImageResultPersistence('ImageSave'), IMAGE_RESULT_PERSISTENCE.PERSISTENT);
    assert.equal(getNodeImageResultPersistence('ImageResize'), IMAGE_RESULT_PERSISTENCE.PERSISTENT);
});

test('image generation publishes its result without retaining a generation-node image cache', async () => {
    const generated = {
        id: 'generate-1',
        type: 'ImageGenerate',
        data: { imageAssetKey: 'generate-1', imageAssetReady: true }
    };
    const preview = { id: 'preview-1', type: 'ImagePreview', data: {} };
    const savedKeys = [];
    const deletedKeys = [];
    const propagated = [];
    const elements = new Map(Object.entries({
        'generate-1-apiconfig': { value: 'model' },
        'generate-1-provider': { value: 'provider' },
        'generate-1-aspect': { value: '1:1' },
        'generate-1-resolution': { value: '1024x1024' },
        'generate-1-quality': { value: 'auto' },
        'generate-1-moderation': { value: 'auto' },
        'generate-1-background': { value: 'auto' },
        'generate-1-search': { checked: false },
        'generate-1-generation-count': { value: '1' },
        'generate-1-prompt': { value: 'prompt' }
    }));
    const api = createExecutionCoreApi({
        state: {
            nodes: new Map([[generated.id, generated], [preview.id, preview]]),
            connections: [{
                from: { nodeId: generated.id, port: 'image' },
                to: { nodeId: preview.id, port: 'image' }
            }],
            models: [{ id: 'model', name: 'Image model', modelId: 'image-model', protocol: 'openai', providerIds: ['provider'] }],
            providers: [{ id: 'provider', name: 'Provider', endpoint: 'https://example.test/v1', apikey: '<REDACTED>', type: 'openai' }]
        },
        nodeConfigs: {},
        documentRef: { getElementById: (id) => elements.get(id) || null, querySelectorAll: () => [] },
        windowRef: { requestAnimationFrame: (callback) => callback() },
        fetchRef: async () => ({
            ok: true,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ data: [{ b64_json: 'AAAA' }] }),
            json: async () => ({ data: [{ b64_json: 'AAAA' }] })
        }),
        getProxyHeaders: () => ({}),
        showToast: () => {},
        addLog: () => {},
        logRequestToPanel: () => {},
        recordNodeRequest: () => {},
        saveHistoryEntry: async () => true,
        saveImageAsset: async (key) => { savedKeys.push(key); return true; },
        saveImageAssetList: async (key) => { savedKeys.push(key); return true; },
        deleteImageAsset: async (key) => { deletedKeys.push(key); return true; },
        releaseNodeImageData: async () => false,
        syncImagePreviewNode: async (nodeId, images) => { propagated.push([nodeId, images]); },
        refreshDependentImageResizePreviews: async () => {},
        fitNodeToContent: () => {},
        getAbortMessage: () => ''
    });

    await api.nodeHandlers.ImageGenerate(generated, {}, new AbortController().signal);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(generated.data.imageList, ['data:image/png;base64,AAAA']);
    assert.deepEqual(propagated, [['preview-1', ['data:image/png;base64,AAAA']]]);
    assert.deepEqual(savedKeys, []);
    assert.deepEqual(deletedKeys, ['generate-1']);
    assert.equal(generated.data.imageAssetKey, undefined);
    assert.equal(generated.data.imageAssetReady, undefined);
});

test('batched workflow generation leaves persistence to its downstream display node', async () => {
    const prompt = { id: 'prompts', type: 'Text', enabled: true, data: { texts: ['first', 'second'] }, el: createNodeElement() };
    const generated = { id: 'generate', type: 'ImageGenerate', enabled: true, data: {}, el: createNodeElement() };
    const preview = { id: 'preview', type: 'ImagePreview', enabled: true, data: {}, el: createNodeElement() };
    const connections = [
        { id: 'prompt-input', type: 'text', from: { nodeId: 'prompts', port: 'text' }, to: { nodeId: 'generate', port: 'prompt' } },
        { id: 'image-output', type: 'image', from: { nodeId: 'generate', port: 'image' }, to: { nodeId: 'preview', port: 'image' } }
    ];
    const state = {
        nodes: new Map([[prompt.id, prompt], [generated.id, generated], [preview.id, preview]]),
        connections,
        providers: [], models: [], selectedNodes: new Set(),
        runningNodeIds: new Set(), runningNodeCancelHandlers: new Map(), concurrentRequestMode: false
    };
    const generatedCacheWrites = [];
    const downstreamImages = [];
    const executed = [];
    const inputConnectionsByNode = {
        prompts: [],
        generate: [connections[0]],
        preview: [connections[1]]
    };
    const documentRef = {
        defaultView: { requestAnimationFrame: (callback) => callback(), addEventListener() {}, removeEventListener() {} },
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement: () => createNodeElement(),
        addEventListener() {},
        removeEventListener() {},
        body: createNodeElement()
    };
    const api = createWorkflowRunnerApi({
        state,
        nodeConfigs: {
            Text: { title: '文本', outputs: [{ name: 'text', type: 'text' }] },
            ImageGenerate: { title: '图片生成', outputs: [{ name: 'image', type: 'image' }] },
            ImagePreview: { title: '图片预览', outputs: [{ name: 'image', type: 'image' }] }
        },
        documentRef,
        confirmRef: () => true,
        resolveExecutionPlan: () => ({
            mode: 'all',
            nodeIds: ['prompts', 'generate', 'preview'],
            executionOrder: ['prompts', 'generate', 'preview'],
            scopeNodeSet: new Set(['prompts', 'generate', 'preview']),
            inputConnectionsByNode,
            incomingConnectionsByNode: inputConnectionsByNode,
            externalInputsByNode: {}
        }),
        normalizeRunOptions: () => ({ mode: 'all' }),
        getCachedOutputValue: (node, port) => port === 'text' ? node.data.texts : node.data.imageList,
        executeNode: async (node, inputs) => {
            executed.push([node.type, inputs]);
            if (node.type === 'Text') {
                node.data.texts = ['first', 'second'];
                return;
            }
            if (node.type === 'ImageGenerate') {
                const image = `data:image/png;base64,${inputs.prompt}`;
                node.data.imageList = [image];
                return { image };
            }
        },
        addNode: () => null,
        generateId: () => 'unused',
        showToast: () => {},
        addLog: () => {},
        scheduleSave: () => {},
        updateAllConnections: () => {},
        updatePortStyles: () => {},
        saveImageAsset: async (key) => { generatedCacheWrites.push(key); return true; },
        saveImageAssetList: async (key) => { generatedCacheWrites.push(key); return true; },
        deleteImageAsset: async () => true,
        syncImagePreviewNode: async (nodeId, images) => { downstreamImages.push([nodeId, images]); },
        refreshDependentImageResizePreviews: async () => {},
        getAbortMessage: () => '已停止',
        playNotificationSound: () => {}
    });

    const result = await api.runWorkflow();

    assert.equal(result.reason, 'finished');
    assert.deepEqual(executed.map(([type]) => type), ['Text', 'ImageGenerate', 'ImageGenerate', 'ImagePreview']);
    assert.deepEqual(generatedCacheWrites, []);
    assert.deepEqual(downstreamImages.at(-1), ['preview', [
        'data:image/png;base64,first',
        'data:image/png;base64,second'
    ]]);
    assert.equal(generated.data.imageAssetKey, undefined);
});
