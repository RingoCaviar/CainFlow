/** A result's source position and its original asset are separate identities. */
export function createImageResultReferenceIdentity(reference, { fallbackIdentity = '' } = {}) {
    const index = Number.isInteger(reference.sourceImageIndex) && reference.sourceImageIndex >= 0 ? reference.sourceImageIndex : 0;
    const point = reference.sourceNodeId
        ? ['node', reference.workflowId || '', reference.sourceNodeId, reference.sourcePort || 'image', index]
        : reference.runId ? ['run', reference.workflowId || '', reference.runId, index]
            : reference.historyId ? ['history', String(reference.historyId)] : ['original'];
    const identity = JSON.stringify([...point, reference.assetKey || fallbackIdentity]);
    return { referenceId: `result:${identity}`, historyId: reference.historyId && !reference.sourceNodeId && !reference.runId
        ? String(reference.historyId) : `agent-asset:${identity}` };
}
