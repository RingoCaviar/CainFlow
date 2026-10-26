import { getImageImportMediaAssetReferences, normalizeImageList } from '../features/execution/execution-data-utils.js';

export function getImageOutputAssets(node) {
    if (node?.type === 'ImageImport') return getImageImportMediaAssetReferences(node);
    if (node?.data?.mediaAssetKeys?.length) return node.data.mediaAssetKeys.slice();
    return node?.data?.imageAssetKey
        ? Array.from({ length: Math.max(1, Number(node.data.imageCount) || 0) }, (_, index) => `${node.data.imageAssetKey}:${index}`)
        : [];
}

// Legacy hydration can compact missing files. Such a list cannot identify durable positions.
export function projectImageOutput(node, values) {
    const assets = getImageOutputAssets(node), images = normalizeImageList(values);
    const count = Math.max(assets.length, images.length, Number(node?.data?.imageCount) || 0);
    const compacted = assets.length > 0 && images.length > 0 && images.length !== assets.length;
    const missingPositions = (node?.data?.mediaIntegrity?.missingItems || []).map(item => item.position);
    return { assets, count, compacted, missingPositions, images: compacted ? [] : images };
}
