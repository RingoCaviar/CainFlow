/** Durable media identities retained by a node snapshot, including forwarded video results. */
export function getSnapshotMediaKeys(node) {
    const keys = [node, node?.data].filter(Boolean).flatMap(holder => [
        ...(Array.isArray(holder.mediaAssetKeys) ? holder.mediaAssetKeys : []),
        holder.imageAssetKey, holder.imageImportAssetKey, holder.videoAssetKey,
        holder.video?.assetKey,
        ...(Array.isArray(holder.videos) ? holder.videos.map(video => video?.assetKey) : [])
    ]);
    return [...new Set(keys.filter(key => typeof key === 'string' && key.startsWith('media:')))];
}
