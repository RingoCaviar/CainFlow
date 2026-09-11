import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';

test('closing immediately after opening workflows retains the complete open-workflow session', () => {
    const stored = new Map();
    const state = {
        workflowTabs: [
            { workflowId: 'workflow-a', name: 'A', data: { workflowId: 'workflow-a', nodes: [], connections: [] } },
            { workflowId: 'workflow-b', name: 'B', data: { workflowId: 'workflow-b', nodes: [], connections: [] } }
        ],
        workflowOrder: [],
        workflowFolders: [],
        workflowSidebarWidth: 320,
        dragging: null,
        resizing: null,
        themeId: 'light',
        globalAnimationEnabled: true,
        undoStack: []
    };
    const manager = createSessionManagerApi({
        state,
        storageKey: 'session',
        nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }) },
        localStorageRef: { setItem(key, value) { stored.set(key, value); } },
        documentRef: { getElementById: () => null },
        showToast() {},
        addNode() {},
        updateAllConnections() {},
        updatePortStyles() {},
        getWorkflowSnapshot: () => ({
            active: { workflowId: 'workflow-b', label: 'B' },
            open: [
                { workflowId: 'workflow-a', label: 'A', pendingExplicitSave: false, running: false },
                { workflowId: 'workflow-b', label: 'B', pendingExplicitSave: false, running: false }
            ]
        })
    });

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = () => 1;
    try {
        manager.scheduleSave({ dirty: false });
        manager.flushSave();
        const savedSession = stored.get('session');
        assert.ok(savedSession, 'application shutdown must not leave the workflow session unsaved');
        assert.deepEqual(JSON.parse(savedSession).workflowTabs.map(({ workflowId }) => workflowId), [
            'workflow-a',
            'workflow-b'
        ]);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
    }
});

test('session saving omits an Open Workflow record whose presentation document is no longer available', () => {
    const stored = new Map();
    const state = {
        workflowTabs: [
            { workflowId: 'workflow-present', name: 'Present', data: { workflowId: 'workflow-present', nodes: [], connections: [] } }
        ],
        workflowOrder: ['Stale', 'Present'],
        workflowFolders: [],
        workflowSidebarWidth: 320,
        dragging: null,
        resizing: null,
        themeId: 'light',
        globalAnimationEnabled: true,
        undoStack: []
    };
    const manager = createSessionManagerApi({
        state,
        storageKey: 'session',
        nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }) },
        localStorageRef: { setItem(key, value) { stored.set(key, value); } },
        documentRef: { getElementById: () => null },
        showToast() {},
        addNode() {},
        updateAllConnections() {},
        updatePortStyles() {},
        getWorkflowSnapshot: () => ({
            active: { workflowId: 'workflow-present', label: 'Present' },
            open: [
                { workflowId: 'workflow-stale', label: 'Stale', pendingExplicitSave: false, running: false },
                { workflowId: 'workflow-present', label: 'Present', pendingExplicitSave: false, running: false }
            ]
        })
    });

    assert.equal(manager.saveState(), true);
    const savedSession = JSON.parse(stored.get('session'));
    assert.deepEqual(savedSession.workflowTabs.map(({ workflowId }) => workflowId), ['workflow-present']);
    assert.deepEqual(savedSession.workflowOrder, ['Stale', 'Present']);
});
