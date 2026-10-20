import { createChatRequestPlan, requestChatCompletion } from '../execution/chat-request-plan.js';
import { getModelsForTask, getResolvedProviderForModel } from '../execution/provider-request-utils.js';
import { getModelProtocolConfig } from '../execution/model-protocol-registry.js';
import { PROMPT_AGENT_SYSTEM_PROMPT } from './prompt-agent-instructions.js';
import { createPromptAgentInput } from './prompt-agent-input.js';
import { normalizePromptAgentParameters } from './prompt-agent-parameters.js';

export function getAvailablePromptAgentModels(models = [], providers = []) {
    return getModelsForTask(models, 'chat').filter((model) => {
        if (!model?.id || !model?.modelId || !getModelProtocolConfig(model.protocol)?.defaultTaskTypes.includes('chat')) return false;
        const provider = getResolvedProviderForModel(model, providers);
        return Boolean(String(provider?.endpoint || '').trim());
    });
}

function parseJson(text) {
    const value = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(value); } catch {
        const start = value.indexOf('{');
        const end = value.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try { return JSON.parse(value.slice(start, end + 1)); } catch { /* use the actionable error below */ }
        }
        throw new Error('模型返回的 Prompt Plan 不是有效 JSON');
    }
}

function normalizeReply(payload, context, images = []) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('模型返回了无效的 Prompt Plan');
    // Accept older flat plans, while giving conversation-only replies an
    // explicit representation rather than forcing invented image requests.
    const plan = Object.hasOwn(payload, 'promptPlan') ? payload.promptPlan : (payload.prompt ? payload : null);
    const intent = payload.intent || (plan ? 'generate' : 'chat');
    if (!['chat', 'clarify', 'generate', 'edit', 'refine'].includes(intent)) throw new Error('模型返回了无效的意图类型');
    const reply = {
        intent,
        message: typeof payload.message === 'string' ? payload.message.trim() : '',
        workSummary: Array.isArray(payload.workSummary)
            ? payload.workSummary.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 3)
            : [],
        promptPlan: null
    };
    if (intent === 'chat' || intent === 'clarify') {
        if (!reply.message) throw new Error('模型没有返回可用的回复');
        return reply;
    }
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || typeof plan.prompt !== 'string' || !plan.prompt.trim()) {
        throw new Error('模型没有返回可用的 Prompt');
    }
    if (plan.negativePrompt != null && typeof plan.negativePrompt !== 'string') throw new Error('负面提示词必须是文本');
    const parameters = normalizePromptAgentParameters(plan.parameters ?? {}, context ? context.parameterSchema : {});
    const imageRoles = plan.imageRoles ?? [];
    if (!Array.isArray(imageRoles)) throw new Error('图片角色必须是数组');
    const selectedImages = imageRoles.map((item) => {
        const image = images.find((candidate) => candidate.imageId === item?.imageId);
        if (!image || !['edit-target', 'reference', 'supporting'].includes(item.role)) throw new Error('模型引用了无效的图片或图片角色');
        return { ...image.reference, imageId: image.imageId, role: item.role };
    });
    if (intent === 'edit' && !imageRoles.some((item) => item.role === 'edit-target')) {
        throw new Error('编辑方案缺少明确的目标图片，请指定要修改的图片');
    }
    return {
        ...reply,
        message: reply.message || '已整理 Prompt Plan。',
        promptPlan: {
            targetNodeId: context?.nodeId || null,
            prompt: plan.prompt.trim(),
            ...(typeof plan.negativePrompt === 'string' ? { negativePrompt: plan.negativePrompt.trim() } : {}),
            parameters,
            referenceImages: selectedImages
        }
    };
}

export async function createPromptAgentModelReply({
    message = '', context = null, conversation = null, workflowMemory = '', referenceImages = [], workflowReferenceImages = [],
    model, providers = [], fetchRef = fetch, headers = {}, getHeaders = null, signal
} = {}) {
    const provider = getResolvedProviderForModel(model, providers);
    if (!model || !provider) throw new Error('请先在设置中配置一个可用的对话模型和 Provider');
    const input = createPromptAgentInput({
        message, context, conversation, workflowMemory, referenceImages, workflowReferenceImages, model
    });
    const plan = createChatRequestPlan({
        provider, model, protocol: model.protocol, systemPrompt: PROMPT_AGENT_SYSTEM_PROMPT,
        messages: input.messages, media: input.media, capabilities: model.capabilities || {}
    });
    const response = await requestChatCompletion(plan, {
        fetchRef, headers: typeof getHeaders === 'function' ? getHeaders(plan) : headers, signal
    });
    return normalizeReply(parseJson(response.text), context, input.images);
}
