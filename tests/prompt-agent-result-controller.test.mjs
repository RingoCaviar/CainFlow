import assert from 'node:assert/strict';
import test from 'node:test';
import { createPromptAgentController } from '../js/features/prompt-agent/prompt-agent-controller.js';
import { createPromptAgentResultPersistence } from '../js/features/prompt-agent/prompt-agent-result-persistence.js';

class Element {
    constructor() {
        this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.value = ''; this.style = {}; this.textContent = '';
        const classes = new Set();
        this.classList = { add: (...names) => names.forEach((name) => classes.add(name)), remove: (...names) => names.forEach((name) => classes.delete(name)),
            contains: (name) => classes.has(name), toggle: (name, force) => { const enabled = force ?? !classes.has(name); if (enabled) classes.add(name); else classes.delete(name); return enabled; } };
    }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    dispatch(type, event = {}) { return this.listeners.get(type)?.({ target: this, preventDefault() {}, ...event }); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    replaceChildren() { this.children = []; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); }
    querySelector(selector) { return this.children.find((child) => child.className === selector.slice(1)) || null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    getBoundingClientRect() { return { width: 480 }; }
    focus() {}
    blur() {}
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
const initial = (text = '方案') => ({ version: 1, imageModelId: 'model', messages: [{
    role: 'agent', text, promptPlan: { targetNodeId: 'image', prompt: '猫', parameters: {} }
}] });
const allRuns = (snapshot) => [...(snapshot?.archivedMessages || []), ...(snapshot?.messages || [])].flatMap((message) => message.runs || []);
const clone = (value) => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
    const elements = new Map();
    const element = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
    let workflowId = 'a', nextRunId = 0, executionCount = 0;
    const workflows = new Map([['a', initial()], ['b', initial('另一个工作流')]]);
    const resultReady = deferred();
    const mutateConversation = (id, reducer) => {
        if (!workflows.has(id)) return false;
        const next = reducer(clone(id === workflowId ? controller.snapshotWorkflow() : workflows.get(id)));
        if (!next) return false;
        workflows.set(id, next);
        if (id === workflowId) controller.syncWorkflowState(next);
        return true;
    };
    const resultPersistence = createPromptAgentResultPersistence({
        mutateConversation,
        media: {
            retain: options.retainRunResults || (async ({ runId, mediaAssetKeys }) => ({ mediaAssetKeys, persistenceStatus: 'retained',
                mediaOwnershipTemporaryOwners: [{ ownerId: `owner-${runId}`, assetKeys: mediaAssetKeys }] })),
            release: options.releaseRunResults || (async () => true)
        },
        saveConversation: options.saveConversation,
        onChange: id => { if (id === workflowId) controller.refreshResults(); }
    });
    const controller = createPromptAgentController({
        documentRef: { getElementById: element, createElement: () => new Element() },
        getChatModels: () => [{ id: 'chat', modelId: 'chat' }], getImageModels: () => [{ id: 'model', modelId: 'image' }],
        getWorkflowId: () => workflowId, createRunId: () => `run-${++nextRunId}`,
        nodeAdapter: { ensureTarget: (plan) => plan, applyPromptPlan: () => true },
        executionAdapter: { applyAndGenerate: async (plan, { retainResults }) => {
            executionCount++;
            const result = await resultReady.promise;
            await retainResults({ workflowId: 'a', outcome: 'completed', nodeResults: [{ nodeId: plan.targetNodeId, ...result }] });
            return { status: 'completed', ...result };
        } },
        onStateChange: () => workflows.set(workflowId, controller.snapshotWorkflow()),
        mutateWorkflowConversation: mutateConversation,
        resultPersistence,
        loadResultImages: async (keys) => keys.map((key) => `/assets/${key}`),
    });
    controller.init();
    controller.restoreWorkflow(workflows.get('a'));
    return {
        controller, workflows, element, resultReady,
        executionCount: () => executionCount,
        run: () => element('prompt-agent-messages').children[0].querySelector('.prompt-agent-actions').children[1].dispatch('click'),
        async clear() { element('prompt-agent-input').value = '/clear'; await controller.submit(); },
        switchTo(id) { workflows.set(workflowId, controller.snapshotWorkflow()); workflowId = id; controller.restoreWorkflow(workflows.get(id)); },
        currentRunView: () => element('prompt-agent-messages').children[0]?.querySelector('.prompt-agent-run-state')
    };
}

test('a background completion updates only its original workflow and reopens with its retained batch', async () => {
    const app = harness();
    const pending = app.run();
    app.switchTo('b');
    const other = clone(app.controller.snapshotWorkflow());
    app.resultReady.resolve({ images: ['original-a', 'original-b'], mediaAssetKeys: ['media:a', 'media:b'] });
    await pending;
    assert.deepEqual(app.controller.snapshotWorkflow(), other);
    assert.deepEqual(allRuns(app.workflows.get('a'))[0].mediaAssetKeys, ['media:a', 'media:b']);
    assert.equal(allRuns(app.workflows.get('a'))[0].persistenceStatus, 'saved');
    app.switchTo('a');
    await turn();
    assert.equal(app.currentRunView().children.filter((child) => child.className === 'prompt-agent-result-image').length, 2);
    assert.equal(app.element('prompt-agent-messages').children[0].querySelector('.prompt-agent-actions').children[1].disabled, false);
});
test('retrying a failed conversation save keeps the original result and does not generate again', async () => {
    let saves = 0, retentions = 0;
    const released = [];
    const app = harness({
        retainRunResults: async ({ mediaAssetKeys }) => { retentions++; return { mediaAssetKeys, persistenceStatus: 'retained',
            mediaOwnershipTemporaryOwners: [{ ownerId: 'operation', assetKeys: mediaAssetKeys }] }; },
        saveConversation: async () => { if (++saves === 1) throw new Error('磁盘暂不可写'); },
        releaseRunResults: async (result) => released.push(result)
    });
    const pending = app.run();
    app.resultReady.resolve({ images: ['original'], mediaAssetKeys: ['media:a'] });
    await pending;
    assert.equal(allRuns(app.controller.snapshotWorkflow())[0].persistenceStatus, 'failed');
    assert.match(app.currentRunView().textContent, /保存失败/);
    const completionOrder = allRuns(app.controller.snapshotWorkflow())[0].completionOrder;
    assert.ok(Number.isSafeInteger(completionOrder) && completionOrder > 0);
    assert.equal(released.length, 0);
    await app.currentRunView().children.find((child) => child.textContent === '重试保存').dispatch('click');
    assert.equal(allRuns(app.controller.snapshotWorkflow())[0].persistenceStatus, 'saved');
    assert.equal(allRuns(app.controller.snapshotWorkflow())[0].completionOrder, completionOrder);
    assert.deepEqual(allRuns(app.controller.snapshotWorkflow())[0].mediaAssetKeys, ['media:a']);
    assert.equal(app.executionCount(), 1);
    assert.equal(retentions, 1);
    assert.equal(released.length, 1);
});
