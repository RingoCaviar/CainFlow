import { getNodeDefinitionPorts } from './registry.js';
import { getCanonicalImageList, normalizeImageList } from '../features/execution/execution-data-utils.js';
import { projectImageOutput } from './image-output-projection.js';
import { getGenerationInputProtocolId } from '../features/execution/provider-request-utils.js';
import { getProtocol } from '../features/execution/protocols/index.js';
import { resolveDeclarativeProtocolVariant } from '../features/execution/protocols/declarative-protocol-schema.js';
import { splitTextForTextSplitNode } from '../core/common-utils.js';

// Each node type opts in when its card and input details use this contract.
const UNIVERSAL_INPUT_NODE_TYPES = new Set(['ImageGenerate', 'ImagePreview', 'ImageResize', 'ColorReset', 'ImageCompare', 'ImageMerge', 'ImageSave', 'CameraControl']);

function mergeRoleCount(node, connections = []) {
    const indices = connections.filter(edge => edge.to?.nodeId === node.id && /^image_\d+$/.test(edge.to.port))
        .map(edge => Number(edge.to.port.slice(6))).filter(index => Number.isSafeInteger(index) && index > 0);
    const configured = Number(node.data?.inputCount ?? node.inputCount ?? 1);
    return Math.max(1, Number.isSafeInteger(configured) ? configured : 1, ...(indices.map(index => index + 1)));
}

export function getUniversalInputRoles(node, state = null) {
    if (node?.type === 'ImageSave') return [['image', '图片输入', 'image'], ['video', '视频输入', 'video']];
    if (node?.type === 'ImageMerge') return Array.from({ length: mergeRoleCount(node, state?.connections) }, (_, index) => [`image_${index + 1}`, `图片 ${index + 1}`, 'image']);
    if (node?.type === 'ImageCompare') return [['imageA', '对比 A（可选）', 'image'], ['imageB', '结果 B（必需）', 'image']];
    if (isUniversalInputNode(node) && node.type !== 'ImageGenerate') return [['image', '图片输入', 'image']];
    return node?.type === 'ImageGenerate' ? [
        ['prompt', '主提示词', 'text'], ['camera_prompt', '视角提示词', 'text'],
        ['referenceImages', '参考图', 'image'], ['mask', '遮罩', 'image'], ['params', '自定义参数', 'params']
    ] : [];
}

export function isUniversalInputNode(node) {
    return UNIVERSAL_INPUT_NODE_TYPES.has(node?.type);
}

const referencePort = port => port === 'referenceImages' || port === 'image' || /^image_\d+$/.test(port || '');
const logicalPort = port => referencePort(port) ? 'referenceImages' : port;

function imageOutput(node) {
    return projectImageOutput(node, getCanonicalImageList(node));
}

function hasRemoteImageOutput(node) {
    return node?.type === 'ImageImport' && (node.importMode ?? node.data?.importMode) === 'url'
        || imageOutput(node).images.some(image => /^https?:\/\//i.test(image));
}

function sourceOutputDescriptor(node, name) {
    const declared = getNodeDefinitionPorts(node?.type, 'output');
    if (node?.type !== 'TextSplit') return declared.find(port => port.name === name);
    const template = declared.find(port => port.type === 'text');
    if (!template) return null;
    const mounted = Array.from(node.el?.querySelectorAll?.('.node-port[data-direction="output"]') || []);
    if (mounted.length) {
        const actual = mounted.find(port => port.dataset.port === name);
        return actual?.dataset.type === template.type ? { ...template, name } : null;
    }
    const data = node.data || {};
    if (data.mergeOutputEnabled === true) return name === 'text' ? { ...template, name } : null;
    const index = Number(String(name || '').match(/^part_(\d+)$/)?.[1]);
    const configured = Math.max(0, parseInt(data.outputCount ?? node.outputCount ?? '0', 10) || 0);
    const parts = Array.isArray(data.parts) && data.parts.length ? data.parts
        : Array.isArray(data.texts) && data.texts.length ? data.texts
            : splitTextForTextSplitNode(data.text || node.text || '', data.delimiter || node.delimiter || '', { removeEmptyLines: data.removeEmptyLines === true });
    const count = configured || Math.max(1, parts.length);
    return index > 0 && index <= count ? { ...template, name } : null;
}

function generationContract(state, node) {
    const modelId = node.apiConfigId ?? node.data?.apiConfigId ?? state.nodeDefaults?.ImageGenerate?.apiConfigId;
    const model = (state.models || []).find(candidate => candidate.id === modelId);
    if (!model) return { error: '请先选择有效的生图模型。' };
    const protocolId = getGenerationInputProtocolId(model), protocol = getProtocol(protocolId);
    if (!protocol) return { error: '当前模型协议未加载，请检查模型兼容格式。' };
    const hasVariants = Object.keys(protocol.variants || {}).length > 0;
    const resolved = hasVariants
        ? resolveDeclarativeProtocolVariant(protocol, model.modelId) : { configuration: protocol };
    if (hasVariants && !resolved.variant) return { error: '当前协议未配置此模型变体，请切换兼容模型。' };
    const configuration = resolved.configuration;
    if (Array.isArray(configuration.taskTypes) && !configuration.taskTypes.includes('image')) return { error: '当前模型协议不支持图片生成。' };
    const reference = Object.entries(configuration.parameters || {}).find(([key, parameter]) => (parameter?.id || key) === 'referenceImages')?.[1];
    const supportsReferences = reference?.inputPort === true && reference.portType === 'image'
        && (!Array.isArray(reference.taskTypes) || reference.taskTypes.includes('image'));
    const capacities = [reference?.portCount, configuration.referenceImage?.maxCount]
        .filter(value => value !== undefined && value !== null && Number.isFinite(Number(value))).map(Number);
    return { protocolId, supportsReferences, maxReferences: capacities.length ? Math.max(0, Math.min(...capacities)) : Infinity, error: '' };
}

function roleError(contract, port) {
    if (contract.error) return contract.error;
    if (port === 'referenceImages' && (!contract.supportsReferences || contract.maxReferences === 0)) return '当前模型协议不支持参考图输入，请保留关系并选择兼容模型。';
    if (port === 'mask' && contract.protocolId !== 'openai') return '当前模型协议不支持遮罩输入，请选择兼容模型。';
    return '';
}

function createsCycle(connections, sourceId, targetId) {
    const queue = [targetId], seen = new Set();
    while (queue.length) {
        const id = queue.pop();
        if (id === sourceId) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const edge of connections) if (edge.from?.nodeId === id) queue.push(edge.to?.nodeId);
    }
    return false;
}

export function resolveUniversalInput({ state, sourceNode, sourcePort, sourceType, targetNode, role = 'auto', ignoreConnectionId = null }) {
    const failure = error => ({ port: '', type: '', multiple: false, error });
    if (!isUniversalInputNode(targetNode)) return failure('当前节点尚未启用通用输入。');
    const descriptor = sourceOutputDescriptor(sourceNode, sourcePort);
    if (!descriptor) return failure('来源输出端口不存在或已变化，请重新连接。');
    if (sourceType && sourceType !== descriptor.type) return failure('来源输出类型已变化，请重新连接。');
    const type = descriptor.type;
    const connections = (state.connections || []).filter(edge => !ignoreConnectionId || edge.id !== ignoreConnectionId);
    const compareRole = targetNode.type === 'ImageCompare' && type === 'image'
        ? ['imageA', 'imageB'].find(name => !connections.some(edge => edge.to?.nodeId === targetNode.id && edge.to.port === name)) : null;
    if (targetNode.type === 'ImageCompare' && type === 'image' && role === 'auto' && !compareRole) return failure('对比 A/B 已满，请在输入明细中明确替换。');
    let port = role;
    if (role === 'auto') {
        if (targetNode.type === 'ImageCompare') port = compareRole;
        else if (targetNode.type === 'ImageSave') port = { image: 'image', video: 'video' }[type];
        else if (targetNode.type === 'ImageMerge') {
            const indices = connections.filter(edge => edge.to?.nodeId === targetNode.id && /^image_\d+$/.test(edge.to.port))
                .map(edge => Number(edge.to.port.slice(6))).filter(index => Number.isSafeInteger(index) && index > 0);
            port = type === 'image' ? `image_${Math.max(0, ...indices) + 1}` : null;
        } else port = (targetNode.type !== 'ImageGenerate' ? { image: 'image' }
            : { image: 'referenceImages', text: sourceNode.type === 'CameraControl' ? 'camera_prompt' : 'prompt', params: 'params' })[type];
    }
    if (!getUniversalInputRoles(targetNode, state).some(([name, , acceptedType]) => name === port && acceptedType === type)) return failure('来源类型不兼容所选输入用途。');
    if (sourceNode.id === targetNode.id) return failure('节点不能连接到自身。');
    if ([sourceNode, targetNode].some(node => state.runningNodeIds?.has(node.id) || ['waiting','running'].includes(node.runStatus))) {
        return failure('节点正在运行，暂不能修改输入连接。');
    }
    const incoming = connections.filter(edge => edge.to?.nodeId === targetNode.id && (targetNode.type === 'ImageGenerate' ? logicalPort(edge.to.port) : edge.to.port) === port);
    if (targetNode.type === 'ImageMerge') {
        const original = state.connections.find(edge => edge.id === ignoreConnectionId);
        const keepsSource = original?.from.nodeId === sourceNode.id && original.from.port === sourcePort;
        if (!keepsSource && connections.some(edge => edge.to?.nodeId === targetNode.id && edge.from?.nodeId === sourceNode.id && edge.from.port === sourcePort)) return failure('不能重复连接相同来源输出。');
    }
    if (incoming.some(edge => edge.from?.nodeId === sourceNode.id && edge.from?.port === sourcePort)) return failure('不能重复连接相同来源输出。');
    if (port !== 'referenceImages' && incoming.length) return failure('该输入用途已占用，请在输入明细中明确替换。');
    if (createsCycle(connections, sourceNode.id, targetNode.id)) return failure('此连接会形成循环，请选择其他来源。');
    if (targetNode.type !== 'ImageGenerate') {
        if (targetNode.type === 'ImageResize' && hasRemoteImageOutput(sourceNode)) return failure('URL 图片不支持连接到图片缩放节点。');
        return { port, type, multiple: false, error: '' };
    }
    const contract = generationContract(state, targetNode), unsupported = roleError(contract, port);
    if (unsupported) return failure(unsupported);
    if (type === 'image' && contract.protocolId === 'google' && hasRemoteImageOutput(sourceNode)) return failure('URL 图片仅支持兼容参考图，当前模型不支持。');
    if (port === 'mask' && imageOutput(sourceNode).count !== 1) return failure('新增遮罩需要已明确输出的单图来源；多图或尚无输出的来源不能自动截取。');
    if (port === 'referenceImages') {
        const count = [...incoming.map(edge => state.nodes.get(edge.from.nodeId)), sourceNode]
            .filter(node => node?.enabled !== false).reduce((sum, node) => sum + Math.max(1, imageOutput(node).count), 0);
        if (count > contract.maxReferences) return failure(`当前模型最多接收 ${contract.maxReferences} 张参考图，已知批次及待输出来源至少占用 ${count} 张。`);
    }
    return { port, type, multiple: port === 'referenceImages', error: '', ...(port === 'mask' ? { maskConsumption: 'single' } : {}) };
}

/** Plan both logical roles together; validation never mutates the live graph. */
export function planCompareInputSwap({ state, node }) {
    const fail = error => ({ error });
    if (node?.type !== 'ImageCompare' || state.nodes.get(node.id) !== node) return fail('对比节点已变化，请重新查看。');
    if (state.historyTransitionInProgress || state.canvasPlanApplying) return fail('画布正在修改，请稍后再交换。');
    const incoming = state.connections.filter(edge => edge.to?.nodeId === node.id && ['imageA', 'imageB'].includes(edge.to.port));
    if (!incoming.length) return fail('请先连接对比图片。');
    if (incoming.filter(edge => edge.to.port === 'imageA').length > 1 || incoming.filter(edge => edge.to.port === 'imageB').length > 1) return fail('对比输入存在冲突，请先检查连接。');
    const changes = new Map(incoming.map(edge => [edge, { ...edge, to: { ...edge.to, port: edge.to.port === 'imageA' ? 'imageB' : 'imageA' } }]));
    const connections = state.connections.map(edge => changes.get(edge) || edge);
    for (const edge of changes.values()) {
        const sourceNode = state.nodes.get(edge.from?.nodeId);
        const result = resolveUniversalInput({ state: { ...state, connections }, targetNode: node,
            sourceNode, sourcePort: edge.from?.port, sourceType: edge.type, role: edge.to.port, ignoreConnectionId: edge.id });
        if (result.error) return fail(result.error);
    }
    return { connections, error: '' };
}

export function planMoveMergeInput({ state, connectionId, direction }) {
    const fail = error => ({ error, connections: null });
    if (state.historyTransitionInProgress || state.canvasPlanApplying) return fail('画布正在修改，请稍后再排序。');
    const edge = state.connections.find(item => item.id === connectionId), node = state.nodes.get(edge?.to?.nodeId);
    if (node?.type !== 'ImageMerge' || !/^image_\d+$/.test(edge.to.port)) return fail('合并输入已变化，请重新查看。');
    if (![-1, 1].includes(direction)) return fail('请选择前移或后移。');
    const incoming = state.connections.filter(item => item.to?.nodeId === node.id && /^image_\d+$/.test(item.to.port))
        .sort((a, b) => Number(a.to.port.slice(6)) - Number(b.to.port.slice(6)));
    if (new Set(incoming.map(item => item.to.port)).size !== incoming.length) return fail('动态输入存在冲突，请先检查连接。');
    const neighbor = incoming[incoming.indexOf(edge) + direction];
    if (!neighbor) return { connections: null, error: '' };
    const changes = new Map([[edge, { ...edge, to: { ...edge.to, port: neighbor.to.port } }],
        [neighbor, { ...neighbor, to: { ...neighbor.to, port: edge.to.port } }]]);
    const connections = state.connections.map(item => changes.get(item) || item);
    for (const next of changes.values()) {
        const policy = resolveUniversalInput({ state: { ...state, connections }, sourceNode: state.nodes.get(next.from.nodeId),
            sourcePort: next.from.port, sourceType: next.type, targetNode: node, role: next.to.port, ignoreConnectionId: next.id });
        if (policy.error) return fail(policy.error);
    }
    return { connections, error: '' };
}

export function validateUniversalImageInputs({ state, node, inputs }) {
    if (!['ImageGenerate', 'ImageMerge'].includes(node?.type)) return '';
    const incoming = (state.connections || []).filter(edge => edge.to?.nodeId === node.id
        && state.nodes.get(edge.from?.nodeId)?.enabled !== false);
    if (node.type === 'ImageMerge') {
        for (const edge of incoming.filter(edge => /^image_\d+$/.test(edge.to.port))) {
            const source = state.nodes.get(edge.from.nodeId), output = imageOutput(source);
            const raw = output.remote ? null : [source?.data?.imageList, source?.data?.images, source?.imageDataList].find(list => Array.isArray(list) && list.length);
            const actual = inputs ? normalizeImageList(inputs[edge.to.port]).length : output.images.length;
            if (!source || output.missingPositions.length || output.compacted || raw?.some(value => !value)
                || Math.max(output.count, raw?.length || 0) > actual) return `合并输入 ${edge.to.port} 的原图存在缺失，请恢复完整批次后再运行。`;
        }
        return '';
    }
    const references = incoming.filter(edge => referencePort(edge.to.port));
    const masks = incoming.filter(edge => edge.to.port === 'mask');
    const inputReferenceCount = inputs ? Object.entries(inputs).filter(([port]) => referencePort(port))
        .reduce((sum, [, value]) => sum + normalizeImageList(value).length, 0) : 0;
    const contract = generationContract(state, node);
    // Old mask connections retain their previous protocol behavior, including
    // protocols that ignored the mask. Explicit replacements get the new rule.
    const checked = incoming.filter(edge => edge.to.port !== 'mask' || edge.maskConsumption === 'single');
    for (const edge of checked) {
        const unsupported = roleError(contract, logicalPort(edge.to.port));
        if (unsupported) return unsupported;
        if (contract.protocolId === 'google' && edge.type === 'image' && hasRemoteImageOutput(state.nodes.get(edge.from.nodeId))) return 'URL 图片仅支持兼容参考图，当前模型不支持。';
    }
    if (inputReferenceCount && !references.length) {
        const unsupported = roleError(contract, 'referenceImages');
        if (unsupported) return unsupported;
    }
    let retainedReferenceCount = 0;
    for (const edge of references) {
        const source = state.nodes.get(edge.from.nodeId), output = imageOutput(source);
        if (!source || output.missingPositions.length) return '已连接参考来源的原图存在缺失，请恢复原图后重试。';
        retainedReferenceCount += output.count;
    }
    const count = Math.max(inputReferenceCount, retainedReferenceCount);
    if (count > contract.maxReferences) return `当前模型最多接收 ${contract.maxReferences} 张参考图，完整有效来源批次共有 ${count} 张。`;
    if (inputs && references.length && inputReferenceCount < retainedReferenceCount) return '已连接参考来源的原图存在缺失，读取批次不完整；请恢复原图后重试。';
    for (const edge of masks) {
        if (edge.maskConsumption !== 'single') continue;
        const source = state.nodes.get(edge.from.nodeId), output = imageOutput(source);
        const actualCount = inputs ? normalizeImageList(inputs.mask).length : output.count;
        const sourceCount = Math.max(output.count, actualCount);
        if (output.missingPositions.length) return '遮罩来源原图存在缺失，请恢复原图后重试。';
        if (sourceCount !== 1 || actualCount !== 1) return `该遮罩连接要求单图来源，当前完整批次有 ${sourceCount} 张；请恢复单图或明确更改用途。`;
    }
    return '';
}
