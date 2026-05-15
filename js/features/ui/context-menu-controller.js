/**
 * 管理画布与节点右键菜单的展示、选择同步和菜单项触发行为。
 */
export function createContextMenuControllerApi({
    state,
    canvasContainer,
    contextMenu,
    connectionCreatePopup,
    viewportApi,
    addNode,
    cloneNode = null,
    detachCloneNode = null,
    renameNode = null,
    runWorkflow,
    createNodeFromConnectionCandidate,
    updateAllConnections,
    showToast = null,
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
        const renameNodeItem = documentRef.getElementById('context-menu-rename-node');
        const cloneNodeItem = documentRef.getElementById('context-menu-clone-node');
        const detachCloneNodeItem = documentRef.getElementById('context-menu-detach-clone-node');
        const divider = documentRef.getElementById('context-menu-node-divider');
        const targetNode = state.contextMenuNodeId ? state.nodes.get(state.contextMenuNodeId) : null;
        const isCloneTarget = targetNode?.isClone === true;

        setElementVisible(runToHereItem, hasNodeTarget);
        setElementVisible(runSelectedItem, hasSelection);
        setElementVisible(renameNodeItem, hasNodeTarget && !isCloneTarget);
        setElementVisible(cloneNodeItem, hasNodeTarget && !isCloneTarget);
        setElementVisible(detachCloneNodeItem, hasNodeTarget && isCloneTarget);

        const hasAnyNodeAction = hasNodeTarget || hasSelection;
        if (nodeActions) {
            nodeActions.style.display = hasAnyNodeAction ? 'block' : 'none';
        }
        if (divider) {
            divider.style.display = hasAnyNodeAction ? 'block' : 'none';
        }
    }

    let ignoreNextDocumentClickForConnectionPopup = false;
    let ignoreNextContextMenuClick = false;
    let closeSubmenuTimer = null;

    function getContextSubmenus() {
        return Array.from(documentRef.querySelectorAll('[data-context-submenu]'));
    }

    function closeConnectionCreatePopup() {
        state.connectionCreatePopup = null;
        connectionCreatePopup?.classList.add('hidden');
        if (connectionCreatePopup) {
            connectionCreatePopup.innerHTML = '';
        }
    }

    function closeContextMenu() {
        contextMenu?.classList.add('hidden');
        closeContextSubmenus();
    }

    function cancelSubmenuClose() {
        if (!closeSubmenuTimer) return;
        clearTimeout(closeSubmenuTimer);
        closeSubmenuTimer = null;
    }

    function closeContextSubmenus() {
        cancelSubmenuClose();
        getContextSubmenus().forEach((submenu) => submenu.classList.add('hidden'));
        contextMenu?.querySelectorAll('[data-submenu-target]').forEach((trigger) => trigger.classList.remove('is-open'));
    }

    function scheduleSubmenuClose() {
        cancelSubmenuClose();
        closeSubmenuTimer = setTimeout(() => {
            closeContextSubmenus();
        }, 180);
    }

    function handleContextMenuItemSelection(item) {
        if (!item) return;
        if (item.dataset.submenuTarget) {
            openContextSubmenu(item);
            return;
        }

        try {
            if (item.id === 'context-menu-run-to-here') {
                if (state.contextMenuNodeId) {
                    runWorkflow({
                        mode: 'target-node',
                        targetNodeId: state.contextMenuNodeId
                    });
                }
                return;
            }

            if (item.id === 'context-menu-run-selected') {
                if (state.selectedNodes.size > 0) {
                    runWorkflow({
                        mode: 'selected-only',
                        selectedNodeIds: Array.from(state.selectedNodes)
                    });
                }
                return;
            }

            if (item.id === 'context-menu-rename-node') {
                const nodeId = state.contextMenuNodeId;
                const node = nodeId ? state.nodes.get(nodeId) : null;
                if (!node || typeof renameNode !== 'function') return;
                const currentTitle = node.customTitle || node.defaultTitle || node.el?.querySelector('.node-title')?.textContent || '';
                const promptRef = documentRef.defaultView?.prompt || (typeof prompt !== 'undefined' ? prompt : null);
                if (!promptRef) return;
                const nextTitle = promptRef('请输入新的节点名称；留空将还原节点原本的名字', currentTitle);
                if (nextTitle !== null) {
                    renameNode(nodeId, nextTitle);
                }
                return;
            }

            if (item.id === 'context-menu-clone-node') {
                const nodeId = state.contextMenuNodeId;
                if (nodeId && typeof cloneNode === 'function') {
                    cloneNode(nodeId);
                }
                return;
            }

            if (item.id === 'context-menu-detach-clone-node') {
                const nodeId = state.contextMenuNodeId;
                if (nodeId && typeof detachCloneNode === 'function') {
                    detachCloneNode(nodeId);
                }
                return;
            }

            if (item.dataset.type) {
                const pos = viewportApi.screenToCanvas(state.contextMenu.x, state.contextMenu.y);
                const nodeId = addNode(item.dataset.type, pos.x, pos.y);
                if (!nodeId && showToast) {
                    showToast(`创建节点失败：${item.dataset.type}`, 'error');
                }
            }
        } catch (error) {
            if (showToast) {
                showToast(`创建节点失败：${error.message || error}`, 'error', 5000);
            }
            throw error;
        } finally {
            closeContextMenu();
        }
    }

    function positionFloatingMenu(menu, clientX, clientY) {
        if (!menu) return;
        const padding = 8;
        menu.style.left = `${clientX}px`;
        menu.style.top = `${clientY}px`;
        menu.classList.remove('hidden');

        const rect = menu.getBoundingClientRect();
        const viewportWidth = documentRef.defaultView?.innerWidth || documentRef.documentElement.clientWidth || 0;
        const viewportHeight = documentRef.defaultView?.innerHeight || documentRef.documentElement.clientHeight || 0;
        const nextLeft = Math.max(padding, Math.min(clientX, viewportWidth - rect.width - padding));
        const nextTop = Math.max(padding, Math.min(clientY, viewportHeight - rect.height - padding));
        menu.style.left = `${nextLeft}px`;
        menu.style.top = `${nextTop}px`;
    }

    function positionSubmenu(submenu, trigger) {
        if (!submenu || !trigger) return;

        const padding = 8;
        const gap = 6;
        const triggerRect = trigger.getBoundingClientRect();
        const viewportWidth = documentRef.defaultView?.innerWidth || documentRef.documentElement.clientWidth || 0;
        const viewportHeight = documentRef.defaultView?.innerHeight || documentRef.documentElement.clientHeight || 0;

        submenu.style.left = `${triggerRect.right + gap}px`;
        submenu.style.top = `${triggerRect.top}px`;
        submenu.classList.remove('hidden');

        const rect = submenu.getBoundingClientRect();
        const hasRoomRight = triggerRect.right + gap + rect.width <= viewportWidth - padding;
        const nextLeft = hasRoomRight
            ? triggerRect.right + gap
            : Math.max(padding, triggerRect.left - rect.width - gap);
        const nextTop = Math.max(padding, Math.min(triggerRect.top, viewportHeight - rect.height - padding));

        submenu.style.left = `${nextLeft}px`;
        submenu.style.top = `${nextTop}px`;
    }

    function openContextSubmenu(trigger) {
        const submenuId = trigger?.dataset.submenuTarget;
        const submenu = submenuId ? documentRef.getElementById(submenuId) : null;
        if (!trigger || !submenu || contextMenu?.classList.contains('hidden')) return;

        cancelSubmenuClose();
        getContextSubmenus().forEach((entry) => {
            if (entry !== submenu) entry.classList.add('hidden');
        });
        contextMenu?.querySelectorAll('[data-submenu-target]').forEach((entry) => {
            if (entry !== trigger) entry.classList.remove('is-open');
        });
        trigger.classList.add('is-open');
        positionSubmenu(submenu, trigger);
    }

    function openConnectionCreatePopup(popupState) {
        if (!connectionCreatePopup) return;
        state.connectionCreatePopup = popupState;
        ignoreNextDocumentClickForConnectionPopup = true;
        connectionCreatePopup.style.left = `${popupState.screenX}px`;
        connectionCreatePopup.style.top = `${popupState.screenY}px`;
        connectionCreatePopup.innerHTML = [
            '<div class="context-menu-header">创建并连接节点</div>',
            ...popupState.candidates.map((candidate) => (`
                <div class="context-menu-item" data-popup-node-type="${candidate.type}">
                    ${candidate.title}
                </div>
            `))
        ].join('');
        connectionCreatePopup.classList.remove('hidden');
    }

    function initConnectionCreatePopup() {
        connectionCreatePopup?.addEventListener('click', (e) => {
            const item = e.target.closest('[data-popup-node-type]');
            if (!item || !state.connectionCreatePopup) return;
            const candidate = state.connectionCreatePopup.candidates.find((entry) => entry.type === item.dataset.popupNodeType);
            if (!candidate) return;
            createNodeFromConnectionCandidate?.(
                state.connectionCreatePopup.source,
                candidate,
                state.connectionCreatePopup.canvasX,
                state.connectionCreatePopup.canvasY
            );
            closeConnectionCreatePopup();
        });
    }

    function initContextMenu() {
        canvasContainer.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (state.justCut) return;

            closeConnectionCreatePopup();
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
            closeContextSubmenus();

            positionFloatingMenu(contextMenu, e.clientX, e.clientY);
        });

        documentRef.addEventListener('click', (e) => {
            if (ignoreNextDocumentClickForConnectionPopup) {
                ignoreNextDocumentClickForConnectionPopup = false;
            } else if (connectionCreatePopup && !connectionCreatePopup.contains(e.target)) {
                closeConnectionCreatePopup();
            }
            const isInsideSubmenu = getContextSubmenus().some((submenu) => submenu.contains(e.target));
            if (!contextMenu.contains(e.target) && !isInsideSubmenu) closeContextMenu();

            if (e.target.id === 'canvas-container' && !state.justDragged) {
                clearSelection();
                updateAllConnections();
            }
        });

        documentRef.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeContextMenu();
                closeConnectionCreatePopup();
            }
        });

        contextMenu.addEventListener('pointerover', (e) => {
            const submenuTrigger = e.target.closest('[data-submenu-target]');
            if (submenuTrigger) {
                openContextSubmenu(submenuTrigger);
            } else if (e.target.closest('.context-menu-item')) {
                closeContextSubmenus();
            }
        });

        contextMenu.addEventListener('pointerleave', scheduleSubmenuClose);
        getContextSubmenus().forEach((submenu) => {
            submenu.addEventListener('pointerenter', cancelSubmenuClose);
            submenu.addEventListener('pointerleave', scheduleSubmenuClose);
        });

        contextMenu.addEventListener('pointerdown', (e) => {
            const item = e.target.closest('.context-menu-item');
            if (!item || !contextMenu.contains(item)) return;
            e.preventDefault();
            e.stopPropagation();
            ignoreNextContextMenuClick = true;
            handleContextMenuItemSelection(item);
        });

        contextMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu-item');
            if (!item || !contextMenu.contains(item)) return;
            e.preventDefault();
            e.stopPropagation();
            if (ignoreNextContextMenuClick) {
                ignoreNextContextMenuClick = false;
                return;
            }
            handleContextMenuItemSelection(item);
        });

        getContextSubmenus().forEach((submenu) => {
            submenu.addEventListener('pointerdown', (e) => {
                const item = e.target.closest('.context-menu-item');
                if (!item) return;
                e.preventDefault();
                e.stopPropagation();
                ignoreNextContextMenuClick = true;
                handleContextMenuItemSelection(item);
            });

            submenu.addEventListener('click', (e) => {
                const item = e.target.closest('.context-menu-item');
                if (!item) return;
                e.preventDefault();
                e.stopPropagation();
                if (ignoreNextContextMenuClick) {
                    ignoreNextContextMenuClick = false;
                    return;
                }
                handleContextMenuItemSelection(item);
            });
        });

        initConnectionCreatePopup();
    }

    return {
        initContextMenu,
        openConnectionCreatePopup,
        closeContextMenu,
        closeConnectionCreatePopup
    };
}
