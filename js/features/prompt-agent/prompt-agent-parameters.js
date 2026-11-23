import { OPENAI_GIF_FRAME_FIELDS, supportsOpenAiOutputCompression } from '../../nodes/image-parameter-controls.js';

// Only parameter controls consumed by the corresponding generation request are public.
export const imageRequestProtocolFields = {
    openai: ['output_format', 'output_compression', ...OPENAI_GIF_FRAME_FIELDS, 'input_fidelity', 'style', 'response_format', 'complexity', 'edit_guide'],
    ttapi: ['image_search', 'thinking_level'],
    'ttapi-openai': ['output_format', 'output_compression']
};
export const publicImageProtocolFields = new Set(['systemPrompt', ...Object.values(imageRequestProtocolFields).flat()]);
export const openAiImageParameterFormats = {
    output_compression: ['jpeg', 'webp'],
    ...Object.fromEntries(OPENAI_GIF_FRAME_FIELDS.map(field => [field, ['gif']]))
};

export function supportsOpenAiTransparentFormat(format) {
    return !['jpeg', 'gif', 'svg'].includes(format);
}

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

const sizeParameterKeys = new Set(['aspect', 'aspectRatio', 'resolution', 'customWidth', 'customHeight']);
const parameterLabels = { count: '出图数量', quality: '画质', moderation: '审核设置', background: '背景', search: '联网搜索',
    output_format: '文件格式', output_compression: '压缩比例', frame_count: 'GIF 帧数', frame_duration_ms: 'GIF 每帧时长',
    input_fidelity: '参考图保真度', style: '风格', complexity: '复杂度', edit_guide: '编辑引导' };

export function mergeAgentSizeAnswer(previous, answer) {
    const next = { ...previous, ...answer };
    if (Object.hasOwn(answer, 'resolution') && answer.resolution !== 'custom'
        || Object.hasOwn(answer, 'aspectRatio') && next.resolution === 'custom') {
        if (next.resolution === 'custom') delete next.resolution;
        delete next.customWidth;
        delete next.customHeight;
    }
    if (answer.resolution === 'custom' && answer.customWidth && answer.customHeight) delete next.aspectRatio;
    return next;
}

function clarifyParameter(key, rule, field = key) {
    const label = parameterLabels[key] || key;
    const error = new Error(`当前生图模型无法使用所需的${label}，请选择替代设置。`);
    const alternatives = rule?.enum || (key === 'count' && rule?.maximum ? [rule.maximum] : []);
    error.parameterClarification = { field, choices: [
        ...alternatives.map(value => ({ value, label: key === 'count' ? `生成 ${value} 张` : String(value) })),
        { value: null, label: '使用模型默认' }
    ] };
    return error;
}

export function resolveAgentParameterPatch(parameters = {}, sources = {}, schema = {}, answers = {}, current = {}) {
    const result = {};
    const protocolSchema = schema.protocolParams?.properties;
    const compressionFormats = protocolSchema?.output_compression?.requiresOutputFormat;
    const proposedFormat = Object.hasOwn(answers, 'protocolParams.output_format')
        ? answers['protocolParams.output_format'] : parameters.protocolParams?.output_format;
    const effectiveFormat = proposedFormat ?? current.protocolParams?.output_format;
    const transparent = (Object.hasOwn(answers, 'background') ? answers.background : parameters.background ?? current.background) === 'transparent'
        && schema.background?.enum?.includes('transparent');
    for (const [key, proposal] of Object.entries({ ...parameters, ...answers })) {
        if (sizeParameterKeys.has(key) || proposal === null) continue;
        const rule = Object.hasOwn(schema, key) ? schema[key] : null;
        if (key === 'search' && proposal === false && !rule) continue;
        if (key.startsWith('protocolParams.')) continue;
        if (key === 'background' && transparent && compressionFormats && proposedFormat == null && !supportsOpenAiTransparentFormat(effectiveFormat)) {
            if (sources[key] === '本轮设置' || sources[key] === '沿用任务' || Object.hasOwn(answers, key)) {
                throw clarifyParameter(key, { enum: rule.enum.filter(value => value !== 'transparent') });
            }
            continue;
        }
        if (key === 'protocolParams' && proposal && typeof proposal === 'object' && !Array.isArray(proposal)) {
            const fields = {};
            const requested = name => sources[`protocolParams.${name}`] === '本轮设置';
            const keepCompression = answers['protocolParams.output_compression'] !== null;
            const compressionRequested = requested('output_compression') && keepCompression;
            if (compressionFormats && proposal.output_compression != null && keepCompression && !supportsOpenAiOutputCompression(effectiveFormat)) {
                const supported = compressionFormats.filter(value => value !== 'jpeg' || !transparent);
                if (compressionRequested && requested('output_format') && proposedFormat) {
                    const error = new Error('压缩率适用于 JPEG 或 WebP，请选择输出格式。');
                    error.parameterClarification = { field: 'protocolParams.output_format', choices: supported.map(value => ({value,label:value.toUpperCase()})) };
                    throw error;
                }
                if (compressionRequested) fields.output_format = supported[0];
            }
            for (const [name, value] of Object.entries(proposal)) {
                const field = `protocolParams.${name}`;
                const nestedRule = Object.hasOwn(rule?.properties || {}, name) ? rule.properties[name] : null;
                const setting = Object.hasOwn(answers, field) ? answers[field] : value;
                if (setting === null) continue;
                if (name === 'output_format' && fields.output_format) continue;
                if (name === 'output_compression' && compressionFormats && !supportsOpenAiOutputCompression(fields.output_format || effectiveFormat)) continue;
                if (name === 'output_format' && !supportsOpenAiTransparentFormat(setting) && transparent && compressionFormats) {
                    if (requested(name)) throw clarifyParameter(name, { enum: ['png', 'webp'] }, field);
                    fields.output_format = 'png';
                    continue;
                }
                if (OPENAI_GIF_FRAME_FIELDS.includes(name) && nestedRule?.requiresOutputFormat
                    && !nestedRule.requiresOutputFormat.includes(fields.output_format ?? effectiveFormat)) {
                    if (requested(name)) throw clarifyParameter(name, null, field);
                    continue;
                }
                if (nestedRule) {
                    try { fields[name] = normalizeValue(setting, nestedRule, name); continue; }
                    catch { /* A requested setting gets a choice below. */ }
                }
                if (requested(name)) throw clarifyParameter(name, nestedRule, field);
            }
            if (Object.keys(fields).length) result[key] = fields;
            continue;
        }
        if (rule) {
            try { result[key] = normalizeValue(proposal, rule, key); continue; }
            catch { /* Only a requested setting needs a decision. */ }
        }
        if (sources[key] !== '本轮设置' && sources[key] !== '沿用任务' && !Object.hasOwn(answers, key)) continue;
        throw clarifyParameter(key, rule);
    }
    return result;
}

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

export function getPromptAgentControl(documentRef, node, id) {
    const roots = [...new Set([node?.parameterRoot, node?.el].filter(Boolean))];
    for (const root of roots) {
        if (root.id === id) return root;
        const control = root.querySelector?.(`[id="${id.replaceAll('"', '\\"')}"]`);
        if (control) return control;
    }
    return roots.length ? null : documentRef.getElementById(id);
}

function hiddenByCapability(control, node, exceptFieldId = null) {
    const boundaries = [node?.parameterRoot, node?.el].filter(Boolean);
    if (!boundaries.length) {
        const field = control.closest?.('[hidden], .hidden');
        return Boolean(field && field.id !== exceptFieldId);
    }
    for (let element = control; element; element = element.parentElement) {
        if (element.id !== exceptFieldId
            && ((element.hidden && element.dataset?.parameterGroup === undefined) || element.classList?.contains('hidden'))) return true;
        if (boundaries.includes(element)) break;
    }
    return false;
}

export function readPromptAgentParameterSchema(documentRef, nodeId, node = null, { openAiOutputFormat, canChangeOpenAiOutputFormat = false } = {}) {
    const schema = {};
    for (const [key, suffix] of Object.entries(PROMPT_AGENT_PARAMETER_CONTROLS)) {
        const control = getPromptAgentControl(documentRef, node, `${nodeId}-${suffix}`);
        if (!control || control.type === 'hidden' || control.hidden) continue;
        // Custom dimensions and aspect can be enabled by a resolution change.
        const conditionalSize = ['customWidth', 'customHeight', 'aspectRatio'].includes(key);
        if (!conditionalSize && (control.disabled || hiddenByCapability(control, node))) continue;
        schema[key] = readControlSchema(control, PARAMETER_TYPES[key]);
    }
    if (schema.resolution?.enum && !schema.resolution.enum.includes('custom')) {
        delete schema.customWidth;
        delete schema.customHeight;
    }
    const prefix = `${nodeId}-param-`;
    const protocolProperties = {};
    const roots = [...new Set([node?.parameterRoot, node?.el].filter(Boolean))];
    if (!roots.length && documentRef.getElementById(nodeId)) roots.push(documentRef.getElementById(nodeId));
    const controls = new Set(roots.flatMap(root => [...(root.querySelectorAll?.('input[id], select[id], textarea[id]') || [])]));
    for (const control of controls) {
        if (!control.id.startsWith(prefix) || control.type === 'hidden' || control.hidden || control.disabled) continue;
        const key = control.id.slice(prefix.length);
        if (key === 'negative_prompt' || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
        const allowedFormats = (canChangeOpenAiOutputFormat || openAiOutputFormat !== undefined) && Object.hasOwn(openAiImageParameterFormats, key)
            ? openAiImageParameterFormats[key] : null;
        if (allowedFormats && !canChangeOpenAiOutputFormat && !allowedFormats.includes(openAiOutputFormat)) continue;
        if (hiddenByCapability(control, node, allowedFormats ? `${nodeId}-${key}-field` : null)) continue;
        protocolProperties[key] = readControlSchema(control, allowedFormats && OPENAI_GIF_FRAME_FIELDS.includes(key) ? 'integer' : 'string');
        if (allowedFormats) protocolProperties[key].requiresOutputFormat = allowedFormats;
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
