import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowManagerApi } from '../js/features/workflow/workflow-manager.js';

test('strict canvas persistence refuses conflict rebase and reconciles an uncertain publication', async t => {
    const staged = { id: 'imported', type: 'ImageImport', mediaAssetKeys: ['media:original'], data: {
        mediaOwnershipTemporaryOwners: [{ ownerId: '["workflow-a","imported","pending"]', assetKeys: ['media:original'] }]
    } };
    const restored = { workflowId: 'workflow-a', mediaOwnershipRevision: 1, nodes: [], connections: [] };
    for (const scenario of ['conflict', 'published', 'retained-mcp-marker', 'new-mcp-write', 'unknown']) {
        let disk = restored, readbacks = 0, writes = 0, committed = 0;
        const fetchMock = t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
            if (url === '/api/workflows') return Response.json({ workflows: ['History'], folders: [] });
            assert.equal(url, '/api/workflows/History');
            if (options.method === 'POST') {
                writes++;
                const document = JSON.parse(options.body);
                if (scenario === 'conflict') {
                    return Response.json({ error: 'Conflict', detail: 'Workflow media ownership revision conflict' }, { status: 409 });
                }
                if (scenario === 'published') disk = document;
                if (scenario === 'retained-mcp-marker') disk = { ...document, canvasMcpWriteRevision: 1 };
                if (scenario === 'new-mcp-write') disk = { ...document, canvasMcpWriteRevision: 2 };
                throw new TypeError('controlled lost response');
            }
            if (options.cache === 'no-store') readbacks++;
            if (scenario === 'unknown') throw new TypeError('controlled readback unavailable');
            return Response.json(disk);
        });
        try {
            const state = { workflowTabs: [], workflowOrder: [], workflowFolders: [], nodes: new Map(),
                connections: [], selectedNodes: new Set(), canvas: { x: 0, y: 0, zoom: 1 } };
            const manager = createWorkflowManagerApi({
                state, nodeSerializer: { buildStatePayload: () => ({ nodes: [...state.nodes.values()], connections: [] }),
                    serializeNodes: () => [...state.nodes.values()] },
                viewportApi: { updateCanvasTransform() {} }, addNode() {}, updateAllConnections() {}, updatePortStyles() {},
                scheduleSave() {}, showToast() {}, panelManager: {}, prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
                getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch' }),
                recordMediaWorkflowRevision: async () => { committed++; return true; },
                getMediaOwnerReferenceList: async () => null,
                replaceMediaOwnerReferenceList: async () => ({ status: 'committed' }),
                removeMediaReference: async () => true,
                documentRef: { getElementById: () => null }, windowRef: { innerWidth: 0, innerHeight: 0 },
                localStorageRef: { getItem: () => null, setItem() {} }
            });
            await manager.activateRestoredWorkflowState({
                workflowTabs: [{ workflowId: 'workflow-a', name: 'History', data: structuredClone(restored) }],
                activeWorkflowId: 'workflow-a', activeWorkflowName: 'History', workflowData: structuredClone(restored)
            });
            state.nodes.set(staged.id, structuredClone(staged));
            const result = await manager.persistActiveHistoryTransition({ strictRevision: true });
            assert.equal(writes, 1, scenario);
            assert.equal(readbacks, scenario === 'conflict' ? 0 : 1, scenario);
            const published = scenario === 'published' || scenario === 'retained-mcp-marker';
            assert.equal(result.committed, published, scenario);
            assert.equal(Boolean(result.publicationUnknown), scenario === 'unknown' || scenario === 'new-mcp-write', scenario);
            assert.equal(committed, published ? 1 : 0, scenario);
            assert.equal(manager.hasPendingAutosave(), false, scenario);
        } finally {
            fetchMock.mock.restore();
        }
    }
});

test('runtime result projection keeps the current revision for strict canvas saves', async t => {
    const workflowId = 'runtime-workflow';
    const image = { id: 'image', type: 'ImageGenerate', x: 30, y: 60, prompt: 'existing prompt' };
    const restored = { workflowId, mediaOwnershipRevision: 7, nodes: [image], connections: [] };
    let disk = structuredClone(restored), readbacks = 0;
    const writes = [];
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
        if (url === '/api/workflows') return Response.json({ workflows: ['Runtime'], folders: [] });
        assert.equal(url, '/api/workflows/Runtime');
        if (options.method !== 'POST') {
            readbacks++;
            return Response.json(disk);
        }
        const document = JSON.parse(options.body);
        const expected = options.headers['X-CainFlow-Expected-Media-Ownership-Revision'];
        const strict = options.headers['X-CainFlow-Strict-Workflow-Revision'];
        writes.push({ expected, strict, revision: document.mediaOwnershipRevision });
        if (expected !== String(disk.mediaOwnershipRevision)) {
            return Response.json({ detail: 'Workflow media ownership revision conflict' }, { status: 409 });
        }
        disk = document;
        return Response.json({ mediaOwnershipRevision: disk.mediaOwnershipRevision });
    });

    const state = { workflowTabs: [], workflowOrder: [], workflowFolders: [], nodes: new Map(),
        connections: [], selectedNodes: new Set(), canvas: { x: 0, y: 0, zoom: 1 } };
    const manager = createWorkflowManagerApi({
        state, nodeSerializer: { buildStatePayload: () => ({ nodes: [...state.nodes.values()], connections: [] }),
            serializeNodes: () => [...state.nodes.values()] },
        viewportApi: { updateCanvasTransform() {} }, addNode() {}, updateAllConnections() {}, updatePortStyles() {},
        scheduleSave() {}, showToast() {}, panelManager: {}, prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
        getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch' }),
        recordMediaWorkflowRevision: async () => true,
        getMediaOwnerReferenceList: async () => null,
        replaceMediaOwnerReferenceList: async () => ({ status: 'committed' }),
        documentRef: { getElementById: () => null }, windowRef: { innerWidth: 0, innerHeight: 0 },
        localStorageRef: { getItem: () => null, setItem() {} }
    });
    await manager.activateRestoredWorkflowState({
        workflowTabs: [{ workflowId, name: 'Runtime', data: structuredClone(restored) }],
        activeWorkflowId: workflowId, activeWorkflowName: 'Runtime', workflowData: structuredClone(restored)
    });
    const initialReadbacks = readbacks;
    state.nodes.set(image.id, image);
    const resultNode = { ...image, lastDuration: 100 };
    assert.equal(manager.updateWorkflowTabDataById(workflowId, { workflowId, nodes: [resultNode], connections: [] },
        { mergeRunResults: true, mergeWithCanvas: true }), true);
    assert.equal(manager.getWorkflowTabSnapshot('Runtime').nodes[0].lastDuration, 100);
    state.nodes.set(image.id, { ...resultNode, prompt: 'first edit' });

    const firstSave = manager.persistActiveHistoryTransition({ strictRevision: true });
    // Session capture can replace the active snapshot before the write finishes.
    manager.snapshotActiveWorkflow();
    assert.equal((await firstSave).committed, true);
    assert.equal(disk.nodes[0].prompt, 'first edit');
    assert.equal(manager.getWorkflowTabSnapshot('Runtime').mediaOwnershipRevision, 8);

    state.nodes.set(image.id, { ...resultNode, prompt: 'second edit' });
    assert.equal((await manager.persistActiveHistoryTransition({ strictRevision: true })).committed, true);
    assert.equal(disk.nodes[0].prompt, 'second edit');
    assert.deepEqual(writes, [
        { expected: '7', strict: 'true', revision: 8 },
        { expected: '8', strict: 'true', revision: 9 }
    ]);
    assert.equal(readbacks, initialReadbacks, 'strict edits commit without looking up and rebasing onto a new revision');
});

test('retouch original metadata can be cleaned on save and reopen without dropping its output', async () => {
    const originalFetch = globalThis.fetch;
    try {
        for (const scenario of ['missing', 'lookup-error', 'newly-regenerated', 'same-image']) {
            const originalAssetKey = scenario === 'same-image' ? 'media:result' : 'media:source';
            const pair = { originalAssetKey, resultAssetKey: 'media:result' };
            const live = { id: 'retouch', type: 'ProductRetouch', data: { mediaAssetKeys: ['media:result'], productRetouchComparison: pair } };
            const snapshots = () => [{ id: live.id, type: live.type, mediaAssetKeys: ['media:result'],
                imageAssetKey: 'media:result', imageCount: 1, productRetouchComparison: live.data.productRetouchComparison }];
            const writes = [], lookups = [], owners = [], changes = [], notices = [];
            let disk = { workflowId: 'workflow-a', mediaOwnershipRevision: 1, nodes: snapshots(), connections: [] };
            globalThis.fetch = async (url, options = {}) => {
                if (url === '/api/workflows/Retouch' && options.method === 'POST') {
                    const body = JSON.parse(options.body);
                    writes.push(body);
                    if (writes.length === 1) return { ok: false, status: 409,
                        json: async () => ({ detail: 'Workflow media ownership revision conflict' }) };
                    disk = body;
                    if (scenario === 'newly-regenerated') live.data.productRetouchComparison = { ...pair };
                    return { ok: true, status: 200, json: async () => ({ mediaOwnershipRevision: body.mediaOwnershipRevision }) };
                }
                if (url === '/api/workflows/Retouch') return { ok: true, status: 200, json: async () => structuredClone(disk) };
                if (url === '/api/workflows') return { ok: true, status: 200, json: async () => ({ workflows: ['Retouch'], folders: [] }) };
                throw new Error(`Unexpected request: ${url}`);
            };
            const state = { workflowTabs: [], workflowOrder: [], workflowFolders: [], nodes: new Map([[live.id, live]]),
                connections: [], selectedNodes: new Set(), canvas: { x: 0, y: 0, zoom: 1 } };
            const manager = createWorkflowManagerApi({
                state, nodeSerializer: { buildStatePayload: () => ({ nodes: snapshots(), connections: [] }), serializeNodes: snapshots },
                viewportApi: { updateCanvasTransform() {} }, addNode() {}, updateAllConnections() {}, updatePortStyles() {},
                scheduleSave() {}, showToast: message => notices.push(message), panelManager: {},
                getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch' }),
                mediaAssetExists: async key => {
                    lookups.push(key);
                    if (scenario === 'lookup-error') throw new Error('Temporary lookup failure');
                    return false;
                },
                recordMediaWorkflowRevision: async (_id, _revision, _epoch, nodes) => (owners.push(nodes), true),
                replaceMediaOwnerReferenceList: async () => ({ status: 'committed' }),
                removeMediaReference: async () => true,
                onRetouchComparisonRemoved: nodeId => changes.push(nodeId),
                prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
                documentRef: { getElementById: () => null }, windowRef: { innerWidth: 0, innerHeight: 0 },
                localStorageRef: { getItem: () => null, setItem() {} }
            });
            const restored = { ...disk, mediaOwnershipRevision: 0 };
            await manager.activateRestoredWorkflowState({ workflowTabs: [{ workflowId: disk.workflowId, name: 'Retouch', data: restored }],
                activeWorkflowId: disk.workflowId, activeWorkflowName: 'Retouch', workflowData: restored });
            assert.equal(await manager.saveActiveWorkflow({ silent: true }), true, `${scenario}: ${notices.join(' | ')}`);
            assert.equal(writes.length, 2);
            const retainsComparison = scenario === 'lookup-error' || scenario === 'same-image';
            assert.deepEqual(lookups, scenario === 'same-image' ? [] : [originalAssetKey]);
            for (const write of writes) {
                assert.deepEqual(write.nodes[0].mediaAssetKeys, ['media:result']);
                assert.deepEqual(write.nodes[0].productRetouchComparison, retainsComparison ? pair : undefined);
            }
            assert.deepEqual(owners.at(-1)[0].assetKeys, retainsComparison ? ['media:result', originalAssetKey] : ['media:result']);
            assert.deepEqual(changes, scenario === 'missing' ? [live.id] : []);
            assert.deepEqual(live.data.productRetouchComparison, scenario === 'missing' ? undefined : pair);
            const reopened = await manager.loadWorkflowFromFile('Retouch');
            assert.deepEqual(reopened.nodes[0].productRetouchComparison, retainsComparison ? pair : undefined);
            assert.deepEqual(reopened.nodes[0].mediaAssetKeys, ['media:result']);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

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

async function assertSaveConflictPreservesDraft(persisted, message) {
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
                json: async () => ({ ...persisted, nodes: [], connections: [] })
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
        assert.equal(toasts.length, 1, 'silent autosave reports one actionable failure');
        assert.deepEqual(toasts.at(-1), {
            message: `工作流「Unsaved」自动保存失败，修改已保留：${message}`,
            type: 'error'
        });
        assert.equal(manager.getActiveWorkflowSnapshot().mediaOwnershipRevision, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

test('saving refuses to overwrite a same-name Workflow with a different identity', async () => {
    await assertSaveConflictPreservesDraft({ workflowId: 'workflow-on-disk', mediaOwnershipRevision: 28 },
        '同名工作流已属于另一工作流，请使用“另存为”保存当前工作流');
});

test('saving keeps the draft if Canvas MCP writes between a revision conflict and its readback', async () => {
    await assertSaveConflictPreservesDraft({ workflowId: 'workflow-in-editor', mediaOwnershipRevision: 2, canvasMcpWriteRevision: 2 },
        'Canvas MCP 已修改此工作流，请重新载入已保存的版本，或使用“另存为”保留当前修改');
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
