import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowDesk } from '../js/features/workflow/workflow-desk.js';
import { createWorkflowSelectionAdapter } from '../js/features/workflow/workflow-selection-adapter.js';

test('activating workflows persists the complete Open Workflow session immediately after commit', async () => {
    const state = { workflowTabs: [], undoStack: [] };
    const savedSessions = [];
    const workflowDesk = createWorkflowDesk({
        resolveSelection: async (selection) => selection.resolve(),
        prepareEditorView: async ({ editorView }) => editorView,
        mutateWorkflow: async () => ({ ok: true })
    });
    const adapter = createWorkflowSelectionAdapter({
        state,
        workflowDesk,
        getActiveWorkflow: () => workflowDesk.snapshot().active,
        getWorkflowTab: (name) => state.workflowTabs.find((tab) => tab.name === name),
        ensureWorkflowIdentity: (tab) => tab && (tab.workflowId ||= tab.data.workflowId),
        loadWorkflowFromFile: async (name) => ({ workflowId: `id-${name}`, nodes: [], connections: [] }),
        prepareWorkflowView: async (data) => ({ data, modelResolution: { nodes: [] } }),
        prepareEditorView: async () => ({ async commit() { return true; } }),
        snapshotActiveWorkflow: () => null,
        cloneWorkflowData: (data) => ({ ...data }),
        getEmptyWorkflowData: () => ({ nodes: [], connections: [] }),
        resolveWorkflowModelReferences: () => ({ nodes: [] }),
        clearUndoStack() {}, updatePortStyles() {}, applyViewport() {}, onViewApplied() {},
        onConnectionsChanged() {}, scheduleAssetCleanup() {}, showToast() {}, renderWorkflowList() {},
        scheduleSave() {},
        saveSession: () => savedSessions.push(workflowDesk.snapshot().open.map(({ label }) => label)),
        releaseWorkflowTabMemory() {}, enterSafeEmpty() {}
    });

    assert.equal(await adapter.activate('Default'), true);
    assert.equal(await adapter.activate('Unsaved'), true);
    assert.deepEqual(savedSessions, [['Default'], ['Default', 'Unsaved']]);
});

test('workflow activation completes only after its Open Workflow session is durable', async () => {
    let releaseSessionWrite;
    const sessionWritten = new Promise((resolve) => { releaseSessionWrite = resolve; });
    const state = { workflowTabs: [], undoStack: [] };
    const workflowDesk = createWorkflowDesk({
        resolveSelection: async (selection) => selection.resolve(),
        prepareEditorView: async ({ editorView }) => editorView,
        mutateWorkflow: async () => ({ ok: true })
    });
    const adapter = createWorkflowSelectionAdapter({
        state,
        workflowDesk,
        getActiveWorkflow: () => workflowDesk.snapshot().active,
        getWorkflowTab: (name) => state.workflowTabs.find((tab) => tab.name === name),
        ensureWorkflowIdentity: (tab) => tab && (tab.workflowId ||= tab.data.workflowId),
        loadWorkflowFromFile: async () => ({ workflowId: 'workflow-unsaved', nodes: [], connections: [] }),
        prepareWorkflowView: async (data) => ({ data, modelResolution: { nodes: [] } }),
        prepareEditorView: async () => ({ async commit() { return true; } }),
        snapshotActiveWorkflow: () => null,
        cloneWorkflowData: (data) => ({ ...data }),
        getEmptyWorkflowData: () => ({ nodes: [], connections: [] }),
        resolveWorkflowModelReferences: () => ({ nodes: [] }),
        clearUndoStack() {}, updatePortStyles() {}, applyViewport() {}, onViewApplied() {},
        onConnectionsChanged() {}, scheduleAssetCleanup() {}, showToast() {}, renderWorkflowList() {},
        scheduleSave() {}, saveSession: () => sessionWritten,
        releaseWorkflowTabMemory() {}, enterSafeEmpty() {}
    });

    let activated = false;
    const activation = adapter.activate('Unsaved').then((result) => { activated = result; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(activated, false);

    releaseSessionWrite();
    await activation;
    assert.equal(activated, true);
});
