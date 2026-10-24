/** Retain each Agent run independently of its mutable generation node. */
export function createPromptAgentResultMediaAdapter({
    saveWorkflowNodeMediaAssets,
    releaseWorkflowNodeMediaAssets,
    cancelWorkflowNodeMediaOperation,
    getImageAsset = async () => ''
} = {}) {
    const consumerId = (runId) => `prompt-agent-result:${runId}`;

    async function retain({ workflowId, runId, images = [], mediaAssetKeys = [] } = {}) {
        try {
            if (!workflowId || !runId) throw new Error('生成记录缺少工作流或运行标识。');
            let values = images.slice();
            // Runtime previews may be released, blob URLs, or provider URLs.
            // Resolve the complete local batch; never fetch remote previews or
            // compress missing positions into a different result batch.
            if (mediaAssetKeys.length > 0 && (values.length !== mediaAssetKeys.length
                || values.some((value) => typeof value !== 'string' || !value.startsWith('data:image/')))) {
                values = await Promise.all(mediaAssetKeys.map((key) => getImageAsset(key)));
            }
            if (!values.length || values.some((value) => typeof value !== 'string' || !value.startsWith('data:image/'))) {
                throw new Error('生成图片未能完整读取，请保留当前结果并重试保存。');
            }
            const assets = await saveWorkflowNodeMediaAssets(values, workflowId, consumerId(runId), runId);
            if (!Array.isArray(assets) || assets.length !== values.length
                || assets.some((asset) => !asset?.asset_key?.startsWith('media:') || !asset.mediaTemporaryOwnerId)) {
                throw new Error('图片已生成，但本地保存失败，请重试保存。');
            }
            const ownerId = JSON.stringify([workflowId, consumerId(runId), runId]);
            if (assets.some((asset) => asset.mediaTemporaryOwnerId !== ownerId)) {
                throw new Error('生成结果的媒体保留标识不一致，请重试保存。');
            }
            const keys = assets.map((asset) => asset.asset_key);
            return {
                mediaAssetKeys: keys,
                mediaOwnershipTemporaryOwners: [{ ownerId, assetKeys: keys.slice() }],
                persistenceStatus: 'retained'
            };
        } catch (error) {
            return { persistenceStatus: 'failed', persistenceError: error?.message || '本地保存失败，请重试保存。' };
        }
    }

    async function release({ workflowId, runId, mediaOwnershipTemporaryOwners = [] } = {}) {
        if (!workflowId || !runId) return false;
        // Fence even an in-flight write so a late response cannot revive a cleared run.
        if (typeof cancelWorkflowNodeMediaOperation === 'function') {
            return cancelWorkflowNodeMediaOperation(workflowId, consumerId(runId), runId);
        }
        const ownerId = JSON.stringify([workflowId, consumerId(runId), runId]);
        const assets = mediaOwnershipTemporaryOwners
            .filter((owner) => owner?.ownerId === ownerId)
            .flatMap((owner) => (owner.assetKeys || []).map((asset_key) => ({ asset_key, mediaTemporaryOwnerId: ownerId })));
        return assets.length === 0 || releaseWorkflowNodeMediaAssets(assets, workflowId, consumerId(runId));
    }

    return Object.freeze({ retain, release });
}
