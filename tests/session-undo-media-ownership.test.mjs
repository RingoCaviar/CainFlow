import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';

test('Undo and Redo mark only nodes that they actually restore as media owners', async () => {
    const element = () => ({ remove() {}, querySelectorAll: () => [] });
    const state = {
        nodes: new Map([
            ['existing', { id: 'existing', el: element() }],
            ['newer', { id: 'newer', type: 'ImagePreview', x: 0, y: 0, data: {}, el: element() }]
        ]),
        selectedNodes: new Set(),
        connections: [],
        undoStack: [JSON.stringify({ nodes: [
            { id: 'existing', type: 'ImagePreview', x: 0, y: 0, data: {} },
            { id: 'restored', type: 'ImageImport', x: 0, y: 0, data: {} }
        ], connections: [] })],
        redoStack: [],
        workflowTabs: [],
        workflowOrder: [],
        workflowFolders: []
    };
    const beforeSaveCalls = [];
    const manager = createSessionManagerApi({
        state,
        storageKey: 'session',
        nodeSerializer: {
            buildStatePayload: () => ({ nodes: [], connections: [] }),
            serializeNodes: () => [...state.nodes.values()].map(({ el: _el, ...node }) => node)
        },
        localStorageRef: { setItem() {}, getItem: () => null, length: 0 },
        documentRef: { getElementById: () => null },
        showToast() {},
        addNode(type, x, y, data) { state.nodes.set(data.id, { ...data, type, x, y, el: element() }); },
        updateAllConnections() {},
        updatePortStyles() {},
        getWorkflowSnapshot: () => ({ active: { workflowId: 'workflow' }, open: [] }),
        clearOrphanedNodeAssets: async () => true
    });
    manager.setBeforeSave((options) => beforeSaveCalls.push(options));

    await manager.undo();

    assert.deepEqual(beforeSaveCalls.find((call) => call.dirty === true)?.mediaOwnershipRestoreOwnerIds,
        ['workflow-import:restored']);
    assert.deepEqual([...state.nodes.keys()], ['existing', 'restored']);
    assert.equal(state.redoStack.length, 1);

    beforeSaveCalls.length = 0;
    await manager.redo();

    assert.deepEqual(beforeSaveCalls.find((call) => call.dirty === true)?.mediaOwnershipRestoreOwnerIds,
        ['workflow-node:newer']);
    assert.deepEqual([...state.nodes.keys()], ['existing', 'newer']);
    assert.equal(state.undoStack.length, 1);
    assert.equal(state.redoStack.length, 0);

    await manager.undo();
    assert.equal(state.redoStack.length, 1);

    manager.pushHistory();
    assert.equal(state.redoStack.length, 0);
});

test('Undo keeps the current graph and history intact when Redo snapshot media cannot be protected', async () => {
    const element = () => ({ remove() {}, querySelectorAll: () => [] });
    const currentNode = {
        id: 'current', type: 'ImagePreview', x: 0, y: 0,
        data: { mediaAssetKeys: ['media:current'] }, el: element()
    };
    const state = {
        nodes: new Map([['current', currentNode]]),
        selectedNodes: new Set(),
        connections: [],
        undoStack: [JSON.stringify({ nodes: [], connections: [] })],
        redoStack: [],
        workflowTabs: [],
        workflowOrder: [],
        workflowFolders: []
    };
    const references = [];
    const manager = createSessionManagerApi({
        state,
        storageKey: 'session',
        nodeSerializer: {
            buildStatePayload: () => ({ nodes: [], connections: [] }),
            serializeNodes: () => [{ ...currentNode, el: undefined }]
        },
        localStorageRef: { setItem() {}, getItem: () => null, length: 0 },
        documentRef: { getElementById: () => null },
        showToast() {},
        addNode() { throw new Error('Undo must not apply the snapshot'); },
        updateAllConnections() {},
        updatePortStyles() {},
        getWorkflowSnapshot: () => ({ active: { workflowId: 'workflow' }, open: [] }),
        referenceMediaAsset: async (...args) => { references.push(args); return false; },
        removeMediaReference: async () => true
    });

    await manager.undo();

    assert.deepEqual(references.map(([ownerType, ownerId, key]) => [ownerType, ownerId.split(':').at(-1) === 'current', key]),
        [['workflow-undo', true, 'media:current']]);
    assert.deepEqual([...state.nodes.keys()], ['current']);
    assert.equal(state.undoStack.length, 1);
    assert.equal(state.redoStack.length, 0);
});
