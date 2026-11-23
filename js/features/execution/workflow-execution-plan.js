import { getIncludedAutoSaveNodeIds } from './generation-save-targets.js';

export function resolveWorkflowExecutionPlan(state, runOptions, {
    isFixedTextChatWithCachedResult = () => false,
    notify = () => {}
} = {}) {
    const { nodes, connections } = state;
    const { mode, targetNodeId, selectedNodeIds } = runOptions;
    const forceRunNodeId = mode === 'target-node' ? targetNodeId : runOptions.refreshTextChatNodeId;
    let scopeNodeSet;
    if (mode === 'target-node') {
        if (!targetNodeId) {
            notify('未找到目标节点', 'error');
            return null;
        }
        scopeNodeSet = new Set();
        function visitUpstream(nodeId) {
            if (scopeNodeSet.has(nodeId) || !nodes.has(nodeId)) return;
            scopeNodeSet.add(nodeId);
            if (nodeId !== targetNodeId && isFixedTextChatWithCachedResult(nodes.get(nodeId))) return;
            for (const connection of connections) {
                if (connection.to.nodeId === nodeId) visitUpstream(connection.from.nodeId);
            }
        }
        visitUpstream(targetNodeId);
    } else if (mode === 'selected-only') {
        scopeNodeSet = new Set(selectedNodeIds);
        if (!scopeNodeSet.size) {
            notify('请先选择要运行的节点', 'warning');
            return null;
        }
    } else {
        scopeNodeSet = new Set(nodes.keys());
    }

    if (!scopeNodeSet.size) {
        notify('当前没有可运行的节点', 'warning');
        return null;
    }

    // Automatic saves are the only downstream work added to a bounded run.
    if (!runOptions.imageRetryNodeId && runOptions.commerceAction !== 'revise-detail-page') {
        for (const id of getIncludedAutoSaveNodeIds(state, scopeNodeSet, runOptions.includedAutoSaveNodeIds)) scopeNodeSet.add(id);
    }

    const incomingConnectionsByNode = Object.create(null);
    const inputConnectionsByNode = Object.create(null);
    for (const nodeId of scopeNodeSet) {
        const useFixedCache = nodeId !== forceRunNodeId && isFixedTextChatWithCachedResult(nodes.get(nodeId));
        const incoming = useFixedCache ? [] : connections.filter(connection => (
            connection.to.nodeId === nodeId && nodes.has(connection.from.nodeId)
        ));
        inputConnectionsByNode[nodeId] = incoming;
        incomingConnectionsByNode[nodeId] = incoming.filter(connection => scopeNodeSet.has(connection.from.nodeId));
    }

    const visiting = new Set();
    const visited = new Set();
    const executionOrder = [];
    function visit(nodeId) {
        if (visited.has(nodeId)) return true;
        if (visiting.has(nodeId)) return false;
        visiting.add(nodeId);
        for (const connection of incomingConnectionsByNode[nodeId]) {
            if (!visit(connection.from.nodeId)) return false;
        }
        visiting.delete(nodeId);
        visited.add(nodeId);
        executionOrder.push(nodeId);
        return true;
    }
    const nodeIds = [...scopeNodeSet];
    if (!nodeIds.every(visit)) {
        notify('循环连接', 'error');
        return null;
    }

    return { ...runOptions, forceRunNodeId, nodeIds, scopeNodeSet, incomingConnectionsByNode, inputConnectionsByNode, executionOrder };
}
