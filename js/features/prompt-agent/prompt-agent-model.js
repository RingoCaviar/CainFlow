import { createChatRequestPlan, requestChatCompletion } from '../execution/chat-request-plan.js';
import { getModelsForTask, getResolvedProviderForModel } from '../execution/provider-request-utils.js';
import { getModelProtocolConfig } from '../execution/model-protocol-registry.js';

export function getAvailablePromptAgentModels(models = [], providers = []) {
    return getModelsForTask(models, 'chat').filter((model) => {
        if (!model?.id || !model?.modelId || !getModelProtocolConfig(model.protocol)?.defaultTaskTypes.includes('chat')) return false;
        const provider = getResolvedProviderForModel(model, providers);
        return Boolean(String(provider?.endpoint || '').trim());
    });
}

const SYSTEM_PROMPT = `你是 CainFlow 的 Prompt Agent。请根据用户要求、当前生图节点和工作流上下文，生成可直接检查的 Prompt Plan。
只返回一个 JSON 对象，不要 Markdown 代码围栏，不要解释推理过程。字段必须是：
{"message": string, "workSummary": string[], "prompt": string, "negativePrompt": string, "parameters": object}。
message 是简短回复；workSummary 最多 5 条可观察步骤；parameters 只能包含适合当前节点的生成参数。不要输出 targetNodeId，客户端会绑定当前明确选中的节点。`;

function parseJson(text) {
    const value = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(value); } catch {
        const start = value.indexOf('{');
        const end = value.lastIndexOf('}');
        if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
        throw new Error('模型返回的 Prompt Plan 不是有效 JSON');
    }
}

function normalizeReply(payload, context, referenceImages = []) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('模型返回了无效的 Prompt Plan');
    const plan = payload.promptPlan && typeof payload.promptPlan === 'object' ? payload.promptPlan : payload;
    const prompt = String(plan.prompt || '').trim();
    if (!prompt) throw new Error('模型没有返回可用的 Prompt');
    const parameters = plan.parameters && typeof plan.parameters === 'object' && !Array.isArray(plan.parameters)
        ? { ...plan.parameters } : {};
    return {
        message: String(payload.message || '已生成 Prompt Plan。').slice(0, 500),
        workSummary: Array.isArray(payload.workSummary)
            ? payload.workSummary.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5)
            : ['读取当前生图节点', '根据模型回复整理 Prompt Plan'],
        promptPlan: {
            targetNodeId: context?.nodeId || null,
            prompt,
            negativePrompt: String(plan.negativePrompt || '').trim(),
            parameters,
            referenceImages
        }
    };
}

export async function createPromptAgentModelReply({
    message = '', context = null, workflowMemory = '', referenceImages = [], workflowReferenceImages = [],
    model, providers = [], fetchRef = fetch, headers = {}, getHeaders = null, signal
} = {}) {
    const provider = getResolvedProviderForModel(model, providers);
    if (!model || !provider) throw new Error('请先在设置中配置一个可用的对话模型和 Provider');
    const media = referenceImages.filter((item) => /^data:image\/.+;base64,/i.test(String(item?.dataUrl || '')))
        .map((item) => ({ type: 'image', url: item.dataUrl }));
    const contextText = [
        context ? `当前生图节点：${JSON.stringify({
            prompt: context.prompt || '', negativePrompt: context.negativePrompt || '', parameters: context.parameters || {},
            referenceImages: context.referenceImages || []
        })}` : '当前没有明确选中的生图节点。',
        workflowMemory ? `工作流上下文：${workflowMemory}` : '',
        workflowReferenceImages.length ? `工作流参考图数量：${workflowReferenceImages.length}` : ''
    ].filter(Boolean).join('\n');
    const plan = createChatRequestPlan({
        provider, model, protocol: model.protocol, systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `${contextText}\n\n用户要求：${String(message || '').trim()}` }],
        media, capabilities: model.capabilities || {}
    });
    const response = await requestChatCompletion(plan, {
        fetchRef, headers: typeof getHeaders === 'function' ? getHeaders(plan) : headers, signal
    });
    return normalizeReply(parseJson(response.text), context, referenceImages);
}
