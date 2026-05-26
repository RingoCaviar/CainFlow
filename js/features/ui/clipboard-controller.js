/**
 * 负责节点复制、剪切板缓存与粘贴还原逻辑，支持多节点批量复制。
 */
import {
    appendMappedConnectionSnapshots,
    collectConnectionSnapshotsForNodes
} from '../../canvas/connection-copy-utils.js';

export function createClipboardControllerApi({
    state,
    documentRef = document,
    showToast,
    addNode,
    updateAllConnections,
    updatePortStyles,
    scheduleSave,
    onConnectionsChanged = () => {}
}) {
    function getNodeTextareaHeights(id) {
        const heights = {};
        documentRef.querySelectorAll(`#${id} textarea[id^="${id}-"]`).forEach((textarea) => {
            const key = textarea.id.slice(`${id}-`.length);
            const height = textarea.offsetHeight || parseFloat(textarea.style.height || '0');
            if (key && Number.isFinite(height) && height > 0) {
                heights[key] = Math.round(height);
            }
        });
        return Object.keys(heights).length > 0 ? heights : null;
    }

    function serializeOneNode(nodeId) {
        const node = state.nodes.get(nodeId);
        if (!node) return null;
        const id = nodeId;
        const serialized = {
            id,
            type: node.type,
            x: node.x,
            y: node.y,
            width: node.width || null,
            height: node.height || null,
            userResized: node.userResized === true,
            collapsed: node.collapsed === true
        };
        if (typeof node.customTitle === 'string' && node.customTitle.trim()) {
            serialized.customTitle = node.customTitle.trim();
        }
        const textareaHeights = getNodeTextareaHeights(id);
        if (textareaHeights) serialized.textareaHeights = textareaHeights;
        if (node.type === 'ImageImport' || node.type === 'ImagePreview' || node.type === 'ImageSave' || node.type === 'ImageResize' || node.type === 'ImageCompare') {
            serialized.imageData = node.data.image || node.imageData || null;
        }
        if (node.type === 'ImagePreview' || node.type === 'ImageSave') {
            const images = Array.isArray(node.data?.images)
                ? node.data.images.filter((item) => typeof item === 'string' && item.trim())
                : [];
            if (images.length > 1) {
                serialized.images = images.slice();
                serialized.imagePreviewIndex = Math.max(0, parseInt(node.imagePreviewIndex || '0', 10) || 0);
            }
        }
        if (node.type === 'ImageImport') {
            serialized.importMode = documentRef.getElementById(`${id}-import-mode`)?.value || node.importMode || 'upload';
            serialized.imageUrl = documentRef.getElementById(`${id}-url-input`)?.value || node.imageUrl || '';
            if (serialized.importMode === 'url') {
                serialized.imageData = null;
            }
        }
        if (node.type === 'ImageResize') {
            serialized.resizeMode = documentRef.getElementById(`${id}-resize-mode`)?.value || 'scale';
            serialized.scalePercent = parseInt(documentRef.getElementById(`${id}-scale-percent`)?.value || '100', 10);
            serialized.targetWidth = documentRef.getElementById(`${id}-target-width`)?.value || '';
            serialized.targetHeight = documentRef.getElementById(`${id}-target-height`)?.value || '';
            serialized.keepAspect = documentRef.getElementById(`${id}-keep-aspect`)?.checked !== false;
            serialized.quality = parseInt(documentRef.getElementById(`${id}-quality`)?.value || '92', 10);
            serialized.originalWidth = node.originalWidth || node.resizePreviewMeta?.originalWidth || 0;
            serialized.originalHeight = node.originalHeight || node.resizePreviewMeta?.originalHeight || 0;
            serialized.outputWidth = node.outputWidth || node.resizePreviewMeta?.outputWidth || 0;
            serialized.outputHeight = node.outputHeight || node.resizePreviewMeta?.outputHeight || 0;
            serialized.outputFormat = node.outputFormat || node.resizePreviewMeta?.outputFormat || '';
            serialized.outputQuality = node.outputQuality || node.resizePreviewMeta?.outputQuality || null;
            serialized.estimatedBytes = node.estimatedBytes || node.resizePreviewMeta?.estimatedBytes || null;
        }
        if (node.type === 'ImageGenerate' || node.type === 'VideoGenerate' || node.type === 'TextChat') {
            serialized.referenceImageCount = Math.max(0, parseInt(node.referenceImageCount ?? node.data?.referenceImageCount ?? '5', 10) || 0);
            serialized.apiConfigId = documentRef.getElementById(`${id}-apiconfig`)?.value || 'default';
            serialized.providerId = documentRef.getElementById(`${id}-provider`)?.value || node.providerId || '';
            serialized.prompt = documentRef.getElementById(`${id}-prompt`)?.value || '';
            if (node.type === 'ImageGenerate') {
                serialized.aspect = documentRef.getElementById(`${id}-aspect`)?.value || '';
                serialized.resolution = documentRef.getElementById(`${id}-resolution`)?.value || '';
                serialized.customWidth = documentRef.getElementById(`${id}-custom-resolution-width`)?.value || '';
                serialized.customHeight = documentRef.getElementById(`${id}-custom-resolution-height`)?.value || '';
                serialized.customResolution = serialized.customWidth && serialized.customHeight
                    ? `${serialized.customWidth}x${serialized.customHeight}`
                    : '';
                serialized.search = documentRef.getElementById(`${id}-search`)?.checked || false;
                serialized.generationCount = Math.max(1, parseInt(documentRef.getElementById(`${id}-generation-count`)?.value || '1', 10) || 1);
            } else if (node.type === 'VideoGenerate') {
                serialized.aspect = documentRef.getElementById(`${id}-aspect`)?.value || '16:9';
                serialized.enhancePrompt = documentRef.getElementById(`${id}-enhance-prompt`)?.checked === true;
                serialized.enableUpsample = documentRef.getElementById(`${id}-enable-upsample`)?.checked === true;
                serialized.generationCount = Math.max(1, parseInt(documentRef.getElementById(`${id}-generation-count`)?.value || '1', 10) || 1);
                serialized.videoId = node.data?.videoId || '';
                serialized.videoUrl = node.data?.videoUrl || '';
                serialized.videoStatus = node.data?.videoStatus || '';
                serialized.videoStatusText = node.data?.videoStatusText || '';
            } else if (node.type === 'TextChat') {
                serialized.sysprompt = documentRef.getElementById(`${id}-sysprompt`)?.value || '';
                serialized.search = documentRef.getElementById(`${id}-search`)?.checked || false;
            }
        }
        if (node.type === 'ImageSave') {
            serialized.filename = documentRef.getElementById(`${id}-filename`)?.value || 'generated_image';
            if (node.data?.video && typeof node.data.video === 'object') {
                serialized.video = {
                    id: node.data.video.id || '',
                    url: node.data.video.url || '',
                    status: node.data.video.status || '',
                    prompt: node.data.video.prompt || ''
                };
            }
        }
        if (node.type === 'ImageMerge') {
            serialized.inputCount = Math.max(1, parseInt(node.data?.inputCount || '1', 10) || 1);
        }
        if (node.type === 'TextMerge') {
            serialized.inputCount = Math.max(1, parseInt(node.data?.inputCount || '1', 10) || 1);
        }
        if (node.type === 'Text') {
            serialized.text = documentRef.getElementById(`${id}-text`)?.value || '';
            if (Array.isArray(node.data?.texts) && node.data.texts.length > 0) {
                serialized.texts = node.data.texts.slice();
                serialized.textPreviewIndex = Math.max(0, parseInt(node.textPreviewIndex || '0', 10) || 0);
            }
        }
        if (node.type === 'TextSplit') {
            serialized.text = node.data?.text || '';
            serialized.delimiter = documentRef.getElementById(`${id}-delimiter`)?.value || '';
            const parsedOutputCount = parseInt(documentRef.getElementById(`${id}-output-count`)?.value ?? node.data?.outputCount ?? '1', 10);
            serialized.outputCount = Number.isFinite(parsedOutputCount) ? Math.max(0, parsedOutputCount) : 1;
            serialized.removeEmptyLines = documentRef.getElementById(`${id}-remove-empty-lines`)?.checked === true;
            serialized.previewEnabled = documentRef.getElementById(`${id}-preview-enabled`)?.checked === true;
            serialized.mergeOutputEnabled = documentRef.getElementById(`${id}-merge-output-enabled`)?.checked === true;
            serialized.parts = Array.isArray(node.data?.parts) ? node.data.parts.slice() : [];
        }
        if (node.type === 'CameraControl') {
            serialized.pitch = Number(node.data?.pitch ?? 12);
            serialized.yaw = Number(node.data?.yaw ?? 28);
            serialized.distance = Number(node.data?.distance ?? 6.5);
            serialized.fov = Number(node.data?.fov ?? 50);
            serialized.roll = Number(node.data?.roll ?? 0);
            serialized.cameraViewMode = node.data?.cameraViewMode === 'thirdPerson' ? 'thirdPerson' : 'firstPerson';
            serialized.text = node.data?.text || node.data?.cameraPrompt || '';
            serialized.cameraPrompt = serialized.text;
            serialized.cameraPreviewImage = node.data?.cameraPreviewImage || '';
        }
        return serialized;
    }

    function copySelectedNode() {
        const selectedIds = Array.from(state.selectedNodes);
        if (selectedIds.length === 0) return showToast('未选中节点', 'warning');

        const nodes = selectedIds.map((id) => serializeOneNode(id)).filter((node) => !!node);
        if (nodes.length === 0) return;

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        nodes.forEach((node) => {
            minX = Math.min(minX, node.x);
            minY = Math.min(minY, node.y);
            maxX = Math.max(maxX, node.x + (node.width || 240));
            maxY = Math.max(maxY, node.y + (node.height || 100));
        });

        const {
            internalConnections,
            externalConnections
        } = collectConnectionSnapshotsForNodes(state, selectedIds);

        state.clipboard = {
            nodes,
            connections: internalConnections,
            externalConnections,
            center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
        };
        state.clipboardTimestamp = Date.now();

        showToast(`已复制 ${nodes.length} 个节点`, 'success');
    }

    function pasteNode(options = {}) {
        if (!state.clipboard || !state.clipboard.nodes.length) {
            return showToast('剪贴板为空', 'warning');
        }

        const includeExternalConnections = options.includeExternalConnections === true;
        const mousePos = state.mouseCanvas;
        const clip = state.clipboard;
        const idMap = new Map();

        state.selectedNodes.forEach((nid) => {
            const node = state.nodes.get(nid);
            if (node) node.el.classList.remove('selected');
        });
        state.selectedNodes.clear();

        clip.nodes.forEach((data) => {
            const offsetX = data.x - clip.center.x;
            const offsetY = data.y - clip.center.y;
            const newId = addNode(data.type, mousePos.x + offsetX, mousePos.y + offsetY, { ...data, id: null }, true);
            if (newId) {
                idMap.set(data.id, newId);
                state.selectedNodes.add(newId);
                state.nodes.get(newId).el.classList.add('selected');
            }
        });

        const connectionResult = appendMappedConnectionSnapshots({
            state,
            idMap,
            internalConnections: clip.connections || [],
            externalConnections: clip.externalConnections || [],
            includeExternalConnections
        });

        updateAllConnections();
        updatePortStyles();
        onConnectionsChanged();
        scheduleSave();

        if (includeExternalConnections && (connectionResult.externalAdded > 0 || connectionResult.externalSkipped > 0)) {
            const suffix = connectionResult.externalSkipped > 0
                ? `，${connectionResult.externalSkipped} 条外部连线因端口不可用已跳过`
                : '';
            showToast(`已粘贴 ${idMap.size} 个节点，并恢复 ${connectionResult.externalAdded} 条外部连线${suffix}`, 'success');
            return;
        }

        showToast(`已粘贴 ${idMap.size} 个节点`, 'success');
    }

    return {
        serializeOneNode,
        copySelectedNode,
        pasteNode
    };
}
