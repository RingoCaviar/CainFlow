/**
 * 负责画布层级的交互事件，包括拖拽、框选、平移辅助与连线过程中的交互同步。
 */
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
    checkLineIntersection,
    getConnectionSamplePoints,
    onConnectionsChanged = () => {},
    documentRef = document,
    windowRef = window,
    requestAnimationFrameRef = requestAnimationFrame
}) {
    let rafUpdate = null;
    const SHAKE_DETACH_DURATION_MS = 300;
    const SHAKE_SAMPLE_DISTANCE = 8;
    const SHAKE_RESET_MS = 520;
    const SHAKE_MIN_REVERSALS = 4;
    const SHAKE_MIN_TRAVEL = 120;
    const SHAKE_REVERSE_DOT = -0.45;

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

    function getNow() {
        return windowRef.performance?.now?.() || Date.now();
    }

    function hasNodeConnections(nodeId) {
        return state.connections.some((connection) => (
            connection.from.nodeId === nodeId ||
            connection.to.nodeId === nodeId
        ));
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
                state.marquee = {
                    startX: e.clientX,
                    startY: e.clientY,
                    endX: e.clientX,
                    endY: e.clientY,
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
            state.mouseCanvas = viewportApi.screenToCanvas(e.clientX, e.clientY);

            if (state.isCutting) {
                const pos = viewportApi.screenToCanvas(e.clientX, e.clientY);
                const prevPos = state.cutPath[state.cutPath.length - 1];
                state.cutPath.push(pos);

                let changed = false;
                const connectionsToRemove = new Set();

                for (const conn of state.connections) {
                    const from = getPortPosition(conn.from.nodeId, conn.from.port, 'output');
                    const to = getPortPosition(conn.to.nodeId, conn.to.port, 'input');

                    const samplePoints = getConnectionSamplePoints(
                        from.x,
                        from.y,
                        to.x,
                        to.y,
                        { type: state.connectionLineType || 'bezier' }
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
                viewportApi.updateCanvasTransform();
            }
            if (state.marquee) {
                state.marquee.endX = e.clientX;
                state.marquee.endY = e.clientY;
                const box = documentRef.getElementById('selection-box');
                const x = Math.min(state.marquee.startX, state.marquee.endX);
                const y = Math.min(state.marquee.startY, state.marquee.endY);
                const w = Math.abs(state.marquee.startX - state.marquee.endX);
                const h = Math.abs(state.marquee.startY - state.marquee.endY);
                box.style.left = x + 'px';
                box.style.top = y + 'px';
                box.style.width = w + 'px';
                box.style.height = h + 'px';

                const mX1 = Math.min(state.marquee.startX, state.marquee.endX);
                const mX2 = Math.max(state.marquee.startX, state.marquee.endX);
                const mY1 = Math.min(state.marquee.startY, state.marquee.endY);
                const mY2 = Math.max(state.marquee.startY, state.marquee.endY);

                state.nodes.forEach((node, id) => {
                    const nRect = node.el.getBoundingClientRect();
                    if (mX1 < nRect.right && mX2 > nRect.left && mY1 < nRect.bottom && mY2 > nRect.top) {
                        if (!state.selectedNodes.has(id)) {
                            state.selectedNodes.add(id);
                            node.el.classList.add('selected');
                        }
                    } else if (!state.marquee.initialSelection.has(id)) {
                        if (state.selectedNodes.has(id)) {
                            state.selectedNodes.delete(id);
                            node.el.classList.remove('selected');
                        }
                    }
                });
                updateAllConnections();
            }
            if (state.dragging) {
                if (state.dragging.isCloneDrag && !state.dragging.cloned) {
                    state.dragging.cloned = true;
                    const newDraggedIds = [];

                    for (const nodeId of state.dragging.nodes) {
                        const origNode = state.nodes.get(nodeId);
                        if (origNode) {
                            const data = serializeOneNode(nodeId);
                            data.id = null;
                            const newId = addNode(origNode.type, origNode.x, origNode.y, data, true);
                            if (newId) newDraggedIds.push(newId);
                        }
                    }

                    if (newDraggedIds.length > 0) {
                        const newStartPositions = new Map();
                        newDraggedIds.forEach((newId, index) => {
                            const origId = state.dragging.nodes[index];
                            const startPos = state.dragging.startPositions.get(origId);
                            if (startPos) newStartPositions.set(newId, { x: startPos.x, y: startPos.y });
                        });

                        state.dragging.nodes = newDraggedIds;
                        state.dragging.startPositions = newStartPositions;

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
                    }
                }
                const pos = viewportApi.screenToCanvas(e.clientX, e.clientY);
                const dx = pos.x - state.dragging.startX;
                const dy = pos.y - state.dragging.startY;

                for (const nodeId of state.dragging.nodes) {
                    const node = state.nodes.get(nodeId);
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
                    const targetW = r.startWidth + dx;
                    const targetH = r.startHeight + dy;

                    const newW = Math.max(targetW, r.minWidth);
                    const maxHeight = Number.isFinite(r.maxHeight) && r.maxHeight > 0 ? r.maxHeight : Infinity;
                    const newH = Math.min(Math.max(targetH, r.minHeight), maxHeight);
                    node.el.style.width = newW + 'px';
                    node.el.style.height = newH + 'px';

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
            }
            if (state.marquee) {
                state.marquee.endX = e.clientX;
                state.marquee.endY = e.clientY;
                const mX1 = Math.min(state.marquee.startX, state.marquee.endX);
                const mX2 = Math.max(state.marquee.startX, state.marquee.endX);
                const mY1 = Math.min(state.marquee.startY, state.marquee.endY);
                const mY2 = Math.max(state.marquee.startY, state.marquee.endY);

                state.nodes.forEach((node, id) => {
                    const nRect = node.el.getBoundingClientRect();
                    if (mX1 < nRect.right && mX2 > nRect.left && mY1 < nRect.bottom && mY2 > nRect.top) {
                        if (!state.selectedNodes.has(id)) {
                            state.selectedNodes.add(id);
                            node.el.classList.add('selected');
                        }
                    } else if (!state.marquee.initialSelection.has(id)) {
                        if (state.selectedNodes.has(id)) {
                            state.selectedNodes.delete(id);
                            node.el.classList.remove('selected');
                        }
                    }
                });

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
                    node.width = parseInt(node.el.style.width, 10);
                    node.height = parseInt(node.el.style.height, 10);

                    node.el.classList.remove('is-interacting');
                    scheduleUIUpdate();
                }
                state.resizing = null;
                scheduleSave();
            }
            if (state.connecting) {
                if (state.connecting.dragged) {
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
            e.preventDefault();
            canvasContainer.classList.add('is-zooming');

            if (!state.isInteracting) {
                state.isInteracting = true;
                documentRef.body.classList.add('is-interacting');
                documentRef.getElementById('connections-group').classList.add('is-interacting');
            }

            clearTimeout(state.zoomTimer);
            state.zoomTimer = setTimeout(() => {
                viewportApi.updateCanvasTransform();

                requestAnimationFrameRef(() => {
                    viewportApi.updateCanvasTransform();

                    requestAnimationFrameRef(() => {
                        state.isInteracting = false;
                        canvasContainer.classList.remove('is-zooming');
                        documentRef.body.classList.remove('is-interacting');
                        documentRef.getElementById('connections-group').classList.remove('is-interacting');

                        viewportApi.updateCanvasTransform();
                        viewportApi.refreshNodeTextRendering();
                        scheduleSave();
                    });
                });
            }, 250);

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
                    viewportApi.updateCanvasTransform();
                    state._zoomRaf = null;
                });
            }
        }, { passive: false });
    }

    return {
        initCanvasInteractions
    };
}
