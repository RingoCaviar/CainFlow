/**
 * 封装 API 请求相关的通用辅助逻辑，包括代理头、错误信息与请求内容清洗。
 */
import { APP_VERSION } from '../core/constants.js';

function encodeTargetUrlHeader(url) {
    const encoded = new TextEncoder().encode(String(url || ''));
    let binary = '';
    for (const byte of encoded) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createProxyHeadersGetter(getState) {
    return function getProxyHeaders(url, method = 'POST', extraHeaders = {}) {
        const state = getState();
        const headers = {
            'x-target-url-b64': encodeTargetUrlHeader(url),
            'x-target-method': method,
            'x-proxy-timeout': state.requestTimeoutEnabled ? state.requestTimeoutSeconds.toString() : '600',
            'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) CainFlow/${APP_VERSION}`,
            ...extraHeaders
        };

        const normalizedMethod = String(method || 'POST').toUpperCase();
        if (!Object.prototype.hasOwnProperty.call(headers, 'Content-Type') && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
            headers['Content-Type'] = 'application/json';
        }
        if (headers['Content-Type'] === null) {
            delete headers['Content-Type'];
        }

        if (state.proxy) {
            headers['x-proxy-enabled'] = state.proxy.enabled ? 'true' : 'false';
            headers['x-proxy-host'] = state.proxy.ip || '127.0.0.1';
            headers['x-proxy-port'] = state.proxy.port || '7890';
        }
        return headers;
    };
}

export function sanitizeRequestUrl(url) {
    if (!url) return '';
    return String(url)
        .replace(/([?&]key=)[^&]+/gi, '$1[REDACTED]')
        .replace(/([?&]api[_-]?key=)[^&]+/gi, '$1[REDACTED]');
}

function inferProviderType(url = '', context = {}) {
    if (context?.providerType === 'google' || context?.providerType === 'openai') return context.providerType;
    const normalizedUrl = String(url || '').toLowerCase();
    if (normalizedUrl.includes('generativelanguage.googleapis.com') || normalizedUrl.includes('/v1beta/models/')) return 'google';
    if (normalizedUrl.includes('/chat/completions') || normalizedUrl.includes('/images/generations') || normalizedUrl.includes('/responses')) return 'openai';
    return 'unknown';
}

function safeParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function buildDefaultSuggestions(providerType) {
    if (providerType === 'google') {
        return [
            '检查当前供应商是否应当使用 Google/Gemini 官方接口。',
            '确认 API Key 是否为有效的 Google API Key。',
            '检查模型名称是否与 Google/Gemini 供应商匹配。'
        ];
    }
    if (providerType === 'openai') {
        return [
            '检查当前供应商地址是否为 OpenAI 兼容接口。',
            '确认 API Key 是否有效且未过期。',
            '检查模型名称是否与 OpenAI 兼容供应商支持范围一致。'
        ];
    }
    return [
        '检查供应商地址、模型名称和 API Key 是否相互匹配。',
        '确认当前账号或中转服务仍然可用。',
        '必要时切换到其他可用供应商重新测试。'
    ];
}

function buildUpstreamDisconnectSuggestions(providerType, modelId = '') {
    const suggestions = [
        '稍后重试一次，避免连续高频请求。',
        '检查当前供应商线路是否稳定，或切换到其他供应商测试。',
        '如果你使用了代理，请确认代理网络当前可用。'
    ];

    if (providerType === 'openai' && (modelId.includes('image') || modelId.startsWith('gpt-image'))) {
        suggestions.splice(1, 0, '确认当前供应商是否真的支持该图片模型的 /images/generations 接口。');
    }

    return suggestions;
}

function buildNoImageResponseSuggestions(providerType, modelId = '') {
    const suggestions = [
        '稍后重试一次，这类问题有时是供应商上游波动导致的。',
        '确认当前供应商是否真的稳定支持所选图片模型。',
        '如果持续出现，建议换同供应商其他图片模型或切换到别的兼容供应商测试。'
    ];

    if (providerType === 'openai' && (modelId.includes('image') || modelId.startsWith('gpt-image'))) {
        suggestions.splice(1, 0, '重点检查该供应商是否明确支持当前模型的 /images/generations 接口。');
    }

    return suggestions;
}

export function classifyProviderError(status, body, context = {}) {
    const text = typeof body === 'string' ? body.trim() : '';
    const json = safeParseJson(text);
    const rawMessage = json?.error?.message || json?.message || text || '未知错误';
    const normalized = `${rawMessage}\n${text}`.toLowerCase();
    const providerType = inferProviderType(context.url, context);
    const modelId = String(context.modelId || '').toLowerCase();
    const apiKeyShape = context.apiKeyShape || 'unknown';

    if (status === 504 || normalized.includes('timeout') || normalized.includes('timed out')) {
        return {
            title: '请求超时',
            userMessage: '上游服务响应超时，可能是生成耗时过长、代理不稳定，或当前网络不可达。',
            suggestions: [
                '稍后重试一次，避免连续快速重复请求。',
                '如果使用了代理，请先检查代理连通性。',
                '如果是第三方中转商，请确认其当前服务状态。'
            ],
            category: 'timeout',
            rawMessage,
            providerType
        };
    }

    if (
        normalized.includes('remote end closed connection without response') ||
        normalized.includes('remotedisconnected') ||
        normalized.includes('upstream connection closed') ||
        normalized.includes('object of type remotedisconnected is not json serializable')
    ) {
        return {
            title: '上游连接中断',
            userMessage: '当前供应商在返回结果前主动断开了连接，通常是供应商线路不稳定、上游模型暂时不可用，或该接口当前不支持这次请求。',
            suggestions: buildUpstreamDisconnectSuggestions(providerType, modelId),
            category: 'upstream_connection_closed',
            rawMessage,
            providerType
        };
    }

    if (
        normalized.includes('disabled in this account') ||
        normalized.includes('violation of terms of service') ||
        normalized.includes('submit an appeal')
    ) {
        return {
            title: '账号已被停用',
            userMessage: '当前账号或中转 key 已被上游停用，CainFlow 无法继续调用该服务。',
            suggestions: [
                '更换一把可用的 API Key 后再试。',
                '如果这是第三方中转平台的 key，请联系供应商处理。',
                '如果是你自己的上游账号，请按提示提交申诉。'
            ],
            category: 'account_disabled',
            rawMessage,
            providerType
        };
    }

    if (
        normalized.includes('no images found in response') ||
        normalized.includes('"type":"upstream_error"')
    ) {
        return {
            title: '供应商未返回图片结果',
            userMessage: '当前供应商没有返回可用图片结果，通常是该模型线路异常、供应商上游暂时失败。',
            suggestions: buildNoImageResponseSuggestions(providerType, modelId),
            category: 'no_image_in_response',
            rawMessage,
            providerType
        };
    }

    if (
        (providerType === 'google' && (modelId.startsWith('gpt-') || modelId.includes('dall-e') || apiKeyShape === 'openai_like')) ||
        (providerType === 'openai' && modelId.startsWith('gemini'))
    ) {
        return {
            title: '供应商与模型不匹配',
            userMessage: providerType === 'google'
                ? '当前请求走的是 Google/Gemini 接口，但你配置的模型或密钥更像是其他供应商的配置。'
                : '当前请求走的是 OpenAI 兼容接口，但你配置的是 Gemini 模型。',
            suggestions: providerType === 'google'
                ? [
                    '检查当前 endpoint、API Key 和模型是否来自同一家服务商。',
                    '如果要用 gpt-image-2，请把供应商改成 OpenAI 兼容或对应的第三方供应商地址。',
                    '如果要用 Gemini 官方接口，请改成 Gemini 模型名，并使用该接口认可的密钥。'
                ]
                : [
                    '如果要用 Gemini，请把供应商改成 Google/Gemini。',
                    '如果要用 OpenAI 兼容供应商，请改成该供应商支持的模型名。',
                    '检查模型绑定关系，避免把 Gemini 模型挂到 OpenAI 供应商上。'
                ],
            category: 'provider_model_mismatch',
            rawMessage,
            providerType
        };
    }

    if (
        normalized.includes('api key not valid') ||
        normalized.includes('api_key_invalid') ||
        normalized.includes('invalid api key') ||
        normalized.includes('incorrect api key') ||
        normalized.includes('invalid_api_key')
    ) {
        if (providerType === 'google') {
            return {
                title: 'Google API Key 无效',
                userMessage: '当前请求发往 Google/Gemini 接口，但提供的 API Key 无效或不属于该服务。',
                suggestions: [
                    '检查当前密钥是否真的可用于这个 Google/Gemini 接口，而不是其他供应商签发的 key。',
                    '如果你本来想用第三方 OpenAI 兼容或中转供应商，请把 endpoint 改成该供应商地址。',
                    '重新检查 endpoint、模型和密钥是否互相匹配。'
                ],
                category: 'invalid_api_key',
                rawMessage,
                providerType
            };
        }

        if (providerType === 'openai') {
            return {
                title: 'OpenAI 兼容密钥无效',
                userMessage: '当前供应商的 API Key 无效、已过期，或不被该 OpenAI 兼容服务接受。',
                suggestions: [
                    '检查 API Key 是否填写完整，是否包含多余空格。',
                    '确认这把 key 是否属于当前供应商或中转平台。',
                    '如有多把 key，请切换另一把测试。'
                ],
                category: 'invalid_api_key',
                rawMessage,
                providerType
            };
        }
    }

    if (
        normalized.includes('model not found') ||
        normalized.includes('not found for api version') ||
        normalized.includes('unsupported model') ||
        normalized.includes('does not exist') ||
        normalized.includes('unknown model')
    ) {
        return {
            title: '模型不可用',
            userMessage: '当前模型名称不存在，或这个供应商并不支持该模型。',
            suggestions: [
                '检查模型 ID 是否拼写正确。',
                '确认该供应商或中转平台是否真的支持这个模型。',
                '必要时换成该供应商文档中明确支持的模型名。'
            ],
            category: 'model_not_found',
            rawMessage,
            providerType
        };
    }

    if (
        status === 429 ||
        normalized.includes('rate limit') ||
        normalized.includes('quota') ||
        normalized.includes('too many requests')
    ) {
        return {
            title: '请求过于频繁或额度不足',
            userMessage: '当前请求被限流，或账户额度已经不足，暂时无法继续调用。',
            suggestions: [
                '稍等片刻后重试，避免短时间内高频请求。',
                '检查账户额度、套餐或余额。',
                '如果使用第三方中转商，请确认该线路是否仍有配额。'
            ],
            category: 'rate_limit',
            rawMessage,
            providerType
        };
    }

    if (
        status === 401 ||
        normalized.includes('unauthorized') ||
        normalized.includes('authentication')
    ) {
        return {
            title: '鉴权失败',
            userMessage: '当前供应商拒绝了这次请求，通常是 API Key、账号权限或鉴权方式存在问题。',
            suggestions: buildDefaultSuggestions(providerType),
            category: 'auth_error',
            rawMessage,
            providerType
        };
    }

    if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
        return {
            title: '服务返回了错误页面',
            userMessage: '上游没有返回标准 API JSON，而是返回了一个网页错误页，通常表示接口地址、代理或服务端状态异常。',
            suggestions: buildDefaultSuggestions(providerType),
            category: 'html_error_page',
            rawMessage,
            providerType
        };
    }

    if (normalized.includes('remote end closed connection without response')) {
        return {
            title: '上游连接中断',
            userMessage: '上游服务在返回结果前断开了连接，通常意味着供应商线路异常、服务端主动中断，或当前接口不支持这次请求。',
            suggestions: buildUpstreamDisconnectSuggestions(providerType, modelId),
            category: 'connection_interrupted',
            rawMessage,
            providerType
        };
    }

    if (!rawMessage) return null;

    return {
        title: 'API 请求失败',
        userMessage: rawMessage,
        suggestions: buildDefaultSuggestions(providerType),
        category: 'generic_api_error',
        rawMessage,
        providerType
    };
}

export function sanitizeRequestPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    try {
        const copy = JSON.parse(JSON.stringify(payload));
        const maskKeys = ['authorization', 'apikey', 'api_key', 'api-key', 'x-api-key', 'key'];
        const traverse = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj)) {
                obj.forEach(traverse);
                return;
            }
            for (const key in obj) {
                const value = obj[key];
                const normalizedKey = key.toLowerCase();
                if (maskKeys.includes(normalizedKey)) {
                    obj[key] = '[REDACTED]';
                } else if (typeof value === 'string') {
                    if (value.startsWith('data:image/') && value.length > 500) {
                        obj[key] = '[图片数据已隐藏]';
                    } else if (value.length > 400) {
                        obj[key] = `${value.substring(0, 400)}... [数据过长已截断]`;
                    }
                } else if (typeof value === 'object' && value !== null) {
                    traverse(value);
                }
            }
        };
        traverse(copy);
        return copy;
    } catch {
        return '[无法序列化的请求内容]';
    }
}

export function formatProxyErrorMessage(status, body, fallbackPrefix = 'API 错误', context = {}) {
    const text = typeof body === 'string' ? body.trim() : '';
    const classified = classifyProviderError(status, body, context);
    if (classified?.userMessage) {
        return classified.userMessage;
    }

    if (status === 504) {
        return '图片生成等待超时，请稍后重试或检查服务端处理耗时';
    }

    if (text.includes('Remote end closed connection without response')) {
        return '网络连接中断：对方服务端在生成完成前关闭了连接，通常意味着上游或代理发生了超时';
    }

    try {
        const json = JSON.parse(text);
        if (json?.error?.message) {
            return `${fallbackPrefix} (${status}): ${json.error.message}`;
        }
    } catch {
        // Ignore non-JSON payloads.
    }

    if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
        return `${fallbackPrefix} (${status}): 服务器返回了 HTML 错误页，请检查代理或上游服务状态`;
    }

    return `${fallbackPrefix} (${status}): ${text.substring(0, 100)}`;
}

export function getAbortMessage(state) {
    return state.abortReason === 'timeout'
        ? '请求超时，生成失败'
        : '用户终止了工作流';
}

export function sanitizeDetails(details) {
    if (!details) return null;
    if (typeof details === 'string' && details.length > 1200) {
        const sanitized = sanitizeRequestUrl(details);
        return `${sanitized.substring(0, 1200)}... [数据过长已截断]`;
    }
    if (typeof details === 'string') {
        return sanitizeRequestUrl(details);
    }
    if (typeof details === 'object') {
        try {
            const copy = JSON.parse(JSON.stringify(details));
            const traverse = (obj) => {
                for (const key in obj) {
                    if (typeof obj[key] === 'string') {
                        if (obj[key].startsWith('data:image/') && obj[key].length > 500) {
                            obj[key] = '[图片数据已隐藏]';
                        } else if (key.toLowerCase().includes('url')) {
                            obj[key] = sanitizeRequestUrl(obj[key]);
                        } else if (obj[key].length > 400) {
                            obj[key] = `${sanitizeRequestUrl(obj[key]).substring(0, 400)}... [数据过长已截断]`;
                        } else {
                            obj[key] = sanitizeRequestUrl(obj[key]);
                        }
                    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                        traverse(obj[key]);
                    }
                }
            };
            traverse(copy);
            return JSON.stringify(copy, null, 2);
        } catch {
            return '[无法序列化的详细信息]';
        }
    }
    return details;
}
/**
 * 提供请求日志脱敏、错误格式化和接口辅助工具。
 */
