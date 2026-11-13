import { getDerivedImagePreview } from '../../nodes/derived-image-preview.js';
import { projectImageOutput } from '../../nodes/image-output-projection.js';
import { projectImageReferences } from '../../nodes/image-reference-projection.js';
import { getNodeDefinitionPorts, getNodeDefinition } from '../../nodes/registry.js';
import { getCanonicalImageList } from '../execution/execution-data-utils.js';
import { getImageDescription } from '../execution/reference-image-description.js';
import { createCanvasImageSourceId } from './reference-image-identity.js';

const isRemote = value => typeof value === 'string' && /^https?:\/\//i.test(value);
const isImage = value => typeof value === 'string' && (/^data:image\//i.test(value) || isRemote(value));
const getNodeImages = node => {
    const images = getCanonicalImageList(node);
    return images.length ? images : getDerivedImagePreview(node);
};

function getRemoteFileName(value) {
    if (!value) return '';
    try { return decodeURIComponent(new URL(value).pathname.split('/').pop()); }
    catch { return ''; }
}

// Only images without a durable key or URL need a compact content identity.
function getImageFingerprint(value) {
    let hash = 0x811c9dc5;
    let check = 5381;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        hash = Math.imul(hash ^ code, 0x01000193);
        check = Math.imul(check, 33) ^ code;
    }
    return `${value.length}:${(hash >>> 0).toString(36)}:${(check >>> 0).toString(36)}`;
}

function projectCanvasImage(node, sourcePort = 'image') {
    if (node.type === 'CameraControl' && sourcePort === 'cameraPreviewImage') {
        return projectImageOutput(node, node.data?.cameraPreviewImage);
    }
    return projectImageOutput(node, getNodeImages(node));
}

function getAssetPosition(node, output, index) {
    if (output.remote) return {};
    const batchKey = node.data?.imageAssetKey;
    if (node.type === 'ImageImport' || node.data?.mediaAssetKeys?.length || !batchKey) {
        return output.assets[index] ? { assetKey: output.assets[index] } : {};
    }
    if (batchKey.startsWith('media:')) return index === 0 ? { assetKey: batchKey } : {};
    return { assetKey: batchKey, legacyAssetIndex: index };
}

function describeOutputSlot(node, output, index, sourcePort) {
    const integrity = node.data?.mediaIntegrity;
    if (!output.remote && (output.missingPositions.includes(index) || integrity?.state === 'missing' && !output.missingPositions.length)) return null;
    const image = output.images[index];
    const asset = getAssetPosition(node, output, index);
    const imageUrl = !asset.assetKey && isRemote(image) ? image : undefined;
    const imageFingerprint = !asset.assetKey && !imageUrl && isImage(image) ? getImageFingerprint(image) : undefined;
    if (!asset.assetKey && !imageUrl && !imageFingerprint) return null;

    const identity = asset.assetKey || imageUrl || imageFingerprint;
    const id = createCanvasImageSourceId(node.id, sourcePort, index, identity, asset.legacyAssetIndex);
    const fileName = node.type === 'ImageImport' ? (output.remote ? getRemoteFileName(imageUrl) : node.imageImportFileName) : '';
    const nodeTitle = node.customTitle || fileName || node.el?.dataset.nodeTitle || getNodeDefinition(node.type)?.title || node.id;
    const title = sourcePort === 'cameraPreviewImage' ? `${nodeTitle} · 视角预览` : nodeTitle;
    const description = getImageDescription(node, index);
    const prompt = node.data?.imagePromptList?.[index] || node.data?.prompt || '';
    return {
        id, sourceId: id, kind: node.type === 'ImageImport' ? 'import' : 'canvas',
        name: output.count > 1 ? `${title} · ${index + 1}` : title,
        sourceNodeId: node.id, sourceImageIndex: index, sourcePort, ...asset, imageUrl, imageFingerprint, description,
        searchText: [fileName, description, prompt].filter(Boolean).join(' '),
        // The persisted node thumbnail can represent the last viewed member of a batch.
        previewUrl: imageUrl || (output.count === 1 && isImage(node.data?.imagePreviewThumbnail) ? node.data.imagePreviewThumbnail : '')
    };
}

function describeHistory(item) {
    const historyId = String(item.id);
    const historyVersion = item.fileVersion || '';
    const fileName = String(item.relativePath || '').split(/[/\\]/).pop();
    const fileUrl = item.fileUrl === `/api/storage/library/${historyId}/file` ? item.fileUrl : '';
    const previewUrl = typeof item.thumbUrl === 'string' && item.thumbUrl.startsWith(`/api/storage/library/${historyId}/thumbnail?v=`)
        ? item.thumbUrl : isImage(item.thumb) ? item.thumb : fileUrl && historyVersion ? `${fileUrl}?v=${encodeURIComponent(historyVersion)}` : fileUrl;
    const id = JSON.stringify(['history', historyId, historyVersion]);
    return {
        id, sourceId: id, kind: 'history', historyId, historyVersion, previewUrl, thumbAssetKey: item.thumbAssetKey,
        name: item.name || item.title || fileName || `历史图片 ${historyId}`,
        searchText: [item.relativePath, item.prompt, item.model].filter(Boolean).join(' ')
    };
}

export function createReferenceImageCatalog({
    state,
    getHistoryMetadata = async () => [],
    getHistoryEntry = async () => null,
    getImageAsset = async () => '',
    getImageAssetList = async () => [],
    createThumbnail = async value => value
}) {
    function getUpstream(nodeId, { state: imageState = state, connections = imageState.connections } = {}) {
        if (!nodeId) return [];
        const { slots } = projectImageReferences({ state: imageState, targetId: nodeId, connections, getOutput: getNodeImages });
        const outputs = new Map();
        return slots.flatMap(({ source, connection, index, number }) => {
            if (!outputs.has(source.id)) outputs.set(source.id, projectCanvasImage(source));
            const candidate = describeOutputSlot(source, outputs.get(source.id), index, connection.from.port);
            if (!candidate) return [];
            return [{ ...candidate, id: JSON.stringify(['input', connection.id || connection.to.port, candidate.id]),
                connectionId: connection.id, targetPort: connection.to.port, referenceNumber: number }];
        });
    }

    function getCanvas() {
        const candidates = [];
        for (const node of state.nodes.values()) {
            const port = node.type === 'CameraControl' ? 'cameraPreviewImage'
                : getNodeDefinitionPorts(node.type, 'output').find(({ type }) => type === 'image')?.name;
            if (!port || !isAvailableNode(state, node)) continue;
            const output = projectCanvasImage(node, port);
            for (let index = 0; index < output.count; index++) {
                const candidate = describeOutputSlot(node, output, index, port);
                if (candidate) candidates.push(candidate);
            }
        }
        return candidates;
    }

    async function getScene() {
        let history;
        try {
            history = await getHistoryMetadata({ thumbnailUrls: true, throwOnError: true });
        } catch {
            return Object.assign(getCanvas(), { warning: '目录历史读取失败，仍可选择画布图片。' });
        }
        return [...getCanvas(), ...history.filter(item => item.id != null && item.mediaType !== 'video' && !item.hasVideo).map(describeHistory)];
    }

    function isAvailableNode(imageState, node) {
        return node && node.enabled !== false && !imageState.runningNodeIds?.has(node.id) && !['running', 'waiting'].includes(node.runStatus);
    }

    async function readImage(candidate, { state: imageState = state } = {}) {
        if (!candidate) return '';
        if (candidate.historyId) {
            const entry = await getHistoryEntry(candidate.historyId, { fileVersion: candidate.historyVersion });
            if (candidate.historyVersion && entry?.fileVersion !== candidate.historyVersion) return '';
            return isImage(entry?.image) ? entry.image : '';
        }

        const { assetKey, legacyAssetIndex, imageUrl, imageFingerprint, sourceNodeId, sourceId, sourcePort = 'image', sourceImageIndex = 0 } = candidate;
        const checkSource = sourceNodeId && (sourceId || !assetKey && !imageUrl);
        function getCurrentOutput() {
            const node = imageState.nodes.get(sourceNodeId);
            if (!isAvailableNode(imageState, node)) return null;
            const output = projectCanvasImage(node, sourcePort);
            const current = describeOutputSlot(node, output, sourceImageIndex, sourcePort);
            if (!current || sourceId && sourceId !== current.sourceId || imageFingerprint && imageFingerprint !== current.imageFingerprint) return null;
            return { node, image: output.images[sourceImageIndex] };
        }
        const current = checkSource ? getCurrentOutput() : null;
        if (checkSource && !current) return '';
        if (assetKey) {
            const value = legacyAssetIndex === undefined ? await getImageAsset(assetKey) : (await getImageAssetList(assetKey))[legacyAssetIndex];
            if (checkSource && getCurrentOutput()?.node !== current.node) return '';
            return isImage(value) ? value : '';
        }
        const value = imageUrl || current?.image;
        return isImage(value) ? value : '';
    }

    async function readThumbnail(candidate) {
        if (candidate.previewUrl) return candidate.previewUrl;
        if (candidate.thumbAssetKey) {
            const thumbnail = await getImageAsset(candidate.thumbAssetKey);
            if (isImage(thumbnail)) return thumbnail;
        }
        const original = await readImage(candidate);
        return !original || isRemote(original) ? original : await createThumbnail(original) || original;
    }

    return { getUpstream, getCanvas, getScene, readImage, readThumbnail };
}
