/**
 * Compiles a declarative video protocol into a provider-neutral execution plan.
 * Callers only consume this plan; provider-specific encoding remains in adapters.
 */

export const VIDEO_PROTOCOL_SCHEMA_VERSION = 1;

const SECRET_HEADER_NAMES = new Set([
    'authorization', 'apikey', 'api-key', 'api_key', 'x-api-key', 'tt-api-key'
]);

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function getPath(value, path = '') {
    if (!path) return value;
    return path.split(/\.|\[|\]/).filter(Boolean).reduce(
        (current, key) => (current === null || current === undefined ? undefined : current[key]),
        value
    );
}

function normalizeEndpoint(endpoint = '') {
    return String(endpoint || '').replace(/\/+$/, '');
}

function buildUrl(endpoint, pathTemplate, variables = {}) {
    const template = String(pathTemplate || '');
    if (!template) throw new Error('协议变体未配置请求路径');
    const path = template.replace(/\{\{(\w+)\}\}/g, (_, key) => (
        variables[key] === undefined || variables[key] === null ? '' : encodeURIComponent(String(variables[key]))
    ));
    if (/^https?:\/\//i.test(path)) return path;
    return `${normalizeEndpoint(endpoint)}${path.startsWith('/') ? path : `/${path}`}`;
}

function buildAuthenticationHeaders(authentication = {}, apiKey = '') {
    if (!apiKey || !authentication || authentication.location === 'query' || authentication.location === 'body') return {};
    const field = String(authentication.field || 'Authorization').trim();
    if (!field) return {};
    const template = String(authentication.template || '{apikey}');
    return { [field]: template.replaceAll('{apikey}', apiKey) };
}

function getAuthenticationValue(authentication = {}, apiKey = '') {
    return String(authentication.template || '{apikey}').replaceAll('{apikey}', apiKey);
}

function applyAuthentication({ url, body, authentication, apiKey }) {
    if (!apiKey || !authentication) return { url, body };
    const location = authentication.location || 'header';
    if (location === 'query') {
        const parsed = new URL(url);
        parsed.searchParams.set(authentication.field || 'key', getAuthenticationValue(authentication, apiKey));
        return { url: parsed.toString(), body };
    }
    if (location === 'body') {
        return {
            url,
            body: { ...body, [authentication.field || 'api_key']: getAuthenticationValue(authentication, apiKey) }
        };
    }
    return { url, body };
}

function getAuthenticationRule(protocol = {}, variant = {}) {
    const normalize = (rule) => ({ ...rule, location: rule.location || 'header' });
    if (variant.authentication) return normalize(variant.authentication);
    if (protocol.authentication) return normalize(protocol.authentication);
    const fieldTemplate = String(protocol.apikeyField || 'Authorization');
    const [field = 'Authorization', ...valueParts] = fieldTemplate.split(':');
    return {
        location: protocol.apikeyLocation || 'header',
        field: field.trim(),
        template: valueParts.length ? valueParts.join(':').trim() : '{apikey}'
    };
}

function validateParameter(paramId, definition = {}, value) {
    if (definition.required && (value === undefined || value === null || value === '')) {
        throw new Error(`缺少必填参数 “${paramId}”`);
    }
    if (value === undefined || value === null || value === '') return;
    const numeric = Number(value);
    if (definition.min !== undefined && (!Number.isFinite(numeric) || numeric < Number(definition.min))) {
        throw new Error(`参数 “${paramId}” 必须不小于 ${definition.min}`);
    }
    if (definition.max !== undefined && (!Number.isFinite(numeric) || numeric > Number(definition.max))) {
        throw new Error(`参数 “${paramId}” 必须不大于 ${definition.max}`);
    }
    if (Array.isArray(definition.options) && definition.options.length > 0) {
        const allowed = definition.options.map((option) => typeof option === 'object' ? option.value : option);
        if (!allowed.includes(value)) throw new Error(`参数 “${paramId}” 不支持值 “${value}”`);
    }
}

function convertValue(value, definition = {}) {
    if (definition.type === 'number' || definition.dataType === 'number') return Number(value);
    if (definition.type === 'boolean' || definition.dataType === 'boolean') return value === true || value === 'true';
    return value;
}

function normalizeImages(inputs = {}) {
    return Object.entries(inputs)
        .filter(([key]) => key === 'image' || key === 'referenceImages' || /^image_\d+$/.test(key))
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .flatMap(([, value]) => Array.isArray(value) ? value : [value])
        .filter((value) => typeof value === 'string' && value.trim());
}

function compileMediaFields(variant = {}, inputs = {}) {
    const images = normalizeImages(inputs);
    const rule = variant.referenceImage;
    if (!rule) {
        if (images.length > 0) throw new Error('当前模型变体不支持参考图输入，请移除不活动连接后重试。');
        return { images, fields: [] };
    }
    const maxCount = rule.maxCount ?? variant.parameters?.referenceImages?.portCount;
    if (Number.isFinite(maxCount) && images.length > maxCount) {
        throw new Error(`此模型最多支持 ${maxCount} 张参考图，当前连接了 ${images.length} 张`);
    }
    if (rule.required === true && images.length === 0) throw new Error('此模型必须连接参考图');
    if (images.length === 0) return { images, fields: [] };
    const field = String(rule.field || 'referenceImages');
    if (rule.mode === 'single-string') return { images, fields: [[field, images[0]]] };
    return { images, fields: images.map((image) => [field, image]) };
}

export function migrateProtocolConfiguration(rawProtocol = {}) {
    const protocol = clone(rawProtocol) || {};
    const version = Number(protocol.schemaVersion || 0);
    if (version > VIDEO_PROTOCOL_SCHEMA_VERSION) {
        return {
            ...protocol,
            readOnly: true,
            executionBlockedReason: '此协议由更新版本的 CainFlow 创建，当前版本只能只读保留。'
        };
    }
    return {
        ...protocol,
        schemaVersion: VIDEO_PROTOCOL_SCHEMA_VERSION,
        variants: protocol.variants && typeof protocol.variants === 'object' ? protocol.variants : {},
        readOnly: false
    };
}

export function validateVideoProtocolConfiguration(rawProtocol = {}) {
    const protocol = migrateProtocolConfiguration(rawProtocol);
    if (protocol.readOnly) return true;
    if (!protocol.id || !Array.isArray(protocol.taskTypes) || !protocol.taskTypes.includes('video')) {
        throw new Error('视频协议必须声明 id 和 video taskType');
    }
    const variants = Object.entries(protocol.variants || {});
    if (variants.length === 0) throw new Error('声明式视频协议必须配置至少一个精确模型变体');
    for (const [modelId, variant] of variants) {
        const prefix = `变体 “${modelId}”`;
        const encoding = variant.requestEncoding || protocol.requestEncoding || 'json';
        if (!['json', 'multipart'].includes(encoding)) throw new Error(`${prefix} 的 requestEncoding 仅支持 json 或 multipart`);
        if (variant.requestEncodingWhenReferenceImages
            && !['json', 'multipart'].includes(variant.requestEncodingWhenReferenceImages)) {
            throw new Error(`${prefix} 的 requestEncodingWhenReferenceImages 仅支持 json 或 multipart`);
        }
        if (!(variant.createPath || protocol.createPath)) throw new Error(`${prefix} 缺少 createPath`);
        if (!(variant.queryPath || protocol.queryPath)) throw new Error(`${prefix} 缺少 queryPath`);
        const asyncTask = variant.asyncTask || protocol.asyncTask || {};
        for (const field of ['taskIdPath', 'statusPath', 'resultPath']) {
            if (!String(asyncTask[field] || '').trim()) throw new Error(`${prefix} 的 asyncTask 缺少 ${field}`);
        }
        if (!Array.isArray(asyncTask.completedStatuses) || asyncTask.completedStatuses.length === 0) {
            throw new Error(`${prefix} 的 asyncTask 缺少 completedStatuses`);
        }
        for (const statusField of ['failedStatuses', 'cancelledStatuses']) {
            if (asyncTask[statusField] !== undefined && !Array.isArray(asyncTask[statusField])) {
                throw new Error(`${prefix} 的 asyncTask.${statusField} 必须是数组`);
            }
        }
        const authentication = getAuthenticationRule(protocol, variant);
        if (!['header', 'query'].includes(authentication.location)) {
            throw new Error(`${prefix} 的 authentication.location 仅支持 header 或 query`);
        }
        if (!String(authentication.field || '').trim()) throw new Error(`${prefix} 的 authentication 缺少 field`);
        const template = String(authentication.template || '{apikey}');
        if (!template.includes('{apikey}')) throw new Error(`${prefix} 的 authentication.template 必须使用 {apikey} 占位符`);
        if (variant.referenceImage) {
            if (!['repeat-field', 'single-string'].includes(variant.referenceImage.mode)) {
                throw new Error(`${prefix} 的 referenceImage mode 不受支持`);
            }
            if (!String(variant.referenceImage.field || '').trim()) throw new Error(`${prefix} 的 referenceImage 缺少 field`);
        }
        const definitions = { ...(protocol.parameters || {}), ...(variant.parameters || {}) };
        for (const [paramId, definition] of Object.entries(definitions)) {
            if (!definition || typeof definition !== 'object') throw new Error(`${prefix} 的参数 “${paramId}” 定义无效`);
            if (definition.options !== undefined && !Array.isArray(definition.options)) {
                throw new Error(`${prefix} 的参数 “${paramId}” options 必须是数组`);
            }
            if (definition.min !== undefined && definition.max !== undefined && Number(definition.min) > Number(definition.max)) {
                throw new Error(`${prefix} 的参数 “${paramId}” min 不能大于 max`);
            }
        }
    }
    return true;
}

export function importVideoProtocolConfiguration(json) {
    let parsed;
    try {
        parsed = typeof json === 'string' ? JSON.parse(json) : clone(json);
    } catch (error) {
        throw new Error(`协议 JSON 无法解析：${error.message}`);
    }
    const migrated = migrateProtocolConfiguration(parsed);
    if (!migrated.readOnly) validateVideoProtocolConfiguration(migrated);
    return migrated;
}

export function compileVideoProtocol({ protocol: rawProtocol, endpoint, modelId, parameters = {}, inputs = {}, apiKey = '' } = {}) {
    const protocol = migrateProtocolConfiguration(rawProtocol);
    if (protocol.readOnly) throw new Error(protocol.executionBlockedReason);
    const variant = protocol.variants?.[modelId];
    if (!variant) throw new Error(`协议 “${protocol.label || protocol.id || '当前协议'}” 未配置模型 “${modelId}” 的变体`);

    const definitions = { ...(protocol.parameters || {}), ...(variant.parameters || {}) };
    const requestBody = { model: modelId };
    Object.entries(definitions).forEach(([paramId, definition]) => {
        if (definition.portOnly === true || paramId === 'referenceImages') return;
        const value = parameters[paramId] === undefined ? definition.defaultValue : parameters[paramId];
        validateParameter(paramId, definition, value);
        if (value === undefined || value === null || value === '') return;
        requestBody[definition.requestField || paramId] = convertValue(value, definition);
    });

    const media = compileMediaFields(variant, inputs);
    const encoding = (media.images.length > 0 && variant.requestEncodingWhenReferenceImages)
        || variant.requestEncoding || protocol.requestEncoding || 'json';
    if (encoding === 'json') {
        media.fields.forEach(([field, value]) => {
            if (Object.hasOwn(requestBody, field)) {
                throw new Error(`JSON 协议不能重复发送字段 “${field}”`);
            }
            requestBody[field] = value;
        });
    }
    const authentication = getAuthenticationRule(protocol, variant);
    if (authentication.location === 'body' && apiKey) {
        throw new Error('异步视频协议暂不支持将 API Key 放在请求体中；请使用请求头或查询参数。');
    }
    const authenticatedCreate = applyAuthentication({
        url: buildUrl(endpoint, variant.createPath || protocol.createPath, { modelId }),
        body: requestBody,
        authentication,
        apiKey
    });
    const headers = buildAuthenticationHeaders(authentication, apiKey);
    if (encoding === 'json') headers['Content-Type'] = 'application/json';
    const asyncTask = variant.asyncTask || protocol.asyncTask || {};
    return {
        protocolId: protocol.id,
        schemaVersion: protocol.schemaVersion,
        variantId: modelId,
        authentication: clone(authentication),
        create: {
            method: 'POST',
            url: authenticatedCreate.url,
            encoding,
            headers,
            body: authenticatedCreate.body,
            fields: encoding === 'multipart' ? [...Object.entries(authenticatedCreate.body), ...media.fields] : []
        },
        asyncTask: clone(asyncTask),
        queryUrl(taskId) {
            const queryUrl = buildUrl(endpoint, variant.queryPath || protocol.queryPath, { taskId, modelId });
            return applyAuthentication({ url: queryUrl, body: {}, authentication, apiKey }).url;
        },
        parseTaskId(response) {
            return String(getPath(response, asyncTask.taskIdPath || 'id') || '').trim();
        },
        parseStatus(response) {
            return String(getPath(response, asyncTask.statusPath || 'status') || '').trim().toLowerCase();
        },
        parseResultUrl(response) {
            return String(getPath(response, asyncTask.resultPath || 'video_url') || '').trim();
        }
    };
}

export function redactProtocolPreview(request = {}, authentication = {}) {
    const authenticationHeader = (authentication.location || 'header') === 'header'
        ? String(authentication.field || '').toLowerCase()
        : '';
    const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([key, value]) => [
        key,
        (SECRET_HEADER_NAMES.has(key.toLowerCase()) || key.toLowerCase() === authenticationHeader) ? '<REDACTED>' : value
    ]));
    const redactUrl = (value) => {
        if (!value || authentication.location !== 'query' || !authentication.field) return value;
        try {
            const url = new URL(value);
            if (url.searchParams.has(authentication.field)) url.searchParams.set(authentication.field, '<REDACTED>');
            return url.toString();
        } catch {
            return value;
        }
    };
    return {
        ...clone(request),
        headers,
        url: redactUrl(request.url),
        query_url_template: redactUrl(request.query_url_template)
    };
}
