import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createWorkflowRunnerApi } from '../js/features/execution/workflow-runner.js';

function createNodeElement() {
    return {
        classList: { add() {}, remove() {}, toggle() {} },
        dataset: {},
        appendChild() {},
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 240 })
    };
}

test('runWorkflow passes every successful concurrent video result to the save node', async () => {
    const promptNode = {
        id: 'prompts', type: 'Text', enabled: true, data: { texts: ['first', 'second'] }, el: createNodeElement()
    };
    const videoNode = {
        id: 'video', type: 'VideoGenerate', enabled: true, data: {}, el: createNodeElement()
    };
    const saveNode = {
        id: 'save', type: 'ImageSave', enabled: true, data: {}, el: createNodeElement()
    };
    const connections = [
        {
            id: 'prompt-connection', type: 'text',
            from: { nodeId: promptNode.id, port: 'text', type: 'text' },
            to: { nodeId: videoNode.id, port: 'prompt', type: 'text' }
        },
        {
            id: 'video-connection', type: 'video',
            from: { nodeId: videoNode.id, port: 'video', type: 'video' },
            to: { nodeId: saveNode.id, port: 'video', type: 'video' }
        }
    ];
    const state = {
        nodes: new Map([[promptNode.id, promptNode], [videoNode.id, videoNode], [saveNode.id, saveNode]]),
        connections,
        providers: [], models: [], selectedNodes: new Set(),
        runningNodeIds: new Set(), runningNodeCancelHandlers: new Map(),
        concurrentRequestMode: true
    };
    let savedVideos = null;
    const executedNodeTypes = [];
    const inputConnectionsByNode = {
        [promptNode.id]: [],
        [videoNode.id]: [connections[0]],
        [saveNode.id]: [connections[1]]
    };
    const documentRef = {
        defaultView: {
            requestAnimationFrame: (callback) => callback(),
            addEventListener() {},
            removeEventListener() {}
        },
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement: () => createNodeElement(),
        addEventListener() {},
        removeEventListener() {},
        body: createNodeElement()
    };
    const executionCore = createExecutionCoreApi({
        state,
        nodeConfigs: {},
        documentRef,
        windowRef: documentRef.defaultView,
        syncImageSaveNode: async () => {},
        autoSaveToDir: async (_id, payload) => { savedVideos = payload.videos; },
        refreshDependentImageResizePreviews: async () => {},
        showToast: () => {}, addLog: () => {}, fitNodeToContent: () => {},
        getAbortMessage: () => ''
    });
    const api = createWorkflowRunnerApi({
        state,
        nodeConfigs: {
            Text: { title: '文本', outputs: [{ name: 'text', type: 'text' }] },
            VideoGenerate: { title: '视频生成', outputs: [{ name: 'video', type: 'video' }] },
            ImageSave: { title: '保存', outputs: [] }
        },
        documentRef,
        confirmRef: () => true,
        resolveExecutionPlan: () => ({
            mode: 'all',
            nodeIds: [promptNode.id, videoNode.id, saveNode.id],
            executionOrder: [promptNode.id, videoNode.id, saveNode.id],
            scopeNodeSet: new Set([promptNode.id, videoNode.id, saveNode.id]),
            inputConnectionsByNode,
            incomingConnectionsByNode: inputConnectionsByNode,
            externalInputsByNode: {}
        }),
        normalizeRunOptions: () => ({ mode: 'all' }),
        getCachedOutputValue: (node, port) => {
            if (port === 'text') return node.data.texts;
            if (port === 'video') return node.data.videos || node.data.video;
            return undefined;
        },
        executeNode: async (node, inputs) => {
            executedNodeTypes.push(node.type);
            if (node.type === 'Text') {
                node.data.texts = ['first', 'second'];
                return;
            }
            if (node.type === 'VideoGenerate') {
                return {
                    video: {
                        id: `result-${inputs.prompt}`,
                        url: `https://example.test/${inputs.prompt}.mp4`,
                        assetKey: `media:${inputs.prompt}`
                    }
                };
            }
            return executionCore.executeNode(node, inputs);
        },
        addNode: () => null,
        generateId: () => 'unused',
        showToast: () => {}, addLog: () => {}, scheduleSave: () => {},
        updateAllConnections: () => {}, updatePortStyles: () => {},
        getAbortMessage: () => '已停止', playNotificationSound: () => {}
    });

    const result = await api.runWorkflow();

    assert.equal(result.reason, 'finished');
    assert.deepEqual(executedNodeTypes, ['Text', 'VideoGenerate', 'VideoGenerate', 'ImageSave']);
    assert.deepEqual(savedVideos, [
        { id: 'result-first', url: 'https://example.test/first.mp4', assetKey: 'media:first' },
        { id: 'result-second', url: 'https://example.test/second.mp4', assetKey: 'media:second' }
    ]);
});
