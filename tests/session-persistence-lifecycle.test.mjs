import assert from 'node:assert/strict';
import test from 'node:test';
import { installSessionPersistenceOnExit } from '../js/features/persistence/session-persistence-lifecycle.js';

test('page exit flushes a pending session save once', () => {
    const listeners = new Map();
    const windowRef = {
        addEventListener(type, listener) { listeners.set(type, listener); }
    };
    let flushes = 0;

    installSessionPersistenceOnExit({ windowRef, flushSession: () => { flushes += 1; } });
    listeners.get('pagehide')();
    listeners.get('beforeunload')();

    assert.equal(flushes, 1);
});

test('pending workflow writes guard browser exit and preserve the recovery session', async () => {
    const listeners = new Map();
    let pending = true, sessions = 0, writes = 0, prevented = 0;
    installSessionPersistenceOnExit({
        windowRef: { addEventListener: (type, listener) => listeners.set(type, listener) },
        flushSession: () => { sessions++; },
        hasPendingWorkflows: () => pending,
        flushWorkflows: async () => { writes++; pending = false; }
    });
    listeners.get('beforeunload')({ preventDefault() { prevented++; } });
    await Promise.resolve();
    assert.equal(prevented, 1);
    assert.equal(writes, 1);
    assert.equal(sessions, 1);
    listeners.get('beforeunload')({ preventDefault() { prevented++; } });
    assert.equal(prevented, 1);
    assert.equal(sessions, 2);
});
