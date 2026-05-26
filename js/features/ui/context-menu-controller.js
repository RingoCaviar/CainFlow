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
    scheduleSave = () => {},
    showToast = null,
    documentRef = document
}) {
    const referenceImageNodeTypes = new Set(['ImageGenerate', 'VideoGenerate', 'TextChat']);
    const defaultReferenceImageCount = 5;
    const maxReferenceImageCount = 64;

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
        const referenceImageCountItem = documentRef.getElementById('context-menu-reference-image-count');
        const cloneNodeItem = documentRef.getElementById('context-menu-clone-node');
        const detachCloneNodeItem = documentRef.getElementById('context-menu-detach-clone-node');
        const divider = documentRef.getElementById('context-menu-node-divider');
        const targetNode = state.contextMenuNodeId ? state.nodes.get(state.contextMenuNodeId) : null;
        const isCloneTarget = targetNode?.isClone === true;

        setElementVisible(runToHereItem, hasNodeTarget);
        setElementVisible(runSelectedItem, hasSelection);
        setElementVisible(renameNodeItem, hasNodeTarget && !isCloneTarget);
        setElementVisible(referenceImageCountItem, hasNodeTarget && !isCloneTarget && referenceImageNodeTypes.has(targetNode?.type));
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

    function normalizeReferenceImageCount(value, fallback = defaultReferenceImageCount) {
        const parsed = parseInt(value ?? fallback, 10);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(0, Math.min(maxReferenceImageCount, parsed));
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderReferenceImagePort(nodeId, index) {
        return `<div class="node-port input" data-node-id="${nodeId}" data-port="image_${index + 1}" data-type="image" data-direction="input">
                <div class="port-dot type-image"></div>
                <span class="port-label">参考图 ${index + 1}</span>
            </div>`;
    }

    function refreshReferenceImagePorts(nodeId, count) {
        const node = state.nodes.get(nodeId);
        if (!node || !referenceImageNodeTypes.has(node.type)) return;
        const inputsSection = node.el?.querySelector('.node-inputs-section');
        if (!inputsSection) return;

        inputsSection.querySelectorAll('.node-port[data-direction="input"][data-type="image"][data-port^="image_"]').forEach((port) => port.remove());
        const paramsPort = inputsSection.querySelector('.node-port[data-direction="input"][data-port="params"]');
        const fragment = documentRef.createDocumentFragment();
        for (let index = 0; index < count; index += 1) {
            const wrapper = documentRef.createElement('div');
            wrapper.innerHTML = renderReferenceImagePort(nodeId, index).trim();
            fragment.appendChild(wrapper.firstElementChild);
        }
        if (paramsPort) {
            inputsSection.insertBefore(fragment, paramsPort);
        } else {
            inputsSection.appendChild(fragment);
        }

        const validPorts = new Set(Array.from({ length: count }, (_, index) => `image_${index + 1}`));
        state.connections = state.connections.filter((connection) => (
            connection.to.nodeId !== nodeId ||
            !/^image_\d+$/.test(String(connection.to.port || '')) ||
            validPorts.has(connection.to.port)
        ));
        node.referenceImageCount = count;
        node.data = node.data || {};
        node.data.referenceImageCount = count;
        updateAllConnections();
        scheduleSave();
    }

    function getReferenceImageCountDialog() {
        let dialog = documentRef.getElementById('reference-image-count-dialog');
        if (dialog) return dialog;
        dialog = documentRef.createElement('div');
        dialog.id = 'reference-image-count-dialog';
        dialog.className = 'reference-image-count-dialog hidden';
        (documentRef.body || canvasContainer).appendChild(dialog);
        return dialog;
    }

    function closeReferenceImageCountDialog() {
        getReferenceImageCountDialog().classList.add('hidden');
    }

    function getNodeRenameDialog() {
        let dialog = documentRef.getElementById('node-rename-dialog');
        if (dialog) return dialog;
        dialog = documentRef.createElement('div');
        dialog.id = 'node-rename-dialog';
        dialog.className = 'reference-image-count-dialog node-rename-dialog hidden';
        (documentRef.body || canvasContainer).appendChild(dialog);
        return dialog;
    }

    function closeNodeRenameDialog() {
        getNodeRenameDialog().classList.add('hidden');
    }

    function openNodeRenameDialog(nodeId) {
        const node = state.nodes.get(nodeId);
        if (!node || typeof renameNode !== 'function') return;
        const currentTitle = node.customTitle || node.defaultTitle || node.el?.querySelector('.node-title')?.textContent || '';
        const dialog = getNodeRenameDialog();
        dialog.innerHTML = `
            <div class="reference-image-count-backdrop" data-close-node-rename="true"></div>
            <div class="reference-image-count-panel" role="dialog" aria-modal="true" aria-labelledby="node-rename-title">
                <div class="reference-image-count-header">
                    <h3 id="node-rename-title">重命名节点</h3>
                    <button type="button" class="reference-image-count-close" data-close-node-rename="true" title="关闭">×</button>
                </div>
                <div class="reference-image-count-body">
                    <label for="node-rename-input">节点名称</label>
                    <input id="node-rename-input" type="text" value="${escapeHtml(currentTitle)}" />
                    <p>留空后点击确定，将还原节点原本的名字。</p>
                </div>
                <div class="reference-image-count-footer">
                    <button type="button" class="btn btn-secondary" data-close-node-rename="true">取消</button>
                    <button type="button" class="btn btn-primary" id="btn-confirm-node-rename">确定</button>
                </div>
            </div>
        `;
        dialog.classList.remove('hidden');
        const input = dialog.querySelector('#node-rename-input');
        input?.focus();
        input?.select();
        dialog.querySelectorAll('[data-close-node-rename="true"]').forEach((element) => {
            element.addEventListener('click', closeNodeRenameDialog);
        });
        dialog.querySelector('#btn-confirm-node-rename')?.addEventListener('click', () => {
            renameNode(nodeId, input?.value ?? '');
            closeNodeRenameDialog();
        });
        input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') dialog.querySelector('#btn-confirm-node-rename')?.click();
        });
    }

    function openReferenceImageCountDialog(nodeId) {
        const node = state.nodes.get(nodeId);
        if (!node || !referenceImageNodeTypes.has(node.type)) return;
        const currentCount = normalizeReferenceImageCount(node.referenceImageCount ?? node.data?.referenceImageCount);
        const dialog = getReferenceImageCountDialog();
        dialog.innerHTML = `
            <div class="reference-image-count-backdrop" data-close-reference-image-count="true"></div>
            <div class="reference-image-count-panel" role="dialog" aria-modal="true" aria-labelledby="reference-image-count-title">
                <div class="reference-image-count-header">
                    <h3 id="reference-image-count-title">修改参考图数量</h3>
                    <button type="button" class="reference-image-count-close" data-close-reference-image-count="true" title="关闭">×</button>
                </div>
                <div class="reference-image-count-body">
                    <label for="reference-image-count-input">参考图数量</label>
                    <div class="reference-image-count-stepper">
                        <button type="button" class="reference-image-count-step" data-reference-image-count-delta="-1" title="减少" aria-label="减少参考图数量">−</button>
                        <input id="reference-image-count-input" type="number" min="0" max="${maxReferenceImageCount}" step="1" value="${currentCount}" />
                        <button type="button" class="reference-image-count-step" data-reference-image-count-delta="1" title="增加" aria-label="增加参考图数量">+</button>
                    </div>
                    <p>默认数字是 5，不建议设置超过 16 个参考图，参考图太多会导致稳定性下降，具体支持多少参考图需要看 API 供应商，设置过多可能会被忽略</p>
                </div>
                <div class="reference-image-count-footer">
                    <button type="button" class="btn btn-secondary" data-close-reference-image-count="true">取消</button>
                    <button type="button" class="btn btn-primary" id="btn-confirm-reference-image-count">确定</button>
                </div>
            </div>
        `;
        dialog.classList.remove('hidden');
        const input = dialog.querySelector('#reference-image-count-input');
        input?.focus();
        input?.select();
        dialog.querySelectorAll('[data-close-reference-image-count="true"]').forEach((element) => {
            element.addEventListener('click', closeReferenceImageCountDialog);
        });
        dialog.querySelector('#btn-confirm-reference-image-count')?.addEventListener('click', () => {
            const nextCount = normalizeReferenceImageCount(input?.value, currentCount);
            refreshReferenceImagePorts(nodeId, nextCount);
            closeReferenceImageCountDialog();
            showToast?.(`参考图数量已设置为 ${nextCount}`, 'success');
        });
        dialog.querySelectorAll('[data-reference-image-count-delta]').forEach((button) => {
            button.addEventListener('click', () => {
                const delta = parseInt(button.dataset.referenceImageCountDelta || '0', 10) || 0;
                const nextCount = normalizeReferenceImageCount((parseInt(input?.value || '0', 10) || 0) + delta, currentCount);
                if (input) input.value = String(nextCount);
            });
        });
        input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') dialog.querySelector('#btn-confirm-reference-image-count')?.click();
        });
    }

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
                if (nodeId) openNodeRenameDialog(nodeId);
                return;
            }

            if (item.id === 'context-menu-reference-image-count') {
                const nodeId = state.contextMenuNodeId;
                if (nodeId) openReferenceImageCountDialog(nodeId);
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

    function isPointInsideRect(clientX, clientY, rect) {
        if (!rect) return false;
        return (
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom
        );
    }

    function getToolbarOrSidebarHoverZoneTarget(event) {
        const target = event.target;
        const chromeTarget = target?.closest?.('#toolbar, #side-bar');
        if (!chromeTarget) return null;

        const canvasRect = canvasContainer?.getBoundingClientRect?.();
        if (!isPointInsideRect(event.clientX, event.clientY, canvasRect)) return null;

        const chromeRect = chromeTarget.getBoundingClientRect();
        if (isPointInsideRect(event.clientX, event.clientY, chromeRect)) return null;

        return chromeTarget;
    }

    function openCanvasContextMenu(event, target = event.target) {
        event.preventDefault();
        if (state.justCut) return;

        closeConnectionCreatePopup();
        state.contextMenu = { x: event.clientX, y: event.clientY };

        const nodeEl = target?.closest?.('.node');

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

        positionFloatingMenu(contextMenu, event.clientX, event.clientY);
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
            openCanvasContextMenu(e);
        });

        documentRef.addEventListener('contextmenu', (e) => {
            if (!getToolbarOrSidebarHoverZoneTarget(e)) return;
            e.stopPropagation();
            openCanvasContextMenu(e, canvasContainer);
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
                closeReferenceImageCountDialog();
                closeNodeRenameDialog();
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
