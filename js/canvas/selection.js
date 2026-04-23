/**
 * 管理画布上的节点选择状态，提供全选与框选结果同步等选择辅助能力。
 */
export function createSelectionApi({ state, updateAllConnections }) {
    function selectAllNodes() {
        state.selectedNodes.forEach((nodeId) => {
            const node = state.nodes.get(nodeId);
            if (node) node.el.classList.remove('selected');
        });

        state.selectedNodes.clear();
        state.nodes.forEach((node, id) => {
            state.selectedNodes.add(id);
            node.el.classList.add('selected');
        });
        updateAllConnections();
    }

    return {
        selectAllNodes
    };
}
/**
 * 封装画布节点选择相关的通用操作。
 */
