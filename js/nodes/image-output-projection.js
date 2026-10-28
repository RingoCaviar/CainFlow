import { getImageImportMediaAssetReferences, normalizeImageList } from '../features/execution/execution-data-utils.js';

const isUrlImport = node => node?.type === 'ImageImport' && (node.importMode ?? node.data?.importMode) === 'url';

export function getImageOutputAssets(node) {
    if (isUrlImport(node)) return [];
    if (node?.type === 'ImageImport') return getImageImportMediaAssetReferences(node);
    if (node?.data?.mediaAssetKeys?.length) return node.data.mediaAssetKeys.slice();
    return node?.data?.imageAssetKey
        ? Array.from({ length: Math.max(1, Number(node.data.imageCount) || 0) }, (_, index) => `${node.data.imageAssetKey}:${index}`)
        : [];
}

// Legacy hydration can compact missing files. Such a list cannot identify durable positions.
export function projectImageOutput(node, values) {
    if (isUrlImport(node)) {
        const value = node.imageUrl || node.data?.imageUrl || node.data?.image || '';
        const images = typeof value === 'string' && /^https?:\/\//i.test(value) ? [value] : [];
        return { assets: [], count: images.length, compacted: false, missingPositions: [], images, remote: true };
    }
    const assets = getImageOutputAssets(node), images = normalizeImageList(values);
    const count = Math.max(assets.length, images.length, Number(node?.data?.imageCount) || 0);
    const compacted = assets.length > 0 && images.length > 0 && images.length !== assets.length;
    const missingPositions = (node?.data?.mediaIntegrity?.missingItems || []).map(item => item.position);
    return { assets, count, compacted, missingPositions, images: compacted ? [] : images };
}

/** Read the actual first output of a single-image consumer, keeping source slots intact. */
export async function readPrimaryImageOutput(node, values, readAsset = null) {
    const output = projectImageOutput(node, values);
    if (output.remote) return output.images[0] || null;
    if (output.missingPositions.includes(0)) return null;
    const raw = [node?.data?.imageList, node?.data?.images, node?.imageDataList].find(list => Array.isArray(list) && list.length);
    if (raw && !raw[0]) return null;
    if (output.images.length) return output.images[0];
    const key = node?.type === 'ImageImport' ? getImageImportMediaAssetReferences(node)[0]
        : node?.data?.mediaAssetKeys?.[0] || node?.data?.imageAssetKey;
    return key && readAsset ? await readAsset(key) || null : null;
}
