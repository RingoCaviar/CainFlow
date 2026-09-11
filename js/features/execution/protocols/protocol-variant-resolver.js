/** Resolve a declared Protocol variant without introducing wildcard model matching. */
export function resolveProtocolVariant(protocol = {}, modelId = '') {
    const variants = protocol?.variants || {};
    const configuredId = String(modelId || '').trim();
    if (Object.hasOwn(variants, configuredId)) {
        return { variantId: configuredId, variant: variants[configuredId] };
    }
    if (protocol.variantIdCaseInsensitive !== true || !configuredId) {
        return { variantId: configuredId, variant: null };
    }
    const normalizedId = configuredId.toLowerCase();
    const variantId = Object.keys(variants).find((candidate) => candidate.toLowerCase() === normalizedId) || '';
    return { variantId: variantId || configuredId, variant: variantId ? variants[variantId] : null };
}
