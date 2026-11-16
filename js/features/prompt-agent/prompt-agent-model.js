import { orderImageReferenceConnections } from '../../nodes/image-reference-projection.js';
import { getImageGenerateExtraProtocol, getImageParameterValues, supportsImageWebSearch } from '../../nodes/image-parameter-controls.js';
import { resolveImageGenerationInputContract } from '../../nodes/universal-input-policy.js';
import { resolveAgentProvider } from './prompt-agent-provider.js';
import { trackAgentRequest } from './prompt-agent-request.js';
import { createChatRequestPlan, requestChatCompletion } from '../execution/chat-request-plan.js';
import { getOpenAIChatCapabilities } from '../execution/openai-chat-capabilities.js';
import { getEffectiveProtocol, getModelsForTask, getModelProviders } from '../execution/provider-request-utils.js';
import { getModelProtocolConfig } from '../execution/model-protocol-registry.js';
import { getProtocol } from '../execution/protocols/index.js';
import { getPromptAgentInstructions } from './prompt-agent-instructions.js';
import { normalizePromptAgentChoices } from './prompt-agent-choices.js';
import { createPromptAgentInput } from './prompt-agent-input.js';
import { imageRequestProtocolFields, normalizePromptAgentParameters } from './prompt-agent-parameters.js';
import { measurePromptAgentContext } from './prompt-agent-token-budget.js';
import { getAgentSearchAvailability, normalizeAgentSearch, getConversationSearchSources } from './prompt-agent-search-data.js';
import { searchPromptAgent } from './prompt-agent-search.js';
import { normalizeCanvasPlan } from './prompt-agent-canvas-plan.js';
import { buildCanvasImageBatch, selectedCanvasImageBatchSources } from './prompt-agent-canvas-image-batch.js';
import { excludesReferenceImages, mayUseCandidate, referenceInputChangePermission } from './prompt-agent-reference-policy.js';
import { canvasPlanReferenceImages, assertPromptOnlyReferenceRecipe } from './prompt-agent-reference-inputs.js';

const directCreationRequest = /^(?:(?:请|帮我|给我|我要|我想|现在|这次|本轮)\s*)*(?:生成|画(?:一|个|只|幅|张|出)|创作|制作|设计|generate\b|draw\b|create\b)\s*\S/i;
const outputAspect = /画幅|画面(?:宽高)?比|宽高比|比例|aspect ratio|canvas size/i;
const subjectAspect = /(?:产品|商品|物体|主体|人物|桌子|尺寸关系).{0,8}的?(?:相对)?比例|(?:相对|大小|身材)比例/;
const referenceMatch = /参考|一致|接近|贴近|一样|相同|跟随|沿用|保持|按|照|match|same|follow/i;
const imageOrdinal = /(?:图(?:片)?\s*([1-9]\d*|[一二三四五六七八九十]+)|第\s*([1-9]\d*|[一二三四五六七八九十]+)\s*张|\bimage\s*#?\s*([1-9]\d*))/gi;
const literalAspect = /(?:^|[^\d])([1-9]\d{0,3})\s*[:：]\s*([1-9]\d{0,3})(?!\d)/;
const priorReference = /(?:之前|上次|上一[轮张版]|刚才|历史|刚生成|生成的第)|\b(?:previous|earlier)\b/i;
const referenceNegation = /(?:不(?:要|用|必|能|会|再|需要|允许)|别|无需|避免|do not|don't|without)[^，,。]{0,8}(?:参考|跟随|照|按|接近|贴近|match|follow)/i;
const explicitAspect = /画幅|画面(?:宽高)?比|宽高比|aspect ratio|canvas size/i;
const nonCanvasDirection = /(?:方形|正方形|横向|竖向)(?:的)?(?:桌子|物体|产品|商品|盒子|人物|构图元素)/;
const namedImageMention = /@[^@\[\]\r\n]+\[([^\]\r\n]+)\]/g;
const taskWideEvidence = /(?:每|各)(?:一)?张|(?:所有|全部|全都|统一)|(?:两|几|多|[2-9二三四五六七八九十])张都|\b(?:all|every|both)\b/i;
const aspectDirections = [
    [/(?:横[版幅图向]|宽屏|landscape)/i, (width, height) => width > height],
    [/(?:竖[版幅图向]|直[式版幅]|portrait)/i, (width, height) => width < height],
    [/(?:正方形|方[版幅图]|square)/i, (width, height) => width === height]
];

function canvasInstructionText(message) {
    // Only the current user message can select a batch or authorize running it.
    // Ignore quoted prompts and labels inside the stable @node token.
    return message.replaceAll(namedImageMention, ' ')
        .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|\x60[^\x60]*\x60/g, ' ');
}

const refersToCanvasSelection = text => /选中|所选|(?:这些|这批)(?:图|节点|素材)|\bselected\b/i.test(text);

function requestedCanvasAction(text, batch = false) {
    const hypothetical = /(?:如何|怎么|怎样|假设|假如|举个例|\bhow (?:to|do|does)\b|\bwhat if\b)/i;
    const preview = /(?:先|只|仅)(?:帮我)?(?:看|看看|列|给|说|规划|设计|预览).{0,8}(?:方案|流程|步骤)|先(?:看看|讨论|聊聊)|(?:不想|不希望|先不|别|不要|暂不|不用|禁止)[^，,。！？；;\n]{0,12}(?:新建|创建|搭建|添加|应用|连线|建图|改图|改画布)|\b(?:preview only|discuss first)\b|\b(?:do not|don't|without|avoid)\b[^.,;!?]{0,25}\b(?:build|apply|create|add)\b/i;
    const requiresApproval = /(?:等(?:待)?|先(?:让|给|由))(?:我(?:们)?|用户)?(?:先|再)?(?:确认|审批|批准|审核|同意)|(?:我(?:们)?|用户)(?:确认|批准|同意)(?:之?后|了再|再)|\b(?:wait for|until|after|once|pending)\s+(?:my\s+(?:confirmation|approval)|(?:i|we)\s+(?:confirm|approve))\b/i;
    if (hypothetical.test(text) || preview.test(text) || requiresApproval.test(text)) return undefined;
    const hold = /(?:不要|不用|不必|不许|不需要|别|无需|禁止|停止|取消|暂停|暂缓|暂不|等.{0,12}再|我来|我自己|由我|手动)[^。！？；;，,\n]{0,14}(?:运行|执行|跑|出图|生图|生成)|不\s*(?:运行|执行|跑)|(?:只|仅)(?:帮我)?(?:建(?:节点|图|工作流)|搭建|连(?:线|好)|编写提示词)|\b(?:do not|don't|without|before|i will|i'll|manually)\b[^.,;!?]{0,25}\b(?:run|running|execute|executing)\b/i;
    const run = /(?:^|[。！，,;；\n]|然后|并且?|接着|完成后|连好后)\s*(?:(?:请|帮我|再|直接|自动|立即|马上|批量|逐张)\s*)*(?:运行(?!状态|说明|日志|能力|模式|原理|方法|设置)|执行(?!状态|说明|日志|原理|方法)|开跑|跑(?=一下|批处理|整批|完|起来|这批|$|[。！，,;；\n]))|(?:^|[.!;,]|\band\b|\bthen\b)\s*(?:(?:please|automatically|immediately|also)\s+)*(?:run|execute)\b/i.test(text);
    const generate = batch && /(?:^|[。！，,;；\n]|然后|并且?|接着)\s*(?:(?:请|帮我|直接|自动|立即|马上)\s*)*(?:批量|逐张)(?:生图|出图|生成)(?!方案|配置|设置|流程|方法|要怎么)/.test(text);
    const build = /(?:建(?:图|立|节点|工作流)|搭建|去配就行|连(?:线|接|好))|\b(?:build|connect|apply)\b/i.test(text);
    const createNow = /(?:直接|自动|立即|马上)\s*(?:新建|创建|搭建|添加|应用|连线)|\b(?:automatically|immediately)\s+(?:build|apply|create|add)\b/i.test(text);
    if (!batch && !createNow) return undefined;
    if ((run || generate) && !hold.test(text)) return 'run';
    return build || createNow ? 'apply' : undefined;
}

function canvasImageBatchRequest(context, message, referenceImages) {
    if (!context || referenceImages.length || excludesReferenceImages(message)) return null;
    const text = canvasInstructionText(message);
    if (!/(?:批量|批处理|逐张|逐图|每(?:一)?张|每个都|分别|给.{0,12}张.{0,4}(?:图|图片)|\bbatch\b|\beach image\b)/i.test(text)
        || !/(?:提示词|出图|生图|图生图|生成|\bprompt\b|\bgenerate\b)/i.test(text)
        || /(?:如何|怎么|怎样|假设|举个例|除了|排除|跳过|(?:只|仅)(?:处理|选|取|限|对)?\s*[前后第]|(?:不同|独立|单独).{0,6}提示词|\bhow (?:to|do|does)\b|\bwhat if\b|\bexcept\b|\bdifferent prompts\b)/i.test(text)) return null;
    if (/(?:运行|执行|重跑|重试)[^，,。！？；;\n]{0,12}(?:生图|生成)节点|\b(?:run|rerun|execute)\b[^.,;!?]{0,35}\bnodes?\b/i.test(text)
        && !/(?:逐张|逐图|每(?:一)?张|每个都|(?:同|共用|共享|一个).{0,6}提示词|\beach image\b)/i.test(text)) return null;

    const imageNodes = context.nodes.filter(node => node.outputs.some(port => port.type === 'image'));
    const configMention = (request, start, end) => /^(?:\s*的)?\s*(?:配置|参数|提示词|设置|模板)/.test(request.slice(end))
        || /(?:配置|参数|提示词|设置|模板)\s*(?:用|沿用|来自|按|取自|参考|套用|为|是)\s*$/.test(request.slice(0, start));
    const configIds = new Set([...message.matchAll(namedImageMention)].filter(match =>
        configMention(message, match.index, match.index + match[0].length)).map(match => match[1]));
    const namedNodes = imageNodes.filter(node => node.name?.length > 1 && text.includes(node.name)
        && context.nodes.filter(candidate => candidate.name === node.name).length === 1)
        .sort((a, b) => text.indexOf(a.name) - text.indexOf(b.name));
    for (const node of namedNodes) {
        const index = text.indexOf(node.name);
        if (configMention(text, index, index + node.name.length)) configIds.add(node.id);
    }
    const mentioned = (context.summary?.mentionedIds || []).filter(id => !configIds.has(id) && imageNodes.some(node => node.id === id));
    const named = refersToCanvasSelection(text) ? [] : namedNodes.map(node => node.id).filter(id => !configIds.has(id));
    const sourceNodeIds = mentioned.length ? mentioned : named.length ? named : selectedCanvasImageBatchSources(context)
        .filter(id => !configIds.has(id));
    if (!sourceNodeIds.length) return null;

    return { sourceNodeIds, mode: requestedCanvasAction(text, true) };
}

function normalizeCanvasBatch(raw, batch, context, message) {
    if (!batch || !raw || typeof raw !== 'object' || Array.isArray(raw)
        || Object.keys(raw).some(key => key !== 'prompt' && key !== 'parameters')) {
        throw new Error('批处理方案只能提供共享提示词和参数，图片范围由用户请求和画布选择确定。');
    }
    const { prompt, parameters } = raw;
    const recipe = buildCanvasImageBatch(context, { sourceNodeIds: batch.sourceNodeIds, prompt, parameters });
    const plan = normalizeCanvasPlan(recipe, context, { message, batchSourceNodeIds: batch.sourceNodeIds,
        referencePolicy: { intent: 'generate' } });
    plan.imageBatch = true;
    return plan;
}

function canApplyAdditiveCanvasPlan(plan, context, text, images) {
    if (!plan || plan.imageBatch || plan.deletes.length || plan.disconnects.length || plan.steps.some(step => step.nodeId)) return false;
    const selectedIds = refersToCanvasSelection(text) ? context.summary.selectedIds : [];
    const allowed = new Set([...selectedIds, ...context.summary.mentionedIds]);
    for (const node of context.nodes) {
        if (node.name?.length > 1 && text.includes(node.name) && context.nodes.filter(candidate => candidate.name === node.name).length === 1) {
            allowed.add(node.id);
        }
    }
    const attached = new Set(images.filter(image => image.origins.includes('本轮附件'))
        .map(image => image.reference.assetKey || image.reference.assetKeys?.[image.sourceImageIndex ?? 0]).filter(Boolean));
    return plan.dependencies.every(id => allowed.has(id))
        && plan.steps.every(step => !step.assetKey || allowed.has(step.assetSourceNodeId) || attached.has(step.assetKey));
}

const proposalFields = new Set(['aspectRatio', 'resolution', 'customWidth', 'customHeight', 'count',
    'quality', 'moderation', 'background', 'search', 'protocolParams']);

export function imageParameterCapabilities(model, provider) {
    if (!model) return null;
    const protocol = getEffectiveProtocol(model, provider);
    const parameters = { count: { type: 'integer', minimum: 1, maximum: 20 } };
    for (const [key, values] of Object.entries(getImageParameterValues(protocol, model.modelId))) {
        if (values.length) parameters[key] = { type: 'string', enum: ['', ...values] };
    }
    if (['google', 'ttapi'].includes(protocol) && supportsImageWebSearch(protocol, model.modelId)) {
        parameters.search = { type: 'boolean' };
    }

    const protocolParameters = getImageGenerateExtraProtocol(getProtocol(protocol), model.modelId)?.parameters || {};
    const properties = Object.fromEntries(Object.values(protocolParameters).flatMap(parameter => {
        if (parameter.id !== 'systemPrompt' && !(imageRequestProtocolFields[protocol] || []).includes(parameter.id)) return [];
        const type = { select: 'string', textarea: 'string', number: 'number', toggle: 'boolean' }[parameter.uiControl];
        if (!type) return [];
        const schema = { type };
        if (parameter.uiControl === 'select') schema.enum = (parameter.options || []).map(option => String(option.value ?? ''));
        if (Number.isFinite(parameter.min)) schema.minimum = parameter.min;
        if (Number.isFinite(parameter.max)) schema.maximum = parameter.max;
        if (protocol === 'openai' && parameter.id === 'output_compression') schema.requiresOutputFormat = ['jpeg', 'webp'];
        return [[parameter.id, schema]];
    }));
    if (Object.keys(properties).length) parameters.protocolParams = { type: 'object', properties };
    const inputs = resolveImageGenerationInputContract({ models: [{ ...model, protocol }] }, { apiConfigId: model.id });
    const maxReferences = inputs.supportsReferences ? inputs.maxReferences : 0;
    return { parameters, ...(!inputs.error && Number.isFinite(maxReferences) ? { maxReferences } : {}) };
}

function ordinalValue(text) {
    const digit = value => '一二三四五六七八九'.indexOf(value) + 1;
    if (/^\d+$/.test(text)) return Number(text);
    if (text === '十') return 10;
    const [tens, units] = text.split('十');
    return units === undefined ? digit(tens) : (tens ? digit(tens) : 1) * 10 + (units ? digit(units) : 0);
}

function scopeImageIntent(reply, raw, normalize) {
    const steps = reply.canvasPlan?.steps.filter(step => step.type === 'ImageGenerate');
    if (!steps || steps.length === 1) return normalize(raw, true) ?? (steps ? normalize(raw?.steps?.[steps[0].id]) : undefined);
    const scoped = Object.fromEntries(steps.flatMap(step => {
        const intent = normalize(raw?.steps?.[step.id]);
        return intent ? [[step.id, intent]] : [];
    }));
    const shared = typeof raw?.evidence === 'string' && taskWideEvidence.test(raw.evidence) ? normalize(raw) : undefined;
    if (Object.keys(scoped).length) {
        return { steps: Object.fromEntries(steps.flatMap(step => {
            const intent = scoped[step.id] || shared;
            return intent ? [[step.id, intent]] : [];
        })) };
    }
    return steps.length ? shared : undefined;
}

function normalizeSizeIntent(raw, reply, input, message) {
    if (!reply.promptPlan && !reply.canvasPlan) return undefined;
    const normalize = (request, allowFallback = false) => {
        const evidence = typeof request?.evidence === 'string' ? request.evidence.trim() : '';
        const quoted = evidence && message.includes(evidence);
        if (quoted && typeof request.aspectRatio === 'string' && !subjectAspect.test(evidence)) {
            const ratio = evidence.match(literalAspect);
            if (ratio) return { aspectRatio: `${ratio[1]}:${ratio[2]}`, evidence };
            const suggested = request.aspectRatio.match(/^([1-9]\d{0,3}):([1-9]\d{0,3})$/);
            const directionNegated = /(?:不要|别|无需|避免|不做|do not|don't|avoid)/i.test(evidence);
            if (suggested && !directionNegated && !nonCanvasDirection.test(evidence)
                && aspectDirections.some(([pattern, accepts]) => pattern.test(evidence) && accepts(Number(suggested[1]), Number(suggested[2])))) {
                return { aspectRatio: suggested[0], approximate: true, evidence };
            }
        }
        const referenceClause = clause => outputAspect.test(clause) && (explicitAspect.test(clause) || !subjectAspect.test(clause))
            && referenceMatch.test(clause) && !referenceNegation.test(clause) && !literalAspect.test(clause);
        const clauses = message.split(/[，。；！？,;!?\n]/).map(clause => clause.trim());
        const direct = clauses.filter(clause => referenceClause(clause) && (/图|第\s*[1-9一二三四五六七八九十]+\s*张|\bimage\b/i.test(clause)));
        const clause = quoted && referenceClause(evidence) && typeof request.referenceImageId === 'string' ? evidence
            : allowFallback && direct.length === 1 ? direct[0] : null;
        if (!clause) return undefined;

        const ordinals = new Set([...clause.matchAll(imageOrdinal)].map(match => ordinalValue(match[1] || match[2] || match[3])));
        const tokens = new Set(clause.match(/@图片\d+(?![\d\[])/g));
        const nodeIds = new Set([...clause.matchAll(namedImageMention)].map(match => match[1]));
        const mentions = input.images.filter(image => nodeIds.has(image.sourceNodeId) || image.mentionTokens?.some(token => tokens.has(token)));
        const current = input.images.filter(image => image.referenceNumbers?.length);
        const named = input.images.filter(image => image.name?.length > 1 && clause.includes(image.name));
        const modelImage = quoted && input.images.find(image => image.imageId === request?.referenceImageId);
        let image;
        if (mentions.length) image = mentions.length === 1 ? mentions[0] : null;
        else if (ordinals.size && current.length && !priorReference.test(clause)) {
            const [ordinal] = ordinals;
            if (ordinals.size === 1) image = current.find(candidate => candidate.referenceNumbers.includes(ordinal));
        } else if (named.length) image = named.length === 1 ? named[0] : null;
        else if (modelImage && (priorReference.test(clause) || modelImage.referenceNumbers?.length || current.length === 0)) image = modelImage;
        else if (!ordinals.size && current.length === 1 && /(?:这|该|原)(?:张|幅)?图/.test(clause)) image = current[0];

        if (!image?.width || !image.height) return { referenceUnavailable: true, evidence: clause,
            ...(image?.name ? { referenceLabel: image.name } : {}) };
        return { referenceSize: { width: image.width, height: image.height }, referenceLabel: image.name, evidence: clause };
    };
    return scopeImageIntent(reply, raw, normalize);
}

function explicitImageParameters(text) {
    // Image captions and quoted text are content rather than control values.
    const clauses = text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"/g, '').split(/[，。；！？,;!?\n]/);
    const parameters = {};
    const protocolParams = {};
    for (const clause of clauses) {
        const search = clause.match(/(不(?:要|用|需要|开启|使用|联网)|别|禁止|无需|关闭|禁用|取消|开启|启用|使用|允许|打开|disable|enable|without|with)\s*(?:生图|图片生成)?\s*(?:联网(?:搜索|检索)?|web search)/i);
        if (search) parameters.search = !/^(?:不|别|禁止|无需|关闭|禁用|取消|disable|without)/i.test(search[1]);
        else if (/(?:用|通过|先)(?:生图)?联网(?:搜索|检索).{0,20}(?:生成|制作|画)|(?:生图|生成时|出图时)(?:请)?联网(?:搜索|检索)?/.test(clause)) parameters.search = true;

        const format = clause.match(/(?:输出格式|图片格式|文件格式|图像格式|output.format)\s*(?:设为|设置为|改为|改成|用|是|为|[:：=])?\s*\.?\b(png|webp|jpe?g)\b/i)
            || clause.match(/(?:输出|保存|导出)(?:为|成)?\s*\.?\b(png|webp|jpe?g)\b/i);
        if (format) protocolParams.output_format = format[1].toLowerCase().replace(/^jpg$/, 'jpeg');
        const compression = clause.match(/(?:输出压缩(?:率)?|压缩率|output.compression)\s*(?:设为|设置为|改为|改成|用|为|[:：=])?\s*(\d{1,3})(?:\s*[%％])?(?!\d)/i);
        if (compression) protocolParams.output_compression = Number(compression[1]);
        const fidelity = clause.match(/(?:参考图保真度|input.fidelity)\s*(?:设为|设置为|改为|用|为|[:：=])?\s*(high|low|高|低)/i);
        if (fidelity) protocolParams.input_fidelity = ({ 高: 'high', 低: 'low' })[fidelity[1]] || fidelity[1].toLowerCase();
        const complexity = clause.match(/(?:构图规划(?:档位)?|complexity)\s*(?:设为|设置为|改为|用|为|[:：=])?\s*(high|medium|low|高|中|低)/i);
        if (complexity) protocolParams.complexity = ({ 高: 'high', 中: 'medium', 低: 'low' })[complexity[1]] || complexity[1].toLowerCase();
        const response = clause.match(/(?:返回格式|response.format)\s*(?:设为|设置为|改为|用|为|[:：=])?\s*\b(url|b64_json|base64)\b/i);
        if (response) protocolParams.response_format = response[1].toLowerCase().replace(/^base64$/, 'b64_json');
        const style = clause.match(/(?:API\s*风格|(?:^|\s)style)\s*(?:设为|设置为|改为|用|为|[:：=])?\s*\b(vivid|natural)\b/i);
        if (style) protocolParams.style = style[1].toLowerCase();
    }
    if (Object.keys(protocolParams).length) parameters.protocolParams = protocolParams;
    return Object.keys(parameters).length ? parameters : undefined;
}

function normalizeImageParameterIntent(raw, reply, message) {
    if (!reply.promptPlan && !reply.canvasPlan) return undefined;
    return scopeImageIntent(reply, raw, (request, allowFallback) => {
        const evidence = typeof request?.evidence === 'string' ? request.evidence.trim() : '';
        return allowFallback ? explicitImageParameters(message)
            : evidence && message.includes(evidence) ? explicitImageParameters(evidence) : undefined;
    });
}

export function getAvailablePromptAgentModels(models = [], providers = []) {
    return getModelsForTask(models, 'chat').filter((model) => {
        if (!model?.id || !model?.modelId || !getModelProtocolConfig(model.protocol)?.defaultTaskTypes.includes('chat')) return false;
        return getModelProviders(model, providers).some(provider => String(provider.endpoint || '').trim());
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

function withOrderedImageGuide(prompt, images) {
    if (images.length < 2) return prompt;
    const roles = { 'edit-target': '编辑目标', reference: '参考', supporting: '合成素材' };
    const guide = images.map((image, index) => `图${index + 1}·${roles[image.role] || '参考'}${image.purpose ? `（${image.purpose}）` : ''}`).join('；');
    const heading = `输入图片顺序：${guide}。`;
    return prompt.startsWith(heading) ? prompt : `${heading}\n${prompt}`;
}

function normalizeReply(payload, context, images = [], userMessage = '', previousReferences = [], parameterCapabilities = null) {
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
        const choices = intent === 'clarify' ? normalizePromptAgentChoices(payload.choices) : undefined;
        if (choices) reply.choices = choices;
        if (intent === 'clarify' && payload.taskUpdate?.mode === 'new') reply.confirmNewTask = true;
        return reply;
    }
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || typeof plan.prompt !== 'string' || !plan.prompt.trim()) {
        throw new Error('模型没有返回可用的 Prompt');
    }
    if (plan.negativePrompt != null && typeof plan.negativePrompt !== 'string') throw new Error('负面提示词必须是文本');
    let parameters;
    if (parameterCapabilities && plan.parameters && typeof plan.parameters === 'object' && !Array.isArray(plan.parameters)) {
        parameters = Object.fromEntries(Object.entries(plan.parameters).flatMap(([key, value]) => {
            const canonical = key === 'aspect' ? 'aspectRatio' : key === 'generationCount' ? 'count' : key;
            if (!proposalFields.has(canonical)) return [];
            const numeric = ['count', 'customWidth', 'customHeight'].includes(canonical);
            return [[canonical, numeric && typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value]];
        }));
    } else {
        parameters = normalizePromptAgentParameters(plan.parameters ?? {}, {
            aspectRatio: { type: 'string' }, resolution: { type: 'string' }, customWidth: { type: 'integer', minimum: 1 }, customHeight: { type: 'integer', minimum: 1 },
            ...(context?.parameterSchema || {})
        });
    }
    const imageRoles = plan.imageRoles ?? [];
    if (!Array.isArray(imageRoles)) throw new Error('图片角色必须是数组');
    let selectedImages = imageRoles.map((item) => {
        const image = images.find((candidate) => candidate.imageId === item?.imageId);
        if (!image || !['edit-target', 'reference', 'supporting'].includes(item.role)) throw new Error('模型引用了无效的图片或图片角色');
        if (item.purpose != null && typeof item.purpose !== 'string') throw new Error('参考图用途必须是文本');
        return { ...image.reference, imageId: image.imageId, role: item.role,
            ...(item.purpose?.trim() ? { purpose: item.purpose.trim().replace(/\s+/g, ' ') } : {}) };
    });
    const latest = images.filter(image => image.latestResult);
    const selection = payload.targetSelection;
    const evidence = typeof selection?.evidence === 'string' ? selection.evidence.trim() : '';
    const explicitEvidence = evidence && userMessage.includes(evidence);
    const clarify = message => ({ ...reply, intent: 'clarify', message, promptPlan: null });
    const editTarget = target => {
        const purpose = selectedImages.find(image => image.imageId === target.imageId)?.purpose;
        return { ...target.reference, imageId: target.imageId, role: 'edit-target', ...(purpose ? { purpose } : {}) };
    };
    if (selection && !['latest', 'explicit', 'prompt-only', 'none'].includes(selection.mode)) throw new Error('无效的编辑目标选择方式');
    const noImages = excludesReferenceImages(userMessage, selection);
    if (noImages) selectedImages = [];
    else if (selection?.mode === 'prompt-only') {
        if (previousReferences.some(image => image.referenceUnavailable === 'multiple-targets')) return clarify('上一方案包含多个生图目标，请明确要修改哪个节点，或保留完整多步骤方案。');
        if (previousReferences.some(image => image.referenceUnavailable)) return clarify('上一方案的参考原图不可用或快照不完整，请恢复原图或保留完整多步骤方案。');
        if (!explicitEvidence) return clarify('请确认是否仅调整提示词。');
        selectedImages = previousReferences.map(image => ({ ...image }));
    }
    else if (intent === 'generate') selectedImages = selectedImages.filter(image => mayUseCandidate(
        images.find(candidate => candidate.imageId === image.imageId), { message: userMessage, selection, intent,
            evidence: imageRoles.find(item => item.imageId === image.imageId)?.evidence }));
    if (!noImages && (intent === 'edit' || intent === 'refine') && latest.length) {
        if (selection?.mode === 'explicit') {
            const target = images.find(image => image.imageId === selection.imageId);
            if (!explicitEvidence || !target) return clarify('请明确要修改哪张图片，或确认使用最新生成结果。');
            selectedImages = [editTarget(target),
                ...selectedImages.filter(image => image.role !== 'edit-target' && image.imageId !== target.imageId)];
        } else if (selection?.mode === 'prompt-only') {
            if (!explicitEvidence) return clarify('你希望仅修改提示词，还是继续修改最新生成的图片？');
        } else {
            const target = latest.length === 1 ? latest[0]
                : explicitEvidence ? latest.find(image => image.imageId === selection?.imageId) : null;
            if (!target) return clarify(`最新一批有 ${latest.length} 张图片，请指定要修改第几张。`);
            selectedImages = [editTarget(target),
                ...selectedImages.filter(image => image.role !== 'edit-target' && image.imageId !== target.imageId)];
        }
    }
    if (!noImages && intent === 'edit' && !selectedImages.some((item) => item.role === 'edit-target')) {
        throw new Error('编辑方案缺少明确的目标图片，请指定要修改的图片');
    }
    return {
        ...reply,
        message: reply.message || '已整理 Prompt Plan。',
        promptPlan: {
            targetNodeId: context?.nodeId || null,
            prompt: withOrderedImageGuide(plan.prompt.trim(), selectedImages),
            ...(typeof plan.negativePrompt === 'string' ? { negativePrompt: plan.negativePrompt.trim() } : {}),
            parameters,
            referenceImages: selectedImages,
            ...(selection?.mode === 'prompt-only' ? { preserveReferenceSnapshot: true } : {})
        }
    };
}

export async function createPromptAgentModelReply({
    message = '', choiceAnswer = null, confirmedNewTask = false, context = null, conversation = null, workflowMemory = '', sizeSettings = {},
    imageSizeCapabilities = null, imageParameterCapabilities = null, referenceImages = [], workflowReferenceImages = [],
    autoCompactTokenLimit,
    model, models = [], providers = [], providerId = '', recordRequest, workflowId, fetchRef = fetch, headers = {}, getHeaders = null, signal,
    searchSettings = { mode: 'auto', modelId: '' }, searchRef = searchPromptAgent, onSearchStatus = () => {}, canvasContext = null,
    getCanvasImage = async () => null, onContextImages = () => {}
} = {}) {
    // Capture all configuration once, including provider order and endpoints.
    [model, models, providers, searchSettings] = JSON.parse(JSON.stringify([model, models, providers, searchSettings]));
    const assertActive = () => { if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError'); };
    assertActive();
    if (!model) throw new Error('请先配置对话模型和供应商。');
    const provider = resolveAgentProvider(model, providers, providerId);
    if (!model || !provider) throw new Error('请先在设置中配置一个可用的对话模型和 Provider');
    if (getOpenAIChatCapabilities({ model, provider })?.imageInput === false) {
        model.capabilities = { ...model.capabilities, imageInput: false };
    }
    const batch = canvasImageBatchRequest(canvasContext, message, referenceImages);
    // A batch targets the selected original assets, independent of any earlier
    // generation or prompt-edit target. No pixel reads are needed for planning it.
    if (batch) context = null;
    const originalReads = new Map();
    const readOriginal = async (assetKey, name) => {
        if (!originalReads.has(assetKey)) originalReads.set(assetKey, Promise.resolve(getCanvasImage(assetKey)));
        const dataUrl = await originalReads.get(assetKey);
        assertActive();
        if (!/^data:image\/[^;]+;base64,/i.test(String(dataUrl || ''))) throw new Error(`「${name}」原图读取失败，不能确认图片内容`);
        return dataUrl;
    };

    // Explicit mentions bind visual context to the named node, independent of canvas selection.
    // Read durable originals before the first request; topology alone does not give the model pixels.
    const explicitMentions = new Set(canvasContext?.summary.mentionedIds || []);
    const implicitSelection = id => !explicitMentions.has(id) && canvasContext?.summary.selectedIds?.includes(id);
    const mentioned = [...new Set([...explicitMentions,
        ...(context?.nodeId && canvasContext?.nodes.some(node => node.id === context.nodeId) ? [context.nodeId] : [])])];
    if (!batch && mentioned.length) {
        const hydrateNode = async (node, sourcePort = 'image', targetPort = '', requireAssets = false, allowUnavailable = false) => {
            if (!node) {
                if (requireAssets) throw new Error('参考图来源已删除，请刷新后重试');
                return [];
            }
            if (node.enabled === false) return [];
            const unavailable = message => {
                if (!allowUnavailable) throw new Error(message);
                return [{ sourceNodeId: node.id, sourcePort, targetPort, name: node.name,
                    assetKeys: [...node.assets], images: [], referenceUnavailable: true, unavailableReason: message }];
            };
            // Selection is structural context as well as potential visual context.
            // Missing pixels must not prevent the model from proposing to delete
            // an empty node; keep their absence explicit and never use previews.
            if (node.running || node.missing) return unavailable(`「${node.name}」参考图正在运行或原图缺失，请恢复后重试`);
            if (requireAssets && !node.assets.length) return unavailable(`「${node.name}」参考原图尚不可用，请恢复后重试`);
            const result = [];
            for (const [index, assetKey] of node.assets.entries()) {
                let dataUrl;
                try { dataUrl = await readOriginal(assetKey, node.name); }
                catch (error) { assertActive(); return unavailable(error.message); }
                result.push({ referenceId: `canvas:${node.id}:${index}:${assetKey}`, sourceNodeId: node.id,
                    sourcePort, targetPort, sourceImageIndex: index, assetKey, dataUrl,
                    name: `${node.name} [${node.id}] 第 ${index + 1} 张`, contextOrigin: '本轮 @节点原图' });
            }
            return result;
        };
        const inputs = new Map();
        for (const id of mentioned) {
            const node = canvasContext.nodes.find(item => item.id === id);
            if (!node) continue;
            if (node.type === 'ImageGenerate') {
                if (referenceInputChangePermission(message, [id])?.mode === 'clear') {
                    inputs.set(id, []);
                    continue;
                }

                const links = orderImageReferenceConnections( canvasContext.connections
                    .filter(link => link.to.nodeId === id && /^(?:referenceImages|image|image_\d+)$/.test(link.to.port)));
                const references = [];
                for (const link of links) references.push(...await hydrateNode(canvasContext.nodes.find(item => item.id === link.from.nodeId), link.from.port, link.to.port, true, implicitSelection(id)));
                inputs.set(id, references);
                if (context?.nodeId !== id) workflowReferenceImages = [...workflowReferenceImages, ...references];
            } else if (node.assets.length) {
                workflowReferenceImages = [...workflowReferenceImages, ...await hydrateNode(node)];
            }
        }
        if (context && inputs.has(context.nodeId)) {
            context = { ...context, referenceImages: inputs.get(context.nodeId),
                outputImages: referenceInputChangePermission(message, [context.nodeId])?.mode === 'clear' ? []
                    : await hydrateNode(canvasContext.nodes.find(item => item.id === context.nodeId), 'image', '', false, implicitSelection(context.nodeId)) };
        }
    }
    const base = { message, choiceAnswer, confirmedNewTask, context, conversation, workflowMemory, sizeSettings, imageSizeCapabilities,
        imageParameterCapabilities, referenceImages, workflowReferenceImages, model, canvasContext, autoCompactTokenLimit };
    const previousTurn = [...(conversation?.archivedMessages || []), ...(conversation?.messages || [])].findLast(item => item.canvasPlan || item.promptPlan);
    const previousPrompt = previousTurn?.promptPlan || conversation?.previousPromptPlan;
    const differentPromptTarget = context?.nodeId && previousPrompt?.targetNodeId && previousPrompt.targetNodeId !== context.nodeId;
    // A first optimization has no prior plan: retain the originals read for this target.
    // Existing same-target snapshots remain authoritative for detecting later changes.
    let previousReferences = differentPromptTarget || !previousPrompt ? context?.referenceImages || []
        : previousPrompt.referenceImages || [];
    const previousCanvas = previousTurn?.canvasPlan;
    let previousReferenceTarget = null;
    if (previousCanvas && !batch) {
        const requestedTargets = (canvasContext?.nodes || []).filter(node => node.type === 'ImageGenerate'
            && (canvasContext.summary.mentionedIds.includes(node.id) || canvasContext.summary.selectedIds.includes(node.id) || (message.includes(node.name)
                && canvasContext.nodes.filter(item => item.name === node.name).length === 1))).map(node => node.id);
        const requested = requestedTargets.length === 1 ? requestedTargets[0] : null;
        previousReferenceTarget = requested;
        const priorTarget = requested && previousCanvas.steps.some(step => (step.nodeId || previousCanvas.bindings?.[step.id]) === requested);
        previousReferences = requested && !priorTarget ? context?.referenceImages || []
            : canvasPlanReferenceImages(previousCanvas, canvasContext, requested);
        for (const reference of previousReferences.filter(reference => reference.assetKey)) {
            try {
                const dataUrl = await readOriginal(reference.assetKey, reference.name);
                base.workflowReferenceImages = [...base.workflowReferenceImages, { ...reference, dataUrl, contextOrigin: '上一方案参考图' }];
            } catch {
                assertActive();
                reference.referenceUnavailable = true;
            }
        }

    }
    const previousAssetKeys = [...new Set([...previousReferences.flatMap(image => [image.assetKey, ...(image.assetKeys || [])]),
        ...(previousCanvas?.steps || []).map(step => step.assetKey)].filter(Boolean))];
    const canvasReads = [];
    let search = null;
    let searchUsed = false;
    const requestText = message.trim();
    const canRetryTaskConfirmation = confirmedNewTask || Boolean(requestText
        && (referenceImages.length || directCreationRequest.test(requestText)));
    let taskConfirmationRetry = false;
    let batchRetry = false;
    for (let round = 0; round < 10; round++) {
        assertActive();
        const request = { ...base, canvasReads, taskConfirmationRetry, searchAllowed: !searchUsed && searchSettings.mode !== 'off', searchContext: search,
            ...(batch ? { canvasBatchScope: { sourceCount: batch.sourceNodeIds.length, sourceNodeIds: batch.sourceNodeIds, retry: batchRetry } } : {}) };
        if ((canvasReads.length || batchRetry) && measurePromptAgentContext(request).reached) throw new Error('画布详情达到本轮上下文预算，未读取部分无法确认；请用 @节点 缩小范围或先压缩上下文');
        const input = createPromptAgentInput(request);
        if (round === 0) onContextImages(input.images.filter(image => image.reference.dataUrl && image.origins.some(origin =>
            ['节点输入', '节点生成结果', '本轮 @节点原图'].includes(origin))).map(image => image.reference));
        const plan = createChatRequestPlan({ provider, model, protocol: model.protocol, systemPrompt: getPromptAgentInstructions(canvasContext),
            messages: input.messages, media: input.media, capabilities: model.capabilities || {} });
        let response, payload;
        try {
            const requestHeaders = typeof getHeaders === 'function' ? getHeaders(plan) : headers;
            response = await trackAgentRequest(plan, () => requestChatCompletion(plan, { fetchRef, headers: requestHeaders, signal }),
                { recordRequest, workflowId, signal, purpose: search ? 'search-summary' : canvasReads.length ? 'canvas-followup' : 'chat' });
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
                const dataUrl = await readOriginal(assetKey, node.name);
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
            const availability = getAgentSearchAvailability({ model, models, providers, providerId: provider.id, settings: searchSettings, kind });
            if (!availability.available) throw new Error(`${availability.message}，请在对话模型设置中配置联网搜索。`);
            const searchModel = availability.model;
            onSearchStatus(kind === 'images' ? '正在搜索图片…' : '正在联网查找资料…');
            search = normalizeAgentSearch(await searchRef({ model: searchModel, providers, providerId: availability.provider.id, recordRequest, workflowId, kind, query: query.trim(), fetchRef,
                getHeaders: typeof getHeaders === 'function' ? getHeaders : () => headers, signal }));
            assertActive();
            if (!search) throw new Error('搜索接口未返回有效结果。');
            onSearchStatus('正在整理检索结果…');
            continue;
        }
        if (batch && !payload?.canvasBatch && !batchRetry) {
            batchRetry = true;
            onSearchStatus('正在为已选图片整理共用提示词…');
            continue;
        }
        if (batch && !payload?.canvasBatch) {
            if (payload?.intent === 'clarify' && !/(?:哪|指定|选择|确认).{0,10}(?:图|素材)|参考图|选中节点/.test(payload.message || '') && payload.taskUpdate?.mode !== 'new') {
                return normalizeReply(payload, null, input.images, message, [], imageParameterCapabilities);
            }
            return { intent: 'clarify', message: '已识别画布图片来源。请补充本批图片要做的处理，或重试生成共用提示词。', promptPlan: null, workSummary: [] };
        }
        if (canRetryTaskConfirmation && payload?.intent === 'clarify' && payload.taskUpdate?.mode === 'new') {
            if (taskConfirmationRetry) {
                return { intent: 'chat', message: '模型未能整理出本轮方案，请重新发送这条请求。', promptPlan: null, ...(search ? { search } : {}) };
            }
            taskConfirmationRetry = true;
            onSearchStatus('正在整理本轮创作方案…');
            continue;
        }
        let reply;
        let canvasEditTargetId;
        try {
            if (!payload.canvasBatch && payload.canvasPlan && ['edit', 'refine'].includes(payload.intent) && payload.targetSelection?.mode !== 'prompt-only') {
                // Reuse the established latest-result selection gate before accepting a graph.
                const targetReply = normalizeReply({ ...payload, canvasPlan: undefined, promptPlan: {
                    prompt: '画布续改目标检查', imageRoles: (payload.canvasPlan.steps || []).filter(step => step.imageId).map(step => ({ imageId: step.imageId, role: 'edit-target' }))
                } }, null, input.images, message, previousReferences);
                if (targetReply.intent === 'clarify') return targetReply;
                const selected = targetReply.promptPlan.referenceImages.find(image => image.role === 'edit-target');
                if (selected && !(payload.canvasPlan.steps || []).some(step => step.imageId === selected.imageId)) {
                    throw new Error('多步骤续改未引用正确的最新结果，请指定要编辑的图片后重新整理方案');
                }
                canvasEditTargetId = selected?.imageId;
            }
            reply = payload.canvasBatch && payload.intent !== 'clarify' ? {
                intent: 'generate', promptPlan: null,
                canvasPlan: normalizeCanvasBatch(payload.canvasBatch, batch, canvasContext, message),
                message: '已整理共用提示词与逐张生图方案。',
                canvasExecution: batch.mode
            } : payload.canvasPlan && canvasContext && payload.intent !== 'clarify' ? {
                intent: ['edit', 'refine', 'chat'].includes(payload.intent) ? payload.intent
                    : payload.targetSelection?.mode === 'prompt-only' ? 'refine' : 'generate',
                message: String(payload.message || '已整理画布操作方案，请检查变更清单。'), promptPlan: null,
                canvasPlan: normalizeCanvasPlan(payload.canvasPlan, canvasContext, { message, mentionedIds: canvasContext.summary.mentionedIds, images: input.images,
                    referencePolicy: { intent: payload.intent, selection: payload.targetSelection, previousAssetKeys } })
            } : normalizeReply(payload, context, input.images, message, previousReferences, imageParameterCapabilities);
            if (reply.canvasPlan && !reply.canvasPlan.imageBatch && previousCanvas && payload.targetSelection?.mode === 'prompt-only') {
                const evidence = payload.targetSelection.evidence;
                if (typeof evidence !== 'string' || !evidence.trim() || !message.includes(evidence.trim())) throw new Error('仅改提示词需要当前用户的明确指令。');
                if (previousReferences.some(reference => reference.referenceUnavailable === true)) throw new Error('上一方案参考原图不可用，请恢复原图后再沿用。');
                assertPromptOnlyReferenceRecipe(previousCanvas, reply.canvasPlan, canvasContext, previousReferenceTarget);
            }

            const canvasText = canvasInstructionText(message);
            const explicitAction = payload.intent !== 'chat' && requestedCanvasAction(canvasText);
            if (explicitAction && canApplyAdditiveCanvasPlan(reply.canvasPlan, canvasContext, canvasText, input.images)) {
                reply.canvasExecution = explicitAction;
            }
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
        if (payload.taskUpdate && reply.intent !== 'clarify' && !reply.canvasPlan?.imageBatch) reply.taskUpdate = payload.taskUpdate;
        if (reply.intent !== 'clarify') {
            const sizeIntent = normalizeSizeIntent(payload.sizeIntent, reply, input, message);
            if (sizeIntent) reply.sizeIntent = sizeIntent;
            const parameterIntent = normalizeImageParameterIntent(payload.parameterIntent, reply, message);
            if (parameterIntent) reply.requestedImageParameters = parameterIntent;
        }
        if (reply.intent === 'edit' || (reply.intent === 'refine' && payload.targetSelection?.mode === 'explicit')) {
            const targets = reply.promptPlan?.referenceImages.filter(image => image.role === 'edit-target') || [];
            const targetId = targets.length === 1 ? targets[0].imageId : canvasEditTargetId;
            const target = input.images.find(image => image.imageId === targetId);
            if (target?.origins.includes('本轮附件') && (!target.latestResult || payload.targetSelection?.mode === 'explicit')) {
                reply.editsCurrentAttachment = true;
            }
        }
        return reply;
    }
}
