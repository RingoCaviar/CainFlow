/**
 * Keeps the derived connection rendering projection aligned with the
 * authoritative workflow model. Callers report facts; this module owns when
 * and how affected paths are rendered.
 */
export function createConnectionProjection({
    updateAllConnections,
    updateDirtyConnections,
    invalidateNodePortCache,
    markNodeConnectionsDirty,
    markConnectionDirty,
    detectMisalignedConnections,
    onAlignmentCorrected = () => {},
    requestAnimationFrameRef = requestAnimationFrame,
    cancelAnimationFrameRef = cancelAnimationFrame
} = {}) {
    let frameId = 0;
    let pendingWholeProjection = false;
    const pendingNodeIds = new Set();
    const pendingConnectionIds = new Set();

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

    function commit() {
        if (frameId) {
            cancelAnimationFrameRef?.(frameId);
            frameId = 0;
        }
        const renderWholeProjection = pendingWholeProjection;
        const hasTargets = pendingNodeIds.size > 0 || pendingConnectionIds.size > 0;
        clearPending();
        if (!renderWholeProjection && hasTargets && typeof updateDirtyConnections === 'function') {
            return updateDirtyConnections();
        }
        if (renderWholeProjection) {
            updateAllConnections?.();
            return true;
        }
        return false;
    }

    function schedule() {
        if (frameId) return;
        frameId = requestAnimationFrameRef(() => {
            frameId = 0;
            commit();
        });
    }

    function verifyAlignment(nodeIds = []) {
        const targets = normalizeIds(nodeIds);
        return new Promise((resolve) => {
            requestAnimationFrameRef(() => {
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
            });
        });
    }

    const interactions = {
        nodeGeometryChanged(nodeIds) {
            markGeometry(nodeIds);
            schedule();
        },
        nodeAppearanceChanged(nodeIds) {
            markAppearance(nodeIds);
            schedule();
        },
        topologyChanged(change) {
            markTopology(change);
            schedule();
        },
        beginInteraction(kind, nodeIds = []) {
            const targets = normalizeIds(nodeIds);
            let closed = false;
            return {
                changed() {
                    if (closed) throw new Error('Canvas interaction is already closed');
                    if (kind === 'node-drag') markGeometry(targets);
                    schedule();
                },
                finish() {
                    if (closed) return Promise.resolve({ inspected: 0, corrected: 0 });
                    closed = true;
                    commit();
                    return verifyAlignment(targets);
                },
                abort() {
                    return this.finish();
                }
            };
        }
    };

    const maintenance = {
        workflowReplaced() {
            pendingWholeProjection = true;
            schedule();
        },
        connectionGeometryStyleChanged() {
            pendingWholeProjection = true;
            schedule();
        },
        repairAlignment(nodeIds = []) {
            return verifyAlignment(nodeIds);
        }
    };

    // Temporary migration bridge. Do not inject this into migrated callers.
    function scheduleLegacyRefresh(options = {}) {
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
        if (frameId) cancelAnimationFrameRef?.(frameId);
        frameId = 0;
        clearPending();
    }

    return { interactions, maintenance, scheduleLegacyRefresh, commit, destroy };
}
