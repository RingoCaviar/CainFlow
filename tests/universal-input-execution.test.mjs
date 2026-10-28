import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import '../js/features/execution/protocols/openai.js';
import { buildInputBatches, shouldRunNodeForEachInput } from '../js/features/execution/workflow-runner.js';

test('image masks retain their complete source through batching so execution can validate or consume its stable first image', () => {
    const node = { type: 'ImageGenerate' }, mask = ['first','second'];
    const inputs = { prompt: 'scene', mask };
    assert.equal(shouldRunNodeForEachInput(node, inputs), false);
    assert.deepEqual(buildInputBatches(node, { ...inputs, prompt: ['one','two'] }), [
        { prompt: 'one', mask }, { prompt: 'two', mask }
    ]);
    assert.deepEqual(mask, ['first','second']);
});

test('real image execution and request preview reject a new mask that now has a multi-image source', async () => {
    const node = { id: 'target', type: 'ImageGenerate', apiConfigId: 'image', providerId: 'provider', data: { prompt: 'masked target' } };
    const source = { id: 'source', type: 'ImageGenerate', data: { imageList: ['data:image/png;base64,YQ==','data:image/png;base64,Yg=='] } };
    const state = { nodes: new Map([[node.id, node],[source.id, source]]),
        connections: [{ id: 'mask', from: { nodeId: source.id, port: 'image' }, to: { nodeId: node.id, port: 'mask' }, type: 'image', maskConsumption: 'single' }],
        models: [{ id: 'image', modelId: 'gpt-image-1', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'test' }] };
    let requestCount = 0;
    const api = createExecutionCoreApi({ state, nodeConfigs: {},
        documentRef: { getElementById: () => null, querySelectorAll: () => [] },
        windowRef: { requestAnimationFrame: () => {} },
        fetchRef: async () => { requestCount++; throw new Error('provider request reached'); },
        getProxyHeaders: () => ({}), logRequestToPanel: () => {}, addLog: () => {}, showToast: () => {},
        classifyProviderError: () => ({}), formatProxyErrorMessage: () => 'provider request reached',
        fitNodeToContent: () => {}, getAbortMessage: () => ''
    });
    await assert.rejects(api.executeNode(node, { mask: source.data.imageList }, new AbortController().signal), /单图/);
    assert.equal(requestCount, 0);
    assert.throws(() => api.buildNodeRequestPreview(node.id), /单图/);
});
