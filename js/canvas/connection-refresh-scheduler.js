/**
 * Coalesces connection refresh requests from UI modules.
 *
 * The connection renderer already supports dirty updates. This scheduler gives
 * callers one shared entry point so resize, drag, execution and panel changes
 * can be batched into a single frame instead of repeatedly recomputing every
 * SVG path in the same task.
 */
export function createConnectionRefreshScheduler({
    updateAllConnections,
    updateDirtyConnections = null,
    invalidateNodePortCache = null,
    markNodeConnectionsDirty = null,
    markConnectionDirty = null,
    detectMisalignedConnections = null,
    onAlignmentCorrected = null,
    requestAnimationFrameRef = requestAnimationFrame,
    cancelAnimationFrameRef = cancelAnimationFrame
}) {
    let frameId = 0;
    let pendingForce = false;
    const pendingNodeIds = new Set();
    const pendingConnectionIds = new Set();
    const pendingReasons = new Set();

    function markTargets({ nodeIds = [], connectionIds = [] } = {}) {
        const normalizedNodeIds = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
        normalizedNodeIds
            .filter((nodeId) => typeof nodeId === 'string' && nodeId)
            .forEach((nodeId) => {
                pendingNodeIds.add(nodeId);
                if (typeof invalidateNodePortCache === 'function') {
                    invalidateNodePortCache(nodeId);
                } else {
                    markNodeConnectionsDirty?.(nodeId);
                }
            });

        const normalizedConnectionIds = Array.isArray(connectionIds) ? connectionIds : [connectionIds];
        normalizedConnectionIds
            .filter((connectionId) => typeof connectionId === 'string' && connectionId)
            .forEach((connectionId) => {
                pendingConnectionIds.add(connectionId);
                markConnectionDirty?.(connectionId);
            });
    }

    function clearPending() {
        pendingForce = false;
        pendingNodeIds.clear();
        pendingConnectionIds.clear();
        pendingReasons.clear();
    }

    function flushConnectionRefresh(options = {}) {
        if (frameId) {
            cancelAnimationFrameRef(frameId);
            frameId = 0;
        }

        const force = options.force === true || pendingForce;
        const hasDirtyTargets = pendingNodeIds.size > 0 || pendingConnectionIds.size > 0;
        clearPending();

        if (!force && hasDirtyTargets && typeof updateDirtyConnections === 'function') {
            return updateDirtyConnections();
        }

        updateAllConnections();
        return true;
    }

    function scheduleConnectionRefresh(options = {}) {
        const {
            force = false,
            nodeIds = [],
            connectionIds = [],
            reason = '',
            settle = false
        } = options || {};

        if (force) pendingForce = true;
        if (reason) pendingReasons.add(String(reason));
        markTargets({ nodeIds, connectionIds });

        if (options.immediate === true) {
            const result = flushConnectionRefresh();
            if (settle) scheduleSettledVerification({ nodeIds, reason });
            return result;
        }

        if (!frameId) {
            frameId = requestAnimationFrameRef(() => {
                frameId = 0;
                flushConnectionRefresh();
                if (settle) {
                    scheduleSettledVerification({ nodeIds, reason });
                }
            });
        }
        return false;
    }

    function hasPendingConnectionRefresh() {
        return frameId !== 0;
    }

    function cancelConnectionRefresh() {
        if (frameId) {
            cancelAnimationFrameRef(frameId);
            frameId = 0;
        }
        clearPending();
    }

    function scheduleSettledVerification({ nodeIds, reason }) {
        requestAnimationFrameRef(() => {
            const targetNodeIds = Array.isArray(nodeIds) ? nodeIds : (nodeIds ? [nodeIds] : []);
            if (targetNodeIds.length) {
                targetNodeIds.forEach((nodeId) => invalidateNodePortCache?.(nodeId));
            } else {
                invalidateNodePortCache?.();
            }
            const mismatches = detectMisalignedConnections?.({ nodeIds: targetNodeIds }) || [];
            if (!mismatches.length) return;
            scheduleConnectionRefresh({ connectionIds: mismatches.map((item) => item.connectionId || item), force: true, immediate: true, reason: `${reason || 'connection'}-settled` });
            onAlignmentCorrected?.({ mismatches, reason });
        });
    }

    return {
        scheduleConnectionRefresh,
        flushConnectionRefresh,
        hasPendingConnectionRefresh,
        cancelConnectionRefresh
    };
}
