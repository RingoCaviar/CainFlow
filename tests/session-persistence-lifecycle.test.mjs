import assert from 'node:assert/strict';
import test from 'node:test';
import { installSessionPersistenceOnExit } from '../js/features/persistence/session-persistence-lifecycle.js';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';

test('a queued recovery save waits for a later drag or resize, but exit flush remains immediate', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const state = { nodes: new Map(), connections: [], undoStack: [], workflowTabs: [] };
    let captures = 0;
    const manager = createSessionManagerApi({ state, storageKey: 'session',
        nodeSerializer: { buildStatePayload() { captures++; return {}; } },
        documentRef: { getElementById: () => null },
        localStorageRef: { getItem: () => null, setItem() {} }, showToast() {} });
    manager.scheduleSave();
    state.dragging = { nodes: ['node'] };
    t.mock.timers.tick(300);
    assert.equal(captures, 0, 'a timer queued before pointer down must not serialize while dragging');
    state.dragging = null;
    state.resizing = { id: 'node' };
    t.mock.timers.tick(300);
    assert.equal(captures, 0);
    state.resizing = null;
    t.mock.timers.tick(300);
    assert.equal(captures, 1, 'the deferred save is not lost even without another edit');
    manager.scheduleSave();
    state.dragging = { nodes: ['node'] };
    manager.flushSave();
    assert.equal(captures, 2, 'explicit exit flush still persists the latest state');
    state.dragging = null;
    t.mock.timers.tick(600);
    assert.equal(captures, 2, 'flush cancels the pending timer');
});

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

test('save readiness distinguishes a queued cache write from an already clean session', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const manager = createSessionManagerApi({ state: { nodes: new Map(), connections: [], workflowTabs: [] },
        storageKey: 'session', nodeSerializer: { buildStatePayload: () => ({}) },
        documentRef: { getElementById: () => null }, localStorageRef: { getItem: () => null, setItem() {} }, showToast() {} });
    assert.equal(manager.hasPendingSave(), false);
    manager.scheduleSave({ dirty: false });
    assert.equal(manager.hasPendingSave(), true);
    t.mock.timers.tick(299);
    assert.equal(manager.hasPendingSave(), true);
    t.mock.timers.tick(1);
    assert.equal(manager.hasPendingSave(), false);
});
