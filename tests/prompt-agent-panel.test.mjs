import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptAgentController } from '../js/features/prompt-agent/prompt-agent-controller.js';

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
    }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    dispatch(type, event = {}) { return this.listeners.get(type)?.({ preventDefault() {}, target: this, ...event }); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren() { this.children.length = 0; }
    querySelector(selector) {
        return this.children.find((child) => child.className === selector.slice(1)) || null;
    }
    blur() {}
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
}, executionAdapter = null) {
    const elements = {
        'btn-prompt-agent': new FakeElement(),
        'prompt-agent-panel': new FakeElement(),
        'btn-close-prompt-agent': new FakeElement(),
        'prompt-agent-form': new FakeElement(),
        'prompt-agent-input': new FakeElement(),
        'prompt-agent-send': new FakeElement(),
        'prompt-agent-messages': new FakeElement()
    };
    const documentRef = {
        activeElement: null,
        getElementById: (id) => elements[id] || null,
        createElement: () => new FakeElement()
    };
    const controller = createPromptAgentController({ documentRef, createReply, nodeAdapter, executionAdapter });
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
