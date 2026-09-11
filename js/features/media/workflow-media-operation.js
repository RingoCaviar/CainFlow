export function rememberWorkflowMediaOperation(node, assets) {
    const complete = (Array.isArray(assets) ? assets : []).filter((asset) => asset?.asset_key);
    const ownerId = complete[0]?.mediaTemporaryOwnerId;
    if (!node?.data || !ownerId || complete.some((asset) => asset.mediaTemporaryOwnerId !== ownerId)) return false;
    node.data.mediaOwnershipTemporaryOwners = [
        ...(Array.isArray(node.data.mediaOwnershipTemporaryOwners) ? node.data.mediaOwnershipTemporaryOwners : []),
        { ownerId, assetKeys: complete.map((asset) => asset.asset_key) }
    ];
    return true;
}
