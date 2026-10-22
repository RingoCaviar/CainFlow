import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';

function harness(options = {}) {
    const state = { nodes: new Map(), connections: [], selectedNodes: new Set(), undoStack: [], redoStack: [], runningNodeIds: new Set(), workflowTabs: [], workflowOrder: [], workflowFolders: [] };
    const element = () => ({ remove() {}, querySelectorAll: () => [] });
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

test('mutation failure or failed durable save restores old graph and does not consume redo', async () => {
    for (const failure of ['mutation', 'save']) {
        const { state, manager, add, serialize } = harness(); add('old', 'before');
        state.redoStack.push(JSON.stringify({ nodes: [], connections: [] }));
        const original = serialize();
        await assert.rejects(manager.applyCanvasBatch(() => { add('partial', 'oops'); manager.pushHistory(); if (failure === 'mutation') throw Error('creation failed'); }, async () => false));
        assert.deepEqual(serialize(), original); assert.equal(state.undoStack.length, 0); assert.equal(state.redoStack.length, 1); assert.equal(state.canvasPlanApplying, false);
    }
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
