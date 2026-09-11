import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowManagerApi } from '../js/features/workflow/workflow-manager.js';

test('saving retries once with the current disk media ownership revision after a revision conflict', async () => {
    const originalFetch = globalThis.fetch;
    const saves = [];
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/workflows/Unsaved' && options.method === 'POST') {
            saves.push({ headers: options.headers, body: JSON.parse(options.body) });
            if (saves.length === 1) {
                return {
                    ok: false,
                    status: 409,
                    json: async () => ({
                        error: 'Workflow changed in another application instance',
                        detail: 'Workflow media ownership revision conflict'
                    })
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ mediaOwnershipRevision: saves.at(-1).body.mediaOwnershipRevision })
            };
        }
        if (url === '/api/workflows/Unsaved') {
            return {
                ok: true,
                status: 200,
                json: async () => ({ workflowId: 'workflow-a', mediaOwnershipRevision: 1, nodes: [], connections: [] })
            };
        }
        if (url === '/api/workflows') {
            return { ok: true, status: 200, json: async () => ({ workflows: ['Unsaved'], folders: [] }) };
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    try {
        const state = {
            workflowTabs: [], workflowOrder: [], workflowFolders: [],
            nodes: new Map(), connections: [], selectedNodes: new Set(),
            canvas: { x: 0, y: 0, zoom: 1 }
        };
        const manager = createWorkflowManagerApi({
            state,
            nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }), serializeNodes: () => [] },
            viewportApi: { updateCanvasTransform() {} },
            addNode() {}, updateAllConnections() {}, updatePortStyles() {}, scheduleSave() {}, showToast() {},
            panelManager: {},
            getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
            recordMediaWorkflowRevision: async () => true,
            getMediaOwnerReferenceList: async () => null,
            replaceMediaOwnerReferenceList: async () => ({ status: 'committed' }),
            prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
            documentRef: { getElementById: () => null },
            windowRef: { innerWidth: 0, innerHeight: 0 },
            localStorageRef: { getItem: () => null, setItem() {} }
        });
        await manager.activateRestoredWorkflowState({
            workflowTabs: [{
                workflowId: 'workflow-a', name: 'Unsaved',
                data: { workflowId: 'workflow-a', mediaOwnershipRevision: 0, nodes: [], connections: [] }
            }],
            activeWorkflowId: 'workflow-a', activeWorkflowName: 'Unsaved',
            workflowData: { workflowId: 'workflow-a', mediaOwnershipRevision: 0, nodes: [], connections: [] }
        });

        assert.equal(await manager.saveActiveWorkflow({ silent: true }), true);
        assert.equal(saves.length, 2);
        assert.equal(saves[0].headers['X-CainFlow-Expected-Media-Ownership-Revision'], '0');
        assert.equal(saves[1].headers['X-CainFlow-Expected-Media-Ownership-Revision'], '1');
        assert.equal(saves[1].body.mediaOwnershipRevision, 2);
        assert.equal(manager.getActiveWorkflowSnapshot().mediaOwnershipRevision, 2);

        assert.equal(await manager.saveActiveWorkflow({ silent: true }), true);
        assert.equal(saves.length, 3);
        assert.equal(saves[2].headers['X-CainFlow-Expected-Media-Ownership-Revision'], '2');
        assert.equal(saves[2].body.mediaOwnershipRevision, 3);
        assert.equal(manager.getActiveWorkflowSnapshot().mediaOwnershipRevision, 3);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('saving refuses to overwrite a same-name Workflow with a different identity', async () => {
    const originalFetch = globalThis.fetch;
    const saves = [];
    const toasts = [];
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/workflows/Unsaved' && options.method === 'POST') {
            saves.push(JSON.parse(options.body));
            return {
                ok: false,
                status: 409,
                json: async () => ({
                    error: 'Workflow changed in another application instance',
                    detail: 'Workflow media ownership revision conflict'
                })
            };
        }
        if (url === '/api/workflows/Unsaved') {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    workflowId: 'workflow-on-disk',
                    mediaOwnershipRevision: 28,
                    nodes: [],
                    connections: []
                })
            };
        }
        if (url === '/api/workflows') {
            return { ok: true, status: 200, json: async () => ({ workflows: ['Unsaved'], folders: [] }) };
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    try {
        const state = {
            workflowTabs: [], workflowOrder: [], workflowFolders: [],
            nodes: new Map(), connections: [], selectedNodes: new Set(),
            canvas: { x: 0, y: 0, zoom: 1 }
        };
        const manager = createWorkflowManagerApi({
            state,
            nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }), serializeNodes: () => [] },
            viewportApi: { updateCanvasTransform() {} },
            addNode() {}, updateAllConnections() {}, updatePortStyles() {}, scheduleSave() {},
            showToast(message, type) { toasts.push({ message, type }); },
            panelManager: {},
            getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
            recordMediaWorkflowRevision: async () => true,
            getMediaOwnerReferenceList: async () => null,
            replaceMediaOwnerReferenceList: async () => ({ status: 'committed' }),
            prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
            documentRef: { getElementById: () => null },
            windowRef: { innerWidth: 0, innerHeight: 0 },
            localStorageRef: { getItem: () => null, setItem() {} }
        });
        await manager.activateRestoredWorkflowState({
            workflowTabs: [{
                workflowId: 'workflow-in-editor', name: 'Unsaved',
                data: { workflowId: 'workflow-in-editor', mediaOwnershipRevision: 0, nodes: [], connections: [] }
            }],
            activeWorkflowId: 'workflow-in-editor', activeWorkflowName: 'Unsaved',
            workflowData: { workflowId: 'workflow-in-editor', mediaOwnershipRevision: 0, nodes: [], connections: [] }
        });

        assert.equal(await manager.saveActiveWorkflow({ silent: true }), false);
        assert.equal(saves.length, 1);
        assert.deepEqual(toasts.at(-1), {
            message: '同名工作流已属于另一工作流，请使用“另存为”保存当前工作流',
            type: 'error'
        });
        assert.equal(manager.getActiveWorkflowSnapshot().mediaOwnershipRevision, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('saving a new Workflow with an ImageGenerate node that omits optional data succeeds', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/workflows/New%20Workflow' && options.method === 'POST') {
            return { ok: true, status: 200, json: async () => ({ success: true }) };
        }
        if (url === '/api/workflows') {
            return { ok: true, status: 200, json: async () => ({ workflows: ['New Workflow'], folders: [] }) };
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    try {
        const node = { id: 'image-1', type: 'ImageGenerate' };
        const state = {
            workflowTabs: [], workflowOrder: [], workflowFolders: [],
            nodes: new Map([['image-1', node]]), connections: [], selectedNodes: new Set(),
            canvas: { x: 0, y: 0, zoom: 1 }
        };
        const manager = createWorkflowManagerApi({
            state,
            nodeSerializer: {
                buildStatePayload: () => ({ nodes: [node], connections: [] }),
                serializeNodes: () => [node]
            },
            viewportApi: { updateCanvasTransform() {} },
            addNode() {}, updateAllConnections() {}, updatePortStyles() {}, scheduleSave() {}, showToast() {},
            panelManager: {},
            getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch-1' }),
            listMediaOwnerReferenceLists: async () => [],
            recordMediaWorkflowRevision: async () => true,
            getMediaOwnerReferenceList: async () => null,
            replaceMediaOwnerReferenceList: async () => ({ status: 'committed' }),
            prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
            documentRef: { getElementById: () => null },
            windowRef: { innerWidth: 0, innerHeight: 0 },
            localStorageRef: { getItem: () => null, setItem() {} }
        });
        await manager.activateRestoredWorkflowState({
            workflowTabs: [{
                workflowId: 'workflow-new', name: 'New Workflow',
                data: { workflowId: 'workflow-new', mediaOwnershipRevision: 0, nodes: [node], connections: [] }
            }],
            activeWorkflowId: 'workflow-new', activeWorkflowName: 'New Workflow',
            workflowData: { workflowId: 'workflow-new', mediaOwnershipRevision: 0, nodes: [node], connections: [] }
        });

        assert.equal(await manager.saveActiveWorkflow({ silent: true }), true);
        assert.equal(manager.getActiveWorkflowSnapshot().mediaOwnershipRevision, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
