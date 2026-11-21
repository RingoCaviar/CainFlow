import { escapeHtml, splitTextForTextSplitNode } from '../../core/common-utils.js';
import { isMultiConnectionInput, orderInputConnections, MAX_REFERENCE_IMAGE_COUNT } from '../../nodes/reference-image-ports.js';
import { projectImageOutput } from '../../nodes/image-output-projection.js';
import { createImageGenerationRevisionApi } from '../../nodes/image-generation-revision.js';
import { resolvePromptImageMentions } from '../../nodes/prompt-image-mentions.js';
import { validateUniversalImageInputs } from '../../nodes/universal-input-policy.js';
import { generateCameraPrompt } from '../camera/camera-prompt-utils.js';
import {
    appendReferenceImages, coerceCustomParamValue, getImageImportMediaAssetReferences, getPrimaryTextInput,
    getTextInputList, normalizeImageList
} from '../execution/execution-data-utils.js';
import { resolveWorkflowExecutionPlan } from '../execution/workflow-execution-plan.js';
import { buildInputBatches, shouldRunNodeForEachInput } from '../execution/workflow-runner.js';
import { createReferenceImageCatalog } from '../media/reference-image-catalog.js';
import { migrateLegacyWorkflowData } from '../persistence/legacy-node-migration.js';
import { normalizeVisualStyle } from '../visual-style/visual-style.js';
import { generateSavedImages, generateSavedVideos, runSavedConversation, savedExecutionError } from './saved-canvas-provider-execution.js';

export const SAVED_EXECUTABLE_TYPES = Object.freeze([
    'Text', 'TextMerge', 'TextSplit', 'CustomParams', 'TextChat', 'ImageImport', 'ImagePreview', 'ImageMerge',
    'ImageCompare', 'VisualStyle', 'CameraControl', 'ImageGenerate', 'VideoGenerate'
]);

const imageData = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i;

function entriesForNumberedPorts(inputs, prefix) {
    return Object.entries(inputs).filter(([port]) => port.startsWith(prefix) && /^\d+$/.test(port.slice(prefix.length)))
        .sort(([a], [b]) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
}

function customParams(node, inputs) {
    const result = Object.create(null);
    const { params, customParams: legacyParams } = node.data;
    const rows = Array.isArray(params) ? params : Array.isArray(legacyParams) ? legacyParams : [];
    for (const row of rows) {
        const key = String(row?.key || '').trim();
        if (!key) continue;
        const port = `param_${key}`;
        if (Object.hasOwn(inputs, port)) {
            const value = inputs[port];
            result[key] = typeof value === 'string' ? coerceCustomParamValue(value) : value;
        } else {
            result[key] = coerceCustomParamValue(row.value);
        }
    }
    return result;
}

function writeNode(node, fields) {
    Object.assign(node.saved, fields);
    Object.assign(node.data, fields);
    if (node.saved.data && typeof node.saved.data === 'object') Object.assign(node.saved.data, fields);
}

function fixedChat(node) {
    return node?.type === 'TextChat' && node.data.fixed === true && node.data.isSucceeded === true
        && typeof node.data.lastText === 'string' && node.data.lastText.trim().length > 0;
}

function textSplit(node, text) {
    const { delimiter = '', removeEmptyLines, mergeOutputEnabled, outputCount } = node.data;
    const count = mergeOutputEnabled ? 0 : Math.max(0, parseInt(outputCount, 10) || 0);
    const parts = splitTextForTextSplitNode(text, delimiter, { removeEmptyLines: removeEmptyLines === true });
    return count ? parts.slice(0, count) : parts;
}

function collectRunOptions(nodes, nodeIds, targetNodeId, imageBatch) {
    if (nodeIds !== undefined && targetNodeId !== undefined) throw savedExecutionError('input');
    if (nodeIds !== undefined) {
        if (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.some(id => !nodes.has(id))) throw savedExecutionError('input');
        return { mode: 'selected-only', selectedNodeIds: [...new Set(nodeIds)], imageBatch };
    }
    if (targetNodeId !== undefined) {
        if (!nodes.has(targetNodeId)) throw savedExecutionError('input');
        return { mode: 'target-node', targetNodeId };
    }
    return { mode: 'all' };
}

export function planSavedWorkflowExecution({ document, nodeIds, targetNodeId, imageBatch = false }) {
    const saved = migrateLegacyWorkflowData(structuredClone(document));
    if (!Array.isArray(saved?.nodes) || !Array.isArray(saved.connections)) throw savedExecutionError('input');
    const nodes = new Map(saved.nodes.map(node => {
        const fields = { ...node.data, ...node };
        return [node.id, { ...fields, data: fields, saved: node }];
    }));
    const options = collectRunOptions(nodes, nodeIds, targetNodeId, imageBatch);
    const plan = resolveWorkflowExecutionPlan({ nodes, connections: saved.connections }, options,
        { isFixedTextChatWithCachedResult: fixedChat });
    const enabledNodeIds = plan?.executionOrder.filter(id => nodes.get(id).enabled !== false) ?? [];
    return { document: saved, nodes, plan, enabledNodeIds };
}

export async function executeSavedWorkflow({ document, models = [], providers = [], nodeIds, targetNodeId,
    signal, getNodeSignal, isNodeStopped = () => false, imageBatch = false, loadMedia, getHistoryEntry, saveMedia, requestProvider }) {
    const { document: saved, nodes, plan, enabledNodeIds } = planSavedWorkflowExecution({ document, nodeIds, targetNodeId, imageBatch });
    if (!plan) return { outcome: 'no-execution', nodeResults: [], document: saved };
    const state = { nodes, connections: saved.connections, models, providers, activeWorkflowId: saved.workflowId };

    const outcomes = new Map();
    const outputs = new Map();
    const cachedOutputs = new Map();
    const media = new Map();
    const generationRevision = createImageGenerationRevisionApi({ state,
        getCachedOutputValue: (node, port) => outputs.get(node.id)?.[port] ?? cachedOutputs.get(node.id)?.[port] });
    const referenceCatalog = createReferenceImageCatalog({ state, getImageAsset: readAsset, getHistoryEntry });

    async function resolveMentions(node, inputs, prompts, { signal, videoPorts } = {}) {
        try {
            return await resolvePromptImageMentions({ node, inputs, prompts, signal, videoPorts, workflowId: saved.workflowId,
                getUpstream: () => referenceCatalog.getUpstream(node.id), readImage: referenceCatalog.readImage });
        } catch (error) {
            if (signal?.aborted) throw error;
            throw savedExecutionError('input');
        }
    }

    async function readAsset(assetKey) {
        if (!assetKey.startsWith('media:') || typeof loadMedia !== 'function') return null;
        if (!media.has(assetKey)) media.set(assetKey, Promise.resolve().then(() => loadMedia(assetKey)));
        const dataUrl = await media.get(assetKey);
        return imageData.test(dataUrl || '') ? dataUrl : null;
    }

    async function savedImages(node) {
        if (node.type === 'ImageImport' && node.data.importMode === 'url') {
            return /^https?:\/\//i.test(node.data.imageUrl || '') ? [node.data.imageUrl] : [];
        }
        const keys = node.type === 'ImageImport' ? getImageImportMediaAssetReferences(node) :
            (node.data.mediaAssetKeys?.length ? node.data.mediaAssetKeys : [node.data.imageAssetKey]).filter(key => typeof key === 'string' && key);
        const missing = node.data.mediaIntegrity?.missingItems?.length;
        if (missing) throw savedExecutionError('input');
        if (!keys.length) return normalizeImageList(node.data.imageDataList || node.data.imageData || node.data.image).filter(value => imageData.test(value));
        if (node.type === 'ImageImport') {
            for (const key of keys) {
                const value = await readAsset(key);
                if (value) return [value];
            }
            throw savedExecutionError('input');
        }
        const values = await Promise.all(keys.map(readAsset));
        if (values.some(value => !value)) throw savedExecutionError('input');
        return projectImageOutput(node, values).images;
    }

    async function outputFor(node, port, resolvingParams) {
        const output = outputs.get(node.id);
        if (output) return output[port];
        if (port === 'image') return savedImages(node);
        if (port === 'video' && node.type === 'VideoGenerate') return node.data.videos || node.data.video;
        if (port === 'style' && node.type === 'VisualStyle') return normalizeVisualStyle(node.data.visualStyle);
        if (port === 'params' && node.type === 'CustomParams') {
            if (resolvingParams.has(node.id)) throw savedExecutionError('input');
            const connections = state.connections.filter(edge => edge.to.nodeId === node.id);
            const inputs = await collectInputs(node, connections, new Set([...resolvingParams, node.id]));
            return customParams(node, inputs);
        }
        if (node.type === 'TextSplit') {
            const parts = textSplit(node, node.data.text || '');
            if (port === 'text' && node.data.mergeOutputEnabled) return parts;
            if (/^part_\d+$/.test(port)) return parts[Number(port.slice(5)) - 1];
        }
        if (port === 'text' && node.type === 'TextChat') return node.data.lastText || undefined;
        if (port === 'text') return node.data.texts?.length ? node.data.texts : node.data.text || node.data.cameraPrompt;
        return undefined;
    }

    async function collectInputs(node, connections = plan.inputConnectionsByNode[node.id], resolvingParams = new Set()) {
        const inputs = Object.create(null);
        for (const edge of orderInputConnections(node.type, connections)) {
            const source = nodes.get(edge.from.nodeId);
            if (!source || source.enabled === false) continue;
            const value = await outputFor(source, edge.from.port, resolvingParams);
            if (!cachedOutputs.has(source.id)) cachedOutputs.set(source.id, Object.create(null));
            cachedOutputs.get(source.id)[edge.from.port] = value;
            const { port } = edge.to;
            if (isMultiConnectionInput(node.type, port)) {
                if (!normalizeImageList(value).length) throw savedExecutionError('input');
                inputs[port] = appendReferenceImages(inputs[port], value, MAX_REFERENCE_IMAGE_COUNT);
            } else if (value !== undefined) inputs[port] = value;
        }
        return inputs;
    }

    async function storeImages(node, images, nodeSignal) {
        const mediaAssetKeys = [];
        for (const value of images) {
            nodeSignal?.throwIfAborted();
            if (!imageData.test(value) || typeof saveMedia !== 'function') throw savedExecutionError('input');
            const assetKey = await saveMedia(value, node.id);
            if (typeof assetKey !== 'string' || !assetKey.startsWith('media:')) throw savedExecutionError('media_save_failed');
            mediaAssetKeys.push(assetKey);
            media.set(assetKey, Promise.resolve(value));
        }
        return mediaAssetKeys;
    }

    async function saveVideo(node, { dataUrl, ...video }, nodeSignal) {
        nodeSignal?.throwIfAborted();
        if (typeof saveMedia !== 'function') throw savedExecutionError('media_save_failed');
        const assetKey = await saveMedia(dataUrl, node.id);
        if (typeof assetKey !== 'string' || !assetKey.startsWith('media:')) throw savedExecutionError('media_save_failed');
        return { ...video, assetKey, url: '' };
    }

    async function outputImages(node, images, nodeSignal) {
        const keys = images.length ? await storeImages(node, images, nodeSignal) : [];
        nodeSignal?.throwIfAborted();
        writeNode(node, { mediaAssetKeys: keys, imageAssetKey: keys[0] || '', imageCount: keys.length, imageAssetReady: keys.length > 0,
            imageMemoryReleased: keys.length > 0, imagePreviewIndex: Math.min(node.data.imagePreviewIndex || 0, Math.max(0, keys.length - 1)) });
        delete node.saved.mediaIntegrity;
        delete node.data.mediaIntegrity;
        if (node.saved.data) delete node.saved.data.mediaIntegrity;
        return { image: images };
    }

    async function executeNode(node, inputs, nodeSignal) {
        const providerContext = { state, signal: nodeSignal, requestProvider, resolveMentions };
        switch (node.type) {
            case 'Text': {
                const texts = getTextInputList(inputs.text);
                const text = Object.hasOwn(inputs, 'text') ? texts[0] || '' : node.data.text || '';
                writeNode(node, { text, texts, textPreviewIndex: 0 });
                return { text: texts.length ? texts : text };
            }
            case 'TextMerge': {
                const texts = entriesForNumberedPorts(inputs, 'text_').flatMap(([, value]) => getTextInputList(value));
                if (!texts.length) throw savedExecutionError('input');
                writeNode(node, { texts, text: texts.at(-1), textPreviewIndex: 0 });
                return { text: texts };
            }
            case 'TextSplit': {
                const text = Object.hasOwn(inputs, 'text') ? getPrimaryTextInput(inputs.text) : node.data.text || '';
                const parts = textSplit(node, text);
                const merge = node.data.mergeOutputEnabled === true;
                writeNode(node, { text, parts, texts: merge ? parts : [] });
                return merge ? { text: parts } : Object.fromEntries(parts.map((part, index) => [`part_${index + 1}`, part]));
            }
            case 'CustomParams':
                return { params: customParams(node, inputs) };
            case 'TextChat': {
                if (fixedChat(node) && plan.targetNodeId !== node.id) return { text: node.data.lastText };
                const batches = shouldRunNodeForEachInput(node, inputs) ? buildInputBatches(node, inputs) : [inputs];
                const texts = [];
                for (const batch of batches) texts.push(await runSavedConversation(node, batch, providerContext));
                nodeSignal?.throwIfAborted();
                const lastText = texts.at(-1);
                writeNode(node, { lastText, lastResponse: escapeHtml(lastText).replace(/\n/g, '<br>'), isSucceeded: true });
                return { text: texts };
            }
            case 'ImageImport': {
                const images = await savedImages(node);
                if (!images.length) throw savedExecutionError('input');
                return { image: images };
            }
            case 'ImagePreview':
                return normalizeImageList(inputs.image).length ? outputImages(node, normalizeImageList(inputs.image), nodeSignal) : { image: [] };
            case 'ImageMerge': {
                if (validateUniversalImageInputs({ state, node, inputs })) throw savedExecutionError('input');
                const images = entriesForNumberedPorts(inputs, 'image_').flatMap(([, value]) => normalizeImageList(value));
                if (!images.length) throw savedExecutionError('input');
                return outputImages(node, images, nodeSignal);
            }
            case 'ImageCompare': {
                const a = normalizeImageList(inputs.imageA)[0];
                const b = normalizeImageList(inputs.imageB)[0];
                if (!b) throw savedExecutionError('input');
                const output = await outputImages(node, [b], nodeSignal);
                writeNode(node, { compareImageA: /^https?:\/\//i.test(a || '') ? a : '', compareImageB: '' });
                return output;
            }
            case 'VisualStyle':
                return { style: normalizeVisualStyle(node.data.visualStyle) };
            case 'CameraControl': {
                const { pitch = 12, yaw = 28, distance = 6.5, fov = 50, roll = 0 } = node.data;
                const text = generateCameraPrompt({ pitch, yaw, distance, fov, roll });
                writeNode(node, { text, cameraPrompt: text });
                return { text, image: normalizeImageList(inputs.image).slice(0, 1) };
            }
            case 'ImageGenerate': {
                const recipe = generationRevision.beginAttempt(node, inputs);
                const batches = shouldRunNodeForEachInput(node, inputs) ? buildInputBatches(node, inputs) : [inputs];
                const images = [];
                for (const batch of batches) {
                    await generateSavedImages(node, batch, { ...providerContext, publishImage: image => images.push(image) });
                }
                const output = await outputImages(node, images, nodeSignal);
                generationRevision.completeAttempt(recipe, { succeeded: true });
                writeNode(node, { generationRevision: node.data.generationRevision, isSucceeded: true });
                return output;
            }
            case 'VideoGenerate': {
                const batches = shouldRunNodeForEachInput(node, inputs) ? buildInputBatches(node, inputs) : [inputs];
                const videos = [];
                for (const batch of batches) {
                    await generateSavedVideos(node, batch, { ...providerContext,
                        publishVideo: async video => videos.push(await saveVideo(node, video, nodeSignal)) });
                }
                nodeSignal?.throwIfAborted();
                const last = videos.at(-1);
                writeNode(node, { videos, videoId: last.id, videoAssetKey: last.assetKey, videoStatus: last.status,
                    videoStatusText: '视频生成完成', videoUrl: '', mediaAssetKeys: videos.map(item => item.assetKey), isSucceeded: true });
                return { video: videos };
            }
            default:
                throw savedExecutionError('unsupported_node');
        }
    }

    async function runNode(id) {
        const node = nodes.get(id);
        const branchSignal = getNodeSignal?.(id);
        const nodeSignal = signal && branchSignal ? AbortSignal.any([signal, branchSignal]) : branchSignal || signal;
        try {
            nodeSignal?.throwIfAborted();
            if (isNodeStopped(id) || plan.incomingConnectionsByNode[id].some(edge => outcomes.get(edge.from.nodeId)?.failureCategory === 'cancelled')) {
                throw savedExecutionError('cancelled');
            }
            const failedInput = plan.incomingConnectionsByNode[id].some(edge => outcomes.get(edge.from.nodeId)?.succeeded === false);
            if (failedInput) throw savedExecutionError('input');
            const output = await executeNode(node, await collectInputs(node), nodeSignal);
            nodeSignal?.throwIfAborted();
            outputs.set(id, output);
            const texts = getTextInputList(output.text ?? entriesForNumberedPorts(output, 'part_').map(([, value]) => value));
            const images = normalizeImageList(output.image);
            const mediaAssetKeys = node.type === 'ImageImport' ? getImageImportMediaAssetReferences(node) : node.data.mediaAssetKeys || [];
            outcomes.set(id, { nodeId: id, succeeded: true, texts, images, mediaAssetKeys });
        } catch (error) {
            const failureCategory = nodeSignal?.aborted || isNodeStopped(id) ? 'cancelled' : error?.failureCategory || 'execution_failed';
            outcomes.set(id, { nodeId: id, succeeded: false, failureCategory });
        }
    }

    if (imageBatch) {
        const pending = new Set(enabledNodeIds);
        while (pending.size && !signal?.aborted) {
            const ready = [...pending].filter(id => plan.incomingConnectionsByNode[id].every(edge => !pending.has(edge.from.nodeId)));
            for (let first = 0; first < ready.length && !signal?.aborted; first += 4) {
                const batch = ready.slice(first, first + 4);
                await Promise.all(batch.map(runNode));
                batch.forEach(id => pending.delete(id));
            }
        }
    } else {
        for (const id of enabledNodeIds) {
            if (signal?.aborted) break;
            await runNode(id);
            const result = outcomes.get(id);
            if (result?.succeeded === false && result.failureCategory !== 'cancelled') break;
        }
    }

    const nodeResults = enabledNodeIds.map(id => outcomes.get(id)).filter(Boolean);
    const failed = nodeResults.some(item => !item.succeeded && item.failureCategory !== 'cancelled');
    const outcome = signal?.aborted ? 'stopped' : failed ? 'failed' : nodeResults.some(item => item.failureCategory === 'cancelled')
        ? 'cancelled' : nodeResults.length ? 'completed' : 'no-execution';
    return { outcome, nodeResults, document: saved };
}
