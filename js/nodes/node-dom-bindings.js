/**
 * 负责把节点 DOM 与交互行为绑定起来，包括拖拽、输入监听、按钮操作和端口事件。
 */
export function createNodeDomBindingsApi({
    state,
    canvasContainer,
    connectionsGroup,
    tempConnection,
    viewportApi,
    getPortPosition,
    pushHistory,
    removeNode,
    selectNode,
    toggleNodesEnabled,
    finishConnection,
    setupImageImport,
    setupImageResize,
    setupImageSave,
    setupImagePreview,
    copyToClipboard,
    showToast,
    scheduleSave,
    debounce,
    adjustTextareaHeight,
    fitNodeToContent = () => {},
    documentRef = document
}) {
    function syncTextInputNodeData(id) {
        const node = state.nodes.get(id);
        const textarea = documentRef.getElementById(`${id}-text`);
        if (!node || !textarea) return;
        node.data.text = textarea.value;
    }

    function bindExpandableTextareaResize(nodeId, textarea) {
        if (!textarea || typeof ResizeObserver === 'undefined') return;

        let frameId = null;
        const scheduleFit = () => {
            if (frameId !== null) return;
            frameId = requestAnimationFrame(() => {
                frameId = null;
                fitNodeToContent(nodeId, { allowShrink: true });
            });
        };

        const observer = new ResizeObserver(() => scheduleFit());
        observer.observe(textarea);

        textarea.addEventListener('mouseup', scheduleFit);
        textarea.addEventListener('touchend', scheduleFit);

        if (!Array.isArray(textarea._cleanupFns)) {
            textarea._cleanupFns = [];
        }
        textarea._cleanupFns.push(() => {
            observer.disconnect();
            textarea.removeEventListener('mouseup', scheduleFit);
            textarea.removeEventListener('touchend', scheduleFit);
            if (frameId !== null) cancelAnimationFrame(frameId);
        });

        setTimeout(scheduleFit, 0);
    }

    function bindNodeInteractions({ id, type, el }) {
        el.addEventListener('mousedown', (e) => {
            const target = e.target;

            if (target.closest('.node-delete, .node-bypass-btn')) return;

            const interactiveSelector = 'input, textarea, select, button, .port, .node-resize-handle, [contenteditable="true"], .chat-response-area, .preview-controls, .workflow-action-btn';
            const isInteractive = target.closest(interactiveSelector);

            const dragAreaSelector = '.file-drop-zone, .preview-container, .save-preview-container, .node-header, .node-glass-bg';
            const isForceDrag = target.matches(dragAreaSelector) || (target.parentElement && target.parentElement.matches(dragAreaSelector));

            if (isInteractive && !isForceDrag) return;

            canvasContainer.focus();

            const isPanAction = e.button === 1 || (e.button === 0 && e.altKey);
            if (isPanAction) return;

            e.preventDefault();
            e.stopPropagation();

            const pos = viewportApi.screenToCanvas(e.clientX, e.clientY);
            const isMulti = e.ctrlKey || e.metaKey;

            if (!state.selectedNodes.has(id)) {
                selectNode(id, isMulti);
            }

            const nodesToDrag = Array.from(state.selectedNodes);
            const startPositions = new Map();
            const draggedNodeIds = new Set(nodesToDrag);

            nodesToDrag.forEach((nid) => {
                const node = state.nodes.get(nid);
                if (node) {
                    startPositions.set(nid, { x: node.x, y: node.y });
                    node.el.classList.add('is-interacting');
                }
            });

            const portOffsets = new Map();
            const connectionsToUpdate = [];

            for (const conn of state.connections) {
                const isFromDragged = draggedNodeIds.has(conn.from.nodeId);
                const isToDragged = draggedNodeIds.has(conn.to.nodeId);
                if (isFromDragged || isToDragged) {
                    const pathEl = connectionsGroup.querySelector(`path[data-conn-id="${conn.id}"]`);
                    if (pathEl) {
                        connectionsToUpdate.push({ conn, pathEl });
                        [{ p: conn.from, d: 'output' }, { p: conn.to, d: 'input' }].forEach((item) => {
                            const key = `${item.p.nodeId}-${item.p.port}-${item.d}`;
                            if (!portOffsets.has(key)) {
                                const pos = getPortPosition(item.p.nodeId, item.p.port, item.d);
                                const node = state.nodes.get(item.p.nodeId);
                                if (node) portOffsets.set(key, { dx: pos.x - node.x, dy: pos.y - node.y });
                            }
                        });
                    }
                }
            }

            state.dragging = {
                nodes: nodesToDrag,
                startX: pos.x,
                startY: pos.y,
                startPositions,
                portOffsets,
                connectionsToUpdate,
                isCloneDrag: e.ctrlKey || e.metaKey,
                cloned: false
            };

            pushHistory();
            documentRef.body.classList.add('is-interacting');
            documentRef.getElementById('connections-group').classList.add('is-interacting');
        });

        el.querySelector('.node-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            removeNode(id);
        });

        el.querySelector('.node-bypass-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const nodesToUpdate = state.selectedNodes.has(id) ? Array.from(state.selectedNodes) : [id];
            toggleNodesEnabled(nodesToUpdate, id);
        });

        el.querySelector('.node-resize-handle').addEventListener('mousedown', (e) => {
            const isPanAction = e.button === 1 || (e.button === 0 && e.altKey);
            if (isPanAction) return;
            e.stopPropagation();
            e.preventDefault();
            const header = el.querySelector('.node-header');
            const headerMinWidth = header ? Math.ceil(header.getBoundingClientRect().width) : 180;
            const minWidth = Math.max(180, Math.min(headerMinWidth, 240));
            const minHeight = Math.max(120, Math.min(el.offsetHeight, 160));
            const node = state.nodes.get(id);

            state.resizing = {
                nodeId: id,
                startX: e.clientX,
                startY: e.clientY,
                startWidth: el.offsetWidth,
                startHeight: el.offsetHeight,
                minWidth,
                minHeight,
                maxHeight: node?.maxHeight || null
            };

            pushHistory();
            el.classList.add('is-interacting');
            documentRef.body.classList.add('is-interacting');
            documentRef.getElementById('connections-group').classList.add('is-interacting');
        });

        el.querySelectorAll('.node-port').forEach((portEl) => {
            const dot = portEl.querySelector('.port-dot');
            dot.addEventListener('mousedown', (e) => {
                const isPanAction = e.button === 1 || (e.button === 0 && e.altKey);
                if (isPanAction) return;
                e.stopPropagation();
                e.preventDefault();

                const tgt = {
                    nodeId: portEl.dataset.nodeId,
                    port: portEl.dataset.port,
                    type: portEl.dataset.type,
                    dir: portEl.dataset.direction
                };

                if (state.connecting) {
                    if (finishConnection(state.connecting, tgt)) {
                        state.connecting = null;
                        tempConnection.setAttribute('d', '');
                    }
                    return;
                }

                const dotRect = dot.getBoundingClientRect();
                const containerRect = canvasContainer.getBoundingClientRect();
                const { x: cx, y: cy, zoom } = state.canvas;
                state.connecting = {
                    nodeId: portEl.dataset.nodeId,
                    portName: portEl.dataset.port,
                    dataType: portEl.dataset.type,
                    isOutput: portEl.dataset.direction === 'output',
                    startX: (dotRect.left + dotRect.width / 2 - containerRect.left - cx) / zoom,
                    startY: (dotRect.top + dotRect.height / 2 - containerRect.top - cy) / zoom,
                    screenX: e.clientX,
                    screenY: e.clientY,
                    dragged: false
                };
                documentRef.body.classList.add('is-interacting');
            });

            dot.addEventListener('mouseup', (e) => {
                if (!state.connecting) return;
                e.stopPropagation();

                const src = state.connecting;
                const tgt = {
                    nodeId: portEl.dataset.nodeId,
                    port: portEl.dataset.port,
                    type: portEl.dataset.type,
                    dir: portEl.dataset.direction
                };

                if (src.nodeId !== tgt.nodeId || src.portName !== tgt.port) {
                    if (finishConnection(src, tgt)) {
                        state.connecting = null;
                        tempConnection.setAttribute('d', '');
                    }
                } else if (src.dragged) {
                    state.connecting = null;
                    tempConnection.setAttribute('d', '');
                }
            });
        });

        if (type === 'ImageImport') setupImageImport(id, el);
        else if (type === 'ImageResize') setupImageResize(id, el);
        else if (type === 'ImageSave') setupImageSave(id, el);
        else if (type === 'ImagePreview') setupImagePreview(id, el);
        else if (type === 'TextChat') {
            const copyBtn = el.querySelector(`#${id}-copy-btn`);
            if (copyBtn) {
                copyBtn.onclick = () => {
                    const area = el.querySelector(`#${id}-response`);
                    if (area && !area.querySelector('.chat-response-placeholder')) {
                        copyToClipboard(area.innerText);
                    } else {
                        showToast('暂无内容可复制', 'warning');
                    }
                };
            }
        } else if (type === 'TextInput') {
            syncTextInputNodeData(id);
        }

        el.querySelectorAll('input, select, textarea').forEach((input) => {
            input.addEventListener('change', () => scheduleSave());
            input.addEventListener('input', debounce(() => scheduleSave(), 500));

            if (type === 'TextInput' && input.id === `${id}-text`) {
                input.addEventListener('input', () => syncTextInputNodeData(id));
                input.addEventListener('change', () => syncTextInputNodeData(id));
            }

            const isExpandable = input.closest('.node-field-expand');
            if (input.tagName === 'TEXTAREA' && !isExpandable) {
                input.addEventListener('input', () => adjustTextareaHeight(input));
                setTimeout(() => adjustTextareaHeight(input), 0);
            } else if (input.tagName === 'TEXTAREA' && isExpandable) {
                bindExpandableTextareaResize(id, input);
            }
        });
    }

    return {
        bindNodeInteractions
    };
}
