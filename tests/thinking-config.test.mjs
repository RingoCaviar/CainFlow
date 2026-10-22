import test from 'node:test';
import assert from 'node:assert/strict';
import { getThinkingCapability, resolveThinking, applyThinking } from '../js/features/execution/thinking-config.js';
import { createChatRequestPlan, requestChatCompletion } from '../js/features/execution/chat-request-plan.js';
import { normalizeModelConfig, extractImageResult } from '../js/features/execution/provider-request-utils.js';
import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';
import { createAgentSearchRequest } from '../js/features/prompt-agent/prompt-agent-search.js';
import { createPromptAgentCompaction } from '../js/features/prompt-agent/prompt-agent-compaction.js';
const provider = { id: 'p', name: '渠道', endpoint: 'https://relay.invalid/v1', apikey: 'test' };
const model = (profile, task = 'chat', protocol = 'openai') => ({ id: 'm', name: '模型', modelId: 'test', taskType: task, protocol, providerIds: ['p'], thinking: { profile } });
const options = (profile, task = 'chat', protocol = 'openai') => ({ model: model(profile, task, protocol), provider, task, protocol });
const level = value => ({ mode: 'level', value });
for (const [profile, protocol, task, setting, patch] of [
    ['openai-basic', 'openai', 'chat', level('high'), { reasoning_effort: 'high' }],
    ['openai-max', 'responses', 'chat', level('max'), { reasoning: { effort: 'max' } }],
    ['google-image', 'google', 'image', level('minimal'), { generationConfig: { thinkingConfig: { thinkingLevel: 'minimal' } } }],
    ['google-25-pro', 'google', 'chat', { mode: 'dynamic' }, { generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }],
    ['google-25-flash', 'google', 'chat', { mode: 'off' }, { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }],
    ['google-25-lite', 'google', 'chat', { mode: 'budget', value: 512 }, { generationConfig: { thinkingConfig: { thinkingBudget: 512 } } }],
    ['deepseek', 'openai', 'chat', { mode: 'off' }, { thinking: { type: 'disabled' } }],
    ['deepseek', 'openai', 'chat', level('max'), { thinking: { type: 'enabled' }, reasoning_effort: 'max' }],
    ['deepseek', 'responses', 'chat', { mode: 'off' }, { reasoning: { effort: 'none' } }],
    ['qwen', 'openai', 'chat', { mode: 'budget', value: 2000 }, { enable_thinking: true, thinking_budget: 2000 }],
    ['qwen-thinking', 'openai', 'chat', { mode: 'budget', value: 1000 }, { thinking_budget: 1000 }],
    ['ttapi-image', 'ttapi', 'image', level('High'), { thinking_level: 'High' }]
]) test(`${profile} ${protocol} maps only supported thinking fields`, () => {
    assert.deepEqual(resolveThinking(options(profile, task, protocol), setting).patch, patch);
});
test('defaults preserve old requests, inheritance can explicitly stop at interface default', () => {
    const config = options('openai-basic'); config.model.thinking.default = level('high');
    assert.deepEqual(resolveThinking(config).patch, { reasoning_effort: 'high' });
    assert.deepEqual(resolveThinking(config, { mode: 'default' }, level('low')).patch, {});
    assert.deepEqual(resolveThinking(config, undefined, level('low')).patch, { reasoning_effort: 'low' });
    assert.deepEqual(applyThinking({ thinking_level: 'High' }, options('auto', 'image', 'ttapi')), { thinking_level: 'High' });
});
test('official exact hosts and model families identify capability; relay names do not', () => {
    const config = { model: { modelId: 'gpt-6.1-sol', protocol: 'openai' }, provider: { endpoint: 'https://api.openai.com/v1' } };
    assert.deepEqual(getThinkingCapability(config).levels, ['low', 'medium', 'high', 'xhigh', 'max']);
    for (const endpoint of ['https://api.openai.com.evil.test', 'https://relay.test']) assert.equal(getThinkingCapability({ ...config, provider: { endpoint } }).supported, false);
    assert.equal(getThinkingCapability({ ...config, task: 'image' }).supported, false);
    assert.equal(getThinkingCapability({ ...config, protocol:'responses', provider:{ endpoint:'https://api.openai.com/v1', autoComplete:false, responsesEndpoint:'https://relay.test/responses' } }).supported, false);
});
test('Provider overrides, wrong protocol, model change and invalid values never silently fall back', () => {
    const config = options('openai-basic'); config.model.thinking.providers = { p: 'none' };
    assert.throws(() => resolveThinking(config, level('high')), /不可用/);
    for (const [profile, protocol, value] of [['openai-max', 'openai', level('none')], ['google-25-pro', 'google', { mode: 'off' }], ['google-25-lite', 'google', { mode: 'budget', value: 511 }], ['google-25-pro', 'google', { mode: 'budget', value: 32769 }], ['qwen-thinking', 'openai', { mode: 'off' }], ['qwen', 'responses', { mode: 'on' }]]) assert.throws(() => resolveThinking(options(profile, 'chat', protocol), value));
});
test('Google configuration preserves image and response options; conflicting custom fields fail', () => {
    const body = { generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageSize: '2K' } } };
    applyThinking(body, options('google-image', 'image', 'google'), level('high'));
    assert.equal(body.generationConfig.imageConfig.imageSize, '2K');
    assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
    assert.throws(() => applyThinking({ reasoning_effort: 'low' }, options('openai-basic'), level('high')), /冲突/);
    assert.throws(() => applyThinking({ thinking: { type: 'enabled' } }, options('deepseek'), { mode: 'off' }), /冲突/);
    assert.deepEqual(applyThinking({ thinking_level: 'High' }, options('auto', 'image', 'ttapi'), { mode: 'default' }), { thinking_level: 'High' });
});
test('model normalization and Agent restore, clear and compact preserve independent thinking settings', () => {
    const configured = model('openai-basic'); configured.thinking.default = level('high'); configured.thinking.providers = { p: 'openai-max' };
    assert.deepEqual(normalizeModelConfig(configured, 0, [provider]).thinking, configured.thinking);
    const store = createPromptAgentConversationStore(); store.setThinking('chat', 'm', level('high')); store.setThinking('image', 'm', { mode: 'default' });
    store.compact('保留摘要'); store.clear(); const restored = createPromptAgentConversationStore(); restored.restore(JSON.parse(JSON.stringify(store.snapshot())));
    assert.deepEqual(restored.getThinking('chat', 'm'), level('high')); assert.deepEqual(restored.getThinking('image', 'm'), { mode: 'default' });
    restored.restore({}); assert.equal(restored.getThinking('chat', 'm'), undefined);
});
test('chat and Responses search bodies use the same configured default', () => {
    const configured = model('openai-basic'); configured.thinking.default = level('high'); configured.agentSearch = 'web';
    const plan = createChatRequestPlan({ model: configured, provider, protocol: 'openai', messages: [{ role: 'user', content: 'test' }] });
    assert.equal(plan.requestBody.reasoning_effort, 'high');
    const search = createAgentSearchRequest({ model: configured, provider, kind: 'web', query: 'test' });
    assert.deepEqual(search.requestBody.reasoning, { effort: 'high' });
    assert.equal(search.requestBody.reasoning_effort, undefined);
});
test('thought text and intermediate images are excluded from final outputs', async () => {
    const configured = model('google-image', 'image', 'google');
    const payload = { candidates: [{ content: { parts: [{ thought: true, text: 'internal', inlineData: { data: 'THOUGHT' } }, { text: 'final' }, { inlineData: { data: 'FINAL' } }] } }] };
    assert.equal(extractImageResult(provider, payload, configured).dataUrl, 'data:image/png;base64,FINAL');
    const result = await requestChatCompletion({ protocol: 'google', url: 'test', requestBody: {} }, { fetchRef: async () => new Response(JSON.stringify(payload)) });
    assert.equal(result.text, 'final');
});
test('supplier parameter refusal makes one request and never retries without settings', async () => {
    let count = 0;
    await assert.rejects(requestChatCompletion({ protocol: 'openai', url: 'test', requestBody: { reasoning_effort: 'high' } }, { fetchRef: async () => { count++; return new Response('unsupported reasoning_effort', { status: 400 }); } }), /HTTP 400/);
    assert.equal(count, 1);
});

test('compaction uses the captured chat thinking configuration without modifying its budget threshold', async () => {
    const configured = model('openai-basic'); configured.thinking.default = level('high'); configured.autoCompactTokenLimit = 64000;
    let body;
    await createPromptAgentCompaction({ model: configured, providers: [provider], conversation: { messages: [{role:'user', text:'保留海报设计'}] },
        fetchRef: async (_, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:'保留海报设计'})}}]})); } });
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(configured.autoCompactTokenLimit, 64000);
});
