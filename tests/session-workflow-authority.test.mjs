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

test('Session restoration refreshes only clean documents changed by Canvas MCP under the same workflow ID', async () => {
    const state = { workflowTabs: [] };
    const desk = createWorkflowDesk({
        resolveSelection: async selection => selection,
        prepareEditorView: async target => target.editorView
    });
    let visibleDocument;
    const selection = createWorkflowSessionSelectionAdapter({
        state,
        workflowDesk: desk,
        prepareEditorView: async (_label, document) => {
            visibleDocument = document;
            return { async commit() { return true; } };
        }
    });
    const names = ['active', 'inactive', 'draft', 'unsaved-identity', 'reused-name', 'ordinary-write', 'missing-file'];
    const workflowTabs = names.map(name => ({
        name,
        workflowId: name,
        dirty: name === 'draft',
        identityPendingSave: name === 'unsaved-identity',
        data: { workflowId: name, mediaOwnershipRevision: 2, marker: 'cached' }
    }));
    const reads = [];
    const loadSavedWorkflow = async name => {
        reads.push(name);
        if (name === 'missing-file') throw new Error('file unavailable');
        return {
            workflowId: name === 'reused-name' ? 'replacement' : name,
            mediaOwnershipRevision: 5,
            canvasMcpWriteRevision: name === 'ordinary-write' ? 2 : 4,
            marker: 'saved'
        };
    };
    const restored = workflowId => ({
        workflowTabs,
        activeWorkflowId: workflowId,
        activeWorkflowName: workflowId,
        workflowData: { ...workflowTabs.find(tab => tab.workflowId === workflowId).data, marker: 'active-cache' }
    });

    assert.equal(await selection.activate(restored('active'), { loadSavedWorkflow }), true);
    assert.equal(visibleDocument.marker, 'saved', 'the active canvas uses the newer saved graph');
    assert.deepEqual(reads, ['active', 'inactive', 'reused-name', 'ordinary-write', 'missing-file']);
    assert.deepEqual(state.workflowTabs.map(tab => tab.data.marker), ['saved', 'saved', 'cached', 'cached', 'cached', 'cached', 'cached']);

    assert.equal(await selection.activate(restored('draft'), { loadSavedWorkflow }), true);
    assert.equal(visibleDocument.marker, 'active-cache', 'the active unsaved draft remains authoritative');
    assert.equal(state.workflowTabs.find(tab => tab.workflowId === 'draft').dirty, true);
});

test('Session serialization omits an Open Workflow record when its presentation document is missing', async () => {
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

    assert.equal(manager.saveState(), true);
    const session = JSON.parse(stored.get('session'));
    assert.deepEqual(session.workflowTabs, []);
    assert.equal(session.activeWorkflowId, '');
    assert.equal(session.activeWorkflowName, '');
});
