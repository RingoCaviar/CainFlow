import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkflowDesk } from '../js/features/workflow/workflow-desk.js';
import { createWorkflowRuntimeManager } from '../js/features/workflow/workflow-runtime-manager.js';

function element(value = '') {
    return {
        value,
        textContent: '',
        innerHTML: '',
        disabled: true,
        className: '',
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        querySelector: () => null,
        querySelectorAll: () => []
    };
}

test('runtime content projections refit every generation card type', async () => {
    for (const [type, data, elements] of [
        ['VideoGenerate', { videoId: 'task-1', videoStatus: 'queued', videoStatusText: '轮询状态更新后的较长说明' }, [
            ['node-video-status', element()], ['node-response', element()], ['node-resume-video-id', element()], ['node-resume-video', element()]
        ]],
        ['ImageGenerate', { imageTaskId: 'task-2', imageTaskStatus: 'queued', imageTaskStatusText: '图片异步状态更新后的较长说明' }, [
            ['node-image-async-status', element()], ['node-image-async-response', element()], ['node-resume-image-id', element()], ['node-resume-image', element()], ['node-generation-progress', element()]
        ]],
        ['TextChat', { text: 'ignored' }, [
            ['node-response', element()], ['node-generation-progress', element()]
        ]]
    ]) {
        let finishRun;
        const pendingRun = new Promise((resolve) => { finishRun = resolve; });
        const visibleNode = { id: 'node', type, enabled: true, data: {}, el: element() };
        const runtimeNode = { id: 'node', type, enabled: true, data };
        const state = { nodes: new Map([[visibleNode.id, visibleNode]]), connections: [], selectedNodes: new Set(), runningNodeIds: new Set(), runningNodeCancelHandlers: new Map(), providers: [], models: [], nodeDefaults: {} };
        const fittedNodeIds = [];
        const workflowDesk = createWorkflowDesk({
            resolveSelection: async (selection) => selection,
            prepareEditorView: async () => ({ async commit() { return true; } }),
            mutateWorkflow: async () => ({ ok: true })
        });
        let manager;
        manager = createWorkflowRuntimeManager({
            state,
            nodeConfigs: { [type]: { title: type } },
            getWorkflowManagerApi: () => ({ getActiveWorkflow: () => workflowDesk.snapshot().active, updateWorkflowTabDataById() {}, projectWorkflowRunningStateById() {}, setWorkflowRunResultById() {} }),
            getWorkflowDesk: () => workflowDesk,
            scheduleSave() {}, showToast() {}, addLog() {},
            fitNodeToContent: (nodeId) => fittedNodeIds.push(nodeId),
            connectionProjection: { nodeAppearanceChanged() {}, nodeGeometryChanged() {} },
            documentRef: { getElementById: (id) => new Map(elements).get(id) || null, implementation: { createHTMLDocument: () => ({}) } },
            windowRef: { requestAnimationFrame: (callback) => { callback(); return 1; }, setInterval: () => 1, clearInterval() {}, setTimeout: (callback) => { callback(); return 1; } },
            confirmRef: () => true,
            createRunContext: ({ workflowId, workflowName }) => ({
                id: `${workflowId}:run`, workflowId, workflowName,
                state: { nodes: new Map([[runtimeNode.id, runtimeNode]]), runningNodeIds: new Set(), activeRunCount: 1 },
                activePlanNodeIds: new Set(), baseNodeIds: new Set([runtimeNode.id]), baseConnectionIds: new Set(),
                resolveExecutionPlan: () => ({ executionOrder: [runtimeNode.id], nodeIds: [runtimeNode.id] }),
                waitForImageRestores: async () => {},
                runner: { async runWorkflow() { manager.applyVisibleNodeRunState({ workflowId, workflowName }, { nodeId: runtimeNode.id, status: 'result-updated', running: true }); await pendingRun; }, cancelRunningNode: () => true },
                serialize: () => ({ nodes: [], connections: [] }), dispose() {}
            })
        });
        await workflowDesk.show({ workflowId: `workflow-${type}`, label: type });
        await manager.runWorkflowInContext({ workflowId: `workflow-${type}`, workflowName: type }, { nodes: [{ id: 'node' }], connections: [] });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(fittedNodeIds, ['node'], `${type} should refit after its visible result changes`);
        finishRun();
    }
});
