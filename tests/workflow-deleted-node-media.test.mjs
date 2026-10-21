import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowManagerApi } from '../js/features/workflow/workflow-manager.js';
import { createDiskStorageApi } from '../js/services/storage-disk.js';
import { startCainflowServer } from './helpers/browser-theme-fixture.mjs';

async function fixture(t, { legacy = false } = {}) {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const node = { id: 'node', type: 'ImageGenerate', ...(legacy
        ? { imageAssetKey: 'old-image' } : { data: { mediaAssetKeys: ['media:image'] } }) };
    const workflow = { workflowId: 'wf', mediaOwnershipRevision: 0, nodes: [node], connections: [] };
    const owners = new Map();
    const events = [];
    const settings = { failCommit: false, failWrite: false, failRelease: false };
    const state = { workflowTabs: [], workflowOrder: [], workflowFolders: [],
        nodes: new Map([['node', node]]), connections: [], selectedNodes: new Set(), canvas: {} };
    const serialize = () => structuredClone([...state.nodes.values()]);
    globalThis.fetch = async (url, options = {}) => {
        if (options.method === 'POST') {
            events.push({ type: 'document', data: JSON.parse(options.body) });
            return { ok: !settings.failWrite, status: settings.failWrite ? 500 : 200,
                json: async () => ({ success: !settings.failWrite, error: 'controlled save failure' }) };
        }
        if (url === '/api/workflows') return { ok: true, json: async () => ({ workflows: ['Work', 'Copy'], folders: [] }) };
        return { ok: true, json: async () => structuredClone(workflow) };
    };
    const identity = (workflowId, type, id) => JSON.stringify([workflowId, type, id]);
    const manager = createWorkflowManagerApi({
        state, nodeSerializer: { buildStatePayload: () => ({ nodes: serialize(), connections: [] }), serializeNodes: serialize },
        viewportApi: { updateCanvasTransform() {} }, addNode() {}, updateAllConnections() {}, updatePortStyles() {},
        scheduleSave() {}, showToast() {}, panelManager: {},
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch' }),
        recordMediaWorkflowRevision: async (...args) => { events.push({ type: 'manifest', args }); return true; },
        listMediaOwnerReferenceLists: async (workflowId) => [...owners.values()].filter((owner) => owner.workflowId === workflowId),
        getMediaOwnerReferenceList: async (...args) => owners.get(identity(...args)) || null,
        replaceMediaOwnerReferenceList: async (request) => {
            events.push({ type: 'formal', request });
            if (settings.failCommit) return { status: 'retryable' };
            owners.set(identity(request.workflowId, request.ownerType, request.ownerId), {
                workflowId: request.workflowId, ownerType: request.ownerType, ownerId: request.ownerId,
                generation: request.expectedGeneration + 1, documentRevision: request.documentRevision,
                tombstoned: request.intent === 'delete', assetKeys: [...request.assetKeys]
            });
            return { status: 'committed' };
        },
        getImageAsset: async () => 'data:image/png;base64,YQ==',
        putMediaAsset: async () => ({ asset_key: 'media:image' }),
        referenceMediaAsset: async (...args) => { events.push({ type: 'legacy', args }); return true; },
        removeMediaReference: async (...args) => { events.push({ type: 'release', args }); return !settings.failRelease; },
        deleteImageAsset: async (...args) => { events.push({ type: 'delete-old', args }); return true; },
        prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
        documentRef: { getElementById: () => null }, windowRef: { innerWidth: 0, innerHeight: 0 },
        localStorageRef: { getItem: () => null, setItem() {} }
    });
    await manager.activateRestoredWorkflowState({
        workflowTabs: [{ workflowId: 'wf', name: 'Work', data: workflow }],
        activeWorkflowId: 'wf', activeWorkflowName: 'Work'
    });
    return { manager, state, events, settings, owners };
}

test('normal save and subsequent node deletion use only formal owners', async (t) => {
    const { manager, state, events, owners } = await fixture(t);
    assert.equal(await manager.saveActiveWorkflow({ silent: true }), true);
    assert.equal(events.some((event) => event.type === 'legacy'), false);
    assert.ok(events.findIndex((event) => event.type === 'formal') < events.findIndex((event) => event.type === 'release'));
    state.nodes.clear();
    assert.equal(await manager.saveActiveWorkflow({ silent: true }), true);
    assert.deepEqual(owners.get('["wf","workflow-node","node"]').assetKeys, []);
    assert.equal(owners.get('["wf","workflow-node","node"]').tombstoned, true);
    assert.equal(events.some((event) => event.type === 'legacy'), false);
});

test('formal save failure retains migration protection until retry succeeds', async (t) => {
    const { manager, events, settings } = await fixture(t, { legacy: true });
    settings.failCommit = true;
    assert.equal(await manager.saveActiveWorkflow({ silent: true }), false);
    assert.equal(events.some((event) => event.type === 'release' || event.type === 'delete-old'), false);
    settings.failCommit = false;
    assert.equal(await manager.saveActiveWorkflow({ silent: true }), true);
    assert.ok(events.some((event) => event.type === 'release' && event.args[0] === 'workflow-migration'));
    assert.equal(events.some((event) => event.type === 'legacy'), false);
});

test('deleting a staged legacy node before saving never recreates its reference', async (t) => {
    const { manager, state, events } = await fixture(t, { legacy: true });
    await manager.loadWorkflowFromFile('Work');
    state.nodes.clear();
    assert.equal(await manager.saveActiveWorkflow({ silent: true }), true);
    assert.equal(events.some((event) => event.type === 'legacy' || event.type === 'formal'), false);
    assert.ok(events.some((event) => event.type === 'release' && event.args[1] === 'migration:wf:node'));
    assert.deepEqual(events.find((event) => event.type === 'document').data.nodes, []);
});

test('failed document save never replaces the previously saved media owner', async (t) => {
    const { manager, state, events, settings, owners } = await fixture(t);
    assert.equal(await manager.saveActiveWorkflow({ silent: true }), true);
    events.length = 0;
    state.nodes.clear();
    settings.failWrite = true;
    assert.equal(await manager.saveActiveWorkflow({ silent: true }), false);
    assert.deepEqual(owners.get('["wf","workflow-node","node"]').assetKeys, ['media:image']);
    assert.equal(events.some((event) => event.type === 'formal' || event.type === 'release'), false);
});

test('internal copies get independent formal owners without redundant aliases or releasing source operations', async (t) => {
    const { manager, state, events, owners } = await fixture(t);
    state.nodes.get('node').data.mediaOwnershipTemporaryOwners = [
        { ownerId: '["wf","node","source-operation"]', assetKeys: ['media:image'] }
    ];
    const copied = await manager.copyWorkflowById('wf', 'Copy');
    assert.ok(copied.workflowId && copied.workflowId !== 'wf');
    assert.deepEqual(owners.get(JSON.stringify([copied.workflowId, 'workflow-node', 'node'])).assetKeys, ['media:image']);
    assert.equal(events.some((event) => event.type === 'legacy'), false);
    assert.equal(events.some((event) => event.type === 'release' && event.args[0] === 'workflow-operation'), false);
    assert.equal(state.nodes.get('node').data.mediaOwnershipTemporaryOwners.length, 1);
});

test('real workflow save, copy, deletion and disk cleanup preserve independent Agent results', async () => {
    const server = await startCainflowServer();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => originalFetch(new URL(url, server.baseUrl), options);
    try {
        // The server listens before its initial integrity scan finishes. Seed
        // only after that scan so it cannot audit a half-built test workflow.
        let safety;
        for (let attempt = 0; attempt < 100; attempt += 1) {
            safety = (await (await fetch('/api/storage/safety-status')).json()).safety;
            if (!safety.backgroundScanPending) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(safety.state, 'healthy');
        assert.equal(safety.backgroundScanPending, false);
        const state = { workflowTabs: [], workflowOrder: [], workflowFolders: [], nodes: new Map(),
            connections: [], selectedNodes: new Set(), canvas: {} };
        const storage = createDiskStorageApi(() => state);
        const disposable = await storage.putMediaAsset('data:image/png;base64,YQ==', 'workflow-node', 'wf:node');
        const retained = await storage.putMediaAsset('data:image/png;base64,Yg==', 'workflow-node', 'wf:node');
        assert.ok(disposable?.asset_key && retained?.asset_key);
        const node = { id: 'node', type: 'ImageGenerate', data: { mediaAssetKeys: [disposable.asset_key, retained.asset_key] } };
        state.nodes.set('node', node);
        const agent = { archivedMessages: [{ runs: [{ runId: 'result', status: 'completed', mediaAssetKeys: [retained.asset_key] }] }] };
        const workflow = { workflowId: 'wf', mediaOwnershipRevision: 0, nodes: [node], connections: [], promptAgent: agent };
        const serialize = () => structuredClone([...state.nodes.values()]);
        const errors = [];
        const manager = createWorkflowManagerApi({
            ...storage, state,
            nodeSerializer: { buildStatePayload: () => ({ nodes: serialize(), connections: [] }), serializeNodes: serialize },
            viewportApi: { updateCanvasTransform() {} }, addNode() {}, updateAllConnections() {}, updatePortStyles() {},
            scheduleSave() {}, showToast: (message, type) => { if (type === 'error') errors.push(message); }, panelManager: {},
            getPromptAgentState: () => structuredClone(agent),
            prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
            documentRef: { getElementById: () => null }, windowRef: { innerWidth: 0, innerHeight: 0 },
            localStorageRef: { getItem: () => null, setItem() {} }
        });
        await manager.activateRestoredWorkflowState({ workflowTabs: [{ workflowId: 'wf', name: 'Work', data: workflow }],
            activeWorkflowId: 'wf', activeWorkflowName: 'Work' });
        assert.equal(await manager.saveActiveWorkflow({ silent: true }), true, errors.join('\n'));
        const copied = await manager.copyWorkflowById('wf', 'Copy');
        assert.ok(copied.workflowId);
        state.nodes.clear();
        assert.equal(await manager.saveActiveWorkflow({ silent: true }), true, errors.join('\n'));
        assert.deepEqual((await storage.getMediaOwnerReferenceList('wf', 'workflow-node', 'node')).assetKeys, []);
        assert.deepEqual((await storage.getMediaOwnerReferenceList(copied.workflowId, 'workflow-node', 'node')).assetKeys,
            [disposable.asset_key, retained.asset_key]);
        assert.equal((await fetch(`/api/storage/assets/${encodeURIComponent(disposable.asset_key)}`)).status, 200);
        const copyTab = state.workflowTabs.find((tab) => tab.workflowId === copied.workflowId);
        copyTab.data.nodes = [];
        await manager.saveAllOpenWorkflows();
        const cleanup = await fetch('/api/storage/maintenance', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'clear-assets', mode: 'node-orphans' }) });
        assert.equal(cleanup.ok, true);
        assert.equal((await cleanup.json()).gcSuspended, false);
        assert.equal((await fetch(`/api/storage/assets/${encodeURIComponent(disposable.asset_key)}`)).status, 404);
        assert.equal(await (await fetch(`/api/storage/assets/${encodeURIComponent(retained.asset_key)}`)).text(), 'b');
        for (const workflowId of ['wf', copied.workflowId]) {
            assert.deepEqual((await storage.getMediaOwnerReferenceList(workflowId, 'prompt-agent-result', 'result')).assetKeys,
                [retained.asset_key]);
        }
        assert.deepEqual(errors, []);
    } finally {
        globalThis.fetch = originalFetch;
        await server.stop();
    }
});
