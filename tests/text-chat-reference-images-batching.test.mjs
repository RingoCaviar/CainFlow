import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import {
    buildInputBatches,
    shouldRunNodeForEachInput
} from '../js/features/execution/workflow-runner.js';

test('TextChat keeps multiple reference images in one request batch', () => {
    const node = { type: 'TextChat' };
    const inputs = {
        referenceImages: ['first-image', 'second-image']
    };

    assert.equal(shouldRunNodeForEachInput(node, inputs), false);
    assert.deepEqual(buildInputBatches(node, inputs), [inputs]);
});

test('TextChat still runs once per ordinary batch input while preserving reference images', () => {
    const node = { type: 'TextChat' };
    const inputs = {
        prompt: ['first prompt', 'second prompt'],
        referenceImages: ['first-image', 'second-image']
    };

    assert.equal(shouldRunNodeForEachInput(node, inputs), true);
    assert.deepEqual(buildInputBatches(node, inputs), [
        { prompt: 'first prompt', referenceImages: ['first-image', 'second-image'] },
        { prompt: 'second prompt', referenceImages: ['first-image', 'second-image'] }
    ]);
});

test('TextChat sends the original referred to in either prompt field and reuses its slot', async () => {
    const upstream = 'data:image/png;base64,QUJD';
    const history = 'data:image/png;base64,REVG';
    const node = { id: 'chat', type: 'TextChat', enabled: true, apiConfigId: 'model', providerId: 'provider', data: {
        imagePromptMentions: [{ token: '@图片1', source: { id: 'directory-picture', historyId: '3', name: '历史细节' } }]
    } };
    const fields = new Map([
        ['chat-apiconfig', { value: 'model' }], ['chat-provider', { value: 'provider' }],
        ['chat-prompt', { value: '对比上游图与 @图片1' }], ['chat-sysprompt', { value: '先描述 @图片1' }],
        ['chat-response', { innerHTML: '' }]
    ]);
    const state = {
        nodes: new Map([[node.id, node]]), connections: [],
        models: [{ id: 'model', modelId: 'gpt-4o', name: 'Controlled', taskType: 'chat', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', name: 'Controlled', endpoint: 'https://controlled.test/v1', apikey: 'fixture' }]
    };
    const bodies = [];
    const noop = () => {};
    const api = createExecutionCoreApi({
        state, nodeConfigs: {}, referenceImageCatalog: { getUpstream: () => [], readImage: async () => history },
        documentRef: { getElementById: id => fields.get(id) || null, querySelectorAll: () => [] },
        windowRef: { requestAnimationFrame: callback => callback() },
        fetchRef: async (_url, options) => {
            bodies.push(JSON.parse(options.body));
            return Response.json({ choices: [{ message: { content: '图像描述' } }] });
        },
        getProxyHeaders: () => ({}), addLog: noop, showToast: noop, logRequestToPanel: noop,
        recordNodeRequest: noop, fitNodeToContent: noop, scheduleSave: noop, getAbortMessage: () => ''
    });
    await api.executeNode(node, { referenceImages: [upstream] }, new AbortController().signal);
    assert.equal(bodies.length, 1);
    const messages = bodies[0].messages;
    assert.equal(messages[0].content, '先描述 参考图 2');
    assert.deepEqual(messages[1].content, [
        { type: 'text', text: '对比上游图与 参考图 2' },
        { type: 'image_url', image_url: { url: upstream } },
        { type: 'image_url', image_url: { url: history } }
    ]);
});
