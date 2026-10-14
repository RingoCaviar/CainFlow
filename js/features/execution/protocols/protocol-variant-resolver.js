import { resolveDeclarativeProtocolVariant } from './declarative-protocol-schema.js';

/** Resolve a declared Protocol variant without introducing wildcard model matching. */
export function resolveProtocolVariant(protocol = {}, modelId = '') {
    const { variantId, variant } = resolveDeclarativeProtocolVariant(protocol, modelId);
    return { variantId, variant };
}
