import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeControllerApi } from '../js/features/ui/runtime-controller.js';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';

test('Ctrl+F5 reloads after the session save omits a stale Open Workflow record', async () => {
    let keydownHandler = null;
    let replacementUrl = '';
    let workflowSaveCalls = 0;
    const toasts = [];
    const classList = { add() {}, remove() {}, contains() { return false; }, toggle() {} };
    const documentRef = {
        body: { classList },
        activeElement: null,
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        addEventListener(type, handler) { if (type === 'keydown') keydownHandler = handler; },
        documentElement: { style: { setProperty() {} } },
        defaultView: {}
    };
    const windowRef = {
        location: {
            href: 'http://localhost/',
            replace(url) { replacementUrl = url; }
        },
        addEventListener() {},
        getSelection: () => ({ toString: () => '' }),
        getComputedStyle: () => ({ getPropertyValue: () => '', display: 'block', visibility: 'visible' })
    };
    const noOp = () => {};
    const state = {
        isRunning: false,
        selectedNodes: new Set(),
        nodes: new Map(),
        connections: [],
        workflowTabs: [
            { workflowId: 'workflow-present', name: 'Present', data: { workflowId: 'workflow-present', nodes: [], connections: [] } }
        ],
        workflowOrder: [],
        workflowFolders: [],
        workflowSidebarWidth: 320,
        themeId: 'light',
        globalAnimationEnabled: true,
        undoStack: []
    };
    const sessionManager = createSessionManagerApi({
        state,
        storageKey: 'session',
        nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }) },
        localStorageRef: { setItem() {} },
        documentRef,
        showToast() {},
        addNode() {},
        updateAllConnections() {},
        updatePortStyles() {},
        getWorkflowSnapshot: () => ({
            active: { workflowId: 'workflow-present', label: 'Present' },
            open: [
                { workflowId: 'workflow-stale', label: 'Stale', pendingExplicitSave: false, running: false },
                { workflowId: 'workflow-present', label: 'Present', pendingExplicitSave: false, running: false }
            ]
        })
    });
    createRuntimeControllerApi({
        state,
        canvasContainer: { classList, contains: () => false },
        contextMenu: { classList },
        selectionApi: { selectAllNodes() {} },
        runWorkflow: noOp,
        saveState: sessionManager.saveState,
        saveCurrentWorkflow: async () => { workflowSaveCalls += 1; return true; },
        showToast: (message) => toasts.push(message),
        exportWorkflow: noOp,
        undo: noOp,
        copySelectedNode: noOp,
        pasteNode: noOp,
        clipboardControllerApi: { markNativeClipboardEvent() {} },
        removeNode: noOp,
        zoomToFit: noOp,
        scheduleSave: noOp,
        closeModal: noOp,
        documentRef,
        windowRef
    }).initRuntimeBindings();

    keydownHandler({ ctrlKey: true, metaKey: false, key: 'F5', code: 'F5', preventDefault() {}, target: documentRef.body });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(workflowSaveCalls, 1);
    assert.match(replacementUrl, /__hard_reload=/);
    assert.deepEqual(toasts, []);
});

test('Ctrl+F5 reloads from the durable session when explicit workflow saving fails', async () => {
    let keydownHandler = null;
    let replacementUrl = '';
    const toasts = [];
    const classList = { add() {}, remove() {}, contains() { return false; }, toggle() {} };
    const documentRef = {
        body: { classList }, activeElement: null, querySelector: () => null, querySelectorAll: () => [],
        getElementById: () => null,
        addEventListener(type, handler) { if (type === 'keydown') keydownHandler = handler; },
        documentElement: { style: { setProperty() {} } }, defaultView: {}
    };
    const windowRef = {
        location: { href: 'http://localhost/', replace(url) { replacementUrl = url; } },
        addEventListener() {}, getSelection: () => ({ toString: () => '' }),
        getComputedStyle: () => ({ getPropertyValue: () => '', display: 'block', visibility: 'visible' })
    };
    const noOp = () => {};
    createRuntimeControllerApi({
        state: { isRunning: false, selectedNodes: new Set() },
        canvasContainer: { classList, contains: () => false }, contextMenu: { classList },
        selectionApi: { selectAllNodes() {} }, runWorkflow: noOp, saveState: () => true,
        saveCurrentWorkflow: async () => false, showToast: (message, type) => toasts.push({ message, type }),
        exportWorkflow: noOp, undo: noOp, copySelectedNode: noOp, pasteNode: noOp,
        clipboardControllerApi: { markNativeClipboardEvent() {} }, removeNode: noOp, zoomToFit: noOp,
        scheduleSave: noOp, closeModal: noOp, documentRef, windowRef
    }).initRuntimeBindings();

    keydownHandler({ ctrlKey: true, metaKey: false, key: 'F5', code: 'F5', preventDefault() {}, target: documentRef.body });
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(replacementUrl, /__hard_reload=/);
    assert.deepEqual(toasts, [{
        message: '工作流文件保存失败；已保存会话并继续强制刷新', type: 'warning'
    }]);
});
