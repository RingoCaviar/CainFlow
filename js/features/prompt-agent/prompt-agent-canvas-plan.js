import { agentNodeDefinition as getNodeDefinition, isReferencePort, normalizePlanInputs, assertReferenceInputsPreserved, referenceManifest, projectPlanConnections } from './prompt-agent-reference-inputs.js';
import { CANVAS_FIELDS, CANVAS_TYPES, canvasBaseline, cloneCanvasValue, canvasPlanExecutionNodeIds } from './prompt-agent-canvas-context.js';
import { excludesReferenceImages, mayUseCandidate, referenceInputChangePermission } from './prompt-agent-reference-policy.js';

const fail = message => { throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);

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

// A prompt proposal cannot become effective by silently replacing its real source.
export function assertCanvasPlanPromptInputs(plan, context) {
    const identity = ref => plan.steps.find(step => step.id === ref)?.nodeId || plan.bindings?.[ref] || ref;
    const links = projectPlanConnections(plan, context.connections, identity);
    for (const step of plan.steps) {
        const node = context.nodes.find(node => node.id === identity(step.id));
        if (node?.editable === false && (step.type === 'ImageGenerate' || Object.keys(step.parameters || {}).length)) throw new Error('目标节点参数只读，不能修改克隆或派生文本来源。');
        if (step.type !== 'ImageGenerate' || !node) continue;
        const previous = context.connections.filter(link => link.to.nodeId === node.id && link.to.port === 'prompt').at(-1);
        const next = links.filter(link => link.to.nodeId === node.id && link.to.port === 'prompt').at(-1);
        const changed = previous && (!next || previous.from.nodeId !== next.from.nodeId || previous.from.port !== next.from.port);
        // Old stored flags used a broader text-edit matcher and cannot prove input authorization.
        const permitted = plan.deletes?.some(item => item.nodeId === previous?.from.nodeId)
            || plan.promptInputChange?.authorizationVersion === 1 && plan.promptInputChange.targetNodeIds?.includes(node.id);
        if (changed && plan.promptInputChange && !permitted) throw new Error('旧方案的提示词输入授权无法核验，请重新生成方案并确认输入关系。');
        if (changed && !permitted) throw new Error('方案不能擅自断开或替换上游提示词来源；请明确要求修改输入关系。');
        if (!changed && node.promptSource?.active && Object.hasOwn(step.parameters || {}, 'prompt')
            && step.parameters.prompt !== node.effectivePrompt) {
            throw new Error(`提示词来自上游「${node.promptSource.name || node.promptSource.nodeId}」，请在方案中明确修改支持的真实来源；只读或视角来源请到来源编辑。`);
        }
    }
}
export function normalizeCanvasPlan(raw, context, { message = '', mentionedIds = [], images = [], referencePolicy } = {}) {
    if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.steps) || !Array.isArray(raw.deletes || [])
        || raw.steps.length + (raw.deletes?.length || 0) < 1 || raw.steps.length + (raw.deletes?.length || 0) > 30) fail('画布方案必须为 v1，包含 1 至 30 个操作');
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
            if (!isReferencePort(link.to?.port) || !raw.steps.some(step => step.id === link.to.ref && step.type === 'ImageGenerate')) continue;
            if (raw.steps.some(step => step.id === link.from?.ref)) continue;
            const node = context.nodes.find(node => node.id === link.from?.ref);
            const image = images.find(item => item.reference.sourceNodeId === node?.id);
            if (promptOnly && !node?.assets.some(retained)) fail('仅改提示词不能改用其他画布素材');
            const named = node && (mentionedIds.includes(node.id) || (message.includes(node.name)
                && context.nodes.filter(item => item.name === node.name).length === 1));
            if (referencePolicy.intent === 'generate' && !named && !mayUseCandidate(image, { ...referencePolicy, message, evidence: link.evidence })) {
                fail('请明确指定方案使用的画布参考图，选中节点或旧连线不能自动成为本次输入');
            }
        }
    }
    const ids = new Set();
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
        if (!CANVAS_TYPES.includes(step.type)) fail(`首版不支持操作 ${step.type}`);
        const existing = step.nodeId && context.nodes.find(node => node.id === step.nodeId);
        if (deletedIds.has(step.nodeId)) fail('不能同时修改和删除同一节点');
        if (step.nodeId && (!existing || existing.type !== step.type || !existing.enabled || existing.running)) fail('目标节点不存在、已禁用或正在运行');
        if (existing?.editable === false && Object.keys(step.parameters || {}).length) fail('目标节点参数只读，不能修改克隆或派生文本来源。');
        if (existing && !canTargetNode(existing, context, message, mentionedIds, step.evidence, true)) fail('修改已有节点前请选中或使用 @节点 明确指定目标');
        let parameters = step.parameters || {};
        if (step.type === 'ImageGenerate' && Object.hasOwn(parameters, 'aspectRatio')) {
            if (Object.hasOwn(parameters, 'aspect') && parameters.aspect !== parameters.aspectRatio) fail('方案中的比例设置冲突');
            const { aspectRatio, ...rest } = parameters; parameters = { ...rest, aspect: aspectRatio };
        }
        if (!object(parameters)) fail('节点参数必须是对象');
        for (const [key, value] of Object.entries(parameters)) {
            if (!CANVAS_FIELDS[step.type].includes(key) || !['string', 'number', 'boolean'].includes(typeof value)) fail(`不支持参数 ${step.type}.${key}`);
            if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) fail(`参数 ${key} 无效`);
            if (typeof value === 'string' && value.length > 25000) fail(`参数 ${key} 过长`);
        }
        if (parameters.inputCount !== undefined && (!Number.isInteger(parameters.inputCount) || parameters.inputCount < 1 || parameters.inputCount > 20)) fail('合并输入数量必须在 1 至 20 之间');
        if (parameters.generationCount !== undefined && (!Number.isInteger(parameters.generationCount) || parameters.generationCount < 1 || parameters.generationCount > 20)) fail('生成数量必须在 1 至 20 之间');
        if (step.type === 'ImageGenerate' && !existing && !String(parameters.prompt || '').trim()) fail('新建生图步骤缺少提示词');
        if (step.type === 'ImageImport' && (!existing && !/^media:/.test(step.assetKey || ''))) fail('图片导入必须引用已登记的本地原图资产');
        if (step.assetKey && !context.nodes.some(node => node.assets.includes(step.assetKey))
            && !images.some(image => image.reference.assetKey === step.assetKey || image.reference.assetKeys?.includes(step.assetKey))) fail('图片资产未登记在当前画布或对话中');
        return { id: step.id, type: step.type, title: String(existing?.name || step.title || getNodeDefinition(step.type).title).slice(0, 100),
            ...(existing ? { nodeId: existing.id } : {}), parameters: { ...parameters },
            ...(step.assetKey ? { assetKey: step.assetKey,
                ...(images.find(image => image.imageId === step.imageId)?.reference.runId ? {} : {
                    assetSourceNodeId: context.nodes.find(node => node.assets.includes(step.assetKey))?.id || null
                }) } : {}), execute: step.execute !== false };
    });
    const lookup = ref => steps.find(step => step.id === ref)?.type || context.nodes.find(node => node.id === ref)?.type;
    const portType = (ref, port, direction) => {
        const type = lookup(ref);
        if (type === 'ImageGenerate' && direction === 'inputs' && isReferencePort(port)) return 'image';
        if (direction === 'inputs' && type === 'ImageMerge' && /^image_\d+$/.test(port)) {
            const count = steps.find(step => step.id === ref)?.parameters.inputCount || context.nodes.find(node => node.id === ref)?.parameters.inputCount || 1;
            return Number(port.slice(6)) >= 1 && Number(port.slice(6)) <= count ? 'image' : null;
        }
        return getNodeDefinition(type)?.[direction]?.find(item => item.name === port)?.type;
    };
    if (!Array.isArray(raw.connections || [])) fail('连线必须是数组');
    const ports = new Set(), retainedDisabled = new Set();
    const connections = (raw.connections || []).map(link => {
        if (!object(link) || !object(link.from) || !object(link.to)) fail('连线无效');
        if (deletedIds.has(link.from.ref) || deletedIds.has(link.to.ref)) fail('不能连接即将删除的节点');
        if (!ids.has(link.to.ref)) fail('只能修改方案内目标节点的输入连线');
        const type = portType(link.from.ref, link.from.port, 'outputs');
        const external = context.nodes.find(node => node.id === link.from.ref);
        if (external && (!external.enabled || external.missing || external.running)) {
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
    const disconnects = (raw.disconnects || []).map(item => {
        if (!ids.has(item?.ref) || !portType(item.ref, item.port, 'inputs')) fail('只能断开方案内节点的有效输入');
        return { ref: item.ref, port: item.port };
    });
    // A new generation uses exactly its proposed inputs, never hidden old edges.
    const referenceInputChange = referenceInputChangePermission(message, steps.filter(step => step.type === 'ImageGenerate').map(step => step.nodeId));
    if (referenceInputChange?.mode === 'clear') {
        for (const step of steps.filter(step => step.type === 'ImageGenerate' && step.nodeId)) {
            for (const link of context.connections.filter(link => link.to.nodeId === step.nodeId && isReferencePort(link.to.port))) {
                if (!disconnects.some(item => item.ref === step.id && item.port === link.to.port)) disconnects.push({ ref: step.id, port: link.to.port });
            }
        }
    }
    const promptInputChange = promptInputChangePermission(message, steps, context, mentionedIds, connections);
    const identity = ref => steps.find(step => step.id === ref)?.nodeId || (ids.has(ref) ? `new:${ref}` : ref);
    const projectedLinks = projectPlanConnections({ steps, connections, disconnects, deletes }, context.connections, identity);
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
        steps, connections, disconnects, deletes,
        deletionConnections: context.connections.filter(link => deletedIds.has(link.from.nodeId) || deletedIds.has(link.to.nodeId)),
        order, dependencies, baseline: canvasBaseline(context, dependencies), modelOverrides: {}, bindings: {}, runs: [] });
    assertReferenceInputsPreserved(plan, context.connections, ref => steps.find(step => step.id === ref)?.nodeId || (ids.has(ref) ? `new:${ref}` : ref));
    const retainedLinks = projectPlanConnections(plan, context.connections, ref => steps.find(step => step.id === ref)?.nodeId || ref);
    if ([...retainedDisabled].some(edge => !retainedLinks.includes(edge))) fail('已禁用来源只能原位保留，不能作为新增输入或改变顺序。');
    assertCanvasPlanPromptInputs(plan, context);
    return plan;
}

export function describeCanvasPlan(plan, context) {
    const displayValue = value => value === '' || value == null ? '（空）' : typeof value === 'string' ? value : String(value);
    const stepLabel = step => context.nodes.find(node => node.id === (step.nodeId || plan.bindings?.[step.id]))?.name || step.title;
    const label = ref => {
        const step = plan.steps.find(step => step.id === ref);
        return (step && stepLabel(step)) || context.nodes.find(node => node.id === ref)?.name
            || plan.deletes?.find(item => item.nodeId === ref)?.title || ref;
    };
    const endpoint = (ref, port) => `${label(ref)} · ${port === 'image' ? '图片' : /^image_\d+$/.test(port) ? `参考图 ${port.split('_')[1]}` : port === 'prompt' ? '提示词' : port}`;
    const lines = plan.steps.flatMap(step => {
        if (!step.nodeId && !plan.bindings?.[step.id]) return [`新增 ${step.title}（${getNodeDefinition(step.type)?.title || step.type}）`];
        const before = context.nodes.find(node => node.id === (step.nodeId || plan.bindings?.[step.id]))?.parameters || {};
        return Object.entries(step.parameters).map(([key, value]) => {
            const previous = displayValue(before[key]), next = displayValue(value);
            return /[\r\n]/.test(previous + next)
                ? `${stepLabel(step)} · ${key}\n修改前：\n${previous}\n修改后：\n${next}`
                : `${stepLabel(step)} · ${key}：${previous} → ${next}`;
        });
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
        context.connections.filter(link => link.to.nodeId === target && link.to.port === item.port)
            .forEach(link => lines.push(`移除连线 ${endpoint(link.from.nodeId, link.from.port)} → ${endpoint(target, item.port)}`));
    }
    return lines;
}

export function assertCanvasPlanCurrent(plan, context) {
    if (plan.workflowId !== context.workflowId || plan.baseline !== canvasBaseline(context, plan.dependencies, canvasPlanExecutionNodeIds(plan))) fail('相关画布内容已变化。请在下方 Agent 输入框发送“根据当前画布重新生成方案”，确认新方案后再点击“应用并执行”。');
}

export function restoreCanvasPlan(value) {
    if (!object(value) || value.version !== 1 || !Array.isArray(value.steps)) return null;
    const plan = cloneCanvasValue(value);
    delete plan.historyId;
    for (const run of plan.runs || []) if (run.status === 'running') run.status = 'interrupted';
    return plan;
}

export function projectCanvasPlan(plan) {
    if (!plan) return null;
    return { version: plan.version, id: plan.id, steps: plan.steps, connections: plan.connections,
        disconnects: plan.disconnects || [], deletes: plan.deletes || [], deletionConnections: plan.deletionConnections || [], bindings: plan.bindings || {}, modelOverrides: plan.modelOverrides || {}, providerOverrides: plan.providerOverrides || {}, agentProviders: plan.agentProviders || {}, thinkingOverrides: plan.thinkingOverrides || {}, agentThinking: plan.agentThinking || {}, agentSizes: plan.agentSizes || {},
        completedSteps: plan.completedSteps || [], latestAttempt: plan.runs?.at(-1) || null };
}

export function promptPlanToCanvas(prompt, context, { message = '' } = {}) {
    const target = prompt.targetNodeId && context.nodes.find(node => node.id === prompt.targetNodeId);
    const steps = [{ id: 'generate', type: 'ImageGenerate', title: target?.name || '图片生成', parameters: { prompt: prompt.prompt },
        generationPatch: cloneCanvasValue(prompt.parameters || {}), ...(typeof prompt.negativePrompt === 'string' ? { negativePrompt: prompt.negativePrompt } : {}),
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
