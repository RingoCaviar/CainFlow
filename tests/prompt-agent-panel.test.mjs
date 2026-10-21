import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptAgentController } from '../js/features/prompt-agent/prompt-agent-controller.js';
import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';

const TEST_CHAT_MODEL = { id: 'chat-1', modelId: 'chat-test', name: 'Chat test' };
const TEST_IMAGE_MODEL = { id: 'image-model-1', modelId: 'image-test', name: 'Image test' };

function selectedImageStore() {
    const store = createPromptAgentConversationStore();
    store.setImageModelId(TEST_IMAGE_MODEL.id);
    return store;
}

class ClassList {
    constructor(initial = []) { this.values = new Set(initial); }
    add(...names) { names.forEach((name) => this.values.add(name)); }
    remove(...names) { names.forEach((name) => this.values.delete(name)); }
    contains(name) { return this.values.has(name); }
    toggle(name, force) {
        const next = force === undefined ? !this.contains(name) : Boolean(force);
        if (next) this.add(name); else this.remove(name);
        return next;
    }
}

class FakeElement {
    constructor({ value = '', classes = [] } = {}) {
        this.value = value;
        this.classList = new ClassList(classes);
        this.attributes = new Map();
        this.dataset = {};
        this.listeners = new Map();
        this.children = [];
        this.textContent = '';
        this.disabled = false;
        this.open = false;
        this.style = {};
    }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    dispatch(type, event = {}) { return this.listeners.get(type)?.({ preventDefault() {}, target: this, ...event }); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    remove() {
        if (!this.parentElement) return;
        const index = this.parentElement.children.indexOf(this);
        if (index >= 0) this.parentElement.children.splice(index, 1);
    }
    replaceChildren() { this.children.length = 0; }
    querySelector(selector) {
        return this.children.find((child) => child.className === selector.slice(1)) || null;
    }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [ ...(child.className === selector.slice(1) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    blur() {}
    getBoundingClientRect() { return { width: 480 }; }
}

function createHarness(createReply = async () => ({
    message: '已整理你的创作方向。',
    workSummary: ['理解需求', '整理提示词方向'],
    promptPlan: {
        targetNodeId: 'image-1',
        prompt: '低饱和电影感海报',
        negativePrompt: '过度饱和',
        parameters: { aspectRatio: '16:9', count: 1 }
    }
}), nodeAdapter = {
    getSelectedContext: () => ({ nodeId: 'image-1', prompt: '旧提示词', negativePrompt: '', parameters: {}, referenceImages: [] }),
    applyPromptPlan: () => true
}, executionAdapter = null, controllerOptions = {}) {
    const elements = {
        'btn-prompt-agent': new FakeElement(),
        'prompt-agent-panel': new FakeElement(),
        'btn-close-prompt-agent': new FakeElement(),
        'prompt-agent-form': new FakeElement(),
        'prompt-agent-input': new FakeElement(),
        'prompt-agent-send': new FakeElement(),
        'prompt-agent-cancel': new FakeElement(),
        'prompt-agent-command-menu': new FakeElement(),
        'prompt-agent-command-status': new FakeElement(),
        'prompt-agent-model': new FakeElement(),
        'prompt-agent-model-hint': new FakeElement(),
        'prompt-agent-add-model': new FakeElement(),
        'prompt-agent-image-model': new FakeElement(),
        'prompt-agent-image-model-hint': new FakeElement(),
        'prompt-agent-image-model-status': new FakeElement(),
        'prompt-agent-add-image-model': new FakeElement(),
        'prompt-agent-messages': new FakeElement(),
        'prompt-agent-references': new FakeElement(),
        'prompt-agent-add-reference': new FakeElement(),
        'prompt-agent-reference-picker': new FakeElement(),
        'prompt-agent-reference-picker-close': new FakeElement(),
        'prompt-agent-reference-picker-list': new FakeElement(),
        'prompt-agent-reference-picker-status': new FakeElement(),
        'prompt-agent-reference-error': new FakeElement()
    };
    const documentRef = {
        activeElement: null,
        getElementById: (id) => elements[id] || null,
        createElement: () => new FakeElement()
    };
    const controller = createPromptAgentController({
        documentRef, createReply, nodeAdapter, executionAdapter,
        getChatModels: () => [TEST_CHAT_MODEL],
        getImageModels: () => [TEST_IMAGE_MODEL],
        conversationStore: selectedImageStore(), ...controllerOptions
    });
    controller.init();
    return { controller, elements };
}

function findResultImages(element) {
    return [ ...(element.className === 'prompt-agent-result-image' ? [element] : []),
        ...element.children.flatMap(findResultImages) ];
}

test('generated batches survive restore and open their own immutable preview batch', async () => {
    let batch = 0;
    const previews = [];
    const { controller, elements } = createHarness(undefined, undefined, {
        applyAndGenerate: async () => ({ status: 'completed', images: [`image-${++batch}-a`, `image-${batch}-b`],
            mediaAssetKeys: [`media:${batch}-a`, `media:${batch}-b`] })
    }, {
        openResultPreview: (images, index) => previews.push({ images, index }),
        loadResultImages: async (keys) => keys.map((key) => key.replace('media:', 'image-'))
    });
    elements['prompt-agent-input'].value = '保留两次生成';
    await controller.submit();
    const actions = elements['prompt-agent-messages'].children[1].querySelector('.prompt-agent-actions');
    await actions.children[1].dispatch('click');
    await actions.children[1].dispatch('click');
    const saved = JSON.parse(JSON.stringify(controller.snapshotWorkflow()));
    assert.equal(saved.messages[1].runs.length, 2);
    assert.deepEqual(saved.messages[1].runs[0].mediaAssetKeys, ['media:1-a', 'media:1-b']);
    assert.ok(!JSON.stringify(saved).includes('image-1-a'));
    const reopened = createHarness(undefined, undefined, null, {
        openResultPreview: (images, index) => previews.push({ images, index }),
        loadResultImages: async (keys) => keys.map((key) => key.replace('media:', 'image-'))
    });
    reopened.controller.restoreWorkflow(saved);
    await new Promise((resolve) => setImmediate(resolve));
    const images = findResultImages(reopened.elements['prompt-agent-messages']);
    assert.equal(images.length, 4);
    images[1].dispatch('click');
    assert.deepEqual(previews.pop(), { images: ['image-1-a', 'image-1-b'], index: 1 });
    images[0].dispatch('keydown', { key: 'Enter' });
    assert.equal(previews.pop().index, 0);
});

test('clearing a running result prevents late completion from resurrecting its conversation', async () => {
    let finish;
    const { controller, elements } = createHarness(undefined, undefined, {
        applyAndGenerate: () => new Promise((resolve) => { finish = resolve; })
    });
    elements['prompt-agent-input'].value = '生成';
    await controller.submit();
    const pending = elements['prompt-agent-messages'].children[1].querySelector('.prompt-agent-actions').children[1].dispatch('click');
    elements['prompt-agent-input'].value = '/clear';
    await controller.submit();
    finish({ status: 'completed', images: ['late'], mediaAssetKeys: ['media:late'] });
    await pending;
    assert.equal(controller.snapshotWorkflow().messages.length, 0);
    assert.equal(findResultImages(elements['prompt-agent-messages']).length, 0);
});

test('restored batches retain missing image positions and keep the remaining images previewable', async () => {
    const previews = [];
    const reads = [];
    const { controller, elements } = createHarness(undefined, undefined, null, {
        loadResultImages: async (keys) => { reads.push(keys); return ['first', null, 'third']; },
        openResultPreview: (images, index) => previews.push({ images, index })
    });
    controller.restoreWorkflow({ messages: [{ role: 'agent', text: '历史结果', promptPlan: { prompt: '猫', targetNodeId: 'removed-node' },
        runs: [{ runId: 'old-run', status: 'completed', mediaAssetKeys: ['media:first', 'media:missing', 'media:third'] }] }] });
    await new Promise((resolve) => setImmediate(resolve));
    const result = elements['prompt-agent-messages'].children[0].querySelector('.prompt-agent-run-state');
    assert.equal(result.children[1].textContent, '第 2 张图片文件缺失');
    assert.equal(findResultImages(result).length, 2);
    result.children[2].dispatch('click');
    assert.deepEqual(previews, [{ images: ['first', 'third'], index: 1 }]);
    assert.deepEqual(reads, [['media:first', 'media:missing', 'media:third']]);
});

test('toolbar toggles the Prompt Agent panel without touching canvas state', () => {
    const { elements } = createHarness();

    elements['btn-prompt-agent'].dispatch('click');
    assert.equal(elements['prompt-agent-panel'].classList.contains('active'), true);
    assert.equal(elements['prompt-agent-panel'].attributes.get('aria-hidden'), 'false');
    assert.equal(elements['btn-prompt-agent'].attributes.get('aria-expanded'), 'true');

    elements['btn-close-prompt-agent'].dispatch('click');
    assert.equal(elements['prompt-agent-panel'].classList.contains('active'), false);
    assert.equal(elements['prompt-agent-panel'].attributes.get('aria-hidden'), 'true');
});

test('image model selection starts empty even with one model, allows drafts and blocks all execution actions', async () => {
    let prepared = 0;
    let settingsOpens = 0;
    const { controller, elements } = createHarness(undefined, {
        getSelectedContext: () => null,
        ensureTarget: () => { prepared++; throw new Error('must not prepare'); }
    }, { applyAndGenerate: () => { throw new Error('must not generate'); } }, {
        conversationStore: createPromptAgentConversationStore(),
        openModelSettings: () => { settingsOpens++; }
    });
    assert.equal(elements['prompt-agent-image-model'].value, '');
    assert.equal(elements['prompt-agent-image-model'].children[0].textContent, '请选择生图模型');
    assert.equal(elements['prompt-agent-send'].disabled, false);
    elements['prompt-agent-input'].value = '先写草稿';
    await controller.submit();
    const actions = elements['prompt-agent-messages'].children[1].querySelector('.prompt-agent-actions');
    assert.ok(actions.children.every((button) => button.disabled));
    assert.equal(prepared, 0);
    assert.match(elements['prompt-agent-image-model-status'].textContent, /请选择生图模型/);
    elements['prompt-agent-add-image-model'].dispatch('click');
    assert.equal(settingsOpens, 1);
    elements['prompt-agent-image-model'].value = TEST_IMAGE_MODEL.id;
    elements['prompt-agent-image-model'].dispatch('change');
    assert.ok(actions.children.every((button) => !button.disabled));
    assert.equal(controller.snapshotWorkflow().imageModelId, TEST_IMAGE_MODEL.id);
    assert.equal(prepared, 0);
});

test('late models and ordering changes never choose or replace an explicit image model', () => {
    const second = { id: 'image-model-2', modelId: 'another-image' };
    let models = [];
    const { controller, elements } = createHarness(undefined, undefined, null, {
        conversationStore: createPromptAgentConversationStore(), getImageModels: () => models
    });
    assert.equal(elements['prompt-agent-image-model'].disabled, true);
    models = [TEST_IMAGE_MODEL, second];
    controller.refreshModels();
    assert.equal(elements['prompt-agent-image-model'].value, '');
    elements['prompt-agent-image-model'].value = second.id;
    elements['prompt-agent-image-model'].dispatch('change');
    models.reverse();
    controller.refreshModels();
    assert.equal(elements['prompt-agent-image-model'].value, second.id);
    models = [TEST_IMAGE_MODEL];
    controller.refreshModels();
    assert.equal(controller.snapshotWorkflow().imageModelId, second.id);
    assert.equal(elements['prompt-agent-image-model'].value, second.id);
    assert.match(elements['prompt-agent-image-model-status'].textContent, /不可用/);
    controller.restoreWorkflow(null);
    assert.equal(elements['prompt-agent-image-model'].value, '');
});

test('explicit model changes affect the next action and never mutate an in-flight generation', async () => {
    const second = { id: 'image-model-2', modelId: 'another-image' };
    const configurations = [];
    let finish;
    const { controller, elements } = createHarness(undefined, {
        getSelectedContext: () => ({ nodeId: 'image-1' }),
        ensureTarget: (plan, options) => { configurations.push(options.modelId); return plan; },
        applyPromptPlan: () => true
    }, { applyAndGenerate: () => new Promise((resolve) => { finish = resolve; }) }, {
        getImageModels: () => [TEST_IMAGE_MODEL, second]
    });
    elements['prompt-agent-input'].value = '生图';
    await controller.submit();
    const actions = elements['prompt-agent-messages'].children[1].querySelector('.prompt-agent-actions');
    actions.children[0].dispatch('click');
    assert.equal(actions.children[0].textContent, '已应用');
    elements['prompt-agent-image-model'].value = second.id;
    elements['prompt-agent-image-model'].dispatch('change');
    assert.equal(actions.children[0].disabled, false);
    const pending = actions.children[1].dispatch('click');
    assert.deepEqual(configurations, [TEST_IMAGE_MODEL.id, second.id]);
    elements['prompt-agent-image-model'].value = TEST_IMAGE_MODEL.id;
    elements['prompt-agent-image-model'].dispatch('change');
    await actions.children[0].dispatch('click');
    await actions.children[1].dispatch('click');
    assert.deepEqual(configurations, [TEST_IMAGE_MODEL.id, second.id]);
    assert.equal(actions.children[1].disabled, true);
    finish({ status: 'completed', images: [] });
    await pending;
    assert.equal(actions.children[1].disabled, false);
    assert.equal(actions.children[0].disabled, false);
    assert.equal(actions.children[0].textContent, '应用到节点');
    actions.children[0].dispatch('click');
    assert.deepEqual(configurations, [TEST_IMAGE_MODEL.id, second.id, TEST_IMAGE_MODEL.id]);
});

test('submitting a message renders a user turn and a collapsed Agent Work Summary', async () => {
    const { elements } = createHarness();
    elements['prompt-agent-input'].value = '做一张低饱和电影感海报';

    await elements['prompt-agent-form'].dispatch('submit');

    assert.equal(elements['prompt-agent-messages'].children.length, 2);
    const [userMessage, agentMessage] = elements['prompt-agent-messages'].children;
    assert.equal(userMessage.children[0].textContent, '做一张低饱和电影感海报');
    assert.equal(agentMessage.children[0].open, false);
    assert.equal(agentMessage.children[0].children[0].textContent, '工作过程');
    assert.equal(agentMessage.children[1].textContent, '已整理你的创作方向。');
    assert.equal(agentMessage.children[2].className, 'prompt-agent-plan');
    assert.equal(agentMessage.children[3].children[0].textContent, '应用到节点');
    assert.equal(elements['prompt-agent-input'].value, '');
});

test('passes selected node context to the Agent and applies the response plan', async () => {
    let request = null;
    let applied = null;
    const { elements } = createHarness(async (value) => {
        request = value;
        return {
            message: '计划已就绪。',
            workSummary: ['读取当前节点'],
            promptPlan: { targetNodeId: 'image-1', prompt: '新提示词', negativePrompt: '', parameters: {} }
        };
    }, {
        getSelectedContext: () => ({ nodeId: 'image-1', prompt: '旧提示词', negativePrompt: '', parameters: {}, referenceImages: [] }),
        applyPromptPlan: (plan) => { applied = plan; return true; }
    });
    elements['btn-prompt-agent'].dispatch('click');
    elements['prompt-agent-input'].value = '调整一下';

    await elements['prompt-agent-form'].dispatch('submit');
    assert.equal(request.context.nodeId, 'image-1');
    const agentMessage = elements['prompt-agent-messages'].children[1];
    agentMessage.children[3].children[0].dispatch('click');
    assert.equal(applied.prompt, '新提示词');
    assert.equal(elements['prompt-agent-panel'].classList.contains('active'), true);
});

test('discussion and clarification remain conversational, and later turns receive the full prior draft', async () => {
    const requests = [];
    const { controller, elements } = createHarness(async (request) => {
        requests.push(request);
        if (requests.length === 1) return {
            intent: 'generate', message: '第一版', workSummary: [],
            promptPlan: { targetNodeId: 'image-1', prompt: '红车海报；标题“出发”', parameters: {} }
        };
        return { intent: 'clarify', message: '希望调整哪一部分？', workSummary: [], promptPlan: null };
    });
    elements['prompt-agent-input'].value = '写一版海报';
    await controller.submit();
    elements['prompt-agent-input'].value = '讨论一下';
    await controller.submit();
    assert.equal(requests[1].conversation.messages.length, 2);
    assert.equal(requests[1].conversation.messages[1].promptPlan.prompt, '红车海报；标题“出发”');
    assert.equal(requests[1].conversation.messages.some((message) => message.text === '讨论一下'), false);
    const lastMessage = elements['prompt-agent-messages'].children.at(-1);
    assert.equal(lastMessage.children.length, 1);
    assert.equal(lastMessage.children[0].textContent, '希望调整哪一部分？');
    assert.equal(controller.snapshotWorkflow().messages.at(-1).intent, 'clarify');
    controller.restoreWorkflow(null);
    elements['prompt-agent-input'].value = '新工作流';
    await controller.submit();
    assert.deepEqual(requests.at(-1).conversation.messages, []);
});

test('refreshes chat models loaded after initialization before submitting', async () => {
    let models = [];
    let request = null;
    const { elements } = createHarness(async (value) => {
        request = value;
        return { message: '计划已就绪。', workSummary: [], promptPlan: null };
    }, undefined, undefined, { getChatModels: () => models });

    models = [{ id: 'chat-provider-model', modelId: 'chat-v1', name: 'Chat v1' }];
    elements['prompt-agent-input'].value = '生成一张海报';
    await elements['prompt-agent-form'].dispatch('submit');

    assert.equal(request.modelId, 'chat-provider-model');
    assert.equal(elements['prompt-agent-model'].disabled, false);
    assert.equal(elements['prompt-agent-model'].children.length, 1);
});

test('unavailable chat models show a quiet hint and keep the draft until a model is configured', async () => {
    let models = [];
    let requests = 0;
    let settingsOpens = 0;
    const { elements } = createHarness(async () => {
        requests += 1;
        return { message: '已就绪', workSummary: [], promptPlan: null };
    }, undefined, undefined, {
        getChatModels: () => models,
        openModelSettings: () => { settingsOpens += 1; }
    });

    assert.equal(elements['prompt-agent-model-hint'].hidden, false);
    assert.equal(elements['prompt-agent-send'].disabled, true);
    elements['prompt-agent-add-model'].dispatch('click');
    assert.equal(settingsOpens, 1);
    elements['prompt-agent-input'].value = '保留这段草稿';
    await elements['prompt-agent-form'].dispatch('submit');
    assert.equal(requests, 0);
    assert.equal(elements['prompt-agent-input'].value, '保留这段草稿');
    assert.equal(elements['prompt-agent-messages'].children.length, 0);

    models = [TEST_CHAT_MODEL];
    elements['prompt-agent-input'].dispatch('focus');
    assert.equal(elements['prompt-agent-model-hint'].hidden, true);
    assert.equal(elements['prompt-agent-send'].disabled, false);
    await elements['prompt-agent-form'].dispatch('submit');
    assert.equal(requests, 1);
});

test('keeps the bound target actionable after deselection', async () => {
    let selected = true;
    let applied = false;
    const { elements } = createHarness(async () => ({
        message: '计划已就绪',
        workSummary: [],
        promptPlan: { targetNodeId: 'image-1', prompt: '新提示词', parameters: {} }
    }), {
        getSelectedContext: () => selected ? { nodeId: 'image-1', prompt: '', negativePrompt: '', parameters: {}, referenceImages: [] } : null,
        applyPromptPlan: () => { applied = true; return true; }
    });
    elements['prompt-agent-input'].value = '调整';
    await elements['prompt-agent-form'].dispatch('submit');
    const agentMessage = elements['prompt-agent-messages'].children[1];
    const actions = agentMessage.children[2];
    selected = false;
    actions.children[0].dispatch('click');

    assert.equal(applied, true);
    assert.equal(actions.children[0].disabled, true);
    assert.equal(actions.children[1].disabled, true);
});

test('drafting without selection does not create a node until explicitly applied', async () => {
    let creations = 0;
    let applied;
    const { elements } = createHarness(async () => ({
        message: '点击生成时会自动创建节点。',
        workSummary: ['整理提示词方向'],
        promptPlan: { targetNodeId: null, prompt: '草稿提示词', negativePrompt: '', parameters: {} }
    }), {
        getSelectedContext: () => null,
        ensureTarget: (plan) => { creations += 1; return { ...plan, targetNodeId: 'created' }; },
        applyPromptPlan: (plan) => { applied = plan; return true; }
    });
    elements['prompt-agent-input'].value = '先帮我写提示词';

    await elements['prompt-agent-form'].dispatch('submit');
    const agentMessage = elements['prompt-agent-messages'].children[1];
    const apply = agentMessage.children[3].children[0];
    assert.equal(creations, 0);
    assert.equal(apply.disabled, false);
    assert.equal(apply.textContent, '创建并应用');
    apply.dispatch('click');
    assert.equal(creations, 1);
    assert.equal(applied.targetNodeId, 'created');
});

test('refreshing action state never requires selecting a bound target', async () => {
    let selected = null;
    const { controller, elements } = createHarness(async () => ({
        message: '计划已就绪',
        workSummary: [],
        promptPlan: { targetNodeId: 'image-1', prompt: '草稿提示词', negativePrompt: '', parameters: {} }
    }), {
        getSelectedContext: () => selected,
        applyPromptPlan: () => true
    });
    elements['prompt-agent-input'].value = '先整理提示词';

    await elements['prompt-agent-form'].dispatch('submit');
    const actions = elements['prompt-agent-messages'].children[1].children[2];
    assert.equal(actions.children[0].disabled, false);
    assert.equal(actions.children[1].disabled, true);

    selected = { nodeId: 'image-1', prompt: '', negativePrompt: '', parameters: {}, referenceImages: [] };
    controller.refreshActionStates();
    assert.equal(actions.children[0].disabled, false);
    assert.equal(actions.children[1].disabled, true);
});

test('creates a target for an unassigned draft instead of retargeting to a later selection', async () => {
    let selected = null;
    let applied = null;
    const { controller, elements } = createHarness(async () => ({
        message: '草稿已就绪',
        workSummary: [],
        promptPlan: { targetNodeId: null, prompt: '草稿提示词', negativePrompt: '', parameters: {} }
    }), {
        getSelectedContext: () => selected,
        ensureTarget: (plan) => ({ ...plan, targetNodeId: 'created' }),
        applyPromptPlan: (plan) => { applied = plan; return true; }
    });
    elements['prompt-agent-input'].value = '先整理提示词';
    await elements['prompt-agent-form'].dispatch('submit');
    const actions = elements['prompt-agent-messages'].children[1].children[2];
    assert.equal(actions.children[0].disabled, false);

    selected = { nodeId: 'image-1', prompt: '', negativePrompt: '', parameters: {}, referenceImages: [] };
    controller.refreshActionStates();
    assert.equal(actions.children[0].disabled, false);
    actions.children[0].dispatch('click');
    assert.equal(applied.targetNodeId, 'created');
    assert.equal(controller.snapshotWorkflow().messages[1].promptPlan.targetNodeId, 'created');
});

test('generation creates once and preserves its target across failure, retry, restore and follow-up', async () => {
    let creations = 0;
    const runs = [];
    const requests = [];
    const context = { nodeId: 'created', prompt: '草稿', parameters: {} };
    const nodeAdapter = {
        getSelectedContext: () => null,
        getContext: (id) => id === 'created' ? context : null,
        ensureTarget: (plan) => {
            if (plan.targetNodeId) return plan;
            creations += 1;
            return { ...plan, targetNodeId: 'created' };
        }
    };
    const { controller, elements } = createHarness(async (request) => {
        requests.push(request);
        return { message: '草稿已就绪', promptPlan: { targetNodeId: request.context?.nodeId || null, prompt: '草稿', parameters: {} } };
    }, nodeAdapter, {
        applyAndGenerate: async (plan) => {
            runs.push(plan.targetNodeId);
            if (runs.length === 1) throw new Error('暂时不可用');
            return { status: 'completed', images: ['result'] };
        }
    });
    elements['prompt-agent-input'].value = '画一只猫';
    await controller.submit();
    const message = elements['prompt-agent-messages'].children[1];
    const generate = message.children[2].children[1];
    assert.equal(generate.disabled, false);
    assert.equal(creations, 0);
    assert.equal(runs.length, 0);
    await generate.dispatch('click');
    assert.equal(creations, 1);
    assert.equal(controller.snapshotWorkflow().messages[1].promptPlan.targetNodeId, 'created');
    const runState = message.children[3];
    assert.match(runState.textContent, /暂时不可用/);
    await runState.children[0].dispatch('click');
    assert.match(runState.textContent, /暂时不可用/);
    assert.equal(message.children.at(-1).textContent, '生成完成');
    controller.restoreWorkflow(controller.snapshotWorkflow());
    const restoredMessage = elements['prompt-agent-messages'].children[1];
    await restoredMessage.children[2].children[1].dispatch('click');
    assert.equal(creations, 1);
    assert.deepEqual(runs, ['created', 'created', 'created']);
    elements['prompt-agent-input'].value = '再暖一点';
    await controller.submit();
    assert.equal(requests[1].context.nodeId, 'created');
});

test('missing generation configuration keeps the draft retryable without a target', async () => {
    let configured = false;
    let runs = 0;
    const { controller, elements } = createHarness(async () => ({
        message: '草稿', promptPlan: { targetNodeId: null, prompt: '猫', parameters: {} }
    }), {
        getSelectedContext: () => null,
        ensureTarget: (plan) => {
            if (!configured) throw new Error('请先配置可用的生图模型');
            return { ...plan, targetNodeId: 'created' };
        }
    }, { applyAndGenerate: async () => { runs += 1; return { status: 'completed', images: [] }; } });
    elements['prompt-agent-input'].value = '猫';
    await controller.submit();
    const message = elements['prompt-agent-messages'].children[1];
    await message.children[2].children[1].dispatch('click');
    const runState = message.children[3];
    assert.match(runState.textContent, /配置可用的生图模型/);
    assert.equal(controller.snapshotWorkflow().messages[1].promptPlan.targetNodeId, null);
    assert.equal(runs, 0);
    configured = true;
    await runState.children[0].dispatch('click');
    assert.equal(runs, 1);
    assert.equal(controller.snapshotWorkflow().messages[1].promptPlan.targetNodeId, 'created');
});

test('stale actions after switching workflows or clearing cannot create or run nodes', async () => {
    for (const reset of ['restore', 'clear']) {
        let creations = 0;
        let runs = 0;
        const { controller, elements } = createHarness(async () => ({
            message: '草稿', promptPlan: { targetNodeId: null, prompt: '猫', parameters: {} }
        }), {
            getSelectedContext: () => null,
            ensureTarget: (plan) => { creations += 1; return { ...plan, targetNodeId: 'created' }; }
        }, { applyAndGenerate: async () => { runs += 1; } });
        elements['prompt-agent-input'].value = '猫';
        await controller.submit();
        const actions = elements['prompt-agent-messages'].children[1].children[2];
        if (reset === 'restore') controller.restoreWorkflow(null);
        else { elements['prompt-agent-input'].value = '/clear'; await controller.submit(); }
        actions.children[0].dispatch('click');
        await actions.children[1].dispatch('click');
        assert.equal(creations, 0);
        assert.equal(runs, 0);
        assert.equal(controller.snapshotWorkflow().messages.length, 0);
    }
});

test('default Prompt Plan keeps the selected node prompt when applying a follow-up instruction', async () => {
    const elements = {
        'btn-prompt-agent': new FakeElement(), 'prompt-agent-panel': new FakeElement(),
        'btn-close-prompt-agent': new FakeElement(), 'prompt-agent-form': new FakeElement(),
        'prompt-agent-input': new FakeElement(), 'prompt-agent-send': new FakeElement(),
        'prompt-agent-messages': new FakeElement()
    };
    const documentRef = {
        activeElement: null,
        getElementById: (id) => elements[id] || null,
        createElement: () => new FakeElement()
    };
    let applied = null;
    const controller = createPromptAgentController({
        documentRef,
        getChatModels: () => [TEST_CHAT_MODEL],
        getImageModels: () => [TEST_IMAGE_MODEL],
        conversationStore: selectedImageStore(),
        nodeAdapter: {
            getSelectedContext: () => ({ nodeId: 'image-1', prompt: '城市夜景', negativePrompt: '', parameters: {}, referenceImages: [] }),
            applyPromptPlan: (plan) => { applied = plan; return true; }
        }
    });
    controller.init();
    elements['prompt-agent-input'].value = '更有电影感';
    await elements['prompt-agent-form'].dispatch('submit');
    const agentMessage = elements['prompt-agent-messages'].children[1];
    agentMessage.children[3].children[0].dispatch('click');
    assert.equal(applied.prompt, '城市夜景\n\n调整要求：更有电影感');
});

test('apply and generate reports progress, result previews, and keeps the plan for retry', async () => {
    let runs = 0;
    const executionAdapter = {
        applyAndGenerate: async () => {
            runs += 1;
            if (runs === 1) throw new Error('供应商暂时不可用');
            return { status: 'completed', images: ['data:image/png;base64,b2s='] };
        },
        stop: () => true,
        focus: () => true
    };
    const { elements } = createHarness(undefined, undefined, executionAdapter);
    elements['prompt-agent-input'].value = '生成电影海报';
    await elements['prompt-agent-form'].dispatch('submit');
    const agentMessage = elements['prompt-agent-messages'].children[1];
    const actions = agentMessage.children[3];

    await actions.children[1].dispatch('click');
    const runState = agentMessage.children[4];
    assert.match(runState.textContent, /供应商暂时不可用/);
    assert.equal(runState.children[0].textContent, '重试');
    assert.equal(runState.children[1].textContent, '返回节点');

    await runState.children[0].dispatch('click');
    assert.match(runState.textContent, /供应商暂时不可用/);
    assert.equal(agentMessage.children.at(-1).textContent, '生成完成');
    assert.equal(agentMessage.children.at(-1).children[0].src, 'data:image/png;base64,b2s=');
});

test('generation progress exposes a stop action for the running node', async () => {
    let resolveRun;
    let stopped = null;
    const executionAdapter = {
        applyAndGenerate: () => new Promise((resolve) => { resolveRun = resolve; }),
        stop: (nodeId) => { stopped = nodeId; return true; },
        focus: () => true
    };
    const { elements } = createHarness(undefined, undefined, executionAdapter);
    elements['prompt-agent-input'].value = '生成';
    await elements['prompt-agent-form'].dispatch('submit');
    const agentMessage = elements['prompt-agent-messages'].children[1];
    const running = agentMessage.children[3].children[1].dispatch('click');
    const runState = agentMessage.children[4];
    assert.equal(runState.textContent, '正在生成…');
    runState.children[0].dispatch('click');
    assert.equal(stopped, 'image-1');
    resolveRun({ status: 'stopped', images: [] });
    await running;
    assert.equal(runState.textContent, '已停止');
});

test('restores workflow conversation and width without reopening the panel', () => {
    const { controller, elements } = createHarness();
    controller.restoreWorkflow({
        version: 1,
        memory: '低饱和电影感',
        panelWidth: 612,
        messages: [
            { role: 'user', text: '继续调整' },
            { role: 'agent', text: '计划已恢复', promptPlan: { targetNodeId: 'image-1', prompt: '电影海报', parameters: {} } }
        ]
    });

    assert.equal(elements['prompt-agent-panel'].style.width, '612px');
    assert.equal(elements['prompt-agent-panel'].classList.contains('active'), false);
    assert.equal(elements['prompt-agent-messages'].children.length, 2);
    assert.equal(controller.snapshotWorkflow().memory, '低饱和电影感');
});

test('a reply that finishes after switching workflows is not written into the new workflow', async () => {
    let resolveReply;
    const { controller, elements } = createHarness(() => new Promise((resolve) => { resolveReply = resolve; }));
    controller.restoreWorkflow({ version: 1, memory: '', messages: [], panelWidth: null });
    elements['prompt-agent-input'].value = '旧工作流请求';
    const pending = elements['prompt-agent-form'].dispatch('submit');
    controller.restoreWorkflow({ version: 1, memory: '新工作流', messages: [], panelWidth: null });
    resolveReply({ message: '迟到回复', workSummary: [], promptPlan: null });
    await pending;

    assert.equal(controller.snapshotWorkflow().memory, '新工作流');
    assert.equal(controller.snapshotWorkflow().messages.length, 0);
});

test('a reply that fails after switching workflows is not written into the new workflow', async () => {
    let rejectReply;
    const { controller, elements } = createHarness(() => new Promise((resolve, reject) => { rejectReply = reject; }));
    controller.restoreWorkflow({ version: 1, memory: '', messages: [], panelWidth: null });
    elements['prompt-agent-input'].value = '旧工作流请求';
    const pending = elements['prompt-agent-form'].dispatch('submit');
    controller.restoreWorkflow({ version: 1, memory: '新工作流', messages: [], panelWidth: null });
    rejectReply(new Error('迟到错误'));
    await pending;

    assert.equal(controller.snapshotWorkflow().memory, '新工作流');
    assert.equal(controller.snapshotWorkflow().messages.length, 0);
});

test('default Prompt Plan uses restored Workflow Memory when no node prompt exists', async () => {
    const elements = {
        'btn-prompt-agent': new FakeElement(), 'prompt-agent-panel': new FakeElement(),
        'btn-close-prompt-agent': new FakeElement(), 'prompt-agent-form': new FakeElement(),
        'prompt-agent-input': new FakeElement(), 'prompt-agent-send': new FakeElement(),
        'prompt-agent-messages': new FakeElement()
    };
    const documentRef = { getElementById: (id) => elements[id] || null, createElement: () => new FakeElement() };
    let applied = null;
    const controller = createPromptAgentController({
        documentRef,
        getChatModels: () => [TEST_CHAT_MODEL],
        getImageModels: () => [TEST_IMAGE_MODEL],
        nodeAdapter: {
            getSelectedContext: () => ({ nodeId: 'image-1', prompt: '', negativePrompt: '', parameters: {}, referenceImages: [] }),
            applyPromptPlan: (plan) => { applied = plan; return true; }
        }
    });
    controller.init();
    controller.restoreWorkflow({ version: 1, memory: '低饱和电影感城市', messages: [], panelWidth: null, imageModelId: TEST_IMAGE_MODEL.id });
    elements['prompt-agent-input'].value = '改成侧脸';
    await elements['prompt-agent-form'].dispatch('submit');
    const agentMessage = elements['prompt-agent-messages'].children[1];
    agentMessage.children[3].children[0].dispatch('click');
    assert.match(applied.prompt, /低饱和电影感城市/);
    assert.match(applied.prompt, /改成侧脸/);
});

test('default Prompt Plan uses restored Workflow Memory with an existing node prompt', async () => {
    const elements = {
        'btn-prompt-agent': new FakeElement(), 'prompt-agent-panel': new FakeElement(),
        'btn-close-prompt-agent': new FakeElement(), 'prompt-agent-form': new FakeElement(),
        'prompt-agent-input': new FakeElement(), 'prompt-agent-send': new FakeElement(),
        'prompt-agent-messages': new FakeElement()
    };
    const documentRef = { getElementById: (id) => elements[id] || null, createElement: () => new FakeElement() };
    let applied = null;
    const controller = createPromptAgentController({
        documentRef,
        getChatModels: () => [TEST_CHAT_MODEL],
        getImageModels: () => [TEST_IMAGE_MODEL],
        nodeAdapter: {
            getSelectedContext: () => ({ nodeId: 'image-1', prompt: '旧提示词', negativePrompt: '', parameters: {}, referenceImages: [] }),
            applyPromptPlan: (plan) => { applied = plan; return true; }
        }
    });
    controller.init();
    controller.restoreWorkflow({ version: 1, memory: '低饱和电影感城市', messages: [], panelWidth: null, imageModelId: TEST_IMAGE_MODEL.id });
    elements['prompt-agent-input'].value = '改成侧脸';
    await elements['prompt-agent-form'].dispatch('submit');
    const agentMessage = elements['prompt-agent-messages'].children[1];
    agentMessage.children[3].children[0].dispatch('click');

    assert.match(applied.prompt, /低饱和电影感城市/);
    assert.match(applied.prompt, /旧提示词/);
    assert.match(applied.prompt, /改成侧脸/);
});

test('pasted reference images are previewed, sent, and persisted with the workflow conversation', async () => {
    let request = null;
    const createReply = async (value) => {
        request = value;
        return {
            message: '已参考图片。',
            workSummary: ['读取参考图'],
            promptPlan: {
                targetNodeId: 'image-1',
                prompt: '参考构图',
                parameters: {},
                referenceImages: value.workflowReferenceImages
            }
        };
    };
    const { controller, elements } = createHarness(createReply, undefined, null, {
        readReferenceFile: async (file) => ({ name: file.name, type: file.type, dataUrl: `data:${file.type};base64,AAAA` })
    });
    const file = { name: '构图.png', type: 'image/png' };
    await elements['prompt-agent-form'].dispatch('paste', {
        clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] }
    });

    assert.equal(elements['prompt-agent-references'].children.length, 1);
    elements['prompt-agent-input'].value = '沿用这个构图';
    await elements['prompt-agent-form'].dispatch('submit');

    assert.equal(request.referenceImages[0].name, '构图.png');
    assert.equal(request.workflowReferenceImages[0].dataUrl, 'data:image/png;base64,AAAA');
    assert.equal(controller.snapshotWorkflow().messages[0].referenceImages[0].name, '构图.png');
    assert.equal(elements['prompt-agent-references'].children.length, 0);
});

test('dropped reference images remain available to later Prompt Plans', async () => {
    const requests = [];
    const { controller, elements } = createHarness(async (value) => {
        requests.push(value);
        return { message: '完成', workSummary: [], promptPlan: { targetNodeId: 'image-1', prompt: value.message, parameters: {}, referenceImages: value.workflowReferenceImages } };
    }, undefined, null, {
        readReferenceFile: async (file) => ({ name: file.name, type: file.type, dataUrl: `data:${file.type};base64,BBBB` })
    });
    await elements['prompt-agent-form'].dispatch('drop', {
        dataTransfer: { files: [{ name: '风格.webp', type: 'image/webp' }] }
    });
    elements['prompt-agent-input'].value = '记住这个风格';
    await elements['prompt-agent-form'].dispatch('submit');
    elements['prompt-agent-input'].value = '再做一个版本';
    await elements['prompt-agent-form'].dispatch('submit');

    assert.equal(requests[1].referenceImages.length, 0);
    assert.equal(requests[1].workflowReferenceImages[0].name, '风格.webp');
});

test('mixed clipboard paste keeps text while collecting its image reference', async () => {
    const { elements } = createHarness(undefined, undefined, null, {
        readReferenceFile: async (file) => ({ name: file.name, type: file.type, dataUrl: `data:${file.type};base64,DDDD` })
    });
    await elements['prompt-agent-form'].dispatch('paste', {
        clipboardData: {
            items: [{ kind: 'file', getAsFile: () => ({ name: '主体.png', type: 'image/png' }) }],
            getData: () => '同时保留这句说明'
        }
    });

    assert.equal(elements['prompt-agent-input'].value, '同时保留这句说明');
    assert.equal(elements['prompt-agent-references'].children.length, 1);
});

test('a reference file that resolves after workflow restore is discarded', async () => {
    let resolveReference;
    const { controller, elements } = createHarness(undefined, undefined, null, {
        readReferenceFile: () => new Promise((resolve) => { resolveReference = resolve; })
    });
    const pending = elements['prompt-agent-form'].dispatch('drop', {
        dataTransfer: { files: [{ name: '旧工作流.png', type: 'image/png' }] }
    });
    controller.restoreWorkflow({ version: 1, memory: '', messages: [], panelWidth: null });
    resolveReference({ name: '旧工作流.png', type: 'image/png', dataUrl: 'data:image/png;base64,EEEE' });
    await pending;

    assert.equal(elements['prompt-agent-references'].children.length, 0);
    assert.equal(controller.snapshotWorkflow().messages.length, 0);
});

const sceneReferences = [
    { referenceId: 'import-a', sourceNodeId: 'a', sourceImageIndex: 0, name: '主体', previewUrl: 'data:image/png;base64,AAAA' },
    { referenceId: 'import-b', sourceNodeId: 'b', sourceImageIndex: 0, name: '风格', previewUrl: 'data:image/png;base64,BBBB' }
];
const previewNumbers = (container) => container.children.map((item) => item.querySelector('.prompt-agent-reference-number').textContent);
function sceneAdapter(readSceneReferenceImage = async (reference) => ({ ...reference, dataUrl: reference.previewUrl })) {
    return { getSelectedContext: () => null, getSceneReferenceImages: () => sceneReferences, readSceneReferenceImage };
}

test('plus selects scene references in click order and renumbers after deselecting or removing', async () => {
    let request;
    const { controller, elements } = createHarness(async (value) => {
        request = value;
        return { message: '已收到参考图', promptPlan: null };
    }, sceneAdapter());
    const picker = elements['prompt-agent-reference-picker'];
    const list = elements['prompt-agent-reference-picker-list'];
    const pending = elements['prompt-agent-references'];
    elements['prompt-agent-add-reference'].dispatch('click');
    assert.equal(picker.hidden, false);
    assert.equal(list.children.length, 2);
    await list.querySelectorAll('.prompt-agent-reference-option')[1].dispatch('click');
    await list.querySelectorAll('.prompt-agent-reference-option')[0].dispatch('click');
    assert.deepEqual(previewNumbers(pending), ['1', '2']);
    assert.equal(pending.children[0].children[0].alt, '参考图 1：风格');
    assert.equal(list.querySelectorAll('.prompt-agent-reference-option')[0].attributes.get('aria-label'), '主体，参考图 2');
    assert.equal(list.querySelectorAll('.prompt-agent-reference-option')[1].attributes.get('aria-checked'), 'true');

    await list.querySelectorAll('.prompt-agent-reference-option')[1].dispatch('click');
    assert.deepEqual(previewNumbers(pending), ['1']);
    assert.equal(list.querySelectorAll('.prompt-agent-reference-option')[0].attributes.get('aria-label'), '主体，参考图 1');
    await list.querySelectorAll('.prompt-agent-reference-option')[1].dispatch('click');
    pending.children[0].querySelector('.prompt-agent-reference-remove').dispatch('click');
    assert.equal(list.querySelectorAll('.prompt-agent-reference-option')[0].attributes.get('aria-checked'), 'false');
    assert.equal(list.querySelectorAll('.prompt-agent-reference-option')[1].attributes.get('aria-label'), '风格，参考图 1');
    await list.querySelectorAll('.prompt-agent-reference-option')[0].dispatch('click');

    await elements['prompt-agent-form'].dispatch('submit');
    assert.deepEqual(request.referenceImages.map((image) => image.sourceNodeId), ['b', 'a']);
    assert.equal(picker.hidden, true);
    assert.equal(pending.hidden, true);
    const snapshot = controller.snapshotWorkflow();
    assert.deepEqual(snapshot.messages[0].referenceImages.map((image) => image.referenceId), ['import-b', 'import-a']);
    controller.restoreWorkflow(snapshot);
    const sent = elements['prompt-agent-messages'].children[0].querySelector('.prompt-agent-message-references');
    assert.deepEqual(previewNumbers(sent), ['1', '2']);
    assert.equal(sent.children[0].children[0].alt, '参考图 1：风格');
});

test('parallel original-image reads keep click order and prevent sending incomplete references', async () => {
    const resolvers = new Map();
    let request;
    const { elements } = createHarness(async (value) => {
        request = value;
        return { message: '收到', promptPlan: null };
    }, sceneAdapter((reference) => new Promise((resolve) => resolvers.set(reference.referenceId, resolve))));
    elements['prompt-agent-add-reference'].dispatch('click');
    const list = elements['prompt-agent-reference-picker-list'];
    const first = list.querySelectorAll('.prompt-agent-reference-option')[1].dispatch('click');
    const second = list.querySelectorAll('.prompt-agent-reference-option')[0].dispatch('click');
    elements['prompt-agent-input'].value = '用第 2 张的主体';
    assert.equal(elements['prompt-agent-send'].disabled, true);
    await elements['prompt-agent-form'].dispatch('submit');
    assert.equal(request, undefined);
    assert.equal(elements['prompt-agent-input'].value, '用第 2 张的主体');
    resolvers.get('import-a')({ ...sceneReferences[0], dataUrl: 'data:image/png;base64,FULL_A' });
    await second;
    assert.equal(elements['prompt-agent-send'].disabled, true);
    resolvers.get('import-b')({ ...sceneReferences[1], dataUrl: 'data:image/png;base64,FULL_B' });
    await first;
    assert.equal(elements['prompt-agent-send'].disabled, false);
    await elements['prompt-agent-form'].dispatch('submit');
    assert.deepEqual(request.referenceImages.map((image) => image.dataUrl), ['data:image/png;base64,FULL_B', 'data:image/png;base64,FULL_A']);
});

test('failed or cancelled selections can be retried without resurrecting a removed image', async () => {
    let resolveImage;
    let fail = true;
    const { elements } = createHarness(undefined, sceneAdapter(async (reference) => {
        if (fail) throw new Error('原图已丢失');
        return new Promise((resolve) => { resolveImage = () => resolve({ ...reference, dataUrl: reference.previewUrl }); });
    }));
    elements['prompt-agent-add-reference'].dispatch('click');
    const list = elements['prompt-agent-reference-picker-list'];
    await list.querySelectorAll('.prompt-agent-reference-option')[0].dispatch('click');
    assert.equal(elements['prompt-agent-references'].children.length, 0);
    assert.equal(elements['prompt-agent-reference-error'].hidden, false);
    assert.match(elements['prompt-agent-reference-error'].textContent, /原图已丢失/);
    assert.equal(elements['prompt-agent-send'].disabled, false);
    fail = false;
    const loading = list.querySelectorAll('.prompt-agent-reference-option')[0].dispatch('click');
    await list.querySelectorAll('.prompt-agent-reference-option')[0].dispatch('click');
    resolveImage();
    await loading;
    assert.equal(elements['prompt-agent-references'].children.length, 0);
    assert.equal(elements['prompt-agent-reference-error'].hidden, true);
    const retry = list.querySelectorAll('.prompt-agent-reference-option')[0].dispatch('click');
    resolveImage();
    await retry;
    assert.deepEqual(previewNumbers(elements['prompt-agent-references']), ['1']);
});

test('scene reads finishing after a workflow switch cannot add references to the new workflow', async () => {
    let finish;
    const { controller, elements } = createHarness(undefined, sceneAdapter((reference) => new Promise((resolve) => {
        finish = () => resolve({ ...reference, dataUrl: reference.previewUrl });
    })));
    elements['prompt-agent-add-reference'].dispatch('click');
    const loading = elements['prompt-agent-reference-picker-list'].querySelectorAll('.prompt-agent-reference-option')[0].dispatch('click');
    controller.restoreWorkflow(null);
    finish();
    await loading;
    assert.equal(elements['prompt-agent-reference-picker'].hidden, true);
    assert.equal(elements['prompt-agent-references'].children.length, 0);
    assert.equal(elements['prompt-agent-send'].disabled, false);
    assert.equal(controller.snapshotWorkflow().messages.length, 0);
});

test('the picker refreshes the current scene and exposes an empty state and keyboard dismissal', () => {
    let candidates = sceneReferences;
    const { controller, elements } = createHarness(undefined, {
        ...sceneAdapter(), getSceneReferenceImages: () => candidates
    });
    elements['prompt-agent-add-reference'].dispatch('click');
    assert.equal(elements['prompt-agent-reference-picker-list'].children.length, 2);
    candidates = [];
    controller.refreshActionStates();
    assert.equal(elements['prompt-agent-reference-picker-list'].children.length, 0);
    assert.match(elements['prompt-agent-reference-picker-status'].textContent, /还没有/);
    elements['prompt-agent-form'].dispatch('keydown', { key: 'Escape' });
    assert.equal(elements['prompt-agent-reference-picker'].hidden, true);
    assert.equal(elements['prompt-agent-add-reference'].attributes.get('aria-expanded'), 'false');
});

function enterText(elements, text) {
    elements['prompt-agent-input'].value = text;
    elements['prompt-agent-input'].dispatch('input');
}

test('clear works without a model and erases drafts, attachments, plans and checkpoints while preserving the panel', async () => {
    let replyCount = 0;
    const { controller, elements } = createHarness(async () => { replyCount++; }, undefined, null, { getChatModels: () => [] });
    controller.restoreWorkflow({
        memory: '记忆', contextSummary: '摘要', panelWidth: 612,
        archivedMessages: [{ role: 'user', text: '旧消息' }],
        messages: [{ role: 'agent', text: '方案', promptPlan: { prompt: '蓝猫', parameters: {} } }],
        referenceImages: [{ name: '旧图', dataUrl: 'data:image/png;base64,OLD' }]
    });
    controller.open();
    enterText(elements, '/clear');
    assert.equal(elements['prompt-agent-send'].disabled, false);
    await controller.submit();
    const snapshot = controller.snapshotWorkflow();
    assert.deepEqual(snapshot.messages, []);
    for (const key of ['contextSummary', 'archivedMessages', 'referenceImages', 'previousPromptPlan']) assert.equal(snapshot[key], undefined);
    assert.equal(snapshot.memory, '');
    assert.equal(elements['prompt-agent-panel'].style.width, '612px');
    assert.equal(elements['prompt-agent-panel'].classList.contains('active'), true);
    assert.equal(replyCount, 0);
    assert.match(elements['prompt-agent-command-status'].textContent, /已清空/);
});

test('clear fences late replies and image reads without unlocking a newer request', async () => {
    const replyResolvers = [];
    let resolveImage;
    const { controller, elements } = createHarness((request) => new Promise((resolve) => replyResolvers.push({ request, resolve })), undefined, null, {
        readReferenceFile: () => new Promise((resolve) => { resolveImage = resolve; })
    });
    enterText(elements, '旧任务');
    const oldReply = controller.submit();
    const oldImage = elements['prompt-agent-form'].dispatch('drop', { dataTransfer: { files: [{ type: 'image/png', name: '旧图' }] } });
    enterText(elements, '/clear');
    await controller.submit();
    assert.equal(replyResolvers[0].request.signal.aborted, true);
    enterText(elements, '新任务');
    const newReply = controller.submit();
    replyResolvers[0].resolve({ message: '迟到回复' });
    resolveImage({ name: '迟到图片', dataUrl: 'data:image/png;base64,LATE' });
    await Promise.all([oldReply, oldImage]);
    assert.equal(elements['prompt-agent-send'].disabled, true);
    assert.equal(elements['prompt-agent-cancel'].hidden, false);
    assert.equal(elements['prompt-agent-references'].children.length, 0);
    assert.deepEqual(controller.snapshotWorkflow().messages.map((message) => message.text), ['新任务']);
    replyResolvers[1].resolve({ message: '新回复' });
    await newReply;
    assert.deepEqual(controller.snapshotWorkflow().messages.map((message) => message.text), ['新任务', '新回复']);
});

test('slash menus filter and handle keyboard selection without executing an IME confirmation', async () => {
    const { controller, elements } = createHarness();
    enterText(elements, '/');
    const menu = elements['prompt-agent-command-menu'];
    const input = elements['prompt-agent-input'];
    assert.equal(menu.hidden, false);
    assert.equal(menu.children.length, 2);
    await input.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(menu.children[1].attributes.get('aria-selected'), 'true');
    await input.dispatch('keydown', { key: 'Enter', isComposing: true });
    assert.equal(menu.hidden, false);
    await input.dispatch('keydown', { key: 'Enter', shiftKey: true });
    assert.equal(menu.hidden, false);
    assert.equal(input.value, '/');
    await input.dispatch('keydown', { key: 'Escape' });
    assert.equal(menu.hidden, true);
    enterText(elements, '/cle');
    assert.equal(menu.children.length, 1);
    await input.dispatch('keydown', { key: 'Enter' });
    assert.match(elements['prompt-agent-command-status'].textContent, /已清空/);
    assert.deepEqual(controller.snapshotWorkflow().messages, []);
    enterText(elements, '讨论 /clear 的意思');
    assert.equal(menu.hidden, true);
});

test('unknown commands and unavailable or empty compaction stay local', async () => {
    let calls = 0;
    let models = [];
    const { controller, elements } = createHarness(async () => { calls++; }, undefined, null, {
        getChatModels: () => models, createCompaction: async () => { calls++; }
    });
    enterText(elements, '/unknown');
    await controller.submit();
    assert.match(elements['prompt-agent-command-status'].textContent, /未知命令/);
    enterText(elements, '/compact');
    await controller.submit();
    assert.match(elements['prompt-agent-command-status'].textContent, /还没有/);
    controller.restoreWorkflow({ messages: [{ role: 'user', text: '猫' }] });
    enterText(elements, '/compact');
    await controller.submit();
    assert.match(elements['prompt-agent-command-status'].textContent, /配置/);
    assert.equal(elements['prompt-agent-input'].value, '/compact');
    models = [TEST_CHAT_MODEL];
    controller.restoreWorkflow({ contextSummary: '蓝色小猫', messages: [] });
    await controller.submit();
    assert.match(elements['prompt-agent-command-status'].textContent, /还没有新增/);
    assert.equal(calls, 0);
});

test('compaction preserves transcript cards and pending references, then merges only subsequent context', async () => {
    const compactions = [];
    let completeCompaction;
    const replies = [];
    const { controller, elements } = createHarness(async (request) => {
        replies.push(request);
        return { message: '已调整', promptPlan: { prompt: '蓝猫，黄昏', parameters: {} } };
    }, sceneAdapter(), null, { createCompaction: (request) => {
        compactions.push(request);
        return new Promise((resolve) => { completeCompaction = resolve; });
    } });
    controller.restoreWorkflow({ messages: [
        { role: 'user', text: '蓝猫，没有文字' },
        { role: 'agent', text: '初稿', promptPlan: { prompt: '蓝猫，清晨，没有文字', parameters: { count: 2 } } }
    ] });
    const originalCards = elements['prompt-agent-messages'].children.slice();
    elements['prompt-agent-add-reference'].dispatch('click');
    await elements['prompt-agent-reference-picker-list'].querySelectorAll('.prompt-agent-reference-option')[0].dispatch('click');
    enterText(elements, '/compact');
    const compacting = controller.submit();
    assert.equal(compactions[0].modelId, TEST_CHAT_MODEL.id);
    assert.equal(compactions[0].conversation.messages.length, 2);
    enterText(elements, '压缩期间继续写的草稿');
    completeCompaction({ summary: '保持蓝猫和无文字要求，最新清晨方案待应用。' });
    await compacting;
    assert.deepEqual(elements['prompt-agent-messages'].children, originalCards);
    assert.equal(elements['prompt-agent-input'].value, '压缩期间继续写的草稿');
    assert.equal(elements['prompt-agent-references'].children.length, 1);
    const compacted = controller.snapshotWorkflow();
    assert.equal(compacted.contextSummary, '保持蓝猫和无文字要求，最新清晨方案待应用。');
    assert.equal(compacted.archivedMessages.length, 2);
    assert.equal(compacted.messages.length, 0);
    assert.equal(compacted.previousPromptPlan.parameters.count, 2);
    enterText(elements, '改为黄昏');
    await controller.submit();
    assert.equal(replies[0].conversation.contextSummary, compacted.contextSummary);
    assert.equal(replies[0].conversation.messages.length, 0);
    enterText(elements, '/compact');
    const again = controller.submit();
    assert.equal(compactions[1].conversation.messages.length, 2);
    assert.equal(compactions[1].conversation.contextSummary, compacted.contextSummary);
    completeCompaction({ summary: '保持蓝猫和无文字要求，已修改草稿为黄昏，尚未应用。' });
    await again;
    assert.equal(controller.snapshotWorkflow().archivedMessages.length, 4);
});

test('failed or invalid compaction leaves the entire saved context unchanged', async () => {
    for (const createCompaction of [
        async () => { throw new Error('网络中断'); },
        async () => ({ summary: '' }),
        async () => ({ summary: '长'.repeat(3001) })
    ]) {
        const { controller, elements } = createHarness(undefined, undefined, null, { createCompaction });
        controller.restoreWorkflow({ contextSummary: '旧摘要', messages: [{ role: 'user', text: '新要求' }] });
        const before = controller.snapshotWorkflow();
        enterText(elements, '/compact');
        await controller.submit();
        assert.deepEqual(controller.snapshotWorkflow(), before);
        assert.match(elements['prompt-agent-command-status'].textContent, /压缩失败/);
        assert.equal(elements['prompt-agent-cancel'].hidden, true);
    }
});

test('cancelling compaction discards even a cancellation-resistant reply and keeps the original context', async () => {
    let finish;
    let request;
    const { controller, elements } = createHarness(undefined, undefined, null, {
        createCompaction: (value) => {
            request = value;
            return new Promise((resolve) => { finish = resolve; });
        }
    });
    controller.restoreWorkflow({ messages: [{ role: 'user', text: '原要求' }] });
    const before = controller.snapshotWorkflow();
    enterText(elements, '/compact');
    const pending = controller.submit();
    elements['prompt-agent-cancel'].dispatch('click');
    assert.equal(request.signal.aborted, true);
    assert.equal(elements['prompt-agent-cancel'].hidden, true);
    finish({ summary: '不应写回的摘要' });
    await pending;
    assert.deepEqual(controller.snapshotWorkflow(), before);
    assert.match(elements['prompt-agent-command-status'].textContent, /已取消压缩/);
});

test('clearing or switching workflow during compaction discards its late result without touching a newer operation', async () => {
    for (const reset of ['clear', 'switch']) {
        let finishCompact;
        let finishReply;
        const { controller, elements } = createHarness(() => new Promise((resolve) => { finishReply = resolve; }), undefined, null, {
            createCompaction: () => new Promise((resolve) => { finishCompact = resolve; })
        });
        controller.restoreWorkflow({ messages: [{ role: 'user', text: '旧上下文' }] });
        enterText(elements, '/compact');
        const pendingCompact = controller.submit();
        if (reset === 'clear') {
            enterText(elements, '/clear');
            await controller.submit();
        } else controller.restoreWorkflow({ messages: [], memory: '新场景' });
        enterText(elements, '新对话');
        const pendingReply = controller.submit();
        finishCompact({ summary: '旧摘要' });
        await pendingCompact;
        assert.equal(controller.snapshotWorkflow().contextSummary, undefined);
        assert.equal(elements['prompt-agent-cancel'].hidden, false);
        assert.equal(elements['prompt-agent-send'].disabled, true);
        finishReply({ message: '新回复' });
        await pendingReply;
        assert.deepEqual(controller.snapshotWorkflow().messages.map((message) => message.text), ['新对话', '新回复']);
    }
});

test('a new action error during compaction cannot be archived by a summary that never saw it', async () => {
    let finish;
    const { controller, elements } = createHarness(undefined, {
        getSelectedContext: () => ({ nodeId: 'image-1' }),
        applyPromptPlan: () => false
    }, null, { createCompaction: () => new Promise((resolve) => { finish = resolve; }) });
    controller.restoreWorkflow({ messages: [
        { role: 'user', text: '蓝猫' },
        { role: 'agent', text: '方案', promptPlan: { targetNodeId: 'image-1', prompt: '蓝猫', parameters: {} } }
    ] });
    enterText(elements, '/compact');
    const compacting = controller.submit();
    const actions = elements['prompt-agent-messages'].children[1].querySelector('.prompt-agent-actions');
    await actions.children[0].dispatch('click');
    assert.equal(controller.snapshotWorkflow().messages.length, 3);
    finish({ summary: '只有之前两条消息的摘要' });
    await compacting;
    assert.equal(controller.snapshotWorkflow().messages.length, 3);
    assert.equal(controller.snapshotWorkflow().contextSummary, undefined);
    assert.match(elements['prompt-agent-command-status'].textContent, /对话已更新/);
});
