/**
 * Keeps the derived connection rendering projection aligned with the
 * authoritative workflow model. Callers report facts; this module owns when
 * and how affected paths are rendered.
 */
import { CANVAS_INTERACTION_KIND } from './canvas-interaction-kinds.js';

export function createConnectionProjection({
    updateAllConnections,
    refreshNodeProjection = null,
    beginConnectionRestoration = null,
    updateDirtyConnections,
    invalidateNodePortCache,
    markNodeConnectionsDirty,
    markConnectionDirty,
    detectMisalignedConnections,
    onAlignmentCorrected = () => {},
    requestAnimationFrameRef = requestAnimationFrame,
    cancelAnimationFrameRef = cancelAnimationFrame,
    setTimeoutRef = setTimeout,
    clearTimeoutRef = clearTimeout
} = {}) {
    const CONNECTION_RESTORE_BATCH_SIZE = 100;
    let frameId = 0;
    let pendingWholeProjection = false;
    const restorationTransaction = {
        inProgress: false,
        promise: null,
        abortController: null
    };
    let destroyed = false;
    const pendingNodeIds = new Set();
    const pendingConnectionIds = new Set();
    const pendingAlignmentFrames = new Map();

    function normalizeIds(ids) {
        if (ids == null) return [];
        return (Array.isArray(ids) ? ids : [ids])
            .filter((id) => typeof id === 'string' && id);
    }

    function markGeometry(nodeIds) {
        normalizeIds(nodeIds).forEach((nodeId) => {
            pendingNodeIds.add(nodeId);
            invalidateNodePortCache?.(nodeId);
        });
    }

    function markAppearance(nodeIds) {
        normalizeIds(nodeIds).forEach((nodeId) => {
            pendingNodeIds.add(nodeId);
            markNodeConnectionsDirty?.(nodeId);
        });
    }

    function markTopology({ nodeIds = [], connectionIds = [] } = {}) {
        markGeometry(nodeIds);
        normalizeIds(connectionIds).forEach((connectionId) => {
            pendingConnectionIds.add(connectionId);
            markConnectionDirty?.(connectionId);
        });
    }

    function clearPending() {
        pendingWholeProjection = false;
        pendingNodeIds.clear();
        pendingConnectionIds.clear();
    }

    function commit({ rematerializeTargets = false } = {}) {
        if (destroyed || restorationTransaction.inProgress) return false;
        if (frameId) {
            cancelAnimationFrameRef?.(frameId);
            frameId = 0;
        }
        const renderWholeProjection = pendingWholeProjection;
        const hasTargets = pendingNodeIds.size > 0 || pendingConnectionIds.size > 0;
        const nodeIds = [...pendingNodeIds];
        const connectionIds = [...pendingConnectionIds];
        clearPending();
        if (!renderWholeProjection && hasTargets && typeof updateDirtyConnections === 'function') {
            if (rematerializeTargets) {
                nodeIds.forEach((nodeId) => markNodeConnectionsDirty?.(nodeId));
                connectionIds.forEach((connectionId) => markConnectionDirty?.(connectionId));
            }
            return updateDirtyConnections();
        }
        if (renderWholeProjection) {
            updateAllConnections?.();
            return true;
        }
        return false;
    }

    function schedule() {
        if (destroyed || frameId || restorationTransaction.inProgress) return;
        frameId = requestAnimationFrameRef(() => {
            frameId = 0;
            commit();
        });
    }

    function verifyAlignment(nodeIds = []) {
        if (destroyed) return Promise.resolve({ inspected: 0, corrected: 0 });
        if (restorationTransaction.promise) {
            return restorationTransaction.promise.then(() => verifyAlignment(nodeIds));
        }
        const targets = normalizeIds(nodeIds);
        return new Promise((resolve) => {
            let completed = false;
            let alignmentFrameId = 0;
            const verify = () => {
                completed = true;
                pendingAlignmentFrames.delete(alignmentFrameId);
                if (destroyed) {
                    resolve({ inspected: 0, corrected: 0 });
                    return;
                }
                if (targets.length > 0) {
                    targets.forEach((nodeId) => invalidateNodePortCache?.(nodeId));
                } else {
                    invalidateNodePortCache?.();
                }
                const mismatches = detectMisalignedConnections?.({ nodeIds: targets }) || [];
                mismatches.forEach((item) => markConnectionDirty?.(item.connectionId || item));
                if (mismatches.length) {
                    updateDirtyConnections?.();
                    onAlignmentCorrected({ mismatches, reason: 'interaction-settled' });
                }
                resolve({ inspected: targets.length, corrected: mismatches.length });
            };
            alignmentFrameId = requestAnimationFrameRef(verify);
            if (!completed) pendingAlignmentFrames.set(alignmentFrameId, resolve);
        });
    }

    function waitForRestorationTurn(signal) {
        if (signal?.aborted) return Promise.resolve();
        return new Promise((resolve) => {
            let settled = false;
            let restorationFrameId = null;
            let restorationTimeoutId = null;
            const finish = () => {
                if (settled) return;
                settled = true;
                if (restorationFrameId != null) cancelAnimationFrameRef?.(restorationFrameId);
                if (restorationTimeoutId != null) clearTimeoutRef?.(restorationTimeoutId);
                resolve();
            };
            if (typeof requestAnimationFrameRef === 'function') {
                restorationFrameId = requestAnimationFrameRef(finish);
            }
            if (!settled && typeof setTimeoutRef === 'function') {
                restorationTimeoutId = setTimeoutRef(finish, 50);
            } else if (restorationFrameId == null) {
                finish();
            }
        });
    }

    const interactions = {
        nodeGeometryChanged(nodeIds) {
            if (destroyed) return;
            markGeometry(nodeIds);
            schedule();
        },
        nodeAppearanceChanged(nodeIds) {
            if (destroyed) return;
            markAppearance(nodeIds);
            schedule();
        },
        topologyChanged(change) {
            if (destroyed) return;
            markTopology(change);
            schedule();
        },
        beginInteraction(kind, nodeIds = []) {
            const targets = new Set(normalizeIds(nodeIds));
            let closed = false;
            return {
                changed(change = {}) {
                    if (destroyed) return;
                    if (closed) throw new Error('Canvas interaction is already closed');
                    normalizeIds(change.nodeIds).forEach((nodeId) => targets.add(nodeId));
                    if (kind === CANVAS_INTERACTION_KIND.NODE_DRAG) markGeometry([...targets]);
                    schedule();
                },
                finish() {
                    if (destroyed) return Promise.resolve({ inspected: 0, corrected: 0 });
                    if (closed) return Promise.resolve({ inspected: 0, corrected: 0 });
                    closed = true;
                    if (kind === CANVAS_INTERACTION_KIND.CONNECTION_DRAW) markGeometry([...targets]);
                    commit();
                    return verifyAlignment([...targets]);
                },
                abort() {
                    return this.finish();
                }
            };
        }
    };

    const maintenance = {
        runPerformanceWorkload() {
            if (destroyed) {
                return { nodeProjectionCount: 0, connectionFullRefreshCount: 0 };
            }
            let nodeProjectionCount = 0;
            let connectionFullRefreshCount = 0;
            if (typeof refreshNodeProjection === 'function') {
                refreshNodeProjection();
                nodeProjectionCount = 1;
            }
            if (typeof updateAllConnections === 'function') {
                updateAllConnections();
                connectionFullRefreshCount = 1;
            }
            return { nodeProjectionCount, connectionFullRefreshCount };
        },
        workflowRestored() {
            if (destroyed) return Promise.resolve(false);
            if (restorationTransaction.promise) return restorationTransaction.promise;
            if (frameId) {
                cancelAnimationFrameRef?.(frameId);
                frameId = 0;
            }
            clearPending();
            restorationTransaction.inProgress = true;
            restorationTransaction.abortController = new AbortController();
            const runRestoration = async () => {
                    if (typeof beginConnectionRestoration === 'function') {
                        const restoration = beginConnectionRestoration();
                        let completed = false;
                        try {
                            while (!completed && !restorationTransaction.abortController.signal.aborted) {
                                completed = restoration.renderNextBatch(CONNECTION_RESTORE_BATCH_SIZE);
                                if (!completed) {
                                    await waitForRestorationTurn(restorationTransaction.abortController.signal);
                                }
                            }
                        } finally {
                            restoration.finish?.({
                                completed: completed && !restorationTransaction.abortController.signal.aborted
                            });
                        }
                    } else {
                        await updateAllConnections?.();
                    }
            };
            let resolveRestoration;
            let rejectRestoration;
            restorationTransaction.promise = new Promise((resolve, reject) => {
                resolveRestoration = resolve;
                rejectRestoration = reject;
            });
            const finishRestoration = (result, error = null) => {
                restorationTransaction.inProgress = false;
                try {
                    if (!destroyed) commit({ rematerializeTargets: true });
                    if (error) rejectRestoration(error);
                    else resolveRestoration(result);
                } catch (cleanupError) {
                    rejectRestoration(cleanupError);
                } finally {
                    restorationTransaction.abortController = null;
                    restorationTransaction.promise = null;
                }
            };
            runRestoration().then(
                (result) => finishRestoration(result),
                (error) => finishRestoration(undefined, error)
            );
            return restorationTransaction.promise;
        },
        workflowReplaced() {
            if (destroyed) return;
            pendingWholeProjection = true;
            schedule();
        },
        connectionGeometryStyleChanged() {
            if (destroyed) return;
            pendingWholeProjection = true;
            schedule();
        },
        repairAlignment(nodeIds = []) {
            return verifyAlignment(nodeIds);
        }
    };

    // Temporary migration bridge. Do not inject this into migrated callers.
    function scheduleLegacyRefresh(options = {}) {
        if (destroyed) return false;
        const nodeIds = normalizeIds(options.nodeIds);
        const connectionIds = normalizeIds(options.connectionIds);
        if (options.force === true) pendingWholeProjection = true;
        if (nodeIds.length === 0 && connectionIds.length === 0) pendingWholeProjection = true;
        markTopology({ nodeIds, connectionIds });
        if (options.immediate === true) {
            const result = commit();
            if (options.settle === true) void verifyAlignment(options.nodeIds);
            return result;
        }
        schedule();
        if (options.settle === true) {
            requestAnimationFrameRef(() => { void verifyAlignment(options.nodeIds); });
        }
        return false;
    }

    function destroy() {
        destroyed = true;
        restorationTransaction.abortController?.abort();
        if (frameId) cancelAnimationFrameRef?.(frameId);
        pendingAlignmentFrames.forEach((resolve, alignmentFrameId) => {
            cancelAnimationFrameRef?.(alignmentFrameId);
            resolve({ inspected: 0, corrected: 0 });
        });
        pendingAlignmentFrames.clear();
        frameId = 0;
        clearPending();
    }

    return { interactions, maintenance, scheduleLegacyRefresh, commit, destroy };
}
