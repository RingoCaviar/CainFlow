import { agentNodeDefinition as getNodeDefinition, isReferencePort, normalizePlanInputs, assertReferenceInputsPreserved, referenceManifest, projectPlanConnections, matchesDisconnectPort, isAuthorizedExactDisconnect } from './prompt-agent-reference-inputs.js';
import { CANVAS_CREATABLE_TYPES, CANVAS_FIELDS, CANVAS_NODE_PATCH_FIELDS, CANVAS_SCALAR_RULES, CANVAS_TYPES,
    canvasBaseline, cloneCanvasValue, canvasPlanExecutionNodeIds } from './prompt-agent-canvas-context.js';
import { excludesReferenceImages, mayUseCandidate, referenceInputChangePermission } from './prompt-agent-reference-policy.js';
import { orderImageReferenceConnections } from '../../nodes/image-reference-projection.js';
import { getDynamicNodePorts } from '../../nodes/node-view-factory.js';

const fail = message => { throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function normalizeNodePatch(raw) {
    if (raw === undefined) return undefined;
    if (!object(raw) || !Object.keys(raw).length || Object.keys(raw).some(key => !CANVAS_NODE_PATCH_FIELDS.includes(key))) {
        fail('节点修改仅支持名称、坐标和启用状态');
    }
    const { title, x, y, enabled } = raw;
    if (Object.hasOwn(raw, 'title') && (typeof title !== 'string' || title.length > 100 || /[\x00-\x1F\x7F]/.test(title))) fail('节点名称无效');
    if ([['x', x], ['y', y]].some(([key, value]) => Object.hasOwn(raw, key) && !Number.isFinite(value))) fail('节点坐标无效');
    if (Object.hasOwn(raw, 'enabled') && typeof enabled !== 'boolean') fail('节点启用状态必须是布尔值');
    return { ...raw, ...(title === undefined ? {} : { title: title.trim() }) };
}

export function isCanvasGraphOnlyStep(plan, step) {
    return step.execute === false && !Object.keys(step.parameters || {}).length && !Object.keys(step.generationPatch || {}).length
        && step.negativePrompt === undefined && !plan.modelOverrides?.[step.id];
}

export function canvasPlanPatchPositions(steps, context) {
    return steps.filter(step => step.patch && (Object.hasOwn(step.patch, 'x') || Object.hasOwn(step.patch, 'y'))).map(step => {
        const position = context.nodes.find(node => node.id === step.nodeId)?.position;
        return [step.nodeId, position?.x, position?.y];
    });
}

export function canvasPlanDynamicPorts(plan, context) {
    const refs = new Map(plan.steps.map(step => [step.id, step.nodeId || plan.bindings?.[step.id]]));
    const nodes = new Map(context.nodes.map(node => [node.id, node]));
    const checks = new Map();
    const add = (ref, direction) => {
        const node = nodes.get(refs.has(ref) ? refs.get(ref) : ref);
        const dynamic = node?.type === 'TextSplit' && direction === 'outputs'
            || ['TextMerge', 'ImageMerge'].includes(node?.type) && direction === 'inputs';
        if (dynamic) checks.set(JSON.stringify([node.id, direction]), [node.id, direction, node[direction].map(port => port.name)]);
    };
    for (const link of plan.connections) {
        add(link.from.ref, 'outputs');
        add(link.to.ref, 'inputs');
    }
    for (const item of plan.disconnects || []) add(item.ref, 'inputs');
    for (const step of plan.steps) if (Object.hasOwn(step.parameters || {}, 'inputCount')) add(step.id, 'inputs');
    return [...checks.values()];
}

export function assertCanvasMergeResize(steps, links, identity) {
    for (const step of steps) {
        const count = step.parameters?.inputCount;
        if (step.type !== 'ImageMerge' || !step.nodeId || count === undefined) continue;
        const id = identity(step.id);
        if (links.some(link => link.to.nodeId === id && /^image_\d+$/.test(link.to.port) && Number(link.to.port.slice(6)) >= count)) {
            fail('合并节点必须保留现有连线及其后的一个空输入，请先明确断开不需要的连线。');
        }
    }
}

const selectedNodeScope = String.raw`(?:我\s*)?(?:当前\s*|现在\s*)?(?:已\s*)?选中(?:的)?(?:这些|所有|全部)?(?:生图|图片生成|生成图片)?节点`;
const referenceInputs = String.raw`(?:上|中|里|内)?(?:的\s*)?(?:所有|全部)?参考图(?:片)?(?:输入|连线|连接)?`;
const clearVerb = '(?:移除|删除|清空|断开|去掉|清掉)';
const selectedReferenceClear = new RegExp(
    String.raw`^(?:(?:请(?:帮我)?|帮我|麻烦(?:帮我)?|直接)\s*)*(?:(?:把|将)?\s*${selectedNodeScope}\s*${referenceInputs}\s*(?:都|全部|全都|一并)?\s*${clearVerb}|${clearVerb}\s*${selectedNodeScope}\s*${referenceInputs})[。！!]?$`
);

export function isSelectedReferenceClearRequest(message) {
    return selectedReferenceClear.test(String(message || '').trim());
}

export function createSelectedReferenceClearReply(context) {
    const selected = new Set(context?.summary?.selectedIds || []);
    const nodes = (context?.nodes || []).filter(node => selected.has(node.id) && node.type === 'ImageGenerate');
    if (!nodes.length) return { message: '请先选中需要清除参考图的生图节点。' };
    const incoming = new Set(context.connections.filter(link => isReferencePort(link.to.port)).map(link => link.to.nodeId));
    const targets = nodes.filter(node => incoming.has(node.id));
    if (!targets.length) return { message: '选中的生图节点没有已连接的参考图。' };
    const blocked = targets.find(node => !node.enabled || node.running || node.editable === false);
    if (blocked) {
        const status = blocked.running ? '正在运行' : !blocked.enabled ? '已禁用' : '不可编辑';
        return { message: `「${blocked.name}」${status}。请处理该节点后再清除参考图。` };
    }
    if (targets.length > 100) return { message: '请分批选择，每次最多清除 100 个生图节点的参考图。' };
    const usedIds = new Set(context.nodes.map(node => node.id));
    let nextStep = 1;
    const steps = targets.map(node => {
        let id;
        do { id = `clear-reference-${nextStep++}`; } while (usedIds.has(id));
        return { id, nodeId: node.id, type: 'ImageGenerate', execute: false };
    });
    const canvasPlan = normalizeCanvasPlan({
        version: 1, steps,
        disconnects: steps.map(step => ({ ref: step.id, port: 'referenceImages' }))
    }, context, { explicitInputChanges: true });
    canvasPlan.applyInPlace = true;
    return { message: `将断开 ${targets.length} 个选中生图节点的参考图连线，保留参考图节点和其他输入。请确认变更。`, canvasPlan };
}

function canTargetNode(node, context, message, mentionedIds, evidence, includePromptSource = false) {
    const focused = new Set([...(context.summary?.selectedIds || []), ...mentionedIds]);
    if (focused.has(node.id)) return true;
    if (includePromptSource && context.nodes.some(target => context.summary?.selectedIds?.includes(target.id)
        && target.promptSource?.editable && target.promptSource.nodeId === node.id)) return true;
    return typeof evidence === 'string' && Boolean(evidence.trim()) && message.includes(evidence)
        && evidence.includes(node.name) && context.nodes.filter(item => item.name === node.name).length === 1;
}

function promptInputChangePermission(message, steps, context, mentionedIds, connections) {
    const targets = steps.filter(step => step.type === 'ImageGenerate' && step.nodeId);
    if (targets.length !== 1) return null;
    const targetId = targets[0].nodeId;
    const sourceId = context.connections.filter(edge => edge.to.nodeId === targetId && edge.to.port === 'prompt').at(-1)?.from.nodeId;
    const proposed = connections.find(link => link.to.ref === targets[0].id && link.to.port === 'prompt');
    const nextSourceId = steps.find(step => step.id === proposed?.from.ref)?.nodeId || proposed?.from.ref;
    const allowedIds = new Set([targetId, sourceId, nextSourceId]);
    const clauses = String(message).split(/[。！!；;\n]/);
    const allowed = clauses.some(clause => {
        // Text edits such as ‘清除提示词中的水印’ never authorize changing its source.
        const relation = clause.match(/(?:断开|解除).{0,18}(?:提示词|prompt)\s*(?:输入(?!框|栏|区)|来源|连线|连接)(?!\s*(?:中|里|内|的?(?:文字|文本|内容|描述)))/i)
            || clause.match(/(?:移除|清除|替换).{0,18}(?:提示词|prompt)\s*(?:输入(?:连线|连接)|来源|连线|连接)(?!\s*(?:中|里|内|的?(?:文字|文本|内容|描述)))/i);
        if (!relation
            || /(?:不(?:要|能|许|准|得|必)?|别|勿|保留|保持).{0,12}(?:断开|移除|解除|清除|替换)/.test(clause)) return false;
        const named = context.nodes.filter(node => clause.includes(`[${node.id}]`)
            || node.name?.length > 1 && clause.includes(node.name) && context.nodes.filter(item => item.name === node.name).length === 1);
        if (named.some(node => !allowedIds.has(node.id))) return false;
        return named.some(node => node.id === targetId) || !named.length && mentionedIds.includes(targetId) && mentionedIds.every(id => allowedIds.has(id));
    });
    return allowed ? { authorizationVersion: 1, targetNodeIds: [targets[0].nodeId] } : null;
}

function ordinalReferenceGroups(context, targetId) {
    const nodes = new Map(context.nodes.map(node => [node.id, node]));
    const references = orderImageReferenceConnections(context.connections.filter(link => link.to.nodeId === targetId));
    return references.map(link => {
        const source = nodes.get(link.from.nodeId);
        if (!source?.enabled || source.running) return [link.id, 0];
        const count = Math.max(source.assets?.length || 0, source.imageCount || 0);
        return [link.id, source.missing || !count ? null : count];
    });
}

function canDisconnectExactEdge(message, evidence, edge, context, mentionedIds, ordinalGroups) {
    const text = String(message);
    if (evidence !== undefined && (typeof evidence !== 'string' || !evidence.trim() || !text.includes(evidence.trim()))) return false;
    const names = new Map();
    for (const node of context.nodes) names.set(node.name, (names.get(node.name) || 0) + 1);
    const nodes = new Map(context.nodes.map(node => [node.id, node]));
    const source = nodes.get(edge.from.nodeId), target = nodes.get(edge.to.nodeId);
    const chineseDigit = value => '零一二三四五六七八九'.indexOf(value);
    const ordinalNumber = value => {
        if (/^\d+$/.test(value)) return Number(value);
        if (!value.includes('十')) return chineseDigit(value);
        if (!/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(value)) return NaN;
        const [tens, ones] = value.split('十');
        return (tens ? chineseDigit(tens) : 1) * 10 + (ones ? chineseDigit(ones) : 0);
    };
    const matchesOnlyImageAt = number => {
        // A source may contribute several image slots through one connection.
        // Removing that connection cannot represent a request to remove one slot.
        if (!Number.isSafeInteger(number) || number < 1) return false;
        const references = ordinalReferenceGroups(context, edge.to.nodeId);
        let slot = 0;
        for (const [connectionId, count] of references) {
            if (count === null) return false;
            if (number <= slot + count) {
                if (count !== 1 || connectionId !== edge.id) return false;
                ordinalGroups.set(edge.to.nodeId, references);
                return true;
            }
            slot += count;
        }
        return false;
    };
    const clauses = text.split(/[。！？!?；;\n，,]/);
    return clauses.some(clause => {
        if (!/(?:断开|移除|去掉|删除|拔掉|\b(?:disconnect|unlink|remove|delete)\b)/i.test(clause)
            || /(?:不要|别|不许|不得|无需|如何|怎么|能否|是否|如果|例如|\b(?:don't|not|how|would|if)\b)/i.test(clause)) return false;
        const tokens = clause.match(/[a-zA-Z0-9_-]+/g) || [];
        if (/(?:连线|连接|\b(?:connection|edge|link)\b)/i.test(clause)
            && (clause.includes('[' + edge.id + ']') || tokens.includes(edge.id))) return true;
        const mentionLocation = node => {
            if (!node) return -1;
            const mention = clause.indexOf('[' + node.id + ']');
            if (mention !== -1) return mention;
            return names.get(node.name) === 1 && (node.name?.length > 1 || tokens.includes(node.name)) ? clause.indexOf(node.name) : -1;
        };
        const sourceIndex = mentionLocation(source), targetIndex = mentionLocation(target);
        const named = context.nodes.filter(node => mentionLocation(node) !== -1);
        const ordinal = clause.match(/第\s*([0-9一二三四五六七八九十]+)\s*(?:张|个)?\s*参考图|参考图(?:片)?\s*第?\s*([0-9一二三四五六七八九十]+)\s*(?:张|个)?/);
        if (ordinal && target?.type === 'ImageGenerate' && isReferencePort(edge.to.port)) {
            const focused = [...new Set([...(context.summary?.selectedIds || []), ...mentionedIds])];
            const targetNamed = named.length === 1 && targetIndex !== -1
                || !named.length && focused.length === 1 && focused[0] === target.id;
            return targetNamed && matchesOnlyImageAt(ordinalNumber(ordinal[1] || ordinal[2]));
        }
        if (named.length !== 2 || sourceIndex < 0 || targetIndex <= sourceIndex || !/(?:到|至|连向|→|->|\bto\b)/i.test(clause)) return false;
        const edges = context.connections.filter(link => link.from.nodeId === source.id && link.to.nodeId === target.id);
        return edges.length === 1;
    });
}

// A prompt proposal cannot become effective by silently replacing its real source.
export function assertCanvasPlanPromptInputs(plan, context) {
    const identity = ref => plan.steps.find(step => step.id === ref)?.nodeId || plan.bindings?.[ref] || ref;
    const links = projectPlanConnections(plan, context.connections, identity);
    for (const step of plan.steps) {
        const node = context.nodes.find(node => node.id === identity(step.id));
        if (node?.editable === false && (step.type === 'ImageGenerate' || Object.keys(step.parameters || {}).length)) throw new Error('目标节点参数只读，不能修改克隆或派生文本来源。');
        if (node && ['VideoGenerate', 'TextChat'].includes(step.type) && Object.hasOwn(step.parameters || {}, 'prompt')
            && step.parameters.prompt !== (node.parameters.prompt || '')
            && links.some(link => link.to.nodeId === node.id && link.to.port === 'prompt')) {
            throw new Error('目标提示词已接入上游，请修改实际文本来源或明确调整提示词连线。');
        }
        if (step.type !== 'ImageGenerate' || !node) continue;
        const previous = context.connections.filter(link => link.to.nodeId === node.id && link.to.port === 'prompt').at(-1);
        const next = links.filter(link => link.to.nodeId === node.id && link.to.port === 'prompt').at(-1);
        const changed = previous && (!next || previous.from.nodeId !== next.from.nodeId || previous.from.port !== next.from.port);
        // Old stored flags used a broader text-edit matcher and cannot prove input authorization.
        const permitted = isAuthorizedExactDisconnect(plan, previous, identity) && (!next || context.connections.includes(next))
            || plan.deletes?.some(item => item.nodeId === previous?.from.nodeId)
            || plan.promptInputChange?.authorizationVersion === 1 && plan.promptInputChange.targetNodeIds?.includes(node.id);
        if (changed && plan.promptInputChange && !permitted) throw new Error('旧方案的提示词输入授权无法核验，请重新生成方案并确认输入关系。');
        if (changed && !permitted) throw new Error('方案不能擅自断开或替换上游提示词来源；请明确要求修改输入关系。');
        if (!changed && node.promptSource?.active && Object.hasOwn(step.parameters || {}, 'prompt')
            && step.parameters.prompt !== node.effectivePrompt) {
            throw new Error(`提示词来自上游「${node.promptSource.name || node.promptSource.nodeId}」，请在方案中明确修改支持的真实来源；只读或视角来源请到来源编辑。`);
        }
    }
}
export function normalizeCanvasPlan(raw, context, { message = '', mentionedIds = [], images = [], referencePolicy, explicitInputChanges = false, batchSourceNodeIds = [] } = {}) {
    if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.steps) || !Array.isArray(raw.deletes || [])
        || raw.steps.length + (raw.deletes?.length || 0) < 1 || raw.steps.length + (raw.deletes?.length || 0) > 100) fail('画布方案必须为 v1，包含 1 至 100 个操作');
    const deletedIds = new Set();
    const deletes = (raw.deletes || []).map(item => {
        const node = context.nodes.find(node => node.id === item?.nodeId);
        if (!node || deletedIds.has(node.id)) fail('删除目标不存在或重复');
        if (!canTargetNode(node, context, message, mentionedIds, item.evidence)) fail('删除已有节点前请选中或使用 @节点 明确指定目标');
        const affected = new Set([node.id, ...context.connections.filter(link => link.from.nodeId === node.id || link.to.nodeId === node.id)
            .flatMap(link => [link.from.nodeId, link.to.nodeId])]);
        if (context.nodes.some(item => affected.has(item.id) && item.running)) fail('目标节点或相连节点正在运行，不能删除');
        deletedIds.add(node.id);
        return { nodeId: node.id, title: node.name, type: node.type };
    });
    if (referencePolicy) {
        const noImages = excludesReferenceImages(message, referencePolicy.selection);
        const promptOnly = referencePolicy.selection?.mode === 'prompt-only';
        const retained = key => Boolean(key && referencePolicy.previousAssetKeys?.includes(key));
        for (const step of raw.steps.filter(item => item.type === 'ImageImport' && !item.nodeId)) {
            if (step.execute === false && !step.assetKey && !step.imageId) continue;
            if (batchSourceNodeIds.includes(step.assetSourceNodeId)
                && context.nodes.some(node => node.id === step.assetSourceNodeId && node.assets.includes(step.assetKey))) continue;
            const image = images.find(item => item.imageId === step.imageId || item.reference.assetKey === step.assetKey);
            const used = (raw.connections || []).some(link => link.from?.ref === step.id);
            const explicitImport = typeof step.evidence === 'string' && message.includes(step.evidence)
                && /导入|import/i.test(step.evidence);
            if (promptOnly && !retained(step.assetKey || image?.reference.assetKey)) fail('仅改提示词不能增加新的参考素材，请沿用上一版方案输入');
            if ((!used && !explicitImport) || (!explicitImport && !promptOnly && (noImages || !mayUseCandidate(image, {
                ...referencePolicy, message, evidence: step.evidence })))) fail('方案包含未确认使用的参考图，请移除多余导入步骤或明确指定素材');
        }
        if (noImages && (raw.connections || []).some(link => isReferencePort(link.to?.port)
            && raw.steps.some(step => step.id === link.to.ref && step.type === 'ImageGenerate'))) fail('纯文字生成方案不能连接参考图，请重新整理方案');
        for (const link of raw.connections || []) {
            if (!isReferencePort(link.to?.port)) continue;
            const target = raw.steps.find(step => step.id === link.to.ref && step.type === 'ImageGenerate');
            if (!target) continue;
            if (raw.steps.some(step => step.id === link.from?.ref)) continue;
            const node = context.nodes.find(node => node.id === link.from?.ref);
            const image = images.find(item => item.reference.sourceNodeId === node?.id);
            if (promptOnly && !node?.assets.some(retained)) fail('仅改提示词不能改用其他画布素材');
            const existing = target.nodeId && context.connections.some(edge => edge.to.nodeId === target.nodeId
                && isReferencePort(edge.to.port) && edge.from.nodeId === node?.id && edge.from.port === link.from?.port);
            if (existing) continue;
            const named = node && (mentionedIds.includes(node.id) || (message.includes(node.name)
                && context.nodes.filter(item => item.name === node.name).length === 1));
            if (referencePolicy.intent === 'generate' && !named && !batchSourceNodeIds.includes(node?.id)
                && !mayUseCandidate(image, { ...referencePolicy, message, evidence: link.evidence })) {
                fail('请明确指定方案使用的画布参考图，选中节点或旧连线不能自动成为本次输入');
            }
        }
    }
    if (!Array.isArray(raw.connections || []) || !Array.isArray(raw.disconnects || [])) fail('画布连线和断开操作必须为数组');
    const ids = new Set(), existingIds = new Set();
    const steps = raw.steps.map(step => {
        if (!object(step) || !/^[a-zA-Z][\w-]{0,63}$/.test(step.id) || ['constructor', 'prototype'].includes(step.id) || ids.has(step.id)) fail('步骤身份无效或重复');
        ids.add(step.id);
        if (context.nodes.some(node => node.id === step.id)) fail('步骤 ID 不能与画布节点 ID 相同');
        if (step.modelId || step.providerId || step.modelOverrides) fail('模型必须由用户手动选择');
        if (step.imageId) {
            const image = images.find(item => item.imageId === step.imageId);
            if (!image) fail('引用图片不存在');
            const reference = image.reference;
            const assetKey = reference.assetKey || reference.assetKeys?.[reference.sourceImageIndex || 0]
                || context.nodes.find(node => node.id === reference.sourceNodeId)?.assets[reference.sourceImageIndex || 0];
            if (!assetKey) fail('参考图尚未保存为本地原图资产，请重新导入');
            step = { ...step, assetKey };
        }
        const existing = step.nodeId && context.nodes.find(node => node.id === step.nodeId);
        const patch = normalizeNodePatch(step.patch);
        if (patch && (!existing || !existing.patchable)) fail('只能修改当前画布中的非克隆节点，目标不存在或只读');
        if (existing && existingIds.has(existing.id)) fail('同一节点不能在方案中重复修改');
        if (existing) existingIds.add(existing.id);
        if (deletedIds.has(step.nodeId)) fail('不能同时修改和删除同一节点');
        const editsInput = existing && ((raw.connections || []).some(link => link?.to?.ref === step.id)
            || (raw.disconnects || []).some(link => link?.ref === step.id));
        const editsOnly = editsInput && !Object.keys(step.parameters || {}).length;
        const execute = step.execute === true || step.execute !== false && !patch && !editsOnly;
        if (step.nodeId && (!existing || existing.type !== step.type || existing.running)) fail('目标节点不存在或正在运行');
        if (execute && (patch?.enabled === false || existing?.enabled === false && patch?.enabled !== true)) fail('不能执行已停用的节点');
        if (existing?.editable === false && Object.keys(step.parameters || {}).length) fail('目标节点参数只读，不能修改克隆或派生文本来源。');
        if (existing && !canTargetNode(existing, context, message, mentionedIds, step.evidence, !patch && !editsInput)) fail('修改已有节点前请选中或使用 @节点 明确指定目标');
        if (existing && editsInput && !existing.patchable) fail('不能修改只读节点的输入连线');
        let parameters = step.parameters || {};
        if (step.type === 'ImageGenerate' && Object.hasOwn(parameters, 'aspectRatio')) {
            if (Object.hasOwn(parameters, 'aspect') && parameters.aspect !== parameters.aspectRatio) fail('方案中的比例设置冲突');
            const { aspectRatio, ...rest } = parameters; parameters = { ...rest, aspect: aspectRatio };
        }
        if (!object(parameters)) fail('节点参数必须是对象');
        const fields = Object.hasOwn(CANVAS_FIELDS, step.type) ? CANVAS_FIELDS[step.type] : [];
        const registered = existing ? existing.patchable : CANVAS_CREATABLE_TYPES.includes(step.type);
        if (!CANVAS_TYPES.includes(step.type) && (!registered || execute || Object.keys(parameters).length)) {
            fail(`节点类型 ${step.type} 仅支持基础画布操作`);
        }
        for (const [key, value] of Object.entries(parameters)) {
            if (step.type === 'ImageGenerate' && key === 'protocolParams') {
                if (!object(value) || Object.entries(value).some(([name, setting]) =>
                    ['__proto__', 'constructor', 'prototype'].includes(name) || !['string', 'number', 'boolean'].includes(typeof setting)
                    || (typeof setting === 'number' && !Number.isFinite(setting)) || (typeof setting === 'string' && setting.length > 25000))) {
                    fail('生图模型参数必须是有效的设置项');
                }
                continue;
            }
            if (!fields.includes(key) || !['string', 'number', 'boolean'].includes(typeof value)) fail(`不支持参数 ${step.type}.${key}`);
            const rule = CANVAS_SCALAR_RULES[step.type]?.[key];
            if (rule?.enum && !(existing?.parameterOptions?.[key] || rule.enum).includes(value)) fail(`参数 ${key} 的值不受支持`);
            if (rule?.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.min || value > (rule.max ?? Infinity))) {
                fail(`参数 ${key} 超出范围`);
            }
            if (rule?.type && rule.type !== 'integer' && typeof value !== rule.type) fail(`参数 ${key} 的类型无效`);
            if (!rule && typeof value === 'number' && (!Number.isFinite(value) || value < 0)) fail(`参数 ${key} 无效`);
            if (typeof value === 'string' && value.length > 25000) fail(`参数 ${key} 过长`);
        }
        if (parameters.inputCount !== undefined && (!Number.isInteger(parameters.inputCount) || parameters.inputCount < 1 || parameters.inputCount > 20)) fail('合并输入数量必须在 1 至 20 之间');
        if (step.type === 'ImageGenerate' && !existing && (execute || Object.keys(parameters).length) && !String(parameters.prompt || '').trim()) fail('新建生图步骤缺少提示词');
        if (step.type === 'ImageImport' && !existing && !(step.execute === false && !step.assetKey && !step.imageId) && !/^media:/.test(step.assetKey || '')) fail('图片导入必须引用已登记的本地原图资产');
        if (step.assetKey && !context.nodes.some(node => node.assets.includes(step.assetKey))
            && !images.some(image => image.reference.assetKey === step.assetKey || image.reference.assetKeys?.includes(step.assetKey))) fail('图片资产未登记在当前画布或对话中');
        const assetSource = step.assetSourceNodeId && context.nodes.find(node => node.id === step.assetSourceNodeId
            && node.enabled && !node.running && !node.missing && node.assets.includes(step.assetKey));
        if (step.assetSourceNodeId && !assetSource) fail('图片资产不属于指定的可用画布来源');
        return { id: step.id, type: step.type, title: String(existing?.name || step.title || getNodeDefinition(step.type).title).slice(0, 100),
            ...(existing ? { nodeId: existing.id } : {}), ...(patch ? { patch } : {}), parameters: { ...parameters },
            ...(step.assetKey ? { assetKey: step.assetKey,
                ...(images.find(image => image.imageId === step.imageId)?.reference.runId ? {} : {
                    assetSourceNodeId: assetSource?.id || context.nodes.find(node => node.assets.includes(step.assetKey))?.id || null
                }) } : {}), execute };
    });
    const lookup = ref => steps.find(step => step.id === ref)?.type || context.nodes.find(node => node.id === ref)?.type;
    const portType = (ref, port, direction, useExisting = false) => {
        const type = lookup(ref);
        if (type === 'ImageGenerate' && direction === 'inputs' && isReferencePort(port)) return 'image';
        const step = steps.find(item => item.id === ref);
        const node = context.nodes.find(item => item.id === (step?.nodeId || ref));
        const resized = !useExisting && type === 'ImageMerge' && step?.parameters.inputCount !== undefined;
        const ports = resized ? getDynamicNodePorts(type, direction, step.parameters) : node?.[direction];
        return (ports || getNodeDefinition(type)?.[direction])?.find(item => item.name === port)?.type;
    };
    if (!Array.isArray(raw.connections || [])) fail('连线必须是数组');
    const ports = new Set(), retainedDisabled = new Set();
    const connections = (raw.connections || []).map(link => {
        if (!object(link) || !object(link.from) || !object(link.to)) fail('连线无效');
        if (deletedIds.has(link.from.ref) || deletedIds.has(link.to.ref)) fail('不能连接即将删除的节点');
        if (!ids.has(link.to.ref)) fail('只能修改方案内目标节点的输入连线');
        if (steps.some(step => step.id === link.from.ref && step.type === 'ImageImport' && !step.nodeId && !step.assetKey)) fail('空图片节点没有原图，不能作为方案输入');
        const type = portType(link.from.ref, link.from.port, 'outputs');
        const external = context.nodes.find(node => node.id === link.from.ref);
        const enabled = steps.find(step => step.nodeId === external?.id && step.nodeId)?.patch?.enabled ?? external?.enabled;
        if (external && (!enabled || external.missing || external.running)) {
            const target = steps.find(step => step.id === link.to.ref);
            const retained = external.enabled === false && !external.running && context.connections.find(edge =>
                edge.from.nodeId === external.id && edge.from.port === link.from.port && edge.to.nodeId === target?.nodeId
                && (edge.to.port === link.to.port || target?.type === 'ImageGenerate' && isReferencePort(edge.to.port) && isReferencePort(link.to.port)));
            if (!retained) fail('引用的外部节点已禁用、原图缺失或正在运行');
            retainedDisabled.add(retained);
        }
        if (!type || type !== portType(link.to.ref, link.to.port, 'inputs')) fail('连线端口不存在或类型不匹配');
        const key = `${link.to.ref}:${link.to.port}`;
        if (ports.has(key) && link.to.port !== 'referenceImages') fail('同一输入端口不能重复连接');
        ports.add(key);
        return { from: { ref: link.from.ref, port: link.from.port }, to: { ref: link.to.ref, port: link.to.port }, type, ...(Number.isInteger(link.order) ? {order:link.order} : {}) };
    });
    if (!Array.isArray(raw.disconnects || [])) fail('断开输入必须是数组');
    const removedConnectionIds = new Set();
    const ordinalGroups = new Map();
    const disconnects = (raw.disconnects || []).map(item => {
        if (!ids.has(item?.ref) || !portType(item.ref, item.port, 'inputs', true)) fail('只能断开方案内节点的有效输入');
        if (item.connectionId !== undefined) {
            const step = steps.find(candidate => candidate.id === item.ref);
            const matches = context.connections.filter(link => link.id === item.connectionId);
            const edge = matches[0];
            if (typeof item.connectionId !== 'string' || !item.connectionId || matches.length !== 1
                || removedConnectionIds.has(item.connectionId) || !step.nodeId || edge.to.nodeId !== step.nodeId
                || !matchesDisconnectPort(step.type, item.port, edge.to.port)) fail('连线不存在、重复或与指定输入端口不匹配');
            if (deletedIds.has(edge.from.nodeId) || context.nodes.some(node => node.id === edge.from.nodeId && node.running)) {
                fail('连线来源正在运行或已包含在删除操作中');
            }
            if (!explicitInputChanges && !canDisconnectExactEdge(message, item.evidence, edge, context, mentionedIds, ordinalGroups)) {
                fail('本轮未明确授权断开这条连线，请指定连接编号、唯一的起止节点，或第几张参考图。');
            }
            removedConnectionIds.add(item.connectionId);
            return { ref: item.ref, port: item.port, connectionId: item.connectionId };
        }
        return { ref: item.ref, port: item.port };
    });
    for (const item of disconnects.filter(item => item.connectionId !== undefined)) {
        const type = lookup(item.ref);
        if (disconnects.some(other => other.connectionId === undefined && other.ref === item.ref && matchesDisconnectPort(type, item.port, other.port))
            || connections.some(link => link.to.ref === item.ref && matchesDisconnectPort(type, item.port, link.to.port))) {
            fail('同一个输入端口不能同时断开指定连线和整体改线');
        }
    }
    const exactDisconnectAuthorization = removedConnectionIds.size ? { version: 1, ids: [...removedConnectionIds],
        ...(ordinalGroups.size ? { ordinalGroups: Object.fromEntries(ordinalGroups) } : {}) } : undefined;
    // External typed edits identify the exact input port in their operation.
    // Agent proposals still need evidence from the user message.
    const inputEdits = explicitInputChanges ? [...connections.map(link => link.to), ...disconnects.filter(item => item.connectionId === undefined)] : [];
    const inputTargets = matches => {
        const refs = new Set(inputEdits.filter(item => matches(item.port)).map(item => item.ref));
        return steps.filter(step => step.type === 'ImageGenerate' && step.nodeId && refs.has(step.id)).map(step => step.nodeId);
    };
    const explicitReferenceTargets = inputTargets(isReferencePort);
    const referenceInputChange = explicitReferenceTargets.length ? { mode: 'replace', targetNodeIds: explicitReferenceTargets }
        : referenceInputChangePermission(message, steps.filter(step => step.type === 'ImageGenerate'
            && !disconnects.some(item => item.ref === step.id && item.connectionId !== undefined && isReferencePort(item.port))).map(step => step.nodeId));
    if (referenceInputChange?.mode === 'clear') {
        for (const step of steps.filter(step => step.type === 'ImageGenerate' && step.nodeId)) {
            for (const link of context.connections.filter(link => link.to.nodeId === step.nodeId && isReferencePort(link.to.port))) {
                if (!disconnects.some(item => item.ref === step.id && item.port === link.to.port)) disconnects.push({ ref: step.id, port: link.to.port });
            }
        }
    }
    const explicitPromptTargets = inputTargets(port => port === 'prompt');
    const promptInputChange = explicitPromptTargets.length ? { authorizationVersion: 1, targetNodeIds: explicitPromptTargets }
        : promptInputChangePermission(message, steps, context, mentionedIds, connections);
    const identity = ref => steps.find(step => step.id === ref)?.nodeId || (ids.has(ref) ? `new:${ref}` : ref);
    const projectedLinks = projectPlanConnections({ steps, connections, disconnects, deletes, exactDisconnectAuthorization }, context.connections, identity);
    assertCanvasMergeResize(steps, projectedLinks, identity);
    const order = []; const visiting = new Set(); const visited = new Set();
    const visit = id => {
        if (visiting.has(id)) fail('方案存在循环依赖');
        if (visited.has(id)) return;
        visiting.add(id);
        for (const link of projectedLinks.filter(link => link.to.nodeId === identity(id))) {
            const parent = steps.find(step => identity(step.id) === link.from.nodeId);
            if (parent) visit(parent.id);
        }
        visiting.delete(id); visited.add(id); order.push(id);
    };
    steps.forEach(step => visit(step.id));
    const dependencies = [...new Set([...deletedIds, ...context.connections.filter(link => deletedIds.has(link.from.nodeId) || deletedIds.has(link.to.nodeId))
        .flatMap(link => [link.from.nodeId, link.to.nodeId]), ...steps.flatMap(step => [step.nodeId, step.assetSourceNodeId]),
        ...context.connections.filter(link => steps.some(step => step.nodeId === link.to.nodeId)).map(link => link.from.nodeId),
        ...context.connections.filter(link => steps.some(step => step.nodeId === link.from.nodeId && step.type === 'ImageGenerate')).map(link => link.to.nodeId),
        ...connections.map(link => ids.has(link.from.ref) ? null : link.from.ref)].filter(Boolean))];
    const plan = normalizePlanInputs({ version: 1, referenceInputChange, promptInputChange, id: globalThis.crypto?.randomUUID?.() || `plan-${Date.now()}-${Math.random()}`, workflowId: context.workflowId,
        steps, connections, disconnects, deletes, ...(exactDisconnectAuthorization ? { exactDisconnectAuthorization } : {}),
        ...(steps.some(step => step.patch) ? { applyInPlace: true, patchPositions: canvasPlanPatchPositions(steps, context) } : {}),
        deletionConnections: context.connections.filter(link => deletedIds.has(link.from.nodeId) || deletedIds.has(link.to.nodeId)),
        order, dependencies, baseline: canvasBaseline(context, dependencies), modelOverrides: {}, bindings: {}, runs: [] });
    const dynamicPorts = canvasPlanDynamicPorts(plan, context);
    if (dynamicPorts.length) plan.dynamicPorts = dynamicPorts;
    assertReferenceInputsPreserved(plan, context.connections, ref => steps.find(step => step.id === ref)?.nodeId || (ids.has(ref) ? `new:${ref}` : ref));
    const retainedLinks = projectPlanConnections(plan, context.connections, ref => steps.find(step => step.id === ref)?.nodeId || ref);
    if ([...retainedDisabled].some(edge => !retainedLinks.includes(edge))) fail('已禁用来源只能原位保留，不能作为新增输入或改变顺序。');
    assertCanvasPlanPromptInputs(plan, context);
    return plan;
}

export function describeCanvasPlan(plan, context) {
    const displayValue = value => value === '' || value == null ? '（空）' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    const stepLabel = step => context.nodes.find(node => node.id === (step.nodeId || plan.bindings?.[step.id]))?.name || step.title;
    const fieldChange = (step, field, before, after) => {
        const previous = displayValue(before), next = displayValue(after);
        return /[\r\n]/.test(previous + next)
            ? `${stepLabel(step)} · ${field}\n修改前：\n${previous}\n修改后：\n${next}`
            : `${stepLabel(step)} · ${field}：${previous} → ${next}`;
    };
    const label = ref => {
        const step = plan.steps.find(step => step.id === ref);
        return (step && stepLabel(step)) || context.nodes.find(node => node.id === ref)?.name
            || plan.deletes?.find(item => item.nodeId === ref)?.title || ref;
    };
    const endpoint = (ref, port) => `${label(ref)} · ${port === 'image' ? '图片' : port === 'referenceImages' ? '参考图' : /^image_\d+$/.test(port) ? `参考图 ${port.split('_')[1]}` : port === 'prompt' ? '提示词' : port}`;
    const lines = plan.steps.flatMap(step => {
        if (!step.nodeId && !plan.bindings?.[step.id]) return [`新增 ${step.title}（${getNodeDefinition(step.type)?.title || step.type}）`];
        if (plan.applyInPlace && plan.libraryPrompt?.stepId === step.id) {
            const { target, expectedValue } = plan.libraryPrompt;
            return [target === 'system'
                ? fieldChange(step, '系统提示词', expectedValue, step.type === 'TextChat'
                    ? step.parameters.sysprompt : step.parameters.protocolParams.systemPrompt)
                : fieldChange(step, '普通提示词', expectedValue, step.parameters[step.type === 'Text' ? 'text' : 'prompt'])];
        }
        const node = context.nodes.find(node => node.id === (step.nodeId || plan.bindings?.[step.id]));
        const changes = Object.entries(step.parameters).map(([key, value]) => fieldChange(step, key, node?.parameters?.[key], value));
        if (step.patch && node) {
            const { title, enabled, x, y } = step.patch;
            if (title !== undefined) changes.push(fieldChange(step, '名称', node.name, title || getNodeDefinition(node.type)?.title));
            if (enabled !== undefined) changes.push(fieldChange(step, '状态', node.enabled ? '启用' : '停用', enabled ? '启用' : '停用'));
            if (x !== undefined || y !== undefined) {
                const previous = node.position;
                changes.push(fieldChange(step, '位置', `${previous.x}, ${previous.y}`, `${x ?? previous.x}, ${y ?? previous.y}`));
            }
        }
        return changes;
    });
    const deletedIds = new Set((plan.deletes || []).map(item => item.nodeId));
    for (const item of plan.deletes || []) lines.push(`删除 ${item.title} [${item.nodeId}]`);
    for (const link of plan.deletionConnections || context.connections.filter(link => deletedIds.has(link.from.nodeId) || deletedIds.has(link.to.nodeId))) {
        lines.push(`移除连线 ${endpoint(link.from.nodeId, link.from.port)} → ${endpoint(link.to.nodeId, link.to.port)}`);
    }
    for (const link of plan.connections) {
        const target = plan.steps.find(step => step.id === link.to.ref);
        for (const old of context.connections.filter(item => item.to.nodeId === target?.nodeId && item.to.port === link.to.port)) {
            lines.push(`移除连线 ${endpoint(old.from.nodeId, old.from.port)} → ${endpoint(old.to.nodeId, old.to.port)}`);
        }
        lines.push(`连接 ${endpoint(link.from.ref, link.from.port)} → ${endpoint(link.to.ref, link.to.port)}`);
    }
    for (const item of plan.disconnects || []) {
        const target = plan.steps.find(step => step.id === item.ref)?.nodeId || plan.bindings?.[item.ref];
        context.connections.filter(link => (item.connectionId === undefined || link.id === item.connectionId)
            && link.to.nodeId === target && (link.to.port === item.port
            || item.port === 'referenceImages' && isReferencePort(link.to.port)))
            .forEach(link => lines.push(`移除连线 ${endpoint(link.from.nodeId, link.from.port)} → ${endpoint(target, link.to.port)}`));
    }
    return lines;
}

export function assertCanvasPlanCurrent(plan, context) {
    const relevant = new Set(plan.dependencies);
    const baselineContext = plan.templateId ? { ...context, connections: context.connections.filter(edge => relevant.has(edge.to.nodeId)) } : context;
    const patchPositionsChanged = plan.patchPositions
        && JSON.stringify(plan.patchPositions) !== JSON.stringify(canvasPlanPatchPositions(plan.steps, context));
    const dynamicPortsChanged = plan.dynamicPorts && JSON.stringify(plan.dynamicPorts) !== JSON.stringify(canvasPlanDynamicPorts(plan, context));
    const ordinalGroupsChanged = !plan.appliedSignature && Object.entries(plan.exactDisconnectAuthorization?.ordinalGroups || {})
        .some(([targetId, groups]) => JSON.stringify(groups) !== JSON.stringify(ordinalReferenceGroups(context, targetId)));
    if (plan.workflowId !== context.workflowId || patchPositionsChanged || dynamicPortsChanged || ordinalGroupsChanged
        || plan.baseline !== canvasBaseline(baselineContext, plan.dependencies, canvasPlanExecutionNodeIds(plan))) {
        fail(plan.applyInPlace ? '相关画布内容已变化，请重新发送原指令，确认新的变更清单。'
            : '相关画布内容已变化。请在下方 Agent 输入框发送“根据当前画布重新生成方案”，确认新方案后再点击“运行”。');
    }
}

export function restoreCanvasPlan(value) {
    if (!object(value) || value.version !== 1 || !Array.isArray(value.steps)) return null;
    const plan = cloneCanvasValue(value);
    delete plan.historyId;
    for (const run of plan.runs || []) if (run.status === 'running') run.status = 'interrupted';
    if (plan.instances) plan.instances = plan.instances.map(restoreCanvasPlan).filter(Boolean);
    return plan;
}

export function projectCanvasPlan(plan) {
    if (!plan) return null;
    return { version: plan.version, id: plan.id, steps: plan.steps, connections: plan.connections,
        disconnects: plan.disconnects || [], deletes: plan.deletes || [], deletionConnections: plan.deletionConnections || [], bindings: plan.bindings || {}, modelOverrides: plan.modelOverrides || {}, providerOverrides: plan.providerOverrides || {}, agentProviders: plan.agentProviders || {}, thinkingOverrides: plan.thinkingOverrides || {}, agentThinking: plan.agentThinking || {}, agentSizes: plan.agentSizes || {},
        completedSteps: plan.completedSteps || [], completedDeletions: plan.completedDeletions || [], latestAttempt: plan.runs?.at(-1) || null };
}

export function promptPlanToCanvas(prompt, context, { message = '' } = {}) {
    const target = prompt.targetNodeId && context.nodes.find(node => node.id === prompt.targetNodeId);
    const steps = [{ id: 'generate', type: 'ImageGenerate', title: target?.name || '图片生成', parameters: { prompt: prompt.prompt },
        generationPatch: cloneCanvasValue(prompt.parameters || {}), ...(typeof prompt.negativePrompt === 'string' ? { negativePrompt: prompt.negativePrompt } : {}),
        ...Object.fromEntries(['sizeIntent', 'sizeAnswer', 'parameterSources', 'parameterAnswers'].filter(key => prompt[key] !== undefined)
            .map(key => [key, cloneCanvasValue(prompt[key])])),
        ...(target ? { nodeId: target.id } : {}), execute: true }];
    const referenceInputChange = referenceInputChangePermission(message, [target?.id]);
    const connections = [], dependencies = target ? [target.id] : [];
    const existingReferences = target ? context.connections.filter(link => link.to.nodeId === target.id && isReferencePort(link.to.port)) : [];
    existingReferences.forEach(link => dependencies.push(link.from.nodeId));
    if (target && prompt.preserveReferenceSnapshot && !referenceInputChange) {
        const actual = referenceManifest(context.nodes, context.connections, [target.id])[0].inputs
            .flatMap(input => input.assets.map((assetKey, index) => [input.nodeId, input.port, index, assetKey]));
        const expected = (prompt.referenceImages || []).map(image => [image.sourceNodeId, image.sourcePort || 'image',
            image.sourceImageIndex || 0, image.assetKey || image.assetKeys?.[image.sourceImageIndex || 0]]);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('参考图原图或输入顺序已变化，请根据当前画布重新生成方案。');
    }

    const references = target && existingReferences.length && !referenceInputChange ? [] : prompt.referenceImages || [];
    for (const [index, image] of references.entries()) {
        const source = context.nodes.find(node => node.id === image.sourceNodeId);
        const key = image.assetKey || image.assetKeys?.[image.sourceImageIndex || 0] || source?.assets?.[image.sourceImageIndex || 0];
        let ref = source?.id;
        if (key && (image.runId || !source || source.type !== 'ImageImport' || source.assets.length > 1 || source.assets[0] !== key)) {
            ref = `reference_${index + 1}`;
            steps.unshift({ id: ref, type: 'ImageImport', title: image.name || `参考图 ${index + 1}`, parameters: {}, assetKey: key, execute: true });
            if (source && !image.runId) dependencies.push(source.id);
        } else if (source) dependencies.push(source.id);
        else throw new Error('方案参考图已失效，请重新选择原图');
        connections.push({ from: { ref, port: image.sourcePort || 'image' }, to: { ref: 'generate', port: 'referenceImages' }, type: 'image', order: index });
    }
    return normalizePlanInputs({ version: 1, referenceInputChange, id: globalThis.crypto?.randomUUID?.() || `plan-${Date.now()}`, workflowId: context.workflowId,
        steps, connections, disconnects: target && referenceInputChange ? existingReferences.map(link => ({ ref: 'generate', port: link.to.port })) : [],
        order: steps.map(step => step.id), dependencies: [...new Set(dependencies)],
        baseline: canvasBaseline(context, dependencies), modelOverrides: {}, bindings: {}, runs: [] });
}
