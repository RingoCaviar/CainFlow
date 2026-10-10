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
    transitionMediaOwner = null,
    referenceMediaAsset = async () => false,
    removeMediaReference = async () => false,
    deleteImageAsset = async () => false
} = {}) {
    const transition = transitionMediaOwner || createMediaOwnershipTransition({
        replaceOwnerReferenceList: async ({ ownerType, ownerId, assetKeys }) => {
            const promoted = await Promise.all((assetKeys || []).map((key) => referenceMediaAsset(ownerType, ownerId, key)));
            return { status: promoted.every(Boolean) ? 'committed' : 'retryable' };
        },
        releaseTemporaryOwner: async ({ owner, nextAssetKeys }) => {
            const released = await Promise.all((nextAssetKeys || []).map((key) => removeMediaReference(owner.ownerType, owner.ownerId, key)));
            return { status: released.every(Boolean) ? 'committed' : 'needs-reconciliation' };
        }
    });
    const releaseTemporaryAssets = async (assets, temporaryOwner) => Promise.all(
        assets.map((key) => removeMediaReference('workflow-migration', temporaryOwner, key))
    );
    const rollbackItems = async (items) => {
        for (const item of items) {
            if (!item.created) continue;
            if (item.snapshot.data === undefined) delete item.node.data;
            else item.node.data = item.snapshot.data;
            item.node.mediaAssetKeys = item.snapshot.mediaAssetKeys;
            item.node.imageImportAssetKey = item.snapshot.imageImportAssetKey;
            await releaseTemporaryAssets(item.assets, item.temporaryOwner);
        }
    };

    async function stageWorkflow(workflow) {
        const workflowId = workflow?.workflowId;
        if (!workflowId) return null;
        const staged = [];
        try {
            for (const node of workflow.nodes || []) {
            const existing = (Array.isArray(node?.data?.mediaAssetKeys) ? node.data.mediaAssetKeys : node?.mediaAssetKeys || [])
                .filter((key) => key?.startsWith('media:'));
            const legacyKeys = legacyKeysFromNode(node);
            const temporaryOwner = `migration:${workflowId}:${node.id}`;
            if (existing.length) {
                // A prior save may have reached disk before its formal owner was
                // promoted. Reusing this stable temporary owner makes that state
                // recoverable after restart without recreating the original.
                staged.push({ node, assets: existing, legacyKeys, temporaryOwner, snapshot: null, created: false, ownerType: node.type === 'ImageImport' ? 'workflow-import' : 'workflow-node' });
                continue;
            }
            let values = imageValuesFromNode(node);
            for (const key of legacyKeys) {
                const list = await getImageAssetList(key);
                const recovered = list.length ? list : [await getImageAsset(key)];
                values.push(...recovered.filter(Boolean));
            }
            values = values.filter(Boolean);
            if (!values.length) continue;
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
            staged.push({ node, assets, legacyKeys, temporaryOwner, snapshot, created: true, ownerType: node.type === 'ImageImport' ? 'workflow-import' : 'workflow-node' });
            }
        } catch (error) {
            await rollbackItems(staged);
            throw error;
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
                        const result = await transition.replaceOwnerReferenceList({
                            operationId: `migration:${workflowId}:${item.node.id}`,
                            workflowId,
                            owner: { ownerType: item.ownerType, ownerId },
                            expectedOwnerRevision: 0,
                            documentRevision: Number(workflow.mediaOwnershipRevision || 1),
                            storageEpoch: 'legacy-migration',
                            nextAssetKeys: [...new Set(item.assets)],
                            reason: 'legacy-migration'
                        });
                        if (!['committed', 'already-committed'].includes(result.status)) throw new Error('Unable to promote migrated media reference');
                        promoted.push(...[...new Set(item.assets)].map((key) => ({ ownerType: item.ownerType, ownerId, key })));
                    }
                } catch (error) {
                    await Promise.all(promoted.map((item) => removeMediaReference(item.ownerType, item.ownerId, item.key)));
                    throw error;
                }
                for (const item of staged) {
                    const released = await transition.releaseTemporaryOwner({
                        operationId: item.temporaryOwner,
                        workflowId,
                        owner: { ownerType: 'workflow-migration', ownerId: item.temporaryOwner },
                        storageEpoch: 'legacy-migration',
                        nextAssetKeys: item.assets,
                        reason: 'legacy-migration-release'
                    });
                    if (!['committed', 'already-committed'].includes(released.status)) throw new Error('Unable to release migrated media owner');
                    await Promise.all(item.legacyKeys.map((key) => deleteImageAsset(key)));
                }
                done = true;
                return true;
            },
            async rollback() {
                if (done) return;
                await rollbackItems(staged);
                done = true;
            }
        };
    }
    return { stageWorkflow };
}
import { createMediaOwnershipTransition } from './media-ownership-transition.js';

