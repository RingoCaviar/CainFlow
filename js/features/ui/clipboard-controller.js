/**
 * 负责节点复制、剪切板缓存与粘贴还原逻辑，支持多节点批量复制。
 */
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
            height: node.height || null
        };
        if (node.type === 'ImageImport' || node.type === 'ImagePreview' || node.type === 'ImageSave' || node.type === 'ImageResize') {
            serialized.imageData = node.data.image || node.imageData || null;
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
        if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
            serialized.apiConfigId = documentRef.getElementById(`${id}-apiconfig`)?.value || 'default';
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
            } else if (node.type === 'TextChat') {
                serialized.sysprompt = documentRef.getElementById(`${id}-sysprompt`)?.value || '';
                serialized.search = documentRef.getElementById(`${id}-search`)?.checked || false;
            }
        }
        if (node.type === 'ImageSave') {
            serialized.filename = documentRef.getElementById(`${id}-filename`)?.value || 'generated_image';
        }
        if (node.type === 'TextInput') {
            serialized.text = documentRef.getElementById(`${id}-text`)?.value || '';
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

        const internalConnections = state.connections.filter((connection) =>
            selectedIds.includes(connection.from.nodeId) && selectedIds.includes(connection.to.nodeId)
        );

        state.clipboard = {
            nodes,
            connections: internalConnections,
            center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
        };
        state.clipboardTimestamp = Date.now();

        showToast(`已复制 ${nodes.length} 个节点`, 'success');
    }

    function pasteNode() {
        if (!state.clipboard || !state.clipboard.nodes.length) {
            return showToast('剪贴板为空', 'warning');
        }

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

        clip.connections.forEach((connection) => {
            const newFromId = idMap.get(connection.from.nodeId);
            const newToId = idMap.get(connection.to.nodeId);
            if (newFromId && newToId) {
                state.connections.push({
                    id: 'c_' + Math.random().toString(36).substr(2, 9),
                    from: { nodeId: newFromId, port: connection.from.port },
                    to: { nodeId: newToId, port: connection.to.port },
                    type: connection.type
                });
            }
        });

        updateAllConnections();
        updatePortStyles();
        onConnectionsChanged();
        scheduleSave();
        showToast(`已粘贴 ${idMap.size} 个节点`, 'success');
    }

    return {
        serializeOneNode,
        copySelectedNode,
        pasteNode
    };
}
