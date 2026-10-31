const ordered = edges => edges.map((edge, index) => ({ edge, rank: Number.isInteger(edge.order) ? edge.order : index }))
    .sort((a, b) => a.rank - b.rank).map(({ edge }) => edge);

export function removeRetiredSaveNodes(document) {
    const removed = new Set(document.nodes.filter(node => node.type === 'ImageSave').map(node => node.id));
    const connections = document.connections || [];
    const sources = (endpoint, visited = new Set()) => {
        if (!removed.has(endpoint.nodeId)) return [endpoint];
        if (visited.has(endpoint.nodeId)) throw new Error('保存节点之间存在循环连接，请先断开循环再清理');
        const next = new Set([...visited, endpoint.nodeId]);
        return ordered(connections.filter(edge => edge.to.nodeId === endpoint.nodeId && edge.to.port === endpoint.port))
            .flatMap(edge => sources(edge.from, next));
    };
    const groups = new Map();
    for (const edge of connections.filter(edge => !removed.has(edge.to.nodeId))) {
        const key = JSON.stringify(edge.to);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(edge);
    }
    const result = [];
    for (const group of groups.values()) {
        if (!group.some(edge => removed.has(edge.from.nodeId))) { result.push(...group); continue; }
        const seen = new Set();
        let order = 0;
        for (const edge of ordered(group)) for (const [index, from] of sources(edge.from).entries()) {
            const key = JSON.stringify(from);
            if (seen.has(key)) continue;
            seen.add(key);
            result.push({ ...edge, id: removed.has(edge.from.nodeId) ? `${edge.id || 'connection'}-bypass-${index}` : edge.id,
                from: { ...from }, to: { ...edge.to }, order: order++ });
        }
    }
    return { ...document, nodes: document.nodes.filter(node => !removed.has(node.id)), connections: result };
}

export function createRetiredSaveNodeCleanup({ state, getWorkflowId, session, serializeNodes, removeNode, onNodesRemoved,
    graphChanged, save, confirm, showToast }) {
    let busy = false;
    const offered = new Set();
    return async function offer({ reset = false } = {}) {
        const workflowId = getWorkflowId();
        if (reset) offered.delete(workflowId);
        if (busy || offered.has(workflowId) || !workflowId || ![...state.nodes.values()].some(node => node.type === 'ImageSave')) return;
        if (state.runningNodeIds?.size || state.canvasPlanApplying || state.historyTransitionInProgress) return;
        busy = true;
        offered.add(workflowId);
        try {
            const accepted = await confirm({ title: '保存节点已弃用',
                message: '你这个工作流里有保存节点，我们已经弃用了。点击确定会自动帮你清理场景中所有的保存节点。我们现在已经改成了全部图片和视频自动保存的机制，不需要你手动连接保存节点了。',
                note: '清理后将自动接续上下游连线并保留输入顺序；取消则保留当前场景。', yesText: '确定', noText: '取消' });
            if (!accepted || getWorkflowId() !== workflowId) return;
            if (state.runningNodeIds?.size) throw new Error('请等待当前运行完成后再清理保存节点');
            const removedIds = [...state.nodes.values()].filter(node => node.type === 'ImageSave').map(node => node.id);
            await session().applyCanvasBatch(async () => {
                if (getWorkflowId() !== workflowId) throw new Error('工作流已切换，未清理');
                const result = removeRetiredSaveNodes({ nodes: serializeNodes(), connections: state.connections });
                for (const id of removedIds) {
                    await removeNode(id, { onlyId: true, skipHistory: true, showToast: false, notifyReferences: false });
                    if (state.nodes.has(id)) throw new Error('保存节点未能清理，已保留原场景');
                }
                state.connections = result.connections;
                graphChanged();
            }, save);
            session().scheduleSave({ dirty: false });
            onNodesRemoved(removedIds);
        } catch (error) { offered.delete(workflowId); showToast(error.message, 'error'); }
        finally { busy = false; }
    };
}
