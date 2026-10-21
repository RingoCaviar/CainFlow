import { createChatRequestPlan, requestChatCompletion } from '../execution/chat-request-plan.js';
import { getModelsForTask, getResolvedProviderForModel } from '../execution/provider-request-utils.js';
import { getModelProtocolConfig } from '../execution/model-protocol-registry.js';
import { PROMPT_AGENT_SYSTEM_PROMPT } from './prompt-agent-instructions.js';
import { createPromptAgentInput } from './prompt-agent-input.js';
import { normalizePromptAgentParameters } from './prompt-agent-parameters.js';
import { measurePromptAgentContext } from './prompt-agent-token-budget.js';
import { resolveAgentSearchModel, normalizeAgentSearch, getConversationSearchSources } from './prompt-agent-search-data.js';
import { searchPromptAgent } from './prompt-agent-search.js';

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

function normalizeReply(payload, context, images = [], userMessage = '') {
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
    let selectedImages = imageRoles.map((item) => {
        const image = images.find((candidate) => candidate.imageId === item?.imageId);
        if (!image || !['edit-target', 'reference', 'supporting'].includes(item.role)) throw new Error('模型引用了无效的图片或图片角色');
        return { ...image.reference, imageId: image.imageId, role: item.role };
    });
    const latest = images.filter(image => image.latestResult);
    const selection = payload.targetSelection;
    const evidence = typeof selection?.evidence === 'string' ? selection.evidence.trim() : '';
    const explicitEvidence = evidence && userMessage.includes(evidence);
    const clarify = message => ({ ...reply, intent: 'clarify', message, promptPlan: null });
    if (selection && !['latest', 'explicit', 'prompt-only'].includes(selection.mode)) throw new Error('无效的编辑目标选择方式');
    if ((intent === 'edit' || intent === 'refine') && latest.length) {
        if (selection?.mode === 'explicit') {
            const target = images.find(image => image.imageId === selection.imageId);
            if (!explicitEvidence || !target) return clarify('请明确要修改哪张图片，或确认使用最新生成结果。');
            selectedImages = [{ ...target.reference, imageId: target.imageId, role: 'edit-target' },
                ...selectedImages.filter(image => image.role !== 'edit-target' && image.imageId !== target.imageId)];
        } else if (selection?.mode === 'prompt-only') {
            if (!explicitEvidence) return clarify('你希望仅修改提示词，还是继续修改最新生成的图片？');
        } else {
            const target = latest.length === 1 ? latest[0]
                : explicitEvidence ? latest.find(image => image.imageId === selection?.imageId) : null;
            if (!target) return clarify(`最新一批有 ${latest.length} 张图片，请指定要修改第几张。`);
            selectedImages = [{ ...target.reference, imageId: target.imageId, role: 'edit-target' },
                ...selectedImages.filter(image => image.role !== 'edit-target' && image.imageId !== target.imageId)];
        }
    }
    if (intent === 'edit' && !selectedImages.some((item) => item.role === 'edit-target')) {
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
    model, models = [], providers = [], fetchRef = fetch, headers = {}, getHeaders = null, signal,
    searchSettings = { mode: 'auto', modelId: '' }, searchRef = searchPromptAgent, onSearchStatus = () => {}
} = {}) {
    // Capture all configuration once, including provider order and endpoints.
    [model, models, providers, searchSettings] = JSON.parse(JSON.stringify([model, models, providers, searchSettings]));
    const assertActive = () => { if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError'); };
    assertActive();
    const provider = getResolvedProviderForModel(model, providers);
    if (!model || !provider) throw new Error('请先在设置中配置一个可用的对话模型和 Provider');
    const base = { message, context, conversation, workflowMemory, referenceImages, workflowReferenceImages, model };
    let search = null;
    for (let round = 0; round < 2; round++) {
        assertActive();
        const request = { ...base, searchAllowed: round === 0 && searchSettings.mode !== 'off', searchContext: search };
        const input = createPromptAgentInput(request);
        const plan = createChatRequestPlan({ provider, model, protocol: model.protocol, systemPrompt: PROMPT_AGENT_SYSTEM_PROMPT,
            messages: input.messages, media: input.media, capabilities: model.capabilities || {} });
        let response, payload;
        try {
            response = await requestChatCompletion(plan, { fetchRef, headers: typeof getHeaders === 'function' ? getHeaders(plan) : headers, signal });
            assertActive();
            payload = parseJson(response.text);
        } catch (error) {
            assertActive();
            if (!search) throw error;
            return { intent: 'chat', message: `检索结果已保留，但整理回复失败：${error.message}`, promptPlan: null, search };
        }
        if (payload?.searchRequest) {
            if (round !== 0) return { intent: 'chat', message: '本轮已完成一次检索；结果已保留，请继续提问以进一步搜索。', promptPlan: null, search };
            const { kind, query } = payload.searchRequest;
            if (!['web', 'images'].includes(kind) || typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('模型返回的搜索请求无效。');
            const searchModel = resolveAgentSearchModel(model, models, searchSettings, kind);
            onSearchStatus(kind === 'images' ? '正在搜索图片…' : '正在联网查找资料…');
            search = normalizeAgentSearch(await searchRef({ model: searchModel, providers, kind, query: query.trim(), fetchRef,
                getHeaders: typeof getHeaders === 'function' ? getHeaders : () => headers, signal }));
            assertActive();
            if (!search) throw new Error('搜索接口未返回有效结果。');
            onSearchStatus('正在整理检索结果…');
            continue;
        }
        let reply;
        try { reply = normalizeReply(payload, context, input.images, message); }
        catch (error) {
            if (!search) throw error;
            return { intent: 'chat', message: `检索结果已保留，但方案无效：${error.message}`, promptPlan: null, search };
        }
        const sources = [...getConversationSearchSources(conversation), ...(search?.sources || [])];
        const cited = [...reply.message.matchAll(/\[\[source:([^\]]+)\]\]/g)].map(match => match[1]);
        if (cited.some(id => !sources.some(source => source.id === id))) {
            if (search) return { intent: 'chat', message: '模型引用了不存在的来源，已阻止展示该回复；真实检索结果保留在下方，请重试。', promptPlan: null, search };
            throw new Error('模型引用了不存在的搜索来源，请重试。');
        }
        if (search) for (const source of sources) {
            if (cited.includes(source.id) && !search.sources.some(item => item.id === source.id)) search.sources.push(source);
        }
        if (search) reply.search = search;
        else if (cited.length) reply.search = normalizeAgentSearch({ sources: sources.filter(source => cited.includes(source.id)), notice: '引用此前检索来源，本轮未重新联网。' });
        const inputTokens = model.protocol === 'google' ? response.payload?.usageMetadata?.promptTokenCount : response.payload?.usage?.prompt_tokens;
        if (Number.isSafeInteger(inputTokens) && inputTokens > 0) reply.tokenObservation = { inputTokens, measurement: measurePromptAgentContext(request) };
        return reply;
    }
}
