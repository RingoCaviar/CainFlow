import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatRequestPlanError, createChatRequestPlan, executeChatRequestPlan, requestChatCompletion } from '../js/features/execution/chat-request-plan.js';

const provider = { id: 'provider-a', name: 'Provider A', apikey: 'secret-token', baseUrl: 'https://api.example.test/v1' };
const openAiModel = { id: 'model-a', modelId: 'chat-a', name: 'Chat A', protocol: 'openai' };

function modelPlan(modelId, customParams, options = {}) {
    return createChatRequestPlan({
        provider: { ...provider, endpoint: 'https://api.openai.com/v1' },
        model: { ...openAiModel, modelId },
        protocol: 'openai',
        messages: [{ role: 'user', content: 'Hello' }],
        customParams,
        ...options
    });
}

test('normalizes old token limits and filters sampling against the official model default or selected effort', () => {
    const custom = { max_tokens: 1024, temperature: 0, top_p: 0.8, logprobs: true, top_logprobs: 2, verbosity: 'low' };
    const old = modelPlan('gpt-5-mini-2025-08-07', custom, { systemPrompt: 'Keep it brief' });
    assert.deepEqual(old.requestBody, {
        model: 'gpt-5-mini-2025-08-07',
        messages: [{ role: 'developer', content: 'Keep it brief' }, { role: 'user', content: 'Hello' }],
        max_completion_tokens: 1024,
        verbosity: 'low'
    });
    assert.deepEqual(old.preview.requestBody, old.requestBody);
    assert.equal(modelPlan('gpt-5.4-mini', custom).requestBody.temperature, 0);
    assert.equal(modelPlan('gpt-5.5', custom).requestBody.temperature, undefined);
    const newest = modelPlan('gpt-5.6-terra', { ...custom, model: 'gpt-6-astra', max_completion_tokens: 512, reasoning_effort: 'none' });
    assert.equal(newest.requestBody.model, 'gpt-5.6-terra');
    assert.equal(newest.requestBody.max_completion_tokens, 512);
    assert.equal(newest.requestBody.temperature, 0);
    assert.equal(modelPlan('gpt-5.4', custom, { thinking: { mode: 'level', value: 'high' } }).requestBody.top_p, undefined);
});

test('retains legacy chat sampling and excludes fields specific to reasoning models', () => {
    const legacy = modelPlan('gpt-4.1-mini', { temperature: 0, reasoning_effort: 'high', verbosity: 'high' });
    assert.equal(legacy.requestBody.temperature, 0);
    assert.equal(legacy.requestBody.reasoning_effort, undefined);
    assert.equal(legacy.requestBody.verbosity, undefined);
    assert.equal(modelPlan('o3', { stop: ['END'] }).requestBody.stop, undefined);
    assert.throws(() => modelPlan('o3-mini', {}, { media: [{ type: 'image', url: 'data:image/png;base64,AAA' }] }), /不支持图片输入/);
});

test('checks incompatible Chat Completions models, tools and explicitly requested reasoning', () => {
    const tools = [{ type: 'function', function: { name: 'example' } }];
    assert.throws(() => modelPlan('gpt-5.4-pro'), /仅支持 Responses API/);
    assert.throws(() => modelPlan('gpt-6.1-terra', { tools, reasoning_effort: 'none' }), /工具调用.*Responses API/);
    assert.throws(() => modelPlan('gpt-5.6-sol', { tools }), /工具调用.*none/);
    assert.deepEqual(modelPlan('gpt-5.6-sol', { tools, reasoning_effort: 'none' }).requestBody.tools, tools);
    assert.throws(() => modelPlan('gpt-6.1-sol', { reasoning_effort: 'none' }), /reasoning_effort/);
    const conflict = { thinking: { mode: 'level', value: 'high' } };
    assert.throws(() => modelPlan('gpt-5.4', { reasoning: { effort: 'low' } }, conflict), /冲突/);
});

test('leaves provider-specific parameters intact on an OpenAI-compatible relay', () => {
    const custom = { max_tokens: 1024, temperature: 0, reasoning_effort: 'none' };
    const { requestBody } = modelPlan('gpt-6.1-sol', custom, { provider: { ...provider, endpoint: 'https://api.openai.com.relay.test/v1' } });
    for (const [key, value] of Object.entries(custom)) assert.equal(requestBody[key], value);
});

test('builds one OpenAI request plan for text and ordered images', () => {
    const plan = createChatRequestPlan({
        provider,
        model: openAiModel,
        protocol: 'openai',
        systemPrompt: 'Be concise',
        messages: [{ role: 'user', content: 'Compare these' }],
        media: [
            { type: 'image', url: 'data:image/png;base64,AAA' },
            { type: 'image', url: 'https://cdn.example.test/b.png' }
        ]
    });

    assert.deepEqual(plan.requestBody.messages, [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: [
            { type: 'text', text: 'Compare these' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            { type: 'image_url', image_url: { url: 'https://cdn.example.test/b.png' } }
        ] }
    ]);
    assert.deepEqual(plan.preview.requestBody, plan.requestBody);
    assert.equal(JSON.stringify(plan.preview).includes('secret-token'), false);
});

test('shared completion transport parses OpenAI and Google text without exposing credentials', async () => {
    const openAiPlan = createChatRequestPlan({ provider, model: openAiModel, protocol: 'openai', messages: [{ role: 'user', content: 'hello' }] });
    const openAi = await requestChatCompletion(openAiPlan, {
        fetchRef: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OpenAI reply' } }] }))
    });
    const googlePlan = createChatRequestPlan({ provider, model: openAiModel, protocol: 'google', messages: [{ role: 'user', content: 'hello' }] });
    const google = await requestChatCompletion(googlePlan, {
        fetchRef: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Google reply' }] } }] }))
    });

    assert.equal(openAi.text, 'OpenAI reply');
    assert.equal(google.text, 'Google reply');
});

test('shared completion transport joins OpenAI structured content parts', async () => {
    const plan = createChatRequestPlan({ provider, model: openAiModel, protocol: 'openai', messages: [{ role: 'user', content: 'hello' }] });
    const result = await requestChatCompletion(plan, {
        fetchRef: async () => new Response(JSON.stringify({ choices: [{ message: {
            content: [{ type: 'text', text: '{"prompt":"生成一张海报"}' }]
        } }] }))
    });
    assert.equal(result.text, '{"prompt":"生成一张海报"}');
});

test('builds Google history and inline image parts without changing media order', () => {
    const plan = createChatRequestPlan({
        provider,
        model: { ...openAiModel, protocol: 'google' },
        protocol: 'google',
        messages: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: 'next' }
        ],
        media: [{ type: 'image', url: 'data:image/jpeg;base64,BBB' }]
    });

    assert.equal(plan.requestBody.contents.length, 3);
    assert.deepEqual(plan.requestBody.contents[2].parts, [
        { text: 'next' },
        { inlineData: { mimeType: 'image/jpeg', data: 'BBB' } }
    ]);
});

test('rejects unsupported media before transport with a structured error', () => {
    assert.throws(() => createChatRequestPlan({
        provider,
        model: openAiModel,
        protocol: 'openai',
        capabilities: { imageInput: false },
        messages: [{ role: 'user', content: 'inspect' }],
        media: [{ type: 'image', url: 'data:image/png;base64,AAA' }]
    }), (error) => {
        assert.ok(error instanceof ChatRequestPlanError);
        assert.equal(error.code, 'unsupported_media');
        assert.equal(error.details.mediaType, 'image');
        return true;
    });
});

test('executes the exact planned body through the shared proxy transport', async () => {
    const plan = createChatRequestPlan({
        provider,
        model: openAiModel,
        protocol: 'openai',
        messages: [{ role: 'user', content: 'hello' }]
    });
    let observed;
    const response = await executeChatRequestPlan(plan, {
        signal: { aborted: false },
        headers: { Authorization: 'Bearer secret-token' },
        fetchRef: async (url, options) => {
            observed = { url, options };
            return { ok: true };
        }
    });

    assert.equal(response.ok, true);
    assert.equal(observed.url, '/proxy');
    assert.deepEqual(JSON.parse(observed.options.body), plan.requestBody);
    assert.equal(observed.options.method, plan.method);
});
