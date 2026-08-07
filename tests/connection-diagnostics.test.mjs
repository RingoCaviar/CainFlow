import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionDiagnostics } from '../js/canvas/connection-diagnostics.js';

function createStorage() {
    const values = new Map();
    return {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, value); }
    };
}

test('connection diagnostics retain the rolling last 24 hours without a count cap', () => {
    let now = 0;
    const diagnostics = createConnectionDiagnostics({ localStorageRef: createStorage(), nowRef: () => now });
    diagnostics.record({ reason: 'old', connectionId: 'c-old' });
    now = 24 * 60 * 60 * 1000 + 1;
    for (let index = 0; index < 250; index += 1) {
        diagnostics.record({ reason: 'new', connectionId: `c-${index}` });
    }

    const entries = diagnostics.getEntries();
    assert.equal(entries.some((entry) => entry.connectionId === 'c-old'), false);
    assert.equal(entries.length, 250);
});
