import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';
import { createWorkflowDesk } from '../js/features/workflow/workflow-desk.js';
import { createWorkflowSessionSelectionAdapter } from '../js/features/workflow/workflow-selection-adapter.js';

test('Session serialization joins presentation data to authoritative Open Workflow records by Workflow identity', async () => {
    const stored = new Map();
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async () => ({ async commit() { return true; } })
    });
    await desk.show({
        workflowId: 'workflow-a',
        label: 'authoritative/a',
        pendingExplicitSave: true
    });
    desk.workflow('workflow-a').runningChanged(true);
    await desk.show({ workflowId: 'workflow-b', label: 'authoritative/b' });

    const state = {
        workflowTabs: [
            {
                workflowId: 'workflow-b',
                name: 'stale/a',
                running: true,
                identityPendingSave: true,
                dirty: true,
                runResult: 'success',
                colorIndex: 7,
                data: { workflowId: 'workflow-b', marker: 'document-b' }
            },
            {
                workflowId: 'workflow-a',
                name: 'stale/b',
                running: false,
                identityPendingSave: false,
                dirty: false,
                runResult: 'error',
                colorIndex: 3,
                data: { workflowId: 'workflow-a', marker: 'document-a' }
            }
        ],
        workflowOrder: ['stale/a', 'closed/workflow', 'stale/b'],
        workflowFolders: [{
            id: 'folder-1',
            name: 'Folder',
            collapsed: false,
            items: ['stale/b', 'closed/workflow', 'stale/a']
        }],
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
        getWorkflowSnapshot: () => desk.snapshot()
    });

    assert.equal(manager.saveState(), true);
    const session = JSON.parse(stored.get('session'));
    assert.deepEqual(session.workflowTabs.map((tab) => ({
        workflowId: tab.workflowId,
        name: tab.name,
        running: tab.running,
        identityPendingSave: tab.identityPendingSave,
        marker: tab.data.marker,
        dirty: tab.dirty,
        runResult: tab.runResult,
        colorIndex: tab.colorIndex
    })), [
        {
            workflowId: 'workflow-a',
            name: 'authoritative/a',
            running: true,
            identityPendingSave: true,
            marker: 'document-a',
            dirty: false,
            runResult: 'error',
            colorIndex: 3
        },
        {
            workflowId: 'workflow-b',
            name: 'authoritative/b',
            running: false,
            identityPendingSave: false,
            marker: 'document-b',
            dirty: true,
            runResult: 'success',
            colorIndex: 7
        }
    ]);
    assert.equal(session.activeWorkflowId, 'workflow-b');
    assert.equal(session.activeWorkflowName, 'authoritative/b');
    assert.deepEqual(session.workflowOrder, [
        'authoritative/b',
        'closed/workflow',
        'authoritative/a'
    ]);
    assert.deepEqual(session.workflowFolders[0].items, [
        'authoritative/a',
        'closed/workflow',
        'authoritative/b'
    ]);

    const restoredState = { workflowTabs: [] };
    const restoredDesk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView
    });
    const restore = createWorkflowSessionSelectionAdapter({
        state: restoredState,
        workflowDesk: restoredDesk,
        prepareEditorView: async () => ({ async commit() { return true; } })
    }).activate;

    assert.equal(await restore({
        workflowTabs: session.workflowTabs,
        activeWorkflowId: session.activeWorkflowId,
        activeWorkflowName: session.activeWorkflowName,
        workflowData: session.workflowTabs.find(({ workflowId }) => workflowId === session.activeWorkflowId).data
    }), true);
    assert.deepEqual(restoredDesk.snapshot().open, [
        {
            workflowId: 'workflow-a',
            label: 'authoritative/a',
            pendingExplicitSave: true,
            running: true,
            active: false
        },
        {
            workflowId: 'workflow-b',
            label: 'authoritative/b',
            pendingExplicitSave: false,
            running: false,
            active: true
        }
    ]);
    assert.equal(restoredState.workflowTabs[0].data.marker, 'document-a');
    assert.equal(restoredState.workflowTabs[1].data.marker, 'document-b');
});

test('Session serialization preserves the previous session when an Open Workflow document is missing', async () => {
    const stored = new Map([['session', 'previous-session']]);
    const desk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async () => ({ async commit() { return true; } })
    });
    await desk.show({ workflowId: 'workflow-a', label: 'a' });
    const manager = createSessionManagerApi({
        state: {
            workflowTabs: [],
            workflowOrder: [],
            workflowFolders: [],
            workflowSidebarWidth: 320,
            themeId: 'light',
            globalAnimationEnabled: true,
            undoStack: []
        },
        storageKey: 'session',
        nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }) },
        localStorageRef: { setItem(key, value) { stored.set(key, value); } },
        documentRef: { getElementById: () => null },
        showToast() {},
        addNode() {},
        updateAllConnections() {},
        updatePortStyles() {},
        getWorkflowSnapshot: () => desk.snapshot()
    });

    assert.equal(manager.saveState(), false);
    assert.equal(stored.get('session'), 'previous-session');
});
