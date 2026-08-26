import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreparedWorkflowEditorView } from '../js/features/workflow/workflow-editor-view.js';

function root(...children) {
    return {
        childNodes: children,
        replaceChildren(...next) { this.childNodes = next; }
    };
}

test('prepared workflow editor view leaves the active editor untouched until atomic commit', () => {
    const oldNode = { id: 'old' };
    const targetNode = { id: 'target' };
    const liveRoot = root(oldNode);
    const targetRoot = root(targetNode);
    const liveState = {
        nodes: new Map([['old', oldNode]]),
        connections: [{ id: 'old-connection' }],
        selectedNodes: new Set(['old']),
        canvas: { x: 1, y: 2, zoom: 1 }
    };
    const targetState = {
        nodes: new Map([['target', targetNode]]),
        connections: [{ id: 'target-connection' }],
        selectedNodes: new Set(),
        canvas: { x: 9, y: 8, zoom: 2 }
    };
    const view = createPreparedWorkflowEditorView({ liveState, liveRoot, targetState, targetRoot });

    liveState.nodes.get('old').editedDuringPrepare = true;
    liveState.connections = [{ id: 'edited-during-prepare' }];
    assert.equal(liveRoot.childNodes[0], oldNode);
    assert.equal(liveState.nodes.has('old'), true);

    view.commit();
    assert.equal(liveRoot.childNodes[0], targetNode);
    assert.equal(liveState.nodes.has('target'), true);
    assert.deepEqual(liveState.canvas, { x: 9, y: 8, zoom: 2 });

    view.rollback();
    assert.equal(liveRoot.childNodes[0], oldNode);
    assert.equal(liveState.nodes.get('old').editedDuringPrepare, true);
    assert.deepEqual(liveState.connections, [{ id: 'edited-during-prepare' }]);
});

test('adopted workflow nodes receive their complete visible-editor bindings after commit', () => {
    const targetNode = { id: 'image-import', type: 'ImageImport' };
    const adopted = [];
    const view = createPreparedWorkflowEditorView({
        liveState: { nodes: new Map(), connections: [], selectedNodes: new Set(), canvas: {} },
        liveRoot: root(),
        targetState: {
            nodes: new Map([[targetNode.id, targetNode]]),
            connections: [],
            selectedNodes: new Set(),
            canvas: {}
        },
        targetRoot: root(targetNode),
        adoptTarget: (state) => state.nodes.forEach((node) => adopted.push(node.type))
    });

    view.commit();

    assert.deepEqual(adopted, ['ImageImport']);
});

test('failed visible-editor adoption can roll back the atomic view exchange', () => {
    const oldNode = { id: 'old' };
    const targetNode = { id: 'target' };
    const liveState = {
        nodes: new Map([[oldNode.id, oldNode]]),
        connections: [],
        selectedNodes: new Set(),
        canvas: { x: 1 }
    };
    const liveRoot = root(oldNode);
    const view = createPreparedWorkflowEditorView({
        liveState,
        liveRoot,
        targetState: {
            nodes: new Map([[targetNode.id, targetNode]]),
            connections: [],
            selectedNodes: new Set(),
            canvas: { x: 2 }
        },
        targetRoot: root(targetNode),
        adoptTarget: () => { throw new Error('binding failed'); }
    });

    assert.throws(() => view.commit(), /binding failed/);
    assert.equal(view.rollback(), true);
    assert.equal(liveRoot.childNodes[0], oldNode);
    assert.equal(liveState.nodes.has('old'), true);
});

test('old-view cleanup failure cannot roll back a finalized workflow activation', () => {
    const errors = [];
    const view = createPreparedWorkflowEditorView({
        liveState: { nodes: new Map(), connections: [], selectedNodes: new Set(), canvas: {} },
        liveRoot: root(),
        targetState: { nodes: new Map(), connections: [], selectedNodes: new Set(), canvas: {} },
        targetRoot: root(),
        disposePrevious: () => { throw new Error('cleanup failed'); },
        onFinalizeError: (error) => errors.push(error.message)
    });

    view.commit();

    assert.equal(view.finalize(), true);
    assert.equal(view.rollback(), false);
    assert.deepEqual(errors, ['cleanup failed']);
});

test('renderer-owned connection projection is restored when workflow adoption rolls back', () => {
    let projection = 'old';
    const view = createPreparedWorkflowEditorView({
        liveState: { nodes: new Map(), connections: [], selectedNodes: new Set(), canvas: {} },
        liveRoot: root(),
        targetState: { nodes: new Map(), connections: [], selectedNodes: new Set(), canvas: {} },
        targetRoot: root(),
        capturePrevious: () => projection,
        adoptTarget: () => { projection = 'target'; },
        restorePrevious: (previous) => { projection = previous; }
    });

    view.commit();
    assert.equal(projection, 'target');
    view.rollback();
    assert.equal(projection, 'old');
});
