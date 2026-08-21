import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionProjection } from '../js/canvas/connection-projection.js';

function createHarness({ mismatches = [] } = {}) {
    const frames = [];
    const calls = [];
    const api = createConnectionProjection({
        updateAllConnections() { calls.push(['all']); },
        updateDirtyConnections() { calls.push(['dirty']); return true; },
        invalidateNodePortCache(id) { calls.push(['geometry', id]); },
        markNodeConnectionsDirty(id) { calls.push(['appearance', id]); },
        markConnectionDirty(id) { calls.push(['connection', id]); },
        detectMisalignedConnections() { calls.push(['detect']); return mismatches; },
        requestAnimationFrameRef(callback) { frames.push(callback); return frames.length; },
        cancelAnimationFrameRef() {}
    });
    return { api, calls, flushFrame() { frames.shift()?.(0); } };
}

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
