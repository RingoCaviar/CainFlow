import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createWorkflowRunnerApi, showNodeExecutionFailure } from '../js/features/execution/workflow-runner.js';
import { createImageGenerationRevisionApi } from '../js/nodes/image-generation-revision.js';
import { registerProtocol } from '../js/features/execution/protocols/index.js';
import { OpenaiProtocol } from '../js/features/execution/protocols/openai.js';

const noop = () => {};
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const element = () => ({ style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 240 }), setAttribute: noop, removeAttribute: noop,
    appendChild: noop, remove: noop, addEventListener: noop });
function fixture({ fetchRef, onState = noop, autoRetry = false, concurrent = false, count = 1, saveDelay = 0, saveMedia } = {}) {
    registerProtocol(OpenaiProtocol);
    const node = { id: 'target', type: 'ImageGenerate', enabled: true, apiConfigId: 'image', providerId: 'provider',
        data: { prompt: 'original prompt', resolution: 'auto', generationCount: count }, el: element() };
    const state = { activeWorkflowId: 'workflow-a', nodes: new Map([[node.id, node]]), connections: [], selectedNodes: new Set([node.id]),
        canvas: { zoom: 1, x: 0, y: 0 }, autoRetry, maxRetries: 1, concurrentRequestMode: concurrent, requestTimeoutEnabled: false,
        models: [{ id: 'image', modelId: 'controlled-image', name: 'controlled image', protocol: 'openai', providerIds: ['provider'], taskType: 'image' }],
        providers: [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'fixture' }] };
    const documentRef = { getElementById: id => id === 'target-apiconfig' ? { value: 'image' } : id === 'target-provider' ? { value: 'provider' } : null,
        querySelectorAll: () => [], addEventListener: noop, createElement: element, defaultView: { requestAnimationFrame: callback => callback(), addEventListener: noop } };
    let serial = 0;
    const saveAsset = async () => { if (saveDelay) await new Promise(resolve => setTimeout(resolve, saveDelay)); return saveMedia ? saveMedia(++serial) : { asset_key: `media:output-${++serial}` }; };
    let revision;
    const core = createExecutionCoreApi({ state, nodeConfigs: {}, documentRef, windowRef: { requestAnimationFrame: callback => callback() },
        fetchRef: fetchRef || (async () => new Response(JSON.stringify({ data: [{ b64_json: png }] }), { headers: { 'Content-Type': 'application/json' } })),
        dataURLtoBlob: value => new Blob([Buffer.from(value.split(',')[1], 'base64')], { type: 'image/png' }),
        getActiveWorkflowId: () => state.activeWorkflowId, saveWorkflowNodeMediaAsset: saveAsset,
        saveWorkflowNodeMediaAssets: images => Promise.all(images.map(saveAsset)),
        getImageAsset: async () => `data:image/png;base64,${png}`,
        getProxyHeaders: () => ({}), showToast: noop, addLog: noop, logRequestToPanel: noop, recordNodeRequest: noop,
        onNodeResultUpdated: () => revision?.observeAll(),
        saveHistoryEntry: async () => true, refreshDependentImageResizePreviews: async () => {}, fitNodeToContent: noop, scheduleSave: noop, getAbortMessage: () => '' });
    revision = createImageGenerationRevisionApi({ state, documentRef, getActiveWorkflowId: () => state.activeWorkflowId, getCachedOutputValue: core.getCachedOutputValue });
    revision.initializeNode(node.id);
    const runner = createWorkflowRunnerApi({ state, nodeConfigs: { ImageGenerate: { title: 'image', outputs: [{ name: 'image', type: 'image' }] } }, documentRef,
        confirmRef: () => true, normalizeRunOptions: core.normalizeRunOptions, resolveExecutionPlan: core.resolveExecutionPlan,
        getCachedOutputValue: core.getCachedOutputValue, executeNode: core.executeNode, generationRevisionApi: revision,
        waitForPendingImageAssetSaves: core.waitForPendingImageAssetSaves,
        getActiveWorkflowId: () => state.activeWorkflowId, saveWorkflowNodeMediaAssets: images => Promise.all(images.map(saveAsset)),
        getImageAsset: async () => `data:image/png;base64,${png}`,
        onNodeRunStateChange: payload => onState(payload, node, state), showToast: noop, addLog: noop, scheduleSave: noop, updatePortStyles: noop, getAbortMessage: () => '', playNotificationSound: noop });
    return { node, state, revision, core, runner, run: () => runner.runWorkflow({ mode: 'selected-only', selectedNodeIds: [node.id] }) };
}

test('public generation completes the captured recipe, and records a minimal trusted revision after media persistence', async () => {
    const f = fixture(); f.node.data.prompt = 'edited'; f.revision.onSettingsChanged(f.node.id);
    assert.equal(f.node.generationDirty, true);
    const result = await f.run();
    assert.equal(result.reason, 'finished', f.node.executionFailure?.message);
    assert.equal(f.node.generationDirty, false);
    assert.match(f.node.data.generationRevision.successFingerprint, /^gen1-/);
    assert.equal(f.node.data.mediaAssetKeys.length, 1);
});

for (const concurrent of [false, true]) {
    for (const throws of [false, true]) {
        test(`media persistence failure rejects completion and a later run recovers (concurrent=${concurrent}, throws=${throws})`, async () => {
            let fail = true;
            const f = fixture({ concurrent, count: 2, saveMedia: serial => {
                if (fail) { if (throws) throw new Error('controlled media failure'); return null; }
                return { asset_key: `media:retry-${serial}` };
            } });
            await f.run();
            assert.equal(f.node.isSucceeded, false);
            assert.equal(f.node.isFailed, true);
            assert.match(f.node.executionFailure.message, /保存|持久化/);
            assert.equal(f.node.data.generationRevision?.successFingerprint, undefined);
            assert.equal(f.node.data.mediaAssetKeys, undefined);
            fail = false;
            await f.run();
            assert.equal(f.node.isSucceeded, true);
            assert.equal(f.node.executionFailure, undefined);
            assert.equal(f.node.data.mediaAssetKeys.length, 2);
            assert.ok(f.node.data.mediaAssetKeys.every(key => key.startsWith('media:retry-')));
            assert.equal(f.node.data.imageResultPersistence, undefined);
        });
    }
}

test('automatic retry clears a settled media failure before a new generation attempt', async () => {
    const f = fixture({ autoRetry: true, saveMedia: serial => serial === 1 ? null : { asset_key: 'media:retried' } });
    await f.run();
    assert.equal(f.node.isSucceeded, true);
    assert.equal(f.node.executionFailure, undefined);
    assert.deepEqual(f.node.data.mediaAssetKeys, ['media:retried']);
});

test('retrying as concurrent input batches cannot inherit an earlier serial media failure', async () => {
    let fail = true;
    const f = fixture({ saveMedia: serial => fail ? null : { asset_key: `media:retry-${serial}` } });
    await f.run();
    assert.equal(f.node.isFailed, true);
    fail = false;
    f.state.concurrentRequestMode = true;
    f.state.nodes.set('prompts', { id: 'prompts', type: 'Text', enabled: true, data: { texts: ['first', 'second'] }, el: element() });
    f.state.connections.push({ id: 'batch-input', from: { nodeId: 'prompts', port: 'text' }, to: { nodeId: f.node.id, port: 'prompt' }, type: 'text' });
    await f.run();
    assert.equal(f.node.isSucceeded, true, f.node.executionFailure?.message);
    assert.equal(f.node.executionFailure, undefined);
    assert.equal(f.node.data.mediaAssetKeys.length, 2);
});

for (const concurrent of [false, true]) {
    test(`input-batch media persistence cannot report success or reuse a partial batch key (concurrent=${concurrent})`, async () => {
        let fail = true;
        const prompts = [];
        const f = fixture({ concurrent,
            fetchRef: async (_url, { body }) => {
                prompts.push(JSON.parse(body).prompt);
                return Response.json({ data: [{ b64_json: png }] });
            },
            saveMedia: serial => fail
                ? (concurrent || serial > 2 ? null : { asset_key: `media:partial-${serial}` })
                : { asset_key: `media:complete-${serial}` } });
        f.state.nodes.set('prompts', { id: 'prompts', type: 'Text', enabled: true, data: { texts: ['first', 'second'] }, el: element() });
        f.state.connections.push({ id: 'batch-input', from: { nodeId: 'prompts', port: 'text' }, to: { nodeId: f.node.id, port: 'prompt' }, type: 'text' });
        await f.run();
        assert.equal(f.node.isSucceeded, false);
        assert.match(f.node.executionFailure.message, /媒体保存失败/);
        assert.equal(f.node.data.mediaAssetKeys, undefined);
        assert.equal(f.node.data.imageResultPersistence, 'transient');
        fail = false;
        prompts.length = 0;
        await f.run();
        assert.equal(f.node.isSucceeded, true);
        assert.equal(f.node.data.mediaAssetKeys.length, 2);
        assert.ok(f.node.data.mediaAssetKeys.every(key => key.startsWith('media:complete-')));
        assert.deepEqual(prompts, ['first', 'second']);
    });
}

test('automatic retry enters a new waiting attempt with the old partial outputs, failure and progress cleared', async () => {
    let requests = 0;
    const waiting = [];
    const f = fixture({ autoRetry: true, count: 2,
        fetchRef: async () => ++requests === 2
            ? new Response(JSON.stringify({ error: { message: 'controlled rejection' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })
            : new Response(JSON.stringify({ data: [{ b64_json: png }] }), { headers: { 'Content-Type': 'application/json' } }),
        onState: (payload, node) => { if (payload.status === 'waiting') waiting.push({ failure: node.executionFailure, image: node.imageData,
            list: node.data.imageList, keys: node.data.mediaAssetKeys, progress: node.apiGenerationProgress }); } });
    const outside = { id: 'outside', type: 'ImageGenerate', data: {}, enabled: true, el: element() };
    const disabled = { id: 'disabled', type: 'ImageGenerate', data: {}, enabled: false, el: element() };
    for (const node of [f.node, outside, disabled]) { showNodeExecutionFailure(node, new Error(`old ${node.id}`)); f.state.nodes.set(node.id, node); }
    f.node.data.prompt = 'retry recipe'; f.revision.onSettingsChanged(f.node.id);
    const result = await f.run();
    assert.equal(result.reason, 'finished', f.node.executionFailure?.message);
    assert.equal(waiting.length, 2, 'both the initial attempt and automatic retry must enter waiting');
    for (const snapshot of waiting) {
        assert.equal(snapshot.failure, undefined); assert.ok(!snapshot.image); assert.ok(!snapshot.list?.length); assert.ok(!snapshot.keys?.length); assert.equal(snapshot.progress, undefined);
    }
    assert.equal(outside.executionFailure.message, 'old outside'); assert.equal(disabled.executionFailure.message, 'old disabled');
    assert.equal(f.node.generationDirty, false);
});

test('partial concurrent provider success keeps changed settings pending', async () => {
    let requests = 0;
    const f = fixture({ concurrent: true, count: 2, fetchRef: async () => ++requests === 2
        ? new Response(JSON.stringify({ error: { message: 'one request rejected' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ data: [{ b64_json: png }] }), { headers: { 'Content-Type': 'application/json' } }) });
    f.node.data.prompt = 'partial recipe'; f.revision.onSettingsChanged(f.node.id);
    await f.run();
    assert.equal(f.node.generationCompletedCount, 1);
    assert.equal(f.node.generationDirty, true);
    assert.equal(f.node.data.generationRevision.successFingerprint, undefined);
});

test('a failed image slot rejects retry after its generation recipe changes', async () => {
    let requests = 0;
    const f = fixture({ concurrent: true, count: 2, fetchRef: async () => ++requests === 2
        ? Response.json({ error: { message: 'second image failed' } }, { status: 400 })
        : Response.json({ data: [{ b64_json: png }] }) });
    await f.run();
    const originalKeys = f.node.data.mediaAssetKeys.slice();
    const { batchId } = f.node.data.concurrentRequestStatus;
    f.node.data.prompt = 'different prompt';
    f.revision.onSettingsChanged(f.node.id);
    await f.runner.runWorkflow({ mode: 'selected-only', selectedNodeIds: [f.node.id],
        imageRetryNodeId: f.node.id, imageRetryIndex: 1, imageRetryBatchId: batchId });
    assert.equal(requests, 2);
    assert.match(f.node.executionFailure.message, /参数或输入已变更/);
    assert.deepEqual(f.node.data.mediaAssetKeys, originalKeys);
    assert.deepEqual(f.node.data.concurrentRequestStatus.requests.map(request => request.status), ['success', 'failed']);
});

test('upstream original replacement marks a consumer pending and an in-scope run confirms the newly persisted source recipe', async () => {
    const f = fixture({ saveDelay: 30 });
    const source = { id: 'source', type: 'ImageGenerate', enabled: true, apiConfigId: 'image', providerId: 'provider',
        data: { prompt: 'source', resolution: 'auto', generationCount: 1, imageList: [`data:image/png;base64,${png}`], mediaAssetKeys: ['media:previous-original'], imageCount: 1 }, el: element() };
    f.state.nodes.set(source.id, source);
    f.state.connections.push({ id: 'source-ref', type: 'image', order: 0, from: { nodeId: source.id, port: 'image' }, to: { nodeId: f.node.id, port: 'referenceImages' } });
    f.revision.observeAll(); await f.run();
    assert.equal(f.node.generationDirty, false, f.node.executionFailure?.message);
    const previous = f.node.data.generationRevision.successFingerprint;
    await f.runner.runWorkflow({ mode: 'selected-only', selectedNodeIds: [source.id] });
    assert.equal(f.node.generationDirty, true, 'a fresh source original changes the consumer recipe even when its pixels look the same');
    const result = await f.runner.runWorkflow({ mode: 'target-node', targetNodeId: f.node.id });
    assert.equal(result.reason, 'finished', f.node.executionFailure?.message);
    assert.equal(f.node.generationDirty, false, 'the target must capture the new durable keys, after the upstream media save completes');
    assert.notEqual(f.node.data.generationRevision.successFingerprint, previous);
});

test('selected-only captures external originals before waiting and cannot confirm a source replaced during the held upstream request', async () => {
    let releaseGate, enteredGate;
    const gateEntered = new Promise(resolve => { enteredGate = resolve; });
    const requests = [];
    const f = fixture({ fetchRef: async (_url, options) => {
        const body = options.body instanceof FormData ? Object.fromEntries(options.body.entries()) : JSON.parse(options.body);
        requests.push(body);
        if (body.prompt === 'gate') { enteredGate(); await new Promise(resolve => { releaseGate = resolve; }); }
        return new Response(JSON.stringify({ data: [{ b64_json: png }] }), { headers: { 'Content-Type': 'application/json' } });
    } });
    const gate = { id: 'gate', type: 'ImageGenerate', enabled: true, apiConfigId: 'image', providerId: 'provider',
        data: { prompt: 'gate', resolution: 'auto', generationCount: 1 }, el: element() };
    const external = { id: 'external', type: 'ImagePreview', enabled: true,
        data: { imageList: [`data:image/png;base64,${png}`], mediaAssetKeys: ['media:external-before'], imageCount: 1 }, el: element() };
    for (const source of [gate, external]) f.state.nodes.set(source.id, source);
    f.state.connections.push(...[external, gate].map((source, order) => ({ id: `${source.id}-ref`, type: 'image', order,
        from: { nodeId: source.id, port: 'image' }, to: { nodeId: f.node.id, port: 'referenceImages' } })));
    f.revision.observeAll();
    const run = f.runner.runWorkflow({ mode: 'selected-only', selectedNodeIds: [gate.id, f.node.id] });
    await gateEntered;
    external.data.mediaAssetKeys = ['media:external-after']; f.revision.observeAll(); releaseGate();
    const result = await run;
    assert.equal(result.reason, 'finished', f.node.executionFailure?.message);
    assert.equal(requests.length, 2);
    assert.equal(f.node.generationDirty, true, 'the generated result consumed the captured prior external source, so the changed source is still pending');
    assert.equal(f.node.data.generationRevision.successFingerprint, undefined);
});

for (const type of ['ImageImport', 'ImageGenerate']) test(`an in-scope ${type} retains reference descriptions as configuration and sends the described original recipe`, async () => {
    const requests = [], description = 'the original subject has a red silhouette';
    const f = fixture({ fetchRef: async (_url, options) => {
        requests.push(options.body instanceof FormData ? Object.fromEntries(options.body.entries()) : JSON.parse(options.body));
        return new Response(JSON.stringify({ data: [{ b64_json: png }] }), { headers: { 'Content-Type': 'application/json' } });
    } });
    const source = { id: 'annotated', type, enabled: true, apiConfigId: 'image', providerId: 'provider', importMode: 'upload', imageImportAssetKey: 'media:original',
        data: { prompt: 'source generation', resolution: 'auto', generationCount: 1, image: `data:image/png;base64,${png}`,
            mediaAssetKeys: ['media:original'], imageCount: 1, imageDescription: description, imageDescriptions: [description] }, el: element() };
    f.state.nodes.set(source.id, source); f.state.connections.push({ id: 'described-reference', type: 'image', order: 7,
        from: { nodeId: source.id, port: 'image' }, to: { nodeId: f.node.id, port: 'referenceImages' } });
    f.revision.observeAll();
    const result = await f.runner.runWorkflow({ mode: 'target-node', targetNodeId: f.node.id });
    assert.equal(result.reason, 'finished', f.node.executionFailure?.message);
    assert.match(requests.at(-1).prompt, /参考图 1：the original subject has a red silhouette/);
    assert.equal(source.data.imageDescription, description); assert.deepEqual(source.data.imageDescriptions, [description]);
    assert.equal(f.node.generationDirty, false);
});
