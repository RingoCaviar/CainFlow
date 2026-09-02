/**
 * 负责画布层级的交互事件，包括拖拽、框选、平移辅助与连线过程中的交互同步。
 */
import { appendMappedConnectionSnapshots } from './connection-copy-utils.js';
import { CANVAS_INTERACTION_KIND } from './canvas-interaction-kinds.js';

export function createCanvasInteractionsApi({
    state,
    canvasContainer,
    nodesLayer,
    tempConnection,
    viewportApi,
    getPortPosition,
    drawTempConnection,
    updateAllConnections,
    updateDirtyConnections = null,
    scheduleConnectionRefresh = null,
    connectionProjection = null,
    invalidateNodePortCache = null,
    markNodeConnectionsDirty = null,
    clearConnectionInsertPreview = null,
    commitConnectionInsertPreview = null,
    detachNodesFromConnections = null,
    updatePortStyles,
    scheduleSave,
    getActiveWorkflowId = () => '',
    saveViewportState = () => false,
    serializeOneNode,
    addNode,
    getNodeMinimumSize = null,
    enforceNodeContentMinimum = null,
    checkLineIntersection,
    getConnectionSamplePoints,
    onConnectionsChanged = () => {},
    onViewportSettled = () => {},
    getConnectionCreateCandidates = null,
    openConnectionCreatePopup = null,
    documentRef = document,
    windowRef = window,
    requestAnimationFrameRef = requestAnimationFrame,
    queueMicrotaskRef = queueMicrotask
}) {
    let panTransformRaf = null;
    const projectionInteractionLeases = new Map();
    let samplePanOrigin = null;
    let sampleZoomOrigin = null;
    let sampleDrag = null;
    let sampleConnection = null;
    const ZOOM_SETTLE_DELAY_MS = 120;
    const SHAKE_DETACH_DURATION_MS = 300;
    const SHAKE_SAMPLE_DISTANCE = 8;
    const SHAKE_RESET_MS = 520;
    const SHAKE_MIN_REVERSALS = 4;
    const SHAKE_MIN_TRAVEL = 120;
    const SHAKE_REVERSE_DOT = -0.45;
    const OUTPUT_PORT_TRANSITION = 28;
    const INPUT_PORT_TURN_LEAD = 72;
    const PAIR_LANE_GAP = 14;
    const PORT_LANE_GAP = 6;
    const NODE_LANE_GAP = 4;
    const MAX_LANE_OFFSET = 42;
    const FALLBACK_NODE_WIDTH = 180;
    const FALLBACK_NODE_HEIGHT = 120;
    const WHEEL_ZOOM_SENSITIVITY = 0.0011;
    const WHEEL_LINE_HEIGHT_PX = 32;
    const MAX_WHEEL_ZOOM_DELTA_PX = 100;

    function alignCanvasDeltaToDevicePixel(delta) {
        const zoom = Number(state.canvas?.zoom) || 1;
        const dpr = Number(windowRef.devicePixelRatio) || 1;
        const scale = zoom * dpr;
        return scale > 0 ? Math.round(delta * scale) / scale : delta;
    }

    function refreshNodeConnections(nodeId, { force = false } = {}) {
        if (typeof scheduleConnectionRefresh === 'function') {
            scheduleConnectionRefresh({
                nodeIds: nodeId,
                force,
                immediate: force,
                reason: 'canvas-node-geometry'
            });
            return;
        }
        if (typeof invalidateNodePortCache === 'function') {
            invalidateNodePortCache(nodeId);
        } else if (typeof markNodeConnectionsDirty === 'function') {
            markNodeConnectionsDirty(nodeId);
        }
        if (!force && typeof updateDirtyConnections === 'function') {
            updateDirtyConnections();
            return;
        }
        updateAllConnections();
    }

    function schedulePanTransformUpdate() {
        if (panTransformRaf) return;
        panTransformRaf = requestAnimationFrameRef(() => {
            panTransformRaf = null;
            viewportApi.updateCanvasTransform({
                updateConnections: false,
                dispatchTransformEvent: false
            });
        });
    }

    function notifyViewportSettled() {
        if (typeof onViewportSettled !== 'function') return;
        try {
            onViewportSettled();
        } catch (error) {
            console.warn('Viewport settled callback failed:', error);
        }
    }

    function persistCurrentViewport() {
        return saveViewportState({
            workflowId: getActiveWorkflowId(),
            canvas: { x: state.canvas.x, y: state.canvas.y, zoom: state.canvas.zoom }
        });
    }

    function beginProjectionInteraction(kind, nodeIds) {
        const interaction = connectionProjection?.beginInteraction?.(kind, nodeIds) || null;
        if (interaction) projectionInteractionLeases.set(kind, interaction);
        return interaction;
    }

    function getProjectionInteraction(kind) {
        return projectionInteractionLeases.get(kind) || null;
    }

    function closeProjectionInteraction(kind, method = 'finish') {
        const interaction = getProjectionInteraction(kind);
        projectionInteractionLeases.delete(kind);
        if (!interaction) return;
        Promise.resolve(interaction[method]()).catch((error) => {
            console.warn('Connection projection interaction failed to settle:', error);
        });
    }

    function finishConnectionDrawInteraction() {
        closeProjectionInteraction(CANVAS_INTERACTION_KIND.CONNECTION_DRAW);
    }

    function settleCanvasPan({ abort = false } = {}) {
        if (!state.canvas.isPanning) return;

        const start = state.canvas.canvasStart;
        const hasMoved = start && (
            Math.abs(state.canvas.x - start.x) > 3 ||
            Math.abs(state.canvas.y - start.y) > 3
        );
        if (hasMoved) {
            state.justDragged = true;
            setTimeout(() => { state.justDragged = false; }, 100);
            scheduleSave();
        }

        state.canvas.isPanning = false;
        delete state.canvas.panButtonMask;
        canvasContainer.classList.remove('grabbing', 'is-panning');
        documentRef.getElementById('connections-group').classList.remove('is-panning');
        viewportApi.updateCanvasTransform({
            updateConnections: false
        });
        closeProjectionInteraction(CANVAS_INTERACTION_KIND.PAN, abort ? 'abort' : 'finish');
        notifyViewportSettled();
    }

    function settleNodeDrag({ endPosition = null, abort = false } = {}) {
        if (!state.dragging) return;

        if (endPosition && (
            Math.abs(endPosition.x - state.dragging.startX) > 2 ||
            Math.abs(endPosition.y - state.dragging.startY) > 2
        )) {
            state.justDragged = true;
            setTimeout(() => { state.justDragged = false; }, 100);
        }

        for (const nodeId of state.dragging.nodes) {
            const node = state.nodes.get(nodeId);
            if (!node) continue;
            node.el.style.left = node.x + 'px';
            node.el.style.top = node.y + 'px';
            node.el.style.setProperty('--node-drag-x', '0px');
            node.el.style.setProperty('--node-drag-y', '0px');
            node.el.style.removeProperty('transform');
            node.el.classList.remove('is-interacting', 'connection-shake-armed');
            node.el.style.removeProperty('--connection-shake-progress');
        }

        if (abort) {
            clearConnectionInsertPreview?.();
        } else if (commitConnectionInsertPreview) {
            commitConnectionInsertPreview();
        } else if (clearConnectionInsertPreview) {
            clearConnectionInsertPreview();
        }

        state.dragging = null;
        closeProjectionInteraction(CANVAS_INTERACTION_KIND.NODE_DRAG, abort ? 'abort' : 'finish');
        scheduleSave();
    }

    function performSampleInteractionStep({ kind, phase, progress }) {
        if (kind === CANVAS_INTERACTION_KIND.PAN) {
            if (phase === 'start') {
                samplePanOrigin = { x: state.canvas.x, y: state.canvas.y };
                beginProjectionInteraction(CANVAS_INTERACTION_KIND.PAN);
                return;
            }
            if (phase === 'update' && samplePanOrigin) {
                state.canvas.x = samplePanOrigin.x + 80 * progress;
                state.canvas.y = samplePanOrigin.y + 40 * progress;
                viewportApi.updateCanvasTransform({
                    updateConnections: false,
                    dispatchTransformEvent: false
                });
                getProjectionInteraction(CANVAS_INTERACTION_KIND.PAN)?.changed();
                return;
            }
            if (phase === 'finish') {
                if (samplePanOrigin) {
                    state.canvas.x = samplePanOrigin.x;
                    state.canvas.y = samplePanOrigin.y;
                }
                viewportApi.updateCanvasTransform({ updateConnections: false });
                samplePanOrigin = null;
                closeProjectionInteraction(CANVAS_INTERACTION_KIND.PAN);
            }
            return;
        }
        if (kind === CANVAS_INTERACTION_KIND.NODE_DRAG) {
            if (phase === 'start') {
                const entry = Array.from(state.nodes.entries()).find(([nodeId]) => !isNodeRunning(nodeId));
                if (!entry) return;
                const [nodeId, node] = entry;
                sampleDrag = { nodeId, startX: node.x, startY: node.y };
                beginProjectionInteraction(CANVAS_INTERACTION_KIND.NODE_DRAG, [nodeId]);
                return;
            }
            if (phase === 'update' && sampleDrag) {
                const node = state.nodes.get(sampleDrag.nodeId);
                if (!node) return;
                node.x = sampleDrag.startX + 60 * progress;
                node.y = sampleDrag.startY + 40 * progress;
                node.el.style.left = `${node.x}px`;
                node.el.style.top = `${node.y}px`;
                getProjectionInteraction(CANVAS_INTERACTION_KIND.NODE_DRAG)?.changed();
                return;
            }
            if (phase === 'finish') {
                if (sampleDrag) {
                    const node = state.nodes.get(sampleDrag.nodeId);
                    if (node) {
                        node.x = sampleDrag.startX;
                        node.y = sampleDrag.startY;
                        node.el.style.left = `${node.x}px`;
                        node.el.style.top = `${node.y}px`;
                    }
                }
                sampleDrag = null;
                closeProjectionInteraction(CANVAS_INTERACTION_KIND.NODE_DRAG);
            }
            return;
        }
        if (kind === CANVAS_INTERACTION_KIND.CONNECTION_DRAW) {
            if (phase === 'start') {
                const connection = state.connections[0];
                if (!connection) return;
                const fromNode = state.nodes.get(connection.from.nodeId);
                const toNode = state.nodes.get(connection.to.nodeId);
                const from = getPortPosition(connection.from.nodeId, connection.from.port, 'output')
                    || { x: fromNode?.x || 0, y: fromNode?.y || 0 };
                const to = getPortPosition(connection.to.nodeId, connection.to.port, 'input')
                    || { x: toNode?.x || 0, y: toNode?.y || 0 };
                sampleConnection = { connection, from, to };
                beginProjectionInteraction(
                    CANVAS_INTERACTION_KIND.CONNECTION_DRAW,
                    [connection.from.nodeId]
                );
                return;
            }
            if (phase === 'update' && sampleConnection) {
                const { connection, from, to } = sampleConnection;
                drawTempConnection(
                    from.x,
                    from.y,
                    from.x + (to.x - from.x) * progress,
                    from.y + (to.y - from.y) * progress
                );
                getProjectionInteraction(CANVAS_INTERACTION_KIND.CONNECTION_DRAW)?.changed({
                    nodeIds: [connection.from.nodeId, connection.to.nodeId]
                });
                return;
            }
            if (phase === 'finish') {
                tempConnection.setAttribute('d', '');
                sampleConnection = null;
                finishConnectionDrawInteraction();
            }
            return;
        }
        if (kind !== CANVAS_INTERACTION_KIND.ZOOM) return;
        if (phase === 'start') {
            sampleZoomOrigin = state.canvas.zoom;
            beginProjectionInteraction(CANVAS_INTERACTION_KIND.ZOOM);
            return;
        }
        if (phase === 'update' && sampleZoomOrigin != null) {
            state.canvas.zoom = sampleZoomOrigin * (1 + 0.15 * progress);
            viewportApi.updateCanvasTransform({
                updateConnections: false,
                dispatchTransformEvent: false
            });
            getProjectionInteraction(CANVAS_INTERACTION_KIND.ZOOM)?.changed();
            return;
        }
        if (phase !== 'finish') return;
        if (sampleZoomOrigin != null) state.canvas.zoom = sampleZoomOrigin;
        viewportApi.updateCanvasTransform({ updateConnections: false });
        sampleZoomOrigin = null;
        closeProjectionInteraction(CANVAS_INTERACTION_KIND.ZOOM);
    }

    function getWheelDeltaPixels(event, canvasHeight) {
        const rawDelta = Number(event?.deltaY) || 0;
        const pixels = event?.deltaMode === 1
            ? rawDelta * WHEEL_LINE_HEIGHT_PX
            : event?.deltaMode === 2
                ? rawDelta * Math.max(1, canvasHeight)
                : rawDelta;
        return Math.max(-MAX_WHEEL_ZOOM_DELTA_PX, Math.min(MAX_WHEEL_ZOOM_DELTA_PX, pixels));
    }

    function beginCanvasPan(e) {
        e.preventDefault();
        state.canvas.isPanning = true;
        state.canvas.panButtonMask = e.button === 1 ? 4 : e.button === 2 ? 2 : 1;
        state.canvas.panStart = { x: e.clientX, y: e.clientY };
        state.canvas.canvasStart = { x: state.canvas.x, y: state.canvas.y };
        beginProjectionInteraction(CANVAS_INTERACTION_KIND.PAN);
        canvasContainer.classList.add('grabbing', 'is-panning');
        documentRef.body.classList.add('is-interacting');
        documentRef.getElementById('connections-group').classList.add('is-panning');
    }

    function isNodeFormControlActive() {
        const active = documentRef.activeElement;
        if (!active || !active.closest) return false;
        const isFormControl = ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable;
        return isFormControl && !!active.closest('.node');
    }

    function hasScrollableNodeAncestor(target) {
        if (!target?.closest?.('.node')) return false;

        let current = target;
        while (current && current !== canvasContainer) {
            if (current.nodeType === 1) {
                const style = windowRef.getComputedStyle(current);
                const canScrollVertically = /^(auto|scroll)$/.test(style.overflowY)
                    && current.scrollHeight > current.clientHeight + 1;
                const canScrollHorizontally = /^(auto|scroll)$/.test(style.overflowX)
                    && current.scrollWidth > current.clientWidth + 1;
                if (canScrollVertically || canScrollHorizontally) return true;
            }
            current = current.parentElement;
        }

        return false;
    }

    function distributeNodeTextareaResize(resizeState, nextNodeHeight) {
        const targets = Array.isArray(resizeState?.textareaResizeTargets)
            ? resizeState.textareaResizeTargets
            : [];
        if (!targets.length) return;

        const delta = Number(nextNodeHeight) - Number(resizeState.startHeight);
        const activeTargets = targets.map((target) => {
            const resizeEl = target?.el;
            if (!resizeEl?.isConnected) return null;
            const minHeight = Math.max(0, Number(target.minHeight) || 0);
            const startHeight = Math.max(minHeight, Number(target.startHeight) || minHeight);
            const rawMaxHeight = Number(target.maxHeight);
            const maxHeight = Number.isFinite(rawMaxHeight) && rawMaxHeight > 0
                ? rawMaxHeight
                : Infinity;
            return {
                target,
                resizeEl,
                minHeight,
                startHeight,
                maxHeight,
                nextHeight: startHeight,
                weight: Math.max(1, Number(target.weight) || startHeight || 1),
                clippedNeed: Math.max(0, Number(target.contentHeight) - startHeight)
            };
        }).filter(Boolean);

        if (!activeTargets.length) return;

        const applyHeights = () => {
            activeTargets.forEach((item) => {
                const nextHeight = Math.min(item.maxHeight, Math.max(item.minHeight, item.nextHeight));
                item.resizeEl.style.height = `${Math.round(nextHeight)}px`;
            });
        };

        const distributeExtra = (remainingDelta, group, getCapacity, getWeight) => {
            let remaining = Math.max(0, Number(remainingDelta) || 0);
            let candidates = group.filter((item) => getCapacity(item) > 0);

            while (remaining > 0.001 && candidates.length) {
                const totalWeight = candidates.reduce((sum, item) => sum + Math.max(1, getWeight(item)), 0) || candidates.length;
                let used = 0;
                const nextCandidates = [];

                candidates.forEach((item) => {
                    const capacity = Math.max(0, getCapacity(item));
                    if (capacity <= 0) return;
                    const share = remaining * (Math.max(1, getWeight(item)) / totalWeight);
                    const addition = Math.min(capacity, share);
                    if (addition > 0) {
                        item.nextHeight += addition;
                        used += addition;
                    }
                    if (capacity - addition > 0.001) nextCandidates.push(item);
                });

                if (used <= 0.001) break;
                remaining -= used;
                candidates = nextCandidates;
            }

            return remaining;
        };

        const distributeShrink = (shrinkDelta, group) => {
            let remaining = Math.max(0, Number(shrinkDelta) || 0);
            let candidates = group.filter((item) => item.nextHeight - item.minHeight > 0);

            while (remaining > 0.001 && candidates.length) {
                const totalCapacity = candidates.reduce((sum, item) => {
                    return sum + Math.max(0, item.nextHeight - item.minHeight);
                }, 0);
                if (totalCapacity <= 0.001) break;

                let used = 0;
                const nextCandidates = [];
                candidates.forEach((item) => {
                    const capacity = Math.max(0, item.nextHeight - item.minHeight);
                    if (capacity <= 0) return;
                    const reduction = Math.min(capacity, remaining * (capacity / totalCapacity));
                    if (reduction > 0) {
                        item.nextHeight -= reduction;
                        used += reduction;
                    }
                    if (capacity - reduction > 0.001) nextCandidates.push(item);
                });

                if (used <= 0.001) break;
                remaining -= used;
                candidates = nextCandidates;
            }

            return remaining;
        };

        if (delta > 0) {
            let remainingDelta = delta;
            const clippedTargets = activeTargets.filter((item) => item.clippedNeed > 0);
            remainingDelta = distributeExtra(
                remainingDelta,
                clippedTargets,
                (item) => Math.min(item.clippedNeed, item.maxHeight - item.nextHeight),
                (item) => item.clippedNeed
            );
            distributeExtra(
                remainingDelta,
                activeTargets,
                (item) => item.maxHeight - item.nextHeight,
                (item) => item.weight
            );
        } else {
            distributeShrink(Math.abs(delta), activeTargets);
        }

        applyHeights();
    }

    function getFirstPositiveNumber(...values) {
        for (const value of values) {
            const parsed = typeof value === 'string' ? parseFloat(value) : Number(value);
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        return 0;
    }

    function getNodeCanvasBounds(node) {
        const left = Number(node?.x);
        const top = Number(node?.y);
        if (!Number.isFinite(left) || !Number.isFinite(top)) return null;

        const width = getFirstPositiveNumber(
            node.width,
            node.observedWidth,
            node.el?.style?.width,
            node.defaultWidth,
            FALLBACK_NODE_WIDTH
        );
        const height = getFirstPositiveNumber(
            node.height,
            node.observedHeight,
            node.el?.style?.height,
            node.defaultHeight,
            FALLBACK_NODE_HEIGHT
        );

        return {
            left,
            top,
            right: left + width,
            bottom: top + height
        };
    }

    function getMarqueeCanvasRect(marquee) {
        const startX = Number(marquee?.startCanvasX);
        const startY = Number(marquee?.startCanvasY);
        const endX = Number(marquee?.endCanvasX);
        const endY = Number(marquee?.endCanvasY);
        if (![startX, startY, endX, endY].every(Number.isFinite)) return null;

        return {
            left: Math.min(startX, endX),
            right: Math.max(startX, endX),
            top: Math.min(startY, endY),
            bottom: Math.max(startY, endY)
        };
    }

    function rectsIntersect(a, b) {
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    }

    function syncMarqueeSelection(marquee) {
        const marqueeRect = getMarqueeCanvasRect(marquee);
        if (!marqueeRect) return false;

        const changedNodeIds = [];
        state.nodes.forEach((node, id) => {
            const nodeBounds = getNodeCanvasBounds(node);
            const intersects = nodeBounds ? rectsIntersect(marqueeRect, nodeBounds) : false;

            if (intersects) {
                if (!state.selectedNodes.has(id)) {
                    state.selectedNodes.add(id);
                    node.el?.classList.add('selected');
                    changedNodeIds.push(id);
                }
            } else if (!marquee.initialSelection.has(id) && state.selectedNodes.has(id)) {
                state.selectedNodes.delete(id);
                node.el?.classList.remove('selected');
                changedNodeIds.push(id);
            }
        });

        if (changedNodeIds.length) connectionProjection?.nodeAppearanceChanged(changedNodeIds);
        return changedNodeIds.length > 0;
    }

    function finishZoomInteraction() {
        if (state.zoomSettleControlLock) {
            state.pendingZoomVisualRefresh = true;
            return;
        }

        state.isInteracting = false;
        canvasContainer.classList.remove('is-zooming');
        documentRef.body.classList.remove('is-interacting');
        documentRef.getElementById('connections-group').classList.remove('is-interacting');

        if (isNodeFormControlActive()) {
            state.pendingZoomVisualRefresh = true;
            closeProjectionInteraction(CANVAS_INTERACTION_KIND.ZOOM);
            persistCurrentViewport();
            return;
        }

        state.pendingZoomVisualRefresh = false;
        viewportApi.updateCanvasTransform({
            updateConnections: false
        });
        closeProjectionInteraction(CANVAS_INTERACTION_KIND.ZOOM);
        requestAnimationFrameRef(() => {
            viewportApi.refreshNodeTextRendering();
            persistCurrentViewport();
            notifyViewportSettled();
        });
    }

    function getNow() {
        return windowRef.performance?.now?.() || Date.now();
    }

    function hasNodeConnections(nodeId) {
        return state.connections.some((connection) => (
            connection.from.nodeId === nodeId ||
            connection.to.nodeId === nodeId
        ));
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

    function getPortOrder(nodeId, portName, direction) {
        const node = state.nodes.get(nodeId);
        const ports = Array.from(node?.el?.querySelectorAll?.(`.node-port[data-direction="${direction}"]`) || []);
        const index = ports.findIndex((portEl) => portEl.dataset.port === portName);
        return index >= 0 ? index : ports.length;
    }

    function compareConnectionsForLane(a, b) {
        const fromA = state.nodes.get(a.from?.nodeId);
        const fromB = state.nodes.get(b.from?.nodeId);
        const toA = state.nodes.get(a.to?.nodeId);
        const toB = state.nodes.get(b.to?.nodeId);
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
            laneById.set(connection.id, clampLaneOffset(current + (index - center) * gap * weight));
        });
    }

    function buildConnectionLaneMap() {
        const laneById = new Map();
        const pairGroups = new Map();
        const outputGroups = new Map();
        const targetGroups = new Map();

        state.connections.forEach((connection) => {
            if (!connection?.id || !state.nodes.has(connection.from?.nodeId) || !state.nodes.has(connection.to?.nodeId)) return;
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

    function getConnectionPathOptions(connection, laneById) {
        return {
            type: state.connectionLineType || 'bezier',
            outputTransition: OUTPUT_PORT_TRANSITION,
            inputTransition: INPUT_PORT_TURN_LEAD,
            laneOffset: laneById.get(connection.id) || 0
        };
    }

    function clearShakeDetachVisuals(draggingState) {
        const nodeId = draggingState?.nodes?.[0];
        const node = nodeId ? state.nodes.get(nodeId) : null;
        node?.el?.classList.remove('connection-shake-armed');
        node?.el?.style.removeProperty('--connection-shake-progress');
    }

    function resetShakeTracker(draggingState, pos, now) {
        clearShakeDetachVisuals(draggingState);
        draggingState.connectionShake = {
            lastX: pos.x,
            lastY: pos.y,
            lastTime: now,
            lastVector: null,
            activeSince: null,
            lastReversalAt: null,
            reversalCount: 0,
            travel: 0
        };
        return draggingState.connectionShake;
    }

    function updateShakeDetach(draggingState, pos) {
        if (!detachNodesFromConnections) return;
        if (!draggingState?.nodes || draggingState.nodes.length !== 1) return;
        if (draggingState.isCloneDrag || draggingState.connectionShakeDetached) return;

        const nodeId = draggingState.nodes[0];
        const node = state.nodes.get(nodeId);
        if (!node || !hasNodeConnections(nodeId)) {
            clearShakeDetachVisuals(draggingState);
            return;
        }

        const now = getNow();
        const shake = draggingState.connectionShake || resetShakeTracker(draggingState, pos, now);
        const dx = pos.x - shake.lastX;
        const dy = pos.y - shake.lastY;
        const distance = Math.hypot(dx, dy);

        if (shake.lastTime && now - shake.lastTime > SHAKE_RESET_MS) {
            resetShakeTracker(draggingState, pos, now);
            return;
        }
        if (distance < SHAKE_SAMPLE_DISTANCE) return;

        const vector = { x: dx / distance, y: dy / distance };
        if (shake.lastVector) {
            const dot = vector.x * shake.lastVector.x + vector.y * shake.lastVector.y;
            if (dot <= SHAKE_REVERSE_DOT) {
                if (!shake.activeSince || (shake.lastReversalAt && now - shake.lastReversalAt > SHAKE_RESET_MS)) {
                    shake.activeSince = now;
                    shake.reversalCount = 1;
                    shake.travel = 0;
                } else {
                    shake.reversalCount += 1;
                }
                shake.lastReversalAt = now;
            }
        }

        if (shake.activeSince) {
            shake.travel += distance;
            const progress = Math.min(1, Math.max(0, (now - shake.activeSince) / SHAKE_DETACH_DURATION_MS));
            node.el.classList.add('connection-shake-armed');
            node.el.style.setProperty('--connection-shake-progress', progress.toFixed(3));

            if (
                now - shake.activeSince >= SHAKE_DETACH_DURATION_MS &&
                shake.reversalCount >= SHAKE_MIN_REVERSALS &&
                shake.travel >= SHAKE_MIN_TRAVEL
            ) {
                const result = detachNodesFromConnections([nodeId], { save: false });
                draggingState.connectionShakeDetached = result?.changed;
                draggingState.connectionsToUpdate = [];
                draggingState.portOffsets = new Map();
                clearShakeDetachVisuals(draggingState);
                if (result?.changed) {
                    clearConnectionInsertPreview?.();
                    node.el.classList.add('connection-shake-detached');
                    windowRef.setTimeout(() => {
                        node.el?.classList.remove('connection-shake-detached');
                    }, 700);
                }
            }
        }

        shake.lastX = pos.x;
        shake.lastY = pos.y;
        shake.lastTime = now;
        shake.lastVector = vector;
    }

    function initCanvasInteractions() {
        windowRef.addEventListener('blur', () => {
            documentRef.body.classList.remove('is-interacting');
            documentRef.getElementById('connections-group').classList.remove('is-interacting');
            settleCanvasPan({ abort: true });
            settleNodeDrag({ abort: true });
            for (const kind of projectionInteractionLeases.keys()) {
                closeProjectionInteraction(kind, 'abort');
            }
            tempConnection.setAttribute('d', '');
        });

        canvasContainer.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || !state.isSpacePressed) return;

            canvasContainer.focus();
            beginCanvasPan(e);
            e.stopPropagation();
        }, true);

        canvasContainer.addEventListener('click', (e) => {
            if (!state.isSpacePressed) return;

            e.preventDefault();
            e.stopPropagation();
        }, true);

        canvasContainer.addEventListener('mousedown', (e) => {
            canvasContainer.focus();

            if (e.ctrlKey && e.button === 2) {
                state.isCutting = true;
                const pos = viewportApi.screenToCanvas(e.clientX, e.clientY);
                state.cutPath = [pos];
                canvasContainer.style.cursor = 'crosshair';
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            if (e.target === canvasContainer || e.target === nodesLayer || e.target.id === 'connections-layer') {
                if (documentRef.activeElement && ['INPUT', 'TEXTAREA'].includes(documentRef.activeElement.tagName)) {
                    documentRef.activeElement.blur();
                }
                windowRef.getSelection()?.removeAllRanges();
            }

            const isPanAction = e.button === 1 || (e.button === 0 && (e.altKey || state.isSpacePressed));
            const isMarqueeAction = e.button === 0 && e.target === canvasContainer && !isPanAction;

            if (isPanAction) {
                beginCanvasPan(e);
                return;
            }

            if (isMarqueeAction) {
                const isToggle = e.ctrlKey || e.metaKey || e.shiftKey;
                if (!isToggle) {
                    const changedNodeIds = Array.from(state.selectedNodes);
                    state.selectedNodes.forEach((nid) => {
                        const node = state.nodes.get(nid);
                        if (node) node.el.classList.remove('selected');
                    });
                    state.selectedNodes.clear();
                    connectionProjection?.nodeAppearanceChanged(changedNodeIds);
                }

                e.preventDefault();
                const startCanvas = viewportApi.screenToCanvas(e.clientX, e.clientY);
                state.marquee = {
                    startX: e.clientX,
                    startY: e.clientY,
                    endX: e.clientX,
                    endY: e.clientY,
                    startCanvasX: startCanvas.x,
                    startCanvasY: startCanvas.y,
                    endCanvasX: startCanvas.x,
                    endCanvasY: startCanvas.y,
                    initialSelection: new Set(state.selectedNodes)
                };
                const box = documentRef.getElementById('selection-box');
                box.style.left = e.clientX + 'px';
                box.style.top = e.clientY + 'px';
                box.style.width = '0px';
                box.style.height = '0px';
                box.classList.remove('hidden');
            }
        });

        windowRef.addEventListener('mousemove', (e) => {
            if (!state.canvas.isPanning) {
                state.mouseCanvas = viewportApi.screenToCanvas(e.clientX, e.clientY);
            }
            if (state.isCutting) {
                const pos = viewportApi.screenToCanvas(e.clientX, e.clientY);
                const prevPos = state.cutPath[state.cutPath.length - 1];
                state.cutPath.push(pos);

                let changed = false;
                const connectionsToRemove = new Set();
                const laneById = buildConnectionLaneMap();

                for (const conn of state.connections) {
                    if (hasRunningEndpoint(conn)) continue;
                    const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output');
                    const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input');

                    const samplePoints = getConnectionSamplePoints(
                        from.x,
                        from.y,
                        to.x,
                        to.y,
                        getConnectionPathOptions(conn, laneById)
                    );

                    for (let i = 1; i < samplePoints.length; i++) {
                        if (checkLineIntersection(prevPos, pos, samplePoints[i - 1], samplePoints[i])) {
                            connectionsToRemove.add(conn.id);
                            changed = true;
                            break;
                        }
                    }
                }

                if (changed) {
                    state.connections = state.connections.filter((c) => !connectionsToRemove.has(c.id));
                    updateAllConnections();
                    updatePortStyles();
                    scheduleSave();
                    onConnectionsChanged();
                }
            }

            if (state.canvas.isPanning) {
                const panButtonMask = state.canvas.panButtonMask;
                const panButtonReleased = Number.isFinite(e.buttons) && panButtonMask && (e.buttons & panButtonMask) === 0;
                if (panButtonReleased) {
                    settleCanvasPan({ abort: true });
                } else {
                    state.canvas.x = state.canvas.canvasStart.x + (e.clientX - state.canvas.panStart.x);
                    state.canvas.y = state.canvas.canvasStart.y + (e.clientY - state.canvas.panStart.y);
                    schedulePanTransformUpdate();
                    getProjectionInteraction(CANVAS_INTERACTION_KIND.PAN)?.changed();
                }
            }
            if (state.marquee) {
                state.marquee.endX = e.clientX;
                state.marquee.endY = e.clientY;
                state.marquee.endCanvasX = state.mouseCanvas.x;
                state.marquee.endCanvasY = state.mouseCanvas.y;
                const box = documentRef.getElementById('selection-box');
                const x = Math.min(state.marquee.startX, state.marquee.endX);
                const y = Math.min(state.marquee.startY, state.marquee.endY);
                const w = Math.abs(state.marquee.startX - state.marquee.endX);
                const h = Math.abs(state.marquee.startY - state.marquee.endY);
                box.style.left = x + 'px';
                box.style.top = y + 'px';
                box.style.width = w + 'px';
                box.style.height = h + 'px';

                syncMarqueeSelection(state.marquee);
            }
            if (state.dragging) {
                if (state.dragging.isCloneDrag && !state.dragging.cloned) {
                    state.dragging.cloned = true;
                    const newDraggedIds = [];
                    const idMap = new Map();

                    for (const nodeId of state.dragging.nodes) {
                        const origNode = state.nodes.get(nodeId);
                        if (origNode) {
                            const data = serializeOneNode(nodeId);
                            data.id = null;
                            const newId = addNode(origNode.type, origNode.x, origNode.y, data, true);
                            if (newId) {
                                newDraggedIds.push(newId);
                                idMap.set(nodeId, newId);
                            }
                        }
                    }

                    if (newDraggedIds.length > 0) {
                        const connectionResult = appendMappedConnectionSnapshots({
                            state,
                            idMap,
                            internalConnections: state.dragging.internalConnections || [],
                            externalConnections: state.dragging.externalConnections || [],
                            includeExternalConnections: false
                        });
                        const newStartPositions = new Map();
                        idMap.forEach((newId, origId) => {
                            const startPos = state.dragging.startPositions.get(origId);
                            if (startPos) newStartPositions.set(newId, { x: startPos.x, y: startPos.y });
                        });

                        state.dragging.nodes = newDraggedIds;
                        state.dragging.startPositions = newStartPositions;
                        state.dragging.connectionsToUpdate = [];
                        state.dragging.portOffsets = new Map();

                        state.selectedNodes.forEach((nid) => {
                            const node = state.nodes.get(nid);
                            if (node) node.el.classList.remove('selected', 'is-interacting');
                        });
                        state.selectedNodes.clear();

                        newDraggedIds.forEach((id) => {
                            state.selectedNodes.add(id);
                            const node = state.nodes.get(id);
                            if (node) node.el.classList.add('selected', 'is-interacting');
                        });

                        updateAllConnections();
                        if (connectionResult.added > 0) {
                            updatePortStyles();
                        }
                        onConnectionsChanged();
                    }
                }
                const pos = viewportApi.screenToCanvas(e.clientX, e.clientY);
                const dx = pos.x - state.dragging.startX;
                const dy = pos.y - state.dragging.startY;
                const hasDragMovement = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;

                if (hasDragMovement && !getProjectionInteraction(CANVAS_INTERACTION_KIND.NODE_DRAG)) {
                    beginProjectionInteraction(CANVAS_INTERACTION_KIND.NODE_DRAG, state.dragging.nodes);
                }

                if (hasDragMovement && state.dragging.deferSelectionOnDrag && !state.dragging.selectionActivated) {
                    state.dragging.activateSelection?.();
                }

                if (hasDragMovement && !state.dragging.interactionVisualsActive) {
                    state.dragging.interactionVisualsActive = true;
                    documentRef.body.classList.add('is-interacting');
                    documentRef.getElementById('connections-group').classList.add('is-interacting');
                    for (const nodeId of state.dragging.nodes) {
                        state.nodes.get(nodeId)?.el?.classList.add('is-interacting');
                    }
                }

                for (const nodeId of state.dragging.nodes) {
                    const node = state.nodes.get(nodeId);
                    if (state.dragging.isCloneDrag !== true && isNodeRunning(nodeId)) continue;
                    if (node) {
                        const startPos = state.dragging.startPositions.get(nodeId);
                        const visualDx = alignCanvasDeltaToDevicePixel(dx);
                        const visualDy = alignCanvasDeltaToDevicePixel(dy);
                        node.x = startPos.x + visualDx;
                        node.y = startPos.y + visualDy;
                        node.el.style.setProperty('--node-drag-x', `${visualDx}px`);
                        node.el.style.setProperty('--node-drag-y', `${visualDy}px`);
                    }
                }
                updateShakeDetach(state.dragging, pos);
                getProjectionInteraction(CANVAS_INTERACTION_KIND.NODE_DRAG)?.changed();
            }
            if (state.resizing) {
                const r = state.resizing;
                const zoom = state.canvas.zoom;
                const dx = (e.clientX - r.startX) / zoom;
                const dy = (e.clientY - r.startY) / zoom;
                const node = state.nodes.get(r.nodeId);
                if (node) {
                    if (isNodeRunning(r.nodeId)) return;
                    const targetW = r.startWidth + dx;
                    const targetH = r.startHeight + dy;
                    let dynamicMinWidth = r.minWidth;
                    let dynamicMinHeight = typeof getNodeMinimumSize === 'function' ? 0 : r.minHeight;
                    const configuredMaxWidth = Number.isFinite(r.maxWidth) && r.maxWidth > 0 ? r.maxWidth : Infinity;
                    let constrainedWidth = Math.min(configuredMaxWidth, Math.max(targetW, r.minWidth));
                    const configuredMaxHeight = Number.isFinite(r.maxHeight) && r.maxHeight > 0 ? r.maxHeight : Infinity;

                    if (typeof getNodeMinimumSize === 'function') {
                        const provisionalMinimum = getNodeMinimumSize(node, {
                            width: constrainedWidth,
                            normalizeFlexibleHeights: true
                        });
                        if (provisionalMinimum) {
                            dynamicMinWidth = Math.max(dynamicMinWidth, Number(provisionalMinimum.minWidth) || 0);
                        }

                        constrainedWidth = Math.min(configuredMaxWidth, Math.max(targetW, dynamicMinWidth));
                        const finalMinimum = getNodeMinimumSize(node, {
                            width: constrainedWidth,
                            normalizeFlexibleHeights: true
                        });
                        if (finalMinimum) {
                            dynamicMinWidth = Math.max(dynamicMinWidth, Number(finalMinimum.minWidth) || 0);
                            dynamicMinHeight = Math.max(dynamicMinHeight, Number(finalMinimum.minHeight) || 0);
                            constrainedWidth = Math.min(configuredMaxWidth, Math.max(targetW, dynamicMinWidth));
                        }
                    }

                    const maxHeight = configuredMaxHeight >= dynamicMinHeight ? configuredMaxHeight : Infinity;
                    const newH = Math.min(Math.max(targetH, dynamicMinHeight), maxHeight);
                    node.el.style.width = constrainedWidth + 'px';
                    node.el.style.height = newH + 'px';
                    distributeNodeTextareaResize(r, newH);

                    refreshNodeConnections(r.nodeId);
                }
            }
            if (state.connecting) {
                const rect = canvasContainer.getBoundingClientRect();
                const { x, y, zoom } = state.canvas;
                const dx = e.clientX - state.connecting.screenX;
                const dy = e.clientY - state.connecting.screenY;
                if (Math.sqrt(dx * dx + dy * dy) > 5) state.connecting.dragged = true;
                const connectionNodeIds = [state.connecting.nodeId].filter(Boolean);
                if (!getProjectionInteraction(CANVAS_INTERACTION_KIND.CONNECTION_DRAW)) {
                    beginProjectionInteraction(CANVAS_INTERACTION_KIND.CONNECTION_DRAW, connectionNodeIds);
                }
                getProjectionInteraction(CANVAS_INTERACTION_KIND.CONNECTION_DRAW)?.changed({ nodeIds: connectionNodeIds });

                drawTempConnection(
                    state.connecting.startX,
                    state.connecting.startY,
                    (e.clientX - rect.left - x) / zoom,
                    (e.clientY - rect.top - y) / zoom,
                    state.connecting.isOutput
                );
            }
        });

        windowRef.addEventListener('mouseup', (e) => {
            if (!getProjectionInteraction(CANVAS_INTERACTION_KIND.CONNECTION_DRAW)) return;
            const targetPort = e.target?.closest?.('.node-port');
            if (!targetPort) return;
            const targetNodeId = targetPort.dataset?.nodeId;
            const connectionNodeIds = [state.connecting?.nodeId, targetNodeId].filter(Boolean);
            queueMicrotaskRef(() => {
                getProjectionInteraction(CANVAS_INTERACTION_KIND.CONNECTION_DRAW)?.changed({ nodeIds: connectionNodeIds });
                finishConnectionDrawInteraction();
            });
        }, true);

        windowRef.addEventListener('mouseup', (e) => {
            documentRef.body.classList.remove('is-interacting');
            documentRef.getElementById('connections-group').classList.remove('is-interacting');

            if (state.isCutting) {
                state.isCutting = false;
                state.cutPath = [];
                canvasContainer.style.cursor = '';
                state.justCut = true;
                setTimeout(() => { state.justCut = false; }, 100);
            }

            if (state.canvas.isPanning) {
                settleCanvasPan();
            }
            if (state.marquee) {
                state.marquee.endX = e.clientX;
                state.marquee.endY = e.clientY;
                const endCanvas = viewportApi.screenToCanvas(e.clientX, e.clientY);
                state.marquee.endCanvasX = endCanvas.x;
                state.marquee.endCanvasY = endCanvas.y;
                syncMarqueeSelection(state.marquee);

                const dw = Math.abs(state.marquee.startX - e.clientX);
                const dh = Math.abs(state.marquee.startY - e.clientY);
                if (dw > 5 || dh > 5) {
                    state.justDragged = true;
                    setTimeout(() => { state.justDragged = false; }, 100);
                }

                documentRef.getElementById('selection-box').classList.add('hidden');
                state.marquee = null;
            }
            if (state.dragging) {
                const pos = viewportApi.screenToCanvas(e.clientX, e.clientY);
                settleNodeDrag({ endPosition: pos });
            }
            if (state.resizing) {
                const r = state.resizing;
                const node = state.nodes.get(r.nodeId);
                if (node) {
                    let finalWidth = parseInt(node.el.style.width, 10);
                    let finalHeight = parseInt(node.el.style.height, 10);
                    distributeNodeTextareaResize(r, finalHeight);
                    if (typeof getNodeMinimumSize === 'function') {
                        let minimum = getNodeMinimumSize(node, {
                            width: finalWidth,
                            normalizeFlexibleHeights: true
                        });
                        const configuredMaxWidth = Number.isFinite(r.maxWidth) && r.maxWidth > 0 ? r.maxWidth : Infinity;
                        finalWidth = Math.min(configuredMaxWidth, Math.max(finalWidth, Number(minimum?.minWidth) || 0));
                        minimum = getNodeMinimumSize(node, {
                            width: finalWidth,
                            normalizeFlexibleHeights: true
                        });
                        finalHeight = Math.max(finalHeight, Number(minimum?.minHeight) || 0);
                        node.el.style.width = `${Math.round(finalWidth)}px`;
                        node.el.style.height = `${Math.round(finalHeight)}px`;
                    }
                    distributeNodeTextareaResize(r, finalHeight);
                    node.width = Math.round(finalWidth);
                    node.height = Math.round(finalHeight);
                    node.observedWidth = node.width;
                    node.observedHeight = node.height;
                    node.userResized = true;

                    node.el.classList.remove('is-interacting');
                    refreshNodeConnections(r.nodeId, { force: true });
                }
                state.resizing = null;
                scheduleSave();
            }
            if (state.connecting) {
                if (state.connecting.dragged) {
                    const releasedOnCanvas = e.target.closest('#canvas-container');
                    const releasedOnPort = e.target.closest('.port-dot');
                    const releasedOnNode = e.target.closest('.node');
                    if (
                        releasedOnCanvas &&
                        !releasedOnPort &&
                        !releasedOnNode &&
                        !state.connecting.rewiredFromConnection &&
                        typeof getConnectionCreateCandidates === 'function'
                    ) {
                        const candidates = getConnectionCreateCandidates(state.connecting);
                        if (candidates.length > 0) {
                            const pos = viewportApi.screenToCanvas(e.clientX, e.clientY);
                            tempConnection.setAttribute('d', '');
                            const source = state.connecting;
                            state.connecting = null;
                            openConnectionCreatePopup?.({
                                source,
                                candidates,
                                screenX: e.clientX,
                                screenY: e.clientY,
                                canvasX: pos.x,
                                canvasY: pos.y
                            });
                            finishConnectionDrawInteraction();
                            return;
                        }
                    }
                    tempConnection.setAttribute('d', '');
                    state.connecting = null;
                } else if (e.target.closest('#canvas-container') && !e.target.closest('.port-dot')) {
                    tempConnection.setAttribute('d', '');
                    state.connecting = null;
                }
            }
            finishConnectionDrawInteraction();
        });

        canvasContainer.addEventListener('mouseenter', () => { state.isMouseOverCanvas = true; });
        canvasContainer.addEventListener('mouseleave', () => { state.isMouseOverCanvas = false; });

        canvasContainer.addEventListener('wheel', (e) => {
            if (state.canvas.isPanning && (e.buttons & 4) === 4) {
                e.preventDefault();
                return;
            }

            if (hasScrollableNodeAncestor(e.target)) return;

            e.preventDefault();
            canvasContainer.classList.add('is-zooming');

            if (!state.isInteracting) {
                state.isInteracting = true;
                beginProjectionInteraction(CANVAS_INTERACTION_KIND.ZOOM);
                documentRef.body.classList.add('is-interacting');
                documentRef.getElementById('connections-group').classList.add('is-interacting');
            }

            clearTimeout(state.zoomTimer);
            state.zoomTimer = setTimeout(() => {
                if (state.zoomSettleBlockedUntil && Date.now() < state.zoomSettleBlockedUntil) {
                    clearTimeout(state.zoomTimer);
                    state.zoomTimer = setTimeout(() => {
                        canvasContainer.dispatchEvent(new Event('wheel-zoom-settle'));
                    }, Math.max(16, state.zoomSettleBlockedUntil - Date.now()));
                    return;
                }

                finishZoomInteraction();
            }, ZOOM_SETTLE_DELAY_MS);

            const rect = canvasContainer.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const oldZoom = state.canvas.zoom;
            // Precision touchpads emit small pixel deltas while wheel mice often emit
            // line deltas. Scaling proportionally keeps both inputs continuous instead
            // of turning every event into a visible 10% jump.
            const zoomDelta = getWheelDeltaPixels(e, rect.height);
            const zoomFactor = Math.exp(-zoomDelta * WHEEL_ZOOM_SENSITIVITY);
            const newZoom = Math.max(0.1, Math.min(5, oldZoom * zoomFactor));
            state.canvas.x = mx - (mx - state.canvas.x) * (newZoom / oldZoom);
            state.canvas.y = my - (my - state.canvas.y) * (newZoom / oldZoom);
            state.canvas.zoom = newZoom;
            getProjectionInteraction(CANVAS_INTERACTION_KIND.ZOOM)?.changed();

            if (!state._zoomRaf) {
                state._zoomRaf = requestAnimationFrameRef(() => {
                    // The visual transform is sufficient while the wheel is moving:
                    // broadcasting every frame makes the projection manager scan every
                    // node. The settled transform below performs that exact refresh once.
                    viewportApi.updateCanvasTransform({
                        updateConnections: false,
                        dispatchTransformEvent: false
                    });
                    state._zoomRaf = null;
                });
            }
        }, { passive: false });

        canvasContainer.addEventListener('wheel-zoom-settle', () => {
            if (state.zoomTimer) {
                clearTimeout(state.zoomTimer);
            }
            state.zoomTimer = setTimeout(() => {
                if (state.zoomSettleControlLock) {
                    state.pendingZoomVisualRefresh = true;
                    return;
                }
                if (state.zoomSettleBlockedUntil && Date.now() < state.zoomSettleBlockedUntil) return;

                finishZoomInteraction();
            }, 0);
        });
    }

    return {
        initCanvasInteractions,
        performSampleInteractionStep
    };
}
