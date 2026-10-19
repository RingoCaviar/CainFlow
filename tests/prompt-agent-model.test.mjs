import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptAgentModelReply, getAvailablePromptAgentModels } from '../js/features/prompt-agent/prompt-agent-model.js';

const model = { id: 'chat-1', modelId: 'gpt-test', protocol: 'openai', capabilities: { imageInput: true }, providerIds: ['provider-1'] };
const provider = { id: 'provider-1', name: 'Test', endpoint: 'https://example.test/v1', apikey: 'secret' };

test('Agent offers only configured chat models with a usable Provider', () => {
    const models = [
        model,
        { ...model, id: 'orphan', providerIds: ['missing'] },
        { ...model, id: 'incomplete', protocol: '' },
        { ...model, id: 'wrong-format', protocol: 'newapi-image-async' },
        { ...model, id: 'image', taskType: 'image' }
    ];
    assert.deepEqual(getAvailablePromptAgentModels(models, [provider]).map((item) => item.id), ['chat-1']);
    assert.deepEqual(getAvailablePromptAgentModels([model], [{ ...provider, endpoint: '  ' }]), []);
});

test('Prompt Agent sends a real structured chat request and converts the response to a target-bound plan', async () => {
    let request;
    const reply = await createPromptAgentModelReply({
        model, providers: [provider], message: '改成电影感夜景', context: { nodeId: 'node-1', prompt: '城市街道', parameters: {} },
        fetchRef: async (url, options) => {
            request = { url, options };
            return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
                message: '已整理', workSummary: ['读取节点', '优化光线'], prompt: '电影感夜景城市街道',
                negativePrompt: '模糊', parameters: { aspectRatio: '16:9' }
            }) } }] }) };
        },
        getHeaders: (plan) => ({ 'x-target-url-b64': plan.url, Authorization: 'Bearer secret' })
    });
    assert.equal(request.url, '/proxy');
    assert.match(request.options.body, /改成电影感夜景/);
    assert.equal(reply.promptPlan.targetNodeId, 'node-1');
    assert.equal(reply.promptPlan.prompt, '电影感夜景城市街道');
});

test('Prompt Agent rejects missing configuration and malformed model plans', async () => {
    await assert.rejects(createPromptAgentModelReply({ message: '你好' }), /配置/);
    await assert.rejects(createPromptAgentModelReply({ model, providers: [provider], message: '你好', fetchRef: async () => ({
        ok: true, json: async () => ({ choices: [{ message: { content: '不是 JSON' } }] })
    }) }), /有效 JSON/);
});
