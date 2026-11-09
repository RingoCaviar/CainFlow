import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createWorkflowDesk,
    WorkflowHandleClosedError
} from '../js/features/workflow/workflow-desk.js';
import { createWorkflowRuntimeManager } from '../js/features/workflow/workflow-runtime-manager.js';

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function scopedToolbarFixture({ holdRestore = false } = {}) {
    const controls = new Map(['btn-run','btn-stop','toolbar-workflow-run-status'].map(id => [id, {
        textContent: '', hidden: true, disabled: false, dataset: {},
        classList: { remove() {}, toggle() {} }, setAttribute() {}
    }]));
    const contexts = [];
    let activeId = 'workflow-a';
    const state = { nodes: new Map(), connections: [], runningNodeIds: new Set(), runningNodeCancelHandlers: new Map() };
    const manager = createWorkflowRuntimeManager({ state, nodeConfigs: {},
        documentRef: { getElementById: id => controls.get(id) || null, implementation: {} },
        getWorkflowManagerApi: () => ({ getActiveWorkflow: () => ({ workflowId: activeId, label: activeId }),
            projectWorkflowRunningStateById() {}, updateWorkflowTabDataById() {}, setWorkflowRunResultById() {} }),
        getWorkflowDesk: () => ({ workflow: () => ({ runningChanged() {} }) }),
        createRunContext: ({ workflowId }) => {
            const context = { id: `${workflowId}:${contexts.length}`, workflowId, workflowName: workflowId,
                state: { nodes: new Map(), runningNodeIds: new Set() },
                baseNodeIds: new Set(), baseConnectionIds: new Set(), completion: deferred(), restore: deferred(), calls: 0,
                resolveExecutionPlan: () => ({ executionOrder: [context.id+'-node'] }),
                waitForImageRestores: () => holdRestore ? context.restore.promise : Promise.resolve(),
                runner: { async runWorkflow(_input, { signal } = {}) { context.calls++; context.signal = signal; context.state.activeRunCount = 1; return context.completion.promise; } },
                serialize: () => ({ nodes: [], connections: [] }), dispose() {} };
            contexts.push(context);
            return context;
        },
        scheduleSave() {}, showToast() {}, addLog() {}, connectionProjection: { nodeAppearanceChanged() {} },
        windowRef: { clearInterval() {} }, confirmRef: () => true
    });
    const reference = id => ({ workflowId: id, workflowName: id });
    return { manager, controls, state, contexts,
        run: id => manager.runWorkflowInContext(reference(id), {}),
        activate(id) { activeId = id; manager.refreshVisibleWorkflowRunState(reference(id)); } };
}

test('toolbar stop is scoped by current workflow identity and leaves background work running', async () => {
    const f = scopedToolbarFixture();
    await f.run('workflow-a');
    f.activate('workflow-b');
    assert.equal(f.controls.get('btn-stop').disabled, true, 'an idle current workflow cannot stop a background workflow');
    assert.equal(f.controls.get('toolbar-workflow-run-status').hidden, true);
    await f.run('workflow-b');
    assert.equal(f.manager.abortWorkflowRuns({ workflowId: 'workflow-b', workflowName: 'renamed-b' }), 1);
    assert.equal(f.contexts[1].signal.aborted, true);
    assert.equal(f.contexts[0].signal.aborted, false);
    assert.equal(f.controls.get('toolbar-workflow-run-status').textContent, '停止中');
    assert.equal(f.controls.get('btn-stop').disabled, true);
    f.contexts[1].completion.resolve();
    await f.contexts[1].promise;
    assert.equal(f.state.isRunning, true, 'the global lifetime still includes the background run');
    assert.equal(f.controls.get('toolbar-workflow-run-status').hidden, true);
    f.activate('workflow-a');
    assert.equal(f.controls.get('toolbar-workflow-run-status').textContent, '运行中');
    assert.equal(f.controls.get('btn-stop').disabled, false);
    f.manager.abortAllWorkflowRuns('manual');
    assert.equal(f.contexts[0].signal.aborted, true, 'exit/all-stop remains available independently of the toolbar');
    f.contexts[0].completion.resolve();
    await f.contexts[0].promise;
});

test('stopping during original restoration never starts the current workflow later', async () => {
    const f = scopedToolbarFixture({ holdRestore: true });
    await f.run('workflow-a');
    assert.equal(f.controls.get('toolbar-workflow-run-status').textContent, '启动中');
    f.manager.abortWorkflowRuns({ workflowId: 'workflow-a', workflowName: 'workflow-a' });
    f.contexts[0].restore.resolve();
    await f.contexts[0].promise;
    assert.equal(f.contexts[0].calls, 0, 'late image restoration cannot undo a stop request');
    assert.equal(f.controls.get('btn-stop').disabled, true);
    assert.equal(f.controls.get('toolbar-workflow-run-status').hidden, true);
});

test('current-workflow stop cancels every independent run in that workflow only', async () => {
    const f = scopedToolbarFixture();
    await f.run('workflow-a');
    await f.run('workflow-a');
    await f.run('workflow-b');
    assert.equal(f.controls.get('toolbar-workflow-run-status').textContent, '运行中·2');
    assert.equal(f.manager.abortWorkflowRuns({ workflowId: 'workflow-a', workflowName: 'workflow-a' }), 2);
    assert.deepEqual(f.contexts.map(context=>context.signal.aborted), [true,true,false]);
    f.contexts.forEach(context=>context.completion.resolve());
    await Promise.all(f.contexts.map(context=>context.promise));
});

test('activating a background run during result settlement does not show startup again', async () => {
    const f = scopedToolbarFixture();
    f.activate('workflow-b');
    await f.run('workflow-a');
    f.contexts[0].state.activeRunCount = 0;
    f.manager.syncGlobalRunToolbarState();
    f.activate('workflow-a');
    assert.equal(f.controls.get('toolbar-workflow-run-status').textContent, '运行中', 'a session already observed running is settling, not preparing again');
    f.contexts[0].completion.resolve();
    await f.contexts[0].promise;
});

test('current-workflow Stop cancels an owned pending launch together with its active runs', async () => {
    const f = scopedToolbarFixture();
    await f.run('workflow-a'); await f.run('workflow-b');
    const preparing = new AbortController();
    Object.assign(f.state, { isRunStarting: true, runStartingWorkflowId: 'workflow-a', runStartController: preparing });
    f.manager.syncGlobalRunToolbarState();
    assert.equal(f.controls.get('toolbar-workflow-run-status').textContent, '启动中');
    assert.equal(f.manager.abortWorkflowRuns({ workflowId: 'workflow-a', workflowName: 'workflow-a' }), 2);
    assert.equal(preparing.signal.aborted, true);
    assert.deepEqual(f.contexts.map(context=>context.signal.aborted), [true,false]);
    assert.equal(f.controls.get('toolbar-workflow-run-status').textContent, '停止中');
    const nextPreparation = new AbortController();
    f.state.runStartController = nextPreparation;
    f.manager.syncGlobalRunToolbarState();
    assert.equal(f.controls.get('toolbar-workflow-run-status').textContent, '启动中', 'an old cancellation settling cannot hide a new independent launch');
    assert.equal(f.controls.get('btn-stop').disabled, false);
    f.manager.abortWorkflowRuns({ workflowId: 'workflow-a', workflowName: 'workflow-a' });
    assert.equal(nextPreparation.signal.aborted, true);
    assert.equal(f.controls.get('toolbar-workflow-run-status').textContent, '停止中');
    Object.assign(f.state, { isRunStarting: false, runStartController: null });
    f.contexts.forEach(context=>context.completion.resolve());
    await Promise.all(f.contexts.map(context=>context.promise));
});

test('Background workflow run survives activation, restores on return, and completes by Workflow identity', async () => {
    let completion = deferred();
    const updates = [];
    const runningProjections = [];
    const results = [];
    let runCount = 0;
    let disposeCount = 0;
    let latestContext = null;
    let runBehavior = () => completion.promise;
    let projectionError = null;
    let currentLabel = 'folder/original';
    const runtimeNode = {
        id: 'node-a',
        enabled: true,
        runStartedAt: 1,
        data: {}
    };
    const visibleNode = {
        id: 'node-a',
        data: {},
        el: {
            classList: { add() {}, remove() {}, toggle() {} },
            querySelector: () => null,
            querySelectorAll: () => []
        }
    };
    const state = {
        nodes: new Map([['node-a', visibleNode]]),
        connections: [],
        selectedNodes: new Set(),
        runningNodeIds: new Set(),
        runningNodeCancelHandlers: new Map(),
        providers: [],
        models: [],
        nodeDefaults: {}
    };
    const workflowManager = {
        getActiveWorkflow: () => workflowDesk.snapshot().active,
        getWorkflowNameById: (workflowId) => workflowId === 'workflow-a' ? currentLabel : '',
        updateWorkflowTabDataById: (workflowId, data) => { updates.push({ workflowId, data }); return true; },
        projectWorkflowRunningStateById: (workflowId, value) => {
            if (projectionError) throw projectionError;
            runningProjections.push({ workflowId, value });
            return true;
        },
        setWorkflowRunResultById: (workflowId, value) => { results.push({ workflowId, value }); return true; }
    };
    const api = createWorkflowRuntimeManager({
        state,
        nodeConfigs: {},
        getWorkflowManagerApi: () => workflowManager,
        getWorkflowDesk: () => workflowDesk,
        scheduleSave: () => {},
        showToast: () => {},
        addLog: () => {},
        connectionProjection: { nodeAppearanceChanged() {} },
        documentRef: {
            getElementById: () => null,
            implementation: { createHTMLDocument: () => ({}) }
        },
        windowRef: { setInterval: () => 1, clearInterval() {} },
        confirmRef: () => true,
        createRunContext: ({ workflowId, workflowName }) => (latestContext = {
            id: `${workflowId}:run`,
            workflowId,
            workflowName,
            nodeRunStarted: true,
            runResult: 'success',
            state: {
                nodes: new Map([['node-a', runtimeNode]]),
                runningNodeIds: new Set(['node-a']),
                activeRunCount: 1
            },
            activePlanNodeIds: new Set(),
            baseNodeIds: new Set(['node-a']),
            baseConnectionIds: new Set(),
            resolveExecutionPlan: () => ({ executionOrder: ['node-a'] }),
            waitForImageRestores: async () => {},
            runner: {
                async runWorkflow() { runCount += 1; await runBehavior(); },
                cancelRunningNode: () => true
            },
            serialize: () => ({ nodes: [{ id: 'node-a', result: 'done' }], connections: [] }),
            dispose() { disposeCount += 1; }
        })
    });
    const workflowDesk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async (target) => ({
            async commit() { return true; },
            async finalize() {
                api.refreshVisibleWorkflowRunState({
                    workflowId: target.workflowId,
                    workflowName: target.label
                });
            }
        }),
        mutateWorkflow: async () => ({ ok: true })
    });
    await workflowDesk.show({ workflowId: 'workflow-a', label: currentLabel });

    assert.equal(await api.runWorkflowInContext({
        workflowId: 'workflow-a',
        workflowName: currentLabel
    }, { nodes: [{ id: 'node-a' }], connections: [] }), true);
    assert.equal(runCount, 1);

    await workflowDesk.show({ workflowId: 'workflow-b', label: 'other' });
    currentLabel = 'folder/renamed';
    assert.equal(runCount, 1);
    assert.equal(
        workflowDesk.snapshot().open.find(({ workflowId }) => workflowId === 'workflow-a').running,
        true
    );

    await workflowDesk.show({ workflowId: 'workflow-a', label: currentLabel });
    assert.equal(runCount, 1);
    assert.equal(state.runningNodeIds.has('node-a'), true);

    completion.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(updates.at(-1).workflowId, 'workflow-a');
    assert.equal(
        workflowDesk.snapshot().open.find(({ workflowId }) => workflowId === 'workflow-a').running,
        false
    );
    assert.equal(results.at(-1).workflowId, 'workflow-a');
    assert.deepEqual(runningProjections.slice(0, 2), [
        { workflowId: 'workflow-a', value: true },
        { workflowId: 'workflow-a', value: false }
    ]);
    assert.equal('runResult' in workflowDesk.snapshot().open[0], false);

    completion = deferred();
    assert.equal(await api.runWorkflowInContext({
        workflowId: 'workflow-a',
        workflowName: currentLabel
    }, { nodes: [{ id: 'node-a' }], connections: [] }), true);
    await workflowDesk.restore({ workflows: [] });
    await workflowDesk.show({ workflowId: 'workflow-a', label: currentLabel });
    const projectionCountBeforeLateCompletion = runningProjections.length;
    const resultCountBeforeLateCompletion = results.length;

    completion.resolve();
    await assert.rejects(latestContext.promise, WorkflowHandleClosedError);
    assert.equal(workflowDesk.snapshot().open[0].running, false);
    assert.equal(runningProjections.length, projectionCountBeforeLateCompletion);
    assert.equal(results.length, resultCountBeforeLateCompletion);
    assert.equal(disposeCount, 2);

    runBehavior = async () => { throw new Error('runtime failed'); };
    assert.equal(await api.runWorkflowInContext({
        workflowId: 'workflow-a',
        workflowName: currentLabel
    }, { nodes: [{ id: 'node-a' }], connections: [] }), true);
    await latestContext.promise;
    assert.equal(workflowDesk.snapshot().open[0].running, false);
    assert.equal(results.at(-1).value, 'error');

    const disposedBeforeStartFailures = disposeCount;
    await assert.rejects(
        api.runWorkflowInContext({ workflowId: 'closed-workflow', workflowName: 'closed' }, {
            nodes: [{ id: 'node-a' }], connections: []
        }),
        WorkflowHandleClosedError
    );
    assert.equal(disposeCount, disposedBeforeStartFailures + 1);

    projectionError = new Error('projection failed');
    await assert.rejects(
        api.runWorkflowInContext({ workflowId: 'workflow-a', workflowName: currentLabel }, {
            nodes: [{ id: 'node-a' }], connections: []
        }),
        projectionError
    );
    projectionError = null;
    assert.equal(workflowDesk.snapshot().open[0].running, false);
    assert.equal(disposeCount, disposedBeforeStartFailures + 2);

    completion = deferred();
    runBehavior = () => completion.promise;
    assert.equal(await api.runWorkflowInContext({
        workflowId: 'workflow-a',
        workflowName: currentLabel
    }, { nodes: [{ id: 'node-a' }], connections: [] }), true);
    api.abortAllWorkflowRuns('manual');
    completion.resolve();
    await latestContext.promise;
    assert.equal(workflowDesk.snapshot().open[0].running, false);
    assert.equal(results.at(-1).value, 'error');
});
