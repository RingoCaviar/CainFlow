const ENDPOINT_TYPE_PROTOCOLS = Object.freeze({
    gemini: 'google',
    google: 'google',
    openai: 'openai',
    'openai-compatible': 'openai',
    'openai-video': 'veo-openai',
    '/v1/videos': 'veo-openai',
    'newapi-image-async': 'newapi-image-async',
    'doubao-video': 'doubao-video'
});

function getSupportedEndpointTypes(fetchedModel = {}) {
    const values = Array.isArray(fetchedModel.raw?.supported_endpoint_types)
        ? fetchedModel.raw.supported_endpoint_types
        : fetchedModel.supported_endpoint_types;
    if (!Array.isArray(values)) return [];
    return [...new Set(values
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean))];
}

function inferProtocolFromModelName(fetchedModel = {}) {
    const fingerprint = `${fetchedModel.id || ''} ${fetchedModel.name || ''}`.toLowerCase();
    if (/\b(?:gemini|imagen)\b/.test(fingerprint) || fingerprint.includes('banana')) return 'google';
    if (
        /\b(?:gpt|openai)\b/.test(fingerprint) ||
        fingerprint.includes('dall-e') ||
        /\bo[134](?:-|\b)/.test(fingerprint)
    ) {
        return 'openai';
    }
    return '';
}

/**
 * Infer the request format from API evidence, not from the model's marketing name.
 * A model family can be exposed through several incompatible provider APIs.
 */
export function inferFetchedModelProtocol(provider, fetchedModel = {}, providerSettings) {
    if (providerSettings.isTtapiOpenAiEndpoint(provider?.endpoint)) return 'ttapi-openai';
    if (providerSettings.isTtapiEndpoint(provider?.endpoint)) return 'ttapi';

    const providerProtocol = providerSettings.getModelFetchProtocol(provider);
    const declaredProtocols = getSupportedEndpointTypes(fetchedModel)
        .map((type) => ENDPOINT_TYPE_PROTOCOLS[type] || '')
        .filter(Boolean);

    if (declaredProtocols.length === 1) return declaredProtocols[0];
    if (declaredProtocols.includes(providerProtocol)) return providerProtocol;

    // A configured provider format is stronger evidence than a model-family name.
    // Keywords only recover legacy/partial provider records whose type is absent.
    if (!String(provider?.type || '').trim()) {
        const keywordProtocol = inferProtocolFromModelName(fetchedModel);
        if (keywordProtocol) return keywordProtocol;
    }
    return providerProtocol;
}
