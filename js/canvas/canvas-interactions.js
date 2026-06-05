/**
 * 负责画布层级的交互事件，包括拖拽、框选、平移辅助与连线过程中的交互同步。
 */
import { appendMappedConnectionSnapshots } from './connection-copy-utils.js';

export function createCanvasInteractionsApi({
    state,
    canvasContainer,
    nodesLayer,
    tempConnection,
    viewportApi,
    getPortPosition,
    drawTempConnection,
    updateAllConnections,
    updateDraggingConnections = null,
    clearConnectionInsertPreview = null,
    commitConnectionInsertPreview = null,
    detachNodesFromConnections = null,
    updatePortStyles,
    scheduleSave,
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
    requestAnimationFrameRef = requestAnimationFrame
}) {
    let rafUpdate = null;
    let panTransformRaf = null;
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

    function scheduleUIUpdate() {
        if (rafUpdate) return;
        rafUpdate = requestAnimationFrameRef(() => {
            if (state.dragging && updateDraggingConnections) {
                updateDraggingConnections(state.dragging);
            } else {
                updateAllConnections();
            }
            rafUpdate = null;
        });
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

    function isNodeFormControlActive() {
        const active = documentRef.activeElement;
        if (!active || !active.closest) return false;
        const isFormControl = ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable;
        return isFormControl && !!active.closest('.node');
    }

    function distributeNodeTextareaResize(resizeState, nextNodeHeight) {
        const targets = Array.isArray(resizeState?.textareaResizeTargets)
            ? resizeState.textareaResizeTargets
            : [];
        if (!targets.length) return;

        const delta = Number(nextNodeHeight) - Number(resizeState.startHeight);
        const totalWeight = targets.reduce((sum, target) => {
            return sum + Math.max(1, Number(target.weight) || Number(target.startHeight) || 1);
        }, 0) || targets.length;

        targets.forEach((target) => {
            const textarea = target?.el;
            if (!textarea?.isConnected) return;
            const weight = Math.max(1, Number(target.weight) || Number(target.startHeight) || 1);
            const ratio = weight / totalWeight;
            const minHeight = Math.max(0, Number(target.minHeight) || 0);
            const startHeight = Math.max(minHeight, Number(target.startHeight) || minHeight);
            const nextHeight = Math.max(minHeight, startHeight + delta * ratio);
            textarea.style.height = `${Math.round(nextHeight)}px`;
        });
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

        let changed = false;
        state.nodes.forEach((node, id) => {
            const nodeBounds = getNodeCanvasBounds(node);
            const intersects = nodeBounds ? rectsIntersect(marqueeRect, nodeBounds) : false;

            if (intersects) {
                if (!state.selectedNodes.has(id)) {
                    state.selectedNodes.add(id);
                    node.el?.classList.add('selected');
                    changed = true;
                }
            } else if (!marquee.initialSelection.has(id) && state.selectedNodes.has(id)) {
                state.selectedNodes.delete(id);
                node.el?.classList.remove('selected');
                changed = true;
            }
        });

        return changed;
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
            scheduleSave();
            return;
        }

        state.pendingZoomVisualRefresh = false;
        viewportApi.updateCanvasTransform();
        requestAnimationFrameRef(() => {
            viewportApi.refreshNodeTextRendering();
            scheduleSave();
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
                e.preventDefault();
                state.canvas.isPanning = true;
                state.canvas.panStart = { x: e.clientX, y: e.clientY };
                state.canvas.canvasStart = { x: state.canvas.x, y: state.canvas.y };
                canvasContainer.classList.add('grabbing');
                documentRef.body.classList.add('is-interacting');
                documentRef.getElementById('connections-group').classList.add('is-panning');
                return;
            }

            if (isMarqueeAction) {
                const isToggle = e.ctrlKey || e.metaKey || e.shiftKey;
                if (!isToggle) {
                    state.selectedNodes.forEach((nid) => {
                        const node = state.nodes.get(nid);
                        if (node) node.el.classList.remove('selected');
                    });
                    state.selectedNodes.clear();
                    updateAllConnections();
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
                state.canvas.x = state.canvas.canvasStart.x + (e.clientX - state.canvas.panStart.x);
                state.canvas.y = state.canvas.canvasStart.y + (e.clientY - state.canvas.panStart.y);
                schedulePanTransformUpdate();
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

                if (syncMarqueeSelection(state.marquee)) {
                    updateAllConnections();
                }
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

                for (const nodeId of state.dragging.nodes) {
                    const node = state.nodes.get(nodeId);
                    if (state.dragging.isCloneDrag !== true && isNodeRunning(nodeId)) continue;
                    if (node) {
                        const startPos = state.dragging.startPositions.get(nodeId);
                        node.x = startPos.x + dx;
                        node.y = startPos.y + dy;
                        node.el.style.transform = `translate(${dx}px, ${dy}px)`;
                    }
                }
                updateShakeDetach(state.dragging, pos);
                scheduleUIUpdate();
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
                    let dynamicMinHeight = r.minHeight;
                    let constrainedWidth = Math.max(targetW, r.minWidth);
                    const configuredMaxHeight = Number.isFinite(r.maxHeight) && r.maxHeight > 0 ? r.maxHeight : Infinity;
                    distributeNodeTextareaResize(r, Math.min(targetH, configuredMaxHeight));

                    if (typeof getNodeMinimumSize === 'function') {
                        const provisionalMinimum = getNodeMinimumSize(node, { width: constrainedWidth });
                        if (provisionalMinimum) {
                            dynamicMinWidth = Math.max(dynamicMinWidth, Number(provisionalMinimum.minWidth) || 0);
                        }

                        constrainedWidth = Math.max(targetW, dynamicMinWidth);
                        const finalMinimum = getNodeMinimumSize(node, { width: constrainedWidth });
                        if (finalMinimum) {
                            dynamicMinWidth = Math.max(dynamicMinWidth, Number(finalMinimum.minWidth) || 0);
                            dynamicMinHeight = Math.max(dynamicMinHeight, Number(finalMinimum.minHeight) || 0);
                            constrainedWidth = Math.max(targetW, dynamicMinWidth);
                        }
                    }

                    const maxHeight = configuredMaxHeight >= dynamicMinHeight ? configuredMaxHeight : Infinity;
                    const newH = Math.min(Math.max(targetH, dynamicMinHeight), maxHeight);
                    node.el.style.width = constrainedWidth + 'px';
                    node.el.style.height = newH + 'px';
                    distributeNodeTextareaResize(r, newH);

                    updateAllConnections();
                }
            }
            if (state.connecting) {
                const rect = canvasContainer.getBoundingClientRect();
                const { x, y, zoom } = state.canvas;
                const dx = e.clientX - state.connecting.screenX;
                const dy = e.clientY - state.connecting.screenY;
                if (Math.sqrt(dx * dx + dy * dy) > 5) state.connecting.dragged = true;

                drawTempConnection(
                    state.connecting.startX,
                    state.connecting.startY,
                    (e.clientX - rect.left - x) / zoom,
                    (e.clientY - rect.top - y) / zoom
                );
            }
        });

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
                const dx = Math.abs(e.clientX - state.canvas.panStart.x);
                const dy = Math.abs(e.clientY - state.canvas.panStart.y);
                if (dx > 3 || dy > 3) {
                    state.justDragged = true;
                    setTimeout(() => { state.justDragged = false; }, 100);
                    scheduleSave();
                }
                state.canvas.isPanning = false;
                canvasContainer.classList.remove('grabbing');
                viewportApi.updateCanvasTransform();
                notifyViewportSettled();
            }
            if (state.marquee) {
                state.marquee.endX = e.clientX;
                state.marquee.endY = e.clientY;
                const endCanvas = viewportApi.screenToCanvas(e.clientX, e.clientY);
                state.marquee.endCanvasX = endCanvas.x;
                state.marquee.endCanvasY = endCanvas.y;
                if (syncMarqueeSelection(state.marquee)) {
                    updateAllConnections();
                }

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
                if (Math.abs(pos.x - state.dragging.startX) > 2 || Math.abs(pos.y - state.dragging.startY) > 2) {
                    state.justDragged = true;
                    setTimeout(() => { state.justDragged = false; }, 100);
                }
                for (const nodeId of state.dragging.nodes) {
                    const node = state.nodes.get(nodeId);
                    if (node) {
                        node.el.style.left = node.x + 'px';
                        node.el.style.top = node.y + 'px';
                        node.el.style.transform = '';
                        node.el.classList.remove('is-interacting', 'connection-shake-armed');
                        node.el.style.removeProperty('--connection-shake-progress');
                    }
                }
                if (commitConnectionInsertPreview) {
                    commitConnectionInsertPreview();
                } else if (clearConnectionInsertPreview) {
                    clearConnectionInsertPreview();
                }
                state.dragging = null;
                updateAllConnections();
                scheduleSave();
            }
            if (state.resizing) {
                const r = state.resizing;
                const node = state.nodes.get(r.nodeId);
                if (node) {
                    let finalWidth = parseInt(node.el.style.width, 10);
                    let finalHeight = parseInt(node.el.style.height, 10);
                    if (typeof getNodeMinimumSize === 'function') {
                        let minimum = getNodeMinimumSize(node, { width: finalWidth });
                        finalWidth = Math.max(finalWidth, Number(minimum?.minWidth) || 0);
                        minimum = getNodeMinimumSize(node, { width: finalWidth });
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

                    if (typeof enforceNodeContentMinimum === 'function') {
                        const enforced = enforceNodeContentMinimum(r.nodeId, {
                            save: false,
                            updateConnections: false
                        });
                        if (enforced) {
                            node.width = Math.round(enforced.width);
                            node.height = Math.round(enforced.height);
                            node.observedWidth = node.width;
                            node.observedHeight = node.height;
                        }
                    }

                    node.el.classList.remove('is-interacting');
                    updateAllConnections();
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
        });

        canvasContainer.addEventListener('mouseenter', () => { state.isMouseOverCanvas = true; });
        canvasContainer.addEventListener('mouseleave', () => { state.isMouseOverCanvas = false; });

        canvasContainer.addEventListener('wheel', (e) => {
            if (state.canvas.isPanning && (e.buttons & 4) === 4) {
                e.preventDefault();
                return;
            }

            e.preventDefault();
            canvasContainer.classList.add('is-zooming');

            if (!state.isInteracting) {
                state.isInteracting = true;
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
            const newZoom = Math.max(0.1, Math.min(5, oldZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
            state.canvas.x = mx - (mx - state.canvas.x) * (newZoom / oldZoom);
            state.canvas.y = my - (my - state.canvas.y) * (newZoom / oldZoom);
            state.canvas.zoom = newZoom;

            if (!state._zoomRaf) {
                state._zoomRaf = requestAnimationFrameRef(() => {
                    viewportApi.updateCanvasTransform({ updateConnections: false });
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
        initCanvasInteractions
    };
}
