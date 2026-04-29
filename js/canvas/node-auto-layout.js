/**
 * Arranges selected nodes, or all nodes when there is no selection, into a tidy
 * left-to-right workflow layout.
 */
export function createNodeAutoLayoutApi({
    state,
    pushHistory,
    updateAllConnections,
    scheduleSave,
    showToast
}) {
    const GRID_SIZE = 20;
    const COLUMN_GAP = 120;
    const ROW_GAP = 56;
    const FALLBACK_NODE_WIDTH = 280;
    const FALLBACK_NODE_HEIGHT = 180;

    function snap(value) {
        return Math.round(value / GRID_SIZE) * GRID_SIZE;
    }

    function getNodeSize(node) {
        return {
            width: Number(node.width) > 0 ? Number(node.width) : (node.el?.offsetWidth || FALLBACK_NODE_WIDTH),
            height: Number(node.height) > 0 ? Number(node.height) : (node.el?.offsetHeight || FALLBACK_NODE_HEIGHT)
        };
    }

    function getTargetNodeIds() {
        const selectedIds = Array.from(state.selectedNodes).filter((id) => state.nodes.has(id));
        return selectedIds.length > 0 ? selectedIds : Array.from(state.nodes.keys());
    }

    function isNodeRunning(nodeId) {
        return state.runningNodeIds?.has(nodeId) || state.nodes.get(nodeId)?.el?.classList.contains('running');
    }

    function compareByCurrentPosition(a, b) {
        const nodeA = state.nodes.get(a);
        const nodeB = state.nodes.get(b);
        if (!nodeA || !nodeB) return 0;
        return (nodeA.x - nodeB.x) || (nodeA.y - nodeB.y) || a.localeCompare(b);
    }

    function getLayoutAnchor(nodeIds) {
        let minX = Infinity;
        let minY = Infinity;
        nodeIds.forEach((id) => {
            const node = state.nodes.get(id);
            if (!node) return;
            minX = Math.min(minX, node.x);
            minY = Math.min(minY, node.y);
        });
        return {
            x: snap(Number.isFinite(minX) ? minX : 0),
            y: snap(Number.isFinite(minY) ? minY : 0)
        };
    }

    function buildGraph(nodeIds) {
        const targetSet = new Set(nodeIds);
        const incomingCount = new Map(nodeIds.map((id) => [id, 0]));
        const outgoing = new Map(nodeIds.map((id) => [id, []]));

        state.connections.forEach((connection) => {
            const fromId = connection.from?.nodeId;
            const toId = connection.to?.nodeId;
            if (!targetSet.has(fromId) || !targetSet.has(toId) || fromId === toId) return;

            outgoing.get(fromId)?.push(toId);
            incomingCount.set(toId, (incomingCount.get(toId) || 0) + 1);
        });

        outgoing.forEach((targets) => targets.sort(compareByCurrentPosition));

        return { incomingCount, outgoing };
    }

    function assignLayers(nodeIds) {
        const { incomingCount, outgoing } = buildGraph(nodeIds);
        const queue = nodeIds
            .filter((id) => incomingCount.get(id) === 0)
            .sort(compareByCurrentPosition);
        const layers = new Map(nodeIds.map((id) => [id, 0]));
        const processed = new Set();

        while (queue.length > 0) {
            const id = queue.shift();
            processed.add(id);

            outgoing.get(id)?.forEach((targetId) => {
                layers.set(targetId, Math.max(layers.get(targetId) || 0, (layers.get(id) || 0) + 1));
                incomingCount.set(targetId, incomingCount.get(targetId) - 1);
                if (incomingCount.get(targetId) === 0) {
                    queue.push(targetId);
                    queue.sort(compareByCurrentPosition);
                }
            });
        }

        // Cycles cannot be fully topologically sorted; keep them tidy by current x order.
        nodeIds
            .filter((id) => !processed.has(id))
            .sort(compareByCurrentPosition)
            .forEach((id, index) => {
                layers.set(id, Math.max(layers.get(id) || 0, index));
            });

        return layers;
    }

    function getGridColumnCount(nodeIds) {
        return Math.max(1, Math.ceil(Math.sqrt(nodeIds.length)));
    }

    function calculatePositions(nodeIds) {
        const anchor = getLayoutAnchor(nodeIds);
        const targetSet = new Set(nodeIds);
        const hasInternalConnections = state.connections.some((connection) => {
            return targetSet.has(connection.from?.nodeId) && targetSet.has(connection.to?.nodeId);
        });

        if (!hasInternalConnections) {
            const columns = getGridColumnCount(nodeIds);
            const sortedIds = [...nodeIds].sort(compareByCurrentPosition);
            const columnWidths = Array(columns).fill(FALLBACK_NODE_WIDTH);
            const rowHeights = [];

            sortedIds.forEach((id, index) => {
                const size = getNodeSize(state.nodes.get(id));
                const column = index % columns;
                const row = Math.floor(index / columns);
                columnWidths[column] = Math.max(columnWidths[column], size.width);
                rowHeights[row] = Math.max(rowHeights[row] || FALLBACK_NODE_HEIGHT, size.height);
            });

            const columnX = [];
            columnWidths.forEach((width, index) => {
                columnX[index] = index === 0 ? anchor.x : columnX[index - 1] + columnWidths[index - 1] + COLUMN_GAP;
            });
            const rowY = [];
            rowHeights.forEach((height, index) => {
                rowY[index] = index === 0 ? anchor.y : rowY[index - 1] + rowHeights[index - 1] + ROW_GAP;
            });

            return new Map(sortedIds.map((id, index) => [
                id,
                {
                    x: snap(columnX[index % columns]),
                    y: snap(rowY[Math.floor(index / columns)])
                }
            ]));
        }

        const layers = assignLayers(nodeIds);
        const grouped = new Map();
        nodeIds.forEach((id) => {
            const layer = layers.get(id) || 0;
            if (!grouped.has(layer)) grouped.set(layer, []);
            grouped.get(layer).push(id);
        });

        const orderedLayers = Array.from(grouped.keys()).sort((a, b) => a - b);
        const positions = new Map();
        let x = anchor.x;

        orderedLayers.forEach((layer) => {
            const idsInLayer = grouped.get(layer).sort(compareByCurrentPosition);
            const maxWidth = idsInLayer.reduce((max, id) => Math.max(max, getNodeSize(state.nodes.get(id)).width), FALLBACK_NODE_WIDTH);
            let y = anchor.y;

            idsInLayer.forEach((id) => {
                const size = getNodeSize(state.nodes.get(id));
                positions.set(id, { x: snap(x), y: snap(y) });
                y += size.height + ROW_GAP;
            });

            x += maxWidth + COLUMN_GAP;
        });

        return positions;
    }

    function applyPositions(positions) {
        positions.forEach((position, id) => {
            const node = state.nodes.get(id);
            if (!node) return;
            node.x = position.x;
            node.y = position.y;
            node.el.style.left = `${position.x}px`;
            node.el.style.top = `${position.y}px`;
        });
    }

    function autoArrangeNodes() {
        const targetNodeIds = getTargetNodeIds();
        const runningCount = targetNodeIds.filter((id) => isNodeRunning(id)).length;
        const nodeIds = targetNodeIds.filter((id) => !isNodeRunning(id));
        if (runningCount > 0) {
            showToast(runningCount > 1 ? `有 ${runningCount} 个节点正在运行，已跳过这些节点` : '节点正在运行，已跳过该节点', 'warning');
        }
        if (nodeIds.length === 0) {
            showToast('画布中没有可排列的节点', 'info');
            return false;
        }

        pushHistory();
        const positions = calculatePositions(nodeIds);
        applyPositions(positions);
        updateAllConnections();
        scheduleSave();
        showToast(state.selectedNodes.size > 0 ? `已排列 ${nodeIds.length} 个选中节点` : `已排列 ${nodeIds.length} 个节点`, 'success');
        return true;
    }

    return {
        autoArrangeNodes
    };
}
