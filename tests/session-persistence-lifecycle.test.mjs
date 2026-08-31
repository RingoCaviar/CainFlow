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
