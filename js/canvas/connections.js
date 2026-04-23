/**
 * 负责节点端口连线的创建、删除、渲染与样式更新，是画布连接关系的核心实现。
 */
export function createConnectionsApi({
    state,
    canvasContainer,
    connectionsGroup,
    tempConnection,
    originAxes,
    getNodeById,
    createBezierPath,
    pushHistory,
    showToast,
    scheduleSave,
    onConnectionsChanged = () => {},
    documentRef = document
}) {
    const pathById = new Map();

    function getPortPosition(nodeId, portName, direction, containerRectOverride = null) {
        const node = getNodeById(nodeId);
        if (!node) return { x: 0, y: 0 };

        if (state.dragging && state.dragging.portOffsets) {
            const offset = state.dragging.portOffsets.get(`${nodeId}-${portName}-${direction}`);
            if (offset) return { x: node.x + offset.dx, y: node.y + offset.dy };
        }

        const portEl = node.el.querySelector(`.node-port[data-node-id="${nodeId}"][data-port="${portName}"][data-direction="${direction}"]`);
        if (!portEl) return { x: node.x, y: node.y };
        const dot = portEl.querySelector('.port-dot');
        const dotRect = dot.getBoundingClientRect();
        const containerRect = containerRectOverride || canvasContainer.getBoundingClientRect();
        const { x: cx, y: cy, zoom } = state.canvas;
        return {
            x: (dotRect.left + dotRect.width / 2 - containerRect.left - cx) / zoom,
            y: (dotRect.top + dotRect.height / 2 - containerRect.top - cy) / zoom
        };
    }

    function updateAllConnections() {
        const { x, y, zoom } = state.canvas;
        const isDragging = !!state.dragging;
        const isPanning = state.canvas.isPanning;

        connectionsGroup.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);
        if (originAxes) {
            originAxes.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);
        }

        if (isDragging || isPanning) {
            connectionsGroup.classList.add('is-dragging');
        } else {
            connectionsGroup.classList.remove('is-dragging', 'is-panning');
        }

        const currentConnIds = new Set(state.connections.map((conn) => conn.id));
        pathById.forEach((path, connId) => {
            if (!currentConnIds.has(connId)) {
                path.remove();
                pathById.delete(connId);
            }
        });

        const containerRect = canvasContainer.getBoundingClientRect();
        const vx1 = -x / zoom;
        const vy1 = -y / zoom;
        const vx2 = (containerRect.width - x) / zoom;
        const vy2 = (containerRect.height - y) / zoom;
        const padding = 100;

        for (const conn of state.connections) {
            let path = pathById.get(conn.id);

            const fromNode = getNodeById(conn.from.nodeId);
            const toNode = getNodeById(conn.to.nodeId);
            if (fromNode && toNode) {
                const isFromVisible = fromNode.x > vx1 - padding && fromNode.x < vx2 + padding && fromNode.y > vy1 - padding && fromNode.y < vy2 + padding;
                const isToVisible = toNode.x > vx1 - padding && toNode.x < vx2 + padding && toNode.y > vy1 - padding && toNode.y < vy2 + padding;
                if (!isFromVisible && !isToVisible && path) {
                    path.setAttribute('d', '');
                    continue;
                }
            }

            const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output', containerRect);
            const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input', containerRect);
            const pathStr = createBezierPath(from.x, from.y, to.x, to.y);
            const isSelected = state.selectedNodes.has(conn.from.nodeId) || state.selectedNodes.has(conn.to.nodeId);

            if (!path) {
                path = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('data-conn-id', conn.id);
                path.classList.add('connection-path');
                path.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    state.connections = state.connections.filter((candidate) => candidate.id !== conn.id);
                    pathById.get(conn.id)?.remove();
                    pathById.delete(conn.id);
                    updateAllConnections();
                    updatePortStyles();
                    showToast('连接已删除', 'info');
                    scheduleSave();
                    onConnectionsChanged();
                });
                connectionsGroup.appendChild(path);
                pathById.set(conn.id, path);
            }

            path.setAttribute('d', pathStr);
            path.classList.toggle('selected', isSelected);
            path.removeAttribute('stroke');
        }
    }

    function updateDraggingConnections(draggingState) {
        if (!draggingState?.connectionsToUpdate?.length) {
            updateAllConnections();
            return;
        }

        const { x, y, zoom } = state.canvas;
        connectionsGroup.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);
        if (originAxes) {
            originAxes.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);
        }
        connectionsGroup.classList.add('is-dragging');

        const containerRect = canvasContainer.getBoundingClientRect();
        for (const { conn, pathEl } of draggingState.connectionsToUpdate) {
            if (!pathEl?.isConnected) continue;
            const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output', containerRect);
            const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input', containerRect);
            pathEl.setAttribute('d', createBezierPath(from.x, from.y, to.x, to.y));
        }
    }

    function finishConnection(src, tgt) {
        pushHistory();
        if (src.nodeId === tgt.nodeId) return showToast('不能连接同一节点', 'warning');
        if (src.isOutput && tgt.dir === 'output') return showToast('不能连接两个输出', 'warning');
        if (!src.isOutput && tgt.dir === 'input') return showToast('不能连接两个输入', 'warning');
        if (src.dataType !== (tgt.type || tgt.dataType)) return showToast('类型不匹配', 'warning');

        const fromId = src.isOutput ? src.nodeId : tgt.nodeId;
        const fromPort = src.isOutput ? src.portName : tgt.port;
        const toId = src.isOutput ? tgt.nodeId : src.nodeId;
        const toPort = src.isOutput ? tgt.port : src.portName;

        if (state.connections.find((conn) => conn.from.nodeId === fromId && conn.from.port === fromPort && conn.to.nodeId === toId && conn.to.port === toPort)) {
            return showToast('连接已存在', 'warning');
        }

        state.connections = state.connections.filter((conn) => !(conn.to.nodeId === toId && conn.to.port === toPort));
        state.connections.push({
            id: 'c_' + Math.random().toString(36).substr(2, 9),
            from: { nodeId: fromId, port: fromPort },
            to: { nodeId: toId, port: toPort },
            type: src.dataType
        });
        updateAllConnections();
        updatePortStyles();
        showToast('连接已创建', 'success');
        scheduleSave();
        onConnectionsChanged();
        return true;
    }

    function drawTempConnection(x1, y1, x2, y2) {
        const { x, y, zoom } = state.canvas;
        const sx1 = x1 * zoom + x;
        const sy1 = y1 * zoom + y;
        const sx2 = x2 * zoom + x;
        const sy2 = y2 * zoom + y;
        const cp = Math.max(50, Math.abs(sx2 - sx1) * 0.4);
        tempConnection.setAttribute('d', `M ${sx1} ${sy1} C ${sx1 + cp} ${sy1}, ${sx2 - cp} ${sy2}, ${sx2} ${sy2}`);
    }

    function updatePortStyles() {
        documentRef.querySelectorAll('.port-dot').forEach((dot) => dot.classList.remove('connected'));
        for (const conn of state.connections) {
            const fromNode = getNodeById(conn.from.nodeId);
            const toNode = getNodeById(conn.to.nodeId);
            if (fromNode) {
                const fromDot = fromNode.el.querySelector(`.node-port[data-port="${conn.from.port}"][data-direction="output"] .port-dot`);
                if (fromDot) fromDot.classList.add('connected');
            }
            if (toNode) {
                const toDot = toNode.el.querySelector(`.node-port[data-port="${conn.to.port}"][data-direction="input"] .port-dot`);
                if (toDot) toDot.classList.add('connected');
            }
        }
    }

    return {
        getPortPosition,
        updateAllConnections,
        updateDraggingConnections,
        finishConnection,
        drawTempConnection,
        updatePortStyles
    };
}
