import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentSearchRequest, parseAgentSearchResponse, searchPromptAgent } from '../js/features/prompt-agent/prompt-agent-search.js';
import { canAgentSearch, resolveAgentSearchModel } from '../js/features/prompt-agent/prompt-agent-search-data.js';
import { createPromptAgentModelReply } from '../js/features/prompt-agent/prompt-agent-model.js';
import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';
import { createPromptAgentInput } from '../js/features/prompt-agent/prompt-agent-input.js';
import { measurePromptAgentContext } from '../js/features/prompt-agent/prompt-agent-token-budget.js';
import { createPromptAgentReferenceSource } from '../js/features/prompt-agent/prompt-agent-reference-source.js';

const provider = { id: 'p', endpoint: 'https://api.example.test/v1', apikey: 'test-key' };
const chat = { id: 'chat', modelId: 'gpt-4o', protocol: 'openai', providerIds: ['p'] };
const searchModel = { ...chat, id: 'search', agentSearch: 'images' };
const google = { ...chat, id: 'google', modelId: 'gemini', protocol: 'google' };
const options = { model: chat, models: [chat, searchModel], providers: [provider], providerId: 'p', message: '找一些图片', searchSettings: { mode: 'auto', modelId: 'search', providerId: 'p' } };
const searchRequest = { searchRequest: { kind: 'images', query: 'recent bridge photos' } };
const raw = {
    output: [{ type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://source.test/page', title: 'Source' }] },
        results: [{ type: 'image_result', image_url: 'https://image.test/full.png', thumbnail_url: 'https://image.test/thumb.png', source_website_url: 'https://source.test/page', caption: 'Bridge' }] },
    { type: 'message', content: [{ type: 'output_text', text: 'Evidence text', annotations: [{ type: 'url_citation', url: 'https://source.test/page', title: 'Source' }] }] }],
    usage: { input_tokens: 123456 }
};
const result = () => parseAgentSearchResponse(raw, { protocol: 'openai-responses', kind: 'images', query: 'bridge', id: 'test' });
const response = payload => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }], usage: { prompt_tokens: 3210 } }));

test('search capabilities are explicit, current model wins and missing dedicated models never fall back', () => {
    assert.equal(canAgentSearch(chat), false);
    assert.equal(canAgentSearch(google), true);
    assert.equal(canAgentSearch(google, 'images'), false);
    assert.equal(canAgentSearch({ ...google, agentSearch: 'none' }), false);
    assert.equal(resolveAgentSearchModel(google, [searchModel], { mode: 'auto', modelId: 'search' }, 'web'), google);
    assert.equal(resolveAgentSearchModel(google, [searchModel], { mode: 'auto', modelId: 'search' }, 'images'), searchModel);
    assert.throws(() => resolveAgentSearchModel(chat, [searchModel], { modelId: 'deleted' }, 'web'), /配置/);
    assert.throws(() => resolveAgentSearchModel(google, [], { mode: 'off' }, 'web'), /关闭/);
});

test('native search plans preserve configuration and require an explicit Responses URL for literal endpoints', () => {
    const original = JSON.stringify(provider);
    const plan = createAgentSearchRequest({ model: searchModel, provider, query: 'bridge', kind: 'images' });
    assert.equal(plan.url, 'https://api.example.test/v1/responses');
    assert.equal(plan.requestBody.store, false);
    assert.deepEqual(plan.requestBody.tools[0].search_content_types, ['image', 'text']);
    assert.equal(plan.requestBody.tools[0].image_settings.max_results, 12);
    assert.equal(JSON.stringify(provider), original);
    assert.throws(() => createAgentSearchRequest({ model: searchModel, provider: { ...provider, autoComplete: false }, kind: 'web' }), /Responses 地址/);
    assert.equal(createAgentSearchRequest({ model: searchModel, provider: { ...provider, autoComplete: false, responsesEndpoint: 'https://relay.test/custom' }, kind: 'web' }).url, 'https://relay.test/custom');
    const gemini = createAgentSearchRequest({ model: google, provider, query: 'facts', kind: 'web' });
    assert.deepEqual(gemini.requestBody.tools, [{ googleSearch: {} }]);
    assert.equal(gemini.requestBody.contents[0].parts[0].text, 'facts');
});

test('parsers require real tool evidence and preserve only structured, safe sources and image results', () => {
    assert.equal(result().sources.length, 1);
    assert.equal(result().images[0].imageUrl, 'https://image.test/full.png');
    const fake = parseAgentSearchResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: '我已经联网 https://fake.test/p.png' }] }] }, { protocol: 'openai-responses', id: 'a' });
    assert.equal(fake.searched, false); assert.equal(fake.images.length, 0); assert.equal(fake.text, '');
    const mixed = structuredClone(raw);
    mixed.output[0].results.push({ type: 'image_result', image_url: 'javascript:bad', source_website_url: 'https://source.test' });
    assert.equal(parseAgentSearchResponse(mixed, { protocol: 'openai-responses', id: 'x' }).images.length, 1);
    const missing = parseAgentSearchResponse({ output: [{ type: 'web_search_call', status: 'completed' }] }, { kind: 'images', id: 'x' });
    assert.match(missing.notice, /未返回.*图片/);
    const gemini = parseAgentSearchResponse({ candidates: [{ content: { parts: [{ thought: true, text: 'private' }, { text: 'facts' }] }, groundingMetadata: {
        webSearchQueries: ['test'], groundingChunks: [{ web: { uri: 'https://source.test/a', title: 'a' } }], searchEntryPoint: { renderedContent: '<b>Google</b>' }
    } }] }, { protocol: 'google', id: 'g' });
    assert.equal(gemini.text, 'facts'); assert.equal(gemini.searched, true); assert.equal(gemini.suggestionsHtml, '<b>Google</b>');
});

test('normal chat makes one request with no search', async () => {
    let calls = 0;
    const reply = await createPromptAgentModelReply({ ...options, searchRef: () => assert.fail('no search'), fetchRef: async () => { calls++; return response({ intent: 'chat', message: '你好' }); } });
    assert.equal(calls, 1); assert.equal(reply.message, '你好'); assert.equal(reply.search, undefined);
});

test('full native search round uses dedicated provider credentials then synthesizes with the original model', async () => {
    const dedicated = { ...searchModel, providerIds: ['sp'] };
    const requests = [];
    const reply = await createPromptAgentModelReply({ ...options, searchSettings: { ...options.searchSettings, providerId: 'sp' }, models: [chat, dedicated], providers: [provider, { id: 'sp', endpoint: 'https://search.test/v1', apikey: 'search-key' }],
        getHeaders: plan => ({ Authorization: plan.provider.apikey, target: plan.url }),
        fetchRef: async (url, init) => {
            const body = JSON.parse(init.body); requests.push({ body, headers: init.headers });
            if (requests.length === 1) return response(searchRequest);
            if (requests.length === 2) return new Response(JSON.stringify(raw));
            const input = JSON.parse(body.messages.at(-1).content);
            assert.equal(input.searchAllowed, false);
            assert.equal(input.images.length, 0, 'search candidates must not become generation references');
            return response({ intent: 'chat', message: `图片已找到 [[source:${input.searchContext.sources[0].id}]]` });
        }
    });
    assert.equal(requests.length, 3);
    assert.equal(requests[1].headers.Authorization, 'search-key');
    assert.equal(requests[2].headers.Authorization, 'test-key');
    assert.equal(reply.search.images.length, 1);
    assert.equal(reply.tokenObservation.inputTokens, 3210, 'search-model usage is not the conversation usage');
});

test('search is bounded, disabled mode never searches, failures never silently retry another model', async () => {
    let searches = 0;
    const args = { ...options, searchRef: async () => { searches++; return result(); }, fetchRef: async () => response(searchRequest) };
    const bounded = await createPromptAgentModelReply(args);
    assert.equal(searches, 1); assert.match(bounded.message, /一次检索/);
    await assert.rejects(createPromptAgentModelReply({ ...args, searchSettings: { mode: 'off' } }), /关闭/);
    assert.equal(searches, 1);
    await assert.rejects(createPromptAgentModelReply({ ...args, searchRef: async () => { throw new Error('provider failed'); } }), /provider failed/);
});

test('fake citations are blocked while genuine search results survive synthesis failure', async () => {
    for (const final of [{ intent: 'chat', message: 'fake [[source:invented]]' }, { intent: 'generate', promptPlan: {} }]) {
        let calls = 0;
        const reply = await createPromptAgentModelReply({ ...options, searchRef: async () => result(), fetchRef: async () => response(calls++ ? final : searchRequest) });
        assert.equal(reply.promptPlan, null); assert.equal(reply.search.images.length, 1); assert.doesNotMatch(reply.message, /\[\[source:invented\]\]/);
    }
});

test('configuration is captured and abort-resistant late search cannot synthesize a reply', async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(createPromptAgentModelReply({ ...options, signal: controller.signal,
        searchRef: async ({ model, providers }) => { assert.equal(model.id, 'search'); assert.equal(providers[0].apikey, 'test-key'); controller.abort(); return result(); },
        fetchRef: async () => { calls++; return response(searchRequest); }
    }), { name: 'AbortError' });
    assert.equal(calls, 1);
    const mutable = structuredClone(options);
    await createPromptAgentModelReply({ ...mutable, searchRef: async ({ model, providers }) => { assert.equal(model.agentSearch, 'images'); assert.equal(providers[0].apikey, 'test-key'); return result(); },
        fetchRef: async () => { mutable.models[1].agentSearch = 'none'; mutable.providers[0].apikey = 'changed'; return response(calls++ === 1 ? searchRequest : { intent: 'chat', message: 'done' }); }
    });
});

test('search HTTP failure and cancellation retain truthful status', async () => {
    await assert.rejects(searchPromptAgent({ model: searchModel, providers: [provider], providerId: 'p', kind: 'web', query: 'facts', fetchRef: async () => new Response('{}', { status: 400 }) }), /HTTP 400/);
    const stop = new AbortController(); stop.abort();
    await assert.rejects(searchPromptAgent({ model: searchModel, signal: stop.signal, fetchRef: () => assert.fail() }), { name: 'AbortError' });
});

test('search settings and evidence restore, compact and clear with workflow isolation', () => {
    const store = createPromptAgentConversationStore();
    store.setSearchSettings({ mode: 'off', modelId: 'search' });
    store.append({ role: 'agent', text: '结论 [[source:stest-1]]', search: result() });
    const before = measurePromptAgentContext({ conversation: store.getCompactionContext() }).used;
    assert.ok(before > measurePromptAgentContext({}).used);
    store.compact('结论来自 [[source:stest-1]]');
    const copy = createPromptAgentConversationStore(); copy.restore(JSON.parse(JSON.stringify(store.snapshot())));
    assert.equal(copy.snapshot().archivedMessages[0].search.images[0].imageUrl, result().images[0].imageUrl);
    const input = createPromptAgentInput({ conversation: copy.getCompactionContext() });
    assert.match(input.messages.at(-1).content, /earlierSearchSources.*stest-1/);
    const compacted = copy.getCompactionContext();
    compacted.contextSummary = '已切换创作主题，不再需要旧资料';
    assert.deepEqual(JSON.parse(createPromptAgentInput({ conversation: compacted }).messages.at(-1).content).earlierSearchSources, [], 'irrelevant archived evidence stays out of the effective context');
    copy.clear(); assert.deepEqual(copy.getSearchSettings(), { mode: 'off', modelId: 'search' });
    assert.equal(copy.snapshot().archivedMessages, undefined);
    copy.restore({}); assert.deepEqual(copy.getSearchSettings(), { mode: 'auto', modelId: '' });
});

test('web selection persists a local import, reuses it offline, and respects edits, failures and cancellation', async () => {
    const state = { nodes: new Map() }; let reads = 0, created = 0, current = true, failSave = false;
    const pixels = 'data:image/png;base64,AAAA';
    const adapter = { getSceneReferenceImages: () => [...state.nodes.values()].map(node => ({ referenceId: `node:${node.id}`, sourceNodeId: node.id })), readSceneReferenceImage: async ref => ({ ...ref, dataUrl: pixels }) };
    const source = createPromptAgentReferenceSource({ state, nodeAdapter: adapter,
        readWebImage: async () => { reads++; return pixels; },
        createImportNode: () => { const id = `${++created}`; state.nodes.set(id, { id, type: 'ImageImport' }); return id; },
        loadImageData: async id => { if (failSave) return false; state.nodes.get(id).imageImportAssetKey = 'media:local'; return true; }
    });
    const image = result().images[0]; const candidate = () => ({ historyId: `web:${image.imageUrl}`, name: image.title, webImage: image });
    const first = await source.importReference(candidate(), { isCurrent: () => current });
    state.nodes.set(first.sourceNodeId, JSON.parse(JSON.stringify(state.nodes.get(first.sourceNodeId))));
    const again = await source.importReference(candidate(), { isCurrent: () => current });
    assert.equal(first.sourceNodeId, again.sourceNodeId); assert.equal(reads, 1); assert.equal(created, 1);
    assert.equal(state.nodes.get('1').agentReferenceSource.web.pageUrl, image.pageUrl);
    state.nodes.get('1').imageImportAssetKey = 'media:edited';
    failSave = true; const retry = candidate();
    await assert.rejects(source.importReference(retry, { isCurrent: () => current }), /保存失败/);
    failSave = false; await source.importReference(retry, { isCurrent: () => current });
    assert.equal(reads, 2); assert.equal(created, 2);
    current = false; assert.equal(await source.importReference(candidate(), { isCurrent: () => current }), null);
});

test('web originals that finish after removal or workflow activation never create a node', async () => {
    let finish, current = true, calls = 0;
    const source = createPromptAgentReferenceSource({ state: { nodes: new Map() }, nodeAdapter: {},
        readWebImage: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
        createImportNode: () => assert.fail('cancelled import must not create a node')
    });
    const candidate = { historyId: 'web:test', webImage: result().images[0] };
    const operation = source.importReference(candidate, { isCurrent: () => current });
    current = false; finish('data:image/png;base64,AAAA');
    assert.equal(await operation, null);
    assert.equal(calls, 1);
    assert.equal(candidate.resolvedImage, undefined, 'late original is not retained for replay');
});
