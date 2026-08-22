import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionProjection } from '../js/canvas/connection-projection.js';

function createHarness({
    mismatches = [],
    beginConnectionRestoration,
    updateDirtyConnections
} = {}) {
    const frames = [];
    const calls = [];
    const api = createConnectionProjection({
        updateAllConnections() { calls.push(['all']); },
        beginConnectionRestoration,
        updateDirtyConnections: updateDirtyConnections || (() => { calls.push(['dirty']); return true; }),
        invalidateNodePortCache(id) { calls.push(['geometry', id]); },
        markNodeConnectionsDirty(id) { calls.push(['appearance', id]); },
        markConnectionDirty(id) { calls.push(['connection', id]); },
        detectMisalignedConnections() { calls.push(['detect']); return mismatches; },
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });
    return { api, calls, flushFrame() { frames.shift()?.(0); } };
}

test('ConnectionProjection owns the cadence of restored connection batches', async () => {
    const renderedBatchSizes = [];
    let restorationFinished = false;
    const { api, flushFrame } = createHarness({
        beginConnectionRestoration: () => ({
            renderNextBatch(batchSize) {
                renderedBatchSizes.push(batchSize);
                return renderedBatchSizes.length === 3;
            },
            finish() {
                restorationFinished = true;
            }
        })
    });

    let settled = false;
    const restoring = api.maintenance.workflowRestored().then(() => { settled = true; });
    await Promise.resolve();

    assert.deepEqual(renderedBatchSizes, [100]);
    assert.equal(settled, false);

    flushFrame();
    await Promise.resolve();
    assert.deepEqual(renderedBatchSizes, [100, 100]);

    flushFrame();
    await restoring;
    assert.deepEqual(renderedBatchSizes, [100, 100, 100]);
    assert.equal(restorationFinished, true);
});

test('workflow restoration remains pending until the restored projection is complete', async () => {
    let renderedBatches = 0;
    const { api, flushFrame } = createHarness({
        beginConnectionRestoration: () => ({
            renderNextBatch() { return ++renderedBatches === 2; },
            finish() {}
        })
    });

    let settled = false;
    const restoring = api.maintenance.workflowRestored().then(() => { settled = true; });
    await Promise.resolve();

    assert.equal(renderedBatches, 1);
    assert.equal(settled, false);

    flushFrame();
    await restoring;
    assert.equal(settled, true);
});

test('workflow restoration commits intents received during restoration after it completes', async () => {
    let renderedBatches = 0;
    const { api, calls, flushFrame } = createHarness({
        beginConnectionRestoration: () => ({
            renderNextBatch() { return ++renderedBatches === 2; },
            finish() {}
        })
    });

    const restoring = api.maintenance.workflowRestored();
    api.interactions.nodeGeometryChanged('node-1');
    flushFrame();

    assert.equal(calls.some(([kind]) => kind === 'dirty'), false);

    flushFrame();
    await restoring;
    assert.equal(calls.filter(([kind]) => kind === 'dirty').length, 1);
});

test('overlapping workflow restoration calls share one projection transaction', async () => {
    let restorationStarts = 0;
    let renderedBatches = 0;
    const { api, flushFrame } = createHarness({
        beginConnectionRestoration: () => {
            restorationStarts += 1;
            return {
                renderNextBatch() { return ++renderedBatches === 2; },
                finish() {}
            };
        }
    });

    const first = api.maintenance.workflowRestored();
    const second = api.maintenance.workflowRestored();

    assert.equal(restorationStarts, 1);

    flushFrame();
    await Promise.all([first, second]);
});

test('workflow restoration can retry after its deferred projection commit fails', async () => {
    let restorationStarts = 0;
    let failCommit = true;
    const { api, flushFrame } = createHarness({
        beginConnectionRestoration: () => {
            restorationStarts += 1;
            let renderedBatches = 0;
            return {
                renderNextBatch() {
                    renderedBatches += 1;
                    return restorationStarts > 1 || renderedBatches === 2;
                },
                finish() {}
            };
        },
        updateDirtyConnections: () => {
            if (failCommit) throw new Error('projection commit failed');
            return true;
        }
    });

    const first = api.maintenance.workflowRestored();
    api.interactions.nodeAppearanceChanged('node-1');
    flushFrame();
    await assert.rejects(first, /projection commit failed/);

    failCommit = false;
    await api.maintenance.workflowRestored();

    assert.equal(restorationStarts, 2);
});

test('coalesces node geometry changes into one dirty projection commit', () => {
    const { api, calls, flushFrame } = createHarness();
    api.interactions.nodeGeometryChanged('node-1');
    api.interactions.nodeGeometryChanged('node-2');
    flushFrame();
    assert.equal(calls.filter(([kind]) => kind === 'dirty').length, 1);
    assert.equal(calls.filter(([kind]) => kind === 'all').length, 0);
});

test('appearance changes do not invalidate port geometry', () => {
    const { api, calls, flushFrame } = createHarness();
    api.interactions.nodeAppearanceChanged(['node-1']);
    flushFrame();
    assert.deepEqual(calls.filter(([kind]) => kind === 'appearance'), [['appearance', 'node-1']]);
    assert.equal(calls.some(([kind]) => kind === 'geometry'), false);
});

test('empty dedicated intents never escalate to a whole projection refresh', () => {
    const { api, calls, flushFrame } = createHarness();

    api.interactions.nodeAppearanceChanged([]);
    api.interactions.nodeGeometryChanged('');
    flushFrame();

    assert.equal(calls.some(([kind]) => kind === 'all' || kind === 'dirty'), false);
});

test('workflow replacement is the maintenance path to a whole projection', () => {
    const { api, calls, flushFrame } = createHarness();
    api.maintenance.workflowReplaced();
    flushFrame();
    assert.deepEqual(calls.filter(([kind]) => kind === 'all'), [['all']]);
});

test('workflow replacement supersedes an older pending projection frame', () => {
    const { api, calls, flushFrame } = createHarness();
    api.interactions.nodeGeometryChanged('node-1');
    api.maintenance.workflowReplaced();

    flushFrame();

    assert.deepEqual(calls.filter(([kind]) => kind === 'all'), [['all']]);
    assert.equal(calls.filter(([kind]) => kind === 'dirty').length, 0);
});

test('finishing an interaction corrects only detected mismatches', async () => {
    const { api, calls, flushFrame } = createHarness({ mismatches: [{ connectionId: 'c-1' }] });
    const interaction = api.interactions.beginInteraction('node-drag', ['node-1']);
    interaction.changed();
    const resultPromise = interaction.finish();
    flushFrame();
    flushFrame();
    const result = await resultPromise;
    assert.equal(result.corrected, 1);
    assert.ok(calls.some(([kind, id]) => kind === 'connection' && id === 'c-1'));
    assert.equal(calls.filter(([kind]) => kind === 'all').length, 0);
});

test('connection drawing settles only the endpoint geometry reported by the lease', async () => {
    const { api, calls, flushFrame } = createHarness();
    const interaction = api.interactions.beginInteraction('connection-draw', ['node-1']);
    interaction.changed({ nodeIds: ['node-2'] });
    const resultPromise = interaction.finish();
    flushFrame();
    flushFrame();
    const result = await resultPromise;

    assert.equal(result.inspected, 2);
    assert.deepEqual(calls.filter(([kind]) => kind === 'geometry'), [
        ['geometry', 'node-1'],
        ['geometry', 'node-2'],
        ['geometry', 'node-1'],
        ['geometry', 'node-2']
    ]);
    assert.equal(calls.some(([kind, nodeId]) => kind === 'geometry' && nodeId === undefined), false);
    assert.equal(calls.filter(([kind]) => kind === 'all').length, 0);
});

test('untargeted legacy refresh preserves the previous whole-projection behavior', () => {
    const { api, calls, flushFrame } = createHarness();

    api.scheduleLegacyRefresh({ reason: 'canvas-ui-frame' });
    flushFrame();

    assert.deepEqual(calls.filter(([kind]) => kind === 'all'), [['all']]);
});

test('global alignment repair invalidates every port cache before detection', async () => {
    const { api, calls, flushFrame } = createHarness();

    const repair = api.maintenance.repairAlignment();
    flushFrame();
    await repair;

    const relevantCalls = calls.filter(([kind]) => kind === 'geometry' || kind === 'detect');
    assert.deepEqual(relevantCalls, [['geometry', undefined], ['detect']]);
});

test('destroying connection projection cancels queued alignment verification', async () => {
    const { api, calls, flushFrame } = createHarness();

    const repair = api.maintenance.repairAlignment();
    api.destroy();
    flushFrame();
    const result = await repair;

    assert.deepEqual(result, { inspected: 0, corrected: 0 });
    assert.equal(calls.some(([kind]) => kind === 'detect' || kind === 'dirty'), false);
});

test('destroyed connection projection ignores subsequent projection intents', () => {
    const { api, calls, flushFrame } = createHarness();

    api.destroy();
    api.interactions.nodeGeometryChanged('node-1');
    api.interactions.topologyChanged({ connectionIds: ['connection-1'] });
    api.maintenance.workflowReplaced();
    flushFrame();

    assert.equal(calls.some(([kind]) => kind === 'all' || kind === 'dirty'), false);
});
