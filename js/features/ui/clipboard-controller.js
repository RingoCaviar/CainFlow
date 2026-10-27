/**
 * 负责节点复制、剪切板缓存与粘贴还原逻辑，支持多节点批量复制。
 */
import {
    appendMappedConnectionSnapshots,
    collectConnectionSnapshotsForNodes
} from '../../canvas/connection-copy-utils.js';
import { migrateLegacyNodeData, migrateLegacyWorkflowData } from '../persistence/legacy-node-migration.js';
import { createNodeSerializer } from '../../nodes/node-serializer.js';
import { getCanonicalImageList } from '../execution/execution-data-utils.js';
import { hasNodeCapability, NODE_CAPABILITIES } from '../../nodes/registry.js';
import { createSelectionApi } from '../../canvas/selection.js';

export function createClipboardControllerApi({
    state,
    selectionApi = createSelectionApi({ state }),
    documentRef = document,
    showToast,
    addNode,
    pushHistory = () => {},
    getWorkflowId = () => '',
    mediaProtection = { protect() {}, release: async () => {} },
    updateAllConnections,
    updatePortStyles,
    scheduleSave,
    onConnectionsChanged = () => {}
}) {
    function markNativeClipboardWrite(duration = 200) {
        const now = Date.now();
        state.nativeClipboardChangeTimestamp = now;
        state.ignoreNativeClipboardEventUntil = now + Math.max(0, duration);
        return now;
    }

    function markNativeClipboardEvent(timestamp = Date.now()) {
        if (state.ignoreNativeClipboardEventUntil && timestamp <= state.ignoreNativeClipboardEventUntil) {
            return false;
        }
        state.nativeClipboardChangeTimestamp = timestamp;
        return true;
    }

    function hasClipboardNodes() {
        return Boolean(state.clipboard && Array.isArray(state.clipboard.nodes) && state.clipboard.nodes.length > 0);
    }

    function shouldPreferInternalClipboard() {
        if (!hasClipboardNodes()) return false;
        return state.clipboardTimestamp > Math.max(
            state.lastFocusTime || 0,
            state.nativeClipboardChangeTimestamp || 0
        );
    }

    const nodeSerializer = createNodeSerializer({ state, documentRef });
    let clipboardMediaSnapshot = null;

    function replaceClipboard(clipboard) {
        const next = { historyId: `clipboard:${crypto.randomUUID()}`, nodes: clipboard.nodes || [] };
        mediaProtection.protect(next, getWorkflowId());
        const previous = clipboardMediaSnapshot;
        clipboardMediaSnapshot = next;
        state.clipboard = clipboard;
        if (previous) void mediaProtection.release(previous);
    }

    function serializeOneNode(nodeId) {
        const snapshot = nodeSerializer.serializeNodes([nodeId])[0];
        if (!snapshot) return null;
        // Copying produces an independent node; explicit cloning adds its own binding.
        const { isClone, cloneSourceId, concurrentRequestStatus, ...copy } = snapshot;
        for (const field of Object.keys(copy)) {
            if (field.startsWith('imageTask')) delete copy[field];
        }
        if (copy.type === 'VideoGenerate') {
            for (const field of ['videoId', 'videoStatus', 'videoStatusText', 'videoCreateHttpStatus', 'videoCreateStatus', 'videoStatusUpdateTime']) delete copy[field];
        }
        const node = state.nodes.get(nodeId);
        const durable = copy.mediaAssetKeys?.length || [copy.imageAssetKey, copy.imageImportAssetKey].some(key => key?.startsWith('media:'));
        const canCopyPixels = hasNodeCapability(node.type, NODE_CAPABILITIES.RECOVERABLE_IMAGE_ASSET) || hasNodeCapability(node.type, NODE_CAPABILITIES.INLINE_IMAGE_DATA);
        if (!durable && copy.imageResultPersistence !== 'transient' && canCopyPixels) {
            const images = getCanonicalImageList(node, { includeResizePreview: false });
            if (images.length && !(node.type === 'ImageImport' && copy.importMode === 'url')) {
                copy.images = images.slice();
                copy.imageData = images[0];
                copy.imageCount = images.length;
            }
        }
        return copy;
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

        replaceClipboard({
            sourceWorkflowId: getWorkflowId(),
            nodes,
            connections: internalConnections,
            externalConnections,
            center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
        });
        state.clipboardTimestamp = Date.now();
        state.ignoreNativeClipboardEventUntil = 0;

        showToast(`已复制 ${nodes.length} 个节点`, 'success');
    }

    function pasteNode(options = {}) {
        if (!state.clipboard || !state.clipboard.nodes.length) {
            return showToast('剪贴板为空', 'warning');
        }

        const includeExternalConnections = options.includeExternalConnections === true
            && Boolean(state.clipboard.sourceWorkflowId)
            && state.clipboard.sourceWorkflowId === getWorkflowId();
        const mousePos = options.position && Number.isFinite(options.position.x) && Number.isFinite(options.position.y)
            ? options.position
            : state.mouseCanvas;
        const clip = state.clipboard;
        const idMap = new Map();

        const newIds = [];
        pushHistory();
        clip.nodes.forEach((data) => {
            const migratedData = migrateLegacyNodeData({ ...data, id: null });
            const offsetX = data.x - clip.center.x;
            const offsetY = data.y - clip.center.y;
            const newId = addNode(migratedData.type, mousePos.x + offsetX, mousePos.y + offsetY, migratedData, true);
            if (newId) {
                idMap.set(data.id, newId);
                newIds.push(newId);
            }
        });
        selectionApi.setSelection(newIds);

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

        if (options.includeExternalConnections === true && !includeExternalConnections && clip.externalConnections?.length) {
            showToast(`已粘贴 ${idMap.size} 个节点；跨工作流的外部连线未自动连接`, 'info');
            return;
        }

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
        pasteNode,
        hasClipboardNodes,
        shouldPreferInternalClipboard,
        markNativeClipboardWrite,
        markNativeClipboardEvent,
        hydrateClipboard(data = null) {
            if (!data || typeof data !== 'object') return null;
            const migrated = migrateLegacyWorkflowData(data);
            replaceClipboard(migrated);
            state.clipboardTimestamp = Date.now();
            return migrated;
        }
    };
}
