import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';
import { createPromptAgentCanvasAdapter } from '../js/features/prompt-agent/prompt-agent-canvas-adapter.js';
import { normalizeCanvasPlan } from '../js/features/prompt-agent/prompt-agent-canvas-plan.js';

function harness(options = {}) {
    const state = { nodes: new Map(), connections: [], selectedNodes: new Set(), undoStack: [], redoStack: [], runningNodeIds: new Set(), workflowTabs: [], workflowOrder: [], workflowFolders: [] };
    const element = () => ({ style: {}, remove() {}, querySelectorAll: () => [] });
    const add = (id, text) => state.nodes.set(id, { id, type: 'Text', text, x: 0, y: 0, data: {}, el: element() });
    const serialize = () => [...state.nodes.values()].map(({ el, ...node }) => structuredClone(node));
    const manager = createSessionManagerApi({ state, storageKey: 'test',
        nodeSerializer: { serializeNodes: serialize, buildStatePayload: () => ({ nodes: serialize(), connections: state.connections }) },
        localStorageRef: { setItem() {}, getItem: () => null, length: 0 }, documentRef: { getElementById: () => null },
        getWorkflowSnapshot: () => ({ active: { workflowId: 'w' }, open: [] }), showToast() {},
        addNode: (_type, _x, _y, node) => state.nodes.set(node.id, { ...node, el: element() }),
        updateAllConnections() {}, updatePortStyles() {}, clearOrphanedNodeAssets: async () => true, ...options });
    return { state, manager, add, serialize };
}

test('multi-node canvas commit adds exactly one undo entry; undo/redo preserve whole graph without rerunning', async () => {
    const { state, manager, add } = harness(); add('old', 'before');
    const result = await manager.applyCanvasBatch(() => {
        manager.pushHistory(); state.nodes.get('old').text = 'after';
        add('one', '1'); manager.pushHistory(); add('two', '2');
        state.connections.push({ id: 'link', from: { nodeId: 'one' }, to: { nodeId: 'two' } });
    }, async () => true);
    assert.equal(state.undoStack.length, 1); assert.equal(JSON.parse(state.undoStack[0]).historyId, result.historyId);
    await manager.undo(); assert.deepEqual([...state.nodes.keys()], ['old']); assert.equal(state.nodes.get('old').text, 'before'); assert.equal(state.connections.length, 0);
    await manager.redo(); assert.equal(state.nodes.size, 3); assert.equal(state.nodes.get('old').text, 'after'); assert.equal(state.connections.length, 1);
});

test('applying a canvas batch clears the pending session save that it cancels', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { manager, add } = harness();
    manager.scheduleSave({ dirty: false });
    assert.equal(manager.hasPendingSave(), true);

    await manager.applyCanvasBatch(() => add('new', 'image prompt'), async () => true);

    assert.equal(manager.hasPendingSave(), false);
});

test('mutation failure or failed durable save restores old graph and does not consume redo', async () => {
    for (const failure of ['mutation', 'save']) {
        const { state, manager, add, serialize } = harness(); add('old', 'before');
        state.redoStack.push(JSON.stringify({ nodes: [], connections: [] }));
        const original = serialize();
        await assert.rejects(manager.applyCanvasBatch(() => { add('partial', 'oops'); manager.pushHistory(); if (failure === 'mutation') throw Error('creation failed'); }, async () => false));
        assert.deepEqual(serialize(), original); assert.equal(state.undoStack.length, 0); assert.equal(state.redoStack.length, 1); assert.equal(state.canvasPlanApplying, false);
    }
});

test('a strict failed save restores the pre-edit graph without queueing an ordinary autosave', async () => {
    const { state, manager, add } = harness();
    add('old', 'before');
    const saves = [];
    manager.setBeforeSave(options => saves.push(options));
    await assert.rejects(manager.applyCanvasBatch(() => add('partial', 'pending'),
        async () => ({ committed: false, publicationUnknown: true }), { persistCapturesWorkflow: true }), /无法确认.*请/);
    assert.deepEqual([...state.nodes.keys()], ['old']);
    assert.deepEqual(saves, [{ skipWorkflowAutosave: true }]);
    assert.equal(state.undoStack.length, 0);
});

test('adapter applies metadata in place, saves once, and rolls back or undoes it as a group', async () => {
    const { state, manager, add, serialize } = harness();
    Object.assign(state, { models: [], providers: [], canvas: { zoom: 1 } });
    add('target', 'retained text');
    add('other', 'unaffected');
    Object.assign(state.nodes.get('target'), { type: 'ImageGenerate', prompt: 'keep', customTitle: 'old', apiConfigId: 'configured', providerId: 'bound' });
    state.selectedNodes.add('target');
    const original = serialize();
    let commits = 0, saveResult = { committed: false };
    const adapter = createPromptAgentCanvasAdapter({ state, documentRef: { body: { children: [] } },
        serializeNodes: serialize, getWorkflowId: () => 'w', session: () => manager,
        renameNode: (id, title) => { state.nodes.get(id).customTitle = title; return true; },
        setNodesEnabled: ([id], enabled) => { state.nodes.get(id).enabled = enabled; return true; },
        save: async () => assert.fail('metadata edits use scoped persistence'),
        persistInPlace: async () => { commits++; return saveResult; },
        origin: () => ({ x: 0, y: 0 }), graphChanged() {}
    });
    const plan = normalizeCanvasPlan({ version: 1, steps: [
        { id: 'update', nodeId: 'target', type: 'ImageGenerate', patch: { title: '新标题', x: -20.5, y: 150, enabled: false } }
    ] }, adapter.context());
    assert.deepEqual(adapter.modelsFor(plan, ''), {}, 'a pure patch needs no image model or provider');
    await assert.rejects(adapter.apply(plan, ''), /保存失败/);
    assert.deepEqual(serialize(), original);
    assert.deepEqual(plan.bindings, {});
    assert.equal(state.undoStack.length, 0);
    saveResult = { committed: true };
    await adapter.apply(plan, '');
    const node = state.nodes.get('target');
    assert.equal(commits, 2, 'one save attempt per application');
    assert.deepEqual([node.customTitle, node.x, node.y, node.enabled], ['新标题', -20.5, 150, false]);
    assert.deepEqual(node.el.style, { left: '-20.5px', top: '150px' });
    assert.deepEqual([node.prompt, node.apiConfigId, node.providerId], ['keep', 'configured', 'bound']);
    assert.equal(state.undoStack.length, 1);
    await manager.undo();
    assert.deepEqual(serialize(), original);
    await manager.redo();
    assert.deepEqual([state.nodes.get('target').customTitle, state.nodes.get('target').x], ['新标题', -20.5]);
});

test('batch locks nested operations and running graphs; subsequent manual edit remains a separate undo step', async () => {
    const { state, manager, add } = harness(); add('old', 'before');
    state.runningNodeIds.add('old'); await assert.rejects(manager.applyCanvasBatch(() => {}, async () => true), /正在/); state.runningNodeIds.clear();
    await manager.applyCanvasBatch(async () => {
        add('new', 'new'); await assert.rejects(manager.applyCanvasBatch(() => {}, async () => true));
        assert.equal(manager.saveState(), false);
    }, async () => true);
    manager.pushHistory(); state.nodes.get('new').text = 'manual';
    await manager.undo(); assert.equal(state.nodes.get('new').text, 'new');
    await manager.undo(); assert.equal(state.nodes.has('new'), false);
});

test('a reference below the viewport stays wired without pulling the new Agent batch down to its row', async () => {
    const { state, manager, add, serialize } = harness();
    Object.assign(state, { models: [], providers: [], canvas: { zoom: 1 } });
    add('reference', '');
    Object.assign(state.nodes.get('reference'), { type: 'ImageImport', x: 100, y: 8200 });
    const viewport = { x: 0, y: 100, width: 1100, height: 800 };
    const adapter = createPromptAgentCanvasAdapter({ state, documentRef: { body: { children: [] } },
        serializeNodes: serialize, getWorkflowId: () => 'w', session: () => manager,
        origin: () => viewport, save: async () => true, graphChanged() {}, focusNode() {},
        addNode(type, x, y) {
            const id = 'new-' + state.nodes.size;
            add(id, '');
            Object.assign(state.nodes.get(id), { type, x, y });
            return id;
        }
    });
    const plan = normalizeCanvasPlan({ version: 1,
        steps: [{ id: 'first', type: 'ImagePreview', parameters: {} }],
        connections: [{ from: { ref: 'reference', port: 'image' }, to: { ref: 'first', port: 'image' } }]
    }, adapter.context(['reference']));
    await adapter.apply(plan, '');
    const node = state.nodes.get(plan.bindings.first);
    assert.ok(node.y >= viewport.y && node.y + 340 <= viewport.y + viewport.height, `new node at y=${node.y}`);
    assert.equal(state.nodes.get('reference').y, 8200);
    assert.deepEqual(state.connections.map(link => [link.from.nodeId, link.to.nodeId]), [['reference', node.id]]);
});

test('media protection failure blocks batch mutation and history truncation', async () => {
    const { state, manager, add } = harness({ undoMedia: { protect() { throw Error('protection offline'); } } });
    add('old', 'before'); state.redoStack.push('existing');
    let mutated = false;
    await assert.rejects(manager.applyCanvasBatch(() => { mutated = true; }, async () => true), /protection/);
    assert.equal(mutated, false); assert.deepEqual(state.redoStack, ['existing']);
    assert.equal(state.undoStack.length, 0);
});

test('undo protects redo before restoring and releases old history only after persistence', async () => {
    const order = [], protectedIds = new Set();
    const { manager, add } = harness({ undoMedia: {
        protect(snapshot) { order.push('protect'); protectedIds.add(snapshot.historyId); },
        async release(snapshot) { order.push('release'); protectedIds.delete(snapshot.historyId); }
    }, persistHistoryTransition: async () => { order.push('commit'); return true; } });
    add('original', 'one'); manager.pushHistory(); add('new', 'two');
    order.length = 0; await manager.undo();
    assert.deepEqual(order, ['protect', 'commit', 'release']);
    assert.equal(protectedIds.size, 1);
    for (let i = 0; i < 7; i++) manager.pushHistory();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(protectedIds.size, 5);
    manager.clearUndoStack(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(protectedIds.size, 0);
});
