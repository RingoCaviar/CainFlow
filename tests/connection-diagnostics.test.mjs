import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionDiagnostics } from '../js/canvas/connection-diagnostics.js';

function createStorage() {
    const values = new Map();
    return {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, value); },
        removeItem(key) { values.delete(key); }
    };
}

test('connection diagnostics retain at most 14 days', () => {
    let now = 0;
    const diagnostics = createConnectionDiagnostics({ localStorageRef: createStorage(), nowRef: () => now, policy: { budgetBytes: 3 * 1024 * 1024, recordBytes: 16 * 1024, retentionDays: 14 } });
    diagnostics.record({ reason: 'old', connectionId: 'c-old' });
    now = 14 * 24 * 60 * 60 * 1000 + 1;
    for (let index = 0; index < 250; index += 1) {
        diagnostics.record({ reason: 'new', connectionId: `c-${index}` });
    }

    const entries = diagnostics.getEntries();
    assert.equal(entries.some((entry) => entry.connectionId === 'c-old'), false);
    assert.equal(entries.length, 250);
});

test('connection diagnostics cap a single record and can be cleared', () => {
    const diagnostics = createConnectionDiagnostics({ localStorageRef: createStorage(), nowRef: () => 1, policy: { budgetBytes: 3 * 1024 * 1024, recordBytes: 16 * 1024, retentionDays: 14 } });
    diagnostics.record({ reason: 'x'.repeat(20 * 1024), connectionId: 'large' });
    assert.equal(diagnostics.getEntries()[0].truncated, true);
    assert.deepEqual(diagnostics.clear(), { success: true });
    assert.equal(diagnostics.getEntries().length, 0);
});

test('connection diagnostics require policy resolved by the backend authority', () => {
    assert.throws(() => createConnectionDiagnostics({ localStorageRef: createStorage() }), /policy/i);
});
