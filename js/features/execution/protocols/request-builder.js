/**
 * 通用请求构建器
 * 根据协议配置自动生成请求体、URL和解析响应
 */

/**
 * 从协议配置构建请求体
 * @param {Object} protocol - 协议对象
 * @param {Object} context - 执行上下文 { parameters, inputs, modelConfig, taskType }
 * @returns {Object} 构建好的请求体
 */
export function buildRequestFromConfig(protocol, context) {
    const { parameters, inputs, modelConfig, taskType } = context;
    const requestBody = {};

    // 1. 处理 model 参数
    // 如果协议的 parameters 中定义了 model，就按参数处理
    // 否则使用旧的 includeModel 逻辑（向后兼容）
    const hasModelParam = protocol.parameters && protocol.parameters.model;
    if (!hasModelParam && protocol.includeModel !== false) {
        // 旧逻辑：自动添加 model 字段
        requestBody.model = modelConfig.modelId;
    }

    // 2. 遍历协议的参数定义，构建请求体
    Object.entries(protocol.parameters || {}).forEach(([paramId, paramDef]) => {
        if (paramDef.portOnly === true || paramId === 'referenceImages' || paramDef.id === 'referenceImages') {
            return;
        }
        // 跳过不适用于当前任务类型的参数
        if (paramDef.taskTypes && !paramDef.taskTypes.includes(taskType)) {
            return;
        }

        let value = parameters[paramId];

        // 特殊处理：如果参数值是 "{{modelId}}"，替换为实际的模型ID
        if (typeof value === 'string' && value === '{{modelId}}') {
            value = modelConfig.modelId;
        }

        // 如果参数定义有默认值且默认值是 "{{modelId}}"，也要替换
        let defaultValue = paramDef.defaultValue;
        if (typeof defaultValue === 'string' && defaultValue === '{{modelId}}') {
            defaultValue = modelConfig.modelId;
        }

        // 检查是否应该包含此参数
        const shouldInclude = checkShouldIncludeParam(value, paramDef, defaultValue);

        if (shouldInclude) {
            const finalValue = value !== undefined && value !== ''
                ? value
                : defaultValue;

            // 类型转换，使用 requestField 或参数ID作为请求体字段名
            const requestField = paramDef.requestField || paramId;
            requestBody[requestField] = convertValueByType(finalValue, paramDef.dataType);
        }
    });

    // 3. 添加固定参数（不在parameters中定义的）
    if (protocol.fixedParams) {
        const fixedForTask = typeof protocol.fixedParams === 'function'
            ? protocol.fixedParams(taskType)
            : protocol.fixedParams;
        Object.assign(requestBody, fixedForTask);
    }

    // 4. 应用自定义参数（用户通过输入端口传入的）
    if (context.customParams) {
        Object.assign(requestBody, context.customParams);
    }

    return requestBody;
}

/**
 * 检查参数是否应该包含在请求体中
 */
function checkShouldIncludeParam(value, paramDef, defaultValue) {
    // 使用传入的 defaultValue，如果没有则使用 paramDef 的
    const effectiveDefaultValue = defaultValue !== undefined ? defaultValue : paramDef.defaultValue;

    // 必填参数：总是包含（即使值为空）
    if (paramDef.required) {
        return true;
    }

    // 判断用户是否提供了有效值
    const hasUserValue = value !== undefined && value !== '';

    // 获取最终要使用的值
    const finalValue = hasUserValue ? value : effectiveDefaultValue;

    // 如果最终值为空（undefined、null、空字符串），检查是否应该省略
    if (finalValue === undefined || finalValue === null || finalValue === '') {
        // 如果 omitIfEmpty 明确设置为 false，则即使值为空也要包含
        if (paramDef.omitIfEmpty === false) {
            return true;
        }
        // 否则省略空值参数
        return false;
    }

    // 有非空值：包含参数
    return true;
}

/**
 * 根据数据类型转换值
 */
function convertValueByType(value, dataType) {
    if (value === undefined || value === null) {
        return value;
    }

    switch (dataType) {
        case 'number':
            return Number(value);
        case 'boolean':
            // 字符串 'false' 应该转为 false
            if (typeof value === 'string') {
                return value.toLowerCase() === 'true';
            }
            return Boolean(value);
        case 'array':
            return Array.isArray(value) ? value : [value];
        case 'object':
            if (typeof value === 'object') {
                return value;
            }
            try {
                return JSON.parse(value);
            } catch (e) {
                return value;
            }
        case 'string':
        default:
            return String(value);
    }
}

/**
 * 从URL模板构建URL
 * @param {Object} protocol - 协议对象
 * @param {Object} context - 执行上下文 { apiConfig, modelConfig, taskType, parameters, inputs }
 * @returns {String} 构建好的URL
 */
export function buildUrlFromTemplate(protocol, context) {
    const { apiConfig, modelConfig, taskType, parameters, inputs } = context;

    let template = protocol.urlTemplates?.[taskType] || protocol.urlTemplate || '{{endpoint}}/v1/endpoint';

    // 替换变量
    const variables = {
        endpoint: String(apiConfig.endpoint || '').replace(/\/+$/, ''),
        model: modelConfig.modelId,
        taskType: taskType,
        ...parameters,
        ...inputs
    };

    // 简单的变量替换 {{varName}}
    let url = template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
        return variables[varName] !== undefined ? variables[varName] : match;
    });

    return url;
}

/**
 * 从响应中根据路径提取数据
 * @param {Object} response - API响应
 * @param {Object} protocol - 协议对象
 * @param {String} taskType - 任务类型
 * @returns {*} 提取的数据
 */
export function parseResponseFromPath(response, protocol, taskType) {
    if (!protocol.responsePath) {
        // 没有配置路径，返回整个响应
        return response;
    }

    // 获取当前任务类型的路径
    const path = typeof protocol.responsePath === 'string'
        ? protocol.responsePath
        : protocol.responsePath[taskType];

    if (!path) {
        return response;
    }

    // 解析路径并提取数据
    return extractByPath(response, path);
}

/**
 * 根据路径字符串提取对象中的值
 * 支持：'data.url', 'data[0].url', 'choices[0].message.content'
 */
function extractByPath(obj, path) {
    if (!path || !obj) {
        return obj;
    }

    const keys = path.split(/\.|\[|\]/).filter(k => k !== '');
    let current = obj;

    for (const key of keys) {
        if (current === null || current === undefined) {
            return null;
        }
        current = current[key];
    }

    return current;
}

/**
 * 包装纯配置协议，自动添加函数
 * @param {Object} protocol - 纯配置协议对象
 * @returns {Object} 包装后的完整协议对象
 */
export function wrapConfigProtocol(protocol) {
    // 如果已经有函数了，说明是自定义协议，直接返回
    if (typeof protocol.buildRequest === 'function') {
        return protocol;
    }

    // 包装成完整协议
    return {
        ...protocol,

        buildUrl(apiConfig, modelConfig, taskType, options = {}) {
            return buildUrlFromTemplate(this, {
                apiConfig,
                modelConfig,
                taskType,
                parameters: options.parameters || {},
                inputs: options.inputs || {}
            });
        },

        buildRequest(context) {
            return buildRequestFromConfig(this, context);
        },

        parseResponse(response, taskType) {
            return parseResponseFromPath(response, this, taskType);
        }
    };
}
