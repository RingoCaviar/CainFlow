const RESULT_STATUSES = new Set([
    'committed', 'already-committed', 'conflict', 'stale-epoch',
    'retryable', 'needs-reconciliation', 'rejected'
]);

export const MEDIA_OWNERSHIP_RESULT_STATUSES = Object.freeze([...RESULT_STATUSES]);

function reject(message) {
    return { status: 'rejected', reason: message };
}

export function validateMediaOwnershipTransitionIntent(intent, { temporary = false } = {}) {
    if (!intent || typeof intent !== 'object') return reject('intent-required');
    if ('previousAssetKeys' in intent) return reject('previous-list-is-storage-owned');
    if (!String(intent.operationId || '').trim()) return reject('operation-id-required');
    if (!String(intent.workflowId || '').trim()) return reject('workflow-id-required');
    if (!intent.owner || !String(intent.owner.ownerType || '').trim() || !String(intent.owner.ownerId || '').trim()) {
        return reject('owner-required');
    }
    if (!String(intent.storageEpoch || '').trim()) return reject('storage-epoch-required');
    if (!String(intent.reason || '').trim()) return reject('reason-required');
    if (!temporary && !['workflow-node', 'workflow-import', 'prompt-agent-result'].includes(intent.owner.ownerType)) return reject('persistent-owner-required');
    if (temporary && !['workflow-operation', 'workflow-migration'].includes(intent.owner.ownerType)) return reject('temporary-owner-required');
    if (!temporary && (!Number.isSafeInteger(intent.documentRevision) || intent.documentRevision < 1)) {
        return reject('document-revision-required');
    }
    if (!temporary && (!Number.isSafeInteger(intent.expectedOwnerRevision) || intent.expectedOwnerRevision < 0)) {
        return reject('owner-revision-required');
    }
    if (!temporary && !Array.isArray(intent.nextAssetKeys)) return reject('next-asset-keys-required');
    if (Array.isArray(intent.nextAssetKeys) && intent.nextAssetKeys.some((key) => typeof key !== 'string' || !key.startsWith('media:'))) {
        return reject('invalid-asset-key');
    }
    return null;
}

export function normalizeMediaOwnershipTransitionResult(result) {
    const status = String(result?.status || 'retryable');
    return RESULT_STATUSES.has(status)
        ? { ...result, status }
        : { status: 'retryable', reason: 'unknown-transition-result' };
}

export function createMediaOwnershipTransition({ replaceOwnerReferenceList, releaseTemporaryOwner }) {
    if (typeof replaceOwnerReferenceList !== 'function' || typeof releaseTemporaryOwner !== 'function') {
        throw new TypeError('Media ownership transition adapters are required');
    }
    return Object.freeze({
        replaceOwnerReferenceList: async (intent) => {
            const invalid = validateMediaOwnershipTransitionIntent(intent);
            if (invalid) return invalid;
            return normalizeMediaOwnershipTransitionResult(await replaceOwnerReferenceList(Object.freeze({
                ...intent,
                owner: Object.freeze({ ...intent.owner }),
                ownerType: intent.owner.ownerType,
                ownerId: intent.owner.ownerId,
                expectedGeneration: intent.expectedOwnerRevision,
                assetKeys: Object.freeze([...intent.nextAssetKeys]),
                nextAssetKeys: Object.freeze([...intent.nextAssetKeys])
            })));
        },
        releaseTemporaryOwner: async (intent) => {
            const invalid = validateMediaOwnershipTransitionIntent(intent, { temporary: true });
            if (invalid) return invalid;
            return normalizeMediaOwnershipTransitionResult(await releaseTemporaryOwner(Object.freeze({
                ...intent, owner: Object.freeze({ ...intent.owner }),
                nextAssetKeys: Object.freeze([...(intent.nextAssetKeys || [])])
            })));
        }
    });
}
