import { createChatRequestPlan, requestChatCompletion } from '../execution/chat-request-plan.js';
import { getModelsForTask, getResolvedProviderForModel } from '../execution/provider-request-utils.js';
import { getModelProtocolConfig } from '../execution/model-protocol-registry.js';
import { getPromptAgentInstructions } from './prompt-agent-instructions.js';
import { createPromptAgentInput } from './prompt-agent-input.js';
import { normalizePromptAgentParameters } from './prompt-agent-parameters.js';
import { measurePromptAgentContext } from './prompt-agent-token-budget.js';
import { getAgentSearchAvailability, normalizeAgentSearch, getConversationSearchSources } from './prompt-agent-search-data.js';
import { searchPromptAgent } from './prompt-agent-search.js';
import { normalizeCanvasPlan } from './prompt-agent-canvas-plan.js';

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
    searchSettings = { mode: 'auto', modelId: '' }, searchRef = searchPromptAgent, onSearchStatus = () => {}, canvasContext = null,
    getCanvasImage = async () => null
} = {}) {
    // Capture all configuration once, including provider order and endpoints.
    [model, models, providers, searchSettings] = JSON.parse(JSON.stringify([model, models, providers, searchSettings]));
    const assertActive = () => { if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError'); };
    assertActive();
    const provider = getResolvedProviderForModel(model, providers);
    if (!model || !provider) throw new Error('请先在设置中配置一个可用的对话模型和 Provider');
    const base = { message, context, conversation, workflowMemory, referenceImages, workflowReferenceImages, model, canvasContext };
    const canvasReads = [];
    let search = null;
    let searchUsed = false;
    for (let round = 0; round < 10; round++) {
        assertActive();
        const request = { ...base, canvasReads, searchAllowed: !searchUsed && searchSettings.mode !== 'off', searchContext: search };
        if (canvasReads.length && measurePromptAgentContext(request).reached) throw new Error('画布详情达到本轮上下文预算，未读取部分无法确认；请用 @节点 缩小范围或先压缩上下文');
        const input = createPromptAgentInput(request);
        const plan = createChatRequestPlan({ provider, model, protocol: model.protocol, systemPrompt: getPromptAgentInstructions(canvasContext),
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
        if (payload?.canvasRead) {
            if (!canvasContext || canvasReads.length >= 6) throw new Error('本轮画布读取已达预算，请缩小节点范围后继续；未读取内容不能确认。');
            const detail = canvasContext.read(payload.canvasRead);
            const requestedImages = payload.canvasRead.images || [];
            if (!Array.isArray(requestedImages) || requestedImages.length > 4) throw new Error('每次画布读取最多查看四张指定原图');
            detail.imageReads = [];
            for (const item of requestedImages) {
                const node = canvasContext.nodes.find(node => node.id === item?.nodeId);
                const index = item?.index ?? 0;
                if (!node || !Number.isInteger(index) || index < 0 || !node.assets[index]) throw new Error('指定画布图片不存在或原图资产缺失');
                const assetKey = node.assets[index];
                const dataUrl = await getCanvasImage(assetKey);
                assertActive();
                if (typeof dataUrl !== 'string' || !/^data:image\/[^;]+;base64,/i.test(dataUrl)) throw new Error(`「${node.name}」原图读取失败，不能确认图片内容`);
                const referenceId = `canvas:${node.id}:${index}:${assetKey}`;
                if (!base.workflowReferenceImages.some(image => image.referenceId === referenceId)) {
                    base.workflowReferenceImages = [...base.workflowReferenceImages, { referenceId, sourceNodeId: node.id,
                        sourcePort: 'image', sourceImageIndex: index, assetKey, dataUrl,
                        name: `${node.name} [${node.id}] 第 ${index + 1} 张`, contextOrigin: '按需读取的画布原图' }];
                }
                detail.imageReads.push({ nodeId: node.id, index, assetKey, pixelsAvailable: model.capabilities?.imageInput !== false });
            }
            canvasReads.push(detail);
            onSearchStatus(`正在读取画布详情（${canvasReads.length}/6）…`);
            continue;
        }
        if (payload?.searchRequest) {
            if (searchUsed) return { intent: 'chat', message: '本轮已完成一次检索；结果已保留，请继续提问以进一步搜索。', promptPlan: null, search };
            searchUsed = true;
            const { kind, query } = payload.searchRequest;
            if (!['web', 'images'].includes(kind) || typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('模型返回的搜索请求无效。');
            const availability = getAgentSearchAvailability({ model, models, providers, settings: searchSettings, kind });
            if (!availability.available) throw new Error(`${availability.message}，请打开联网菜单完成配置。`);
            const searchModel = availability.model;
            onSearchStatus(kind === 'images' ? '正在搜索图片…' : '正在联网查找资料…');
            search = normalizeAgentSearch(await searchRef({ model: searchModel, providers, kind, query: query.trim(), fetchRef,
                getHeaders: typeof getHeaders === 'function' ? getHeaders : () => headers, signal }));
            assertActive();
            if (!search) throw new Error('搜索接口未返回有效结果。');
            onSearchStatus('正在整理检索结果…');
            continue;
        }
        let reply;
        try {
            if (payload.canvasPlan && ['edit', 'refine'].includes(payload.intent)) {
                // Reuse the established latest-result selection gate before accepting a graph.
                const targetReply = normalizeReply({ ...payload, canvasPlan: undefined, promptPlan: {
                    prompt: '画布续改目标检查', imageRoles: (payload.canvasPlan.steps || []).filter(step => step.imageId).map(step => ({ imageId: step.imageId, role: 'edit-target' }))
                } }, null, input.images, message);
                if (targetReply.intent === 'clarify') return targetReply;
                const selected = targetReply.promptPlan.referenceImages.find(image => image.role === 'edit-target');
                if (selected && !(payload.canvasPlan.steps || []).some(step => step.imageId === selected.imageId)) {
                    throw new Error('多步骤续改未引用正确的最新结果，请指定要编辑的图片后重新整理方案');
                }
            }
            reply = payload.canvasPlan && canvasContext ? {
                intent: 'generate', message: String(payload.message || '已整理画布操作方案，请检查变更清单。'), promptPlan: null,
                canvasPlan: normalizeCanvasPlan(payload.canvasPlan, canvasContext, { message, mentionedIds: canvasContext.summary.mentionedIds, images: input.images })
            } : normalizeReply(payload, context, input.images, message);
        }
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
