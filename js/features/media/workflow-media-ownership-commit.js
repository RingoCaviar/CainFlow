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
    replaceMediaOwnerReferenceList,
    removeMediaReference = async () => false
}) {
    const expectedOwnerGenerations = new Map();

    function expectNextOwnerGeneration({ workflowId, ownerType, ownerId, generation, documentRevision, storageEpoch }) {
        expectedOwnerGenerations.set(`${workflowId}\0${ownerType}\0${ownerId}`, {
            generation: Number(generation),
            documentRevision: Number(documentRevision),
            storageEpoch: String(storageEpoch || '')
        });
    }

    function clearExpectedOwnerGeneration({ workflowId, ownerType, ownerId }) {
        expectedOwnerGenerations.delete(`${workflowId}\0${ownerType}\0${ownerId}`);
    }

    async function validateExpectedStorageEpoch(workflowId) {
        const expectations = Array.from(expectedOwnerGenerations.entries())
            .filter(([key]) => key.startsWith(`${workflowId}\0`));
        if (expectations.length === 0) return true;
        const storageEpoch = String((await getStorageSafetyStatus())?.storageEpoch || '');
        const valid = storageEpoch && expectations.every(([, value]) => value.storageEpoch === storageEpoch);
        if (!valid) expectations.forEach(([key]) => expectedOwnerGenerations.delete(key));
        return valid;
    }

    function getExpectedStorageEpoch(workflowId) {
        const expectation = Array.from(expectedOwnerGenerations.entries())
            .find(([key]) => key.startsWith(`${workflowId}\0`));
        return expectation?.[1]?.storageEpoch || '';
    }

    async function commitPersistedWorkflow(workflow) {
        const workflowId = String(workflow?.workflowId || '').trim();
        const documentRevision = Number(workflow?.mediaOwnershipRevision || 0);
        if (!workflowId || !Number.isInteger(documentRevision) || documentRevision < 1) return false;

        const safety = await getStorageSafetyStatus();
        const storageEpoch = String(safety?.storageEpoch || '');
        if (!storageEpoch) return false;
        const staleExpectationKeys = Array.from(expectedOwnerGenerations.entries())
            .filter(([key, value]) => key.startsWith(`${workflowId}\0`) && value.storageEpoch && value.storageEpoch !== storageEpoch)
            .map(([key]) => key);
        if (staleExpectationKeys.length > 0) {
            staleExpectationKeys.forEach((key) => expectedOwnerGenerations.delete(key));
            return false;
        }
        const ownerReferenceLists = collectWorkflowMediaOwnerLists(workflow);
        const temporaryOwners = new Map((workflow.nodes || []).map((node) => [
            `${getWorkflowMediaOwnerType(node)}\0${node.id}`,
            { node, owners: Array.isArray(node?.data?.mediaOwnershipTemporaryOwners)
                ? node.data.mediaOwnershipTemporaryOwners : [] }
        ]));
        const identities = new Set(ownerReferenceLists.map((owner) => `${owner.ownerType}\0${owner.ownerId}`));
        const restoredOwnerIntents = new Map((Array.isArray(workflow.mediaOwnershipRestoreOwnerIds)
            ? workflow.mediaOwnershipRestoreOwnerIds : [])
            .filter((marker) => Number(marker?.documentRevision) === documentRevision)
            .map((marker) => [marker.ownerId, marker.intent === 'redo' ? 'redo' : 'undo']));
        const previousOwners = await listMediaOwnerReferenceLists(workflowId);
        if (!Array.isArray(previousOwners)) return false;
        for (const previous of previousOwners) {
            if (!identities.has(`${previous.ownerType}\0${previous.ownerId}`)) {
                if (previous.tombstoned) continue;
                ownerReferenceLists.push({ ownerType: previous.ownerType, ownerId: previous.ownerId, assetKeys: [], deleted: true });
            } else if (previous.tombstoned && restoredOwnerIntents.has(`${previous.ownerType}:${previous.ownerId}`)) {
                const current = ownerReferenceLists.find((owner) => (
                    owner.ownerType === previous.ownerType && owner.ownerId === previous.ownerId
                ));
                if (current) current.restored = restoredOwnerIntents.get(`${previous.ownerType}:${previous.ownerId}`);
            }
        }
        if (!await recordMediaWorkflowRevision(
            workflowId, documentRevision, storageEpoch, ownerReferenceLists
        )) return false;

        for (const owner of ownerReferenceLists) {
            const current = await getMediaOwnerReferenceList(workflowId, owner.ownerType, owner.ownerId);
            if (current?.tombstoned && !owner.restored && !owner.deleted) return false;
            const operationKind = owner.deleted ? 'workflow-delete' : (owner.restored ? `workflow-${owner.restored}` : 'workflow-save');
            const operationId = `${operationKind}:${documentRevision}`;
            const expectationKey = `${workflowId}\0${owner.ownerType}\0${owner.ownerId}`;
            const requestedExpectation = expectedOwnerGenerations.get(expectationKey);
            if (requestedExpectation?.storageEpoch && requestedExpectation.storageEpoch !== storageEpoch) {
                expectedOwnerGenerations.delete(expectationKey);
                return false;
            }
            const expectedGeneration = requestedExpectation
                && requestedExpectation.documentRevision + 1 === documentRevision
                ? requestedExpectation.generation
                : (Number(current?.documentRevision) === documentRevision
                    ? Math.max(0, Number(current?.generation || 0) - 1)
                    : Number(current?.generation || 0));
            const result = await replaceMediaOwnerReferenceList({
                workflowId,
                ownerType: owner.ownerType,
                ownerId: owner.ownerId,
                operationId,
                intent: owner.deleted ? 'delete' : (owner.restored || 'save'),
                idempotencyKey: `${workflowId}:${operationId}:${owner.ownerType}:${owner.ownerId}`,
                expectedGeneration,
                documentRevision,
                storageEpoch,
                assetKeys: owner.assetKeys
            });
            expectedOwnerGenerations.delete(expectationKey);
            if (!['committed', 'already-committed'].includes(result?.status)) return false;
            const temporaryOwner = temporaryOwners.get(`${owner.ownerType}\0${owner.ownerId}`);
            if (temporaryOwner) {
                const released = await Promise.all(temporaryOwner.owners.flatMap((candidate) => (
                    Array.isArray(candidate?.assetKeys) ? candidate.assetKeys.map((assetKey) => (
                        removeMediaReference('workflow-operation', candidate.ownerId, assetKey)
                    )) : []
                )));
                if (!released.every(Boolean)) return false;
                if (temporaryOwner.node.data) {
                    delete temporaryOwner.node.data.mediaOwnershipTemporaryOwners;
                }
            }
        }
        return true;
    }

    return {
        commitPersistedWorkflow,
        expectNextOwnerGeneration,
        clearExpectedOwnerGeneration,
        validateExpectedStorageEpoch,
        getExpectedStorageEpoch
    };
}
