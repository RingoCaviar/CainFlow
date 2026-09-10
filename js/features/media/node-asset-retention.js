import { hasNodeCapability, NODE_CAPABILITIES } from '../../nodes/registry.js';

function getImportAssetKey(node) {
    if (typeof node?.imageImportAssetKey === 'string' && node.imageImportAssetKey) {
        return node.imageImportAssetKey;
    }
    return typeof node?.data?.imageImportAssetKey === 'string' ? node.data.imageImportAssetKey : '';
}

function getNodeAssetKey(node) {
    if (typeof node?.imageAssetKey === 'string' && node.imageAssetKey) {
        return node.imageAssetKey;
    }
    return typeof node?.data?.imageAssetKey === 'string' ? node.data.imageAssetKey : '';
}

function retainWorkflowNodeAssets(ids, nodes) {
    (Array.isArray(nodes) ? nodes : []).forEach((node) => {
        const importAssetKey = getImportAssetKey(node);
        if (importAssetKey) ids.add(importAssetKey);

        if (!node?.id || !hasNodeCapability(node.type, NODE_CAPABILITIES.RECOVERABLE_IMAGE_ASSET)) return;
        ids.add(node.id);
        const assetKey = getNodeAssetKey(node);
        if (assetKey) ids.add(assetKey);
    });
}

/**
 * Returns every persisted node or import asset that belongs to an open workflow.
 * A connection affects runtime propagation, not ownership of a node's current result.
 */
export function collectRetainedNodeAssetIds({ nodes, workflowTabs = [], activeWorkflowName = '' } = {}) {
    const ids = new Set();
    retainWorkflowNodeAssets(ids, nodes instanceof Map ? Array.from(nodes.values()) : nodes);
    (Array.isArray(workflowTabs) ? workflowTabs : []).forEach((tab) => {
        if (tab?.name === activeWorkflowName) return;
        retainWorkflowNodeAssets(ids, tab?.data?.nodes);
    });
    return ids;
}
