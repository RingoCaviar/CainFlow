import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowManagerApi } from '../js/features/workflow/workflow-manager.js';

test('startup keeps every restored open workflow when the file-list refresh is temporarily unavailable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
    try {
        const state = {
            workflowTabs: [],
            workflowOrder: [],
            workflowFolders: [],
            nodes: new Map(),
            connections: [],
            selectedNodes: new Set(),
            canvas: { x: 0, y: 0, zoom: 1 }
        };
        const manager = createWorkflowManagerApi({
            state,
            nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }) },
            viewportApi: { updateCanvasTransform() {} },
            addNode() {},
            updateAllConnections() {},
            updatePortStyles() {},
            scheduleSave() {},
            showToast() {},
            panelManager: {},
            prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
            documentRef: { getElementById: () => null },
            windowRef: { innerWidth: 0, innerHeight: 0 },
            localStorageRef: { getItem: () => null, setItem() {} }
        });

        await manager.activateRestoredWorkflowState({
            workflowTabs: [
                { workflowId: 'workflow-a', name: 'A', data: { workflowId: 'workflow-a', nodes: [], connections: [] } },
                { workflowId: 'workflow-b', name: 'B', data: { workflowId: 'workflow-b', nodes: [], connections: [] } }
            ],
            activeWorkflowId: 'workflow-a',
            activeWorkflowName: 'A',
            workflowData: { workflowId: 'workflow-a', nodes: [], connections: [] }
        });

        assert.equal(await manager.ensureOpenWorkflow(), true);
        assert.deepEqual(state.workflowTabs.map(({ workflowId }) => workflowId), ['workflow-a', 'workflow-b']);
        assert.deepEqual(manager.workflowDesk.snapshot().open.map(({ workflowId }) => workflowId), ['workflow-a', 'workflow-b']);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('startup removes stale restored Open Workflow records together with their missing documents', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ workflows: ['Default', 'Unsaved'], folders: [] })
    });
    try {
        const state = {
            workflowTabs: [], workflowOrder: [], workflowFolders: [],
            nodes: new Map(), connections: [], selectedNodes: new Set(),
            canvas: { x: 0, y: 0, zoom: 1 }
        };
        const manager = createWorkflowManagerApi({
            state,
            nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }) },
            viewportApi: { updateCanvasTransform() {} },
            addNode() {}, updateAllConnections() {}, updatePortStyles() {}, scheduleSave() {}, showToast() {},
            panelManager: {},
            prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
            documentRef: { getElementById: () => null },
            windowRef: { innerWidth: 0, innerHeight: 0 },
            localStorageRef: { getItem: () => null, setItem() {} }
        });

        await manager.activateRestoredWorkflowState({
            workflowTabs: [
                { workflowId: 'workflow-stale', name: 'Unsaved 1', data: { workflowId: 'workflow-stale', nodes: [], connections: [] } },
                { workflowId: 'workflow-default', name: 'Default', data: { workflowId: 'workflow-default', nodes: [], connections: [] } }
            ],
            activeWorkflowId: 'workflow-default',
            activeWorkflowName: 'Default',
            workflowData: { workflowId: 'workflow-default', nodes: [], connections: [] }
        });

        assert.equal(await manager.ensureOpenWorkflow(), true);
        assert.deepEqual(state.workflowTabs.map(({ name }) => name), ['Default']);
        assert.deepEqual(manager.workflowDesk.snapshot().open.map(({ label }) => label), ['Default']);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('workflow panel refresh failure preserves every committed Open Workflow', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
    try {
        let toggleWorkflowPanel = null;
        let openWorkflowPanel = null;
        const workflowList = {
            dataset: {},
            innerHTML: '',
            classList: { toggle() {} },
            addEventListener() {},
            querySelectorAll: () => []
        };
        const documentRef = {
            getElementById(id) {
                if (id === 'btn-toggle-workflow') {
                    return { addEventListener(type, listener) { if (type === 'click') toggleWorkflowPanel = listener; } };
                }
                if (id === 'workflow-list') return workflowList;
                return null;
            }
        };
        const state = {
            workflowTabs: [], workflowOrder: [], workflowFolders: [],
            nodes: new Map(), connections: [], selectedNodes: new Set(),
            canvas: { x: 0, y: 0, zoom: 1 }
        };
        const manager = createWorkflowManagerApi({
            state,
            nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }) },
            viewportApi: { updateCanvasTransform() {} },
            addNode() {}, updateAllConnections() {}, updatePortStyles() {}, scheduleSave() {}, showToast() {},
            panelManager: { toggle(_name, callback) { openWorkflowPanel = callback; } },
            prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
            documentRef,
            windowRef: { innerWidth: 0, innerHeight: 0, addEventListener() {} },
            localStorageRef: { getItem: () => null, setItem() {} }
        });
        await manager.activateRestoredWorkflowState({
            workflowTabs: [
                { workflowId: 'workflow-a', name: 'A', data: { workflowId: 'workflow-a', nodes: [], connections: [] } },
                { workflowId: 'workflow-b', name: 'B', data: { workflowId: 'workflow-b', nodes: [], connections: [] } }
            ],
            activeWorkflowId: 'workflow-a',
            activeWorkflowName: 'A',
            workflowData: { workflowId: 'workflow-a', nodes: [], connections: [] }
        });

        manager.initWorkflow();
        toggleWorkflowPanel();
        openWorkflowPanel();
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepEqual(manager.workflowDesk.snapshot().open.map(({ label }) => label), ['A', 'B']);
        assert.deepEqual(state.workflowTabs.map(({ name }) => name), ['A', 'B']);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
