/**
 * Built-in protocol override records.
 *
 * A built-in protocol is the immutable baseline shipped with CainFlow. User
 * changes are kept in an independent record and resolved only at runtime. The
 * helpers in this module deliberately stay free of registry or DOM concerns so
 * import/export and execution snapshot tests can exercise the contract alone.
 */

export const PROTOCOL_OVERRIDE_FORMAT_VERSION = 1;

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
    if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function digest(value) {
    let hash = 2166136261;
    for (const character of stableValue(value)) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Recursively merge object fields while treating arrays as user-owned values. */
export function mergeProtocolConfiguration(base = {}, override = {}) {
    if (override === undefined) return clone(base);
    if (override === null || typeof override !== 'object' || Array.isArray(override)) return clone(override);
    if (base === null || typeof base !== 'object' || Array.isArray(base)) return clone(override);
    const result = clone(base) || {};
    Object.entries(override).forEach(([key, value]) => {
        result[key] = value && typeof value === 'object' && !Array.isArray(value)
            && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
            ? mergeProtocolConfiguration(result[key], value)
            : clone(value);
    });
    return result;
}

export function normalizeProtocolOverrideRecord(raw = {}, fallbackProtocolId = '') {
    const source = raw && typeof raw === 'object' ? raw : {};
    const protocolId = String(source.protocolId || source.id || fallbackProtocolId || '').trim();
    const config = source.config && typeof source.config === 'object'
        ? source.config
        : (source.override && typeof source.override === 'object' ? source.override : source);
    const baseSchemaVersion = Number(source.baseSchemaVersion ?? source.baseVersion ?? 1);
    const revision = Number(source.revision || source.updatedAt || 0) || 0;
    return {
        formatVersion: Number(source.formatVersion || PROTOCOL_OVERRIDE_FORMAT_VERSION),
        protocolId,
        baseSchemaVersion: Number.isFinite(baseSchemaVersion) ? baseSchemaVersion : 1,
        baseRevision: String(source.baseRevision || ''),
        revision,
        config: clone(config) || {},
        importedAt: source.importedAt ? String(source.importedAt) : '',
        source: source.source ? String(source.source) : 'user'
    };
}

export function createProtocolOverrideRecord({
    protocolId,
    baseProtocol = {},
    config = {},
    baseRevision = '',
    revision = Date.now(),
    importedAt = new Date().toISOString(),
    source = 'user'
} = {}) {
    const normalizedId = String(protocolId || config.id || baseProtocol.id || '').trim();
    return normalizeProtocolOverrideRecord({
        formatVersion: PROTOCOL_OVERRIDE_FORMAT_VERSION,
        protocolId: normalizedId,
        baseSchemaVersion: Number(baseProtocol.schemaVersion || 1),
        baseRevision: baseRevision || baseProtocol.baseRevision || digest(baseProtocol),
        revision,
        config: { ...clone(config), id: normalizedId },
        importedAt,
        source
    }, normalizedId);
}

/**
 * Resolve a baseline and an override record. A record tied to a newer unknown
 * baseline is preserved but cannot be edited or executed on this version.
 */
export function applyProtocolOverride(baseProtocol = {}, rawRecord = null) {
    const base = clone(baseProtocol) || {};
    const currentSchemaVersion = Number(base.schemaVersion || 1);
    const baselineMetadata = {
        baseSchemaVersion: currentSchemaVersion,
        baseRevision: String(base.baseRevision || digest(base))
    };
    if (!rawRecord) return { ...base, ...baselineMetadata };
    const record = normalizeProtocolOverrideRecord(rawRecord, base.id);
    const unknownBaseline = (
        record.protocolId && record.protocolId !== base.id
    ) || record.baseSchemaVersion > currentSchemaVersion
        || (record.baseRevision && baselineMetadata.baseRevision
            && record.baseRevision !== baselineMetadata.baseRevision);
    if (unknownBaseline) {
        const reason = record.baseSchemaVersion > currentSchemaVersion
            ? '此协议覆盖记录依赖更新版本的内置基线，当前版本只能只读保留。'
            : '此协议覆盖记录依赖不兼容的内置基线，当前版本只能只读保留。';
        return {
            ...base,
            id: base.id,
            readOnly: true,
            executionBlockedReason: reason,
            overrideRevision: record.revision,
            baseSchemaVersion: record.baseSchemaVersion,
            baseRevision: record.baseRevision || baselineMetadata.baseRevision,
            overrideRecord: record
        };
    }
    const merged = mergeProtocolConfiguration(base, record.config);
    return {
        ...merged,
        id: base.id,
        readOnly: false,
        overrideRevision: record.revision,
        baseSchemaVersion: currentSchemaVersion,
        baseRevision: record.baseRevision || baselineMetadata.baseRevision,
        overrideRecord: record
    };
}

export function createProtocolExecutionSnapshot(protocol = {}, metadata = {}) {
    const source = clone(protocol) || {};
    const snapshot = {
        ...source,
        executionSnapshot: {
            protocolId: source.id || '',
            schemaVersion: Number(source.schemaVersion || 1),
            baseSchemaVersion: Number(source.baseSchemaVersion || source.schemaVersion || 1),
            baseRevision: String(source.baseRevision || ''),
            overrideRevision: Number(source.overrideRevision || 0),
            configDigest: digest(source),
            capturedAt: new Date().toISOString(),
            ...clone(metadata)
        }
    };
    return deepFreeze(snapshot);
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
}

export function createProtocolOverrideExport(protocol = {}, rawRecord = null) {
    const record = normalizeProtocolOverrideRecord(rawRecord || {
        protocolId: protocol.id,
        baseSchemaVersion: protocol.baseSchemaVersion || protocol.schemaVersion || 1,
        baseRevision: protocol.baseRevision || '',
        revision: protocol.overrideRevision || 0,
        config: protocol
    }, protocol.id);
    return {
        format: 'cainflow-protocol-override',
        formatVersion: PROTOCOL_OVERRIDE_FORMAT_VERSION,
        protocolId: record.protocolId || protocol.id || '',
        baseSchemaVersion: record.baseSchemaVersion,
        baseRevision: record.baseRevision,
        revision: record.revision,
        override: clone(record.config) || {},
        exportedAt: new Date().toISOString()
    };
}

export function parseProtocolOverrideImport(value) {
    let parsed;
    try {
        parsed = typeof value === 'string' ? JSON.parse(value) : clone(value);
    } catch (error) {
        throw new Error(`协议覆盖 JSON 无法解析：${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('协议覆盖必须是 JSON 对象');
    if (parsed.format === 'cainflow-protocol-override' || parsed.override) {
        const record = normalizeProtocolOverrideRecord({
            ...parsed,
            protocolId: parsed.protocolId || parsed.id,
            config: parsed.override || parsed.config
        });
        if (!record.protocolId) throw new Error('协议覆盖缺少 protocolId');
        return record;
    }
    if (!parsed.id) throw new Error('协议配置缺少 id');
    return createProtocolOverrideRecord({ protocolId: parsed.id, config: parsed });
}
