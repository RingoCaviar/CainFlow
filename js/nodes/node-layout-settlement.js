/**
 * Applies the final content fit before reporting authoritative node geometry.
 */
export function settleNodeContentLayout(nodeId, { ensureVisible, reportGeometry }) {
    ensureVisible(nodeId);
    reportGeometry(nodeId);
}
