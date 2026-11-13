/**
 * 负责画布层级的交互事件，包括拖拽、框选、平移辅助与连线过程中的交互同步。
 */
import { appendMappedConnectionSnapshots } from './connection-copy-utils.js';
import { CANVAS_INTERACTION_KIND } from './canvas-interaction-kinds.js';
import { createSelectionApi } from './selection.js';

export function createCanvasInteractionsApi({
    state,
    selectionApi = createSelectionApi({ state }),
    canvasContainer,
    nodesLayer,
    tempConnection,
    viewportApi,
    getPortPosition,
    drawTempConnection,
    finishConnection = null,
    getNearestConnectionTarget = null,
    updateConnectionTargetFeedback = null,
    clearConnectionTargetFeedback = null,
    updateAllConnections,
    updateDraggingConnections = null,
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
    showToast = () => {},
    pushHistory = () => {},
    getActiveWorkflowId = () => '',
    saveViewportState = () => false,
    serializeOneNode,
    addNode,
    getNodeMinimumSize = null,
    enforceNodeContentMinimum = null,
    findConnectionsCrossingSegments = () => new Set(),
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
    let connectionDrawScheduled = false;
    let connectionDrawPointer = null;
    const projectionInteractionLeases = new Map();
    const pendingGestureFrames = new WeakMap();
    let samplePanOrigin = null;
    let sampleZoomOrigin = null;
    let sampleDrag = null;
    let sampleConnection = null;
    let cuttingHistoryRecorded = false;
    let cutWorkflowId = null;
    let pendingCutFrame = null;
    const pendingCutSegments = [];
    let suppressDragClick = false;
    const ZOOM_SETTLE_DELAY_MS = 120;
    const SHAKE_DETACH_DURATION_MS = 300;
    const SHAKE_SAMPLE_DISTANCE = 8;
    const SHAKE_RESET_MS = 520;
    const SHAKE_MIN_REVERSALS = 4;
    const SHAKE_MIN_TRAVEL = 120;
    const SHAKE_REVERSE_DOT = -0.45;
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

    function queueGestureFrame(gesture, pointer, apply) {
        const queued = pendingGestureFrames.get(gesture);
        if (queued) {
            queued.pointer = pointer;
            return;
        }
        const frame = { pointer };
        pendingGestureFrames.set(gesture, frame);
        requestAnimationFrameRef(() => {
            if (pendingGestureFrames.get(gesture) !== frame) return;
            pendingGestureFrames.delete(gesture);
            if ((gesture === state.dragging || gesture === state.marquee || gesture === state.resizing) &&
                isCurrentGesture(gesture)) {
                apply(gesture, frame.pointer);
            }
        });
    }

    function isCurrentGesture(gesture) {
        if (gesture.workflowId !== undefined && gesture.workflowId !== getActiveWorkflowId()) return false;
        if (gesture.node && state.nodes.get(gesture.nodeId) !== gesture.node) return false;
        if (gesture.startPositions) {
            for (const [id, start] of gesture.startPositions) {
                if (start.node && state.nodes.get(id) !== start.node) return false;
            }
        }
        return true;
    }

    function takeGesturePointer(gesture, releasePointer) {
        const queued = pendingGestureFrames.get(gesture);
        pendingGestureFrames.delete(gesture);
        return releasePointer || queued?.pointer;
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
            // Position screen-space overlays in this frame without waking the
            // full canvas projection and connection-rendering subscribers.
            documentRef.dispatchEvent?.(new CustomEvent('cainflow:canvas-pan-frame'));
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
        connectionDrawPointer = null;
        closeProjectionInteraction(CANVAS_INTERACTION_KIND.CONNECTION_DRAW);
    }

    function cancelConnectionDraw() {
        state.connecting = null;
        connectionDrawPointer = null;
        tempConnection.setAttribute('d', '');
        clearConnectionTargetFeedback?.();
        closeProjectionInteraction(CANVAS_INTERACTION_KIND.CONNECTION_DRAW, 'abort');
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

    function recordDragMotion(dragging, pos) {
        const dx = Math.abs(pos.x - dragging.startX);
        const dy = Math.abs(pos.y - dragging.startY);
        if (dx > 0.5 || dy > 0.5) dragging.hasMotion = true;
        if (dx > 2 || dy > 2) dragging.hasMoved = true;
    }

    function cloneDraggedNodes(dragging) {
        dragging.cloned = true;
        const idMap = new Map();
        for (const nodeId of dragging.nodes) {
            const node = state.nodes.get(nodeId);
            if (!node) continue;
            const data = serializeOneNode(nodeId);
            data.id = null;
            const newId = addNode(node.type, node.x, node.y, data, true);
            if (newId) idMap.set(nodeId, newId);
        }
        if (!idMap.size) return false;

        const { added } = appendMappedConnectionSnapshots({
            state,
            idMap,
            internalConnections: dragging.internalConnections || [],
            externalConnections: dragging.externalConnections || [],
            includeExternalConnections: false,
            remapPromptMentions: { fromWorkflowId: getActiveWorkflowId(), toWorkflowId: getActiveWorkflowId() }
        });
        const newStartPositions = new Map();
        idMap.forEach((newId, originalId) => {
            const start = dragging.startPositions.get(originalId);
            if (start) newStartPositions.set(newId, { ...start, node: state.nodes.get(newId) });
        });
        dragging.nodes = [...idMap.values()];
        dragging.startPositions = newStartPositions;
        dragging.connectionsToUpdate = [];
        dragging.portOffsets = new Map();
        for (const nodeId of state.selectedNodes) state.nodes.get(nodeId)?.el.classList.remove('is-interacting');
        selectionApi.setSelection(dragging.nodes, { notify: false });
        if (added > 0) updatePortStyles();
        return true;
    }

    function applyNodeDragPosition(dragging, pos, { settling = false } = {}) {
        if (dragging.deferSelectionOnDrag && !dragging.selectionActivated) dragging.activateSelection?.();
        const cloned = dragging.isCloneDrag && !dragging.cloned && cloneDraggedNodes(dragging);
        let dragProjection = getProjectionInteraction(CANVAS_INTERACTION_KIND.NODE_DRAG);
        if (!dragProjection) dragProjection = beginProjectionInteraction(CANVAS_INTERACTION_KIND.NODE_DRAG, dragging.nodes);
        if (!settling && !dragging.interactionVisualsActive) {
            dragging.interactionVisualsActive = true;
            documentRef.getElementById('connections-group').classList.add('is-interacting');
            for (const nodeId of dragging.nodes) state.nodes.get(nodeId)?.el?.classList.add('is-interacting');
        }

        const visualDx = alignCanvasDeltaToDevicePixel(pos.x - dragging.startX);
        const visualDy = alignCanvasDeltaToDevicePixel(pos.y - dragging.startY);
        let moved = false;
        for (const nodeId of dragging.nodes) {
            const node = state.nodes.get(nodeId);
            const start = dragging.startPositions.get(nodeId);
            if (!node || !start) continue;
            const nextX = start.x + visualDx;
            const nextY = start.y + visualDy;
            if (node.x !== nextX) {
                node.x = nextX;
                moved = true;
                if (!settling) node.el.style.setProperty('--node-drag-x', `${visualDx}px`);
            }
            if (node.y !== nextY) {
                node.y = nextY;
                moved = true;
                if (!settling) node.el.style.setProperty('--node-drag-y', `${visualDy}px`);
            }
        }
        if (cloned) {
            if (!settling) publishClonedConnections();
        } else if (dragProjection && moved) {
            if (!settling && typeof dragProjection.nodePositionsApplied === 'function') dragProjection.nodePositionsApplied();
            else dragProjection.changed();
        } else if (!dragProjection && !settling && moved) {
            updateDraggingConnections?.(dragging);
        }
        if (!settling) renderShakeDetachProgress(dragging);
        return cloned;
    }

    function publishClonedConnections() {
        updateAllConnections();
        onConnectionsChanged();
    }

    function settleNodeDrag({ endPosition = null, abort = false } = {}) {
        const dragging = state.dragging;
        if (!dragging) return;

        const pointer = takeGesturePointer(dragging, endPosition);
        const isCurrent = isCurrentGesture(dragging);
        let cloned = false;
        if (isCurrent && dragging.hasMotion && pointer) {
            recordDragMotion(dragging, pointer);
            cloned = applyNodeDragPosition(dragging, pointer, { settling: true });
        }
        const moved = dragging.hasMoved;
        if (isCurrent && moved && !abort) {
            state.justDragged = true;
            setTimeout(() => { state.justDragged = false; }, 100);
            suppressDragClick = true;
        }

        for (const nodeId of dragging.nodes) {
            const node = dragging.startPositions.get(nodeId)?.node || (isCurrent && state.nodes.get(nodeId));
            if (!node) continue;
            if (isCurrent) {
                node.el.style.left = node.x + 'px';
                node.el.style.top = node.y + 'px';
            }
            node.el.style.setProperty('--node-drag-x', '0px');
            node.el.style.setProperty('--node-drag-y', '0px');
            node.el.style.removeProperty('transform');
            node.el.classList.remove('is-interacting', 'connection-shake-armed');
            node.el.style.removeProperty('--connection-shake-progress');
        }
        if (cloned) publishClonedConnections();

        if (!isCurrent || abort || !moved) {
            clearConnectionInsertPreview?.();
        } else if (commitConnectionInsertPreview) {
            commitConnectionInsertPreview({ refresh: true });
        } else if (clearConnectionInsertPreview) {
            clearConnectionInsertPreview();
        }

        state.dragging = null;
        if (!isCurrent) {
            projectionInteractionLeases.delete(CANVAS_INTERACTION_KIND.NODE_DRAG);
            return;
        }
        if (moved) documentRef.dispatchEvent?.(new CustomEvent('cainflow:node-drag-ended'));
        closeProjectionInteraction(CANVAS_INTERACTION_KIND.NODE_DRAG, abort ? 'abort' : 'finish');
        scheduleSave();
    }

    function applyNodeResizePointer(r, pos, { settling = false } = {}) {
        const node = state.nodes.get(r.nodeId);
        if (!node || isNodeRunning(r.nodeId)) return;
        const zoom = state.canvas.zoom;
        const dx = (pos.x - r.startX) / zoom;
        const dy = (pos.y - r.startY) / zoom;
        const edge = r.edge || 'bottom-right';
        const movesLeft = edge.includes('left');
        const movesTop = edge.includes('top');
        let targetWidth = r.startWidth + (movesLeft ? -dx : edge.includes('right') ? dx : 0);
        const targetHeight = r.startHeight + (movesTop ? -dy : edge.includes('bottom') ? dy : 0);
        if (r.mediaAspectRatio > 0 && (movesTop || edge.includes('bottom'))
            && (edge === 'top' || edge === 'bottom' || Math.abs(dy * r.mediaAspectRatio) > Math.abs(dx))) {
            targetWidth = r.startWidth + (movesTop ? -dy : dy) * r.mediaAspectRatio;
        }
        const maxWidth = Number.isFinite(r.maxWidth) && r.maxWidth > 0 ? r.maxWidth : Infinity;
        const maxHeight = Number.isFinite(r.maxHeight) && r.maxHeight > 0 ? r.maxHeight : Infinity;
        let minimumHeight = r.minHeight;
        let width = Math.min(maxWidth, Math.max(targetWidth, r.minWidth));
        if (typeof getNodeMinimumSize === 'function') {
            let minimum = getNodeMinimumSize(node, { width, normalizeFlexibleHeights: true });
            const minimumWidth = Math.max(r.minWidth, Number(minimum?.minWidth) || 0);
            const adjustedWidth = Math.min(maxWidth, Math.max(targetWidth, minimumWidth));
            if (adjustedWidth !== width) {
                minimum = getNodeMinimumSize(node, { width: adjustedWidth, normalizeFlexibleHeights: true });
            }
            width = Math.min(maxWidth, Math.max(adjustedWidth, Number(minimum?.minWidth) || 0));
            minimumHeight = Number(minimum?.minHeight) || 0;
        }
        const allowedHeight = maxHeight >= minimumHeight ? maxHeight : Infinity;
        const height = node.el.classList.contains('node-media-aspect')
            ? minimumHeight
            : Math.min(Math.max(targetHeight, minimumHeight), allowedHeight);
        node.el.style.width = `${width}px`;
        node.el.style.height = `${height}px`;
        if (movesLeft) {
            node.x = r.startNodeX + r.startWidth - width;
            node.el.style.left = `${node.x}px`;
        }
        if (movesTop) {
            node.y = r.startNodeY + r.startHeight - height;
            node.el.style.top = `${node.y}px`;
        }
        distributeNodeTextareaResize(r, height);
        if (settling) return;
        if (typeof connectionProjection?.nodeResizeApplied === 'function') connectionProjection.nodeResizeApplied(r.nodeId);
        else refreshNodeConnections(r.nodeId);
    }

    function settleNodeResize(releasePointer = null) {
        const r = state.resizing;
        if (!r) return;
        const pointer = takeGesturePointer(r, releasePointer);
        if (!isCurrentGesture(r)) {
            r.node?.el.classList.remove('is-interacting');
            if (r.cursorClass) documentRef.body.classList.remove(r.cursorClass);
            state.resizing = null;
            return;
        }
        if (r.hasPointerMovement && pointer) applyNodeResizePointer(r, pointer, { settling: true });
        const node = state.nodes.get(r.nodeId);
        if (node) {
            let finalWidth = parseInt(node.el.style.width, 10) || r.startWidth;
            let finalHeight = parseInt(node.el.style.height, 10) || r.startHeight;
            distributeNodeTextareaResize(r, finalHeight);
            if (typeof getNodeMinimumSize === 'function') {
                const measuredWidth = finalWidth;
                let minimum = getNodeMinimumSize(node, {
                    width: finalWidth,
                    normalizeFlexibleHeights: true
                });
                const configuredMaxWidth = Number.isFinite(r.maxWidth) && r.maxWidth > 0 ? r.maxWidth : Infinity;
                finalWidth = Math.min(configuredMaxWidth, Math.max(finalWidth, Number(minimum?.minWidth) || 0));
                if (finalWidth !== measuredWidth) {
                    minimum = getNodeMinimumSize(node, { width: finalWidth, normalizeFlexibleHeights: true });
                }
                finalHeight = node.el.classList.contains('node-media-aspect') ? minimum.minHeight : Math.max(finalHeight, Number(minimum?.minHeight) || 0);
                node.el.style.width = `${Math.round(finalWidth)}px`;
                node.el.style.height = `${Math.round(finalHeight)}px`;
            }
            distributeNodeTextareaResize(r, finalHeight);
            node.width = Math.round(finalWidth);
            node.height = Math.round(finalHeight);
            if (r.edge?.includes('left')) {
                node.x = r.startNodeX + r.startWidth - node.width;
                node.el.style.left = `${node.x}px`;
            }
            if (r.edge?.includes('top')) {
                node.y = r.startNodeY + r.startHeight - node.height;
                node.el.style.top = `${node.y}px`;
            }
            node.observedWidth = node.width;
            node.observedHeight = node.height;
            node.userResized = true;
            node.el.classList.remove('is-interacting');
            if (typeof connectionProjection?.nodeGeometrySettled === 'function') {
                Promise.resolve(connectionProjection.nodeGeometrySettled(r.nodeId, {
                    verticalPositionChanged: node.y !== r.startNodeY
                })).catch((error) => {
                    console.warn('Connection projection failed to settle node resize:', error);
                });
            } else {
                refreshNodeConnections(r.nodeId, { force: true });
            }
        }
        if (r.cursorClass) documentRef.body.classList.remove(r.cursorClass);
        state.resizing = null;
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
                resizeRole: target.resizeRole || '',
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
            const chatResponseTargets = activeTargets.filter((item) => item.resizeRole === 'chat-response');
            distributeExtra(
                remainingDelta,
                chatResponseTargets.length ? chatResponseTargets : activeTargets,
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
        if (!marqueeRect) return;

        const desired = new Set([...marquee.initialSelection].filter(id => state.nodes.has(id)));
        state.nodes.forEach((node, id) => {
            const nodeBounds = getNodeCanvasBounds(node);
            if (nodeBounds && rectsIntersect(marqueeRect, nodeBounds)) desired.add(id);
        });

        if (desired.size !== state.selectedNodes.size || [...desired].some(id => !state.selectedNodes.has(id))) {
            selectionApi.setSelection([...desired]);
        }
    }

    function applyMarqueePointer(marquee, pointer, { settling = false } = {}) {
        marquee.endX = pointer.x;
        marquee.endY = pointer.y;
        marquee.endCanvasX = pointer.canvas.x;
        marquee.endCanvasY = pointer.canvas.y;
        if (!settling) {
            const { style } = documentRef.getElementById('selection-box');
            style.left = `${Math.min(marquee.startX, pointer.x)}px`;
            style.top = `${Math.min(marquee.startY, pointer.y)}px`;
            style.width = `${Math.abs(marquee.startX - pointer.x)}px`;
            style.height = `${Math.abs(marquee.startY - pointer.y)}px`;
        }
        syncMarqueeSelection(marquee);
    }

    function settleMarquee(releasePointer = null) {
        const marquee = state.marquee;
        if (!marquee) return;
        const pointer = takeGesturePointer(marquee, releasePointer);
        if (isCurrentGesture(marquee)) {
            if (pointer) applyMarqueePointer(marquee, pointer, { settling: true });
            if (Math.abs(marquee.startX - marquee.endX) > 5 || Math.abs(marquee.startY - marquee.endY) > 5) {
                state.justDragged = true;
                setTimeout(() => { state.justDragged = false; }, 100);
            }
        }
        documentRef.getElementById('selection-box').classList.add('hidden');
        state.marquee = null;
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

    function appendCutPoint(point) {
        const previous = state.cutPath.at(-1);
        if (previous?.x === point.x && previous.y === point.y) return;
        if (previous) pendingCutSegments.push([previous, point]);
        // The queued segments own the trajectory. Only the final point is needed across frames.
        state.cutPath[0] = point;
    }

    function flushCutSegments() {
        pendingCutFrame = null;
        if (!pendingCutSegments.length) return;
        const segments = pendingCutSegments.splice(0);
        if (cutWorkflowId !== getActiveWorkflowId() || state.canvasPlanApplying || state.historyTransitionInProgress) {
            cutWorkflowId = null;
            return;
        }
        const connectionsToRemove = findConnectionsCrossingSegments(segments);
        if (!connectionsToRemove.size) return;
        if (!cuttingHistoryRecorded) {
            try {
                pushHistory();
            } catch (error) {
                showToast(error.message, 'warning');
                return;
            }
            cuttingHistoryRecorded = true;
        }
        state.connections = state.connections.filter(connection => !connectionsToRemove.has(connection.id));
        updateAllConnections();
        updatePortStyles();
        scheduleSave();
        onConnectionsChanged();
    }

    function queueCutMovement(event, point) {
        for (const sample of event.getCoalescedEvents?.() || []) {
            appendCutPoint(viewportApi.screenToCanvas(sample.clientX, sample.clientY));
        }
        appendCutPoint(point);
        if (pendingCutFrame || !pendingCutSegments.length) return;
        const frame = {};
        pendingCutFrame = frame;
        requestAnimationFrameRef(() => {
            if (pendingCutFrame === frame) flushCutSegments();
        });
    }

    function finishCut(event = null) {
        if (!state.isCutting) return;
        if (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
            appendCutPoint(viewportApi.screenToCanvas(event.clientX, event.clientY));
        }
        flushCutSegments();
        state.isCutting = false;
        cutWorkflowId = null;
        state.cutPath = [];
        canvasContainer.style.cursor = '';
        state.justCut = true;
        setTimeout(() => { state.justCut = false; }, 100);
    }

    function clearShakeDetachVisuals(draggingState) {
        const nodeId = draggingState?.nodes?.[0];
        const node = nodeId ? state.nodes.get(nodeId) : null;
        node?.el?.classList.remove('connection-shake-armed');
        node?.el?.style.removeProperty('--connection-shake-progress');
    }

    function resetShakeTracker(draggingState, pos, now) {
        draggingState.connectionShake = {
            lastX: pos.x,
            lastY: pos.y,
            lastTime: now,
            lastVector: null,
            activeSince: null,
            lastReversalAt: null,
            reversalCount: 0,
            travel: 0,
            progress: null
        };
        return draggingState.connectionShake;
    }

    function updateShakeDetach(draggingState, pos) {
        if (!detachNodesFromConnections) return;
        if (!draggingState?.nodes || draggingState.nodes.length !== 1) return;
        if (draggingState.isCloneDrag || draggingState.connectionShakeDetached) return;

        const nodeId = draggingState.nodes[0];
        const node = state.nodes.get(nodeId);
        const now = getNow();
        if (!node || isNodeRunning(nodeId)) {
            if (draggingState.connectionShake) resetShakeTracker(draggingState, pos, now);
            return;
        }
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
            shake.progress = progress.toFixed(3);

            if (
                now - shake.activeSince >= SHAKE_DETACH_DURATION_MS &&
                shake.reversalCount >= SHAKE_MIN_REVERSALS &&
                shake.travel >= SHAKE_MIN_TRAVEL
            ) {
                if (!hasNodeConnections(nodeId)) {
                    resetShakeTracker(draggingState, pos, now);
                    return;
                }
                if (draggingState.deferSelectionOnDrag && !draggingState.selectionActivated) draggingState.activateSelection?.();
                try { draggingState.promoteHistory?.(); }
                catch (error) { showToast(error.message, 'warning'); resetShakeTracker(draggingState, pos, now); return; }
                const result = detachNodesFromConnections([nodeId], { save: false });
                draggingState.connectionShakeDetached = result?.changed;
                draggingState.connectionsToUpdate = [];
                draggingState.portOffsets = new Map();
                shake.progress = null;
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

    function renderShakeDetachProgress(dragging) {
        const shake = dragging.connectionShake;
        if (!shake) return;
        const nodeId = dragging.nodes[0];
        const progress = shake.progress != null && hasNodeConnections(nodeId) ? shake.progress : null;
        if ((dragging.renderedShakeProgress ?? null) === progress) return;
        dragging.renderedShakeProgress = progress;
        if (progress == null) return clearShakeDetachVisuals(dragging);
        const node = state.nodes.get(nodeId);
        node?.el?.classList.add('connection-shake-armed');
        node?.el?.style.setProperty('--connection-shake-progress', progress);
    }

    function initCanvasInteractions() {
        // Only suppress the click/dblclick belonging to the completed drag.
        // A fresh press starts a new gesture, even within the old 100ms window.
        const stopDragClick = event => {
            if (!suppressDragClick || event.detail === 0) return false;
            event.preventDefault();
            event.stopImmediatePropagation();
            return true;
        };
        canvasContainer.addEventListener('dblclick', stopDragClick, true);
        windowRef.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || event.isComposing || !state.connecting) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (state.connecting.dragged) suppressDragClick = true;
            if (!state.isInteracting && !state.canvas.isPanning) {
                documentRef.body.classList.remove('is-interacting');
                documentRef.getElementById('connections-group').classList.remove('is-interacting');
            }
            cancelConnectionDraw();
        }, true);
        windowRef.addEventListener('blur', () => {
            suppressDragClick = false;
            finishCut();
            documentRef.body.classList.remove('is-interacting');
            documentRef.getElementById('connections-group').classList.remove('is-interacting');
            settleCanvasPan({ abort: true });
            settleMarquee();
            settleNodeDrag({ abort: true });
            settleNodeResize();
            cancelConnectionDraw();
            for (const kind of projectionInteractionLeases.keys()) {
                closeProjectionInteraction(kind, 'abort');
            }
        });

        canvasContainer.addEventListener('mousedown', (e) => {
            if (suppressDragClick) state.justDragged = false;
            suppressDragClick = false;
            if (e.target?.closest?.('#canvas-navigation')) return;
            if (e.button !== 0 || !state.isSpacePressed) return;

            canvasContainer.focus();
            beginCanvasPan(e);
            e.stopPropagation();
        }, true);

        canvasContainer.addEventListener('click', (e) => {
            if (stopDragClick(e)) return;
            if (e.target?.closest?.('#canvas-navigation')) return;
            if (!state.isSpacePressed) return;

            e.preventDefault();
            e.stopPropagation();
        }, true);

        canvasContainer.addEventListener('mousedown', (e) => {
            canvasContainer.focus();

            if (e.ctrlKey && e.button === 2) {
                state.isCutting = true;
                cuttingHistoryRecorded = false;
                cutWorkflowId = getActiveWorkflowId();
                pendingCutSegments.length = 0;
                pendingCutFrame = null;
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
                    selectionApi.clearSelection();
                }

                e.preventDefault();
                const startCanvas = viewportApi.screenToCanvas(e.clientX, e.clientY);
                state.marquee = {
                    workflowId: getActiveWorkflowId(),
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
            const wasPanning = state.canvas.isPanning;
            if (!wasPanning) {
                state.mouseCanvas = viewportApi.screenToCanvas(e.clientX, e.clientY);
            }
            if (state.isCutting) {
                const point = state.canvas.isPanning
                    ? viewportApi.screenToCanvas(e.clientX, e.clientY)
                    : state.mouseCanvas;
                queueCutMovement(e, point);
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
            if (state.marquee || state.dragging) {
                const pos = wasPanning ? viewportApi.screenToCanvas(e.clientX, e.clientY) : state.mouseCanvas;
                if (state.marquee && isCurrentGesture(state.marquee)) {
                    queueGestureFrame(state.marquee, { x: e.clientX, y: e.clientY, canvas: pos }, applyMarqueePointer);
                }
                if (state.dragging) {
                    recordDragMotion(state.dragging, pos);
                    if (state.dragging.nodes.length === 1 && isCurrentGesture(state.dragging)) {
                        updateShakeDetach(state.dragging, pos);
                    }
                    if (state.dragging.hasMotion) queueGestureFrame(state.dragging, pos, applyNodeDragPosition);
                }
            }
            if (state.resizing && isCurrentGesture(state.resizing) &&
                (state.resizing.hasPointerMovement || e.clientX !== state.resizing.startX || e.clientY !== state.resizing.startY)) {
                state.resizing.hasPointerMovement = true;
                queueGestureFrame(state.resizing, { x: e.clientX, y: e.clientY }, applyNodeResizePointer);
            }
            if (state.connecting) {
                const dx = e.clientX - state.connecting.screenX;
                const dy = e.clientY - state.connecting.screenY;
                if (Math.sqrt(dx * dx + dy * dy) > 5) state.connecting.dragged = true;
                const connectionNodeIds = [state.connecting.nodeId].filter(Boolean);
                if (!getProjectionInteraction(CANVAS_INTERACTION_KIND.CONNECTION_DRAW)) {
                    beginProjectionInteraction(CANVAS_INTERACTION_KIND.CONNECTION_DRAW, connectionNodeIds);
                }
                getProjectionInteraction(CANVAS_INTERACTION_KIND.CONNECTION_DRAW)?.changed({ nodeIds: connectionNodeIds });

                connectionDrawPointer = { source: state.connecting, clientX: e.clientX, clientY: e.clientY };
                if (!connectionDrawScheduled) {
                    connectionDrawScheduled = true;
                    requestAnimationFrameRef(() => {
                        connectionDrawScheduled = false;
                        const pointer = connectionDrawPointer;
                        if (!pointer || state.connecting !== pointer.source) return;
                        const source = pointer.source;
                        const currentRect = canvasContainer.getBoundingClientRect();
                        const canvas = state.canvas;
                        const feedback = updateConnectionTargetFeedback?.(source, pointer.clientX, pointer.clientY);
                        drawTempConnection(source.startX, source.startY,
                            feedback?.position?.x ?? (pointer.clientX - currentRect.left - canvas.x) / canvas.zoom,
                            feedback?.position?.y ?? (pointer.clientY - currentRect.top - canvas.y) / canvas.zoom,
                            source.isOutput, feedback?.starts);
                    });
                }
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
            if (state.connecting?.dragged && typeof getNearestConnectionTarget === 'function') {
                const nearest = getNearestConnectionTarget(state.connecting, e.clientX, e.clientY);
                if (nearest) {
                    if (finishConnection?.(state.connecting, nearest.target)) suppressDragClick = true;
                    state.connecting = null;
                    tempConnection.setAttribute('d', '');
                    documentRef.body.classList.remove('is-interacting');
                    documentRef.getElementById('connections-group').classList.remove('is-interacting');
                } else if (e.target?.closest?.('.port-dot')) {
                    const portEl = e.target.closest('.node-port');
                    if (portEl && finishConnection?.(state.connecting, {
                        nodeId: portEl.dataset.nodeId,
                        port: portEl.dataset.port,
                        type: portEl.dataset.type,
                        dir: portEl.dataset.direction
                    })) suppressDragClick = true;
                    state.connecting = null;
                    tempConnection.setAttribute('d', '');
                    documentRef.body.classList.remove('is-interacting');
                    documentRef.getElementById('connections-group').classList.remove('is-interacting');
                }
            }
            if (!state.connecting || state.connecting.dragged) clearConnectionTargetFeedback?.();
        }, true);

        windowRef.addEventListener('mouseup', (e) => {
            // Read geometry before removing interaction styles across the canvas.
            const releasePointer = Number.isFinite(e.clientX) && Number.isFinite(e.clientY)
                ? { x: e.clientX, y: e.clientY }
                : null;
            const releaseCanvasPoint = releasePointer && (state.dragging || state.marquee)
                ? viewportApi.screenToCanvas(e.clientX, e.clientY)
                : null;
            documentRef.body.classList.remove('is-interacting');
            documentRef.getElementById('connections-group').classList.remove('is-interacting');

            finishCut(e);

            if (state.canvas.isPanning) {
                settleCanvasPan();
            }
            settleMarquee(releasePointer && releaseCanvasPoint ? { ...releasePointer, canvas: releaseCanvasPoint } : null);
            if (state.dragging) {
                settleNodeDrag({ endPosition: releaseCanvasPoint });
            }
            settleNodeResize(releasePointer);
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
                            clearConnectionTargetFeedback?.();
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
            if (!state.connecting) clearConnectionTargetFeedback?.();
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
