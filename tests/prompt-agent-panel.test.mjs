import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptAgentController } from '../js/features/prompt-agent/prompt-agent-controller.js';

const TEST_CHAT_MODEL = { id: 'chat-1', modelId: 'chat-test', name: 'Chat test' };

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
        'prompt-agent-model': new FakeElement(),
        'prompt-agent-model-hint': new FakeElement(),
        'prompt-agent-messages': new FakeElement(),
        'prompt-agent-references': new FakeElement()
    };
    const documentRef = {
        activeElement: null,
        getElementById: (id) => elements[id] || null,
        createElement: () => new FakeElement()
    };
    const controller = createPromptAgentController({
        documentRef, createReply, nodeAdapter, executionAdapter,
        getChatModels: () => [TEST_CHAT_MODEL], ...controllerOptions
    });
    controller.init();
    return { controller, elements };
}

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
    const { elements } = createHarness(async () => {
        requests += 1;
        return { message: '已就绪', workSummary: [], promptPlan: null };
    }, undefined, undefined, { getChatModels: () => models });

    assert.equal(elements['prompt-agent-model-hint'].hidden, false);
    assert.equal(elements['prompt-agent-send'].disabled, true);
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

test('disables response actions when the selected target changes before application', async () => {
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

    assert.equal(applied, false);
    assert.equal(actions.children[0].disabled, true);
    assert.equal(actions.children[1].disabled, true);
});

test('keeps chatting but disables plan application without one selected image node', async () => {
    const { elements } = createHarness(async () => ({
        message: '选择一个生图节点后即可应用。',
        workSummary: ['整理提示词方向'],
        promptPlan: { targetNodeId: null, prompt: '草稿提示词', negativePrompt: '', parameters: {} }
    }), {
        getSelectedContext: () => null,
        applyPromptPlan: () => false
    });
    elements['prompt-agent-input'].value = '先帮我写提示词';

    await elements['prompt-agent-form'].dispatch('submit');
    const agentMessage = elements['prompt-agent-messages'].children[1];
    assert.equal(agentMessage.children[3].children[0].disabled, true);
});

test('refreshes response actions after selecting the planned target node', async () => {
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
    assert.equal(actions.children[0].disabled, true);
    assert.equal(actions.children[1].disabled, true);

    selected = { nodeId: 'image-1', prompt: '', negativePrompt: '', parameters: {}, referenceImages: [] };
    controller.refreshActionStates();
    assert.equal(actions.children[0].disabled, false);
    assert.equal(actions.children[1].disabled, true);
});

test('binds an unassigned draft to a single image node selected afterwards', async () => {
    let selected = null;
    let applied = null;
    const { controller, elements } = createHarness(async () => ({
        message: '草稿已就绪',
        workSummary: [],
        promptPlan: { targetNodeId: null, prompt: '草稿提示词', negativePrompt: '', parameters: {} }
    }), {
        getSelectedContext: () => selected,
        applyPromptPlan: (plan) => { applied = plan; return true; }
    });
    elements['prompt-agent-input'].value = '先整理提示词';
    await elements['prompt-agent-form'].dispatch('submit');
    const actions = elements['prompt-agent-messages'].children[1].children[2];
    assert.equal(actions.children[0].disabled, true);

    selected = { nodeId: 'image-1', prompt: '', negativePrompt: '', parameters: {}, referenceImages: [] };
    controller.refreshActionStates();
    assert.equal(actions.children[0].disabled, false);
    actions.children[0].dispatch('click');
    assert.equal(applied.targetNodeId, 'image-1');
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
    assert.equal(runState.textContent, '生成完成');
    assert.equal(runState.children[0].src, 'data:image/png;base64,b2s=');
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
        nodeAdapter: {
            getSelectedContext: () => ({ nodeId: 'image-1', prompt: '', negativePrompt: '', parameters: {}, referenceImages: [] }),
            applyPromptPlan: (plan) => { applied = plan; return true; }
        }
    });
    controller.init();
    controller.restoreWorkflow({ version: 1, memory: '低饱和电影感城市', messages: [], panelWidth: null });
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
        nodeAdapter: {
            getSelectedContext: () => ({ nodeId: 'image-1', prompt: '旧提示词', negativePrompt: '', parameters: {}, referenceImages: [] }),
            applyPromptPlan: (plan) => { applied = plan; return true; }
        }
    });
    controller.init();
    controller.restoreWorkflow({ version: 1, memory: '低饱和电影感城市', messages: [], panelWidth: null });
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
