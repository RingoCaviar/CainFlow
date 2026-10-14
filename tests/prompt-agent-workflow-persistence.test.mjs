import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkflowManagerApi } from '../js/features/workflow/workflow-manager.js';

test('active workflow snapshots own Prompt Agent conversation state', async () => {
    const state = {
        workflowTabs: [], workflowOrder: [], workflowFolders: [],
        nodes: new Map(), connections: [], selectedNodes: new Set(),
        canvas: { x: 0, y: 0, zoom: 1 }
    };
    const agentState = {
        version: 1, memory: '电影感', panelWidth: 520,
        messages: [{ role: 'user', text: '城市夜景' }]
    };
    const manager = createWorkflowManagerApi({
        state,
        nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }), serializeNodes: () => [] },
        viewportApi: { updateCanvasTransform() {} },
        addNode() {}, updateAllConnections() {}, updatePortStyles() {}, scheduleSave() {}, showToast() {},
        panelManager: {},
        getPromptAgentState: () => agentState,
        prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
        documentRef: { getElementById: () => null },
        windowRef: { innerWidth: 0, innerHeight: 0 },
        localStorageRef: { getItem: () => null, setItem() {} }
    });
    await manager.activateRestoredWorkflowState({
        workflowTabs: [{
            workflowId: 'workflow-a', name: 'Agent Work',
            data: { workflowId: 'workflow-a', nodes: [], connections: [], promptAgent: { version: 1, memory: 'old', messages: [] } }
        }],
        activeWorkflowId: 'workflow-a', activeWorkflowName: 'Agent Work'
    });

    assert.deepEqual(manager.getActiveWorkflowSnapshot().promptAgent, agentState);

    manager.updateWorkflowTabDataById('workflow-a', {
        workflowId: 'workflow-a', nodes: [], connections: [], version: '1.3'
    }, { mergeRunResults: true });
    assert.deepEqual(manager.getActiveWorkflowSnapshot().promptAgent, agentState);
});
