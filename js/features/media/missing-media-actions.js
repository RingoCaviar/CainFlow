const activeOperations = new Map();
const DEFAULT_MAX_RECOVERY_BYTES = 512 * 1024 * 1024;

export async function validateRecoveryBlob(blob, mediaType, {
    decodeImage = async () => true,
    decodeVideo = async () => true,
    maxBytes = DEFAULT_MAX_RECOVERY_BYTES
} = {}) {
    if (!(blob instanceof Blob) || blob.size < 1) throw new Error('Recovered media is empty');
    const family = expectedMediaFamily(mediaType);
    if (!String(blob.type || '').startsWith(family)) throw new Error('Recovered media type does not match');
    if (blob.size > maxBytes) throw new Error('Recovered media exceeds the size limit');
    const decoded = mediaType === 'video' ? await decodeVideo(blob) : await decodeImage(blob);
    if (!decoded) throw new Error('Recovered media cannot be decoded');
    return blob;
}

function requireIdentity(request) {
    if (!request.workflowId || !request.nodeId) throw new Error('Workflow and node identity are required');
}

function assertRemoteSource(source) {
    if (source?.persisted !== true) throw new Error('Remote recovery source must be persisted');
    const url = String(source?.url || '');
    const taskId = String(source?.taskId || '');
    if (!/^https?:\/\//i.test(url) && !taskId) {
        throw new Error('Remote recovery requires a persisted HTTP(S) result URL or task identity');
    }
}

function expectedMediaFamily(mediaType) {
    return mediaType === 'video' ? 'video/' : 'image/';
}

function assertContext(context, request) {
    if (!context || context.workflowId !== request.workflowId || context.nodeId !== request.nodeId) {
        throw new Error('Media consumer is no longer available');
    }
    if (context.running) throw new Error('Media consumer is running; confirm again after it stops');
    if (Number(context.documentRevision) !== Number(request.expectedDocumentRevision)
        || Number(context.ownerGeneration) !== Number(request.expectedOwnerGeneration)
        || (request.expectedStorageEpoch !== undefined
            && String(context.storageEpoch || '') !== String(request.expectedStorageEpoch || ''))) {
        throw new Error('Media consumer version changed; confirmation is required again');
    }
    if (Number.isInteger(request.position)
        && context.assetKeys[request.position] !== request.expectedAssetKey) {
        throw new Error('Selected Media asset position changed; confirmation is required again');
    }
}

function operationKey(request) {
    return String(request.operationId || [
        request.kind, request.workflowId, request.nodeId,
        request.position ?? (request.positions || []).join(','),
        request.expectedDocumentRevision, request.expectedOwnerGeneration
    ].join(':'));
}

export function createMissingMediaActionCoordinator({
    confirm,
    getContext,
    recoverRemote,
    recoverTask,
    recoverLocal,
    materializeReplacement,
    commitReferenceList,
    recordUndo = () => null
}) {
    async function commit(request, context, assetKeys, intent, materializedAsset = null) {
        const latest = await getContext(request.workflowId, request.nodeId);
        assertContext(latest, request);
        return commitReferenceList({
            workflowId: request.workflowId,
            nodeId: request.nodeId,
            ownerType: request.ownerType || 'workflow-node',
            operationId: operationKey(request),
            intent,
            expectedDocumentRevision: context.documentRevision,
            expectedOwnerGeneration: context.ownerGeneration,
            expectedStorageEpoch: context.storageEpoch,
            assetKeys,
            position: request.position,
            positions: request.positions,
            restoredMissing: request.restoredMissing,
            materializedAsset
        });
    }

    async function execute(request) {
        requireIdentity(request);
        const context = await getContext(request.workflowId, request.nodeId);
        assertContext(context, request);
        const positions = [...new Set((request.positions || [])
            .filter((position) => Number.isInteger(position) && position >= 0 && position < context.assetKeys.length))]
            .sort((a, b) => a - b);
        if (request.kind === 'remove' && positions.length === 0) return { status: 'no-selection' };
        if (!await confirm(request, context)) return { status: 'cancelled' };

        if (request.kind === 'remove') {
            const undoToken = recordUndo(context);
            const removed = positions.map((position) => ({ position, assetKey: context.assetKeys[position] }));
            const selected = new Set(positions);
            const assetKeys = context.assetKeys.filter((_, position) => !selected.has(position));
            const result = await commit(request, context, assetKeys, 'remove');
            return {
                ...result,
                undoToken,
                undo: {
                    workflowId: request.workflowId, nodeId: request.nodeId, ownerType: request.ownerType,
                    removed, expectedDocumentRevision: result.documentRevision,
                    expectedOwnerGeneration: context.ownerGeneration + 1,
                    expectedStorageEpoch: context.storageEpoch
                }
            };
        }

        let asset;
        if (request.kind === 'remote-recover') {
            assertRemoteSource(request.source);
            asset = request.source?.url ? await recoverRemote(request) : await recoverTask(request);
            if (!asset || asset.assetKey !== request.expectedAssetKey) {
                throw new Error('Recovered content does not match the missing Media asset identity');
            }
        } else if (request.kind === 'local-recover') {
            const family = expectedMediaFamily(context.mediaType);
            if (!String(request.localFile?.type || '').startsWith(family)) throw new Error('Local file media type does not match');
            asset = await recoverLocal(request);
            if (!asset || asset.assetKey !== request.expectedAssetKey
                || (request.expectedDigest && asset.digest !== request.expectedDigest)) {
                throw new Error('Local file digest does not match the missing Media asset identity');
            }
        } else if (request.kind === 'replace') {
            const family = expectedMediaFamily(context.mediaType);
            if (!String(request.localFile?.type || '').startsWith(family)) throw new Error('Local file media type does not match');
            asset = await materializeReplacement(request);
        } else {
            throw new Error('Unsupported Missing Media asset action');
        }
        if (!asset?.assetKey) throw new Error('Recovered media was not persisted');
        const assetKeys = context.assetKeys.slice();
        assetKeys[request.position] = asset.assetKey;
        return commit(request, context, assetKeys, request.kind === 'replace' ? 'replace' : 'recover', asset);
    }

    function run(request) {
        const key = operationKey(request);
        if (activeOperations.has(key)) return activeOperations.get(key);
        const normalizedRequest = { ...request, operationId: key };
        const operation = execute(normalizedRequest).finally(() => activeOperations.delete(key));
        activeOperations.set(key, operation);
        return operation;
    }

    async function undo(record) {
        const context = await getContext(record.workflowId, record.nodeId);
        const request = {
            kind: 'undo-remove', workflowId: record.workflowId, nodeId: record.nodeId,
            ownerType: record.ownerType, expectedDocumentRevision: record.expectedDocumentRevision,
            expectedOwnerGeneration: record.expectedOwnerGeneration,
            expectedStorageEpoch: record.expectedStorageEpoch
        };
        assertContext(context, request);
        const assetKeys = context.assetKeys.slice();
        for (const item of [...record.removed].sort((a, b) => a.position - b.position)) {
            assetKeys.splice(item.position, 0, item.assetKey);
        }
        request.restoredMissing = record.removed;
        const result = await commit(request, context, assetKeys, 'undo');
        return { ...result, mediaStillMissing: true };
    }

    return { run, undo };
}

export function resetMissingMediaActionOperations() {
    activeOperations.clear();
}
