import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegacyMediaMigrationCoordinator } from '../js/features/media/legacy-media-migration.js';
import { createWorkflowManagerApi } from '../js/features/workflow/workflow-manager.js';

test('staged legacy migration keeps old asset until document persistence commits', async () => {
    const calls = []; let serial = 0;
    const coordinator = createLegacyMediaMigrationCoordinator({
        getImageAsset: async (key) => key === 'old-key' ? 'data:image/png;base64,b2xk' : '',
        putMediaAsset: async (_value, type, owner) => ({ asset_key: `media:${++serial}`, type, owner }),
        referenceMediaAsset: async (...args) => (calls.push(['reference', ...args]), true),
        removeMediaReference: async (...args) => (calls.push(['remove', ...args]), true),
        deleteImageAsset: async (key) => (calls.push(['delete', key]), true)
    });
    const workflow = { workflowId: 'wf', nodes: [{ id: 'n', type: 'ImagePreview', data: { imageAssetKey: 'old-key' } }] };
    const stage = await coordinator.stageWorkflow(workflow);
    assert.deepEqual(workflow.nodes[0].data.mediaAssetKeys, ['media:1']);
    assert.equal(calls.some((call) => call[0] === 'delete'), false);
    await stage.commit();
    assert.deepEqual(calls.at(-1), ['delete', 'old-key']);
});

test('failed document persistence rolls back fields and temporary references', async () => {
    const calls = [];
    const coordinator = createLegacyMediaMigrationCoordinator({
        getImageAsset: async () => 'data:image/png;base64,b2xk',
        putMediaAsset: async () => ({ asset_key: 'media:1' }),
        removeMediaReference: async (...args) => (calls.push(args), true)
    });
    const node = { id: 'n', type: 'ImageImport', data: { imageImportAssetKey: 'old-key' }, imageImportAssetKey: 'old-key' };
    const stage = await coordinator.stageWorkflow({ workflowId: 'wf', nodes: [node] });
    await stage.rollback();
    assert.equal(node.data.imageImportAssetKey, 'old-key');
    assert.equal(node.data.mediaAssetKeys, undefined);
    assert.equal(calls.length, 1);
});

test('legacy image lists retain their ordering and repeated images', async () => {
    let serial = 0;
    const coordinator = createLegacyMediaMigrationCoordinator({
        getImageAssetList: async () => ['data:image/png;base64,YQ==', 'data:image/png;base64,YQ=='],
        putMediaAsset: async () => ({ asset_key: `media:${++serial}` })
    });
    const node = { id: 'n', type: 'ImagePreview', data: { imageAssetKey: 'old-list' } };
    const stage = await coordinator.stageWorkflow({ workflowId: 'wf', nodes: [node] });
    assert.deepEqual(node.data.mediaAssetKeys, ['media:1', 'media:2']);
    await stage.rollback();
});

test('serialized workflow nodes migrate their top-level legacy key', async () => {
    const coordinator = createLegacyMediaMigrationCoordinator({
        getImageAsset: async () => 'data:image/png;base64,YQ==',
        putMediaAsset: async () => ({ asset_key: 'media:1' })
    });
    const node = { id: 'n', type: 'ImagePreview', imageAssetKey: 'old-key' };
    const stage = await coordinator.stageWorkflow({ workflowId: 'wf', nodes: [node] });
    assert.deepEqual(node.mediaAssetKeys, ['media:1']);
    await stage.rollback();
    assert.equal(node.mediaAssetKeys, undefined);
});

test('loading a legacy workflow stages its Media asset before a later save', async () => {
    const originalFetch = globalThis.fetch;
    let staged = 0;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ workflowId: 'wf', nodes: [{ id: 'n', type: 'ImagePreview', imageAssetKey: 'old-key' }], connections: [] }) });
    try {
        const manager = createWorkflowManagerApi({
            state: { workflowTabs: [], nodes: new Map(), connections: [], selectedNodes: new Set(), canvas: {} },
            nodeSerializer: {}, viewportApi: { updateCanvasTransform() {} }, addNode() {}, updateAllConnections() {}, updatePortStyles() {},
            scheduleSave() {}, showToast() {}, panelManager: {}, documentRef: { getElementById: () => null }, windowRef: { innerWidth: 0, innerHeight: 0 }, localStorageRef: {},
            getImageAsset: async () => 'data:image/png;base64,YQ==',
            putMediaAsset: async () => (staged++, { asset_key: 'media:1' })
        });
        const workflow = await manager.loadWorkflowFromFile('legacy');
        assert.equal(staged, 1);
        assert.deepEqual(workflow.nodes[0].mediaAssetKeys, ['media:1']);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('formal owner failure retains stable temporary reference for retry after persistence', async () => {
    const calls = [];
    const coordinator = createLegacyMediaMigrationCoordinator({
        getImageAsset: async () => 'data:image/png;base64,YQ==',
        putMediaAsset: async () => ({ asset_key: 'media:1' }),
        referenceMediaAsset: async () => false,
        removeMediaReference: async (...args) => (calls.push(args), true)
    });
    const workflow = { workflowId: 'wf', nodes: [{ id: 'n', type: 'ImagePreview', imageAssetKey: 'old-key' }] };
    const stage = await coordinator.stageWorkflow(workflow);
    await assert.rejects(stage.commit(), /promote/);
    assert.equal(calls.length, 0, 'temporary reference remains while the durable document awaits retry');

    const retry = createLegacyMediaMigrationCoordinator({
        referenceMediaAsset: async () => true,
        removeMediaReference: async (...args) => (calls.push(args), true)
    });
    const retryStage = await retry.stageWorkflow(workflow);
    await retryStage.commit();
    assert.deepEqual(calls[0], ['workflow-migration', 'migration:wf:n', 'media:1']);
});

test('a later node staging failure rolls back earlier temporary assets', async () => {
    const removed = [];
    let writes = 0;
    const coordinator = createLegacyMediaMigrationCoordinator({
        getImageAsset: async () => 'data:image/png;base64,YQ==',
        putMediaAsset: async () => (++writes === 1 ? { asset_key: 'media:1' } : null),
        removeMediaReference: async (...args) => (removed.push(args), true)
    });
    const first = { id: 'one', type: 'ImagePreview', imageAssetKey: 'good' };
    const second = { id: 'two', type: 'ImagePreview', imageAssetKey: 'bad' };
    await assert.rejects(coordinator.stageWorkflow({ workflowId: 'wf', nodes: [first, second] }));
    assert.equal(first.mediaAssetKeys, undefined);
    assert.deepEqual(removed, [['workflow-migration', 'migration:wf:one', 'media:1']]);
});
