import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryCanvasImporter } from '../js/features/canvas-mcp/canvas-history-import.js';

const context = { workflowId: 'workflow-a', nodes: [], connections: [], summary: { selectedIds: [] } };
const originals = [
    { id: 41, fileVersion: '4:100', note: '原图标签', filename: 'original.png' },
    { id: -42, fileVersion: '5:101', filename: 'second.png' }
];

function fixture(overrides = {}) {
    const reads = [], stages = [], cancels = [], applied = [];
    const importHistory = createHistoryCanvasImporter({
        canvasAdapter: {
            context: () => context,
            async apply(plan, _model, _onChange, isCurrent, options) {
                assert.ok(isCurrent());
                applied.push({ plan, options });
                const saved = await options.persist();
                if (!saved.committed) throw new Error('save failed');
                return { bindings: Object.fromEntries([...options.stagedImports].map(([stepId, staged]) => [stepId, staged.nodeId])) };
            }
        },
        listHistoryImages: async ({ id }) => ({ items: originals.filter(item => item.id === id) }),
        getHistoryImageBlob: async (id, options) => {
            reads.push([id, options.fileVersion]);
            return new Blob([String(id)], { type: 'image/png' });
        },
        saveWorkflowNodeMediaAsset: async (blob, workflowId, nodeId, operationId, { isCurrent }) => {
            assert.ok(isCurrent());
            const key = 'media:' + await blob.text();
            const asset = { asset_key: key, mediaTemporaryOwnerId: JSON.stringify([workflowId, nodeId, operationId]) };
            stages.push({ blob, workflowId, nodeId, operationId, asset });
            return asset;
        },
        cancelWorkflowNodeMediaOperation: async (...scope) => { cancels.push(scope); return true; },
        persist: async () => ({ committed: true }),
        ...overrides
    });
    return { importHistory, reads, stages, cancels, applied };
}

const items = originals.map(({ id, fileVersion }) => ({ id, fileVersion }));

test('history originals are captured by current identity and imported together with staged ownership', async () => {
    const f = fixture();
    const result = await f.importHistory({ items }, { context });
    assert.equal(result.workflowId, 'workflow-a');
    assert.deepEqual(f.reads, [[41, '4:100'], [-42, '5:101']]);
    assert.deepEqual(result.imported.map(({ id, fileVersion, nodeId }) => [id, fileVersion, nodeId]), [
        [41, '4:100', f.stages[0].nodeId], [-42, '5:101', f.stages[1].nodeId]
    ]);
    assert.equal(f.applied.length, 1);
    assert.deepEqual(f.applied[0].plan.steps.map(({ type, assetKey, execute, title }) => [type, assetKey, execute, title]), [
        ['ImageImport', 'media:41', false, '原图标签'], ['ImageImport', 'media:-42', false, 'second.png']
    ]);
    assert.deepEqual(f.cancels, []);
});

test('rejects unexpected fields and stale versions without reading original bytes', async () => {
    const f = fixture();
    await assert.rejects(f.importHistory({ items: [{ ...items[0], path: 'outside' }] }), /历史图片参数/);
    await assert.rejects(f.importHistory({ items: [{ ...items[0], fileVersion: '2:3' }] }), /已变化/);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.applied, []);
});

test('a lost storage response or failed canvas save cancels each attempted temporary owner', async () => {
    const failure = fixture({ persist: async () => ({ committed: false }) });
    await assert.rejects(failure.importHistory({ items }), /save failed/);
    assert.deepEqual(failure.cancels, failure.stages.map(({ workflowId, nodeId, operationId }) => [workflowId, nodeId, operationId]));

    let started;
    const lost = fixture({ saveWorkflowNodeMediaAsset: async (_blob, workflowId, nodeId, operationId) => {
        started = [workflowId, nodeId, operationId];
        throw new Error('lost response');
    } });
    await assert.rejects(lost.importHistory({ items }), /保存历史原图失败/);
    assert.deepEqual(lost.cancels, [started]);
    assert.deepEqual(lost.applied, []);
});

test('revocation after loading drops the import, while a durable ownership recovery keeps staging', async () => {
    let current = true;
    const stopped = fixture({ getHistoryImageBlob: async () => {
        current = false;
        return new Blob(['bytes'], { type: 'image/png' });
    } });
    await assert.rejects(stopped.importHistory({ items }, { isCurrent: () => current }), /范围已变化/);
    assert.deepEqual(stopped.stages, []);

    const pending = fixture({ persist: async () => ({ committed: true, ownershipPending: true }) });
    const result = await pending.importHistory({ items });
    assert.equal(result.ownershipPending, true);
    assert.deepEqual(pending.cancels, []);
});

test('an unreadable workflow write result keeps the protected original and asks to check the workflow', async () => {
    const f = fixture({ persist: async () => ({ committed: false, publicationUnknown: true }) });
    await assert.rejects(f.importHistory({ items }), /无法确认.*请/);
    assert.deepEqual(f.cancels, []);
});
