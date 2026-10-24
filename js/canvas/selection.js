/**
 * 画布节点选择的唯一事实源。
 *
 * `state.selectedNodes` 是权威选中状态；节点元素上的 `.selected` 类只是它的派生渲染。
 * 本模块是唯一同时读写这二者的地方，并把变更同步给连接投影。所有交互路径都必须经由
 * 这里修改选中状态，不能自行读写 `state.selectedNodes` 或直接增删 `.selected` 类。
 */
export function createSelectionApi({
    state,
    connectionProjection
}) {
    function setNodeSelectedClass(nodeId, selected) {
        const node = state.nodes.get(nodeId);
        if (!node?.el?.classList) return;
        if (selected) {
            node.el.classList.add('selected');
        } else {
            node.el.classList.remove('selected');
        }
    }

    function notifyChanged(nodeIds, notify = true) {
        if (notify && nodeIds.length && connectionProjection) {
            connectionProjection.nodeAppearanceChanged(nodeIds);
        }
    }

    function clearSelection({ notify = true } = {}) {
        const changedNodeIds = Array.from(state.selectedNodes);
        state.selectedNodes.forEach((nodeId) => setNodeSelectedClass(nodeId, false));
        state.selectedNodes.clear();
        notifyChanged(changedNodeIds, notify);
        return changedNodeIds;
    }

    function setSelection(ids, { notify = true } = {}) {
        const next = new Set(ids.filter((id) => state.nodes.has(id)));
        const changedNodeIds = [];
        state.selectedNodes.forEach((nodeId) => {
            if (!next.has(nodeId)) {
                changedNodeIds.push(nodeId);
                setNodeSelectedClass(nodeId, false);
            }
        });
        next.forEach((nodeId) => {
            if (!state.selectedNodes.has(nodeId)) {
                changedNodeIds.push(nodeId);
                setNodeSelectedClass(nodeId, true);
            }
        });
        state.selectedNodes.clear();
        next.forEach((nodeId) => state.selectedNodes.add(nodeId));
        notifyChanged(changedNodeIds, notify);
        return changedNodeIds;
    }

    function selectNode(id, { isMulti = false, notify = true } = {}) {
        const changedNodeIds = new Set();
        if (!isMulti) {
            state.selectedNodes.forEach((nodeId) => {
                changedNodeIds.add(nodeId);
                setNodeSelectedClass(nodeId, false);
            });
            state.selectedNodes.clear();
        }

        let added = false;
        if (state.selectedNodes.has(id)) {
            state.selectedNodes.delete(id);
            changedNodeIds.add(id);
            setNodeSelectedClass(id, false);
        } else {
            state.selectedNodes.add(id);
            changedNodeIds.add(id);
            setNodeSelectedClass(id, true);
            added = true;
        }

        const changed = Array.from(changedNodeIds);
        notifyChanged(changed, notify);
        return { selected: state.selectedNodes.has(id), added, changedNodeIds: changed };
    }

    function addToSelection(id, { notify = true } = {}) {
        if (state.selectedNodes.has(id)) return false;
        state.selectedNodes.add(id);
        setNodeSelectedClass(id, true);
        notifyChanged([id], notify);
        return true;
    }

    function removeFromSelection(id, { notify = true } = {}) {
        if (!state.selectedNodes.has(id)) return false;
        state.selectedNodes.delete(id);
        setNodeSelectedClass(id, false);
        notifyChanged([id], notify);
        return true;
    }

    function selectAllNodes() {
        const changedNodeIds = new Set(state.selectedNodes);
        state.selectedNodes.forEach((nodeId) => setNodeSelectedClass(nodeId, false));
        state.selectedNodes.clear();
        state.nodes.forEach((node, id) => {
            state.selectedNodes.add(id);
            setNodeSelectedClass(id, true);
            changedNodeIds.add(id);
        });
        notifyChanged(Array.from(changedNodeIds));
    }

    function reset() {
        state.selectedNodes.clear();
    }

    return {
        selectNode,
        clearSelection,
        setSelection,
        addToSelection,
        removeFromSelection,
        selectAllNodes,
        reset,
        notifyChanged: (nodeIds) => notifyChanged(nodeIds, true),
        getSelectedNodeIds: () => Array.from(state.selectedNodes)
    };
}
