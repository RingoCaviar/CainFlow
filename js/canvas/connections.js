/**
 * 负责节点端口连线的创建、删除、渲染与样式更新，是画布连接关系的核心实现。
 */
import { getFirstCompatibleDefinitionPort, listNodeDefinitions } from '../nodes/registry.js';

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
    addNode = null,
    documentRef = document
}) {
    const pathById = new Map();
    const connectionById = new Map();
    const connectionsByNodeId = new Map();
    const connectionsByPortKey = new Map();
    const dirtyConnectionIds = new Set();
    const flowDecorationById = new Map();
    const insertionPreviewPaths = [];
    let flowAnimationFrame = null;
    let connectionIndexSignature = '';
    let laneMapCacheSignature = '';
    let laneMapCache = new Map();
    const view = documentRef.defaultView || window;
    const INSERTION_PREVIEW_PADDING = 24;
    const OUTPUT_PORT_TRANSITION = 28;
    const INPUT_PORT_TURN_LEAD = 72;
    const PAIR_LANE_GAP = 14;
    const PORT_LANE_GAP = 6;
    const NODE_LANE_GAP = 4;
    const MAX_LANE_OFFSET = 42;
    const FLOW_ANIMATION_TARGET_FPS = 60;
    const FLOW_ANIMATION_FRAME_MS = 1000 / FLOW_ANIMATION_TARGET_FPS;
    let lastFlowAnimationTime = 0;

    function getConnectionSignature(connections = state.connections) {
        return connections.map((conn) => (
            `${conn?.id || ''}:${conn?.from?.nodeId || ''}.${conn?.from?.port || ''}>${conn?.to?.nodeId || ''}.${conn?.to?.port || ''}:${conn?.type || ''}`
        )).join('|');
    }

    function addToSetMap(map, key, value) {
        if (!key) return;
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(value);
    }

    function getPortKey(nodeId, portName, direction) {
        return `${nodeId || ''}:${direction || ''}:${portName || ''}`;
    }

    function invalidateConnectionLaneCache() {
        laneMapCacheSignature = '';
        laneMapCache = new Map();
    }

    function rebuildConnectionIndex() {
        connectionById.clear();
        connectionsByNodeId.clear();
        connectionsByPortKey.clear();

        state.connections.forEach((connection) => {
            if (!connection?.id) return;
            connectionById.set(connection.id, connection);
            addToSetMap(connectionsByNodeId, connection.from?.nodeId, connection.id);
            addToSetMap(connectionsByNodeId, connection.to?.nodeId, connection.id);
            addToSetMap(connectionsByPortKey, getPortKey(connection.from?.nodeId, connection.from?.port, 'output'), connection.id);
            addToSetMap(connectionsByPortKey, getPortKey(connection.to?.nodeId, connection.to?.port, 'input'), connection.id);
        });

        connectionIndexSignature = getConnectionSignature();
        dirtyConnectionIds.clear();
        invalidateConnectionLaneCache();
    }

    function ensureConnectionIndex() {
        const nextSignature = getConnectionSignature();
        if (nextSignature !== connectionIndexSignature) {
            rebuildConnectionIndex();
        }
    }

    function getConnectionById(connId) {
        ensureConnectionIndex();
        return connectionById.get(connId) || null;
    }

    function getConnectionIdsForNode(nodeId) {
        ensureConnectionIndex();
        return Array.from(connectionsByNodeId.get(nodeId) || []);
    }

    function markConnectionDirty(connId) {
        if (connId) dirtyConnectionIds.add(connId);
    }

    function markNodeConnectionsDirty(nodeId) {
        getConnectionIdsForNode(nodeId).forEach((connId) => dirtyConnectionIds.add(connId));
        invalidateConnectionLaneCache();
    }

    function markAllConnectionsDirty() {
        ensureConnectionIndex();
        connectionById.forEach((_, connId) => dirtyConnectionIds.add(connId));
        invalidateConnectionLaneCache();
    }

    function isGlobalAnimationEnabled() {
        return state.globalAnimationEnabled !== false;
    }

    function isNodeRunning(nodeId) {
        return state.runningNodeIds?.has(nodeId) || state.nodes.get(nodeId)?.el?.classList.contains('running');
    }

    function hasRunningEndpoint(connection) {
        return isNodeRunning(connection.from.nodeId) || isNodeRunning(connection.to.nodeId);
    }

    function clampLaneOffset(value) {
        return Math.max(-MAX_LANE_OFFSET, Math.min(MAX_LANE_OFFSET, value));
    }

    function getConnectionPathOptions(connection = null, laneById = null) {
        const laneOffset = connection && laneById instanceof Map
            ? (laneById.get(connection.id) || 0)
            : 0;
        return {
            type: state.connectionLineType || 'bezier',
            outputTransition: OUTPUT_PORT_TRANSITION,
            inputTransition: INPUT_PORT_TURN_LEAD,
            laneOffset
        };
    }

    function getPortOrder(nodeId, portName, direction) {
        const node = getNodeById(nodeId);
        const ports = Array.from(node?.el?.querySelectorAll?.(`.node-port[data-direction="${direction}"]`) || []);
        const index = ports.findIndex((portEl) => portEl.dataset.port === portName);
        return index >= 0 ? index : ports.length;
    }

    function compareConnectionsForLane(a, b) {
        const fromA = getNodeById(a.from?.nodeId);
        const fromB = getNodeById(b.from?.nodeId);
        const toA = getNodeById(a.to?.nodeId);
        const toB = getNodeById(b.to?.nodeId);
        return ((fromA?.y ?? 0) - (fromB?.y ?? 0)) ||
            ((toA?.y ?? 0) - (toB?.y ?? 0)) ||
            (getPortOrder(a.from?.nodeId, a.from?.port, 'output') - getPortOrder(b.from?.nodeId, b.from?.port, 'output')) ||
            (getPortOrder(a.to?.nodeId, a.to?.port, 'input') - getPortOrder(b.to?.nodeId, b.to?.port, 'input')) ||
            String(a.id || '').localeCompare(String(b.id || ''));
    }

    function addCenteredLaneOffsets(laneById, group, gap, weight = 1) {
        if (!Array.isArray(group) || group.length <= 1) return;
        const sorted = group.slice().sort(compareConnectionsForLane);
        const center = (sorted.length - 1) / 2;
        sorted.forEach((connection, index) => {
            const current = laneById.get(connection.id) || 0;
            const offset = (index - center) * gap * weight;
            laneById.set(connection.id, clampLaneOffset(current + offset));
        });
    }

    function buildConnectionLaneMap(connections = state.connections) {
        const laneById = new Map();
        const pairGroups = new Map();
        const outputGroups = new Map();
        const targetGroups = new Map();

        connections.forEach((connection) => {
            if (!connection?.id || !getNodeById(connection.from?.nodeId) || !getNodeById(connection.to?.nodeId)) return;

            const pairKey = `${connection.from.nodeId}->${connection.to.nodeId}`;
            const outputKey = `${connection.from.nodeId}:${connection.from.port}`;
            const targetKey = `${connection.to.nodeId}`;
            if (!pairGroups.has(pairKey)) pairGroups.set(pairKey, []);
            if (!outputGroups.has(outputKey)) outputGroups.set(outputKey, []);
            if (!targetGroups.has(targetKey)) targetGroups.set(targetKey, []);
            pairGroups.get(pairKey).push(connection);
            outputGroups.get(outputKey).push(connection);
            targetGroups.get(targetKey).push(connection);
        });

        pairGroups.forEach((group) => addCenteredLaneOffsets(laneById, group, PAIR_LANE_GAP, 1));
        outputGroups.forEach((group) => addCenteredLaneOffsets(laneById, group, PORT_LANE_GAP, 0.7));
        targetGroups.forEach((group) => addCenteredLaneOffsets(laneById, group, NODE_LANE_GAP, 0.55));
        return laneById;
    }

    function getConnectionLaneMap() {
        const signature = getConnectionSignature();
        if (signature !== laneMapCacheSignature) {
            laneMapCache = buildConnectionLaneMap(state.connections);
            laneMapCacheSignature = signature;
        }
        return laneMapCache;
    }

    function getNodePortCacheSignature(node) {
        if (!node?.el) return '';
        const bounds = getNodeBounds(node);
        const collapsed = node.collapsed === true || node.el.classList.contains('collapsed') ? '1' : '0';
        const domWidth = node.el.offsetWidth || 0;
        const domHeight = node.el.offsetHeight || 0;
        const scrollWidth = node.el.scrollWidth || 0;
        const scrollHeight = node.el.scrollHeight || 0;
        const ports = Array.from(node.el.querySelectorAll?.('.node-port[data-direction]') || []);
        const portState = ports.map((portEl) => (
            `${portEl.dataset.direction || ''}:${portEl.dataset.port || ''}:${portEl.classList.contains('hidden') ? 'h' : 'v'}:${portEl.classList.contains('is-hidden-by-collapse') ? 'c' : 'o'}`
        )).join('|');
        return `${Math.round(bounds.right - bounds.left)}:${Math.round(bounds.bottom - bounds.top)}:${domWidth}:${domHeight}:${scrollWidth}:${scrollHeight}:${collapsed}:${portState}`;
    }

    function getPortElement(node, portName, direction) {
        if (!node?.el) return null;
        return Array.from(node.el.querySelectorAll?.('.node-port[data-direction]') || [])
            .find((portEl) => (
                portEl.dataset.port === portName &&
                portEl.dataset.direction === direction
            )) || null;
    }

    function isPortElementVisible(portEl) {
        if (!portEl) return false;
        const dot = portEl.querySelector('.port-dot') || portEl;
        const dotRect = dot.getBoundingClientRect();
        return !portEl.classList.contains('hidden') &&
            !portEl.classList.contains('is-hidden-by-collapse') &&
            portEl.offsetParent !== null &&
            dotRect.width > 0 &&
            dotRect.height > 0;
    }

    function getPortDotWorldPosition(portEl, containerRectOverride = null) {
        if (!portEl) return null;
        const dot = portEl.querySelector('.port-dot') || portEl;
        const dotRect = dot.getBoundingClientRect();
        if (dotRect.width <= 0 || dotRect.height <= 0) return null;

        const containerRect = containerRectOverride || canvasContainer.getBoundingClientRect();
        const { x: cx, y: cy } = state.canvas;
        const zoom = Math.max(0.0001, Number(state.canvas?.zoom) || 1);
        return {
            x: (dotRect.left + dotRect.width / 2 - containerRect.left - cx) / zoom,
            y: (dotRect.top + dotRect.height / 2 - containerRect.top - cy) / zoom
        };
    }

    function invalidateNodePortCache(nodeId = null) {
        if (nodeId) {
            const node = getNodeById(nodeId);
            if (node) delete node._portPositionCache;
            markNodeConnectionsDirty(nodeId);
            return;
        }
        state.nodes.forEach((node) => {
            if (node) delete node._portPositionCache;
        });
        markAllConnectionsDirty();
    }

    function measureNodePorts(nodeId, containerRectOverride = null) {
        const node = getNodeById(nodeId);
        if (!node?.el) return null;
        const ports = Array.from(node.el.querySelectorAll?.('.node-port[data-direction]') || []);
        const cache = {
            signature: getNodePortCacheSignature(node),
            ports: new Map()
        };

        ports.forEach((portEl) => {
            const portName = portEl.dataset.port || '';
            const direction = portEl.dataset.direction || '';
            if (!portName || !direction) return;
            const worldPosition = getPortDotWorldPosition(portEl, containerRectOverride);
            const visible = isPortElementVisible(portEl);
            cache.ports.set(getPortKey(nodeId, portName, direction), {
                dx: worldPosition ? worldPosition.x - node.x : 0,
                dy: worldPosition ? worldPosition.y - node.y : 0,
                visible
            });
        });

        if (!state.dragging && !state.canvas?.isPanning) {
            node._portPositionCache = cache;
        }
        return cache;
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
        decoration = {
            group,
            arrows,
            active: false,
            pathData: '',
            totalLength: 0,
            edgePadding: 0,
            usableLength: 0,
            spacing: 0,
        };
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
        const shouldShow = isGlobalAnimationEnabled() && isActive && !!path.getAttribute('d');
        if (!shouldShow) {
            removeFlowDecoration(connId);
            return;
        }

        const decoration = ensureFlowDecoration(connId);
        const pathData = path.getAttribute('d') || '';
        if (decoration.pathData !== pathData) {
            let totalLength = 0;
            try {
                totalLength = path.getTotalLength();
            } catch {
                removeFlowDecoration(connId);
                return;
            }

            if (!Number.isFinite(totalLength) || totalLength < 80) {
                removeFlowDecoration(connId);
                return;
            }

            const arrowCount = decoration.arrows.length;
            const edgePadding = Math.min(28, totalLength * 0.18);
            const usableLength = Math.max(totalLength - edgePadding * 2, 1);
            decoration.pathData = pathData;
            decoration.totalLength = totalLength;
            decoration.edgePadding = edgePadding;
            decoration.usableLength = usableLength;
            decoration.spacing = Math.max(26, usableLength / Math.max(arrowCount - 1, 1));
        }
        decoration.active = true;
        decoration.group.classList.toggle('active', decoration.active);
        if (path.nextSibling !== decoration.group) {
            path.parentNode?.insertBefore(decoration.group, path.nextSibling);
        }
    }

    function stopFlowAnimation() {
        if (flowAnimationFrame !== null) {
            view.cancelAnimationFrame(flowAnimationFrame);
            flowAnimationFrame = null;
        }
        lastFlowAnimationTime = 0;
    }

    function scheduleFlowAnimation() {
        if (flowAnimationFrame !== null) return;
        if (!isGlobalAnimationEnabled()) return;
        flowAnimationFrame = view.requestAnimationFrame(animateFlowDecorations);
    }

    function animateFlowDecorations(now) {
        flowAnimationFrame = null;
        if (lastFlowAnimationTime && now - lastFlowAnimationTime < FLOW_ANIMATION_FRAME_MS) {
            scheduleFlowAnimation();
            return;
        }
        lastFlowAnimationTime = now;
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

            hasActiveDecoration = true;
            decoration.group.classList.add('active');

            const arrowCount = decoration.arrows.length;
            const totalLength = decoration.totalLength;
            const edgePadding = decoration.edgePadding;
            const usableLength = decoration.usableLength;
            const spacing = decoration.spacing;
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
            return;
        }

        scheduleFlowAnimation();
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
        scheduleFlowAnimation();
    }

    function getPortPosition(nodeId, portName, direction, containerRectOverride = null) {
        const node = getNodeById(nodeId);
        if (!node) return { x: 0, y: 0 };

        if (state.dragging && state.dragging.portOffsets) {
            const offset = state.dragging.portOffsets.get(`${nodeId}-${portName}-${direction}`);
            if (offset) return { x: node.x + offset.dx, y: node.y + offset.dy };
        }

        const portEl = getPortElement(node, portName, direction);
        if (!portEl) return { x: node.x, y: node.y };
        return getPortDotWorldPosition(portEl, containerRectOverride) || { x: node.x, y: node.y };
    }

    function isConnectionEndpointVisible(nodeId, portName, direction) {
        const node = getNodeById(nodeId);
        if (!node?.el) return false;
        return isPortElementVisible(getPortElement(node, portName, direction));
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

    function getPopupCandidateDirection(source) {
        return source?.isOutput ? 'input' : 'output';
    }

    function getPopupCandidatePort(source, definition, direction) {
        if (
            direction === 'input' &&
            source?.isOutput &&
            source.dataType === 'text' &&
            definition?.type === 'ImageGenerate'
        ) {
            const sourceNode = getNodeById(source.nodeId);
            const preferredPortName = sourceNode?.type === 'CameraControl' ? 'camera_prompt' : 'prompt';
            const ports = Array.isArray(definition.inputs) ? definition.inputs : [];
            const preferredPort = ports.find((port) => port?.name === preferredPortName && port?.type === 'text');
            if (preferredPort) return preferredPort;
        }

        return getFirstCompatibleDefinitionPort(definition, direction, source.dataType);
    }

    function getCompatibleNodeTypeCandidates(source) {
        if (!source?.dataType) return [];
        const direction = getPopupCandidateDirection(source);

        return listNodeDefinitions()
            .map((definition) => {
                const port = getPopupCandidatePort(source, definition, direction);
                if (!port) return null;
                return {
                    type: definition.type,
                    title: definition.title || definition.type,
                    matchPortName: port.name,
                    matchDirection: direction
                };
            })
            .filter(Boolean);
    }

    function createNodeFromConnectionCandidate(source, candidate, x, y) {
        if (!addNode || !source || !candidate) return false;
        if (isNodeRunning(source.nodeId)) {
            showToast('节点正在运行，暂不能修改连线', 'warning');
            return false;
        }

        const offsetX = source.isOutput ? 24 : -24;
        const nodeId = addNode(candidate.type, x + offsetX, y);
        if (!nodeId) return false;

        const target = {
            nodeId,
            port: candidate.matchPortName,
            type: source.dataType,
            dir: candidate.matchDirection
        };

        return finishConnection(source, target);
    }

    function getConnectionInsertScore(conn, node, containerRect, laneById = null) {
        if (typeof getConnectionSamplePoints !== 'function') return null;

        const bounds = expandBounds(getNodeBounds(node), INSERTION_PREVIEW_PADDING);
        const center = getNodeCenter(node);
        const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output', containerRect);
        const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input', containerRect);
        const samplePoints = getConnectionSamplePoints(from.x, from.y, to.x, to.y, getConnectionPathOptions(conn, laneById));

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
        if (isNodeRunning(nodeId)) return null;
        if (!node || !isNodeIsolated(nodeId)) return null;

        const containerRect = canvasContainer.getBoundingClientRect();
        const laneById = buildConnectionLaneMap(state.connections);
        let bestCandidate = null;

        for (const conn of state.connections) {
            if (hasRunningEndpoint(conn)) continue;
            if (conn.from.nodeId === nodeId || conn.to.nodeId === nodeId) continue;
            if (!getNodeById(conn.from.nodeId) || !getNodeById(conn.to.nodeId)) continue;

            const dataType = conn.type || '';
            const ports = getInsertionPorts(nodeId, dataType);
            if (!ports) continue;

            const score = getConnectionInsertScore(conn, node, containerRect, laneById);
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
        if (!state.connectionInsertPreview && insertionPreviewPaths.length === 0) return;
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
        const pathOptions = getConnectionPathOptions(conn, buildConnectionLaneMap());

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

    function getCurrentConnectionViewport(containerRect = null) {
        const { x, y, zoom } = state.canvas;
        const rect = containerRect || canvasContainer.getBoundingClientRect();
        return {
            left: -x / zoom,
            top: -y / zoom,
            right: (rect.width - x) / zoom,
            bottom: (rect.height - y) / zoom
        };
    }

    function getActiveConnectionSelectionInfo() {
        const relationCache = state.activeNodeRelationCache || {};
        return {
            activeNodeId: relationCache.anchorNodeId || state.activeNodeId || null,
            incomingConnectionIds: new Set(relationCache.incomingConnectionIds || []),
            outgoingConnectionIds: new Set(relationCache.outgoingConnectionIds || [])
        };
    }

    function ensureConnectionPath(conn) {
        let path = pathById.get(conn.id);
        if (path) return path;

        path = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('data-conn-id', conn.id);
        path.classList.add('connection-path');
        path.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (hasRunningEndpoint(conn)) {
                showToast('节点正在运行，暂不能修改连线', 'warning');
                return;
            }
            state.connections = state.connections.filter((candidate) => candidate.id !== conn.id);
            pathById.get(conn.id)?.remove();
            pathById.delete(conn.id);
            removeFlowDecoration(conn.id);
            rebuildConnectionIndex();
            updateAllConnections();
            updatePortStyles();
            showToast('连接已删除', 'info');
            scheduleSave();
            onConnectionsChanged();
        });
        connectionsGroup.appendChild(path);
        pathById.set(conn.id, path);
        return path;
    }

    function renderConnectionPath(conn, context = {}) {
        if (!conn?.id) return false;
        const {
            containerRect = canvasContainer.getBoundingClientRect(),
            viewport = getCurrentConnectionViewport(containerRect),
            laneById = getConnectionLaneMap(),
            selectionInfo = getActiveConnectionSelectionInfo(),
            padding = 100
        } = context;
        let path = pathById.get(conn.id);
        const fromNode = getNodeById(conn.from?.nodeId);
        const toNode = getNodeById(conn.to?.nodeId);
        if (!fromNode || !toNode) {
            if (path) {
                path.setAttribute('d', '');
                updateFlowDecoration(path, conn.id, false);
            }
            return false;
        }

        const isFromVisible = isNodeVisibleInViewport(fromNode, viewport, padding);
        const isToVisible = isNodeVisibleInViewport(toNode, viewport, padding);
        if (!isFromVisible && !isToVisible && path) {
            path.setAttribute('d', '');
            updateFlowDecoration(path, conn.id, false);
            return false;
        }

        const endpointsVisible = isConnectionEndpointVisible(conn.from.nodeId, conn.from.port, 'output') &&
            isConnectionEndpointVisible(conn.to.nodeId, conn.to.port, 'input');
        if (!endpointsVisible && path) {
            path.setAttribute('d', '');
            updateFlowDecoration(path, conn.id, false);
            return false;
        }
        if (!endpointsVisible) return false;

        const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output', containerRect);
        const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input', containerRect);
        const pathStr = createBezierPath(from.x, from.y, to.x, to.y, getConnectionPathOptions(conn, laneById));
        const isSelected = state.selectedNodes.has(conn.from.nodeId) ||
            state.selectedNodes.has(conn.to.nodeId) ||
            conn.from.nodeId === selectionInfo.activeNodeId ||
            conn.to.nodeId === selectionInfo.activeNodeId ||
            selectionInfo.incomingConnectionIds.has(conn.id) ||
            selectionInfo.outgoingConnectionIds.has(conn.id);

        path = ensureConnectionPath(conn);
        path.setAttribute('d', pathStr);
        path.classList.toggle('selected', isSelected);
        path.removeAttribute('stroke');
        updateFlowDecoration(path, conn.id, hasRunningEndpoint(conn));
        return true;
    }

    function updateAllConnections() {
        const { x, y, zoom } = state.canvas;
        const isDragging = !!state.dragging;
        const isPanning = state.canvas.isPanning;
        ensureConnectionIndex();
        invalidateConnectionLaneCache();

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
        const context = {
            containerRect,
            viewport: getCurrentConnectionViewport(containerRect),
            laneById: getConnectionLaneMap(),
            selectionInfo: getActiveConnectionSelectionInfo(),
            padding: 100
        };

        for (const conn of state.connections) {
            renderConnectionPath(conn, context);
        }

        dirtyConnectionIds.clear();
        renderConnectionInsertPreview();
        ensureFlowAnimation();
    }

    function updateDirtyConnections(options = {}) {
        ensureConnectionIndex();
        if (options.force === true) {
            return updateAllConnections();
        }
        if (dirtyConnectionIds.size === 0) return false;

        const { x, y, zoom } = state.canvas;
        connectionsGroup.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);
        if (originAxes) {
            originAxes.setAttribute('transform', `translate(${x}, ${y}) scale(${zoom})`);
        }

        const containerRect = canvasContainer.getBoundingClientRect();
        const context = {
            containerRect,
            viewport: getCurrentConnectionViewport(containerRect),
            laneById: getConnectionLaneMap(),
            selectionInfo: getActiveConnectionSelectionInfo(),
            padding: 100
        };

        Array.from(dirtyConnectionIds).forEach((connId) => {
            const conn = getConnectionById(connId);
            if (!conn) {
                pathById.get(connId)?.remove();
                pathById.delete(connId);
                removeFlowDecoration(connId);
                return;
            }
            renderConnectionPath(conn, context);
        });

        dirtyConnectionIds.clear();
        renderConnectionInsertPreview();
        ensureFlowAnimation();
        return true;
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

        invalidateConnectionLaneCache();
        const containerRect = canvasContainer.getBoundingClientRect();
        const context = {
            containerRect,
            viewport: getCurrentConnectionViewport(containerRect),
            laneById: getConnectionLaneMap(),
            selectionInfo: getActiveConnectionSelectionInfo(),
            padding: 100
        };
        for (const { conn, pathEl } of draggingState.connectionsToUpdate) {
            if (pathEl && !pathEl.isConnected) continue;
            renderConnectionPath(conn, context);
            dirtyConnectionIds.delete(conn?.id);
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
        if (isNodeRunning(preview.nodeId) || hasRunningEndpoint(conn)) {
            clearConnectionInsertPreview();
            showToast('节点正在运行，暂不能修改连线', 'warning');
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
        if (isNodeRunning(src.nodeId) || isNodeRunning(tgt.nodeId)) {
            return showToast('节点正在运行，暂不能修改连线', 'warning');
        }
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

        const replacedConnection = state.connections.find((conn) => conn.to.nodeId === toId && conn.to.port === toPort);
        if (replacedConnection && hasRunningEndpoint(replacedConnection)) {
            return showToast('节点正在运行，暂不能修改连线', 'warning');
        }

        if (!src.historyPushed) {
            pushHistory();
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
        documentRef.querySelectorAll('.node-port').forEach((portEl) => {
            portEl.classList.remove('is-hidden-by-collapse');
            portEl.setAttribute('aria-hidden', 'false');
        });
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
        state.nodes.forEach((node) => {
            if (!node?.el || !(node.collapsed === true || node.el.classList.contains('collapsed'))) return;
            node.el.querySelectorAll('.node-port').forEach((portEl) => {
                if (portEl.dataset.direction !== 'input') return;
                const dot = portEl.querySelector('.port-dot');
                const isConnected = dot?.classList.contains('connected') === true;
                if (isConnected) return;
                portEl.classList.add('is-hidden-by-collapse');
                portEl.setAttribute('aria-hidden', 'true');
            });
        });
    }

    return {
        getPortPosition,
        invalidateNodePortCache,
        measureNodePorts,
        markConnectionDirty,
        markNodeConnectionsDirty,
        rebuildConnectionIndex,
        updateAllConnections,
        updateDirtyConnections,
        updateDraggingConnections,
        clearConnectionInsertPreview,
        commitConnectionInsertPreview,
        getCompatibleNodeTypeCandidates,
        createNodeFromConnectionCandidate,
        finishConnection,
        drawTempConnection,
        updatePortStyles
    };
}
