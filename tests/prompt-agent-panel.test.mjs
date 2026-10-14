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
    querySelector(selector) {
        return this.children.find((child) => child.className === selector.slice(1)) || null;
    }
    blur() {}
}

function createHarness(createReply = async () => ({
    message: '已整理你的创作方向。',
    workSummary: ['理解需求', '整理提示词方向']
})) {
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
    const controller = createPromptAgentController({ documentRef, createReply });
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
    assert.equal(elements['prompt-agent-input'].value, '');
});
