import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticClient } from '../js/services/diagnostic-client.js';

function storage() {
    const values = new Map();
    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key)
    };
}

test('diagnostic client configures Canvas from backend status and owns multi-adapter clearing', async () => {
    const calls = [];
    const fetchImpl = async (_url, options = {}) => {
        calls.push(options.body ? JSON.parse(options.body) : { action: 'status' });
        if (!options.body) return { ok: true, json: async () => ({ status: { level: 'standard', totalBudgetBytes: 30, adapters: { backend: { budgetBytes: 27, usedBytes: 4 }, canvas: { budgetBytes: 3000, recordBytes: 1000, retentionDays: 14 } } } }) };
        return { ok: true, json: async () => ({ adapters: { backend: { success: true } } }) };
    };
    const client = createDiagnosticClient({ fetchImpl, localStorageRef: storage(), nowRef: () => 1 });

    const status = await client.status();
    assert.equal(status.adapters.canvas.budgetBytes, 3000);
    assert.equal(client.recordCanvas({ reason: 'alignment', connectionId: 'c1' }), true);
    const updatedStatus = await client.status();
    assert.ok(updatedStatus.adapters.canvas.usedBytes > 0);
    const cleared = await client.clear('all');
    assert.deepEqual(cleared.adapters, { backend: { success: true }, canvas: { success: true } });
    assert.deepEqual(calls.at(-1), { action: 'clear', scope: 'all' });
});

test('diagnostic clear reports partial success when the backend adapter fails', async () => {
    let clearing = false;
    const fetchImpl = async (_url, options = {}) => {
        if (options.body) {
            clearing = true;
            throw new Error('backend unavailable');
        }
        return { ok: true, json: async () => ({ status: { adapters: { backend: { budgetBytes: 27 }, canvas: { budgetBytes: 3000, recordBytes: 1000, retentionDays: 14 } } } }) };
    };
    const client = createDiagnosticClient({ fetchImpl, localStorageRef: storage() });
    await client.status();
    client.recordCanvas({ reason: 'alignment', connectionId: 'c1' });

    const result = await client.clear('all');

    assert.equal(clearing, true);
    assert.equal(result.adapters.backend.success, false);
    assert.equal(result.adapters.canvas.success, true);
});

test('diagnostic client records a Canvas alignment repair batch through one interface', async () => {
    const fetchImpl = async () => ({
        ok: true,
        json: async () => ({
            status: {
                adapters: {
                    canvas: { budgetBytes: 3000, recordBytes: 1000, retentionDays: 14 }
                }
            }
        })
    });
    const client = createDiagnosticClient({ fetchImpl, localStorageRef: storage(), nowRef: () => 1 });
    await client.status();

    const result = client.recordCanvasBatch([
        { reason: 'viewport-settled', connectionId: 'c1' },
        { reason: 'viewport-settled', connectionId: 'c2' }
    ]);

    assert.deepEqual(result, { accepted: 2, deduped: 0, dropped: 0 });
});

test('diagnostic client records a bounded Workflow diagnostic through the backend authority', async () => {
    const calls = [];
    const client = createDiagnosticClient({
        localStorageRef: storage(),
        fetchImpl: async (_url, options) => {
            calls.push(JSON.parse(options.body));
            return { ok: true, json: async () => ({ recorded: true }) };
        }
    });

    const result = await client.recordWorkflow({
        kind: 'workflow-duplicate-identity-repaired',
        id: 'copy-id',
        error: 'Duplicate Workflow identity repaired'
    });

    assert.equal(result.recorded, true);
    assert.deepEqual(calls[0], {
        action: 'record',
        intent: {
            kind: 'workflow-duplicate-identity-repaired',
            id: 'copy-id',
            error: 'Duplicate Workflow identity repaired'
        }
    });
});
