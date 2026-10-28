import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';

function harness(overrides = {}) {
    const state = { nodes: new Map(), connections: [], selectedNodes: new Set(), undoStack: [], redoStack: [],
        runningNodeIds: new Set(), workflowTabs: [], workflowOrder: [], workflowFolders: [] };
    const protectedIds = new Set(), releasedIds = [];
    const buttons = { 'btn-undo': { disabled: true }, 'btn-redo': { disabled: true } };
    const element = () => ({ remove() {}, querySelectorAll: () => [] });
    const add = (id, data = {}) => state.nodes.set(id, { id, type: 'ImageGenerate', x: 0, y: 0, data, el: element() });
    const serialize = () => [...state.nodes.values()].map(({ el, ...node }) => structuredClone(node));
    const manager = createSessionManagerApi({ state, storageKey: 'test',
        nodeSerializer: { serializeNodes: serialize, buildStatePayload: () => ({ nodes: serialize(), connections: state.connections }) },
        documentRef: { getElementById: id => buttons[id] || null },
        localStorageRef: { getItem: () => null, setItem() {}, length: 0 },
        showToast() {}, addNode: (_type, _x, _y, node) => state.nodes.set(node.id, { ...node, el: element() }),
        updateAllConnections() {}, updatePortStyles() {},
        getWorkflowSnapshot: () => ({ active: { workflowId: 'workflow-a' }, open: [] }),
        undoMedia: { protect(snapshot) { protectedIds.add(snapshot.historyId); },
            async release(snapshot) { releasedIds.push(snapshot.historyId); protectedIds.delete(snapshot.historyId); }, async end() {} },
        ...overrides });
    return { state, manager, add, serialize, buttons, protectedIds, releasedIds };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('a prepared successful node-and-edge edit commits one undo entry and redoes only its graph', async () => {
    const { state, manager, add, protectedIds, releasedIds } = harness();
    add('old', { mediaAssetKeys: ['media:old'] });
    state.connections.push({ id: 'old-edge', from: { nodeId: 'old', port: 'image' }, to: { nodeId: 'old-target', port: 'referenceImages' }, order: 2 });
    state.redoStack.push(JSON.stringify({ historyId: 'old-redo', nodes: [], connections: [] }));
    protectedIds.add('old-redo');

    const edit = manager.prepareHistoryEdit();
    assert.equal(state.undoStack.length, 0);
    assert.equal(state.redoStack.length, 1, 'preparing alone does not discard the redo branch');
    add('created');
    state.connections[0].to.port = 'mask';
    state.connections.push({ id: 'created-edge', from: { nodeId: 'old', port: 'image' }, to: { nodeId: 'created', port: 'referenceImages' }, order: 0 });
    const historyId = edit.commit();
    assert.equal(edit.commit(), historyId);
    assert.equal(edit.cancel(), false, 'a committed snapshot remains owned by undo');
    assert.equal(state.undoStack.length, 1);
    assert.equal(state.redoStack.length, 0);
    assert.equal(JSON.parse(state.undoStack[0]).connections[0].to.port, 'referenceImages', 'the before snapshot is independent of later graph mutations');
    await tick();
    assert.deepEqual(releasedIds, ['old-redo']);
    assert.ok(protectedIds.has(historyId));

    await manager.undo();
    assert.deepEqual([...state.nodes.keys()], ['old']);
    assert.equal(state.connections.length, 1);
    assert.equal(state.connections[0].to.port, 'referenceImages');
    await manager.redo();
    assert.deepEqual([...state.nodes.keys()], ['old', 'created']);
    assert.equal(state.connections.length, 2);
    assert.equal(state.connections[0].to.port, 'mask');
});

test('cancelling a failed prepared edit preserves undo and redo and releases only its new protection', async () => {
    const { state, manager, add, protectedIds, releasedIds, buttons } = harness();
    add('old', { mediaAssetKeys: ['media:old'] });
    manager.pushHistory();
    const oldUndo = [...state.undoStack];
    state.redoStack.push(JSON.stringify({ historyId: 'redo-to-keep', nodes: [], connections: [] }));
    protectedIds.add('redo-to-keep');
    manager.updateUndoButton();
    const beforeButtons = structuredClone(buttons);
    const edit = manager.prepareHistoryEdit();
    add('partial');
    state.nodes.delete('partial'); // The synchronous graph caller rolls back its uncommitted node.
    assert.equal(edit.cancel(), true);
    assert.equal(edit.cancel(), false);
    assert.equal(edit.commit(), null);
    await tick();
    assert.deepEqual(state.undoStack, oldUndo);
    assert.equal(state.redoStack.length, 1);
    assert.deepEqual(buttons, beforeButtons);
    assert.equal(protectedIds.size, 2);
    assert.ok(protectedIds.has('redo-to-keep'));
    assert.equal(releasedIds.length, 1);
});

test('preparation keeps unrelated running nodes editable but rejects canvas plan and history transitions', async () => {
    let persist;
    const { state, manager, add } = harness({ persistHistoryTransition: () => new Promise(resolve => { persist = resolve; }) });
    add('unrelated');
    state.runningNodeIds.add('unrelated');
    const edit = manager.prepareHistoryEdit();
    assert.equal(edit.cancel(), true);
    state.runningNodeIds.clear();
    state.canvasPlanApplying = true;
    assert.throws(() => manager.prepareHistoryEdit(), /画布|正在/);
    state.canvasPlanApplying = false;
    manager.pushHistory();
    add('newer');
    const undoing = manager.undo();
    assert.throws(() => manager.prepareHistoryEdit(), /撤销|正在/);
    for (let i = 0; i < 10 && !persist; i += 1) await tick();
    assert.ok(persist);
    persist(true);
    await undoing;
});

test('a commit blocked by a later canvas plan releases its pending protection without consuming redo', async () => {
    const { state, manager, add, protectedIds, releasedIds } = harness();
    add('old', { mediaAssetKeys: ['media:old'] });
    state.redoStack.push(JSON.stringify({ historyId: 'redo-to-keep', nodes: [], connections: [] }));
    const edit = manager.prepareHistoryEdit();
    state.canvasPlanApplying = true;
    assert.throws(() => edit.commit(), /画布|正在/);
    assert.equal(edit.commit(), null);
    assert.equal(edit.cancel(), false);
    await tick();
    assert.equal(protectedIds.size, 0);
    assert.equal(releasedIds.length, 1);
    assert.equal(state.undoStack.length, 0);
    assert.equal(state.redoStack.length, 1);
});

test('a snapshot protection failure rejects preparation before touching either history branch', () => {
    const { state, manager, add } = harness({ undoMedia: { protect() { throw Error('media protection offline'); }, release() { throw Error('unexpected release'); } } });
    add('old', { mediaAssetKeys: ['media:old'] });
    state.redoStack.push('redo-to-keep');
    assert.throws(() => manager.prepareHistoryEdit(), /protection/);
    assert.deepEqual(state.undoStack, []);
    assert.deepEqual(state.redoStack, ['redo-to-keep']);
});
