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
    getConnectionSamplePoints,
    pushHistory,
    showToast,
    scheduleSave,
    onConnectionsChanged = () => {},
    documentRef = document
}) {
    const pathById = new Map();
    const flowDecorationById = new Map();
    const insertionPreviewPaths = [];
    let flowAnimationFrame = null;
    const view = documentRef.defaultView || window;
    const INSERTION_PREVIEW_PADDING = 24;

    function isGlobalAnimationEnabled() {
        return state.globalAnimationEnabled !== false;
    }

    function createFlowArrowElement() {
        const arrow = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path');
        arrow.classList.add('connection-flow-arrow');
        arrow.setAttribute('d', 'M -7 -4 L 0 0 L -7 4');
        return arrow;
    }

    function ensureFlowDecoration(connId) {
        let decoration = flowDecorationById.get(connId);
        if (decoration) return decoration;

        const group = documentRef.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.classList.add('connection-flow-decoration');
        group.setAttribute('data-conn-flow-id', connId);

        const arrows = [];
        for (let i = 0; i < 7; i++) {
            const arrow = createFlowArrowElement();
            group.appendChild(arrow);
            arrows.push(arrow);
        }

        connectionsGroup.appendChild(group);
        decoration = { group, arrows, active: false };
        flowDecorationById.set(connId, decoration);
        return decoration;
    }

    function removeFlowDecoration(connId) {
        const decoration = flowDecorationById.get(connId);
        if (!decoration) return;
        decoration.group.remove();
        flowDecorationById.delete(connId);
    }

    function updateFlowDecoration(path, connId, isActive) {
        const decoration = ensureFlowDecoration(connId);
        decoration.active = isGlobalAnimationEnabled() && isActive && !!path.getAttribute('d');
        decoration.group.classList.toggle('active', decoration.active);
        if (path.nextSibling !== decoration.group) {
            path.parentNode?.insertBefore(decoration.group, path.nextSibling);
        }
    }

    function stopFlowAnimation() {
        if (!flowAnimationFrame) return;
        view.cancelAnimationFrame(flowAnimationFrame);
        flowAnimationFrame = null;
    }

    function animateFlowDecorations(now) {
        let hasActiveDecoration = false;

        flowDecorationById.forEach((decoration, connId) => {
            if (!decoration.active) return;

            const path = pathById.get(connId);
            const pathData = path?.getAttribute('d');
            if (!path || !pathData) {
                decoration.active = false;
                decoration.group.classList.remove('active');
                return;
            }

            let totalLength = 0;
            try {
                totalLength = path.getTotalLength();
            } catch {
                decoration.active = false;
                decoration.group.classList.remove('active');
                return;
            }

            if (!Number.isFinite(totalLength) || totalLength < 80) {
                decoration.group.classList.remove('active');
                return;
            }

            hasActiveDecoration = true;
            decoration.group.classList.add('active');

            const arrowCount = decoration.arrows.length;
            const edgePadding = Math.min(28, totalLength * 0.18);
            const usableLength = Math.max(totalLength - edgePadding * 2, 1);
            const spacing = Math.max(26, usableLength / Math.max(arrowCount - 1, 1));
            const speed = 0.045;
            const phase = (now * speed) % spacing;

            decoration.arrows.forEach((arrow, index) => {
                const rawLength = edgePadding + phase + index * spacing;
                const loopedLength = edgePadding + ((rawLength - edgePadding) % usableLength + usableLength) % usableLength;
                const currentPoint = path.getPointAtLength(loopedLength);
                const tangentPoint = path.getPointAtLength(Math.min(loopedLength + 1.5, totalLength));
                const angle = Math.atan2(tangentPoint.y - currentPoint.y, tangentPoint.x - currentPoint.x) * 180 / Math.PI;
                const progress = (loopedLength - edgePadding) / usableLength;
                const opacity = 0.38 + Math.sin(progress * Math.PI) * 0.48;

                arrow.setAttribute(
                    'transform',
                    `translate(${currentPoint.x} ${currentPoint.y}) rotate(${angle})`
                );
                arrow.style.opacity = opacity.toFixed(3);
            });
        });

        if (!hasActiveDecoration) {
            flowAnimationFrame = null;
            return;
        }

        flowAnimationFrame = view.requestAnimationFrame(animateFlowDecorations);
    }

    function ensureFlowAnimation() {
        if (!isGlobalAnimationEnabled()) {
            flowDecorationById.forEach((decoration) => {
                decoration.active = false;
                decoration.group.classList.remove('active');
            });
            stopFlowAnimation();
            return;
        }
        const hasActiveDecoration = Array.from(flowDecorationById.values()).some((decoration) => decoration.active);
        if (!hasActiveDecoration) {
            stopFlowAnimation();
            return;
        }
        if (!flowAnimationFrame) {
            flowAnimationFrame = view.requestAnimationFrame(animateFlowDecorations);
        }
    }

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

    function getNodeBounds(node) {
        const width = Number(node.width) > 0
            ? Number(node.width)
            : (node.el?.offsetWidth || 0);
        const height = Number(node.height) > 0
            ? Number(node.height)
            : (node.el?.offsetHeight || 0);

        return {
            left: node.x,
            top: node.y,
            right: node.x + width,
            bottom: node.y + height
        };
    }

    function getNodeCenter(node) {
        const bounds = getNodeBounds(node);
        return {
            x: (bounds.left + bounds.right) / 2,
            y: (bounds.top + bounds.bottom) / 2
        };
    }

    function expandBounds(bounds, padding) {
        return {
            left: bounds.left - padding,
            top: bounds.top - padding,
            right: bounds.right + padding,
            bottom: bounds.bottom + padding
        };
    }

    function isPointInsideBounds(point, bounds) {
        return point.x >= bounds.left &&
            point.x <= bounds.right &&
            point.y >= bounds.top &&
            point.y <= bounds.bottom;
    }

    function getDistancePointToSegment(point, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq <= 0.0001) return Math.hypot(point.x - a.x, point.y - a.y);

        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq));
        return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
    }

    function getOrientation(a, b, c) {
        const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
        if (Math.abs(value) < 0.0001) return 0;
        return value > 0 ? 1 : 2;
    }

    function isPointOnSegment(point, a, b) {
        return point.x <= Math.max(a.x, b.x) + 0.0001 &&
            point.x >= Math.min(a.x, b.x) - 0.0001 &&
            point.y <= Math.max(a.y, b.y) + 0.0001 &&
            point.y >= Math.min(a.y, b.y) - 0.0001;
    }

    function doSegmentsIntersect(a, b, c, d) {
        const o1 = getOrientation(a, b, c);
        const o2 = getOrientation(a, b, d);
        const o3 = getOrientation(c, d, a);
        const o4 = getOrientation(c, d, b);

        if (o1 !== o2 && o3 !== o4) return true;
        if (o1 === 0 && isPointOnSegment(c, a, b)) return true;
        if (o2 === 0 && isPointOnSegment(d, a, b)) return true;
        if (o3 === 0 && isPointOnSegment(a, c, d)) return true;
        return o4 === 0 && isPointOnSegment(b, c, d);
    }

    function doesSegmentIntersectBounds(a, b, bounds) {
        if (isPointInsideBounds(a, bounds) || isPointInsideBounds(b, bounds)) return true;

        const topLeft = { x: bounds.left, y: bounds.top };
        const topRight = { x: bounds.right, y: bounds.top };
        const bottomRight = { x: bounds.right, y: bounds.bottom };
        const bottomLeft = { x: bounds.left, y: bounds.bottom };

        return doSegmentsIntersect(a, b, topLeft, topRight) ||
            doSegmentsIntersect(a, b, topRight, bottomRight) ||
            doSegmentsIntersect(a, b, bottomRight, bottomLeft) ||
            doSegmentsIntersect(a, b, bottomLeft, topLeft);
    }

    function isNodeIsolated(nodeId) {
        return !state.connections.some((conn) => (
            conn.from.nodeId === nodeId ||
            conn.to.nodeId === nodeId
        ));
    }

    function getFirstCompatiblePort(node, direction, dataType) {
        const port = node?.el?.querySelector(`.node-port[data-direction="${direction}"][data-type="${dataType}"]`);
        return port?.dataset?.port || null;
    }

    function getInsertionPorts(nodeId, dataType) {
        const node = getNodeById(nodeId);
        if (!node) return null;

        const inputPort = getFirstCompatiblePort(node, 'input', dataType);
        const outputPort = getFirstCompatiblePort(node, 'output', dataType);
        if (!inputPort || !outputPort) return null;

        return { inputPort, outputPort };
    }

    function getConnectionInsertScore(conn, node, containerRect) {
        if (typeof getConnectionSamplePoints !== 'function') return null;

        const bounds = expandBounds(getNodeBounds(node), INSERTION_PREVIEW_PADDING);
        const center = getNodeCenter(node);
        const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output', containerRect);
        const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input', containerRect);
        const samplePoints = getConnectionSamplePoints(from.x, from.y, to.x, to.y, {
            type: state.connectionLineType || 'bezier'
        });

        let bestScore = Infinity;
        for (let i = 1; i < samplePoints.length; i++) {
            const prev = samplePoints[i - 1];
            const current = samplePoints[i];
            if (!doesSegmentIntersectBounds(prev, current, bounds)) continue;
            bestScore = Math.min(bestScore, getDistancePointToSegment(center, prev, current));
        }

        return Number.isFinite(bestScore) ? bestScore : null;
    }

    function findConnectionInsertPreview(draggingState) {
        if (!draggingState?.nodes || draggingState.nodes.length !== 1) return null;
        if (draggingState.connectionShakeDetached) return null;

        const nodeId = draggingState.nodes[0];
        const node = getNodeById(nodeId);
        if (!node || !isNodeIsolated(nodeId)) return null;

        const containerRect = canvasContainer.getBoundingClientRect();
        let bestCandidate = null;

        for (const conn of state.connections) {
            if (conn.from.nodeId === nodeId || conn.to.nodeId === nodeId) continue;
            if (!getNodeById(conn.from.nodeId) || !getNodeById(conn.to.nodeId)) continue;

            const dataType = conn.type || '';
            const ports = getInsertionPorts(nodeId, dataType);
            if (!ports) continue;

            const score = getConnectionInsertScore(conn, node, containerRect);
            if (score === null) continue;

            if (!bestCandidate || score < bestCandidate.score) {
                bestCandidate = {
                    connectionId: conn.id,
                    nodeId,
                    inputPort: ports.inputPort,
                    outputPort: ports.outputPort,
                    type: dataType,
                    score
                };
            }
        }

        return bestCandidate;
    }

    function ensureInsertionPreviewPath(index) {
        if (insertionPreviewPaths[index]) return insertionPreviewPaths[index];

        const path = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.classList.add('connection-insert-preview-path');
        path.setAttribute('data-insert-preview-index', String(index));
        connectionsGroup.appendChild(path);
        insertionPreviewPaths[index] = path;
        return path;
    }

    function clearConnectionInsertPreview() {
        pathById.forEach((path) => path.classList.remove('connection-insert-target'));
        state.nodes.forEach((node) => node.el?.classList.remove('connection-insert-candidate'));
        insertionPreviewPaths.forEach((path) => path?.remove());
        insertionPreviewPaths.length = 0;
        state.connectionInsertPreview = null;
    }

    function renderConnectionInsertPreview() {
        const preview = state.connectionInsertPreview;
        pathById.forEach((path) => path.classList.remove('connection-insert-target'));
        state.nodes.forEach((node) => node.el?.classList.remove('connection-insert-candidate'));

        if (!preview) {
            insertionPreviewPaths.forEach((path) => path.setAttribute('d', ''));
            return;
        }

        const conn = state.connections.find((candidate) => candidate.id === preview.connectionId);
        const node = getNodeById(preview.nodeId);
        if (!conn || !node) {
            clearConnectionInsertPreview();
            return;
        }

        const containerRect = canvasContainer.getBoundingClientRect();
        const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output', containerRect);
        const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input', containerRect);
        const nodeInput = getPortPosition(preview.nodeId, preview.inputPort, 'input', containerRect);
        const nodeOutput = getPortPosition(preview.nodeId, preview.outputPort, 'output', containerRect);
        const pathOptions = { type: state.connectionLineType || 'bezier' };

        const inboundPath = ensureInsertionPreviewPath(0);
        const outboundPath = ensureInsertionPreviewPath(1);
        inboundPath.setAttribute('d', createBezierPath(from.x, from.y, nodeInput.x, nodeInput.y, pathOptions));
        outboundPath.setAttribute('d', createBezierPath(nodeOutput.x, nodeOutput.y, to.x, to.y, pathOptions));

        pathById.get(conn.id)?.classList.add('connection-insert-target');
        node.el?.classList.add('connection-insert-candidate');
    }

    function updateConnectionInsertPreview(draggingState) {
        const candidate = findConnectionInsertPreview(draggingState);
        if (!candidate) {
            clearConnectionInsertPreview();
            return null;
        }

        state.connectionInsertPreview = candidate;
        renderConnectionInsertPreview();
        return candidate;
    }

    function createConnectionId() {
        return 'c_' + Math.random().toString(36).substr(2, 9);
    }

    function isNodeVisibleInViewport(node, viewport, padding = 100) {
        if (!node) return false;
        const bounds = getNodeBounds(node);
        return !(
            bounds.right < viewport.left - padding ||
            bounds.left > viewport.right + padding ||
            bounds.bottom < viewport.top - padding ||
            bounds.top > viewport.bottom + padding
        );
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
                removeFlowDecoration(connId);
            }
        });

        const containerRect = canvasContainer.getBoundingClientRect();
        const viewport = {
            left: -x / zoom,
            top: -y / zoom,
            right: (containerRect.width - x) / zoom,
            bottom: (containerRect.height - y) / zoom
        };
        const padding = 100;

        for (const conn of state.connections) {
            let path = pathById.get(conn.id);

            const fromNode = getNodeById(conn.from.nodeId);
            const toNode = getNodeById(conn.to.nodeId);
            if (fromNode && toNode) {
                const isFromVisible = isNodeVisibleInViewport(fromNode, viewport, padding);
                const isToVisible = isNodeVisibleInViewport(toNode, viewport, padding);
                if (!isFromVisible && !isToVisible && path) {
                    path.setAttribute('d', '');
                    updateFlowDecoration(path, conn.id, false);
                    continue;
                }
            }

            const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output', containerRect);
            const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input', containerRect);
            const pathStr = createBezierPath(from.x, from.y, to.x, to.y, {
                type: state.connectionLineType || 'bezier'
            });
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
                    removeFlowDecoration(conn.id);
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
            updateFlowDecoration(path, conn.id, isSelected);
        }

        renderConnectionInsertPreview();
        ensureFlowAnimation();
    }

    function updateDraggingConnections(draggingState) {
        if (!draggingState?.connectionsToUpdate?.length) {
            updateAllConnections();
            updateConnectionInsertPreview(draggingState);
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
            pathEl.setAttribute('d', createBezierPath(from.x, from.y, to.x, to.y, {
                type: state.connectionLineType || 'bezier'
            }));
        }

        updateConnectionInsertPreview(draggingState);
        ensureFlowAnimation();
    }

    function commitConnectionInsertPreview() {
        const preview = state.connectionInsertPreview;
        if (!preview) return false;

        const conn = state.connections.find((candidate) => candidate.id === preview.connectionId);
        const node = getNodeById(preview.nodeId);
        if (!conn || !node || !isNodeIsolated(preview.nodeId)) {
            clearConnectionInsertPreview();
            return false;
        }

        const ports = getInsertionPorts(preview.nodeId, conn.type || '');
        if (!ports ||
            ports.inputPort !== preview.inputPort ||
            ports.outputPort !== preview.outputPort) {
            clearConnectionInsertPreview();
            return false;
        }

        state.connections = state.connections.filter((candidate) => candidate.id !== conn.id);
        state.connections.push(
            {
                id: createConnectionId(),
                from: { nodeId: conn.from.nodeId, port: conn.from.port },
                to: { nodeId: preview.nodeId, port: preview.inputPort },
                type: conn.type
            },
            {
                id: createConnectionId(),
                from: { nodeId: preview.nodeId, port: preview.outputPort },
                to: { nodeId: conn.to.nodeId, port: conn.to.port },
                type: conn.type
            }
        );

        clearConnectionInsertPreview();
        updateAllConnections();
        updatePortStyles();
        showToast('节点已插入连线', 'success');
        scheduleSave();
        onConnectionsChanged();
        return true;
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
        tempConnection.setAttribute('d', createBezierPath(sx1, sy1, sx2, sy2, {
            type: state.connectionLineType || 'bezier'
        }));
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
        clearConnectionInsertPreview,
        commitConnectionInsertPreview,
        finishConnection,
        drawTempConnection,
        updatePortStyles
    };
}
