import { canvasBaseline } from './prompt-agent-canvas-context.js';
import { normalizeCanvasPlan } from './prompt-agent-canvas-plan.js';

function resolveDestination(context, nodeId, target) {
    if (target !== 'prompt' && target !== 'system') throw new Error('请选择普通提示词或系统提示词');
    const requested = context.nodes.find(node => node.id === nodeId);
    if (!requested || requested.running) throw new Error('目标节点不存在或正在运行');
    if (!['Text', 'ImageGenerate', 'TextChat'].includes(requested.type)) throw new Error('套用提示词支持文本、图片生成和智能对话节点');
    if (!requested.editable) throw new Error('目标节点只读，请指定可编辑的节点');
    if (target === 'system') {
        if (requested.type === 'TextChat') {
            return { node: requested, control: 'sysprompt', previousValue: requested.parameters.sysprompt || '' };
        }
        if (!requested.supportsSystemPrompt) throw new Error('目标节点当前没有可编辑的系统提示词');
        return { node: requested, control: 'param-systemPrompt', previousValue: requested.parameters.protocolParams?.systemPrompt || '' };
    }
    if (requested.type === 'Text') {
        if (context.connections.some(edge => edge.to.nodeId === nodeId && edge.to.port === 'text')) {
            throw new Error('目标文本节点由上游提供内容，请指定可编辑的文本来源');
        }
        return { node: requested, control: 'text', previousValue: requested.parameters.text || '' };
    }
    const inputs = context.connections.filter(edge => edge.to.nodeId === nodeId && edge.to.port === 'prompt');
    if (!inputs.length) {
        return { node: requested, control: 'prompt', previousValue: requested.effectivePrompt ?? requested.parameters.prompt ?? '' };
    }
    const [input] = inputs;
    const source = context.nodes.find(node => node.id === input.from.nodeId);
    if (inputs.length !== 1 || input.from.port !== 'text' || source?.type !== 'Text' || !source.enabled
        || !source.editable || source.running || context.connections.some(edge => edge.to.nodeId === source.id && edge.to.port === 'text')) {
        throw new Error('普通提示词来自不可直接编辑的上游，请指定可编辑的提示词来源');
    }
    if (context.connections.some(edge => edge !== input && edge.from.nodeId === source.id && edge.from.port === 'text')) {
        throw new Error('上游文本来源由多个输入共用，请直接指定要编辑的文本节点');
    }
    return { node: source, control: 'text', previousValue: source.parameters.text || '' };
}

function planParameters(control, content) {
    if (control === 'param-systemPrompt') return { protocolParams: { systemPrompt: content } };
    return { [control]: content };
}

export function createPrepareApplyPrompt({ promptLibrary }) {
    return async function prepareApplyPrompt({ nodeId, promptId, name, target = 'prompt' }, { context, isCurrent = () => true } = {}) {
        if (!isCurrent() || !context?.workflowId) throw new Error('工作流已变化，请重新选择目标');
        if (typeof nodeId !== 'string' || !nodeId) throw new Error('请指定当前画布节点');
        const { node, control, previousValue } = resolveDestination(context, nodeId, target);
        const preset = await promptLibrary().getPrompt({ promptId, name });
        if (!isCurrent()) throw new Error('工作流已变化，请重新选择目标');
        let stepId = 'apply-library-prompt';
        for (let suffix = 1; context.nodes.some(item => item.id === stepId); suffix++) stepId = 'apply-library-prompt-' + suffix;
        const plan = normalizeCanvasPlan({ version: 1, steps: [{
            id: stepId, type: node.type, nodeId: node.id, parameters: planParameters(control, preset.content), execute: false
        }] }, context, { mentionedIds: [node.id] });
        plan.applyInPlace = true;
        plan.libraryPrompt = { stepId, requestedNodeId: nodeId, target, expectedValue: previousValue };
        if (!plan.dependencies.includes(nodeId)) {
            plan.dependencies.push(nodeId);
            plan.baseline = canvasBaseline(context, plan.dependencies);
        }
        return { plan, nodeId, appliedNodeId: node.id, promptName: preset.name, target };
    };
}

export function isPromptLibraryWrite(plan, step) {
    return plan.applyInPlace === true && plan.libraryPrompt?.stepId === step.id;
}

export function validatePromptLibraryWrite(plan, step, context) {
    if (plan.steps.length !== 1 || plan.connections.length || plan.disconnects?.length || plan.deletes?.length || step.execute !== false) {
        throw new Error('提示词库操作只能修改一个节点字段');
    }
    const { requestedNodeId, expectedValue, target } = plan.libraryPrompt;
    const { node, control, previousValue } = resolveDestination(context, requestedNodeId, target);
    if (node.id !== step.nodeId || node.type !== step.type || previousValue !== expectedValue) {
        throw new Error('目标提示词或来源已变化，请重新套用预设');
    }
    const content = control === 'param-systemPrompt' ? step.parameters?.protocolParams?.systemPrompt : step.parameters?.[control];
    if (typeof content !== 'string' || !content.trim() || content.length > 20_000
        || JSON.stringify(step.parameters) !== JSON.stringify(planParameters(control, content))) {
        throw new Error('提示词库预设无效');
    }
    return { control, content };
}
