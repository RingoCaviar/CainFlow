import { getOpenAIChatCapabilities } from './openai-chat-capabilities.js';
import { applyThinking, THINKING_PROFILES } from './thinking-config.js';
import { resolveProviderUrl } from './provider-request-utils.js';

export class ChatRequestPlanError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ChatRequestPlanError';
        this.code = code;
        this.details = details;
    }
}

function normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map((message) => ({
        role: message?.role === 'assistant' ? 'assistant' : 'user',
        content: String(message?.content || '')
    })).filter((message) => message.content.trim());
}

function normalizeMedia(media) {
    if (!Array.isArray(media)) return [];
    return media.map((item) => ({ type: String(item?.type || ''), url: String(item?.url || '') }))
        .filter((item) => item.type || item.url);
}

function validateMedia(media, protocol, capabilities) {
    for (const item of media) {
        if (item.type !== 'image') {
            throw new ChatRequestPlanError('unsupported_media', `不支持的对话附件类型：${item.type || 'unknown'}`, { mediaType: item.type || 'unknown' });
        }
        if (capabilities?.imageInput === false) {
            throw new ChatRequestPlanError('unsupported_media', '当前模型不支持图片输入', { mediaType: 'image' });
        }
        if (protocol === 'google' && !/^data:image\/.+;base64,/i.test(item.url)) {
            throw new ChatRequestPlanError('unsupported_media_source', 'Google 对话协议仅支持可内联的图片附件', { mediaType: 'image', source: item.url });
        }
    }
}

function buildOpenAiBody({ model, messages, systemPrompt, media, systemRole = 'system' }) {
    const requestMessages = [];
    if (systemPrompt) requestMessages.push({ role: systemRole, content: systemPrompt });
    messages.forEach((message, index) => {
        const attachHere = message.role === 'user' && index === messages.map((item) => item.role).lastIndexOf('user') && media.length > 0;
        requestMessages.push({
            role: message.role,
            content: attachHere
                ? [
                    { type: 'text', text: message.content },
                    ...media.map((item) => ({ type: 'image_url', image_url: { url: item.url } }))
                ]
                : message.content
        });
    });
    return { model: model.modelId, messages: requestMessages };
}

function migrateOpenAIChatParams(body) {
    const tokenLimit = body.max_output_tokens ?? body.max_tokens;
    if (body.max_completion_tokens == null && tokenLimit != null) body.max_completion_tokens = tokenLimit;
    delete body.max_output_tokens;
    delete body.max_tokens;
    if (body.reasoning_effort == null && body.reasoning?.effort != null) body.reasoning_effort = body.reasoning.effort;
    delete body.reasoning;
}

function applyOpenAIChatLimits(body, capabilities) {
    const profile = THINKING_PROFILES[capabilities.thinkingProfile];
    if (profile && body.reasoning_effort != null && !profile.levels.includes(body.reasoning_effort)) {
        throw new ChatRequestPlanError('unsupported_parameter', `${body.model} 不支持 reasoning_effort=${body.reasoning_effort}。可用档位：${profile.levels.join('、')}。`, {
            parameter: 'reasoning_effort'
        });
    }
    if (!profile) delete body.reasoning_effort;
    if (!capabilities.verbosity) delete body.verbosity;
    if (capabilities.stop === false) delete body.stop;
    const effort = body.reasoning_effort ?? capabilities.defaultEffort;
    if (effort && effort !== 'none') {
        for (const field of ['temperature', 'top_p', 'logprobs', 'top_logprobs']) delete body[field];
    }
    if (!body.tools?.length && !body.functions?.length) return;
    if (capabilities.functionCalling === 'responses-only') {
        throw new ChatRequestPlanError('unsupported_parameter', `${body.model} 的工具调用需要 Responses API，请移除工具参数或选择支持 Chat Completions 工具调用的模型。`, {
            parameter: 'tools'
        });
    }
    if (capabilities.functionCalling === 'without-reasoning' && effort !== 'none') {
        throw new ChatRequestPlanError('unsupported_parameter', `${body.model} 在 Chat Completions 中进行工具调用时需要 reasoning_effort=none。`, {
            parameter: 'tools'
        });
    }
}

function buildGoogleBody({ messages, systemPrompt, media, searchEnabled }) {
    const lastUserIndex = messages.map((item) => item.role).lastIndexOf('user');
    const contents = messages.map((message, index) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [
            { text: message.content },
            ...(index === lastUserIndex ? media.map((item) => {
                const match = item.url.match(/^data:(.+?);base64,(.+)$/i);
                return { inlineData: { mimeType: match[1], data: match[2] } };
            }) : [])
        ]
    }));
    const body = { contents };
    if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
    if (searchEnabled) body.tools = [{ googleSearch: {} }];
    return body;
}

export function createChatRequestPlan({
    provider,
    model,
    protocol = model?.protocol,
    messages,
    systemPrompt = '',
    media = [],
    capabilities = {},
    searchEnabled = false,
    customParams = {},
    thinking
}) {
    if (!provider || !model) throw new ChatRequestPlanError('invalid_configuration', '缺少对话模型或 Provider 配置');
    const effectiveProtocol = protocol === 'google' ? 'google' : 'openai';
    const official = protocol === 'openai' ? getOpenAIChatCapabilities({ model, provider, protocol }) : null;
    if (official?.chatCompletions === false) {
        throw new ChatRequestPlanError('unsupported_model', `${model.modelId} 仅支持 Responses API，请选择支持 Chat Completions 的对话模型。`);
    }
    const normalizedMessages = normalizeMessages(messages);
    if (normalizedMessages.length === 0) throw new ChatRequestPlanError('empty_messages', '请输入提问内容');
    const normalizedMedia = normalizeMedia(media);
    validateMedia(normalizedMedia, effectiveProtocol, {
        imageInput: capabilities.imageInput !== false && official?.imageInput !== false
    });
    const baseBody = effectiveProtocol === 'google'
        ? buildGoogleBody({ messages: normalizedMessages, systemPrompt, media: normalizedMedia, searchEnabled })
        : buildOpenAiBody({ model, messages: normalizedMessages, systemPrompt, media: normalizedMedia, systemRole: official?.systemRole });
    const requestBody = { ...baseBody, ...(customParams && typeof customParams === 'object' ? customParams : {}) };
    if (official) {
        requestBody.model = baseBody.model;
        migrateOpenAIChatParams(requestBody);
    }
    applyThinking(requestBody, { model, provider, task: 'chat', protocol }, thinking);
    if (official) applyOpenAIChatLimits(requestBody, official);
    const url = resolveProviderUrl(provider, model, 'chat');
    const plan = {
        protocol: effectiveProtocol,
        method: 'POST',
        url,
        requestBody,
        provider,
        model
    };
    plan.preview = {
        protocol: effectiveProtocol,
        method: plan.method,
        url,
        contentType: 'application/json',
        provider: provider.name || provider.id || '',
        model: model.name || model.modelId || '',
        requestBody
    };
    return plan;
}

export function executeChatRequestPlan(plan, { fetchRef = fetch, headers = {}, signal } = {}) {
    if (!plan?.requestBody || !plan?.url) {
        throw new ChatRequestPlanError('invalid_plan', '对话请求计划不完整');
    }
    return fetchRef('/proxy', {
        method: plan.method || 'POST',
        headers,
        body: JSON.stringify(plan.requestBody),
        signal
    });
}

export async function requestChatCompletion(plan, { fetchRef = fetch, headers = {}, signal } = {}) {
    const response = await executeChatRequestPlan(plan, { fetchRef, headers, signal });
    if (!response.ok) {
        const body = await response.text();
        const thinkingError = /reasoning|thinking/i.test(body) ? '思考参数被接口拒绝，请检查兼容方式与档位。' : '';
        const error = new ChatRequestPlanError('provider_request_failed', `${plan.model?.name || plan.model?.modelId || '对话模型'} / ${plan.provider?.name || plan.provider?.id || 'Provider'}：对话请求失败（HTTP ${response.status}）${thinkingError}`,  {
            status: response.status,
            body: body.slice(0, 2000)
        });
        throw error;
    }
    const payload = await response.json();
    const rawText = plan.protocol === 'google'
        ? payload.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map((part) => part.text || '').join('')
        : payload.choices?.[0]?.message?.content;
    const text = Array.isArray(rawText)
        ? rawText.map((part) => typeof part === 'string' ? part : String(part?.text || '')).join('')
        : rawText;
    if (!String(text || '').trim()) throw new ChatRequestPlanError('empty_response', 'API 返回了空回复');
    return { text: String(text), payload };
}
