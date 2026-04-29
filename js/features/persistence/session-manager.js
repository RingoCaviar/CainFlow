/**
 * 负责本地会话状态保存、撤销栈维护与自动保存调度。
 */
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
    onConnectionsChanged = () => {}
}) {
    let saveTimer = null;

    function saveState() {
        try {
            const data = nodeSerializer.buildStatePayload();
            localStorageRef.setItem(storageKey, JSON.stringify(data));
        } catch (e) {
            console.warn('Save failed:', e);
            if (e.name === 'QuotaExceededError') {
                showToast('浏览器存储空间不足，部分状态可能未保存', 'error', 5000);
            }
        }
    }

    function scheduleSave() {
        if (state.dragging || state.resizing) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveState, 300);
    }

    function updateUndoButton() {
        const btn = documentRef.getElementById('btn-undo');
        if (btn) btn.disabled = state.undoStack.length === 0;
    }

    function pushHistory() {
        const snapshot = {
            nodes: nodeSerializer.serializeNodes(true),
            connections: state.connections.map((connection) => ({ ...connection }))
        };
        state.undoStack.push(JSON.stringify(snapshot));
        if (state.undoStack.length > 5) state.undoStack.shift();
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
        state.nodes.forEach((node) => node.el.remove());
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
        saveState();
        showToast('已撤回上一步操作', 'info');
    }

    return {
        scheduleSave,
        saveState,
        pushHistory,
        updateUndoButton,
        undo
    };
}
