import { normalizeImageList } from '../features/execution/execution-data-utils.js';
import { getImageInputKeys } from '../features/execution/provider-request-utils.js';
import { createCanvasImageSourceId } from '../features/media/reference-image-identity.js';
import { MAX_REFERENCE_IMAGE_COUNT } from './reference-image-ports.js';

const tokenPattern = /@图片([1-9]\d*)/g;
const identityFields = ['id', 'sourceId', 'name', 'kind', 'workflowId', 'sourceNodeId', 'sourcePort', 'assetKey', 'historyId', 'historyVersion', 'imageUrl', 'imageFingerprint', 'targetPort', 'connectionId'];
const frameLabels = { image_1: '首帧', image_2: '尾帧' };

export function normalizePromptImageMentions(records) {
    if (!Array.isArray(records)) return [];
    const seen = new Set();
    return records.flatMap(record => {
        if (!/^@图片[1-9]\d*$/.test(record?.token || '') || seen.has(record.token) || !record.source?.id) return [];
        const source = Object.fromEntries(identityFields.flatMap(key => (
            typeof record.source[key] === 'string' && record.source[key] ? [[key, record.source[key]]] : []
        )));
        if (Number.isSafeInteger(record.source.legacyAssetIndex)) source.legacyAssetIndex = record.source.legacyAssetIndex;
        source.sourceImageIndex = Number.isSafeInteger(record.source.sourceImageIndex) ? record.source.sourceImageIndex : 0;
        seen.add(record.token);
        return [{ token: record.token, source }];
    });
}

export function registerPromptImageMention(node, candidate, prompt, range, maxLength = -1) {
    const records = normalizePromptImageMentions(node.data?.imagePromptMentions);
    const sameSource = records.find(({ source }) => source.workflowId === (candidate.workflowId || undefined)
        && (source.id === candidate.id || source.connectionId && source.connectionId === candidate.connectionId
            && source.sourceNodeId === candidate.sourceNodeId && source.sourcePort === candidate.sourcePort
            && source.targetPort === candidate.targetPort && source.sourceImageIndex === candidate.sourceImageIndex));
    const usedTokens = new Set([...records.map(record => record.token), ...[...prompt.matchAll(tokenPattern)].map(match => match[0])]);
    let number = 1;
    while (!sameSource && usedTokens.has(`@图片${number}`)) number++;
    const token = sameSource?.token || `@图片${number}`;
    const separatorLength = range.replacing ? 0 : 1;
    if (maxLength >= 0 && prompt.length - (range.end - range.start) + token.length + separatorLength > maxLength) return '';
    if (!sameSource) {
        node.data ||= {};
        node.data.imagePromptMentions = normalizePromptImageMentions([...records, { token, source: candidate }]);
    }
    return token;
}

export function findPromptImageMentions(node, prompts) {
    const records = normalizePromptImageMentions(node?.data?.imagePromptMentions);
    if (!records.length) return [];
    const tokens = new Set(prompts.flatMap(prompt => [...String(prompt || '').matchAll(tokenPattern)].map(match => match[0])));
    const recordsByToken = new Map(records.map(record => [record.token, record]));
    return [...tokens].map(token => recordsByToken.get(token)).filter(Boolean);
}

/** Remap the identities of references whose source or exact edge was copied. */
export function remapCopiedPromptImageMentions(records, { nodeIds, connectionIds, fromWorkflowId, toWorkflowId }) {
    return normalizePromptImageMentions(records).map(record => {
        const { source } = record;
        if (!source.sourceNodeId || source.workflowId && source.workflowId !== fromWorkflowId) return record;
        const mappedSourceNodeId = nodeIds.get(source.sourceNodeId);
        const mappedConnectionId = source.connectionId ? connectionIds.get(source.connectionId) : '';
        if (source.connectionId ? !mappedConnectionId : !mappedSourceNodeId) return record;
        const sourceNodeId = mappedSourceNodeId || source.sourceNodeId;
        const sourceId = createCanvasImageSourceId(sourceNodeId, source.sourcePort, source.sourceImageIndex,
            source.assetKey || source.imageUrl || source.imageFingerprint, source.legacyAssetIndex);
        const id = mappedConnectionId ? JSON.stringify(['input', mappedConnectionId, sourceId]) : sourceId;
        return { token: record.token, source: { ...source, id, sourceId, sourceNodeId,
            ...(mappedConnectionId ? { connectionId: mappedConnectionId } : {}), workflowId: toWorkflowId } };
    });
}

export function findPromptImageMentionUpstream(source, upstream) {
    const sameConnectionSlot = candidate => candidate.connectionId === source.connectionId && candidate.sourceNodeId === source.sourceNodeId
        && candidate.sourcePort === source.sourcePort && candidate.targetPort === source.targetPort
        && candidate.sourceImageIndex === source.sourceImageIndex;
    const sameSource = candidate => (candidate.sourceId || candidate.id) === (source.sourceId || source.id)
        && (!source.targetPort || source.targetPort === candidate.targetPort);
    return source.connectionId ? upstream.find(sameConnectionSlot) : upstream.find(sameSource);
}

function getUpstreamLabel(node, inputs, source, upstream) {
    const slot = findPromptImageMentionUpstream(source, upstream);
    if (!slot) return '';
    const keys = getImageInputKeys(inputs);
    const port = slot.targetPort;
    if (!keys.includes(port)) return '';
    const slotValues = normalizeImageList(inputs[port]);
    const samePort = upstream.filter(candidate => candidate.targetPort === port);
    if (slotValues.length !== samePort.length) return '';
    const index = samePort.indexOf(slot);
    if (node.type === 'VideoGenerate') return frameLabels[port] || `参考图 ${index + 1}`;
    const previous = keys.slice(0, keys.indexOf(port)).reduce((count, key) => count + normalizeImageList(inputs[key]).length, 0);
    return `参考图 ${previous + index + 1}`;
}

function includeVideoImage(inputs, image, ports) {
    const referencePort = ports.find(port => port.id === 'referenceImages');
    if (referencePort) {
        const references = normalizeImageList(inputs.referenceImages);
        const maxCount = referencePort.maxCount ?? Infinity;
        if (references.length >= maxCount) throw new Error(`当前模型最多接收 ${maxCount} 张参考图，请减少提示词引用或上游输入。`);
        inputs.referenceImages = [...references, image];
        return `参考图 ${references.length + 1}`;
    }
    const frame = ports.find(port => frameLabels[port.id] && !normalizeImageList(inputs[port.id]).length);
    if (!frame) throw new Error('当前视频模型没有可用的参考图或帧输入。');
    inputs[frame.id] = image;
    return frameLabels[frame.id];
}

function includeReferenceImage(inputs, image, maxCount) {
    const images = getImageInputKeys(inputs).flatMap(key => normalizeImageList(inputs[key]));
    if (images.length >= maxCount) throw new Error(`当前节点最多接收 ${maxCount} 张参考图，请减少提示词引用或上游输入。`);
    inputs.referenceImages = [...normalizeImageList(inputs.referenceImages), image];
    return `参考图 ${images.length + 1}`;
}

/** Resolve only the selected identities present in the effective request text. */
export function resolvePromptImageMentions({ node, inputs, prompts, readImage, getUpstream = () => [], workflowId, videoPorts = [], signal }) {
    const mentions = findPromptImageMentions(node, prompts);
    if (!mentions.length) return { inputs, prompts };
    return (async () => {
        const resolvedInputs = { ...inputs }, labels = new Map(), attached = new Map();
        const upstream = getUpstream();
        for (const { token, source } of mentions) {
            signal?.throwIfAborted();
            const unavailable = () => new Error(`无法读取 ${token}（${source.name || '参考图'}），请重新选择图片。`);
            if (source.workflowId && source.workflowId !== workflowId) throw unavailable();
            const identity = source.sourceId || source.id;
            let label = getUpstreamLabel(node, inputs, source, upstream) || attached.get(identity);
            if (!label) {
                if (source.connectionId) throw unavailable();
                const image = await readImage?.(source);
                signal?.throwIfAborted();
                if (!image) throw unavailable();
                label = node.type === 'VideoGenerate'
                    ? includeVideoImage(resolvedInputs, image, videoPorts)
                    : includeReferenceImage(resolvedInputs, image, node.type === 'TextChat' ? MAX_REFERENCE_IMAGE_COUNT : Infinity);
                attached.set(identity, label);
            }
            labels.set(token, label);
        }
        return { inputs: resolvedInputs, prompts: prompts.map(prompt => String(prompt || '').replace(tokenPattern, token => labels.get(token) || token)) };
    })();
}
