/**
 * 负责节点端口连线的创建、删除、渲染与样式更新，是画布连接关系的核心实现。
 */
import { getFirstCompatibleDefinitionPort, listNodeDefinitions } from '../nodes/registry.js';
import { createCanvasConnectionRenderer } from './canvas-connection-renderer.js';
import { checkLineIntersection, getBezierCurveGeometry } from './geometry.js';
import { orderImageReferenceConnections } from '../nodes/image-reference-projection.js';
import {
    applyReferenceImagePorts,
    getNextInputConnectionOrder,
    isMultiConnectionInput,
    MAX_REFERENCE_IMAGE_COUNT
} from '../nodes/reference-image-ports.js';
import {
    getGenerationNodeInputConnectionPolicy,
    getProjectedInputConnectionPolicy,
    resolveGenerationInputProjection
} from '../nodes/generation-input-projection.js';
import { getGenerationInputProtocolId, getModelsForTask } from '../features/execution/provider-request-utils.js';
import { getProtocol } from '../features/execution/protocols/index.js';
import { isUniversalInputNode, resolveUniversalInput, planCompareInputSwap, planMoveMergeInput } from '../nodes/universal-input-policy.js';

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
    onNodeGeometryChanged = () => {},
    onTopologyChanged = null,
    addNode = null,
    prepareHistoryEdit = null,
    discardCreatedNode = null,
    selectCreatedNode = null,
    documentRef = document,
    performanceMonitor = null,
    connectionRenderer = null
}) {
    const pathById = new Map();
    const renderedPathGeometry = new WeakMap();
    const translatedPaths = new Set();
    const nodeGeometryRevisions = new WeakMap();
    let portGeometryRevision = 0;
    const connectionById = new Map();
    const connectionsByNodeId = new Map();
    let hoveredNodeId = null;
    const hoveredConnectionIds = new Set();
    function highlightNodeConnections(nodeId) {
        if (hoveredNodeId === nodeId) return;
        for (const id of hoveredConnectionIds) pathById.get(id)?.classList.remove('is-hovered');
        hoveredConnectionIds.clear();
        hoveredNodeId = nodeId;
        if (!nodeId) return;
        ensureConnectionIndex();
        for (const id of connectionsByNodeId.get(nodeId) || []) {
            pathById.get(id)?.classList.add('is-hovered');
            hoveredConnectionIds.add(id);
        }
    }
    // Only node boundary changes touch their incident paths, never pointermove
    // or curve geometry. Internal controls keep the same hover relationship.
    const onCanvasPointerOver = event => {
        highlightNodeConnections(event.target.closest?.('.node')?.id || null);
    };
    const onCanvasPointerLeave = () => highlightNodeConnections(null);
    canvasContainer.addEventListener?.('pointerover', onCanvasPointerOver);
    canvasContainer.addEventListener?.('pointerleave', onCanvasPointerLeave);
    const connectionsByPortKey = new Map();
    const dirtyConnectionIds = new Set();
    const dirtyNodeIds = new Set();
    const flowDecorationById = new Map();
    const curveGeometryById = new Map();
    const connectionHitSamples = new Map();
    const insertionPreviewPaths = [];
    let connectionHitIndex = null;
    let highlightedInsertPath = null;
    let highlightedInsertNode = null;
    let flowAnimationFrame = null;
    let connectionIndexSignature = '';
    let laneMapCacheRevision = 0;
    let laneMapBuiltRevision = -1;
    let laneMapCache = new Map();
    const portOrderCache = new Map();
    const view = documentRef.defaultView || window;
    const observedEndpoints = new Map();
    const endpointSizeObserver = view.ResizeObserver ? new view.ResizeObserver(entries => {
        for (const entry of entries) {
            const node = getNodeById(entry.target.id), observed = observedEndpoints.get(entry.target.id);
            if (!node || node.el !== entry.target || observed?.el !== entry.target) continue;
            const size = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;
            const width = size?.inlineSize ?? entry.contentRect.width;
            const height = size?.blockSize ?? entry.contentRect.height;
            if (observed.width === width && observed.height === height) continue;
            observed.width = width; observed.height = height;
            onNodeGeometryChanged(node.id);
        }
    }) : null;

    function observeEndpoint(node) {
        if (!endpointSizeObserver || !node?.el || observedEndpoints.get(node.id)?.el === node.el) return;
        const previous = observedEndpoints.get(node.id);
        if (previous) endpointSizeObserver.unobserve(previous.el);
        observedEndpoints.set(node.id, { el: node.el });
        endpointSizeObserver.observe(node.el, { box: 'border-box' });
    }
    const INSERTION_PREVIEW_PADDING = 24;
    const CONNECTION_HIT_CELL_SIZE = 256;
    const CONNECTION_HIT_CELL_LIMIT = 32;
    const CONNECTION_BOUNDS_PADDING = 100;
    const OUTPUT_PORT_TRANSITION = 28;
    const INPUT_PORT_TURN_LEAD = 72;
    const PAIR_LANE_GAP = 14;
    const PORT_LANE_GAP = 6;
    const NODE_LANE_GAP = 4;
    const MAX_LANE_OFFSET = 42;
    const FLOW_ANIMATION_TARGET_FPS = 60;
    const FLOW_ANIMATION_FRAME_MS = 1000 / FLOW_ANIMATION_TARGET_FPS;
    let lastFlowAnimationTime = 0;
    const TARGET_SNAP_RADIUS = 32;
    const TARGET_CELL_SIZE = TARGET_SNAP_RADIUS * 2;
    const TARGET_FEEDBACK_CLASSES = [
        'connection-target-available', 'connection-target-unavailable', 'connection-target-nearest'
    ];
    let targetLayout = null;
    let targetFeedback = null;
    let nearestTargetPort = null;
    let batchDragPreview = null;
    const highlightedTargetPorts = new Set();
    let targetLayoutObserver = null;
    let targetLayoutLayer = null;
    const canvasConnectionRenderer = connectionRenderer || createCanvasConnectionRenderer({
        canvasContainer,
        documentRef,
        state,
        windowRef: view
    });

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
        laneMapCacheRevision += 1;
        laneMapCache = new Map();
        laneMapBuiltRevision = -1;
        portOrderCache.clear();
    }

    function rebuildConnectionIndex() {
        targetFeedback = null;
        for (const [id, observed] of observedEndpoints) {
            if (getNodeById(id)?.el === observed.el) continue;
            endpointSizeObserver?.unobserve(observed.el);
            observedEndpoints.delete(id);
        }
        connectionById.clear();
        connectionsByNodeId.clear();
        connectionsByPortKey.clear();
        connectionHitSamples.clear();

        state.connections.forEach((connection) => {
            if (!connection?.id) return;
            connectionById.set(connection.id, connection);
            addToSetMap(connectionsByNodeId, connection.from?.nodeId, connection.id);
            addToSetMap(connectionsByNodeId, connection.to?.nodeId, connection.id);
            addToSetMap(connectionsByPortKey, getPortKey(connection.from?.nodeId, connection.from?.port, 'output'), connection.id);
            addToSetMap(connectionsByPortKey, getPortKey(connection.to?.nodeId, connection.to?.port, 'input'), connection.id);
        });

        connectionIndexSignature = getConnectionSignature();
        invalidateConnectionLaneCache();
    }

    function exportConnectionProjection() {
        if (translatedPaths.size) updateAllConnections();
        return state.connections.map((connection) => ({
            id: connection.id,
            d: pathById.get(connection.id)?.getAttribute?.('d') || '',
            selected: pathById.get(connection.id)?.classList?.contains?.('selected') === true,
            canvasRendered: pathById.get(connection.id)?.classList?.contains?.('canvas-rendered') === true,
            flowActive: flowDecorationById.get(connection.id)?.active === true,
            curveGeometry: curveGeometryById.get(connection.id) || null
        }));
    }

    function adoptConnectionProjection(projection = []) {
        translatedPaths.clear();
        pathById.forEach((path) => path.remove?.());
        pathById.clear();
        hoveredConnectionIds.clear();
        flowDecorationById.forEach((decoration) => decoration.group?.remove?.());
        flowDecorationById.clear();
        curveGeometryById.clear();
        rebuildConnectionIndex();
        const projectedById = new Map(
            (Array.isArray(projection) ? projection : [])
                .filter((entry) => entry?.id)
                .map((entry) => [entry.id, entry])
        );
        canvasConnectionRenderer.begin();
        state.connections.forEach((connection) => {
            const projected = projectedById.get(connection.id) || {};
            const path = ensureConnectionPath(connection);
            path.setAttribute('d', projected.d || '');
            path.classList.toggle('selected', projected.selected === true);
            updateConnectionHover(path, connection);
            const useCanvas = canvasConnectionRenderer.enabled && projected.canvasRendered === true && !!projected.curveGeometry;
            path.classList.toggle('canvas-rendered', useCanvas);
            if (useCanvas) {
                curveGeometryById.set(connection.id, projected.curveGeometry);
                canvasConnectionRenderer.draw(connection.id, projected.curveGeometry);
            }
            updateFlowDecoration(path, connection.id, projected.flowActive === true);
        });
        canvasConnectionRenderer.end();
        return {
            adoptedCount: pathById.size,
            hasUnmaterializedConnections: hasUnmaterializedConnections()
        };
    }

    function hasUnmaterializedConnections() {
        const containerRect = canvasContainer.getBoundingClientRect();
        const viewport = getCurrentConnectionViewport(containerRect);
        return state.connections.some((connection) => (
            !pathById.get(connection.id)?.getAttribute?.('d') &&
            isConnectionNearViewport(connection, viewport) &&
            isConnectionAwaitingLayout(connection)
        ));
    }

    function isConnectionNearViewport(connection, viewport) {
        const fromNode = getNodeById(connection.from?.nodeId);
        const toNode = getNodeById(connection.to?.nodeId);
        if (!fromNode || !toNode) return false;
        return connectionBoundsOverlapViewport(fromNode, toNode, viewport);
    }

    function isConnectionAwaitingLayout(connection) {
        const fromNode = getNodeById(connection.from?.nodeId);
        const toNode = getNodeById(connection.to?.nodeId);
        const fromPort = getPortElement(fromNode, connection.from?.port, 'output');
        const toPort = getPortElement(toNode, connection.to?.port, 'input');
        if (!fromPort || !toPort) return false;
        return [fromPort, toPort].every((portEl) => (
            !portEl.classList.contains('hidden')
        ));
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

    function markConnectionDirty(connId) {
        if (connId) {
            targetFeedback = null;
            dirtyConnectionIds.add(connId);
        }
    }

    function markNodeConnectionsDirty(nodeId) {
        if (nodeId) dirtyNodeIds.add(nodeId);
        targetFeedback = null;
        if (connectionsByNodeId.has(nodeId)) invalidateConnectionLaneCache();
    }

    function markAllConnectionsDirty() {
        ensureConnectionIndex();
        connectionById.forEach((_, connId) => dirtyConnectionIds.add(connId));
        invalidateConnectionLaneCache();
    }

    function isGlobalAnimationEnabled() {
        return state.globalAnimationEnabled !== false && state.performanceProtection?.active !== true;
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
        const cacheKey = `${nodeId || ''}:${direction || ''}:${portName || ''}`;
        if (portOrderCache.has(cacheKey)) return portOrderCache.get(cacheKey);
        const node = getNodeById(nodeId);
        const ports = Array.from(node?.el?.querySelectorAll?.(`.node-port[data-direction="${direction}"]`) || []);
        const index = ports.findIndex((portEl) => portEl.dataset.port === portName);
        const order = index >= 0 ? index : ports.length;
        portOrderCache.set(cacheKey, order);
        return order;
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
        if (laneMapBuiltRevision !== laneMapCacheRevision) {
            laneMapCache = buildConnectionLaneMap(state.connections);
            laneMapBuiltRevision = laneMapCacheRevision;
        }
        return laneMapCache;
    }

    function getNodePortCacheSignature(node) {
        if (!node?.el) return '';
        const bounds = getNodeBounds(node);
        const domWidth = node.el.offsetWidth || 0;
        const domHeight = node.el.offsetHeight || 0;
        const scrollWidth = node.el.scrollWidth || 0;
        const scrollHeight = node.el.scrollHeight || 0;
        const ports = Array.from(node.el.querySelectorAll?.('.node-port[data-direction]') || []);
        const portState = ports.map((portEl) => (
            `${portEl.dataset.direction || ''}:${portEl.dataset.port || ''}:${portEl.classList.contains('hidden') ? 'h' : 'v'}`
        )).join('|');
        return `${Math.round(bounds.right - bounds.left)}:${Math.round(bounds.bottom - bounds.top)}:${domWidth}:${domHeight}:${scrollWidth}:${scrollHeight}:${portState}`;
    }

    function getPortElement(node, portName, direction) {
        if (!node?.el) return null;
        if (direction === 'input' && isUniversalInputNode(node)) {
            const universal = node.el.querySelector?.('.universal-input[data-direction="input"]');
            if (universal) return universal;
        }
        return Array.from(node.el.querySelectorAll?.('.node-port[data-direction]') || [])
            .find((portEl) => (
                portEl.dataset.port === portName &&
                portEl.dataset.direction === direction
            )) || null;
    }

    function isPortElementVisible(portEl, dotRectOverride = null) {
        if (!portEl) return false;
        const dot = portEl.querySelector('.port-dot') || portEl;
        const dotRect = dotRectOverride || dot.getBoundingClientRect();
        return !portEl.classList.contains('hidden') &&
            portEl.offsetParent !== null &&
            dotRect.width > 0 &&
            dotRect.height > 0;
    }

    function getPortDotWorldPosition(portEl, containerRectOverride = null, dotRectOverride = null) {
        if (!portEl) return null;
        const dot = portEl.querySelector('.port-dot') || portEl;
        const dotRect = dotRectOverride || dot.getBoundingClientRect();
        if (dotRect.width <= 0 || dotRect.height <= 0) return null;

        const containerRect = containerRectOverride || canvasContainer.getBoundingClientRect();
        const { x: cx, y: cy } = state.canvas;
        const zoom = Math.max(0.0001, Number(state.canvas?.zoom) || 1);
        return {
            x: (dotRect.left + dotRect.width / 2 - containerRect.left - cx) / zoom,
            y: (dotRect.top + dotRect.height / 2 - containerRect.top - cy) / zoom
        };
    }

    function invalidateNodePortCache(nodeId = null, { markDirty = true, translationOnly = false, measurementOnly = false } = {}) {
        if (!measurementOnly) invalidateTargetLayout();
        if (translationOnly && nodeId && state.dragging) {
            if (markDirty) markNodeConnectionsDirty(nodeId);
            return;
        }
        // Drag-start offsets are valid only until actual size/port geometry changes.
        state.dragging?.portOffsets?.clear();
        if (nodeId) {
            const node = getNodeById(nodeId);
            if (node) {
                if (!measurementOnly) nodeGeometryRevisions.set(node, (nodeGeometryRevisions.get(node) || 0) + 1);
                delete node._portPositionCache;
            }
            if (measurementOnly) {
                connectionsByNodeId.get(nodeId)?.forEach((id) => connectionHitSamples.delete(id));
            }
            if (markDirty) markNodeConnectionsDirty(nodeId);
            return;
        }
        connectionHitSamples.clear();
        if (!measurementOnly) {
            portGeometryRevision += 1;
            connectionHitIndex = null;
        }
        state.nodes.forEach((node) => {
            if (node) delete node._portPositionCache;
        });
        if (markDirty) markAllConnectionsDirty();
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
            const dot = portEl.querySelector('.port-dot') || portEl;
            const dotRect = dot.getBoundingClientRect();
            const worldPosition = getPortDotWorldPosition(portEl, containerRectOverride, dotRect);
            const visible = isPortElementVisible(portEl, dotRect);
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

    function destroy() {
        endpointSizeObserver?.disconnect();
        observedEndpoints.clear();
        translatedPaths.clear();
        clearConnectionTargetFeedback();
        stopFlowAnimation();
        flowDecorationById.forEach((decoration) => decoration.group?.remove?.());
        flowDecorationById.clear();
        pathById.forEach((path) => path.remove?.());
        pathById.clear();
        hoveredConnectionIds.clear();
        hoveredNodeId = null;
        canvasContainer.removeEventListener?.('pointerover', onCanvasPointerOver);
        canvasContainer.removeEventListener?.('pointerleave', onCanvasPointerLeave);
        curveGeometryById.clear();
        connectionHitSamples.clear();
        connectionHitIndex = null;
        connectionById.clear();
        connectionsByNodeId.clear();
        connectionsByPortKey.clear();
        dirtyConnectionIds.clear();
        clearConnectionInsertPreview();
        canvasConnectionRenderer.destroy?.();
    }

    function getPortPosition(nodeId, portName, direction, containerRectOverride = null) {
        const node = getNodeById(nodeId);
        if (!node) return { x: 0, y: 0 };
        if (direction === 'input' && isUniversalInputNode(node) && node.el?.querySelector?.('.universal-input')) portName = 'auto';

        if (state.dragging && state.dragging.portOffsets) {
            const offset = state.dragging.portOffsets.get(`${nodeId}-${portName}-${direction}`);
            if (offset) return { x: node.x + offset.dx, y: node.y + offset.dy };
        }

        if (!state.dragging && !state.canvas?.isPanning) {
            const portKey = getPortKey(nodeId, portName, direction);
            const cache = node._portPositionCache || measureNodePorts(nodeId, containerRectOverride);
            const cachedPort = cache?.ports.get(portKey);
            if (cachedPort) return {
                x: node.x + cachedPort.dx,
                y: node.y + cachedPort.dy
            };
        }

        const portEl = getPortElement(node, portName, direction);
        if (!portEl) return { x: node.x, y: node.y };
        return getPortDotWorldPosition(portEl, containerRectOverride) || { x: node.x, y: node.y };
    }

    function isConnectionEndpointVisible(nodeId, portName, direction) {
        const node = getNodeById(nodeId);
        if (!node?.el) return false;
        if (direction === 'input' && isUniversalInputNode(node) && node.el.querySelector?.('.universal-input')) portName = 'auto';
        if (!state.dragging && !state.canvas?.isPanning) {
            const cache = node._portPositionCache || measureNodePorts(nodeId);
            const cachedPort = cache?.ports.get(getPortKey(nodeId, portName, direction));
            if (cachedPort) return cachedPort.visible;
        }
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
        if (direction === 'output' && isUniversalInputNode(getNodeById(source.nodeId))) {
            const targetNode = getNodeById(source.nodeId);
            return (definition.outputs || []).find(port => !resolveUniversalInput({ state,
                sourceNode: { id: Symbol('candidate-source'), type: definition.type, data: {} }, sourcePort: port.name,
                sourceType: port.type, targetNode, role: source.portName }).error) || null;
        }
        if (direction === 'input' && definition.type === 'ImageGenerate') {
            const models = getModelsForTask(state.models || [], 'image');
            const model = models.find(item => item.id === state.nodeDefaults?.ImageGenerate?.apiConfigId) || models[0];
            const policy = resolveUniversalInput({ state, sourceNode: getNodeById(source.nodeId),
                sourcePort: source.portName, sourceType: source.dataType,
                targetNode: { id: Symbol('candidate-target'), type: definition.type, apiConfigId: model?.id, data: {} } });
            if (policy.error) return null;
            return applyReferenceImagePorts(definition).inputs.find(port => port.name === policy.port) || null;
        }
        // Match the rendered input contract instead of legacy image_1/image_2 definitions.
        let effectiveDefinition = applyReferenceImagePorts(definition);
        if (definition.type === 'VideoGenerate' && direction === 'input') {
            const models = getModelsForTask(state.models || [], 'video');
            const selectedId = state.nodeDefaults?.VideoGenerate?.apiConfigId;
            const model = selectedId ? models.find((entry) => entry.id === selectedId) : models[0];
            const projection = resolveGenerationInputProjection({
                protocol: getProtocol(getGenerationInputProtocolId(model)), modelId: model?.modelId, taskType: 'video'
            });
            effectiveDefinition = { ...effectiveDefinition, inputs: effectiveDefinition.inputs.filter((port) => (
                getProjectedInputConnectionPolicy(projection, port.name).supported
            )) };
        }
        if (direction === 'output' && source.dataType === 'any') {
            return effectiveDefinition.outputs?.[0] || null;
        }
        return getFirstCompatibleDefinitionPort(effectiveDefinition, direction, source.dataType);
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
        if (state.canvasPlanApplying || state.historyTransitionInProgress) { showToast('画布正在修改，请稍后再连接', 'warning'); return false; }
        if (isNodeRunning(source.nodeId)) {
            showToast('节点正在运行，暂不能修改连线', 'warning');
            return false;
        }

        const sourceNode = getNodeById(source.nodeId);
        const sourcePort = getPortElement(sourceNode, source.portName, source.isOutput ? 'output' : 'input');
        if (!isPortElementVisible(sourcePort) || sourcePort.dataset.type !== source.dataType) {
            showToast('拖线端口已变化，请重新拖线创建节点', 'warning');
            return false;
        }
        const currentCandidate = getCompatibleNodeTypeCandidates(source).find((entry) => entry.type === candidate.type);
        if (!currentCandidate) {
            showToast('节点配置已变化，请重新拖线创建节点', 'warning');
            return false;
        }
        if (!source.isOutput && !isUniversalInputNode(sourceNode)) {
            const policy = getGenerationNodeInputConnectionPolicy(sourceNode, source.portName);
            const multiple = policy?.multiple ?? isMultiConnectionInput(sourceNode.type, source.portName);
            const count = state.connections.filter((connection) => (
                connection.to.nodeId === source.nodeId && connection.to.port === source.portName
            )).length;
            const maximum = multiple ? (policy?.maxCount ?? MAX_REFERENCE_IMAGE_COUNT) : 1;
            if (policy?.supported === false || count >= maximum) {
                showToast('输入端口已不可用或连接数已满，请重新拖线', 'warning');
                return false;
            }
        }

        let edit = null;
        const beforeConnections = state.connections.slice();
        let nodeId = null;
        const rollback = () => {
            if (nodeId) {
                state.connections = beforeConnections;
                discardCreatedNode?.(nodeId);
                updateAllConnections(); updatePortStyles(); onConnectionsChanged();
            }
            edit?.cancel();
        };
        try {
            edit = prepareHistoryEdit?.();
            const offsetX = source.isOutput ? 24 : -24;
            nodeId = addNode(currentCandidate.type, x + offsetX, y, undefined, Boolean(edit));
            if (!nodeId) { edit?.cancel(); return false; }
            const targetNode = getNodeById(nodeId);
            const targetPort = getPortElement(targetNode, currentCandidate.matchPortName, currentCandidate.matchDirection);
            const target = { nodeId, port: currentCandidate.matchPortName,
                type: targetPort?.dataset.type || source.dataType, dir: currentCandidate.matchDirection };
            const connected = finishConnection({ ...source, dragged: false, historyPushed: true }, target);
            if (!connected) {
                rollback();
                return false;
            }
            edit?.commit();
            selectCreatedNode?.(nodeId);
            return true;
        } catch (error) {
            rollback();
            showToast(error.message || '新建连接失败，原图已保留', 'warning');
            return false;
        }
    }

    function getBoundsCells(bounds) {
        return {
            left: Math.floor(bounds.left / CONNECTION_HIT_CELL_SIZE),
            top: Math.floor(bounds.top / CONNECTION_HIT_CELL_SIZE),
            right: Math.floor(bounds.right / CONNECTION_HIT_CELL_SIZE),
            bottom: Math.floor(bounds.bottom / CONNECTION_HIT_CELL_SIZE)
        };
    }

    function getCellCount(cells) {
        if (!Object.values(cells).every(Number.isSafeInteger)) return Infinity;
        return (cells.right - cells.left + 1) * (cells.bottom - cells.top + 1);
    }

    function visitCells(cells, visit) {
        for (let x = cells.left; x <= cells.right; x += 1) {
            for (let y = cells.top; y <= cells.bottom; y += 1) visit(`${x}:${y}`);
        }
    }

    function getConnectionHitIndex() {
        const type = state.connectionLineType || 'bezier';
        if (connectionHitIndex?.revision === laneMapCacheRevision && connectionHitIndex.type === type) {
            return connectionHitIndex;
        }

        const entries = [];
        const buckets = new Map();
        const wide = [];
        state.connections.forEach((connection, order) => {
            const from = getNodeById(connection.from?.nodeId);
            const to = getNodeById(connection.to?.nodeId);
            if (!connection.id || !from || !to) return;
            const bounds = expandBounds(getConnectionBounds(from, to), CONNECTION_BOUNDS_PADDING);
            const entry = { connection, bounds, order };
            entries.push(entry);
            const cells = getBoundsCells(bounds);
            // Long wires and large queries use a bounded scan, keeping the grid sparse.
            if (getCellCount(cells) <= CONNECTION_HIT_CELL_LIMIT) {
                visitCells(cells, key => addToSetMap(buckets, key, entry));
            } else {
                wide.push(entry);
            }
        });
        connectionHitIndex = { revision: laneMapCacheRevision, type, entries, buckets, wide };
        return connectionHitIndex;
    }

    function getNearbyConnections(index, bounds) {
        const cells = getBoundsCells(bounds);
        let entries = index.entries;
        if (getCellCount(cells) <= CONNECTION_HIT_CELL_LIMIT) {
            entries = new Set(index.wide);
            visitCells(cells, key => index.buckets.get(key)?.forEach(entry => entries.add(entry)));
        }
        return Array.from(entries).filter(entry => boundsOverlap(entry.bounds, bounds));
    }

    function getConnectionHitGeometry(connection, containerRect, laneById) {
        const fromNode = getNodeById(connection.from.nodeId);
        const toNode = getNodeById(connection.to.nodeId);
        const pathOptions = getConnectionPathOptions(connection, laneById);
        const signature = [
            nodeGeometryRevisions.get(fromNode), fromNode.x, fromNode.y,
            nodeGeometryRevisions.get(toNode), toNode.x, toNode.y,
            pathOptions.type, pathOptions.laneOffset, state.canvas.zoom
        ].join(':');
        const previous = connectionHitSamples.get(connection.id);
        if (previous?.signature === signature && previous.fromNode === fromNode && previous.toNode === toNode) {
            return previous;
        }
        const from = getPortPosition(connection.from.nodeId, connection.from.port, 'output', containerRect);
        const to = getPortPosition(connection.to.nodeId, connection.to.port, 'input', containerRect);
        const samplePoints = getConnectionSamplePoints(from.x, from.y, to.x, to.y, pathOptions);
        const geometry = { signature, fromNode, toNode, from, to, pathOptions, samplePoints };
        connectionHitSamples.set(connection.id, geometry);
        return geometry;
    }

    function findConnectionsCrossingSegments(segments) {
        const hits = new Set();
        if (!segments.length || typeof getConnectionSamplePoints !== 'function') return hits;
        ensureConnectionIndex();
        const index = getConnectionHitIndex();
        let laneById;
        let containerRect;
        // All samples in this frame hit the routes that were visible before the cut is applied.
        for (const [start, end] of segments) {
            const bounds = {
                left: Math.min(start.x, end.x), right: Math.max(start.x, end.x),
                top: Math.min(start.y, end.y), bottom: Math.max(start.y, end.y)
            };
            for (const { connection } of getNearbyConnections(index, bounds)) {
                if (hits.has(connection.id) || hasRunningEndpoint(connection)) continue;
                laneById ??= getConnectionLaneMap();
                containerRect ??= canvasContainer.getBoundingClientRect();
                const { samplePoints } = getConnectionHitGeometry(connection, containerRect, laneById);
                if (samplePoints.some((point, i) => i > 0 && checkLineIntersection(start, end, samplePoints[i - 1], point))) {
                    hits.add(connection.id);
                }
            }
        }
        return hits;
    }

    function getConnectionInsertScore(samplePoints, bounds, center) {
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
        if (draggingState.connectionShakeDetached || typeof getConnectionSamplePoints !== 'function') return null;

        const nodeId = draggingState.nodes[0];
        const node = getNodeById(nodeId);
        if (isNodeRunning(nodeId)) return null;
        ensureConnectionIndex();
        if (!node || connectionsByNodeId.has(nodeId)) return null;

        const nodeBounds = getNodeBounds(node);
        const bounds = expandBounds(nodeBounds, INSERTION_PREVIEW_PADDING);
        const center = { x: (nodeBounds.left + nodeBounds.right) / 2, y: (nodeBounds.top + nodeBounds.bottom) / 2 };
        const candidates = getNearbyConnections(getConnectionHitIndex(), bounds);
        if (!candidates.length) return null;
        const containerRect = canvasContainer.getBoundingClientRect();
        const laneById = getConnectionLaneMap();
        const portsByType = new Map();
        let bestCandidate = null;
        let bestOrder = Infinity;

        for (const { connection: conn, order } of candidates) {
            if (hasRunningEndpoint(conn)) continue;

            const dataType = conn.type || '';
            if (!portsByType.has(dataType)) portsByType.set(dataType, getInsertionPorts(nodeId, dataType));
            const ports = portsByType.get(dataType);
            if (!ports) continue;

            const { samplePoints } = getConnectionHitGeometry(conn, containerRect, laneById);
            const score = getConnectionInsertScore(samplePoints, bounds, center);
            if (score === null) continue;

            if (!bestCandidate || score < bestCandidate.score || (score === bestCandidate.score && order < bestOrder)) {
                bestOrder = order;
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

    function syncConnectionInsertHighlight(connectionId = null, nodeId = null) {
        const nextPath = pathById.get(connectionId) || null;
        const nextNode = (nodeId && getNodeById(nodeId)?.el) || null;
        if (highlightedInsertPath !== nextPath) {
            highlightedInsertPath?.classList.toggle('connection-insert-target', false);
            nextPath?.classList.toggle('connection-insert-target', true);
            highlightedInsertPath = nextPath;
        }
        if (highlightedInsertNode !== nextNode) {
            highlightedInsertNode?.classList.toggle('connection-insert-candidate', false);
            nextNode?.classList.toggle('connection-insert-candidate', true);
            highlightedInsertNode = nextNode;
        }
    }

    function clearConnectionInsertPreview() {
        syncConnectionInsertHighlight();
        insertionPreviewPaths.forEach((path) => path?.remove());
        insertionPreviewPaths.length = 0;
        state.connectionInsertPreview = null;
    }

    function renderConnectionInsertPreview(geometry = null) {
        const preview = state.connectionInsertPreview;
        if (!preview) {
            syncConnectionInsertHighlight();
            insertionPreviewPaths.forEach((path) => setSvgAttribute(path, 'd', ''));
            return;
        }

        const conn = connectionById.get(preview.connectionId);
        const node = getNodeById(preview.nodeId);
        if (!conn || !node) {
            clearConnectionInsertPreview();
            return;
        }

        const containerRect = canvasContainer.getBoundingClientRect();
        const from = geometry?.from || getPortPosition(conn.from.nodeId, conn.from.port, 'output', containerRect);
        const to = geometry?.to || getPortPosition(conn.to.nodeId, conn.to.port, 'input', containerRect);
        const nodeInput = getPortPosition(preview.nodeId, preview.inputPort, 'input', containerRect);
        const nodeOutput = getPortPosition(preview.nodeId, preview.outputPort, 'output', containerRect);
        const pathOptions = geometry?.pathOptions || getConnectionPathOptions(conn, getConnectionLaneMap());

        const inboundPath = ensureInsertionPreviewPath(0);
        const outboundPath = ensureInsertionPreviewPath(1);
        setSvgAttribute(inboundPath, 'd', createBezierPath(from.x, from.y, nodeInput.x, nodeInput.y, pathOptions));
        setSvgAttribute(outboundPath, 'd', createBezierPath(nodeOutput.x, nodeOutput.y, to.x, to.y, pathOptions));

        syncConnectionInsertHighlight(conn.id, node.id);
    }

    function updateConnectionInsertPreview(draggingState) {
        const candidate = findConnectionInsertPreview(draggingState);
        if (!candidate) {
            clearConnectionInsertPreview();
            return null;
        }

        state.connectionInsertPreview = candidate;
        renderConnectionInsertPreview(connectionHitSamples.get(candidate.connectionId));
        return candidate;
    }

    function createConnectionId() {
        return 'c_' + Math.random().toString(36).substr(2, 9);
    }

    function getConnectionBounds(fromNode, toNode, viewport = null) {
        const from = getNodeBounds(fromNode);
        const to = getNodeBounds(toNode);
        const bounds = {
            left: Math.min(from.left, to.left),
            right: Math.max(from.right, to.right),
            top: Math.min(from.top, to.top),
            bottom: Math.max(from.bottom, to.bottom)
        };
        if (viewport && (
            bounds.bottom < viewport.top || bounds.top > viewport.bottom ||
            (bounds.right >= viewport.left && bounds.left <= viewport.right)
        )) return bounds;
        if (state.connectionLineType !== 'orthogonal') {
            // Bound the Bézier control points using the largest possible port span.
            const span = Math.max(Math.abs(from.right - to.left), Math.abs(to.right - from.left));
            const { control1, control2 } = getBezierCurveGeometry(0, 0, span, 0, getConnectionPathOptions());
            bounds.right = Math.max(bounds.right, from.right + control1.x);
            bounds.left = Math.min(bounds.left, to.left + control2.x - span);
        }
        return bounds;
    }

    function boundsOverlap(first, second) {
        return first.right >= second.left && first.left <= second.right &&
            first.bottom >= second.top && first.top <= second.bottom;
    }

    function connectionBoundsOverlapViewport(fromNode, toNode, viewport) {
        const paddedViewport = expandBounds(viewport, CONNECTION_BOUNDS_PADDING);
        return boundsOverlap(getConnectionBounds(fromNode, toNode, paddedViewport), paddedViewport);
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

    function deleteConnection(connectionId) {
        const connection = getConnectionById(connectionId);
        if (!connection || hasRunningEndpoint(connection)) return false;
        state.connections = state.connections.filter((candidate) => candidate.id !== connectionId);
        pathById.get(connectionId)?.remove();
        pathById.delete(connectionId);
        hoveredConnectionIds.delete(connectionId);
        curveGeometryById.delete(connectionId);
        canvasConnectionRenderer.remove?.(connectionId);
        removeFlowDecoration(connectionId);
        rebuildConnectionIndex();
        updateAllConnections();
        updatePortStyles();
        scheduleSave();
        onConnectionsChanged();
        return true;
    }

    function getImageReferenceConnections(nodeId) {
        const nodeType = getNodeById(nodeId)?.type;
        return orderImageReferenceConnections(state.connections.filter(connection => connection.to.nodeId === nodeId
            && isMultiConnectionInput(nodeType, connection.to.port)), nodeType);
    }

    function isImageReferenceConnectionLocked(connection) {
        return hasRunningEndpoint(connection) || [connection.from.nodeId, connection.to.nodeId].some(nodeId =>
            ['waiting', 'running'].includes(getNodeById(nodeId)?.runStatus));
    }

    function moveImageReferenceConnection(nodeId, connectionId, targetConnectionId) {
        if (state.canvasPlanApplying || state.historyTransitionInProgress) return false;
        const connections = getImageReferenceConnections(nodeId);
        const from = connections.findIndex(connection => connection.id === connectionId);
        const to = connections.findIndex(connection => connection.id === targetConnectionId);
        if (from < 0 || to < 0 || from === to || connections.some(isImageReferenceConnectionLocked)) return false;
        pushHistory();
        connections.splice(to, 0, connections.splice(from, 1)[0]);
        const orders = new Map(connections.map((connection, index) => [connection.id, index]));
        state.connections = state.connections.map(connection => orders.has(connection.id)
            ? { ...connection, order: orders.get(connection.id) } : connection);
        rebuildConnectionIndex();
        updateAllConnections();
        updatePortStyles();
        scheduleSave();
        onConnectionsChanged();
        return true;
    }

    function disconnectImageReferenceConnection(nodeId, connectionId) {
        if (state.canvasPlanApplying || state.historyTransitionInProgress) return false;
        const connection = getImageReferenceConnections(nodeId).find(item => item.id === connectionId);
        if (!connection || isImageReferenceConnectionLocked(connection)) return false;
        pushHistory();
        return deleteConnection(connectionId);
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
            try { pushHistory(); }
            catch (error) { showToast(error.message, 'warning'); return; }
            state.connections = state.connections.filter((candidate) => candidate.id !== conn.id);
            pathById.get(conn.id)?.remove();
            pathById.delete(conn.id);
            hoveredConnectionIds.delete(conn.id);
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

    function setSvgAttribute(element, name, value) {
        if (element && element.getAttribute?.(name) !== value) element.setAttribute(name, value);
    }

    function updateConnectionHover(path, connection) {
        const hovered = hoveredNodeId === connection.from.nodeId || hoveredNodeId === connection.to.nodeId;
        path.classList.toggle('is-hovered', hovered);
        if (hovered) hoveredConnectionIds.add(connection.id);
        else hoveredConnectionIds.delete(connection.id);
    }

    function renderConnectionPath(conn, context = {}) {
        if (!conn?.id) return false;
        const {
            containerRect = canvasContainer.getBoundingClientRect(),
            viewport = getCurrentConnectionViewport(containerRect),
            laneById = getConnectionLaneMap()
        } = context;
        let path = pathById.get(conn.id);
        if (path) {
            if (translatedPaths.delete(path)) setSvgAttribute(path, 'transform', '');
            renderedPathGeometry.delete(path);
        }
        const fromNode = getNodeById(conn.from?.nodeId);
        const toNode = getNodeById(conn.to?.nodeId);
        observeEndpoint(fromNode);
        observeEndpoint(toNode);
        if (!fromNode || !toNode) {
            if (path) {
                setSvgAttribute(path, 'd', '');
                updateFlowDecoration(path, conn.id, false);
            }
            return false;
        }

        if (!connectionBoundsOverlapViewport(fromNode, toNode, viewport)) {
            if (path) {
                setSvgAttribute(path, 'd', '');
                updateFlowDecoration(path, conn.id, false);
            }
            return false;
        }

        const endpointsVisible = isConnectionEndpointVisible(conn.from.nodeId, conn.from.port, 'output') &&
            isConnectionEndpointVisible(conn.to.nodeId, conn.to.port, 'input');
        if (!endpointsVisible && path) {
            setSvgAttribute(path, 'd', '');
            updateFlowDecoration(path, conn.id, false);
            return false;
        }
        if (!endpointsVisible) return false;

        const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output', containerRect);
        const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input', containerRect);
        const pathOptions = getConnectionPathOptions(conn, laneById);
        const pathStr = createBezierPath(from.x, from.y, to.x, to.y, pathOptions);
        // Current selection alone controls emphasis; active-node history can outlive it.
        const isSelected = state.selectedNodes.has(conn.from.nodeId) ||
            state.selectedNodes.has(conn.to.nodeId);

        const usesBezier = pathOptions.type !== 'orthogonal';
        if (canvasConnectionRenderer.enabled && !isSelected && usesBezier) {
            const curveGeometry = getBezierCurveGeometry(from.x, from.y, to.x, to.y, pathOptions);
            curveGeometryById.set(conn.id, curveGeometry);
            canvasConnectionRenderer.draw(conn.id, curveGeometry);
        } else {
            curveGeometryById.delete(conn.id);
        }

        path = ensureConnectionPath(conn);
        path.classList.toggle('canvas-rendered', canvasConnectionRenderer.enabled && !isSelected && usesBezier);
        if (path.getAttribute('d') !== pathStr) {
            path.setAttribute('d', pathStr);
        }
        path.classList.toggle('selected', isSelected);
        updateConnectionHover(path, conn);
        path.removeAttribute('stroke');
        updateFlowDecoration(path, conn.id, hasRunningEndpoint(conn));
        renderedPathGeometry.set(path, {
            fromNode, toNode, fromX: fromNode.x, fromY: fromNode.y, toX: toNode.x, toY: toNode.y,
            revision: portGeometryRevision, signature: getConnectionSignature([conn]),
            fromRevision: nodeGeometryRevisions.get(fromNode) || 0, toRevision: nodeGeometryRevisions.get(toNode) || 0,
            laneOffset: pathOptions.laneOffset, type: pathOptions.type, zoom: state.canvas.zoom
        });
        return true;
    }

    function translateInternalDragPath(conn, draggedIds, laneById) {
        if (!draggedIds.has(conn.from.nodeId) || !draggedIds.has(conn.to.nodeId)) return false;
        const path = pathById.get(conn.id), baseline = path && renderedPathGeometry.get(path);
        const from = getNodeById(conn.from.nodeId), to = getNodeById(conn.to.nodeId);
        if (!baseline || !path.getAttribute('d') || baseline.fromNode !== from || baseline.toNode !== to
            || baseline.revision !== portGeometryRevision || baseline.zoom !== state.canvas.zoom
            || baseline.fromRevision !== (nodeGeometryRevisions.get(from) || 0)
            || baseline.toRevision !== (nodeGeometryRevisions.get(to) || 0)
            || baseline.signature !== getConnectionSignature([conn]) || hasRunningEndpoint(conn)
            || flowDecorationById.has(conn.id)) return false;
        const options = getConnectionPathOptions(conn, laneById);
        if (baseline.laneOffset !== options.laneOffset || baseline.type !== options.type) return false;
        const dx = from.x - baseline.fromX, dy = from.y - baseline.fromY;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)
            || Math.abs(dx - (to.x - baseline.toX)) > 0.0001
            || Math.abs(dy - (to.y - baseline.toY)) > 0.0001) return false;
        setSvgAttribute(path, 'transform', `translate(${dx}, ${dy})`);
        baseline.translation = { x: dx, y: dy };
        path.classList.toggle('selected', state.selectedNodes.has(from.id) || state.selectedNodes.has(to.id));
        translatedPaths.add(path);
        return true;
    }

    function updateAllConnections() {
        if (performanceMonitor?.measure) {
            return performanceMonitor.measure('connection-full-refresh', updateAllConnectionsImpl);
        }
        return updateAllConnectionsImpl();
    }

    function prepareWholeConnectionProjection({ reflectInteractionState = true } = {}) {
        for (const path of translatedPaths) setSvgAttribute(path, 'transform', '');
        translatedPaths.clear();
        const { x, y, zoom } = state.canvas;
        const isDragging = !!state.dragging;
        const isPanning = state.canvas.isPanning;
        ensureConnectionIndex();
        invalidateNodePortCache(null, { markDirty: false });
        invalidateConnectionLaneCache();

        setSvgAttribute(connectionsGroup, 'transform', `translate(${x}, ${y}) scale(${zoom})`);
        setSvgAttribute(originAxes, 'transform', `translate(${x}, ${y}) scale(${zoom})`);

        if (reflectInteractionState && (isDragging || isPanning)) {
            connectionsGroup.classList.add('is-dragging');
        } else {
            connectionsGroup.classList.remove('is-dragging', 'is-panning');
        }

        const currentConnIds = new Set(state.connections.map((conn) => conn.id));
        pathById.forEach((path, connId) => {
            if (!currentConnIds.has(connId)) {
                path.remove();
                pathById.delete(connId);
                hoveredConnectionIds.delete(connId);
                removeFlowDecoration(connId);
            }
        });
    }

    function getWholeConnectionRenderContext() {
        const containerRect = canvasContainer.getBoundingClientRect();
        return {
            containerRect,
            viewport: getCurrentConnectionViewport(containerRect),
            laneById: getConnectionLaneMap()
        };
    }

    function completeWholeConnectionProjection() {
        dirtyConnectionIds.clear();
        renderConnectionInsertPreview();
        ensureFlowAnimation();
    }

    function updateAllConnectionsImpl() {
        canvasConnectionRenderer.begin();
        try {
            prepareWholeConnectionProjection();
            const context = getWholeConnectionRenderContext();

            for (const conn of state.connections) {
                renderConnectionPath(conn, context);
            }

            completeWholeConnectionProjection();
        } finally {
            canvasConnectionRenderer.end();
        }
    }

    function beginConnectionRestoration() {
        canvasConnectionRenderer.begin();
        try {
            prepareWholeConnectionProjection({ reflectInteractionState: false });
        } catch (error) {
            canvasConnectionRenderer.end();
            throw error;
        }

        let nextConnectionIndex = 0;
        let finished = false;
        return {
            renderViewport() {
                if (finished) return true;
                const context = getWholeConnectionRenderContext();
                state.connections.forEach((connection) => {
                    if (isConnectionNearViewport(connection, context.viewport) || pathById.has(connection.id)) {
                        renderConnectionPath(connection, context);
                    }
                });
                nextConnectionIndex = state.connections.length;
                return true;
            },
            renderNextBatch(batchSize) {
                if (finished) return true;
                const context = getWholeConnectionRenderContext();
                const batchEnd = Math.min(nextConnectionIndex + batchSize, state.connections.length);
                while (nextConnectionIndex < batchEnd) {
                    renderConnectionPath(state.connections[nextConnectionIndex], context);
                    nextConnectionIndex += 1;
                }
                return nextConnectionIndex >= state.connections.length;
            },
            finish({ completed = false } = {}) {
                if (finished) return;
                finished = true;
                try {
                    if (completed) {
                        completeWholeConnectionProjection();
                    }
                } finally {
                    canvasConnectionRenderer.end();
                }
            }
        };
    }

    function updateDirtyConnections(options = {}) {
        ensureConnectionIndex();
        dirtyNodeIds.forEach((nodeId) => {
            connectionsByNodeId.get(nodeId)?.forEach((connId) => dirtyConnectionIds.add(connId));
        });
        dirtyNodeIds.clear();
        if (state.dragging) {
            connectionsGroup.classList.add('is-dragging');
            updateConnectionInsertPreview(state.dragging);
        }
        if (canvasConnectionRenderer.enabled) return updateAllConnections();
        if (options.force === true) {
            return updateAllConnections();
        }
        if (dirtyConnectionIds.size === 0) return false;

        const { x, y, zoom } = state.canvas;
        setSvgAttribute(connectionsGroup, 'transform', `translate(${x}, ${y}) scale(${zoom})`);
        setSvgAttribute(originAxes, 'transform', `translate(${x}, ${y}) scale(${zoom})`);

        const laneById = getConnectionLaneMap();
        const draggedIds = new Set(state.dragging?.isCloneDrag ? [] : state.dragging?.nodes || []);
        let context = null;
        Array.from(dirtyConnectionIds).forEach((connId) => {
            const conn = connectionById.get(connId);
            if (!conn) {
                translatedPaths.delete(pathById.get(connId));
                pathById.get(connId)?.remove();
                pathById.delete(connId);
                hoveredConnectionIds.delete(connId);
                removeFlowDecoration(connId);
                return;
            }
            if (translateInternalDragPath(conn, draggedIds, laneById)) return;
            if (!context) {
                const containerRect = canvasContainer.getBoundingClientRect();
                context = { containerRect, viewport: getCurrentConnectionViewport(containerRect), laneById };
            }
            renderConnectionPath(conn, context);
        });

        dirtyConnectionIds.clear();
        renderConnectionInsertPreview();
        ensureFlowAnimation();
        return true;
    }

    const CONNECTION_ENDPOINT_TOLERANCE = 0.5;

    function getRenderedPathEndpoints(path) {
        if (!path) return null;
        const translation = translatedPaths.has(path) ? renderedPathGeometry.get(path)?.translation : null;
        const point = (x, y) => ({ x: Number(x) + (translation?.x || 0), y: Number(y) + (translation?.y || 0) });
        try {
            const length = path.getTotalLength();
            const start = path.getPointAtLength(0);
            const end = path.getPointAtLength(length);
            return {
                from: point(start.x, start.y),
                to: point(end.x, end.y)
            };
        } catch {
            const values = (path.getAttribute('d') || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) || [];
            if (values.length < 4) return { from: null, to: null };
            return {
                from: point(values[0], values[1]),
                to: point(values.at(-2), values.at(-1))
            };
        }
    }

    function areEndpointsAligned(expected, actual) {
        if (!expected?.from || !expected?.to || !actual?.from || !actual?.to) return false;
        const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
        return distance(expected.from, actual.from) <= CONNECTION_ENDPOINT_TOLERANCE &&
            distance(expected.to, actual.to) <= CONNECTION_ENDPOINT_TOLERANCE;
    }

    function detectMisalignedConnections({ nodeIds = [], viewportOnly = false } = {}) {
        const nodeSet = new Set(Array.isArray(nodeIds) ? nodeIds : [nodeIds]);
        const containerRect = canvasContainer.getBoundingClientRect();
        const viewport = getCurrentConnectionViewport(containerRect);
        let candidates = state.connections;
        if (viewportOnly) {
            const endpointIds = new Set();
            candidates = candidates.filter((connection) => {
                // Keep checking drawn paths, including lines that cross the viewport
                // with both endpoints offscreen.
                if (!pathById.get(connection.id)?.getAttribute('d') && !isConnectionNearViewport(connection, viewport)) {
                    return false;
                }
                endpointIds.add(connection.from?.nodeId);
                endpointIds.add(connection.to?.nodeId);
                return true;
            });
            for (const nodeId of endpointIds) {
                if (nodeId) invalidateNodePortCache(nodeId, { markDirty: false, measurementOnly: true });
            }
        }
        return candidates.map((conn) => {
            if (nodeSet.size && !nodeSet.has(conn.from?.nodeId) && !nodeSet.has(conn.to?.nodeId)) return false;
            const path = pathById.get(conn.id);
            const pathData = path?.getAttribute('d') || '';
            if (!pathData) {
                if (!viewportOnly && !isConnectionNearViewport(conn, viewport)) return false;
                const endpointsVisible = isConnectionEndpointVisible(conn.from.nodeId, conn.from.port, 'output') &&
                    isConnectionEndpointVisible(conn.to.nodeId, conn.to.port, 'input');
                if (!endpointsVisible) return false;
            }
            const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output', containerRect);
            const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input', containerRect);
            const expected = { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } };
            const actual = pathData ? getRenderedPathEndpoints(path) : { from: null, to: null };
            if (areEndpointsAligned(expected, actual)) return false;
            if (path) renderedPathGeometry.delete(path);
            return {
                connectionId: conn.id,
                from: { nodeId: conn.from.nodeId, port: conn.from.port },
                to: { nodeId: conn.to.nodeId, port: conn.to.port },
                expected,
                actual,
                canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom }
            };
        }).filter(Boolean);
    }

    function realignConnections() {
        invalidateNodePortCache();
        updateAllConnections();
        return state.connections.length;
    }

    function updateDraggingConnections(draggingState) {
        if (!draggingState?.connectionsToUpdate?.length) {
            updateAllConnections();
            updateConnectionInsertPreview(draggingState);
            return;
        }

        const { x, y, zoom } = state.canvas;
        setSvgAttribute(connectionsGroup, 'transform', `translate(${x}, ${y}) scale(${zoom})`);
        setSvgAttribute(originAxes, 'transform', `translate(${x}, ${y}) scale(${zoom})`);
        connectionsGroup.classList.add('is-dragging');

        invalidateConnectionLaneCache();
        const containerRect = canvasContainer.getBoundingClientRect();
        const context = {
            containerRect,
            viewport: getCurrentConnectionViewport(containerRect),
            laneById: getConnectionLaneMap()
        };
        for (const { conn, pathEl } of draggingState.connectionsToUpdate) {
            if (pathEl && !pathEl.isConnected) continue;
            renderConnectionPath(conn, context);
            dirtyConnectionIds.delete(conn?.id);
        }

        updateConnectionInsertPreview(draggingState);
        ensureFlowAnimation();
    }

    function commitConnectionInsertPreview({ refresh = false } = {}) {
        if (refresh) {
            state.connectionInsertPreview = findConnectionInsertPreview(state.dragging);
            if (!state.connectionInsertPreview) {
                clearConnectionInsertPreview();
                return false;
            }
        }
        const preview = state.connectionInsertPreview;
        if (!preview) return false;
        if (state.canvasPlanApplying || state.historyTransitionInProgress) { clearConnectionInsertPreview(); return false; }

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

        let inputPort = preview.inputPort, outputTargetPort = conn.to.port, inputPolicy = null, outputPolicy = null;
        if (isUniversalInputNode(node)) {
            inputPolicy = resolveUniversalInput({ state, sourceNode: getNodeById(conn.from.nodeId),
                sourcePort: conn.from.port, sourceType: conn.type, targetNode: node, role: 'auto', ignoreConnectionId: conn.id });
            if (inputPolicy.error) { clearConnectionInsertPreview(); showToast(inputPolicy.error, 'warning'); return false; }
            inputPort = inputPolicy.port;
        }
        const targetNode = getNodeById(conn.to.nodeId);
        if (isUniversalInputNode(targetNode)) {
            const projectedState = { ...state, connections: [...state.connections.filter(edge => edge.id !== conn.id),
                { from: { ...conn.from }, to: { nodeId: node.id, port: inputPort }, type: conn.type }] };
            outputPolicy = resolveUniversalInput({ state: projectedState, sourceNode: node, sourcePort: preview.outputPort,
                sourceType: conn.type, targetNode, role: conn.to.port, ignoreConnectionId: conn.id });
            if (outputPolicy.error) { clearConnectionInsertPreview(); showToast(outputPolicy.error, 'warning'); return false; }
            outputTargetPort = outputPolicy.port;
        }

        try { state.dragging?.promoteHistory?.(); }
        catch (error) { clearConnectionInsertPreview(); showToast(error.message, 'warning'); return false; }
        state.connections = state.connections.filter((candidate) => candidate.id !== conn.id);
        state.connections.push(
            {
                id: createConnectionId(),
                from: { nodeId: conn.from.nodeId, port: conn.from.port },
                to: { nodeId: preview.nodeId, port: inputPort },
                type: conn.type,
                ...(inputPolicy?.multiple ? { order: 0 } : {})
            },
            {
                id: createConnectionId(),
                from: { nodeId: preview.nodeId, port: preview.outputPort },
                to: { nodeId: conn.to.nodeId, port: outputTargetPort },
                type: conn.type,
                ...(conn.order !== undefined ? { order: conn.order } : {}),
                ...(outputPolicy?.maskConsumption ? { maskConsumption: outputPolicy.maskConsumption } : {})
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

    function resolveConnection(src, tgt, connectionLookup, graphState) {
        const fromId = src.isOutput ? src.nodeId : tgt.nodeId;
        const fromPort = src.isOutput ? src.portName : tgt.port;
        const toId = src.isOutput ? tgt.nodeId : src.nodeId;
        let toPort = src.isOutput ? tgt.port : src.portName;
        const sourceNode = getNodeById(fromId), targetNode = getNodeById(toId);
        const output = getPortElement(sourceNode, fromPort, 'output');
        const type = output?.dataset.type || (src.isOutput ? src.dataType : (tgt.type || tgt.dataType));
        let policy = null;
        if (isUniversalInputNode(targetNode)) {
            if (!output) return { error: '来源输出已变化，请重新连接' };
            if (src.isOutput && src.dataType !== type) return { error: '来源输出类型已变化，请重新拖线' };
            policy = resolveUniversalInput({ state: graphState, sourceNode, sourcePort: fromPort, sourceType: type,
                targetNode, role: toPort, ignoreConnectionId: src.rewiredFromConnection?.id || null, connectionLookup });
            if (policy.error) return policy;
            toPort = policy.port;
        }
        return { fromId, fromPort, toId, toPort, type, policy, error: '' };
    }

    function getConnectionTargetError(src, tgt) {
        return checkConnectionTarget(src, tgt).error || null;
    }

    function checkConnectionTarget(src, tgt, connectionLookup, graphState = state) {
        if (state.canvasPlanApplying || state.historyTransitionInProgress) return { error: '画布正在修改，请稍后再连接' };
        if (!src || !tgt || !getNodeById(src.nodeId) || !getNodeById(tgt.nodeId)) return { error: '端口不存在' };
        if (isNodeRunning(src.nodeId) || isNodeRunning(tgt.nodeId)) return { error: '节点正在运行，暂不能修改连线' };
        const rewiredId = src.rewiredFromConnection?.id;
        const rewiredConnection = rewiredId && (connectionLookup
            ? connectionLookup.byId.get(rewiredId)
            : graphState.connections.find((connection) => connection.id === rewiredId));
        if (rewiredConnection && hasRunningEndpoint(rewiredConnection)) return { error: '节点正在运行，暂不能修改连线' };
        if (src.nodeId === tgt.nodeId) return { error: '不能连接同一节点' };
        if (src.isOutput && tgt.dir === 'output') return { error: '不能连接两个输出' };
        if (!src.isOutput && tgt.dir === 'input') return { error: '不能连接两个输入' };
        if (state.connecting === src) {
            const sourcePort = getPortElement(getNodeById(src.nodeId), src.portName, src.isOutput ? 'output' : 'input');
            if (!sourcePort || sourcePort.isConnected === false || sourcePort.dataset.port !== src.portName ||
                sourcePort.dataset.type !== src.dataType || sourcePort.classList.contains('hidden')) {
                return { error: '来源端口已变化，请重新连接' };
            }
        }

        const targetType = src.isOutput ? (tgt.type || tgt.dataType) : src.dataType;
        const sourceType = src.isOutput ? src.dataType : (tgt.type || tgt.dataType);
        const resolved = resolveConnection(src, tgt, connectionLookup, graphState);
        if (resolved.error) return resolved;
        if (!resolved.policy && targetType !== 'any' && sourceType !== targetType) {
            return { error: '类型不匹配' };
        }

        const { fromId, fromPort, toId, toPort } = resolved;
        const toNode = getNodeById(toId);
        const projectedPolicy = getGenerationNodeInputConnectionPolicy(toNode, toPort);
        if (projectedPolicy && !projectedPolicy.supported) {
            return { error: '当前模型不支持此输入端口' };
        }
        const isMultiConnection = projectedPolicy?.multiple ?? isMultiConnectionInput(toNode?.type, toPort);

        const incoming = connectionLookup ? (connectionLookup.incomingByNode.get(toId) || []) : graphState.connections;
        const inputConnections = incoming.filter((conn) => conn.to.nodeId === toId && conn.to.port === toPort);
        if (inputConnections.some((conn) => (!rewiredId || conn.id !== rewiredId) && conn.from.nodeId === fromId && conn.from.port === fromPort)) {
            return { error: '连接已存在' };
        }

        const maximumConnections = projectedPolicy?.maxCount ?? MAX_REFERENCE_IMAGE_COUNT;
        if (!resolved.policy && isMultiConnection && inputConnections.length >= maximumConnections) {
            return { error: `此输入端口最多连接 ${maximumConnections} 张图片` };
        }

        const replacedConnection = isMultiConnection ? null : inputConnections[0];
        if (replacedConnection && hasRunningEndpoint(replacedConnection)) {
            return { error: '节点正在运行，暂不能修改连线' };
        }
        return { ...resolved, isMultiConnection, inputConnections, rewiredConnection };
    }

    function buildConnectionLookup(connections, { reverse = false, ignoredId } = {}) {
        const byId = new Map();
        const incomingByNode = new Map();
        const neighbors = new Map();
        for (const connection of connections) {
            if (connection.id) byId.set(connection.id, connection);
            const fromId = connection.from?.nodeId;
            const toId = connection.to?.nodeId;
            if (!fromId || !toId) continue;
            if (!incomingByNode.has(toId)) incomingByNode.set(toId, []);
            incomingByNode.get(toId).push(connection);
            if (!ignoredId || connection.id !== ignoredId) {
                addToSetMap(neighbors, reverse ? toId : fromId, reverse ? fromId : toId);
            }
        }
        return { byId, incomingByNode, neighbors };
    }

    function getReachableNodes(neighbors, startId) {
        const reachable = new Set();
        const queue = [startId];
        while (queue.length) {
            const nodeId = queue.pop();
            if (!nodeId || reachable.has(nodeId)) continue;
            reachable.add(nodeId);
            for (const neighbor of neighbors.get(nodeId) || []) queue.push(neighbor);
        }
        return reachable;
    }

    function buildTargetConnectionLookup(source) {
        // A fixed output searches ancestors. A fixed input searches descendants.
        const { byId, incomingByNode, neighbors } = buildConnectionLookup(state.connections, {
            reverse: source?.isOutput, ignoredId: source?.rewiredFromConnection?.id
        });
        const reachable = getReachableNodes(neighbors, source?.nodeId);
        return {
            byId,
            incomingByNode,
            createsCycle(fromId, toId) { return reachable.has(source?.isOutput ? toId : fromId); }
        };
    }

    function invalidateTargetLayout() {
        targetLayout = null;
    }

    function isTargetLayoutMutation(record) {
        if (record.type === 'attributes' && record.attributeName === 'class' && record.target.matches('.node-port')) {
            // Feedback classes change only opacity and shadows. Do not invalidate our own writes.
            const withoutFeedback = (value) => (value || '').split(/\s+/)
                .filter((name) => name && !TARGET_FEEDBACK_CLASSES.includes(name)).join(' ');
            return withoutFeedback(record.oldValue) !== withoutFeedback(record.target.getAttribute('class'));
        }
        if (record.type === 'characterData') return record.target.parentElement?.closest?.('.node-port');
        if (record.type === 'childList') {
            return record.target.closest?.('.node-port') ||
                [...record.addedNodes, ...record.removedNodes].some((node) =>
                    node.matches?.('.node-port') || node.querySelector?.('.node-port'));
        }
        return record.target.closest?.('.node-port') ||
            (record.target.matches?.('.node, .node-ports-row, .node-inputs-section, .node-outputs-section') &&
                record.target.querySelector?.('.node-port'));
    }

    function observeTargetLayout() {
        const layer = canvasContainer.querySelector?.('#nodes-layer');
        if (targetLayoutObserver || !view.MutationObserver || !layer) return;
        targetLayoutObserver = new view.MutationObserver((records) => {
            if (records.some(isTargetLayoutMutation)) invalidateTargetLayout();
        });
        targetLayoutObserver.observe(layer, {
            subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true,
            attributeFilter: ['class', 'style', 'hidden', 'data-type', 'data-direction', 'data-node-id', 'data-port']
        });
        targetLayoutLayer = layer;
        layer.addEventListener('scroll', invalidateTargetLayout, true);
    }

    function readConnectionTarget(portEl) {
        const { nodeId, port, type, direction: dir } = portEl.dataset;
        return { nodeId, port, type, dir };
    }

    function getVisibleConnectionPorts(nodeId, direction) {
        const ports = getNodeById(nodeId)?.el?.querySelectorAll(`.node-port[data-direction="${direction}"]`) || [];
        return Array.from(ports)
            .filter(port => port.isConnected !== false && port.hidden !== true && port.offsetParent !== null &&
                !port.classList.contains('hidden') && !port.classList.contains('image-first-canonical-input'))
            .map(readConnectionTarget)
            .filter(port => port.nodeId === nodeId && port.port && port.type);
    }

    function getBatchConnectionSources(nodeIds) {
        return Array.from(new Set(nodeIds)).flatMap(nodeId => {
            if (isNodeRunning(nodeId)) return [];
            const outputs = getVisibleConnectionPorts(nodeId, 'output').map(port => ({
                nodeId, portName: port.port, dataType: port.type, isOutput: true
            }));
            return outputs.length ? [{ nodeId, outputs }] : [];
        });
    }

    function isBatchDrag(source) {
        return Boolean(source?.isOutput && source.dragged && source.selectedNodeIds?.length > 1);
    }

    function getBatchDragSources(source) {
        const groups = getBatchConnectionSources([source.nodeId, ...source.selectedNodeIds]);
        const anchor = groups[0]?.nodeId === source.nodeId && groups[0].outputs.some(port =>
            port.portName === source.portName && port.dataType === source.dataType);
        if (!anchor) return [];
        return [source, ...groups.slice(1).flatMap(({ outputs }) => {
            const compatible = outputs.filter(port => port.dataType === source.dataType);
            const preferred = compatible.find(port => port.portName === source.portName) || compatible[0];
            return preferred ? [preferred] : [];
        })];
    }

    function measureConnectionTarget(portEl) {
        const dot = portEl.querySelector('.port-dot');
        const rect = dot?.getBoundingClientRect();
        if (!rect || !isPortElementVisible(portEl, rect)) return null;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    function getTargetLayout() {
        const { x, y, zoom } = state.canvas;
        const containerRect = canvasContainer.getBoundingClientRect?.();
        const dense = canvasContainer.classList?.contains('canvas-dense-mode');
        const viewport = `${x}:${y}:${zoom}:${containerRect?.left}:${containerRect?.top}:${containerRect?.width}:${containerRect?.height}:${state.themeId}:${dense}`;
        if (targetLayout?.viewport === viewport) return targetLayout;
        const cells = new Map();
        const ports = Array.from((canvasContainer.querySelectorAll ? canvasContainer : documentRef).querySelectorAll('.node-port'));
        const entries = ports.map((portEl, order) => {
            const center = measureConnectionTarget(portEl);
            const entry = { portEl, center, order };
            if (center) {
                const cell = `${Math.floor(center.x / TARGET_CELL_SIZE)}:${Math.floor(center.y / TARGET_CELL_SIZE)}`;
                if (!cells.has(cell)) cells.set(cell, []);
                cells.get(cell).push(entry);
            }
            return entry;
        });
        for (const portEl of highlightedTargetPorts) {
            if (portEl.isConnected !== false) continue;
            portEl.classList.remove(...TARGET_FEEDBACK_CLASSES);
            highlightedTargetPorts.delete(portEl);
        }
        targetLayout = { viewport, containerRect, cells, entries };
        return targetLayout;
    }

    function findNearestConnectionTarget(clientX, clientY, radius, layout, canConnect) {
        let nearest = null;
        let bestDistanceSquared = radius * radius;
        for (const entry of nearbyTargetPorts(layout, clientX, clientY, radius)) {
            const { portEl, center, order } = entry;
            if (!center) continue;
            const dx = clientX - center.x, dy = clientY - center.y;
            const distanceSquared = dx * dx + dy * dy;
            if (distanceSquared > bestDistanceSquared || (distanceSquared === bestDistanceSquared && order < nearest?.order)) continue;
            if (portEl.isConnected === false || portEl.classList.contains('hidden') || portEl.offsetParent === null) continue;
            const target = readConnectionTarget(portEl);
            if (!canConnect(target)) continue;
            bestDistanceSquared = distanceSquared;
            nearest = { target, entry, order };
        }
        if (!nearest) return null;
        const { target, entry } = nearest;
        const rect = layout.containerRect;
        const { x, y, zoom } = state.canvas;
        const position = rect
            ? { x: (entry.center.x - rect.left - x) / zoom, y: (entry.center.y - rect.top - y) / zoom }
            : getPortPosition(target.nodeId, target.port, target.dir);
        return { target, position, portEl: entry.portEl };
    }

    function* nearbyTargetPorts(layout, clientX, clientY, radius) {
        const left = Math.floor((clientX - radius) / TARGET_CELL_SIZE);
        const right = Math.floor((clientX + radius) / TARGET_CELL_SIZE);
        const top = Math.floor((clientY - radius) / TARGET_CELL_SIZE);
        const bottom = Math.floor((clientY + radius) / TARGET_CELL_SIZE);
        if (![left, right, top, bottom].every(Number.isSafeInteger) ||
            (right - left + 1) * (bottom - top + 1) > Math.max(4, layout.cells.size)) {
            yield* layout.entries;
            return;
        }
        for (let cellX = left; cellX <= right; cellX += 1) {
            for (let cellY = top; cellY <= bottom; cellY += 1) {
                yield* layout.cells.get(`${cellX}:${cellY}`) || [];
            }
        }
    }

    function getNearestConnectionTarget(src, clientX, clientY, radius = TARGET_SNAP_RADIUS) {
        if (![clientX, clientY, radius].every(Number.isFinite) || radius < 0) return null;
        // The mouseup coordinates and layout can both have changed since the last feedback frame.
        invalidateTargetLayout();
        const { canConnect } = createConnectionTargetCheck(src);
        const nearest = findNearestConnectionTarget(clientX, clientY, radius, getTargetLayout(), canConnect);
        if (!nearest) return null;
        return { target: nearest.target, position: nearest.position };
    }

    function createConnectionTargetCheck(source) {
        if (!isBatchDrag(source)) {
            const lookup = buildTargetConnectionLookup(source);
            return { canConnect: target => !checkConnectionTarget(source, target, lookup).error };
        }
        const batchSources = getBatchDragSources(source);
        const { byId, incomingByNode, neighbors } = buildConnectionLookup(state.connections);
        const availableTargets = new Map();
        function canConnect(target) {
            if (target.dir !== 'input' || !batchSources.length) return false;
            if (target.type !== 'any' && target.type !== source.dataType && !isUniversalInputNode(getNodeById(target.nodeId))) return false;
            const key = `${target.nodeId}:${target.port}:${target.type}`;
            if (availableTargets.has(key)) return availableTargets.get(key);
            const reachable = getReachableNodes(neighbors, target.nodeId);
            const lookup = { byId, incomingByNode, createsCycle: fromId => reachable.has(fromId) };
            const available = batchSources.some(candidate => {
                if (lookup.createsCycle(candidate.nodeId)) return false;
                const result = checkConnectionTarget(candidate, target, lookup);
                return !result.error && (candidate === source || result.isMultiConnection || !result.inputConnections.length);
            });
            availableTargets.set(key, available);
            return available;
        }
        return { batchSources, canConnect };
    }

    function updateConnectionTargetFeedback(src, clientX = NaN, clientY = NaN) {
        observeTargetLayout();
        const layout = getTargetLayout();
        const connections = state.connections;
        const running = [...(state.runningNodeIds || [])].join('|');
        const blocked = !!(state.canvasPlanApplying || state.historyTransitionInProgress);
        const modelSettings = state.models;
        const previousFeedback = targetFeedback;
        const batch = isBatchDrag(src);
        const graphChanged = !previousFeedback || previousFeedback.source !== src || previousFeedback.connections !== connections ||
            previousFeedback.connectionCount !== connections.length || previousFeedback.batch !== batch;
        if (graphChanged || previousFeedback.running !== running || previousFeedback.blocked !== blocked ||
            previousFeedback.modelSettings !== modelSettings || previousFeedback.layout !== layout) {
            const { batchSources, canConnect } = createConnectionTargetCheck(src);
            targetFeedback = { source: src, connections, connectionCount: connections.length,
                running, blocked, modelSettings, layout, batch, batchSources, canConnect };
            for (const { portEl, center } of layout.entries) {
                const available = !!center && canConnect(readConnectionTarget(portEl));
                highlightedTargetPorts.add(portEl);
                setTargetClass(portEl, 'connection-target-available', available);
                setTargetClass(portEl, 'connection-target-unavailable', !available);
            }
        }
        const nearest = Number.isFinite(clientX) && Number.isFinite(clientY)
            ? findNearestConnectionTarget(clientX, clientY, TARGET_SNAP_RADIUS, layout, targetFeedback.canConnect)
            : null;
        if (nearestTargetPort !== nearest?.portEl) {
            if (nearestTargetPort) setTargetClass(nearestTargetPort, 'connection-target-nearest', false);
            nearestTargetPort = nearest?.portEl || null;
            if (nearestTargetPort) setTargetClass(nearestTargetPort, 'connection-target-nearest', true);
        }
        const target = nearest && { target: nearest.target, position: nearest.position };
        if (!batch) return target;

        const previewSources = getBatchPreviewSources(targetFeedback, nearest);
        showBatchDragPreview(layout, nearest, previewSources.length, clientX, clientY);
        return {
            ...target,
            starts: previewSources.map(({ nodeId, portName }) => getPortPosition(nodeId, portName, 'output', layout.containerRect))
        };
    }

    function setTargetClass(portEl, name, enabled) {
        if (portEl.classList.contains(name) !== enabled) portEl.classList.toggle(name, enabled);
    }

    function getBatchPreviewSources(feedback, nearest) {
        const { batchSources, source } = feedback;
        if (!nearest) return batchSources;
        if (feedback.previewPort !== nearest.portEl) {
            feedback.previewPort = nearest.portEl;
            feedback.previewSources = planConnectionBatch(
                batchSources.map(output => ({ outputs: [output] })), [nearest.target], source
            ).acceptedSources;
        }
        return feedback.previewSources;
    }

    function showBatchDragPreview(layout, nearest, count, clientX, clientY) {
        if (!count || !layout.containerRect || !Number.isFinite(clientX) || !Number.isFinite(clientY)) {
            batchDragPreview?.remove();
            batchDragPreview = null;
            return;
        }
        if (!batchDragPreview) {
            batchDragPreview = documentRef.createElement('div');
            batchDragPreview.className = 'connection-batch-preview';
            batchDragPreview.setAttribute('aria-hidden', 'true');
            canvasContainer.appendChild(batchDragPreview);
        }
        const { left, top, right, bottom } = layout.containerRect;
        const text = `${nearest ? '连接 ' : ''}${count} 个来源`;
        if (batchDragPreview.textContent !== text) batchDragPreview.textContent = text;
        batchDragPreview.classList.toggle('is-snapped', Boolean(nearest));
        batchDragPreview.style.setProperty('--preview-x', `${(clientX > right - 150 ? clientX - 14 : clientX + 14) - left}px`);
        batchDragPreview.style.setProperty('--preview-y', `${(clientY > bottom - 48 ? clientY - 38 : clientY + 14) - top}px`);
        batchDragPreview.classList.toggle('is-left', clientX > right - 150);
    }

    function clearConnectionTargetFeedback() {
        targetLayoutLayer?.removeEventListener('scroll', invalidateTargetLayout, true);
        targetLayoutLayer = null;
        targetLayoutObserver?.disconnect();
        targetLayoutObserver = null;
        invalidateTargetLayout();
        targetFeedback = null;
        nearestTargetPort = null;
        for (const portEl of highlightedTargetPorts) portEl.classList.remove(...TARGET_FEEDBACK_CLASSES);
        highlightedTargetPorts.clear();
        batchDragPreview?.remove();
        batchDragPreview = null;
    }

    function appendConnection(connections, checked) {
        const { fromId, fromPort, toId, toPort, type, policy, isMultiConnection, rewiredConnection, inputConnections } = checked;
        if (rewiredConnection) connections = connections.filter(connection => connection.id !== rewiredConnection.id);
        if (!isMultiConnection && inputConnections.length) {
            connections = connections.filter(connection => connection.to.nodeId !== toId || connection.to.port !== toPort);
        }
        connections.push({
            id: createConnectionId(),
            from: { nodeId: fromId, port: fromPort },
            to: { nodeId: toId, port: toPort },
            type,
            ...(policy?.maskConsumption ? { maskConsumption: policy.maskConsumption } : {}),
            ...(isMultiConnection ? {
                order: getNextInputConnectionOrder(connections, { nodeId: toId, port: toPort })
            } : {})
        });
        return connections;
    }

    function commitConnections(connections, message, change) {
        state.connections = connections;
        if (change && onTopologyChanged) onTopologyChanged(change);
        else updateAllConnections();
        updatePortStyles();
        showToast(message, 'success');
        scheduleSave();
        onConnectionsChanged();
    }

    function planConnectionBatch(sources, targets, replacementSource = null) {
        const graphState = { ...state, connections: [...state.connections] };
        const connectedNodeIds = new Set();
        const connectionIds = new Set();
        const acceptedSources = [];
        const { byId, incomingByNode, neighbors } = buildConnectionLookup(state.connections);
        // Every edge in the batch points at the same node, so its downstream reachability stays fixed.
        const targetNodeId = targets[0]?.nodeId;
        const reachable = getReachableNodes(neighbors, targetNodeId);
        const lookup = { byId, incomingByNode, createsCycle: fromId => reachable.has(fromId) };
        for (const { outputs } of sources) {
            for (const output of outputs) {
                if (lookup.createsCycle(output.nodeId)) continue;
                let match;
                for (const target of targets) {
                    const result = checkConnectionTarget(output, target, lookup, graphState);
                    if (!result.error && (result.isMultiConnection || !result.inputConnections.length || output === replacementSource)) {
                        match = result;
                        break;
                    }
                }
                if (!match) continue;
                const incoming = incomingByNode.get(targetNodeId) || [];
                graphState.connections = appendConnection(graphState.connections, match);
                const edge = graphState.connections.at(-1);
                if (!match.isMultiConnection) {
                    for (const replaced of match.inputConnections) {
                        connectedNodeIds.add(replaced.from.nodeId);
                        connectionIds.add(replaced.id);
                    }
                }
                incomingByNode.set(targetNodeId, [...(match.isMultiConnection ? incoming : incoming.filter(item => item.to.port !== match.toPort)), edge]);
                connectedNodeIds.add(match.fromId);
                connectedNodeIds.add(match.toId);
                connectionIds.add(edge.id);
                acceptedSources.push(output);
                break;
            }
        }
        return { connections: graphState.connections, acceptedSources, connectedNodeIds, connectionIds };
    }

    function commitConnectionBatch(plan) {
        const count = plan.acceptedSources.length;
        if (!count) {
            showToast('没有可连接的来源', 'info');
            return null;
        }
        try { pushHistory(); }
        catch (error) { showToast(error.message || '连接未完成，请重试', 'warning'); return null; }
        commitConnections(plan.connections, `已连接 ${count} 个来源`, {
            nodeIds: [...plan.connectedNodeIds], connectionIds: [...plan.connectionIds]
        });
        return true;
    }

    function connectBatchToNode(sourceNodeIds, targetNodeId) {
        return commitConnectionBatch(planConnectionBatch(
            getBatchConnectionSources(sourceNodeIds), getVisibleConnectionPorts(targetNodeId, 'input')
        ));
    }

    function finishConnection(src, tgt) {
        if (isBatchDrag(src)) {
            if (tgt?.dir !== 'input') return false;
            const sources = getBatchDragSources(src).map(output => ({ outputs: [output] }));
            return Boolean(commitConnectionBatch(planConnectionBatch(sources, [tgt], src)));
        }
        const checked = checkConnectionTarget(src, tgt);
        if (checked.error) { showToast(checked.error, 'warning'); return false; }
        const { rewiredConnection, toId, toPort } = checked;
        if (rewiredConnection?.to.nodeId === toId && rewiredConnection.to.port === toPort) return true;
        if (!src.historyPushed) pushHistory();
        commitConnections(appendConnection([...state.connections], checked), '连接已创建');
        return true;
    }

    function updateInputConnection(connectionId, { role, from, disconnect = false } = {}) {
        const index = state.connections.findIndex(edge => edge.id === connectionId);
        const edge = state.connections[index], targetNode = getNodeById(edge?.to?.nodeId);
        const fail = error => { showToast(error, 'warning'); return { changed: false, error }; };
        const recordHistory = () => { try { pushHistory(); return ''; } catch (error) { return error.message || '画布正在修改，请稍后重试'; } };
        if (!edge || !isUniversalInputNode(targetNode)) return fail('输入连接已变化，请重新查看');
        if (state.canvasPlanApplying) return fail('画布方案正在应用，请稍后再修改');
        if (hasRunningEndpoint(edge)) return fail('节点正在运行，暂不能修改输入连接');
        if (disconnect) {
            const error = recordHistory(); if (error) return fail(error);
            state.connections.splice(index, 1);
        } else {
            const endpoint = from || edge.from, sourceNode = getNodeById(endpoint.nodeId);
            const sourceType = getPortElement(sourceNode, endpoint.port, 'output')?.dataset.type;
            if (!sourceType) return fail('来源输出已变化，请重新选择');
            const policy = resolveUniversalInput({ state, sourceNode, sourcePort: endpoint.port, sourceType,
                targetNode, role: role || edge.to.port, ignoreConnectionId: edge.id });
            if (policy.error) return fail(policy.error);
            if (endpoint.nodeId === edge.from.nodeId && endpoint.port === edge.from.port && policy.port === edge.to.port
                && (!from || policy.maskConsumption === edge.maskConsumption)) return { changed: false, error: '' };
            const error = recordHistory(); if (error) return fail(error);
            const next = { ...edge, from: { ...endpoint }, to: { ...edge.to, port: policy.port }, type: policy.type };
            delete next.maskConsumption;
            if (policy.maskConsumption) next.maskConsumption = policy.maskConsumption;
            if (policy.multiple && !Number.isFinite(Number(next.order))) next.order = getNextInputConnectionOrder(state.connections, next.to);
            state.connections[index] = next;
        }
        updateAllConnections(); updatePortStyles(); scheduleSave(); onConnectionsChanged();
        return { changed: true, error: '' };
    }

    function applyInputConnectionPlan(plan) {
        const fail = error => { showToast(error, 'warning'); return { changed: false, error }; };
        if (plan.error) return fail(plan.error);
        if (!plan.connections) return { changed: false, error: '' };
        if (state.connections.some((edge, index) => edge !== plan.connections[index] && hasRunningEndpoint(edge))) return fail('节点正在运行，暂不能修改输入顺序');
        try { pushHistory(); } catch (error) { return fail(error.message || '画布正在修改，请稍后再交换'); }
        state.connections = plan.connections;
        updateAllConnections(); updatePortStyles(); scheduleSave(); onConnectionsChanged();
        return { changed: true, error: '' };
    }

    function swapInputConnections(nodeId) {
        return applyInputConnectionPlan(planCompareInputSwap({ state, node: getNodeById(nodeId) }));
    }

    function moveMergeInputConnection(connectionId, direction) {
        return applyInputConnectionPlan(planMoveMergeInput({ state, connectionId, direction }));
    }

    function drawTempConnection(x1, y1, x2, y2, startsAtOutput = true, starts = [{ x: x1, y: y1 }]) {
        const { x, y, zoom } = state.canvas;
        const endX = x2 * zoom + x;
        const endY = y2 * zoom + y;
        const type = state.connectionLineType || 'bezier';
        const path = starts.map((start, index) => {
            const startX = start.x * zoom + x;
            const startY = start.y * zoom + y;
            // Aligned endpoints otherwise collapse into a single horizontal stroke.
            const laneOffset = Math.abs(startY - endY) < 1
                ? clampLaneOffset((index - (starts.length - 1) / 2) * 12)
                : 0;
            const options = { type, laneOffset };
            return startsAtOutput
                ? createBezierPath(startX, startY, endX, endY, options)
                : createBezierPath(endX, endY, startX, startY, options);
        }).join(' ');
        setSvgAttribute(tempConnection, 'd', path);
    }

    function updatePortStyles() {
        targetFeedback = null;
        documentRef.querySelectorAll('.port-dot').forEach((dot) => dot.classList.remove('connected'));
        documentRef.querySelectorAll('.node-port').forEach((portEl) => {
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
                const toDot = getPortElement(toNode, conn.to.port, 'input')?.querySelector('.port-dot');
                if (toDot) toDot.classList.add('connected');
            }
        }
        documentRef.querySelectorAll('.node-port[data-multiple="true"]').forEach((portEl) => {
            const count = state.connections.filter((connection) => (
                connection.to.nodeId === portEl.dataset.nodeId &&
                connection.to.port === portEl.dataset.port
            )).length;
            const label = portEl.querySelector('.port-label');
            const baseLabel = portEl.dataset.baseLabel || '参考图';
            if (label) label.textContent = count > 0 ? `${baseLabel} · ${count}` : baseLabel;
        });

    }

    return {
        destroy,
        projectionHandoffAdapter: {
            capture: exportConnectionProjection,
            adopt: adoptConnectionProjection,
            hasUnmaterializedConnections
        },
        getPortPosition,
        getBatchConnectionSources,
        connectBatchToNode,
        getConnectionTargetError,
        getNearestConnectionTarget,
        updateConnectionTargetFeedback,
        clearConnectionTargetFeedback,
        invalidateNodePortCache,
        measureNodePorts,
        markConnectionDirty,
        markNodeConnectionsDirty,
        rebuildConnectionIndex,
        updateAllConnections,
        beginConnectionRestoration,
        updateDirtyConnections,
        detectMisalignedConnections,
        realignConnections,
        updateDraggingConnections,
        findConnectionsCrossingSegments,
        clearConnectionInsertPreview,
        commitConnectionInsertPreview,
        getCompatibleNodeTypeCandidates,
        createNodeFromConnectionCandidate,
        deleteConnection,
        moveImageReferenceConnection,
        disconnectImageReferenceConnection,
        finishConnection,
        updateInputConnection,
        swapInputConnections,
        moveMergeInputConnection,
        drawTempConnection,
        updatePortStyles
    };
}
