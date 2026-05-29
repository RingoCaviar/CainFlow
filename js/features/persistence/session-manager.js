/**
 * 负责本地会话状态保存、撤销栈维护与自动保存调度。
 */
import { cleanupElementResources } from '../../core/common-utils.js';

export function createSessionManagerApi({
    state,
    storageKey,
    nodeSerializer,
    localStorageRef = localStorage,
    documentRef = document,
    showToast,
    addNode,
    updateAllConnections,
    updatePortStyles,
    onConnectionsChanged = () => {},
    clearOrphanedNodeAssets = async () => true
}) {
    let saveTimer = null;
    let onBeforeSave = () => {};

    function setBeforeSave(callback) {
        onBeforeSave = typeof callback === 'function' ? callback : () => {};
    }

    function saveState() {
        try {
            onBeforeSave({ dirty: false });
            const data = nodeSerializer.buildStatePayload();
            data.workflowTabs = Array.isArray(state.workflowTabs)
                ? state.workflowTabs.map((tab) => ({
                    name: tab.name,
                    data: tab.data,
                    dirty: tab.dirty === true,
                    colorIndex: Number.isInteger(tab.colorIndex) ? tab.colorIndex : 0,
                    runResult: tab.runResult === 'success' || tab.runResult === 'error' ? tab.runResult : ''
                }))
                : [];
            data.activeWorkflowName = state.activeWorkflowName || '';
            localStorageRef.setItem(storageKey, JSON.stringify(data));
        } catch (e) {
            console.warn('Save failed:', e);
            if (e.name === 'QuotaExceededError') {
                showToast('浏览器存储空间不足，部分状态可能未保存', 'error', 5000);
            }
        }
    }

    function scheduleSave(options = {}) {
        if (state.dragging || state.resizing) return;
        if (options.dirty !== false) {
            onBeforeSave({ dirty: true });
        }
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveState, 300);
    }

    function updateUndoButton() {
        const btn = documentRef.getElementById('btn-undo');
        if (btn) btn.disabled = state.undoStack.length === 0;
    }

    function collectActiveNodeAssetIds() {
        const ids = new Set(state.nodes.keys());
        state.undoStack.forEach((raw) => {
            try {
                const snapshot = JSON.parse(raw);
                if (!Array.isArray(snapshot?.nodes)) return;
                snapshot.nodes.forEach((node) => {
                    if (node?.id) ids.add(node.id);
                });
            } catch {
                // Ignore invalid legacy undo entries.
            }
        });
        return ids;
    }

    function cleanupOrphanedNodeAssetsSoon() {
        setTimeout(() => {
            clearOrphanedNodeAssets(collectActiveNodeAssetIds()).catch((error) => {
                console.warn('Clear orphaned node assets failed:', error);
            });
        }, 0);
    }

    function pushHistory() {
        const snapshot = {
            nodes: nodeSerializer.serializeNodes(false),
            connections: state.connections.map((connection) => ({ ...connection }))
        };
        state.undoStack.push(JSON.stringify(snapshot));
        if (state.undoStack.length > 5) {
            state.undoStack.shift();
            cleanupOrphanedNodeAssetsSoon();
        }
        updateUndoButton();
    }

    async function undo() {
        if (state.undoStack.length === 0) return;
        if (state.runningNodeIds?.size > 0) {
            showToast('有节点正在运行，暂不能撤销会修改运行中节点的操作', 'warning');
            return;
        }

        const raw = state.undoStack.pop();
        const snapshot = JSON.parse(raw);

        state.selectedNodes.clear();
        state.nodes.forEach((node) => {
            cleanupElementResources(node.el);
            node.el.remove();
        });
        state.nodes.clear();
        state.connections = [];

        if (snapshot.nodes && snapshot.nodes.length) {
            for (const nodeData of snapshot.nodes) {
                addNode(nodeData.type, nodeData.x, nodeData.y, nodeData, true);
            }
        }

        if (snapshot.connections && snapshot.connections.length) {
            state.connections = snapshot.connections;
        }

        updateAllConnections();
        updatePortStyles();
        onConnectionsChanged();
        updateUndoButton();
        onBeforeSave({ dirty: true });
        saveState();
        cleanupOrphanedNodeAssetsSoon();
        showToast('已撤回上一步操作', 'info');
    }

    return {
        scheduleSave,
        saveState,
        setBeforeSave,
        pushHistory,
        updateUndoButton,
        undo,
        collectActiveNodeAssetIds,
        cleanupOrphanedNodeAssetsSoon
    };
}
