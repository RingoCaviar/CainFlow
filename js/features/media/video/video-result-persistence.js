export function getVideoResultSource(result = {}) {
    const assetKey = String(result.videoAssetKey || result.assetKey || '');
    if (assetKey) return `/api/storage/assets/${encodeURIComponent(assetKey)}`;
    return String(result.videoUrl || result.url || '');
}

export async function persistVideoResultForNode({
    node,
    videoBlobs,
    workflowId,
    saveWorkflowNodeMediaAssets,
    rememberWorkflowMediaOperation = () => {}
} = {}) {
    const blobs = Array.isArray(videoBlobs) ? videoBlobs.filter((value) => value instanceof Blob) : [];
    if (!node?.id || blobs.length === 0 || !workflowId
        || typeof saveWorkflowNodeMediaAssets !== 'function') return [];
    let assets = [];
    try {
        assets = await saveWorkflowNodeMediaAssets(
            blobs, workflowId, node.id, node.activeMediaOperationId || ''
        );
    } catch {
        return [];
    }
    const assetKeys = Array.isArray(assets)
        ? assets.map((asset) => String(asset?.asset_key || '')).filter(Boolean)
        : [];
    if (assetKeys.length !== blobs.length) return [];
    node.data = node.data || {};
    rememberWorkflowMediaOperation(node, assets);
    node.data.mediaAssetKeys = assetKeys;
    node.data.videoAssetKey = assetKeys.at(-1) || '';
    return assetKeys;
}
