const PROMPT_AGENT_PARAMETER_CONTROLS = {
    aspectRatio: 'aspect',
    resolution: 'resolution',
    customWidth: 'custom-resolution-width',
    customHeight: 'custom-resolution-height',
    quality: 'quality',
    moderation: 'moderation',
    background: 'background',
    search: 'search',
    count: 'generation-count'
};

const PARAMETER_TYPES = {
    aspectRatio: 'string', resolution: 'string', customWidth: 'integer', customHeight: 'integer',
    quality: 'string', moderation: 'string', background: 'string', search: 'boolean', count: 'integer'
};

function readControlSchema(control, type) {
    const schema = { type: control.type === 'checkbox' ? 'boolean' : (control.type === 'number' ? 'number' : type) };
    if (type === 'integer') schema.type = type;
    if (control.options) schema.enum = Array.from(control.options).filter((option) => !option.disabled).map((option) => option.value);
    for (const [attribute, key] of [['min', 'minimum'], ['max', 'maximum']]) {
        if (control[attribute] !== undefined && control[attribute] !== '' && Number.isFinite(Number(control[attribute]))) {
            schema[key] = Number(control[attribute]);
        }
    }
    if (type === 'integer' && schema.minimum === undefined) schema.minimum = 1;
    return schema;
}

export function readPromptAgentParameterSchema(documentRef, nodeId) {
    const schema = {};
    for (const [key, suffix] of Object.entries(PROMPT_AGENT_PARAMETER_CONTROLS)) {
        const control = documentRef.getElementById(`${nodeId}-${suffix}`);
        if (!control || control.type === 'hidden' || control.hidden) continue;
        // Custom dimensions and aspect can be enabled by a resolution change.
        const conditionalSize = ['customWidth', 'customHeight', 'aspectRatio'].includes(key);
        if (!conditionalSize && (control.disabled || control.closest?.('[hidden], .hidden'))) continue;
        schema[key] = readControlSchema(control, PARAMETER_TYPES[key]);
    }
    if (schema.resolution?.enum && !schema.resolution.enum.includes('custom')) {
        delete schema.customWidth;
        delete schema.customHeight;
    }
    const prefix = `${nodeId}-param-`;
    const protocolProperties = {};
    const nodeElement = documentRef.getElementById(nodeId);
    for (const control of nodeElement?.querySelectorAll?.('input[id], select[id], textarea[id]') || []) {
        if (!control.id.startsWith(prefix) || control.type === 'hidden' || control.hidden
            || control.disabled || control.closest?.('[hidden], .hidden')) continue;
        const key = control.id.slice(prefix.length);
        if (key === 'negative_prompt' || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
        protocolProperties[key] = readControlSchema(control, 'string');
    }
    if (Object.keys(protocolProperties).length) schema.protocolParams = { type: 'object', properties: protocolProperties };
    return schema;
}

function normalizeValue(value, schema, key) {
    if (schema.type === 'object') return normalizeObject(value, schema.properties || {}, key);
    let normalized = value;
    if (schema.type === 'number' || schema.type === 'integer') {
        if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') throw new Error(`参数 ${key} 必须是数字`);
        normalized = Number(value);
        if (!Number.isFinite(normalized) || (schema.type === 'integer' && !Number.isInteger(normalized))
            || (schema.minimum !== undefined && normalized < schema.minimum)
            || (schema.maximum !== undefined && normalized > schema.maximum)) {
            throw new Error(`参数 ${key} 超出当前节点支持的范围`);
        }
    } else if (typeof value !== schema.type) {
        throw new Error(`参数 ${key} 的类型不正确`);
    }
    if (schema.enum && !schema.enum.includes(normalized)) throw new Error(`参数 ${key} 的值不受当前节点支持`);
    return normalized;
}

function normalizeObject(parameters, schema, prefix = '') {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('生成参数必须是对象');
    return Object.fromEntries(Object.entries(parameters).map(([key, value]) => {
        const name = prefix ? `${prefix}.${key}` : key;
        if (!Object.hasOwn(schema, key)) throw new Error(`当前节点不支持参数 ${{ aspectRatio: '比例', aspect: '比例', resolution: '分辨率', customWidth: '宽度', customHeight: '高度' }[name] || name}`);
        return [key, normalizeValue(value, schema[key], name)];
    }));
}

export function normalizePromptAgentParameters(parameters = {}, schema) {
    const fallback = Object.fromEntries(Object.entries(PARAMETER_TYPES).map(([key, type]) => [
        key, { type, ...(type === 'integer' ? { minimum: 1 } : {}) }
    ]));
    if (parameters && Object.hasOwn(parameters, 'aspect')) {
        if (Object.hasOwn(parameters, 'aspectRatio') && parameters.aspectRatio !== parameters.aspect) throw new Error('方案中的比例设置冲突，请明确需要的比例。');
        const { aspect, ...rest } = parameters;
        parameters = { ...rest, aspectRatio: aspect };
    }
    return normalizeObject(parameters, schema ?? fallback);
}
