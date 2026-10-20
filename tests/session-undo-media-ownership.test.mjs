import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';

test('session initialization removes legacy persisted undo snapshot metadata', () => {
    const removed = [];
    createSessionManagerApi({
        state: { nodes: new Map(), connections: [], undoStack: [], redoStack: [] },
        storageKey: 'session', nodeSerializer: { serializeNodes: () => [] },
        localStorageRef: {
            getItem: () => '[{"nodes":[]}]',
            removeItem: (key) => removed.push(key)
        },
        documentRef: { getElementById: () => null }
    });
    assert.deepEqual(removed, ['cainflow_pending_undo_media_releases']);
});

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

test('Undo keeps graph history without creating a disk owner for the Redo snapshot', async () => {
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
        addNode() { throw new Error('The target snapshot has no nodes'); },
        updateAllConnections() {},
        updatePortStyles() {},
        getWorkflowSnapshot: () => ({ active: { workflowId: 'workflow' }, open: [] }),
        referenceMediaAsset: async (...args) => { references.push(args); return false; },
        removeMediaReference: async () => true
    });

    await manager.undo();

    assert.deepEqual(references, []);
    assert.deepEqual([...state.nodes.keys()], []);
    assert.equal(state.undoStack.length, 0);
    assert.equal(state.redoStack.length, 1);
});

test('Undo restores node structure without a media key already collected from disk', async () => {
    const state = {
        nodes: new Map(), selectedNodes: new Set(), connections: [],
        undoStack: [JSON.stringify({ mediaUndoOwnerId: 'workflow:old-undo', nodes: [{
            id: 'deleted', type: 'ImageImport', x: 0, y: 0,
            imageImportAssetKey: 'media:collected', mediaAssetKeys: ['media:collected'],
            imageAssetReady: true, imageCount: 1
        }], connections: [] })],
        redoStack: [], workflowTabs: [], workflowOrder: [], workflowFolders: []
    };
    const persisted = [];
    const released = [];
    const manager = createSessionManagerApi({
        state, storageKey: 'session',
        nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }), serializeNodes: () => [] },
        localStorageRef: { setItem() {}, getItem: () => null, length: 0 },
        documentRef: { getElementById: () => null }, showToast() {},
        addNode(_type, _x, _y, data) {
            state.nodes.set(data.id, { ...data, el: { remove() {}, querySelectorAll: () => [] } });
        },
        updateAllConnections() {}, updatePortStyles() {},
        getWorkflowSnapshot: () => ({ active: { workflowId: 'workflow' }, open: [] }),
        mediaAssetExists: async () => false,
        removeMediaReference: async (...args) => { released.push(args); return true; },
        persistHistoryTransition: async () => {
            persisted.push([...state.nodes.values()].map(({ el: _el, ...node }) => node));
            return true;
        }
    });
    await manager.undo();
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0][0].mediaAssetKeys, []);
    assert.equal(persisted[0][0].imageImportAssetKey, '');
    assert.equal(persisted[0][0].imageAssetReady, undefined);
    assert.deepEqual(released, [['workflow-undo', 'workflow:old-undo:deleted', 'media:collected']]);
    assert.equal(state.redoStack.length, 1);
});

test('Undo keeps surviving images in a batch and updates the image count', async () => {
    const state = {
        nodes: new Map(), selectedNodes: new Set(), connections: [],
        undoStack: [JSON.stringify({ nodes: [{
            id: 'batch', type: 'ImagePreview', x: 0, y: 0,
            mediaAssetKeys: ['media:removed', 'media:surviving'],
            imageAssetKey: 'media:removed', imageCount: 2, imagePreviewIndex: 1
        }], connections: [] })],
        redoStack: [], workflowTabs: [], workflowOrder: [], workflowFolders: []
    };
    const manager = createSessionManagerApi({
        state, storageKey: 'session',
        nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }), serializeNodes: () => [] },
        localStorageRef: { setItem() {}, getItem: () => null, length: 0 },
        documentRef: { getElementById: () => null }, showToast() {},
        addNode(_type, _x, _y, data) {
            state.nodes.set(data.id, { ...data, el: { remove() {}, querySelectorAll: () => [] } });
        },
        updateAllConnections() {}, updatePortStyles() {},
        getWorkflowSnapshot: () => ({ active: { workflowId: 'workflow' }, open: [] }),
        mediaAssetExists: async (key) => key === 'media:surviving'
    });
    await manager.undo();
    const restored = state.nodes.get('batch');
    assert.deepEqual(restored.mediaAssetKeys, ['media:surviving']);
    assert.equal(restored.imageAssetKey, 'media:surviving');
    assert.equal(restored.imageCount, 1);
    assert.equal(restored.imagePreviewIndex, 0);
});
