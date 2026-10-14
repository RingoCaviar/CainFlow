/**
 * Shared contract for Declarative protocol configurations.
 *
 * The editor and execution layer deliberately use the same data shape.  A
 * protocol variant is an overlay: plain objects merge recursively, arrays are
 * replaced as a whole, and null explicitly clears an inherited value.  This
 * keeps protocol declarations extensible while making the effective request
 * contract deterministic.
 */

export const DECLARATIVE_PROTOCOL_SCHEMA_VERSION = 1;

const PROTOCOL_FIELDS = [
    'id', 'schemaVersion', 'label', 'taskTypes', 'helpText',
    'urlTemplate', 'urlTemplates', 'apikeyLocation', 'apikeyField',
    'authentication', 'parameters', 'responsePath', 'fixedParams', 'videoMeta',
    'variants', 'variantIdCaseInsensitive', 'requestEncoding',
    'requestEncodingWhenReferenceImages', 'createPath', 'queryPath', 'asyncTask',
    'referenceImage', 'transportAdapter', 'includeModel', 'readOnly', 'executionBlockedReason'
];

const VARIANT_FIELDS = [
    'id', 'schemaVersion', 'label', 'taskTypes', 'helpText',
    'urlTemplate', 'urlTemplates', 'apikeyLocation', 'apikeyField',
    'authentication', 'parameters', 'responsePath', 'fixedParams', 'videoMeta',
    'variants', 'variantIdCaseInsensitive', 'requestEncoding',
    'requestEncodingWhenReferenceImages', 'createPath', 'queryPath', 'asyncTask',
    'referenceImage', 'transportAdapter', 'includeModel'
];

const PARAMETER_FIELDS = [
    'id', 'label', 'exposed', 'inputPort', 'portType', 'portCount', 'portLabel',
    'portOnly', 'required', 'omitIfEmpty', 'dataType', 'type', 'uiControl',
    'options', 'defaultValue', 'requestField', 'taskTypes', 'min', 'max', 'step',
    'minLength', 'maxLength', 'note', 'description', 'placeholder', 'rows',
    'layout', 'mediaRole'
];

const FIELD_DESCRIPTORS = Object.freeze({
    protocol: Object.freeze(PROTOCOL_FIELDS.map((id) => ({ id, editor: editorForProtocolField(id) }))),
    variant: Object.freeze(VARIANT_FIELDS.map((id) => ({ id, editor: editorForVariantField(id) }))),
    parameter: Object.freeze(PARAMETER_FIELDS.map((id) => ({ id, editor: editorForParameterField(id) })))
});

function editorForProtocolField(id) {
    if (id === 'parameters') return 'parameter-map';
    if (id === 'variants') return 'variant-map';
    if (['taskTypes'].includes(id)) return 'string-list';
    if (['authentication', 'responsePath', 'fixedParams', 'videoMeta', 'asyncTask', 'referenceImage', 'urlTemplates'].includes(id)) return 'object';
    return ['schemaVersion'].includes(id) ? 'number' : 'scalar';
}

function editorForVariantField(id) {
    if (id === 'parameters') return 'parameter-map';
    if (id === 'variants') return 'variant-map';
    if (['taskTypes'].includes(id)) return 'string-list';
    if (['authentication', 'responsePath', 'fixedParams', 'videoMeta', 'asyncTask', 'referenceImage', 'urlTemplates'].includes(id)) return 'object';
    return ['schemaVersion'].includes(id) ? 'number' : 'scalar';
}

function editorForParameterField(id) {
    if (['options', 'taskTypes'].includes(id)) return 'collection';
    if (['defaultValue'].includes(id)) return 'value';
    return ['min', 'max', 'step', 'minLength', 'maxLength', 'rows', 'portCount'].includes(id) ? 'number' : 'scalar';
}

export const DECLARATIVE_PROTOCOL_SCHEMA = Object.freeze({
    schemaVersion: DECLARATIVE_PROTOCOL_SCHEMA_VERSION,
    sections: Object.freeze({
        protocol: FIELD_DESCRIPTORS.protocol,
        variant: FIELD_DESCRIPTORS.variant,
        parameter: FIELD_DESCRIPTORS.parameter
    }),
    merge: Object.freeze({
        objects: 'recursive',
        arrays: 'replace',
        null: 'clear',
        unknownFields: 'preserve-read-only'
    })
});

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function cloneDeclarativeProtocolValue(value) {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(cloneDeclarativeProtocolValue);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneDeclarativeProtocolValue(item)]));
}

/**
 * Merge one protocol overlay onto another without mutating either source.
 * Unknown fields intentionally follow the same recursive rules as known
 * fields, so importing a future declaration never drops information.
 */
export function mergeDeclarativeProtocol(base = {}, overlay = {}) {
    if (overlay === null) return null;
    if (!isPlainObject(base) || !isPlainObject(overlay)) return cloneDeclarativeProtocolValue(overlay);

    const merged = cloneDeclarativeProtocolValue(base);
    Object.entries(overlay).forEach(([key, value]) => {
        if (value === undefined) return;
        if (value === null) {
            merged[key] = null;
        } else if (isPlainObject(value) && isPlainObject(base[key])) {
            merged[key] = mergeDeclarativeProtocol(base[key], value);
        } else {
            // Arrays, scalars, and objects replacing a non-object use the
            // overlay as a complete value.  Arrays never concatenate.
            merged[key] = cloneDeclarativeProtocolValue(value);
        }
    });
    return merged;
}

export function normalizeDeclarativeProtocolConfiguration(rawProtocol = {}) {
    const protocol = isPlainObject(rawProtocol)
        ? cloneDeclarativeProtocolValue(rawProtocol)
        : {};
    protocol.schemaVersion = Number(protocol.schemaVersion || DECLARATIVE_PROTOCOL_SCHEMA_VERSION);
    if (!isPlainObject(protocol.parameters)) protocol.parameters = {};
    if (!isPlainObject(protocol.variants)) protocol.variants = {};
    return protocol;
}

function findVariant(protocol, modelId = '') {
    const variants = isPlainObject(protocol?.variants) ? protocol.variants : {};
    const requested = String(modelId || '').trim();
    if (Object.hasOwn(variants, requested)) return { variantId: requested, variant: variants[requested] };
    if (protocol?.variantIdCaseInsensitive !== true || !requested) return { variantId: requested, variant: null };
    const normalized = requested.toLowerCase();
    const variantId = Object.keys(variants).find((candidate) => candidate.toLowerCase() === normalized) || '';
    return { variantId: variantId || requested, variant: variantId ? variants[variantId] : null };
}

/**
 * Return the selected variant and its fully inherited configuration.  The
 * original protocol and variant remain available for callers that need to
 * preserve declaration identity; `configuration` is the execution/editor
 * view with recursively merged parameters and nested rules.
 */
export function resolveDeclarativeProtocolVariant(protocol = {}, modelId = '') {
    const normalized = normalizeDeclarativeProtocolConfiguration(protocol);
    const { variantId, variant } = findVariant(normalized, modelId);
    if (!variant) {
        return { variantId, variant: null, configuration: normalized, matched: false };
    }
    const configuration = mergeDeclarativeProtocol(normalized, variant);
    configuration.variantId = variantId;
    // A selected variant must not recursively carry the full variant map into
    // a request definition; it is metadata on the parent declaration only.
    configuration.variants = normalized.variants;
    return {
        variantId,
        variant: cloneDeclarativeProtocolValue(variant),
        configuration,
        matched: true
    };
}

export function getEffectiveProtocolParameters(protocol = {}, modelId = '') {
    return resolveDeclarativeProtocolVariant(protocol, modelId).configuration.parameters || {};
}

function knownFieldsFor(section) {
    const descriptors = FIELD_DESCRIPTORS[section] || [];
    return new Set(descriptors.map(({ id }) => id));
}

export function getUnknownDeclarativeFields(value = {}, section = 'protocol') {
    if (!isPlainObject(value)) return {};
    const known = knownFieldsFor(section);
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !known.has(key))
        .map(([key, item]) => [key, cloneDeclarativeProtocolValue(item)]));
}

/**
 * Build the generated editor contract.  Known fields have one structured
 * editing descriptor; unknown fields are returned separately and marked
 * read-only so a round-trip can preserve them without pretending the editor
 * understands their semantics.
 */
export function getDeclarativeProtocolEditorContract(protocol = {}) {
    const normalized = normalizeDeclarativeProtocolConfiguration(protocol);
    const variantEntries = Object.entries(normalized.variants || {}).map(([variantId, variant]) => ({
        id: variantId,
        fields: FIELD_DESCRIPTORS.variant,
        unknownFields: getUnknownDeclarativeFields(variant, 'variant'),
        parameters: Object.fromEntries(Object.entries(variant?.parameters || {}).map(([paramId, param]) => [paramId, {
            id: paramId,
            fields: FIELD_DESCRIPTORS.parameter,
            unknownFields: getUnknownDeclarativeFields(param, 'parameter')
        }]))
    }));
    return {
        schemaVersion: DECLARATIVE_PROTOCOL_SCHEMA_VERSION,
        fields: FIELD_DESCRIPTORS.protocol,
        parameters: Object.fromEntries(Object.entries(normalized.parameters || {}).map(([paramId, param]) => [paramId, {
            id: paramId,
            fields: FIELD_DESCRIPTORS.parameter,
            unknownFields: getUnknownDeclarativeFields(param, 'parameter')
        }])),
        variants: variantEntries,
        unknownFields: {
            protocol: getUnknownDeclarativeFields(normalized, 'protocol'),
            readOnly: true
        },
        merge: DECLARATIVE_PROTOCOL_SCHEMA.merge
    };
}
