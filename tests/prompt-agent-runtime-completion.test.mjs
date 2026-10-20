import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptAgentExecutionAdapter } from '../js/features/prompt-agent/prompt-agent-execution-adapter.js';
import { createWorkflowRuntimeManager } from '../js/features/workflow/workflow-runtime-manager.js';

function createHarness({
    waitForImageRestores = async () => {}, waitForPendingImageAssetSaves, noPlan = false,
    releaseGeneratedImages = false, getImageAssetList
} = {}) {
    let finish;
    const completion = new Promise((resolve) => { finish = resolve; });
    const runtimeNode = { id: 'image-1', type: 'ImageGenerate', enabled: true, data: { imageList: ['old-runtime-image'] } };
    const state = {
        nodes: new Map([[runtimeNode.id, { ...runtimeNode, data: { imageList: ['old-visible-image'] } }]]),
        runningNodeIds: new Set(), runningNodeCancelHandlers: new Map()
    };
    const workflow = { workflowId: 'workflow-a', workflowName: '测试场景' };
    const workflowData = { nodes: [{ id: runtimeNode.id }], connections: [] };
    let activeWorkflowId = workflow.workflowId;
    let context;
    let sequence = 0;
    const runtime = createWorkflowRuntimeManager({
        state, nodeConfigs: {},
        documentRef: { getElementById: () => null },
        windowRef: { setInterval: () => 1, clearInterval() {} },
        confirmRef: () => true,
        showToast() {}, addLog() {}, scheduleSave() {},
        getImageAssetList,
        getWorkflowDesk: () => ({ workflow: () => ({ runningChanged() {} }) }),
        getWorkflowManagerApi: () => ({
            getActiveWorkflow: () => ({ workflowId: activeWorkflowId, label: workflow.workflowName }),
            updateWorkflowTabDataById() {}, projectWorkflowRunningStateById() {}, setWorkflowRunResultById() {}
        }),
        createRunContext: () => {
            const run = {
                id: `run-${++sequence}`, ...workflow, nodeRunStarted: true,
                state: { nodes: new Map([[runtimeNode.id, runtimeNode]]), runningNodeIds: new Set([runtimeNode.id]) },
                activePlanNodeIds: new Set(), baseNodeIds: new Set([runtimeNode.id]), baseConnectionIds: new Set(),
                resolveExecutionPlan: () => noPlan ? null : ({ executionOrder: [runtimeNode.id] }),
                waitForImageRestores, waitForPendingImageAssetSaves,
                runner: {
                    async runWorkflow() {
                        const result = await completion;
                        if (result instanceof Error) throw result;
                        if (result.outcome === 'completed') runtimeNode.data.imageList = ['data:image/png;base64,NEW_RESULT'];
                        if (result.outcome === 'completed' && releaseGeneratedImages) {
                            delete runtimeNode.data.imageList;
                            runtimeNode.data.mediaAssetKeys = ['media:result-1', 'media:result-2'];
                            runtimeNode.data.imageMemoryReleased = true;
                        }
                        if (result.outcome === 'failed') runtimeNode.executionFailure = { message: '供应商拒绝了本次请求' };
                        runtimeNode.isSucceeded = result.outcome === 'completed';
                        run.state.runningNodeIds.clear();
                        return result;
                    },
                    cancelRunningNode: () => true
                },
                serialize: () => ({ nodes: [runtimeNode], connections: [] }),
                dispose() { run.state.nodes.clear(); }
            };
            context = run;
            return run;
        }
    });
    const adapter = createPromptAgentExecutionAdapter({
        state, nodeAdapter: { applyPromptPlan: () => true },
        runWorkflow: (input) => runtime.runWorkflowInContext(workflow, workflowData, input, { waitForCompletion: true })
    });
    return {
        adapter, runtime, state, workflow, workflowData, finish, context: () => context,
        switchWorkflow() {
            activeWorkflowId = 'workflow-b';
            state.nodes = new Map([[runtimeNode.id, { ...runtimeNode, data: { imageList: ['other-workflow-image'] } }]]);
        }
    };
}

test('Agent stays pending while the actual background runtime generates, then returns this run’s images', async () => {
    const harness = createHarness();
    let status = '正在生成…';
    let result;
    const generating = harness.adapter.applyAndGenerate({ targetNodeId: 'image-1', prompt: '新画面', parameters: {} })
        .then((value) => { result = value; status = '生成完成'; }, (error) => { status = `生成失败：${error.message}`; });
    await new Promise((resolve) => setImmediate(resolve));
    try {
        assert.equal(harness.context().state.runningNodeIds.has('image-1'), true);
        assert.equal(status, '正在生成…', 'Agent must not report failure while its node is still running');
    } finally {
        harness.finish({ started: true, executed: true, reason: 'finished', outcome: 'completed' });
        await harness.context().promise;
        await generating;
    }
    assert.deepEqual(result, { status: 'completed', images: ['data:image/png;base64,NEW_RESULT'] });
    assert.equal(harness.context().state.nodes.size, 0, 'completion output must survive runtime disposal');
});

test('Agent completion stays bound to its run when the visible workflow changes', async () => {
    const harness = createHarness();
    const generating = harness.adapter.applyAndGenerate({ targetNodeId: 'image-1' });
    await new Promise((resolve) => setImmediate(resolve));
    harness.switchWorkflow();
    harness.finish({ started: true, executed: true, reason: 'finished', outcome: 'completed' });
    assert.deepEqual(await generating, { status: 'completed', images: ['data:image/png;base64,NEW_RESULT'] });
    assert.deepEqual(harness.state.nodes.get('image-1').data.imageList, ['other-workflow-image']);
});

test('completed batches remain available when the runner has released the in-memory images', async () => {
    const reads = [];
    const harness = createHarness({
        releaseGeneratedImages: true,
        getImageAssetList: async (key) => {
            reads.push(key);
            return [`data:image/png;base64,${key.endsWith('1') ? 'FIRST' : 'SECOND'}`];
        }
    });
    const generating = harness.adapter.applyAndGenerate({ targetNodeId: 'image-1' });
    harness.switchWorkflow();
    harness.finish({ started: true, executed: true, reason: 'finished', outcome: 'completed' });
    assert.deepEqual(await generating, {
        status: 'completed', images: ['data:image/png;base64,FIRST', 'data:image/png;base64,SECOND']
    });
    assert.deepEqual(reads, ['media:result-1', 'media:result-2']);
});

test('unavailable cached previews do not misreport a completed generation as failed', async () => {
    const harness = createHarness({
        releaseGeneratedImages: true,
        getImageAssetList: async () => { throw new Error('缓存读取暂不可用'); }
    });
    const generating = harness.adapter.applyAndGenerate({ targetNodeId: 'image-1' });
    harness.finish({ started: true, executed: true, reason: 'finished', outcome: 'completed' });
    assert.deepEqual(await generating, { status: 'completed', images: [] });
});

test('Agent waits for result persistence before reporting completion', async () => {
    let finishSaving;
    const saving = new Promise((resolve) => { finishSaving = resolve; });
    const harness = createHarness({ waitForPendingImageAssetSaves: () => saving });
    let completed = false;
    const generating = harness.adapter.applyAndGenerate({ targetNodeId: 'image-1' }).then(() => { completed = true; });
    harness.finish({ started: true, executed: true, reason: 'finished', outcome: 'completed' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    finishSaving();
    await generating;
    assert.equal(completed, true);
});

test('real runtime completion forwards failure, timeout and cancellation without exposing stale images', async () => {
    for (const outcome of ['failed', 'timeout', 'stopped', 'cancelled']) {
        const harness = createHarness();
        const generating = harness.adapter.applyAndGenerate({ targetNodeId: 'image-1' });
        harness.finish({ started: true, executed: true, reason: outcome === 'failed' ? 'error' : 'finished', outcome });
        if (outcome === 'failed' || outcome === 'timeout') {
            await assert.rejects(generating, outcome === 'failed' ? /供应商拒绝了本次请求/ : /生成超时/);
        } else {
            assert.deepEqual(await generating, { status: 'stopped', images: [] });
        }
    }
});

test('runtime preparation errors reach Agent instead of being swallowed or reported as success', async () => {
    const harness = createHarness({ waitForImageRestores: async () => { throw new Error('参考图原始文件不可用'); } });
    await assert.rejects(harness.adapter.applyAndGenerate({ targetNodeId: 'image-1' }), /参考图原始文件不可用/);
    assert.equal(harness.context().state.nodes.size, 0);
});

test('ordinary canvas launches still return immediately and overlapping Agent launches are rejected', async () => {
    const harness = createHarness();
    assert.equal(await harness.runtime.runWorkflowInContext(harness.workflow, harness.workflowData), true);
    const running = harness.context();
    assert.equal(running.state.runningNodeIds.has('image-1'), true);
    assert.deepEqual(await harness.runtime.runWorkflowInContext(
        harness.workflow, harness.workflowData, null, { waitForCompletion: true }
    ), { started: false, executed: false, reason: 'already-running' });
    harness.finish({ started: true, executed: true, reason: 'finished', outcome: 'completed' });
    await running.promise;
});

test('a rejected execution plan cannot be reported as completed', async () => {
    const harness = createHarness({ noPlan: true });
    await assert.rejects(harness.adapter.applyAndGenerate({ targetNodeId: 'image-1' }), /检查节点配置/);
    assert.equal(harness.context().state.nodes.size, 0);
});
