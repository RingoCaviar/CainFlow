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

/** Capture the active form at a persistence boundary while retaining inactive drafts. */
export function snapshotProtocolVariantDrafts(data = {}, activeParameters = data.protocolParams || {}) {
    const key = data.protocolVariantKey || '';
    const drafts = { ...(data.protocolVariantDrafts || {}) };
    if (key) drafts[key] = { ...(drafts[key] || {}), ...activeParameters };
    return {
        protocolVariantKey: key,
        protocolVariantDrafts: drafts
    };
}

export function applyProtocolVariantSnapshot(target = {}, data = {}, activeParameters = data.protocolParams || {}) {
    target.protocolParams = { ...activeParameters };
    Object.assign(target, snapshotProtocolVariantDrafts(data, activeParameters));
    return target;
}
