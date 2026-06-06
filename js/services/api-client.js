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
            'x-proxy-timeout': state.requestTimeoutEnabled ? state.requestTimeoutSeconds.toString() : '0',
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

export function getProxyRequestInfo(state = {}) {
    const proxy = state?.proxy && typeof state.proxy === 'object' ? state.proxy : null;
    if (!proxy) {
        return {
            enabled: false,
            host: '',
            port: '',
            mode: 'direct',
            label: '直连'
        };
    }

    const enabled = proxy.enabled === true;
    const host = String(proxy.ip || proxy.host || '127.0.0.1').trim() || '127.0.0.1';
    const port = String(proxy.port || '7890').trim() || '7890';
    return {
        enabled,
        host,
        port,
        mode: enabled ? 'proxy' : 'direct',
        label: enabled ? `代理 ${host}:${port}` : '直连'
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
    if (
        normalizedUrl.includes('/chat/completions') ||
        normalizedUrl.includes('/images/generations') ||
        normalizedUrl.includes('/images/edits') ||
        normalizedUrl.includes('/responses')
    ) return 'openai';
    return 'unknown';
}

function safeParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function buildBlockedTargetSuggestions() {
    return [
        '检查 API 地址是否填写完整，裸 IP 或域名会按 http:// 处理',
        '确认地址中没有多余空格、中文标点或被截断的路径',
        '如果是自建服务，先在浏览器或其他工具里验证该地址可访问'
    ];
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
        suggestions.splice(1, 0, '确认当前供应商是否真的支持该图片模型的 /images/generations 或 /images/edits 接口。');
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
        suggestions.splice(1, 0, '重点检查该供应商是否明确支持当前模型的 /images/generations 或 /images/edits 接口。');
    }

    return suggestions;
}

function isCloudflareChallengePage(text = '') {
    const normalized = String(text || '').toLowerCase();
    return (
        normalized.includes('<title>just a moment...</title>') ||
        (
            normalized.includes('just a moment') &&
            normalized.includes('cloudflare')
        ) ||
        normalized.includes('/cdn-cgi/challenge-platform/') ||
        normalized.includes('cf-browser-verification') ||
        normalized.includes('__cf_chl_tk') ||
        normalized.includes('cf_chl_')
    );
}

function buildForbiddenSuggestions() {
    return [
        '如果这是供应商的人机验证或 IP 保护，请在供应商后台放行当前 IP，或切换到可访问该服务的网络/代理。',
        '确认当前 API Key、账号或套餐是否有访问该模型和接口的权限。',
        '检查 endpoint 是否指向真实 API 接口，而不是会触发网页防护的站点页面。'
    ];
}

function buildConnectionRefusedSuggestions(context = {}) {
    const proxyEnabled = context.proxyEnabled === true;
    const proxyHost = String(context.proxyHost || '').trim();
    const proxyPort = String(context.proxyPort || '').trim();
    const proxyLabel = proxyHost && proxyPort ? `${proxyHost}:${proxyPort}` : '当前代理端口';
    if (proxyEnabled) {
        const suggestions = [
            '确认代理软件已启动，并且 HTTP/Mixed 代理端口可连接。',
            '检查 CainFlow 常规设置里的代理地址和端口是否与代理软件一致。',
            '暂时关闭 CainFlow 代理后重试，用来区分是代理问题还是上游服务问题。'
        ];
        if (proxyHost || proxyPort) {
            suggestions.unshift(`当前连接的是 ${proxyLabel}，这台机器上很可能没有对应的代理监听进程。`);
        }
        return suggestions;
    }

    const targetHost = String(context.targetHost || '').trim();
    const targetPort = String(context.targetPort || '').trim();
    const targetProtocol = String(context.targetProtocol || '').trim();
    const originalEndpoint = String(context.providerEndpoint || '').trim();
    const targetLabel = targetHost
        ? `${targetProtocol ? `${targetProtocol}://` : ''}${targetHost}${targetPort ? `:${targetPort}` : ''}`
        : '当前 API 地址';
    const suggestions = [
        `当前是直连模式，连接被 ${targetLabel} 拒绝，请先确认这个地址和端口真的有 API 服务在运行。`,
        '如果 endpoint 是本地或局域网中转地址，检查对应服务是否已启动、监听端口是否填对。',
        '如果这是公网服务，确认 API 地址应使用 https://，不要漏写协议或误写成 http://。'
    ];
    if (originalEndpoint && !originalEndpoint.includes('://')) {
        suggestions.unshift('当前 API 地址没有写协议，CainFlow 会按 http:// 处理；如果服务商要求 HTTPS，请补成完整的 https:// 地址。');
    }
    return suggestions;
}

export function classifyProviderError(status, body, context = {}) {
    const text = typeof body === 'string' ? body.trim() : '';
    const json = safeParseJson(text);
    const rawMessage = json?.error?.message || (typeof json?.error === 'string' ? json.error : '') || json?.message || text || '未知错误';
    const detailText = typeof json?.detail === 'string' ? json.detail : '';
    const normalized = `${rawMessage}\n${detailText}\n${text}`.toLowerCase();
    const providerType = inferProviderType(context.url, context);
    const modelId = String(context.modelId || '').toLowerCase();
    const apiKeyShape = context.apiKeyShape || 'unknown';

    if (
        status === 403 &&
        (
            normalized.includes('forbidden: target url is not allowed') ||
            normalized.includes('target url is not allowed')
        )
    ) {
        return {
            title: '目标地址不可用',
            userMessage: '当前目标地址不可用，请检查 API 地址是否为有效的 http 或 https URL。',
            suggestions: buildBlockedTargetSuggestions(),
            category: 'blocked_target_url',
            rawMessage,
            providerType
        };
    }

    if (isCloudflareChallengePage(text)) {
        return {
            title: '被人机验证拦截',
            userMessage: '服务器返回了 Cloudflare 的 “Just a moment...” 验证页，请求被人机验证拦截了，CainFlow 无法直接通过这类网页验证。',
            suggestions: [
                '在浏览器中打开对应服务并完成验证，或使用已经通过验证的官方 API 入口。',
                '如果服务端启用了 IP 保护，请放行当前 IP，或切换到受信任的网络/代理。',
                '确认 endpoint 指向 API 接口，而不是 Cloudflare 保护下的网页地址。'
            ],
            category: 'cloudflare_challenge',
            rawMessage,
            providerType
        };
    }

    if (status === 403) {
        return {
            title: '被禁止访问',
            userMessage: '服务器返回 403 Forbidden，表示当前请求被禁止访问。常见原因是触发了人机验证、服务器增加了 IP 保护/地区限制，或当前账号/API Key 没有访问权限。',
            suggestions: buildForbiddenSuggestions(),
            category: 'forbidden',
            rawMessage,
            providerType
        };
    }

    if (status === 504 || normalized.includes('timeout') || normalized.includes('timed out')) {
        const refusedDetail = normalized.includes('api connection refused') || normalized.includes('winerror 10061') || normalized.includes('connection refused') || normalized.includes('actively refused');
        if (refusedDetail) {
            const proxyHost = String(context.proxyHost || '').trim();
            const proxyPort = String(context.proxyPort || '').trim();
            const proxyLabel = proxyHost && proxyPort ? `${proxyHost}:${proxyPort}` : '当前代理端口';
            const targetHost = String(context.targetHost || '').trim();
            const targetPort = String(context.targetPort || '').trim();
            const targetProtocol = String(context.targetProtocol || '').trim();
            const targetLabel = targetHost
                ? `${targetProtocol ? `${targetProtocol}://` : ''}${targetHost}${targetPort ? `:${targetPort}` : ''}`
                : '当前 API 地址';
            return {
                title: '连接被拒绝',
                userMessage: context.proxyEnabled === true
                    ? `本机代理 ${proxyLabel} 拒绝连接，通常是代理软件没有启动、端口填错，或被防火墙拦截。`
                    : `${targetLabel} 拒绝连接，CainFlow 当前没有启用代理；通常是 API 地址/端口不正确，或目标服务没有启动。`,
                suggestions: buildConnectionRefusedSuggestions(context),
                category: 'connection_refused',
                rawMessage,
                providerType
            };
        }
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
            title: '接口协议与模型可能不一致',
            userMessage: providerType === 'google'
                ? '当前请求正在使用 Google/Gemini 协议，但所选模型名称可能不适合这个协议。'
                : '当前请求正在使用 OpenAI 兼容协议，但所选模型名称可能不适合这个协议。',
            suggestions: providerType === 'google'
                ? [
                    '检查模型卡片里的兼容格式是否选成了正确协议。',
                    '如果这是 OpenAI 兼容或中转模型，请把兼容格式切到对应模式。',
                    '如果这是 Gemini 官方接口，请确认模型 ID 使用 Gemini 文档认可的名称。'
                ]
                : [
                    '检查模型卡片里的兼容格式是否选成了正确协议。',
                    '如果这是 Gemini 模型，请切换到 Google/Gemini 协议。',
                    '如果这是 OpenAI 兼容供应商，请确认模型 ID 是该供应商支持的名称。'
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

function sanitizeRequestPayload(payload, options = {}) {
    const { truncate = true } = options;
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
                    } else if (truncate && value.length > 400) {
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
        const normalized = text.toLowerCase();
        if (normalized.includes('api connection refused') || normalized.includes('winerror 10061') || normalized.includes('connection refused') || normalized.includes('actively refused')) {
            return context.hint || '连接被拒绝，请检查目标服务或代理端口是否在运行';
        }
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
    if (state.abortReason === 'timeout') return '请求超时，生成失败';
    if (state.abortReason === 'manual') return '用户手动停止了工作流';
    return '工作流已停止';
}

const DETAILS_STRING_LIMIT = 1200;
const DETAILS_FIELD_STRING_LIMIT = 400;
const DETAILS_FULL_STRING_LIMIT = 60000;
const DETAILS_FULL_FIELD_STRING_LIMIT = 12000;
const DETAILS_OBJECT_TEXT_LIMIT = 16000;
const DETAILS_FULL_OBJECT_TEXT_LIMIT = 60000;
const DETAILS_MAX_DEPTH = 8;
const DETAILS_MAX_ARRAY_ITEMS = 80;
const DETAILS_MAX_OBJECT_KEYS = 120;
const SENSITIVE_DETAIL_KEYS = new Set([
    'authorization',
    'apikey',
    'api_key',
    'api-key',
    'x-api-key',
    'key',
    'token',
    'access_token',
    'cookie',
    'set-cookie'
]);

function formatApproxBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return '未知大小';
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${Math.round(value)} B`;
}

function estimateBase64Bytes(payload = '') {
    const compact = String(payload || '').replace(/\s+/g, '');
    if (!compact) return 0;
    const padding = compact.endsWith('==') ? 2 : (compact.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor(compact.length * 3 / 4) - padding);
}

function parseDataUrlMeta(value = '') {
    const match = String(value || '').match(/^data:([^;,]+)?((?:;[^,]*)*),(.*)$/is);
    if (!match) return null;
    const mimeType = match[1] || 'application/octet-stream';
    const options = match[2] || '';
    const payload = match[3] || '';
    const isBase64 = /;base64/i.test(options);
    const bytes = isBase64 ? estimateBase64Bytes(payload) : payload.length;
    return { mimeType, bytes };
}

function getMediaLabelFromMime(mimeType = '') {
    const normalized = String(mimeType || '').toLowerCase();
    if (normalized.startsWith('image/')) return '图片';
    if (normalized.startsWith('video/')) return '视频';
    if (normalized.startsWith('audio/')) return '音频';
    return '媒体';
}

function summarizeDataUrl(value) {
    const meta = parseDataUrlMeta(value);
    if (!meta) return '[媒体数据已省略]';
    const label = getMediaLabelFromMime(meta.mimeType);
    return `[${label}数据已省略: ${meta.mimeType}, ${formatApproxBytes(meta.bytes)}]`;
}

function summarizeBlobLike(value, fallbackLabel = '二进制数据') {
    const name = typeof value?.name === 'string' && value.name ? `, ${value.name}` : '';
    const type = typeof value?.type === 'string' && value.type ? value.type : 'application/octet-stream';
    const size = formatApproxBytes(value?.size || 0);
    return `[${fallbackLabel}已省略: ${type}${name}, ${size}]`;
}

function isDataUrlString(value) {
    return typeof value === 'string' && /^data:/i.test(value.trim());
}

function isLikelyBase64Payload(value) {
    if (typeof value !== 'string' || value.length < 1500) return false;
    const trimmed = value.trim();
    if (!trimmed || /^https?:\/\//i.test(trimmed) || /^</.test(trimmed)) return false;
    const compact = trimmed.replace(/\s+/g, '');
    if (compact.length < 1500 || compact.length % 4 === 1) return false;
    return /^[A-Za-z0-9+/=_-]+$/.test(compact);
}

function sanitizeStringValue(value, key = '', options = {}) {
    const { truncate = true, stringLimit = null } = options;
    const raw = String(value ?? '');
    const normalizedKey = String(key || '').toLowerCase();
    if (SENSITIVE_DETAIL_KEYS.has(normalizedKey)) return '[REDACTED]';
    if (isDataUrlString(raw)) return truncate ? summarizeDataUrl(raw) : raw;
    if (isLikelyBase64Payload(raw)) {
        return truncate ? `[Base64数据已省略: ${formatApproxBytes(estimateBase64Bytes(raw))}]` : raw;
    }

    const sanitized = sanitizeRequestUrl(raw);
    const isUrlLike = normalizedKey.includes('url') || /^https?:\/\//i.test(sanitized);
    if (!truncate && stringLimit === null) {
        return sanitized;
    }
    const limit = Number.isFinite(Number(stringLimit)) && Number(stringLimit) > 0
        ? Number(stringLimit)
        : truncate
        ? (isUrlLike ? DETAILS_FULL_FIELD_STRING_LIMIT : DETAILS_FIELD_STRING_LIMIT)
        : DETAILS_FULL_FIELD_STRING_LIMIT;

    if (sanitized.length > limit) {
        const suffix = truncate ? '[数据过长已截断]' : '[完整详情仍过长，已截断]';
        return `${sanitized.substring(0, limit)}... ${suffix}`;
    }
    return sanitized;
}

function sanitizeDetailsValue(value, options = {}, context = {}) {
    const { depth = 0, key = '', seen = new WeakSet() } = context;
    if (value === null || value === undefined) return value;
    const type = typeof value;
    if (type === 'string') return sanitizeStringValue(value, key, options);
    if (type === 'number' || type === 'boolean') return value;
    if (type === 'bigint') return String(value);
    if (type === 'function') return '[函数已省略]';
    if (type !== 'object') return String(value);

    if (typeof Blob !== 'undefined' && value instanceof Blob) {
        const isFile = typeof File !== 'undefined' && value instanceof File;
        return summarizeBlobLike(value, isFile ? '文件' : 'Blob');
    }
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
        return `[ArrayBuffer已省略: ${formatApproxBytes(value.byteLength)}]`;
    }
    if (ArrayBuffer.isView?.(value)) {
        return `[TypedArray已省略: ${formatApproxBytes(value.byteLength)}]`;
    }
    if (value instanceof Error) {
        return {
            name: value.name || 'Error',
            message: sanitizeStringValue(value.message || '', 'message', options),
            stack: sanitizeStringValue(value.stack || '', 'stack', options)
        };
    }
    if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
        return Object.fromEntries(Array.from(value.entries()).map(([entryKey, entryValue]) => [
            entryKey,
            sanitizeStringValue(entryValue, entryKey, options)
        ]));
    }
    if (typeof FormData !== 'undefined' && value instanceof FormData) {
        const fields = [];
        value.forEach((entryValue, entryKey) => {
            fields.push({
                key: entryKey,
                value: sanitizeDetailsValue(entryValue, options, { depth: depth + 1, key: entryKey, seen })
            });
        });
        return { type: 'FormData', fields };
    }
    if (depth >= DETAILS_MAX_DEPTH) return '[对象层级过深，已省略]';
    if (seen.has(value)) return '[循环引用已省略]';
    seen.add(value);

    if (Array.isArray(value)) {
        const maxItems = options.truncate === false ? value.length : DETAILS_MAX_ARRAY_ITEMS;
        const limited = value.slice(0, maxItems).map((item, index) => (
            sanitizeDetailsValue(item, options, { depth: depth + 1, key: String(index), seen })
        ));
        if (value.length > maxItems) {
            limited.push(`[还有 ${value.length - maxItems} 项已省略]`);
        }
        seen.delete(value);
        return limited;
    }

    const output = {};
    const entries = Object.entries(value);
    const maxKeys = options.truncate === false ? entries.length : DETAILS_MAX_OBJECT_KEYS;
    entries.slice(0, maxKeys).forEach(([entryKey, entryValue]) => {
        output[entryKey] = sanitizeDetailsValue(entryValue, options, {
            depth: depth + 1,
            key: entryKey,
            seen
        });
    });
    if (entries.length > maxKeys) {
        output.__omittedKeys = entries.length - maxKeys;
    }
    seen.delete(value);
    return output;
}

function truncateDetailsText(text, options = {}) {
    const { truncate = true } = options;
    if (!truncate) return text;
    const limit = truncate ? DETAILS_OBJECT_TEXT_LIMIT : DETAILS_FULL_OBJECT_TEXT_LIMIT;
    if (typeof text !== 'string' || text.length <= limit) return text;
    const suffix = truncate ? '[数据过长已截断]' : '[完整详情仍过长，已截断]';
    return `${text.substring(0, limit)}... ${suffix}`;
}

export function sanitizeDetails(details, options = {}) {
    const { truncate = true } = options;
    if (!details) return null;
    if (typeof details === 'string') {
        const sanitized = sanitizeStringValue(details, '', {
            truncate,
            stringLimit: truncate ? DETAILS_STRING_LIMIT : null
        });
        if (!truncate) return sanitized;
        const limit = truncate ? DETAILS_STRING_LIMIT : DETAILS_FULL_STRING_LIMIT;
        if (sanitized.length > limit) {
            const suffix = truncate ? '[数据过长已截断]' : '[完整详情仍过长，已截断]';
            return `${sanitized.substring(0, limit)}... ${suffix}`;
        }
        return sanitized;
    }
    if (typeof details === 'object') {
        try {
            const sanitized = sanitizeDetailsValue(details, { truncate });
            return truncateDetailsText(JSON.stringify(sanitized, null, 2), { truncate });
        } catch {
            return '[无法序列化的详细信息]';
        }
    }
    return details;
}
/**
 * 提供请求日志脱敏、错误格式化和接口辅助工具。
 */
