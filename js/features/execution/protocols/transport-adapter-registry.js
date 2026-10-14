/**
 * Declarative transport adapter registry.
 *
 * Protocol documents refer to an adapter by a stable id and a major version.
 * The registry is deliberately small: adding an adapter is a code change, so
 * a saved protocol can never silently acquire a different wire format.
 */

export const TRANSPORT_ADAPTER_SCHEMA_VERSION = 1;

const ADAPTERS = new Map([
    ['json', Object.freeze({
        adapterId: 'json',
        version: 1,
        encoding: 'json',
        capabilities: Object.freeze({
            fieldSources: Object.freeze(['parameter', 'literal']),
            media: false,
            authLocations: Object.freeze(['header', 'query', 'body']),
            fieldSchema: Object.freeze({
                parameter: Object.freeze(['name', 'source', 'path', 'kind', 'required']),
                literal: Object.freeze(['name', 'source', 'value', 'kind', 'required'])
            }),
            compatibleEncodings: Object.freeze(['json'])
        })
    })],
    ['multipart', Object.freeze({
        adapterId: 'multipart',
        version: 1,
        encoding: 'multipart',
        capabilities: Object.freeze({
            fieldSources: Object.freeze(['parameter', 'media', 'literal']),
            media: true,
            authLocations: Object.freeze(['header', 'query']),
            fieldSchema: Object.freeze({
                parameter: Object.freeze(['name', 'source', 'path', 'kind', 'repeat', 'mime', 'required']),
                media: Object.freeze(['name', 'source', 'path', 'kind', 'repeat', 'mime', 'required']),
                literal: Object.freeze(['name', 'source', 'value', 'kind', 'required'])
            }),
            compatibleEncodings: Object.freeze(['multipart'])
        })
    })]
]);

const ADAPTER_CONFIG_KEYS = new Set(['adapterId', 'version', 'parts']);
const PART_KEYS = new Set(['name', 'source', 'path', 'kind', 'repeat', 'mime', 'required', 'value']);
const SOURCES = new Set(['parameter', 'media', 'literal']);
const KINDS = new Set(['text', 'url', 'file']);

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
}

/** Return an adapter definition or null for an unknown adapter id. */
export function getTransportAdapter(adapterId = '') {
    return ADAPTERS.get(String(adapterId || '').trim()) || null;
}

export function getTransportAdapters() {
    return [...ADAPTERS.values()].map(clone);
}

/**
 * Resolve a protocol/variant declaration. Legacy requestEncoding values map
 * to the matching built-in adapter and therefore remain backwards compatible.
 */
export function resolveTransportAdapter(protocol = {}, variant = {}) {
    const declared = firstDefined(variant.transportAdapter, protocol.transportAdapter);
    const requestedEncoding = firstDefined(variant.requestEncoding, protocol.requestEncoding);
    if (declared === undefined && requestedEncoding !== undefined && !['json', 'multipart'].includes(requestedEncoding)) {
        return {
            adapterId: String(requestedEncoding), version: 1, encoding: String(requestedEncoding), unsupported: true,
            reason: `requestEncoding “${requestedEncoding}” 不受支持；当前仅支持 json 或 multipart。`
        };
    }
    const adapterId = typeof declared === 'string'
        ? declared
        : declared?.adapterId || (requestedEncoding || 'json');
    const adapter = getTransportAdapter(adapterId);
    if (!adapter) {
        return {
            adapterId: String(adapterId || ''),
            version: Number(declared?.version || 1),
            encoding: String(firstDefined(variant.requestEncoding, protocol.requestEncoding) || ''),
            unsupported: true,
            reason: `不支持 Transport adapter “${adapterId}”，请切换到已注册的适配器。`
        };
    }
    const version = Number(typeof declared === 'object' ? (declared.version || adapter.version) : adapter.version);
    if (!Number.isInteger(version) || version < 1) {
        return { ...clone(adapter), version, unsupported: true, reason: `Transport adapter “${adapter.adapterId}” 的版本无效。` };
    }
    if (version > adapter.version) {
        return {
            ...clone(adapter), version, unsupported: true,
            reason: `Transport adapter “${adapter.adapterId}” 需要版本 ${version}，当前仅支持版本 ${adapter.version}；此协议只能只读保留。`
        };
    }
    if (declared !== undefined) {
        const declaredRequestEncoding = firstDefined(variant.requestEncoding, protocol.requestEncoding);
        const declaredImageEncoding = firstDefined(
            variant.requestEncodingWhenReferenceImages,
            protocol.requestEncodingWhenReferenceImages
        );
        for (const [field, encoding] of [
            ['requestEncoding', declaredRequestEncoding],
            ['requestEncodingWhenReferenceImages', declaredImageEncoding]
        ]) {
            if (encoding !== undefined && encoding !== '' && encoding !== adapter.encoding) {
                return {
                    ...clone(adapter),
                    version,
                    unsupported: true,
                    reason: `Transport adapter “${adapter.adapterId}” 与 ${field} “${encoding}” 冲突；请只保留一致的编码声明。`
                };
            }
        }
    }
    return { ...clone(adapter), version, config: typeof declared === 'object' ? clone(declared) : {} };
}

function getAtPath(value, path = '') {
    if (!path) return value;
    return String(path).split('.').filter(Boolean).reduce(
        (current, key) => current === null || current === undefined ? undefined : current[key], value
    );
}

/** Validate adapter config and throw a user-facing explanation for unsupported values. */
export function validateTransportAdapterConfiguration(protocol = {}, variant = {}) {
    const adapter = resolveTransportAdapter(protocol, variant);
    if (adapter.unsupported) throw new Error(adapter.reason);
    const declaration = firstDefined(variant.transportAdapter, protocol.transportAdapter);
    if (declaration === undefined || typeof declaration === 'string') return adapter;

    for (const key of Object.keys(declaration)) {
        if (!ADAPTER_CONFIG_KEYS.has(key)) {
            throw new Error(`Transport adapter “${adapter.adapterId}” 不支持字段 “${key}”，请移除后再保存。`);
        }
    }
    if (declaration.parts !== undefined) {
        if (adapter.adapterId !== 'multipart') throw new Error(`Transport adapter “${adapter.adapterId}” 不支持 multipart parts。`);
        if (!Array.isArray(declaration.parts)) throw new Error('multipart adapter 的 parts 必须是数组。');
        declaration.parts.forEach((part, index) => {
            if (!part || typeof part !== 'object') throw new Error(`multipart parts[${index}] 必须是对象。`);
            for (const key of Object.keys(part)) {
                if (!PART_KEYS.has(key)) throw new Error(`multipart parts[${index}] 不支持字段 “${key}”。`);
            }
            if (!String(part.name || '').trim()) throw new Error(`multipart parts[${index}] 缺少 name。`);
            if (!SOURCES.has(part.source)) throw new Error(`multipart parts[${index}] 的 source 不受支持。`);
            if (!KINDS.has(part.kind || 'text')) throw new Error(`multipart parts[${index}] 的 kind 不受支持。`);
            if (part.source !== 'literal' && !String(part.path || '').trim()) {
                throw new Error(`multipart parts[${index}] 需要 path。`);
            }
            if (part.source === 'literal' && part.value === undefined) {
                throw new Error(`multipart parts[${index}] 的 literal 需要 value。`);
            }
        });
    }
    return adapter;
}

/** Resolve an ordered multipart declaration into [name, value] pairs. */
export function resolveMultipartParts(parts = [], { parameters = {}, inputs = {} } = {}) {
    const fields = [];
    for (const part of parts) {
        const sourceValue = part.source === 'literal'
            ? part.value
            : getAtPath(part.source === 'media' ? inputs : parameters, part.path);
        const values = Array.isArray(sourceValue) && part.repeat !== false ? sourceValue : [sourceValue];
        for (const value of values) {
            if (value === undefined || value === null || value === '') {
                if (part.required) throw new Error(`multipart 字段 “${part.name}” 缺少必填值。`);
                continue;
            }
            fields.push([part.name, value]);
        }
    }
    return fields;
}
