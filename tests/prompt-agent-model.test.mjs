import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptAgentModelReply, getAvailablePromptAgentModels } from '../js/features/prompt-agent/prompt-agent-model.js';
import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';

const model = { id: 'chat-1', modelId: 'gpt-test', protocol: 'openai', capabilities: { imageInput: true }, providerIds: ['provider-1'] };
const provider = { id: 'provider-1', name: 'Test', endpoint: 'https://example.test/v1', apikey: 'secret' };

test('continuing an edit cannot bind old input A instead of latest generated B', async () => {
    const { result } = replyHarness({ intent: 'edit', message: '修改背景', promptPlan: {
        prompt: '将背景改为蓝色', imageRoles: [{ imageId: 'image-1', role: 'edit-target' }]
    } }, { message: '把背景改为蓝色', workflowReferenceImages: [
        { referenceId: 'old', sourceNodeId: 'old', dataUrl: 'data:image/png;base64,AAAA' },
        { referenceId: 'result:B', runId: 'B', assetKey: 'media:B', latestResult: true, resultNumber: 1, dataUrl: 'data:image/png;base64,BBBB' }
    ] });
    assert.equal((await result).promptPlan.referenceImages[0].assetKey, 'media:B');
});

test('latest multi-image edits require explicit selection; explicit old inputs and prompt-only remain supported', async () => {
    const workflowReferenceImages = [
        { referenceId: 'old', sourceNodeId: 'old', dataUrl: 'data:image/png;base64,AAAA' },
        ...[1, 2].map(n => ({ referenceId: `result:${n}`, runId: 'new', latestResult: true,
            resultNumber: n, assetKey: `media:new${n}`, dataUrl: `data:image/png;base64,NEW${n}` }))
    ];
    const payload = { intent: 'edit', promptPlan: { prompt: '修改背景', imageRoles: [{ imageId: 'image-1', role: 'edit-target' }] } };
    const options = { message: '修改背景', workflowReferenceImages };
    const ambiguous = await replyHarness(payload, options).result;
    assert.equal(ambiguous.intent, 'clarify'); assert.equal(ambiguous.promptPlan, null);
    const selected = await replyHarness({ ...payload, targetSelection: { mode: 'latest', imageId: 'image-3', evidence: '第二张' } },
        { ...options, message: '修改第二张的背景' }).result;
    assert.equal(selected.promptPlan.referenceImages[0].assetKey, 'media:new2');
    const original = await replyHarness({ ...payload, targetSelection: { mode: 'explicit', imageId: 'image-1', evidence: '导入原图' } },
        { ...options, message: '修改导入原图的背景' }).result;
    assert.equal(original.promptPlan.referenceImages[0].sourceNodeId, 'old');
    const prompt = await replyHarness({ ...payload, intent: 'refine', targetSelection: { mode: 'prompt-only', evidence: '只改提示词' } },
        { ...options, message: '只改提示词' }).result;
    assert.deepEqual(prompt.promptPlan.referenceImages, [], 'prompt-only cannot invent material from candidates when no prior plan exists');
    const invented = await replyHarness({ ...payload, targetSelection: { mode: 'explicit', imageId: 'image-1', evidence: '导入原图' } }, options).result;
    assert.equal(invented.intent, 'clarify');
});

test('identical pixels retain latest result identity even if an imported image appeared first', async () => {
    const dataUrl = 'data:image/png;base64,SAME';
    const { result, request } = replyHarness({ intent: 'edit', promptPlan: {
        prompt: '继续修改', imageRoles: [{ imageId: 'image-1', role: 'edit-target' }]
    } }, { referenceImages: [{ referenceId: 'import', sourceNodeId: 'import', dataUrl }],
        workflowReferenceImages: [{ referenceId: 'result', runId: 'latest', latestResult: true, assetKey: 'media:same', dataUrl }] });
    assert.equal((await result).promptPlan.referenceImages[0].assetKey, 'media:same');
    const catalog = JSON.parse(request().messages.at(-1).content[0].text);
    assert.deepEqual(catalog.latestResultImageIds, ['image-1']);
    assert.equal(catalog.images[0].runId, 'latest');
    assert.equal(request().messages.at(-1).content.length, 2);
});

test('two identical latest outputs still require a batch position', async () => {
    const { result } = replyHarness({ intent: 'edit', promptPlan: { prompt: '继续', imageRoles: [] } }, {
        workflowReferenceImages: [1, 2].map(resultNumber => ({ referenceId: `result:${resultNumber}`,
            runId: 'latest', latestResult: true, resultNumber, dataUrl: 'data:image/png;base64,SAME' }))
    });
    assert.match((await result).message, /2 张/);
});

test('OpenAI and Google expose actual input usage without counting generated output', async () => {
    for (const protocol of ['openai', 'google']) {
        const reply = await createPromptAgentModelReply({ model: { ...model, protocol }, providers: [provider], providerId: provider.id, message: '你好',
            fetchRef: async () => ({ ok: true, json: async () => protocol === 'google' ? {
                candidates: [{ content: { parts: [{ text: JSON.stringify({ intent: 'chat', message: '你好' }) }] } }],
                usageMetadata: { promptTokenCount: 1234, totalTokenCount: 8888 }
            } : {
                choices: [{ message: { content: JSON.stringify({ intent: 'chat', message: '你好' }) } }],
                usage: { prompt_tokens: 1234, total_tokens: 8888, prompt_tokens_details: { cached_tokens: 1000 } }
            } })
        });
        assert.equal(reply.tokenObservation.inputTokens, 1234);
        assert.ok(reply.tokenObservation.measurement.textTokens > 0);
    }
});

test('explicit compaction sends the checkpoint and exact latest draft with historical image ordinals but no archived dialogue', async () => {
    const store = createPromptAgentConversationStore();
    const images = [
        { name: '主体', referenceId: 'source-a', dataUrl: 'data:image/png;base64,SUBJECT' },
        { name: '配色', referenceId: 'source-b', dataUrl: 'data:image/png;base64,COLOR' }
    ];
    store.append({ role: 'user', text: '仅归档的原话_不要再次发送', referenceImages: images });
    store.append({ role: 'agent', text: '仅归档的回复_不要再次发送', promptPlan: {
        targetNodeId: 'node-1', prompt: '蓝猫海报，标题“出发！”', negativePrompt: '水印',
        parameters: { count: 2 }, referenceImages: [{ ...images[0], role: 'edit-target' }]
    } });
    store.compact('保留蓝猫主体与精确标题，图2仅配色参考。草稿尚未应用。');
    const restored = createPromptAgentConversationStore();
    restored.restore(store.snapshot());
    const { result, request } = replyHarness({ intent: 'chat', message: '收到', promptPlan: null }, {
        message: '沿用第2张的配色',
        conversation: restored.snapshot(),
        workflowReferenceImages: restored.getReferenceImages()
    });
    await result;
    const messages = request().messages;
    const current = JSON.parse(messages.at(-1).content[0].text);
    assert.equal(current.contextSummary, store.snapshot().contextSummary);
    assert.equal(current.workflowMemory, '');
    assert.deepEqual(current.earlierReferenceTurns, [{
        messageNumber: 1, referenceImages: [
            { referenceNumber: 1, name: '主体', imageId: 'image-1' },
            { referenceNumber: 2, name: '配色', imageId: 'image-2' }
        ]
    }]);
    assert.doesNotMatch(JSON.stringify(messages), /仅归档的原话|仅归档的回复/);
    const plan = JSON.parse(messages.find((item) => item.role === 'assistant').content).promptPlan;
    assert.equal(plan.prompt, '蓝猫海报，标题“出发！”');
    assert.equal(plan.negativePrompt, '水印');
    assert.equal(plan.parameters.count, 2);
    assert.equal(plan.referenceImages[0].role, 'edit-target');
    assert.deepEqual(messages.at(-1).content.slice(1).map((part) => part.image_url.url), images.map((image) => image.dataUrl));
});

test('the complete latest plan survives compaction even when its text exceeds the ordinary history budget', async () => {
    const prompt = `${'必须保留的精确文字'.repeat(2100)}结尾也不能丢`;
    for (const messages of [[], [{ role: 'user', text: '后续讨论'.repeat(5000) }]]) {
        const { result, request } = replyHarness({ intent: 'chat', message: '收到', promptPlan: null }, {
            conversation: {
                contextSummary: '保留上版完整方案',
                previousPromptPlan: { prompt, parameters: { count: 2 } },
                messages
            }
        });
        await result;
        const plan = JSON.parse(request().messages.find((item) => item.role === 'assistant').content).promptPlan;
        assert.equal(plan.prompt, prompt);
        assert.equal(plan.parameters.count, 2);
        assert.equal(JSON.parse(request().messages.at(-1).content).contextSummary, '保留上版完整方案');
    }
});

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
        model, providers: [provider], providerId: provider.id, message: '改成电影感夜景', context: { nodeId: 'node-1', prompt: '城市街道', parameters: {} },
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
    await assert.rejects(createPromptAgentModelReply({ model, providers: [provider], providerId: provider.id, message: '你好', fetchRef: async () => ({
        ok: true, json: async () => ({ choices: [{ message: { content: '不是 JSON' } }] })
    }) }), /有效 JSON/);
});

function replyHarness(payload, options = {}) {
    let request;
    const result = createPromptAgentModelReply({
        model, providers: [provider], providerId: provider.id, message: '再暖一点', ...options,
        fetchRef: async (url, init) => {
            request = JSON.parse(init.body);
            const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
            return { ok: true, json: async () => options.model?.protocol === 'google'
                ? { candidates: [{ content: { parts: [{ text }] } }] }
                : { choices: [{ message: { content: text } }] } };
        }
    });
    return { result, request: () => request };
}

test('discussion and clarification replies do not require or expose an applicable plan', async () => {
    for (const intent of ['chat', 'clarify']) {
        const { result } = replyHarness({
            intent, message: '请说明希望保留哪张图中的主体。', workSummary: [],
            // A stray model plan must not turn a discussion into an action.
            promptPlan: { prompt: '不应被应用', parameters: {} }
        });
        assert.deepEqual(await result, {
            intent, message: '请说明希望保留哪张图中的主体。', workSummary: [], promptPlan: null
        });
    }
});

test('follow-ups send complete unapplied drafts with assistant roles and keep the current request separate', async () => {
    const { result, request } = replyHarness({ intent: 'chat', message: '收到', promptPlan: null }, {
        context: { nodeId: 'image-1', prompt: '旧城市图', parameters: {} },
        conversation: {
            memory: '旧风格摘要',
            messages: [
                { role: 'user', text: '红车海报，标题“出发！”' },
                { role: 'agent', text: '已整理', intent: 'generate', promptPlan: {
                    targetNodeId: 'image-1', prompt: '红色汽车海报，标题“出发！”', negativePrompt: '人物', parameters: { count: 2 }
                } }
            ]
        },
        message: '车换蓝色，标题不变'
    });
    await result;
    const messages = request().messages;
    assert.deepEqual(messages.map((item) => item.role), ['system', 'user', 'assistant', 'user']);
    const draft = JSON.parse(messages[2].content).promptPlan;
    assert.equal(draft.prompt, '红色汽车海报，标题“出发！”');
    assert.equal(draft.parameters.count, 2);
    const current = JSON.parse(messages.at(-1).content);
    assert.equal(current.currentNode.prompt, '旧城市图');
    assert.equal(current.userRequest, '车换蓝色，标题不变');
    assert.equal(JSON.stringify(messages).split('车换蓝色，标题不变').length - 1, 1);
});

test('current, historical, connected and result images are real deduplicated media with explicit availability', async () => {
    const a = { name: '配色.png', dataUrl: 'data:image/png;base64,REF_A' };
    const b = 'data:image/png;base64,NODE_B';
    const c = 'data:image/png;base64,RESULT_C';
    const { result, request } = replyHarness({
        intent: 'generate', message: '按配色参考整理新画面', promptPlan: {
            prompt: '新空间站', negativePrompt: null, parameters: {},
            imageRoles: [{ imageId: 'image-1', role: 'reference' }]
        }
    }, {
        referenceImages: [a], workflowReferenceImages: [a],
        context: {
            nodeId: 'image-1', parameters: {},
            referenceImages: [
                { sourceNodeId: 'source-a', images: [a.dataUrl] },
                { sourceNodeId: 'source-b', images: [b] },
                { sourceNodeId: 'missing', assetKeys: ['media:missing'], images: [] }
            ],
            outputImages: [{ sourceNodeId: 'image-1', images: [c] }]
        }
    });
    const reply = await result;
    const content = request().messages.at(-1).content;
    assert.deepEqual(content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url), [a.dataUrl, b, c]);
    assert.doesNotMatch(content[0].text, /base64|REF_A|NODE_B|RESULT_C|media:missing/);
    const catalog = JSON.parse(content[0].text).images;
    assert.deepEqual(catalog[0].origins, ['本轮附件', '节点输入', '历史附件']);
    assert.equal(catalog[0].connectedToNode, true);
    assert.equal(catalog[2].visionAvailable, false);
    assert.equal(catalog[2].attachmentIndex, undefined);
    assert.equal(catalog[3].attachmentIndex, 3);
    assert.equal(catalog[3].connectedToNode, false);
    assert.equal(reply.promptPlan.referenceImages.length, 1);
    assert.equal(reply.promptPlan.referenceImages[0].role, 'reference');
    assert.equal(Object.hasOwn(reply.promptPlan, 'negativePrompt'), false);
});

test('historical pictures remain visible on a text-only follow-up for OpenAI and Google', async () => {
    for (const protocol of ['openai', 'google']) {
        const { result, request } = replyHarness({ intent: 'chat', message: '比较构图', promptPlan: null }, {
            model: { ...model, protocol },
            workflowReferenceImages: [{ name: '前一张.png', dataUrl: 'data:image/png;base64,HISTORY' }]
        });
        await result;
        if (protocol === 'google') {
            assert.deepEqual(request().contents.at(-1).parts[1].inlineData, { mimeType: 'image/png', data: 'HISTORY' });
        } else {
            assert.equal(request().messages.at(-1).content[1].image_url.url, 'data:image/png;base64,HISTORY');
        }
    }
});

test('visible reference numbers map to media even when equal images are selected from different nodes', async () => {
    const a = { name: '主体', referenceId: 'node-a', dataUrl: 'data:image/png;base64,SAME' };
    const b = { name: '复制的主体', referenceId: 'node-b', dataUrl: a.dataUrl };
    const c = { name: '背景', referenceId: 'node-c', dataUrl: 'data:image/png;base64,BACKGROUND' };
    const { result, request } = replyHarness({ intent: 'chat', message: '收到', promptPlan: null }, {
        referenceImages: [a, c, b],
        workflowReferenceImages: [a, b, c],
        conversation: { messages: [{ role: 'user', text: '之前的顺序', referenceImages: [c, a] }] }
    });
    await result;
    const messages = request().messages;
    const content = messages.at(-1).content;
    assert.deepEqual(JSON.parse(content[0].text).images.map((image) => image.referenceNumbers), [[1, 3], [2]]);
    assert.deepEqual(content.slice(1).map((image) => image.image_url.url), [a.dataUrl, c.dataUrl]);
    assert.deepEqual(JSON.parse(messages[1].content).referenceImages, [
        { referenceNumber: 1, name: '背景', imageId: 'image-2' },
        { referenceNumber: 2, name: '主体', imageId: 'image-1' }
    ]);
});

test('text-only models receive explicit missing-vision metadata without image payloads', async () => {
    const { result, request } = replyHarness({ intent: 'clarify', message: '当前模型无法看图，请描述要修改的对象。', promptPlan: null }, {
        model: { ...model, capabilities: { imageInput: false } },
        referenceImages: [{ name: '照片', dataUrl: 'data:image/png;base64,UNSEEN' }]
    });
    assert.equal((await result).intent, 'clarify');
    assert.doesNotMatch(JSON.stringify(request()), /UNSEEN/);
    const input = JSON.parse(request().messages.at(-1).content);
    assert.equal(input.images[0].visionAvailable, false);
});

test('new plans accept only supported parameter changes and preserve null negative prompts', async () => {
    const context = { nodeId: 'node-1', negativePrompt: '保持原值', parameterSchema: {
        count: { type: 'integer', minimum: 1, maximum: 4 },
        aspectRatio: { type: 'string', enum: ['1:1', '16:9'] },
        protocolParams: { type: 'object', properties: { seed: { type: 'integer', minimum: 0 } } }
    } };
    const payload = { intent: 'refine', message: '已调整', promptPlan: {
        prompt: '暖色光线的原场景', negativePrompt: null,
        parameters: { count: 2, protocolParams: { seed: 42 } }, imageRoles: []
    } };
    const reply = await replyHarness(payload, { context }).result;
    assert.equal(Object.hasOwn(reply.promptPlan, 'negativePrompt'), false);
    assert.deepEqual(reply.promptPlan.parameters, { count: 2, protocolParams: { seed: 42 } });
    for (const parameters of [
        { count: 99 }, { count: true }, { aspectRatio: '77:1' },
        { providerId: 'other' }, { protocolParams: { unknown: 42 } }, []
    ]) {
        await assert.rejects(replyHarness({ ...payload, promptPlan: { ...payload.promptPlan, parameters } }, { context }).result, /参数/);
    }
});

test('malformed plans and invented image references fail before reaching node actions', async () => {
    for (const payload of [
        { intent: 'unknown', message: 'x' },
        { intent: 'generate', promptPlan: null },
        { intent: 'generate', promptPlan: { prompt: { text: 'x' } } },
        { intent: 'generate', promptPlan: { prompt: '猫', negativePrompt: [] } },
        { intent: 'edit', promptPlan: { prompt: '改背景', imageRoles: [] } },
        { intent: 'generate', promptPlan: { prompt: '猫', imageRoles: [{ imageId: 'nonexistent', role: 'reference' }] } },
        'prefix { malformed } suffix'
    ]) {
        await assert.rejects(replyHarness(payload).result);
    }
});

test('conversations retain the complete draft and do not silently omit long uncompressed history', async () => {
    const { result, request } = replyHarness({ intent: 'chat', message: '收到', promptPlan: null }, {
        conversation: {
            memory: '摘要',
            previousPromptPlan: { prompt: '白色陶瓷杯；文字“早安”', parameters: {} },
            messages: [{ role: 'user', text: '再暖一点' }]
        }
    });
    await result;
    assert.match(request().messages.find((item) => item.role === 'assistant').content, /白色陶瓷杯/);
    const bounded = replyHarness({ intent: 'chat', message: '收到', promptPlan: null }, {
        conversation: { messages: [
            { role: 'user', text: '旧'.repeat(20000) },
            { role: 'agent', text: '草稿', promptPlan: { prompt: '保留最近完整方案', parameters: {} } }
        ] }
    });
    await bounded.result;
    assert.ok(JSON.stringify(bounded.request()).length > 20000);
    assert.match(bounded.request().messages.find((item) => item.role === 'assistant').content, /保留最近完整方案/);
    assert.equal(JSON.parse(bounded.request().messages.at(-1).content).historyOmitted, false);
});


test('context-only result selection preserves run identity without inventing image contents', async () => {
    const { result, request } = replyHarness({ intent: 'edit', message: '编辑上一批第二张', promptPlan: {
        prompt: '仅修改背景，保留主体', imageRoles: [{ imageId: 'image-2', role: 'edit-target' }]
    } }, { message: '把刚才第二张背景换成雪山', workflowReferenceImages: [1, 2].map(number => ({
        referenceId: `result:run:${number}`, runId: 'run', messageNumber: 4, resultNumber: number,
        name: `结果 ${number}`, assetKey: `asset:${number}`, contextOrigin: '对话生成结果'
    })) });
    const reply = await result;
    assert.equal(reply.promptPlan.referenceImages[0].assetKey, 'asset:2');
    const input = JSON.parse(request().messages.at(-1).content);
    assert.deepEqual(input.images.map(image => [image.runId, image.resultNumber, image.visionAvailable]),
        [['run', 1, false], ['run', 2, false]]);
});

test('current node output batch resolves each selected image to its own pixels and index', async () => {
    const { result } = replyHarness({ intent: 'edit', promptPlan: {
        prompt: '修改第二张', imageRoles: [{ imageId: 'image-2', role: 'edit-target' }]
    } }, { context: { nodeId: 'generator', parameterSchema: {}, outputImages: [{
        sourceNodeId: 'generator', sourcePort: 'image', images: ['data:image/png;base64,FIRST', 'data:image/png;base64,SECOND']
    }] } });
    const ref = (await result).promptPlan.referenceImages[0];
    assert.equal(ref.dataUrl, 'data:image/png;base64,SECOND');
    assert.equal(ref.sourceImageIndex, 1);
});

test('independent generation must not adopt a historical candidate without explicit selection', async () => {
    const result = await replyHarness({ intent: 'generate', message: '新画面', promptPlan: {
        prompt: '一座雪山', imageRoles: [{ imageId: 'image-1', role: 'reference' }]
    } }, { message: '画一座雪山，不使用参考图', workflowReferenceImages: [
        { referenceId: 'old', runId: 'old', assetKey: 'media:old', dataUrl: 'data:image/png;base64,AAAA' }
    ] }).result;
    assert.equal(result.promptPlan.referenceImages.length, 0);
});

test('pure text result converts to a graph without an import step', async () => {
    const { promptPlanToCanvas } = await import('../js/features/prompt-agent/prompt-agent-canvas-plan.js');
    const { createCanvasContext } = await import('../js/features/prompt-agent/prompt-agent-canvas-context.js');
    const reply = await replyHarness({ intent: 'generate', promptPlan: { prompt: '雪山', imageRoles: [{ imageId: 'image-1', role: 'reference' }] } }, {
        message: '画一座全新的雪山', workflowReferenceImages: [{ runId: 'old', assetKey: 'media:old', dataUrl: 'data:image/png;base64,AAAA' }]
    }).result;
    const graph = promptPlanToCanvas(reply.promptPlan, createCanvasContext({ workflowId: 'w', nodes: [], connections: [] }));
    assert.deepEqual(graph.steps.map(step => step.type), ['ImageGenerate']);
    assert.deepEqual(graph.connections, []);
});

test('prompt-only retains previous draft inputs instead of adopting latest candidates', async () => {
    const old = { sourceNodeId: 'original', assetKey: 'media:original', role: 'reference' };
    const reply = await replyHarness({ intent: 'refine', targetSelection: { mode: 'prompt-only', evidence: '只改提示词' },
        promptPlan: { prompt: '新的提示词', imageRoles: [{ imageId: 'image-1', role: 'edit-target' }] } }, {
        message: '只改提示词', conversation: { messages: [{ role: 'agent', promptPlan: { prompt: '原提示词', referenceImages: [old] } }] },
        workflowReferenceImages: [{ latestResult: true, runId: 'new', assetKey: 'media:new', dataUrl: 'data:image/png;base64,AAAA' }]
    }).result;
    assert.deepEqual(reply.promptPlan.referenceImages, [old]);
});

test('prompt-only uses the most recent canvas plan inputs after single-step upgrade', async () => {
    const reply = await replyHarness({ intent: 'refine', targetSelection: { mode: 'prompt-only', evidence: '只改提示词' }, promptPlan: { prompt: '调整光照', imageRoles: [] } }, {
        message: '只改提示词', conversation: { messages: [{ role: 'agent', canvasPlan: { id: 'saved-plan',
            steps: [{ id: 'input', type: 'ImageImport', assetKey: 'media:original', title: '原素材' }, { id: 'generate', type: 'ImageGenerate' }],
            connections: [{ from: { ref: 'input', port: 'image' }, to: { ref: 'generate', port: 'image_1' } }], bindings: { input: 'imported' } } }] },
        workflowReferenceImages: [{ latestResult: true, runId: 'latest', assetKey: 'media:latest', dataUrl: 'data:image/png;base64,AAAA' }]
    }).result;
    assert.equal(reply.promptPlan.referenceImages[0].assetKey, 'media:original');
});

test('prompt-only keeps every ordered reference from a canonical multi-input canvas plan', async () => {
    const reply = await replyHarness({ intent: 'refine', targetSelection: { mode: 'prompt-only', evidence: '只改提示词' },
        promptPlan: { prompt: '调整光照', imageRoles: [] } }, {
        message: '只改提示词', conversation: { messages: [{ role: 'agent', canvasPlan: { id: 'saved-plan',
            steps: [
                { id: 'first', type: 'ImageImport', assetKey: 'media:first', title: '人物' },
                { id: 'second', type: 'ImageImport', assetKey: 'media:second', title: '配色' },
                { id: 'generate', type: 'ImageGenerate' }
            ], connections: [
                { from: { ref: 'second', port: 'image' }, to: { ref: 'generate', port: 'referenceImages' }, order: 1 },
                { from: { ref: 'first', port: 'image' }, to: { ref: 'generate', port: 'referenceImages' }, order: 0 }
            ], bindings: { first: 'first-node', second: 'second-node' } } }] }
    }).result;
    assert.deepEqual(reply.promptPlan.referenceImages.map(image => image.assetKey), ['media:first', 'media:second']);
});

test('multiple reference roles produce a concise ordered image guide for the actual generation prompt', async () => {
    const references = [
        { name: '人物', referenceId: 'person', sourceNodeId: 'person', assetKey: 'media:person', dataUrl: 'data:image/png;base64,PERSON' },
        { name: '色彩', referenceId: 'palette', sourceNodeId: 'palette', assetKey: 'media:palette', dataUrl: 'data:image/png;base64,PALETTE' }
    ];
    const reply = await replyHarness({ intent: 'generate', promptPlan: { prompt: '画一张海报，保留人物身份，使用暖色调。',
        imageRoles: [
            { imageId: 'image-1', role: 'edit-target', purpose: '保留人物身份' },
            { imageId: 'image-2', role: 'reference', purpose: '仅参考配色' }
        ] } }, { message: '用这两张图画海报', referenceImages: references }).result;
    assert.deepEqual(reply.promptPlan.referenceImages.map(image => image.assetKey), ['media:person', 'media:palette']);
    assert.deepEqual(reply.promptPlan.referenceImages.map(image => image.purpose), ['保留人物身份', '仅参考配色']);
    assert.match(reply.promptPlan.prompt, /^输入图片顺序：图1·编辑目标（保留人物身份）；图2·参考（仅参考配色）。\n/);
    assert.match(reply.promptPlan.prompt, /画一张海报，保留人物身份，使用暖色调。$/);
});


test('explicit image mention reads its original before the first model request and fails closed for missing pixels', async () => {
    const canvasContext = {summary:{mentionedIds:['photo']},nodes:[{id:'photo',name:'参考',type:'ImageImport',assets:['media:photo']}],connections:[]};
    const good = replyHarness({intent:'chat',message:'已查看'}, {canvasContext, getCanvasImage:async()=> 'data:image/png;base64,AAAA'});
    await good.result;
    assert.equal(good.request().messages.at(-1).content.find(part=>part.type==='image_url').image_url.url, 'data:image/png;base64,AAAA');
    const bad = replyHarness({intent:'chat'}, {canvasContext, getCanvasImage:async()=>null});
    await assert.rejects(bad.result, /原图读取失败/);
    assert.equal(bad.request(), undefined, 'no provider request with missing original or a substituted thumbnail');
});
