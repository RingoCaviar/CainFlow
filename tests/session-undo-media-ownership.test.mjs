import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';

test('Undo marks only nodes that it actually restores as media owners', async () => {
    const element = () => ({ remove() {}, querySelectorAll: () => [] });
    const state = {
        nodes: new Map([
            ['existing', { id: 'existing', el: element() }],
            ['recreated', { id: 'recreated', el: element() }]
        ]),
        selectedNodes: new Set(),
        connections: [],
        undoStack: [JSON.stringify({ nodes: [
            { id: 'existing', type: 'ImagePreview', x: 0, y: 0, data: {} },
            { id: 'recreated', type: 'ImagePreview', x: 0, y: 0, data: {} },
            { id: 'restored', type: 'ImageImport', x: 0, y: 0, data: {} }
        ], connections: [] })],
        workflowTabs: [],
        workflowOrder: [],
        workflowFolders: []
    };
    const beforeSaveCalls = [];
    const manager = createSessionManagerApi({
        state,
        storageKey: 'session',
        nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }) },
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
});
