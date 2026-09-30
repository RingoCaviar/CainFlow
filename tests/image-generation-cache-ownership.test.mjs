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

test('image generation owns a recoverable image result', () => {
    assert.equal(hasNodeCapability('ImageGenerate', NODE_CAPABILITIES.IMAGE_RESULT), true);
    assert.equal(hasNodeCapability('ImageGenerate', NODE_CAPABILITIES.CANONICAL_IMAGES), true);
    assert.equal(hasNodeCapability('ImageGenerate', NODE_CAPABILITIES.RECOVERABLE_IMAGE_ASSET), true);
    assert.equal(hasNodeCapability('ImageGenerate', NODE_CAPABILITIES.IMAGE_RESTORE), true);
    assert.equal(hasNodeCapability('ImageGenerate', NODE_CAPABILITIES.NODE_ID_IMAGE_ASSET), false);
    assert.equal(hasNodeCapability('ImageGenerate', NODE_CAPABILITIES.PREVIEW_THUMBNAIL_RESTORE), false);
});

test('node capabilities are the authority for image-result persistence', () => {
    assert.equal(getNodeImageResultPersistence('ImageGenerate'), IMAGE_RESULT_PERSISTENCE.PERSISTENT);
    assert.equal(getNodeImageResultPersistence('ImagePreview'), IMAGE_RESULT_PERSISTENCE.PERSISTENT);
    assert.equal(getNodeImageResultPersistence('ImageSave'), IMAGE_RESULT_PERSISTENCE.PERSISTENT);
    assert.equal(getNodeImageResultPersistence('ImageResize'), IMAGE_RESULT_PERSISTENCE.PERSISTENT);
});

test('image generation persists its result for restart and still publishes downstream', async () => {
    const generated = {
        id: 'generate-1',
        type: 'ImageGenerate',
        data: { imageAssetKey: 'generate-1', imageAssetReady: true }
    };
    const preview = { id: 'preview-1', type: 'ImagePreview', data: {} };
    const savedKeys = [];
    const deletedKeys = [];
    const propagated = [];
    let saveCount = 0;
    const updatedNodes = [];
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
        getActiveWorkflowId: () => 'workflow-1',
        saveWorkflowNodeMediaAsset: async (image, workflowId, nodeId) => {
            savedKeys.push([workflowId, nodeId, image]);
            return { asset_key: 'media:generated' };
        },
        saveImageAsset: async (key) => { savedKeys.push(key); return true; },
        saveImageAssetList: async (key) => { savedKeys.push(key); return true; },
        deleteImageAsset: async (key) => { deletedKeys.push(key); return true; },
        releaseNodeImageData: async () => false,
        syncImagePreviewNode: async (nodeId, images) => { propagated.push([nodeId, images]); },
        refreshDependentImageResizePreviews: async () => {},
        fitNodeToContent: () => {},
        scheduleSave: () => { saveCount += 1; },
        onNodeResultUpdated: (nodeId) => updatedNodes.push(nodeId),
        getAbortMessage: () => ''
    });

    await api.nodeHandlers.ImageGenerate(generated, {}, new AbortController().signal);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(generated.data.imageList, ['data:image/png;base64,AAAA']);
    assert.deepEqual(propagated, [
        ['preview-1', ['data:image/png;base64,AAAA']],
        ['preview-1', ['data:image/png;base64,AAAA']]
    ]);
    assert.deepEqual(savedKeys, [['workflow-1', 'generate-1', 'data:image/png;base64,AAAA']]);
    assert.deepEqual(deletedKeys, []);
    assert.equal(generated.data.imageAssetKey, 'media:generated');
    assert.deepEqual(generated.data.mediaAssetKeys, ['media:generated']);
    assert.equal(generated.data.imageAssetReady, true);
    assert.ok(saveCount > 0);
    assert.ok(updatedNodes.includes('generate-1'));
});

function createSequentialGenerationHarness(saveMediaAsset, { withSaveNode = false } = {}) {
    const node = { id: 'generate-sequential', type: 'ImageGenerate', data: {} };
    const save = { id: 'save-sequential', type: 'ImageSave', data: {} };
    const elements = new Map(Object.entries({
        'generate-sequential-apiconfig': { value: 'model' },
        'generate-sequential-provider': { value: 'provider' },
        'generate-sequential-aspect': { value: '1:1' },
        'generate-sequential-resolution': { value: '1024x1024' },
        'generate-sequential-quality': { value: 'auto' },
        'generate-sequential-moderation': { value: 'auto' },
        'generate-sequential-background': { value: 'auto' },
        'generate-sequential-search': { checked: false },
        'generate-sequential-generation-count': { value: '1' },
        'generate-sequential-prompt': { value: 'prompt' }
    }));
    let requestCount = 0;
    const state = {
        nodes: new Map([[node.id, node], ...(withSaveNode ? [[save.id, save]] : [])]),
        connections: withSaveNode ? [{ from: { nodeId: node.id, port: 'image' }, to: { nodeId: save.id, port: 'image' } }] : [],
        models: [{ id: 'model', name: 'Image model', modelId: 'image-model', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', name: 'Provider', endpoint: 'https://example.test/v1', apikey: '<REDACTED>', type: 'openai' }]
    };
    const api = createExecutionCoreApi({
        state, nodeConfigs: {},
        documentRef: { getElementById: (id) => elements.get(id) || null, querySelectorAll: () => [] },
        windowRef: { requestAnimationFrame: (callback) => callback() },
        fetchRef: async () => {
            const body = { data: [{ b64_json: `AAAA${++requestCount}` }] };
            return { ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body), json: async () => body };
        },
        getProxyHeaders: () => ({}), showToast() {}, addLog() {}, logRequestToPanel() {},
        recordNodeRequest() {}, saveHistoryEntry: async () => true,
        getActiveWorkflowId: () => 'workflow-1',
        saveWorkflowNodeMediaAsset: saveMediaAsset,
        releaseWorkflowNodeMediaAssets: async () => true,
        syncImagePreviewNode: async () => {},
        syncImageSaveNode: async () => {
            if (node.data.mediaAssetKeys?.length) save.data.mediaAssetKeys = node.data.mediaAssetKeys.slice();
        },
        refreshDependentImageResizePreviews: async () => {},
        fitNodeToContent() {}, scheduleSave() {}, onNodeResultUpdated() {}, getAbortMessage: () => ''
    });
    return { node, save, generate: () => api.nodeHandlers.ImageGenerate(node, {}, new AbortController().signal) };
}

test('a failed new generation cannot restore the previous generated batch after restart', async () => {
    let saves = 0;
    const { node, generate } = createSequentialGenerationHarness(async () => (
        ++saves === 1 ? { asset_key: 'media:first' } : null
    ));
    await generate();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(node.data.mediaAssetKeys, ['media:first']);

    await generate();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(node.data.imageResultPersistence, 'transient');
    assert.equal(node.data.mediaAssetKeys, undefined);
});

test('two generated images in one workflow run retain the latest image with an immutable media operation', async () => {
    const writes = new Map();
    const { node, generate } = createSequentialGenerationHarness(async (image, _workflowId, _nodeId, operationId) => {
        const previous = writes.get(operationId);
        if (previous && previous !== image) return null;
        writes.set(operationId, image);
        return { asset_key: `media:${image.slice(-1)}` };
    });
    node.activeMediaOperationId = 'same-workflow-run';

    await generate();
    await new Promise((resolve) => setImmediate(resolve));
    await generate();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(node.data.mediaAssetKeys, ['media:2']);
    assert.equal(node.data.imageResultPersistence, undefined);
});

test('a connected save node receives the generated Media asset after background persistence', async () => {
    const { node, save, generate } = createSequentialGenerationHarness(
        async () => ({ asset_key: 'media:generated' }), { withSaveNode: true }
    );
    await generate();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(node.data.mediaAssetKeys, ['media:generated']);
    assert.deepEqual(save.data.mediaAssetKeys, ['media:generated']);
});

test('an older image save cannot overwrite the newer generation', async () => {
    let resolveFirstSave;
    let saves = 0;
    const { node, generate } = createSequentialGenerationHarness(async () => {
        saves += 1;
        return saves === 1
            ? new Promise((resolve) => { resolveFirstSave = resolve; })
            : { asset_key: 'media:second' };
    });
    await generate();
    await new Promise((resolve) => setImmediate(resolve));
    await generate();
    resolveFirstSave({ asset_key: 'media:first' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(node.data.mediaAssetKeys, ['media:second']);
    assert.equal(node.data.imageAssetKey, 'media:second');
    assert.equal(node.data.imageResultPersistence, undefined);
});

test('batched workflow generation retains its own result and propagates downstream', async () => {
    const prompt = { id: 'prompts', type: 'Text', enabled: true, data: { texts: ['first', 'second'] }, el: createNodeElement() };
    const generated = { id: 'generate', type: 'ImageGenerate', enabled: true, data: { imageResultPersistence: 'transient' }, el: createNodeElement() };
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
        getActiveWorkflowId: () => 'workflow-1',
        saveWorkflowNodeMediaAssets: async (images, workflowId, nodeId) => {
            generatedCacheWrites.push([workflowId, nodeId, images.length]);
            return images.map((_, index) => ({ asset_key: `media:generated-${index}` }));
        },
        deleteImageAsset: async () => true,
        syncImagePreviewNode: async (nodeId, images) => { downstreamImages.push([nodeId, images]); },
        refreshDependentImageResizePreviews: async () => {},
        getAbortMessage: () => '已停止',
        playNotificationSound: () => {}
    });

    const result = await api.runWorkflow();

    assert.equal(result.reason, 'finished');
    assert.deepEqual(executed.map(([type]) => type), ['Text', 'ImageGenerate', 'ImageGenerate', 'ImagePreview']);
    assert.deepEqual(generatedCacheWrites, [['workflow-1', 'generate', 2]]);
    assert.deepEqual(downstreamImages.at(-1), ['preview', [
        'data:image/png;base64,first',
        'data:image/png;base64,second'
    ]]);
    assert.equal(generated.data.imageAssetKey, 'media:generated-0');
    assert.deepEqual(generated.data.mediaAssetKeys, ['media:generated-0', 'media:generated-1']);
    assert.equal(generated.data.imageResultPersistence, undefined);
});
