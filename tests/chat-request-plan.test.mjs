import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatRequestPlanError, createChatRequestPlan, executeChatRequestPlan, requestChatCompletion } from '../js/features/execution/chat-request-plan.js';

const provider = { id: 'provider-a', name: 'Provider A', apikey: 'secret-token', baseUrl: 'https://api.example.test/v1' };
const openAiModel = { id: 'model-a', modelId: 'chat-a', name: 'Chat A', protocol: 'openai' };

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
