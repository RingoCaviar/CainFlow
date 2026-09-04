import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkflowDesk } from '../js/features/workflow/workflow-desk.js';
import { createWorkflowRuntimeManager } from '../js/features/workflow/workflow-runtime-manager.js';

function element(value = '') {
    return { value, textContent: '', innerHTML: '', disabled: true, className: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, querySelectorAll: () => [] };
}

test('runWorkflowInContext projects the latest running video task over stale visible information', async () => {
    let finishRun;
    const pendingRun = new Promise((resolve) => { finishRun = resolve; });
    const visibleNode = { id: 'video', type: 'VideoGenerate', enabled: true, data: { videoId: 'old-task', videoStatusText: '旧任务' }, el: element() };
    const runtimeNode = { id: 'video', type: 'VideoGenerate', enabled: true, data: {} };
    const elements = new Map([
        ['video-video-status', element()],
        ['video-response', element()],
        ['video-resume-video-id', element('old-task')],
        ['video-resume-video', element()]
    ]);
    const state = { nodes: new Map([[visibleNode.id, visibleNode]]), connections: [], selectedNodes: new Set(), runningNodeIds: new Set(), runningNodeCancelHandlers: new Map(), providers: [], models: [], nodeDefaults: {} };
    let runtimeManager;
    const workflowDesk = createWorkflowDesk({
        resolveSelection: async (selection) => selection,
        prepareEditorView: async () => ({ async commit() { return true; } }),
        mutateWorkflow: async () => ({ ok: true })
    });
    runtimeManager = createWorkflowRuntimeManager({
        state,
        nodeConfigs: { VideoGenerate: { title: '视频生成' } },
        getWorkflowManagerApi: () => ({
            getActiveWorkflow: () => workflowDesk.snapshot().active,
            updateWorkflowTabDataById: () => true,
            projectWorkflowRunningStateById: () => true,
            setWorkflowRunResultById: () => true
        }),
        getWorkflowDesk: () => workflowDesk,
        confirmRef: () => true,
        scheduleSave: () => {}, showToast: () => {}, addLog: () => {},
        connectionProjection: { nodeAppearanceChanged() {}, nodeGeometryChanged() {} },
        documentRef: { getElementById: (id) => elements.get(id) || null, implementation: { createHTMLDocument: () => ({}) } },
        windowRef: { setInterval: () => 1, clearInterval() {} },
        createRunContext: ({ workflowId, workflowName }) => ({
            id: `${workflowId}:run`, workflowId, workflowName,
            state: { nodes: new Map([[runtimeNode.id, runtimeNode]]), runningNodeIds: new Set(), activeRunCount: 1 },
            activePlanNodeIds: new Set(), baseNodeIds: new Set([runtimeNode.id]), baseConnectionIds: new Set(),
            resolveExecutionPlan: () => ({ executionOrder: [runtimeNode.id], nodeIds: [runtimeNode.id] }),
            waitForImageRestores: async () => {},
            runner: {
                async runWorkflow() {
                    runtimeNode.data = { videoId: 'new-task', videoStatus: 'queued', videoStatusText: '轮询中：任务 new-task' };
                    runtimeManager.applyVisibleNodeRunState({ workflowId, workflowName }, { nodeId: runtimeNode.id, status: 'result-updated', running: true });
                    await pendingRun;
                },
                cancelRunningNode: () => true
            },
            serialize: () => ({ nodes: [], connections: [] }),
            dispose() {}
        })
    });
    await workflowDesk.show({ workflowId: 'workflow-video', label: 'Video' });

    assert.equal(await runtimeManager.runWorkflowInContext({ workflowId: 'workflow-video', workflowName: 'Video' }, { nodes: [{ id: 'video' }], connections: [] }), true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(visibleNode.data.videoId, 'new-task');
    assert.equal(elements.get('video-video-status').textContent, '轮询中：任务 new-task');
    assert.equal(elements.get('video-resume-video-id').value, 'new-task');
    assert.equal(elements.get('video-resume-video').disabled, false);
    finishRun();
});
