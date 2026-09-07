const MEDIA_OWNER_TYPES = Object.freeze({
    ImageImport: 'workflow-import'
});
const MEDIA_OWNER_NODE_TYPES = new Set([
    'ImageGenerate', 'ImagePreview', 'ImageImport', 'ImageResize', 'ImageSave', 'ImageCompare', 'ImageMerge'
]);

function readMediaAssetKeys(node) {
    const keys = Array.isArray(node?.data?.mediaAssetKeys)
        ? node.data.mediaAssetKeys
        : (Array.isArray(node?.mediaAssetKeys) ? node.mediaAssetKeys : []);
    const importKey = node?.imageImportAssetKey || node?.data?.imageImportAssetKey;
    return [...keys, ...(keys.length === 0 && importKey ? [importKey] : [])]
        .filter((key) => typeof key === 'string' && key.startsWith('media:'));
}

function collectWorkflowMediaOwnerLists(workflow) {
    return (workflow?.nodes || []).flatMap((node) => {
        const assetKeys = readMediaAssetKeys(node);
        if (!node?.id || (!MEDIA_OWNER_NODE_TYPES.has(node.type) && assetKeys.length === 0)) return [];
        return [{
            ownerType: getWorkflowMediaOwnerType(node),
            ownerId: node.id,
            assetKeys
        }];
    });
}

export function getWorkflowMediaOwnerType(node) {
    return MEDIA_OWNER_TYPES[node?.type] || 'workflow-node';
}

export function prepareWorkflowMediaOwnershipCommit(workflow, { newWorkflowIdentity = false } = {}) {
    if (!workflow?.workflowId) throw new Error('Workflow identity is required for Media asset ownership');
    const previousRevision = newWorkflowIdentity ? 0 : Number(workflow.mediaOwnershipRevision || 0);
    return {
        ...workflow,
        mediaOwnershipRevision: Math.max(0, previousRevision) + 1
    };
}

export function createWorkflowMediaOwnershipCommitter({
    getStorageSafetyStatus,
    getMediaOwnerReferenceList,
    listMediaOwnerReferenceLists = async () => [],
    recordMediaWorkflowRevision,
    replaceMediaOwnerReferenceList
}) {
    async function commitPersistedWorkflow(workflow) {
        const workflowId = String(workflow?.workflowId || '').trim();
        const documentRevision = Number(workflow?.mediaOwnershipRevision || 0);
        if (!workflowId || !Number.isInteger(documentRevision) || documentRevision < 1) return false;

        const safety = await getStorageSafetyStatus();
        const storageEpoch = String(safety?.storageEpoch || '');
        if (!storageEpoch) return false;
        const ownerReferenceLists = collectWorkflowMediaOwnerLists(workflow);
        const identities = new Set(ownerReferenceLists.map((owner) => `${owner.ownerType}\0${owner.ownerId}`));
        const previousOwners = await listMediaOwnerReferenceLists(workflowId);
        if (!Array.isArray(previousOwners)) return false;
        for (const previous of previousOwners) {
            if (!identities.has(`${previous.ownerType}\0${previous.ownerId}`)) {
                ownerReferenceLists.push({ ownerType: previous.ownerType, ownerId: previous.ownerId, assetKeys: [] });
            }
        }
        if (!await recordMediaWorkflowRevision(
            workflowId, documentRevision, storageEpoch, ownerReferenceLists
        )) return false;

        for (const owner of ownerReferenceLists) {
            const current = await getMediaOwnerReferenceList(workflowId, owner.ownerType, owner.ownerId);
            if (current?.tombstoned) return false;
            const operationId = `workflow-save:${documentRevision}`;
            const expectedGeneration = Number(current?.documentRevision) === documentRevision
                ? Math.max(0, Number(current?.generation || 0) - 1)
                : Number(current?.generation || 0);
            const result = await replaceMediaOwnerReferenceList({
                workflowId,
                ownerType: owner.ownerType,
                ownerId: owner.ownerId,
                operationId,
                idempotencyKey: `${workflowId}:${operationId}:${owner.ownerType}:${owner.ownerId}`,
                expectedGeneration,
                documentRevision,
                storageEpoch,
                assetKeys: owner.assetKeys
            });
            if (!['committed', 'already-committed'].includes(result?.status)) return false;
        }
        return true;
    }

    return { commitPersistedWorkflow };
}
