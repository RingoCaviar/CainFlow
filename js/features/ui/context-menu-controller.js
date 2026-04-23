/**
 * 管理画布与节点右键菜单的展示、选择同步和菜单项触发行为。
 */
export function createContextMenuControllerApi({
    state,
    canvasContainer,
    contextMenu,
    viewportApi,
    addNode,
    runWorkflow,
    updateAllConnections,
    documentRef = document
}) {
    function setElementVisible(element, visible) {
        if (!element) return;
        element.style.display = visible ? 'flex' : 'none';
    }

    function clearSelection() {
        state.selectedNodes.forEach((nodeId) => {
            const node = state.nodes.get(nodeId);
            if (node) node.el.classList.remove('selected');
        });
        state.selectedNodes.clear();
    }

    function ensureNodeSelected(nodeEl) {
        if (state.selectedNodes.has(nodeEl.id)) return;
        clearSelection();
        state.selectedNodes.add(nodeEl.id);
        nodeEl.classList.add('selected');
    }

    function updateNodeActionVisibility({ hasNodeTarget, hasSelection }) {
        const nodeActions = documentRef.getElementById('context-menu-node-actions');
        const runToHereItem = documentRef.getElementById('context-menu-run-to-here');
        const runSelectedItem = documentRef.getElementById('context-menu-run-selected');
        const divider = documentRef.getElementById('context-menu-node-divider');

        setElementVisible(runToHereItem, hasNodeTarget);
        setElementVisible(runSelectedItem, hasSelection);

        const hasAnyNodeAction = hasNodeTarget || hasSelection;
        if (nodeActions) {
            nodeActions.style.display = hasAnyNodeAction ? 'block' : 'none';
        }
        if (divider) {
            divider.style.display = hasAnyNodeAction ? 'block' : 'none';
        }
    }

    function initContextMenu() {
        canvasContainer.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (state.justCut) return;

            state.contextMenu = { x: e.clientX, y: e.clientY };

            const nodeEl = e.target.closest('.node');

            if (nodeEl) {
                state.contextMenuNodeId = nodeEl.id;
                ensureNodeSelected(nodeEl);
            } else {
                state.contextMenuNodeId = null;
            }

            updateNodeActionVisibility({
                hasNodeTarget: Boolean(state.contextMenuNodeId),
                hasSelection: state.selectedNodes.size > 0
            });

            contextMenu.style.left = e.clientX + 'px';
            contextMenu.style.top = e.clientY + 'px';
            contextMenu.classList.remove('hidden');
        });

        documentRef.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target)) contextMenu.classList.add('hidden');

            if (e.target.id === 'canvas-container' && !state.justDragged) {
                clearSelection();
                updateAllConnections();
            }
        });

        documentRef.querySelectorAll('.context-menu-item').forEach((item) => {
            item.addEventListener('click', () => {
                if (item.id === 'context-menu-run-to-here') {
                    if (state.contextMenuNodeId) {
                        runWorkflow({
                            mode: 'target-node',
                            targetNodeId: state.contextMenuNodeId
                        });
                    }
                } else if (item.id === 'context-menu-run-selected') {
                    if (state.selectedNodes.size > 0) {
                        runWorkflow({
                            mode: 'selected-only',
                            selectedNodeIds: Array.from(state.selectedNodes)
                        });
                    }
                } else if (item.dataset.type) {
                    const pos = viewportApi.screenToCanvas(state.contextMenu.x, state.contextMenu.y);
                    addNode(item.dataset.type, pos.x, pos.y);
                }
                contextMenu.classList.add('hidden');
            });
        });
    }

    return {
        initContextMenu
    };
}
