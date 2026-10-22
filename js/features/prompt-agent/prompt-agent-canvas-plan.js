import { getNodeDefinition } from '../../nodes/registry.js';
import { CANVAS_FIELDS, CANVAS_TYPES, canvasBaseline, cloneCanvasValue } from './prompt-agent-canvas-context.js';
import { excludesReferenceImages, mayUseCandidate } from './prompt-agent-reference-policy.js';

const fail = message => { throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function normalizeCanvasPlan(raw, context, { message = '', mentionedIds = [], images = [], referencePolicy } = {}) {
    if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > 30) fail('画布方案必须为 v1，包含 1 至 30 个步骤');
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
        if (noImages && (raw.connections || []).some(link => /^image_\d+$/.test(link.to?.port)
            && raw.steps.some(step => step.id === link.to.ref && step.type === 'ImageGenerate'))) fail('纯文字生成方案不能连接参考图，请重新整理方案');
        for (const link of raw.connections || []) {
            if (!/^image_\d+$/.test(link.to?.port) || !raw.steps.some(step => step.id === link.to.ref && step.type === 'ImageGenerate')) continue;
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
        if (step.nodeId && (!existing || existing.type !== step.type || !existing.enabled || existing.running)) fail('目标节点不存在、已禁用或正在运行');
        if (existing && !mentionedIds.includes(existing.id)) {
            const evidence = typeof step.evidence === 'string' ? step.evidence : '';
            if (!evidence || !message.includes(evidence) || !evidence.includes(existing.name)
                || context.nodes.filter(node => node.name === existing.name).length !== 1) fail('修改已有节点前请使用 @节点 明确指定目标');
        }
        const parameters = step.parameters || {};
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
        return { id: step.id, type: step.type, title: String(step.title || getNodeDefinition(step.type).title).slice(0, 100),
            ...(existing ? { nodeId: existing.id } : {}), parameters: { ...parameters },
            ...(step.assetKey ? { assetKey: step.assetKey,
                ...(images.find(image => image.imageId === step.imageId)?.reference.runId ? {} : {
                    assetSourceNodeId: context.nodes.find(node => node.assets.includes(step.assetKey))?.id || null
                }) } : {}), execute: step.execute !== false };
    });
    const lookup = ref => steps.find(step => step.id === ref)?.type || context.nodes.find(node => node.id === ref)?.type;
    const portType = (ref, port, direction) => {
        const type = lookup(ref);
        if (direction === 'inputs' && type === 'ImageMerge' && /^image_\d+$/.test(port)) {
            const count = steps.find(step => step.id === ref)?.parameters.inputCount || context.nodes.find(node => node.id === ref)?.parameters.inputCount || 1;
            return Number(port.slice(6)) >= 1 && Number(port.slice(6)) <= count ? 'image' : null;
        }
        return getNodeDefinition(type)?.[direction]?.find(item => item.name === port)?.type;
    };
    if (!Array.isArray(raw.connections || [])) fail('连线必须是数组');
    const ports = new Set();
    const connections = (raw.connections || []).map(link => {
        if (!object(link) || !object(link.from) || !object(link.to)) fail('连线无效');
        if (!ids.has(link.to.ref)) fail('只能修改方案内目标节点的输入连线');
        const type = portType(link.from.ref, link.from.port, 'outputs');
        const external = context.nodes.find(node => node.id === link.from.ref);
        if (external && (!external.enabled || external.missing || external.running)) fail('引用的外部节点已禁用、原图缺失或正在运行');
        if (!type || type !== portType(link.to.ref, link.to.port, 'inputs')) fail('连线端口不存在或类型不匹配');
        const key = `${link.to.ref}:${link.to.port}`;
        if (ports.has(key)) fail('同一输入端口不能重复连接');
        ports.add(key);
        return { from: { ref: link.from.ref, port: link.from.port }, to: { ref: link.to.ref, port: link.to.port }, type };
    });
    if (!Array.isArray(raw.disconnects || [])) fail('断开输入必须是数组');
    const disconnects = (raw.disconnects || []).map(item => {
        if (!ids.has(item?.ref) || !portType(item.ref, item.port, 'inputs')) fail('只能断开方案内节点的有效输入');
        return { ref: item.ref, port: item.port };
    });
    // A new generation uses exactly its proposed inputs, never hidden old edges.
    if (referencePolicy && (referencePolicy.intent === 'generate' || excludesReferenceImages(message, referencePolicy.selection))) {
        for (const step of steps.filter(step => step.type === 'ImageGenerate' && step.nodeId)) {
            for (const link of context.connections.filter(link => link.to.nodeId === step.nodeId && /^image_\d+$/.test(link.to.port))) {
                if (!disconnects.some(item => item.ref === step.id && item.port === link.to.port)) disconnects.push({ ref: step.id, port: link.to.port });
            }
        }
    }
    const order = []; const visiting = new Set(); const visited = new Set();
    const visit = id => {
        if (visiting.has(id)) fail('方案存在循环依赖');
        if (visited.has(id)) return;
        visiting.add(id);
        connections.filter(link => link.to.ref === id && ids.has(link.from.ref)).forEach(link => visit(link.from.ref));
        visiting.delete(id); visited.add(id); order.push(id);
    };
    steps.forEach(step => visit(step.id));
    const dependencies = [...new Set([...steps.flatMap(step => [step.nodeId, step.assetSourceNodeId]),
        ...context.connections.filter(link => steps.some(step => step.nodeId === link.to.nodeId)).map(link => link.from.nodeId),
        ...context.connections.filter(link => steps.some(step => step.nodeId === link.from.nodeId && step.type === 'ImageGenerate')).map(link => link.to.nodeId),
        ...connections.map(link => ids.has(link.from.ref) ? null : link.from.ref)].filter(Boolean))];
    return { version: 1, id: globalThis.crypto?.randomUUID?.() || `plan-${Date.now()}-${Math.random()}`, workflowId: context.workflowId,
        steps, connections, disconnects, order, dependencies, baseline: canvasBaseline(context, dependencies), modelOverrides: {}, bindings: {}, runs: [] };
}

export function describeCanvasPlan(plan, context) {
    const displayValue = value => value === '' || value == null ? '（空）' : typeof value === 'string' ? value : String(value);
    const label = ref => plan.steps.find(step => step.id === ref)?.title || context.nodes.find(node => node.id === ref)?.name || ref;
    const endpoint = (ref, port) => `${label(ref)} · ${port === 'image' ? '图片' : /^image_\d+$/.test(port) ? `参考图 ${port.split('_')[1]}` : port === 'prompt' ? '提示词' : port}`;
    const lines = plan.steps.flatMap(step => {
        if (!step.nodeId && !plan.bindings?.[step.id]) return [`新增 ${step.title}（${getNodeDefinition(step.type)?.title || step.type}）`];
        const before = context.nodes.find(node => node.id === (step.nodeId || plan.bindings?.[step.id]))?.parameters || {};
        return Object.entries(step.parameters).map(([key, value]) => {
            const previous = displayValue(before[key]), next = displayValue(value);
            return /[\r\n]/.test(previous + next)
                ? `${step.title} · ${key}\n修改前：\n${previous}\n修改后：\n${next}`
                : `${step.title} · ${key}：${previous} → ${next}`;
        });
    });
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
    if (plan.workflowId !== context.workflowId || plan.baseline !== canvasBaseline(context, plan.dependencies, Object.values(plan.bindings || {}))) fail('相关画布内容已变化，请刷新方案并重新确认');
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
        disconnects: plan.disconnects || [], bindings: plan.bindings || {}, modelOverrides: plan.modelOverrides || {},
        completedSteps: plan.completedSteps || [], latestAttempt: plan.runs?.at(-1) || null };
}

export function promptPlanToCanvas(prompt, context) {
    const target = prompt.targetNodeId && context.nodes.find(node => node.id === prompt.targetNodeId);
    const steps = [{ id: 'generate', type: 'ImageGenerate', title: '图片生成', parameters: { prompt: prompt.prompt },
        generationPatch: cloneCanvasValue(prompt.parameters || {}), ...(typeof prompt.negativePrompt === 'string' ? { negativePrompt: prompt.negativePrompt } : {}),
        ...(target ? { nodeId: target.id } : {}), execute: true }];
    const connections = [], dependencies = target ? [target.id] : [];
    for (const [index, image] of (prompt.referenceImages || []).entries()) {
        const source = context.nodes.find(node => node.id === image.sourceNodeId);
        const key = image.assetKey || image.assetKeys?.[image.sourceImageIndex || 0] || source?.assets?.[image.sourceImageIndex || 0];
        let ref = source?.id;
        if (key && (image.runId || !source || source.type !== 'ImageImport' || source.assets.length > 1 || source.assets[0] !== key)) {
            ref = `reference_${index + 1}`;
            steps.unshift({ id: ref, type: 'ImageImport', title: image.name || `参考图 ${index + 1}`, parameters: {}, assetKey: key, execute: true });
            if (source && !image.runId) dependencies.push(source.id);
        } else if (source) dependencies.push(source.id);
        else throw new Error('方案参考图已失效，请重新选择原图');
        connections.push({ from: { ref, port: image.sourcePort || 'image' }, to: { ref: 'generate', port: `image_${index + 1}` }, type: 'image' });
    }
    return { version: 1, id: globalThis.crypto?.randomUUID?.() || `plan-${Date.now()}`, workflowId: context.workflowId,
        steps, connections, disconnects: target ? context.connections.filter(link => link.to.nodeId === target.id && /^image_\d+$/.test(link.to.port)).map(link => ({ ref: 'generate', port: link.to.port })) : [],
        order: steps.map(step => step.id), dependencies: [...new Set(dependencies)],
        baseline: canvasBaseline(context, dependencies), modelOverrides: {}, bindings: {}, runs: [] };
}
