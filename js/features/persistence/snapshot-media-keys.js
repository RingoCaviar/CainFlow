import { readProductRetouchComparison } from '../product-retouch/product-retouch-comparison.js';
import { getCommerceImageSetHistoryAssetKeys } from '../ecommerce-image-set/commerce-image-set-plan.js';

/** Durable media identities retained by a node snapshot, including forwarded video results. */
export function getSnapshotMediaKeys(node, { includeCommerceHistory = true } = {}) {
    const keys = [node, node?.data].filter(Boolean).flatMap(holder => [
        ...(Array.isArray(holder.mediaAssetKeys) ? holder.mediaAssetKeys : []),
        holder.imageAssetKey, holder.imageImportAssetKey, holder.videoAssetKey,
        holder.video?.assetKey,
        ...(Array.isArray(holder.videos) ? holder.videos.map(video => video?.assetKey) : [])
    ]);
    const comparison = readProductRetouchComparison(node);
    if (comparison) keys.push(comparison.originalAssetKey);
    if (node?.type === 'ECommerceImageSet' && includeCommerceHistory) {
        keys.push(...getCommerceImageSetHistoryAssetKeys(node.commerceImageSet ?? node.data?.commerceImageSet));
    }
    return [...new Set(keys.filter(key => typeof key === 'string' && key.startsWith('media:')))];
}
