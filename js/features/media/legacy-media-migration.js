/**
 * Stages conversion of legacy image fields to content-addressed Media assets.
 * A stage intentionally owns its new assets only temporarily: callers must commit
 * it after the workflow document has reached durable storage.
 */
function imageValuesFromNode(node) {
    const data = node?.data || {};
    const values = [node.image, data.image, node.imageData, node.resizePreviewData, node.images, data.images, node.imageList, data.imageList, node.imageDataList, node.generatedImages]
        .flatMap((value) => Array.isArray(value) ? value : [value])
        .filter((value) => typeof value === 'string' && value.startsWith('data:image/'));
    return values;
}

function legacyKeysFromNode(node) {
    const data = node?.data || {};
    return [node.imageImportAssetKey, data.imageImportAssetKey, node.imageAssetKey, data.imageAssetKey]
        .filter((key, index, keys) => typeof key === 'string' && key && !key.startsWith('media:') && keys.indexOf(key) === index);
}

export function createLegacyMediaMigrationCoordinator({
    getImageAsset = async () => null,
    getImageAssetList = async () => [],
    putMediaAsset = async () => null,
    referenceMediaAsset = async () => false,
    removeMediaReference = async () => false,
    deleteImageAsset = async () => false
} = {}) {
    const releaseTemporaryAssets = async (assets, temporaryOwner) => Promise.all(
        assets.map((key) => removeMediaReference('workflow-migration', temporaryOwner, key))
    );

    async function stageWorkflow(workflow) {
        const workflowId = workflow?.workflowId;
        if (!workflowId) return null;
        const staged = [];
        for (const node of workflow.nodes || []) {
            const existing = (Array.isArray(node?.data?.mediaAssetKeys) ? node.data.mediaAssetKeys : node?.mediaAssetKeys || [])
                .filter((key) => key?.startsWith('media:'));
            if (existing.length) continue;
            const legacyKeys = legacyKeysFromNode(node);
            let values = imageValuesFromNode(node);
            for (const key of legacyKeys) {
                const list = await getImageAssetList(key);
                const recovered = list.length ? list : [await getImageAsset(key)];
                values.push(...recovered.filter(Boolean));
            }
            values = values.filter(Boolean);
            if (!values.length) continue;
            const temporaryOwner = `migration:${workflowId}:${node.id}:${crypto.randomUUID()}`;
            const assets = [];
            try {
                for (const value of values) {
                    const asset = await putMediaAsset(value, 'workflow-migration', temporaryOwner);
                    if (!asset?.asset_key) throw new Error('Unable to store migrated media asset');
                    assets.push(asset.asset_key);
                }
            } catch (error) {
                await releaseTemporaryAssets(assets, temporaryOwner);
                throw error;
            }
            const snapshot = { data: node.data ? { ...node.data } : undefined, mediaAssetKeys: node.mediaAssetKeys, imageImportAssetKey: node.imageImportAssetKey };
            if (node.data && typeof node.data === 'object') node.data.mediaAssetKeys = assets;
            else node.mediaAssetKeys = assets;
            staged.push({ node, assets, legacyKeys, temporaryOwner, snapshot, ownerType: node.type === 'ImageImport' ? 'workflow-import' : 'workflow-node' });
        }
        if (!staged.length) return null;
        let done = false;
        return {
            async commit() {
                if (done) return true;
                const promoted = [];
                try {
                    for (const item of staged) {
                        const ownerId = `${workflowId}:${item.node.id}`;
                        for (const key of [...new Set(item.assets)]) {
                            if (!await referenceMediaAsset(item.ownerType, ownerId, key)) throw new Error('Unable to promote migrated media reference');
                            promoted.push({ ownerType: item.ownerType, ownerId, key });
                        }
                    }
                } catch (error) {
                    await Promise.all(promoted.map((item) => removeMediaReference(item.ownerType, item.ownerId, item.key)));
                    throw error;
                }
                for (const item of staged) {
                    await releaseTemporaryAssets(item.assets, item.temporaryOwner);
                    await Promise.all(item.legacyKeys.map((key) => deleteImageAsset(key)));
                }
                done = true;
                return true;
            },
            async rollback() {
                if (done) return;
                for (const item of staged) {
                    if (item.snapshot.data === undefined) delete item.node.data;
                    else item.node.data = item.snapshot.data;
                    item.node.mediaAssetKeys = item.snapshot.mediaAssetKeys;
                    item.node.imageImportAssetKey = item.snapshot.imageImportAssetKey;
                    await releaseTemporaryAssets(item.assets, item.temporaryOwner);
                }
                done = true;
            }
        };
    }
    return { stageWorkflow };
}
