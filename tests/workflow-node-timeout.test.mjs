import assert from 'node:assert/strict';
import test from 'node:test';

import { clearNodeExecutionFailure, createWorkflowRunnerApi, showNodeExecutionFailure } from '../js/features/execution/workflow-runner.js';

function createNodeElement() {
    return {
        classList: { add() {}, remove() {}, toggle() {} },
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 240 })
    };
}

test('runner aborts an individual node at its own timeout and reports a node timeout', async () => {
    const node = { id: 'image-1', type: 'ImageSave', enabled: true, data: {}, el: createNodeElement() };
    const state = {
        nodes: new Map([[node.id, node]]),
        connections: [],
        providers: [],
        models: [],
        selectedNodes: new Set(),
        requestTimeoutEnabled: true,
        requestTimeoutSeconds: 1
    };
    const logs = [];
    let receivedSignal = null;
    const api = createWorkflowRunnerApi({
        state,
        nodeConfigs: { ImageSave: { title: '保存图片', outputs: [] } },
        documentRef: {
            defaultView: { requestAnimationFrame: (callback) => callback() },
            getElementById: () => null
        },
        confirmRef: () => true,
        resolveExecutionPlan: () => ({
            mode: 'all',
            nodeIds: [node.id],
            executionOrder: [node.id],
            scopeNodeSet: new Set([node.id]),
            inputConnectionsByNode: { [node.id]: [] },
            incomingConnectionsByNode: { [node.id]: [] },
            externalInputsByNode: {}
        }),
        normalizeRunOptions: () => ({ mode: 'all' }),
        getCachedOutputValue: () => undefined,
        executeNode: (_node, _inputs, signal) => new Promise((_resolve, reject) => {
            receivedSignal = signal;
            signal.addEventListener('abort', () => {
                const error = new Error('Node run aborted');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        }),
        addNode: () => null,
        generateId: () => 'unused',
        showToast: () => {},
        addLog: (...entry) => logs.push(entry),
        scheduleSave: () => {},
        updateAllConnections: () => {},
        updatePortStyles: () => {},
        getAbortMessage: () => '已停止',
        playNotificationSound: () => {}
    });

    const result = await api.runWorkflow();

    assert.equal(receivedSignal.aborted, true);
    assert.equal(result.reason, 'error');
    assert.ok(logs.some((entry) => entry[0] === 'error' && entry[2] === '节点运行超时（1 秒）'));
});

test('node execution failure marks the node and its named input port until cleared', () => {
    const classes = new Set();
    const portClasses = new Set();
    const indicatorClasses = new Set(['hidden']);
    const port = { classList: { add: (name) => portClasses.add(name), remove: (name) => portClasses.delete(name) } };
    const indicator = { classList: { add: (name) => indicatorClasses.add(name), remove: (name) => indicatorClasses.delete(name) }, title: '' };
    const node = {
        id: 'compare-1', type: 'ImageCompare', enabled: true, data: {},
        el: {
            classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
            querySelector: (selector) => selector.includes('imageB') ? port : (selector === '.node-failure-indicator' ? indicator : null),
            querySelectorAll: (selector) => selector === '.node-port.execution-error' ? [port] : [],
            getBoundingClientRect: () => ({ width: 240 })
        }
    };
    const error = new Error('B 输入未连接图片');
    error.inputPort = 'imageB';
    showNodeExecutionFailure(node, error);

    assert.equal(node.isFailed, true);
    assert.equal(node.executionFailure.message, 'B 输入未连接图片');
    assert.ok(classes.has('error'));
    assert.ok(portClasses.has('execution-error'));
    assert.equal(indicatorClasses.has('hidden'), false);
    clearNodeExecutionFailure(node);
    assert.equal(node.isFailed, false);
    assert.equal(classes.has('error'), false);
    assert.equal(portClasses.has('execution-error'), false);
    assert.equal(indicatorClasses.has('hidden'), true);
});
