import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';

function createStorage() {
    const values = new Map();
    return {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, value); },
        removeItem(key) { values.delete(key); }
    };
}

test('viewport state persists by Workflow identity without serializing or dirtying the workflow', () => {
    let serializedWorkflowCount = 0;
    const beforeSaveCalls = [];
    const manager = createSessionManagerApi({
        state: { undoStack: [], workflowTabs: [] },
        storageKey: 'session',
        nodeSerializer: {
            buildStatePayload() {
                serializedWorkflowCount += 1;
                return {};
            }
        },
        localStorageRef: createStorage(),
        documentRef: { getElementById: () => null },
        showToast: () => {},
        addNode: () => {},
        updateAllConnections: () => {},
        updatePortStyles: () => {}
    });
    manager.setBeforeSave((event) => beforeSaveCalls.push(event));

    assert.equal(manager.saveViewportState({
        workflowId: 'workflow-a',
        canvas: { x: 24, y: -12, zoom: 1.5 }
    }), true);

    assert.deepEqual(manager.loadViewportState('workflow-a'), { x: 24, y: -12, zoom: 1.5 });
    assert.equal(serializedWorkflowCount, 0);
    assert.deepEqual(beforeSaveCalls, []);
});

test('viewport state updates the matching open workflow snapshot without using its mutable name', () => {
    const workflowA = { workflowId: 'workflow-a', name: 'renamed/a', data: { canvas: { x: 0, y: 0, zoom: 1 } } };
    const workflowB = { workflowId: 'workflow-b', name: 'a', data: { canvas: { x: 9, y: 9, zoom: 2 } } };
    const manager = createSessionManagerApi({
        state: { undoStack: [], workflowTabs: [workflowA, workflowB] },
        storageKey: 'session',
        nodeSerializer: { buildStatePayload: () => ({}) },
        localStorageRef: createStorage(),
        documentRef: { getElementById: () => null },
        showToast: () => {},
        addNode: () => {},
        updateAllConnections: () => {},
        updatePortStyles: () => {}
    });

    manager.saveViewportState({ workflowId: 'workflow-a', canvas: { x: 4, y: 5, zoom: 1.25 } });

    assert.deepEqual(workflowA.data.canvas, { x: 4, y: 5, zoom: 1.25 });
    assert.deepEqual(workflowB.data.canvas, { x: 9, y: 9, zoom: 2 });
});
