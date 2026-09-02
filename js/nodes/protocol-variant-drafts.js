/** Persisted drafts are keyed by protocol and exact model variant, never provider. */
export function getProtocolVariantDraftKey(protocolId, modelId) {
    return protocolId && modelId ? `${protocolId}:${modelId}` : '';
}

export function activateProtocolVariantDraft(data = {}, { protocolId, modelId, parameters = {} } = {}) {
    const key = getProtocolVariantDraftKey(protocolId, modelId);
    const drafts = { ...(data.protocolVariantDrafts || {}) };
    const saved = { ...(drafts[key] || {}) };
    const initialized = Object.fromEntries(Object.entries(parameters).flatMap(([id, definition]) => {
        if (definition?.portOnly === true || definition?.id === 'referenceImages') return [];
        if (saved[id] !== undefined) return [[id, saved[id]]];
        return definition?.defaultValue === undefined ? [] : [[id, definition.defaultValue]];
    }));
    return {
        ...data,
        protocolVariantKey: key,
        protocolVariantDrafts: { ...drafts, [key]: initialized },
        protocolParams: initialized
    };
}

export function saveProtocolVariantDraft(data = {}, parameters = {}) {
    const key = data.protocolVariantKey;
    if (!key) return data;
    return {
        ...data,
        protocolVariantDrafts: {
            ...(data.protocolVariantDrafts || {}),
            [key]: { ...(data.protocolVariantDrafts?.[key] || {}), ...parameters }
        },
        protocolParams: { ...(data.protocolParams || {}), ...parameters }
    };
}

/**
 * Return the persisted representation of the authoritative active draft while
 * retaining every inactive Protocol variant draft.
 */
export function snapshotProtocolVariantDrafts(data = {}) {
    const key = data.protocolVariantKey || '';
    const drafts = { ...(data.protocolVariantDrafts || {}) };
    const activeParameters = { ...(data.protocolParams || {}) };
    if (key) drafts[key] = { ...(drafts[key] || {}), ...activeParameters };
    return {
        protocolVariantKey: key,
        protocolVariantDrafts: drafts
    };
}

export function applyProtocolVariantSnapshot(target = {}, data = {}) {
    target.protocolParams = { ...(data.protocolParams || {}) };
    Object.assign(target, snapshotProtocolVariantDrafts(data));
    return target;
}
