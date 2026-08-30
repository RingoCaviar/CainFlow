import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowRuntimeManager } from '../js/features/workflow/workflow-runtime-manager.js';

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

test('Background workflow run survives activation, restores on return, and completes by Workflow identity', async () => {
    const completion = deferred();
    const updates = [];
    const running = [];
    const results = [];
    let runCount = 0;
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
        activeWorkflowId: 'workflow-a',
        activeWorkflowName: currentLabel,
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
        getWorkflowNameById: (workflowId) => workflowId === 'workflow-a' ? currentLabel : '',
        updateWorkflowTabDataById: (workflowId, data) => { updates.push({ workflowId, data }); return true; },
        setWorkflowRunningStateById: (workflowId, value) => { running.push({ workflowId, value }); return true; },
        setWorkflowRunResultById: (workflowId, value) => { results.push({ workflowId, value }); return true; }
    };
    const api = createWorkflowRuntimeManager({
        state,
        nodeConfigs: {},
        getWorkflowManagerApi: () => workflowManager,
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
        createRunContext: ({ workflowId, workflowName }) => ({
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
                async runWorkflow() { runCount += 1; await completion.promise; },
                cancelRunningNode: () => true
            },
            serialize: () => ({ nodes: [{ id: 'node-a', result: 'done' }], connections: [] }),
            dispose() {}
        })
    });

    assert.equal(await api.runWorkflowInContext({
        workflowId: 'workflow-a',
        workflowName: currentLabel
    }, { nodes: [{ id: 'node-a' }], connections: [] }), true);
    assert.equal(runCount, 1);

    state.activeWorkflowId = 'workflow-b';
    state.activeWorkflowName = 'other';
    currentLabel = 'folder/renamed';
    assert.equal(runCount, 1);
    assert.deepEqual(running[0], { workflowId: 'workflow-a', value: true });

    state.activeWorkflowId = 'workflow-a';
    state.activeWorkflowName = currentLabel;
    api.refreshVisibleWorkflowRunState({ workflowId: 'workflow-a', workflowName: currentLabel });
    assert.equal(runCount, 1);
    assert.equal(state.runningNodeIds.has('node-a'), true);

    completion.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(updates.at(-1).workflowId, 'workflow-a');
    assert.equal(running.at(-1).workflowId, 'workflow-a');
    assert.equal(running.at(-1).value, false);
    assert.equal(results.at(-1).workflowId, 'workflow-a');
});
