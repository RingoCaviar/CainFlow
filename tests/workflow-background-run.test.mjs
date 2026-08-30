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
