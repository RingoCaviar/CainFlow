import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderComputedFixture, renderComputedFixtureAtViewport } from './helpers/browser-theme-fixture.mjs';

import { createConversationWorkbenchController, renderConversationMarkdown, selectConversationBranch } from '../js/features/conversation/conversation-workbench-controller.js';

test('Conversation branch projection sends only the selected assistant sibling', () => {
    const messages = [
        { id: 'u1', role: 'user' },
        { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
        { id: 'a2', role: 'assistant', parentMessageId: 'u1' }
    ];
    assert.deepEqual(selectConversationBranch(messages, new Map([['u1', 0]])).map((item) => item.id), ['u1', 'a1']);
    assert.deepEqual(selectConversationBranch(messages).map((item) => item.id), ['u1', 'a2']);
});

test('Conversation regeneration reuses the selected branch projection', async () => {
    const source = await readFile(new URL('../js/features/conversation/conversation-workbench-controller.js', import.meta.url), 'utf8');
    assert.match(source, /selectedConversation\s*=\s*\{[\s\S]*selectConversationBranch\(activeConversation\.messages, visibleVersionByParent\)[\s\S]*executionService\.regenerate\(\{ conversation: selectedConversation/);
});

test('Conversation markdown renders formatting without executing HTML or loading external media', () => {
    const html = renderConversationMarkdown('**重点** <script>alert(1)</script> ![偷取](https://evil.test/pixel) [文档](javascript:alert(1))');

    assert.match(html, /<strong>重点<\/strong>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<img|<script|javascript:/i);
    assert.match(html, /\[偷取\]\(https:\/\/evil\.test\/pixel\)/);
});

function workbenchDocument() {
    const ids = [
        'conversation-search', 'conversation-new', 'conversation-list', 'conversation-title',
        'conversation-status', 'conversation-model', 'conversation-messages', 'conversation-composer',
        'conversation-guidance', 'conversation-mode-chat', 'conversation-mode-image', 'conversation-send',
        'conversation-send-summary', 'conversation-list-pane', 'conversation-context-pane',
        'conversation-list-collapse', 'conversation-list-toggle', 'conversation-context-collapse', 'conversation-context-toggle',
        'conversation-drawer-backdrop', 'conversation-workflow-filter', 'conversation-archive-entry'
    ];
    const elements = new Map(ids.map((id) => [id, {
        id, value: '', innerHTML: '', textContent: '', hidden: false, attributes: new Map(),
        classList: { values: new Set(), toggle(name, force) { force ? this.values.add(name) : this.values.delete(name); }, add(name) { this.values.add(name); }, remove(name) { this.values.delete(name); }, contains(name) { return this.values.has(name); } },
        addEventListener() {},
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
    }]));
    return { getElementById: (id) => elements.get(id) || null, elements };
}

test('Conversation workbench creates, lists, selects, and renders durable conversations through its public controller', async () => {
    const documentRef = workbenchDocument();
    const summary = { id: 'c1', title: '镜头讨论', revision: 2, defaultModelId: 'm1', status: 'active' };
    const api = {
        listConversations: async () => [summary],
        createConversation: async () => ({ ...summary, id: 'c2', title: '新对话', revision: 1 }),
        getConversation: async (id) => ({ ...summary, id, messages: [
            { id: 'u1', role: 'user', status: 'completed', parts: [{ type: 'text', text: '分析构图' }] },
            { id: 'a1', role: 'assistant', status: 'completed', parts: [{ type: 'text', text: '**主体**居中' }] }
        ] })
    };
    const controller = createConversationWorkbenchController({ documentRef, api, state: { models: [{ id: 'm1', name: '模型一' }] } });

    await controller.init();
    assert.match(documentRef.elements.get('conversation-list').innerHTML, /镜头讨论/);
    await controller.selectConversation('c1');
    assert.equal(documentRef.elements.get('conversation-title').textContent, '镜头讨论');
    assert.match(documentRef.elements.get('conversation-messages').innerHTML, /分析构图/);
    assert.match(documentRef.elements.get('conversation-messages').innerHTML, /<strong>主体<\/strong>/);
    await controller.createConversation();
    assert.equal(controller.getSnapshot().activeConversationId, 'c2');
});

test('Conversation workbench collapses side panes without leaving hidden content focusable', async () => {
    const documentRef = workbenchDocument();
    const controller = createConversationWorkbenchController({
        documentRef,
        api: { listConversations: async () => [] },
        state: { models: [] }
    });
    await controller.init();

    controller.setPaneExpanded('conversation-list-pane', 'conversation-list-toggle', false);
    assert.equal(documentRef.elements.get('conversation-list-pane').inert, true);
    assert.equal(documentRef.elements.get('conversation-list-pane').classList.contains('is-collapsed'), true);
    assert.equal(documentRef.elements.get('conversation-list-toggle').attributes.get('aria-expanded'), 'false');

    controller.setPaneExpanded('conversation-list-pane', 'conversation-list-toggle', true);
    assert.equal(documentRef.elements.get('conversation-list-pane').inert, false);
    assert.equal(documentRef.elements.get('conversation-list-toggle').attributes.get('aria-expanded'), 'true');
});

test('Conversation lifecycle changes current defaults and status without rewriting messages', async () => {
    const documentRef = workbenchDocument();
    const messages = [{ id: 'a1', role: 'assistant', status: 'completed', execution: { modelId: 'old' }, parts: [{ type: 'text', text: 'kept' }] }];
    let current = { id: 'c1', title: 'Original', revision: 1, status: 'active', defaultModelId: 'old', messages };
    const api = {
        listConversations: async () => [current], getConversation: async () => current,
        updateConversation: async (_id, input) => { current = { ...current, ...input, revision: current.revision + 1 }; return current; }
    };
    const controller = createConversationWorkbenchController({ documentRef, api, state: { models: [] } });
    await controller.init();

    await controller.updateLifecycle({ title: 'Renamed', defaultModelId: 'new', status: 'archived' });
    assert.equal(current.title, 'Renamed');
    assert.equal(current.status, 'archived');
    assert.equal(current.defaultModelId, 'new');
    assert.equal(current.messages[0].execution.modelId, 'old');
    assert.equal(current.messages[0].parts[0].text, 'kept');
});

test('Switching the chat model preserves loaded messages when the update API returns only a Conversation summary', async () => {
    const documentRef = workbenchDocument();
    const messages = [
        { id: 'u1', role: 'user', status: 'completed', parts: [{ type: 'text', text: '你好' }] },
        { id: 'a1', role: 'assistant', status: 'completed', parts: [{ type: 'text', text: '你好，我在。' }] }
    ];
    const current = { id: 'c1', title: '对话', revision: 1, status: 'active', defaultModelId: 'old', defaultProviderId: 'p1', messages };
    let updateInput;
    const notices = [];
    const controller = createConversationWorkbenchController({
        documentRef,
        api: {
            listConversations: async () => [current],
            getConversation: async () => current,
            updateConversation: async (_id, input) => {
                updateInput = input;
                return { id: 'c1', title: '对话', revision: 2, status: 'active', defaultModelId: input.defaultModelId, defaultProviderId: input.defaultProviderId };
            }
        },
        state: { models: [{ id: 'old', taskType: 'chat', providerId: 'p1' }, { id: 'new', name: '新模型', taskType: 'chat', providerId: 'p2' }], providers: [{ id: 'p1' }, { id: 'p2' }] },
        showToast: (message) => notices.push(message)
    });

    await controller.init();
    await controller.changeChatModel('new');

    assert.equal(updateInput.defaultModelId, 'new');
    assert.match(documentRef.elements.get('conversation-messages').innerHTML, /你好，我在。/);
    assert.ok(notices.some((message) => /仅影响下一条消息/.test(message)));
});

test('Conversation workbench gives a direct setup next step when no usable model exists', async () => {
    const documentRef = workbenchDocument();
    const current = { id: 'c1', title: '新对话', revision: 1, status: 'active', messages: [] };
    const controller = createConversationWorkbenchController({
        documentRef,
        api: { listConversations: async () => [current], getConversation: async () => current },
        state: { models: [], providers: [] }
    });

    await controller.init();

    assert.equal(documentRef.elements.get('conversation-guidance').hidden, false);
    assert.match(documentRef.elements.get('conversation-guidance').innerHTML, /还没有可用的对话模型/);
    assert.match(documentRef.elements.get('conversation-guidance').innerHTML, /去设置/);
});

test('First send creates a Conversation and exposes setup guidance instead of doing nothing', async () => {
    const documentRef = workbenchDocument();
    const created = { id: 'c1', title: '新对话', revision: 1, status: 'active', messages: [] };
    const notices = [];
    const controller = createConversationWorkbenchController({
        documentRef,
        api: {
            listConversations: async () => [],
            createConversation: async () => created,
            getConversation: async () => created
        },
        state: { models: [], providers: [] },
        executionService: { getRunState: () => null },
        showToast: (message) => notices.push(message)
    });
    documentRef.elements.get('conversation-composer').value = '帮我规划海报';

    await controller.init();
    await controller.sendCurrentMessage();

    assert.equal(controller.getSnapshot().activeConversationId, 'c1');
    assert.equal(documentRef.elements.get('conversation-guidance').hidden, false);
    assert.ok(notices.some((message) => /还没有可用的对话模型/.test(message)));
});

test('New Conversation and chat model choices exclude video-only models', async () => {
    const documentRef = workbenchDocument();
    let createdInput;
    const controller = createConversationWorkbenchController({
        documentRef,
        api: {
            listConversations: async () => [],
            createConversation: async (input) => { createdInput = input; return { id: 'c1', ...input, revision: 1, status: 'active', messages: [] }; },
            getConversation: async () => ({ id: 'c1', revision: 1, status: 'active', messages: [] })
        },
        state: { models: [
            { id: 'video', name: '视频模型', taskType: 'video', providerId: 'p1' },
            { id: 'chat', name: '对话模型', taskType: 'chat', providerId: 'p1' }
        ], providers: [{ id: 'p1' }] }
    });
    await controller.init();
    await controller.createConversation();

    assert.equal(createdInput.defaultModelId, 'chat');
    assert.equal(createdInput.workflowId, '');
    assert.doesNotMatch(documentRef.elements.get('conversation-model').innerHTML, /视频模型/);
    assert.match(documentRef.elements.get('conversation-model').innerHTML, /对话模型/);
});

test('Ordinary assistant replies do not offer canvas materialization actions', async () => {
    const documentRef = workbenchDocument();
    const current = { id: 'c1', title: '新对话', revision: 1, status: 'active', messages: [
        { id: 'a1', role: 'assistant', status: 'completed', parts: [{ type: 'text', text: '普通回复' }] }
    ] };
    const controller = createConversationWorkbenchController({
        documentRef,
        api: { listConversations: async () => [current], getConversation: async () => current },
        state: { models: [] }
    });

    await controller.init();

    assert.doesNotMatch(documentRef.elements.get('conversation-messages').innerHTML, /添加为 Text|data-materialize-message/);
});

test('Failed assistant messages keep an actionable error and retry in the message stream', async () => {
    const documentRef = workbenchDocument();
    const current = { id: 'c1', title: '新对话', revision: 1, status: 'active', messages: [
        { id: 'u1', role: 'user', status: 'completed', parts: [{ type: 'text', text: '你好' }] },
        { id: 'a1', role: 'assistant', parentMessageId: 'u1', status: 'failed', parts: [{ type: 'text', text: '' }], execution: { attempts: [{ error: { summary: '连接超时，请重试或换模型' } }] } }
    ] };
    const controller = createConversationWorkbenchController({
        documentRef, api: { listConversations: async () => [current], getConversation: async () => current }, state: { models: [] }
    });

    await controller.init();

    assert.match(documentRef.elements.get('conversation-messages').innerHTML, /连接超时，请重试或换模型/);
    assert.match(documentRef.elements.get('conversation-messages').innerHTML, /重新生成/);
});

test('Standalone chat never sends workflow data even when a canvas is active', async () => {
    const documentRef = workbenchDocument();
    const current = { id: 'c1', title: '新对话', revision: 1, status: 'active', defaultModelId: 'm1', defaultProviderId: 'p1', messages: [] };
    let sent;
    const controller = createConversationWorkbenchController({
        documentRef,
        api: { listConversations: async () => [current], getConversation: async () => current },
        state: { models: [{ id: 'm1', taskType: 'chat', providerId: 'p1' }], providers: [{ id: 'p1' }], nodes: new Map([['node-1', { type: 'Text' }]]) },
        executionService: { getRunState: () => null, send: async (input) => { sent = input; } },
        getActiveWorkflow: () => ({ id: 'workflow-1', revision: 9 })
    });
    documentRef.elements.get('conversation-composer').value = '只聊聊天';

    await controller.init();
    await controller.sendCurrentMessage();

    assert.equal(sent.workflowSummary, null);
    assert.deepEqual(sent.contextParts, []);
});

test('Conversation workspace exposes standalone chat panes and composer contract', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

    for (const id of [
        'conversation-list-pane', 'conversation-list-toggle', 'conversation-search', 'conversation-new', 'conversation-list',
        'conversation-main-pane', 'conversation-title', 'conversation-model', 'conversation-messages', 'conversation-guidance',
        'conversation-staged-context', 'conversation-send-summary', 'conversation-composer', 'conversation-send',
        'conversation-toolbar-new', 'conversation-toolbar-list',
        'conversation-toolbar-stop', 'conversation-toolbar-return-canvas'
    ]) assert.match(html, new RegExp(`id="${id}"`), id);

    assert.match(html, /aria-label="对话列表"/);
    assert.match(html, /aria-label="消息与输入"/);
    assert.doesNotMatch(html, /conversation-context-pane|conversation-link-workflow|conversation-stage-selected-nodes/);
    assert.doesNotMatch(html, /id="conversation-mode-image"/);
    assert.match(html, /toolbar-canvas-only/);
    assert.match(html, /toolbar-conversation-only/);
});

test('Conversation workspace resolves readable chat surfaces in all seven themes', () => {
    const results = renderComputedFixture(new URL('./fixtures/conversation-workspace-theme.html', import.meta.url), 'cainflow-conversation-');

    assert.equal(results.length, 7);
    for (const result of results) {
        assert.ok(result.list.width > 180, `${result.themeId} list pane remains usable`);
        assert.ok(result.main.width > result.list.width, `${result.themeId} message pane remains primary`);
        assert.notEqual(result.main.background, 'rgba(0, 0, 0, 0)', `${result.themeId} resolves a canvas surface`);
        assert.notEqual(result.message.color, result.message.background, `${result.themeId} message text remains distinguishable`);
    }
});

test('Conversation workspace uses focus-manageable side drawers at a narrow viewport', async () => {
    const results = await renderComputedFixtureAtViewport(
        new URL('./fixtures/conversation-workspace-theme.html', import.meta.url),
        'cainflow-conversation-narrow-',
        500, 900
    );
    for (const result of results) {
        assert.equal(result.list.position, 'absolute', `${result.themeId} list becomes a drawer`);
        assert.ok(result.main.width >= 480, `${result.themeId} main pane retains the narrow viewport`);
    }
});
