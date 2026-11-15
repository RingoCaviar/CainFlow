/** Read a matching original/result pair from a live node or workflow snapshot. */
export function readProductRetouchComparison(node) {
    if (node?.type !== 'ProductRetouch') return null;
    const comparison = node.productRetouchComparison ?? node.data?.productRetouchComparison;
    const keys = Array.isArray(node.data?.mediaAssetKeys) ? node.data.mediaAssetKeys : node.mediaAssetKeys;
    const { originalAssetKey, resultAssetKey } = comparison || {};
    if (!Array.isArray(keys) || keys.length !== 1 || keys[0] !== resultAssetKey
        || !isMediaAssetKey(originalAssetKey) || !isMediaAssetKey(resultAssetKey)) return null;
    return { originalAssetKey, resultAssetKey };
}

function isMediaAssetKey(key) {
    return typeof key === 'string' && /^media:\S+$/.test(key);
}
