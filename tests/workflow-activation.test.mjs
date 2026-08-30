import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowActivation } from '../js/features/workflow/workflow-activation.js';
import { createWorkflowDesk } from '../js/features/workflow/workflow-desk.js';
import {
    createWorkflowSessionActivator,
    createWorkflowTargetActivator
} from '../js/features/workflow/workflow-activation-coordinator.js';

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function createTestActiveState(state) {
    return {
        commitActive({ workflowId, label }) {
            state.activeWorkflowId = workflowId;
            state.activeWorkflowName = label;
        },
        clearActive() {
            state.activeWorkflowId = '';
            state.activeWorkflowName = '';
        }
    };
}

function createTargetActivatorHarness({ state, prepareWorkflowView }) {
    const applied = [];
    const activator = createWorkflowTargetActivator({
        state,
        activeState: createTestActiveState(state),
        workflowActivation: createWorkflowActivation(),
        createWorkflowId: () => 'generated-workflow-id',
        getWorkflowTab: (name) => state.workflowTabs.find((tab) => tab.name === name),
        ensureWorkflowIdentity: (tab) => tab?.workflowId || '',
        loadWorkflowFromFile: async () => null,
        prepareWorkflowView,
        prepareEditorView: async () => ({ commit: () => true, finalize: () => {} }),
        snapshotActiveWorkflow: () => {},
        cloneWorkflowData: (data) => structuredClone(data),
        getEmptyWorkflowData: () => ({ nodes: [], connections: [] }),
        resolveWorkflowModelReferences: (data) => ({ nodes: data.nodes || [] }),
        clearUndoStack: () => {},
        updatePortStyles: () => {},
        applyViewport: () => {},
        onViewApplied: (view) => applied.push(view),
        onConnectionsChanged: () => {},
        scheduleAssetCleanup: () => {},
        showToast: () => {},
        renderWorkflowList: () => {},
        scheduleSave: () => {},
        releaseWorkflowTabMemory: () => {},
        enterSafeEmpty: () => {}
    });
    return { activator, applied };
}

test('workflow activation commits the current name for a stable identity renamed during preparation', async () => {
    const preparationStarted = deferred();
    const finishPreparation = deferred();
    const target = {
        name: 'folder/original',
        workflowId: 'workflow-target',
        data: { workflowId: 'workflow-target', nodes: [], connections: [] }
    };
    const state = {
        workflowTabs: [target],
        activeWorkflowName: '',
        activeWorkflowId: '',
        undoStack: []
    };
    const { activator, applied } = createTargetActivatorHarness({
        state,
        prepareWorkflowView: async (data) => {
            preparationStarted.resolve();
            await finishPreparation.promise;
            return { data, modelResolution: { nodes: [] } };
        }
    });

    const activation = activator.activate('folder/original');
    await preparationStarted.promise;
    target.name = 'folder/renamed';
    finishPreparation.resolve();

    assert.equal(await activation, true);
    assert.equal(state.activeWorkflowName, 'folder/renamed');
    assert.deepEqual(applied, [{ workflowName: 'folder/renamed', workflowId: 'workflow-target' }]);
});

test('workflow activation keeps the workflow being left unchanged when target commit triggers a snapshot', async () => {
    const previousWorkflow = {
        name: 'new-workflow',
        workflowId: 'workflow-new',
        data: { workflowId: 'workflow-new', nodes: [{ id: 'new-node' }], connections: [] }
    };
    const targetWorkflow = {
        name: 'old-workflow',
        workflowId: 'workflow-old',
        data: { workflowId: 'workflow-old', nodes: [{ id: 'old-node' }], connections: [] }
    };
    const state = {
        workflowTabs: [previousWorkflow, targetWorkflow],
        activeWorkflowName: previousWorkflow.name,
        activeWorkflowId: previousWorkflow.workflowId,
        undoStack: []
    };
    let visibleData = structuredClone(previousWorkflow.data);
    const getWorkflowTab = (name) => state.workflowTabs.find((tab) => tab.name === name);
    const snapshotActiveWorkflow = () => {
        const activeTab = getWorkflowTab(state.activeWorkflowName);
        activeTab.data = structuredClone(visibleData);
        activeTab.data.workflowId = activeTab.workflowId;
    };
    const activator = createWorkflowTargetActivator({
        state,
        activeState: createTestActiveState(state),
        workflowActivation: createWorkflowActivation(),
        createWorkflowId: () => 'generated-workflow-id',
        getWorkflowTab,
        ensureWorkflowIdentity: (tab) => tab?.workflowId || '',
        loadWorkflowFromFile: async () => null,
        prepareWorkflowView: async (data) => ({
            data: structuredClone(data),
            modelResolution: { nodes: structuredClone(data.nodes || []) }
        }),
        prepareEditorView: async (_name, data) => ({
            commit: () => {
                visibleData = structuredClone(data);
                snapshotActiveWorkflow();
                return true;
            },
            finalize() {},
            rollback() {}
        }),
        snapshotActiveWorkflow,
        cloneWorkflowData: (data) => structuredClone(data),
        getEmptyWorkflowData: () => ({ nodes: [], connections: [] }),
        resolveWorkflowModelReferences: (data) => ({ nodes: data.nodes || [] }),
        clearUndoStack: () => {},
        updatePortStyles: () => {},
        applyViewport: () => {},
        onViewApplied: () => {},
        onConnectionsChanged: () => {},
        scheduleAssetCleanup: () => {},
        showToast: () => {},
        renderWorkflowList: () => {},
        scheduleSave: () => {},
        releaseWorkflowTabMemory: () => {},
        enterSafeEmpty: () => {}
    });

    assert.equal(await activator.activate(targetWorkflow.name), true);
    assert.deepEqual(previousWorkflow.data.nodes, [{ id: 'new-node' }]);
});

test('session activation coordinator reconciles the active workflow identity as one state change', () => {
    const state = { activeWorkflowName: 'legacy-name', activeWorkflowId: '' };
    const workflowActivation = createWorkflowActivation();
    const coordinator = createWorkflowSessionActivator({
        state,
        activeState: createTestActiveState(state),
        workflowActivation
    });

    assert.equal(coordinator.reconcileActiveTab({
        name: 'current-name',
        workflowId: 'workflow-a'
    }), true);
    assert.deepEqual(state, {
        activeWorkflowName: 'current-name',
        activeWorkflowId: 'workflow-a'
    });
    assert.equal(workflowActivation.retainActive('workflow-a'), true);
});

test('production session restoration commits document data and viewport through WorkflowDesk', async () => {
    const state = { workflowTabs: [], workflowOrder: [], workflowFolders: [] };
    let preparedData = null;
    let viewportActiveId = null;
    const workflowDesk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => target.editorView,
        createWorkflowId: () => 'generated-id'
    });
    const coordinator = createWorkflowSessionActivator({
        state,
        workflowDesk,
        workflowActivation: createWorkflowActivation(),
        prepareEditorView: async (_label, workflowData) => {
            preparedData = workflowData;
            return { async commit() { return true; } };
        },
        applyViewport: () => { viewportActiveId = workflowDesk.snapshot().active?.workflowId; }
    });

    assert.equal(await coordinator.activate({
        workflowTabs: [{ name: 'legacy', data: { nodes: [{ id: 'node-a' }] } }],
        activeWorkflowName: 'legacy',
        workflowOrder: ['legacy'],
        workflowFolders: ['folder-a']
    }), true);

    assert.deepEqual(preparedData, { nodes: [{ id: 'node-a' }], workflowId: 'generated-id' });
    assert.equal(state.workflowTabs[0].identityPendingSave, true);
    assert.equal(viewportActiveId, 'generated-id');
    assert.deepEqual(state.workflowOrder, ['legacy']);
    assert.deepEqual(state.workflowFolders, ['folder-a']);
});

test('session workflow activation waits for visible editor commit to finish', async () => {
    const commitGate = deferred();
    let commitSignal = null;
    const state = {
        workflowTabs: [],
        activeWorkflowName: '',
        activeWorkflowId: '',
        workflowOrder: [],
        workflowFolders: []
    };
    const coordinator = createWorkflowSessionActivator({
        state,
        activeState: createTestActiveState(state),
        workflowActivation: createWorkflowActivation(),
        createWorkflowId: () => 'workflow-a',
        prepareEditorView: async () => ({
            commit: async ({ signal }) => {
                commitSignal = signal;
                await commitGate.promise;
                return true;
            },
            finalize() {},
            rollback() {}
        })
    });
    const activation = coordinator.activate({
        workflowTabs: [{
            name: 'workflow-a',
            workflowId: 'workflow-a',
            data: { workflowId: 'workflow-a' }
        }],
        activeWorkflowName: 'workflow-a',
        activeWorkflowId: 'workflow-a'
    });
    const firstResult = await Promise.race([
        activation.then(() => 'activation'),
        new Promise((resolve) => setImmediate(() => resolve('event-loop-turn')))
    ]);
    assert.equal(firstResult, 'event-loop-turn');
    assert.equal(commitSignal instanceof AbortSignal, true);
    commitGate.resolve();
    assert.equal(await activation, true);
});

test('latest workflow activation is the only prepared target committed', async () => {
    const gates = new Map([['a', deferred()], ['b', deferred()], ['c', deferred()]]);
    const committed = [];
    const disposed = [];
    const activation = createWorkflowActivation();
    const operations = {
        prepare: async ({ key }) => {
            await gates.get(key).promise;
            return { key, dispose: () => disposed.push(key) };
        },
        commit: async ({ key }) => committed.push(key)
    };

    const a = activation.activate('a', operations);
    const b = activation.activate('b', operations);
    const c = activation.activate('c', operations);
    gates.get('c').resolve();
    gates.get('a').resolve();
    gates.get('b').resolve();

    assert.deepEqual(await Promise.all([a, b, c]), [false, false, true]);
    assert.deepEqual(committed, ['c']);
    assert.deepEqual(new Set(disposed), new Set(['a', 'b']));
});

test('duplicate pending activation reuses one preparation', async () => {
    const gate = deferred();
    let preparations = 0;
    const activation = createWorkflowActivation();
    const operations = {
        prepare: async () => { preparations += 1; await gate.promise; return {}; },
        commit: async () => {}
    };
    const first = activation.activate('a', operations);
    const second = activation.activate('a', operations);
    assert.equal(first, second);
    gate.resolve();
    assert.equal(await first, true);
    assert.equal(preparations, 1);
});

test('forced activation commits again for the active workflow identity', async () => {
    const activation = createWorkflowActivation();
    let commits = 0;
    const operations = {
        force: true,
        prepare: async () => ({}),
        commit: async () => { commits += 1; return true; }
    };

    assert.equal(await activation.activate('workflow-a', operations), true);
    assert.equal(await activation.activate('workflow-a', operations), true);
    assert.equal(commits, 2);
});

test('forced activation supersedes an older pending request with the same identity', async () => {
    const activation = createWorkflowActivation();
    let releaseFirst;
    const firstPrepared = new Promise((resolve) => { releaseFirst = resolve; });
    const commits = [];
    const first = activation.activate('workflow-a', {
        prepare: async () => { await firstPrepared; return { request: 'first' }; },
        commit: async (prepared) => { commits.push(prepared.request); return true; }
    });
    const second = activation.activate('workflow-a', {
        force: true,
        prepare: async () => ({ request: 'second' }),
        commit: async (prepared) => { commits.push(prepared.request); return true; }
    });

    assert.notEqual(second, first);
    releaseFirst();
    assert.equal(await first, false);
    assert.equal(await second, true);
    assert.deepEqual(commits, ['second']);
});

test('activation promotes a temporary request key to the committed stable identity', async () => {
    const activation = createWorkflowActivation();
    assert.equal(await activation.activate('path:folder/a', {
        prepare: async () => ({ workflowId: 'workflow-a' }),
        commit: async () => true,
        getActiveKey: (prepared) => prepared.workflowId
    }), true);

    assert.equal(activation.retainActive('workflow-a'), true);
    assert.equal(activation.retainActive('path:folder/a'), false);
});

test('failed preparation keeps the previous active workflow', async () => {
    const errors = [];
    const activation = createWorkflowActivation({ onError: (error) => errors.push(error.message) });
    activation.setActiveKey('a');
    const result = await activation.activate('b', {
        prepare: async () => { throw new Error('load failed'); },
        commit: async () => { throw new Error('must not commit'); }
    });
    assert.equal(result, false);
    assert.deepEqual(errors, ['load failed']);
    assert.equal(await activation.activate('a', { prepare: async () => ({}), commit: async () => {} }), true);
});

test('superseded commit rolls back before the latest activation can commit', async () => {
    const commitStarted = deferred();
    const finishCommit = deferred();
    const events = [];
    const activation = createWorkflowActivation();
    activation.setActiveKey('original');

    const first = activation.activate('a', {
        prepare: async () => ({ key: 'a' }),
        commit: async () => {
            events.push('commit-a');
            commitStarted.resolve();
            await finishCommit.promise;
            return true;
        },
        rollback: async () => events.push('rollback-a')
    });
    await commitStarted.promise;
    const latest = activation.activate('b', {
        prepare: async () => { throw new Error('b failed'); },
        commit: async () => true
    });
    finishCommit.resolve();

    assert.deepEqual(await Promise.all([first, latest]), [false, false]);
    assert.deepEqual(events, ['commit-a', 'rollback-a']);
});

test('commit failure reports whether rollback had to use a safe empty workflow', async () => {
    const reports = [];
    const activation = createWorkflowActivation({ onError: (_error, context) => reports.push(context) });
    await activation.activate('broken', {
        prepare: async () => ({}),
        commit: async () => { throw new Error('commit failed'); },
        rollback: async () => ({ safeEmpty: true })
    });

    assert.equal(reports.length, 1);
    assert.equal(reports[0].rollbackResult.safeEmpty, true);
});

test('rollback failure is reported without attempting the rollback twice', async () => {
    const reports = [];
    let rollbackAttempts = 0;
    const activation = createWorkflowActivation({ onError: (error, context) => reports.push({ error, context }) });

    const result = await activation.activate('broken', {
        prepare: async () => ({}),
        commit: async () => false,
        rollback: async () => {
            rollbackAttempts += 1;
            throw new Error('rollback failed');
        }
    });

    assert.equal(result, false);
    assert.equal(rollbackAttempts, 1);
    assert.equal(reports.some(({ context }) => context?.phase === 'rollback'), true);
});

test('safe empty recovery clears the previous idempotency key', async () => {
    let committed = false;
    const activation = createWorkflowActivation();
    activation.setActiveKey('workflow-a');
    activation.resetActive();
    const result = await activation.activate('workflow-a', {
        prepare: async () => ({}),
        commit: async () => { committed = true; return true; }
    });
    assert.equal(result, true);
    assert.equal(committed, true);
});

test('only the winning workflow activation finalizes its prepared editor view', async () => {
    const events = [];
    const activation = createWorkflowActivation();
    const result = await activation.activate('target', {
        prepare: async () => ({}),
        commit: async () => { events.push('commit'); return true; },
        finalize: () => events.push('finalize')
    });

    assert.equal(result, true);
    assert.deepEqual(events, ['commit', 'finalize']);
});

test('retaining the active workflow supersedes an in-flight transition without rebuilding it', async () => {
    const gate = deferred();
    let committed = false;
    const activation = createWorkflowActivation();
    activation.setActiveKey('active');
    const pending = activation.activate('target', {
        prepare: async () => { await gate.promise; return {}; },
        commit: async () => { committed = true; }
    });

    assert.equal(activation.retainActive('active'), true);
    gate.resolve();

    assert.equal(await pending, false);
    assert.equal(committed, false);
});

test('duplicate callers share a retry when their prepared target revision becomes stale', async () => {
    let revision = 0;
    let preparations = 0;
    const committed = [];
    const activation = createWorkflowActivation();
    const operations = {
        prepare: async () => {
            preparations += 1;
            const prepared = { revision };
            if (preparations === 1) revision += 1;
            return prepared;
        },
        validate: (prepared) => prepared.revision === revision,
        commit: async (prepared) => committed.push(prepared.revision)
    };

    const first = activation.activate('target', operations);
    const duplicate = activation.activate('target', operations);

    assert.deepEqual(await Promise.all([first, duplicate]), [true, true]);
    assert.equal(preparations, 2);
    assert.deepEqual(committed, [1]);
});

test('finalize side-effect failure does not roll back a committed workflow activation', async () => {
    const reports = [];
    let rollbacks = 0;
    const activation = createWorkflowActivation({ onError: (error, context) => reports.push({ error, context }) });

    const result = await activation.activate('target', {
        prepare: async () => ({}),
        commit: async () => true,
        finalize: () => { throw new Error('notification failed'); },
        rollback: async () => { rollbacks += 1; }
    });

    assert.equal(result, true);
    assert.equal(rollbacks, 0);
    assert.equal(reports[0].context.phase, 'finalize');
});

test('continuously changing target revision stops after the shared retry budget', async () => {
    let preparations = 0;
    const reports = [];
    const activation = createWorkflowActivation({
        maxValidationRetries: 2,
        onError: (error, context) => reports.push({ error, context })
    });

    const result = await activation.activate('target', {
        prepare: async () => { preparations += 1; return {}; },
        validate: () => false,
        commit: async () => true
    });

    assert.equal(result, false);
    assert.equal(preparations, 3);
    assert.equal(reports[0].context.phase, 'validate');
});

test('validation can cancel a workflow activation without retrying stale file data', async () => {
    let preparations = 0;
    let committed = false;
    let disposed = false;
    const activation = createWorkflowActivation();

    const result = await activation.activate('reload', {
        prepare: async () => { preparations += 1; return { dispose: () => { disposed = true; } }; },
        validate: () => null,
        commit: async () => { committed = true; }
    });

    assert.equal(result, false);
    assert.equal(preparations, 1);
    assert.equal(disposed, true);
    assert.equal(committed, false);
});
