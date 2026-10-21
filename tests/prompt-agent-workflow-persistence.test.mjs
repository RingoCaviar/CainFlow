import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkflowManagerApi } from '../js/features/workflow/workflow-manager.js';

test('Agent result updates use workflow identity and preserve the latest graph and conversation', async () => {
    const state = { workflowTabs: [], workflowOrder: [], workflowFolders: [], nodes: new Map(), connections: [], selectedNodes: new Set(), canvas: {} };
    let agentState = { version: 1, messages: [{ role: 'agent', text: 'latest active', runs: [{ runId: 'active-run', status: 'running' }] }] };
    const applied = [];
    const manager = createWorkflowManagerApi({
        state,
        nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }), serializeNodes: () => [] },
        viewportApi: { updateCanvasTransform() {} },
        addNode() {}, updateAllConnections() {}, updatePortStyles() {}, scheduleSave() {}, showToast() {}, panelManager: {},
        getPromptAgentState: () => agentState,
        applyPromptAgentState: (next, id) => { applied.push(id); agentState = next; },
        prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
        documentRef: { getElementById: () => null }, windowRef: { innerWidth: 0, innerHeight: 0 },
        localStorageRef: { getItem: () => null, setItem() {} }
    });
    await manager.activateRestoredWorkflowState({
        workflowTabs: ['a', 'b'].map((id) => ({ workflowId: id, name: `Work ${id}`, data: {
            workflowId: id, nodes: [], connections: [], promptAgent: { version: 1, messages: [{ text: `stored-${id}` }] }
        } })), activeWorkflowId: 'a', activeWorkflowName: 'Work a'
    });
    const background = state.workflowTabs.find((tab) => tab.workflowId === 'b');
    background.data.nodes.push({ id: 'recent-node', type: 'Text', text: 'new edit' });
    assert.equal(manager.mutatePromptAgentByWorkflowId('b', (current) => ({ ...current, result: 'background' })), true);
    assert.deepEqual(background.data.nodes.map((node) => node.id), ['recent-node']);
    assert.equal(background.data.promptAgent.messages[0].text, 'stored-b');
    assert.equal(background.data.promptAgent.result, 'background');
    assert.deepEqual(applied, []);
    assert.equal(manager.mutatePromptAgentByWorkflowId('a', (current) => ({ ...current, result: 'active' })), true);
    assert.equal(agentState.messages[0].text, 'latest active');
    assert.equal(agentState.result, 'active');
    assert.deepEqual(applied, ['a']);
    const before = JSON.stringify(background.data);
    assert.equal(manager.mutatePromptAgentByWorkflowId('b', () => false), false);
    assert.equal(JSON.stringify(background.data), before);
    assert.equal(manager.mutatePromptAgentByWorkflowId('removed-workflow', () => { throw new Error('must not run'); }), false);
});

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

test('copying a workflow establishes separate result owners without transferring temporary ownership', async () => {
    const originalFetch = globalThis.fetch;
    const written = [];
    const references = [];
    globalThis.fetch = async (url, options = {}) => {
        if (options.method === 'POST') {
            written.push(JSON.parse(options.body));
            return { ok: true, status: 200 };
        }
        if (url === '/api/workflows') return { ok: true, status: 200, json: async () => ({ workflows: ['Source', 'Copy'], folders: [] }) };
        throw new Error(`Unexpected request: ${url}`);
    };
    try {
        const agentState = { version: 1, messages: [], archivedMessages: [{ role: 'agent', text: '结果', runs: [{
            runId: 'run-1', targetNodeId: 'deleted-node', status: 'completed', mediaAssetKeys: ['media:result'], persistenceStatus: 'retained',
            mediaOwnershipTemporaryOwners: [{ ownerId: 'source-operation', assetKeys: ['media:result'] }]
        }] }] };
        const state = { workflowTabs: [], workflowOrder: [], workflowFolders: [], nodes: new Map(), connections: [], selectedNodes: new Set(), canvas: {} };
        const manager = createWorkflowManagerApi({
            state,
            nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }), serializeNodes: () => [] },
            viewportApi: { updateCanvasTransform() {} },
            addNode() {}, updateAllConnections() {}, updatePortStyles() {}, scheduleSave() {}, showToast() {}, panelManager: {},
            getPromptAgentState: () => agentState,
            getStorageSafetyStatus: async () => ({ storageEpoch: 'epoch' }),
            recordMediaWorkflowRevision: async () => true,
            getMediaOwnerReferenceList: async () => null,
            replaceMediaOwnerReferenceList: async (request) => { references.push(request); return { status: 'committed' }; },
            prepareDetachedEditorView: async () => ({ async commit() { return true; } }),
            documentRef: { getElementById: () => null }, windowRef: { innerWidth: 0, innerHeight: 0 },
            localStorageRef: { getItem: () => null, setItem() {} }
        });
        await manager.activateRestoredWorkflowState({
            workflowTabs: [{ workflowId: 'source', name: 'Source', data: { workflowId: 'source', nodes: [], connections: [], promptAgent: agentState } }],
            activeWorkflowId: 'source', activeWorkflowName: 'Source'
        });
        const result = await manager.copyWorkflowById('source', 'Copy');
        assert.ok(result.workflowId);
        const copied = written[0];
        assert.notEqual(copied.workflowId, 'source');
        const copiedRun = copied.promptAgent.archivedMessages[0].runs[0];
        assert.deepEqual(copiedRun.mediaAssetKeys, ['media:result']);
        assert.equal(copiedRun.mediaOwnershipTemporaryOwners, undefined);
        assert.ok(references.some((entry) => entry.workflowId === copied.workflowId && entry.owner.ownerType === 'prompt-agent-result' && entry.owner.ownerId === 'run-1'));
        assert.equal(agentState.archivedMessages[0].runs[0].mediaOwnershipTemporaryOwners[0].ownerId, 'source-operation');
    } finally { globalThis.fetch = originalFetch; }
});
