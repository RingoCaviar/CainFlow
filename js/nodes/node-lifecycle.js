/**
 * 管理节点的创建、删除、选择、启停与尺寸自适应等生命周期行为。
 */
export function createNodeLifecycleApi({
    state,
    nodeConfigs,
    createNodeMarkup,
    nodesLayer,
    generateId,
    getImageAsset,
    saveImageAsset,
    deleteImageAsset,
    showResolutionBadge,
    restoreImageResizePreview,
    bindNodeInteractions,
    pushHistory,
    scheduleSave,
    showToast,
    updateAllConnections,
    updatePortStyles,
    onConnectionsChanged = () => {},
    getCacheSidebarActive,
    updateCacheUsage,
    documentRef = document
}) {
    const view = documentRef.defaultView || window;
    let pendingNodeSizeConnectionRefresh = null;

    function scheduleNodeSizeConnectionRefresh() {
        if (pendingNodeSizeConnectionRefresh !== null) return;
        const requestFrame = view.requestAnimationFrame || ((callback) => view.setTimeout(callback, 16));
        pendingNodeSizeConnectionRefresh = requestFrame(() => {
            pendingNodeSizeConnectionRefresh = null;
            updateAllConnections();
        });
    }

    function readObservedNodeSize(entry, el) {
        const borderSize = Array.isArray(entry.borderBoxSize)
            ? entry.borderBoxSize[0]
            : entry.borderBoxSize;
        const width = borderSize?.inlineSize || el.offsetWidth || entry.contentRect?.width || 0;
        const height = borderSize?.blockSize || el.offsetHeight || entry.contentRect?.height || 0;
        return {
            width: Math.round(width),
            height: Math.round(height)
        };
    }

    function bindNodeSizeObserver(nodeData) {
        const ResizeObserverCtor = view.ResizeObserver;
        if (!ResizeObserverCtor || !nodeData?.el) return;

        nodeData.observedWidth = nodeData.el.offsetWidth || Number(nodeData.width) || 0;
        nodeData.observedHeight = nodeData.el.offsetHeight || Number(nodeData.height) || 0;

        const observer = new ResizeObserverCtor((entries) => {
            const entry = entries[0];
            if (!entry || !state.nodes.has(nodeData.id)) return;

            const { width, height } = readObservedNodeSize(entry, nodeData.el);
            const widthChanged = Math.abs(width - (nodeData.observedWidth || 0)) > 1;
            const heightChanged = Math.abs(height - (nodeData.observedHeight || 0)) > 1;
            if (!widthChanged && !heightChanged) return;

            nodeData.observedWidth = width;
            nodeData.observedHeight = height;
            if (width > 0) nodeData.width = width;
            if (height > 0) nodeData.height = height;
            scheduleNodeSizeConnectionRefresh();
        });

        try {
            observer.observe(nodeData.el, { box: 'border-box' });
        } catch {
            observer.observe(nodeData.el);
        }
        nodeData.sizeObserver = observer;
    }

    function disconnectNodeSizeObserver(nodeData) {
        if (nodeData?.sizeObserver) {
            nodeData.sizeObserver.disconnect();
            nodeData.sizeObserver = null;
        }
    }

    function isRemoteImageUrl(value) {
        return typeof value === 'string' && /^https?:\/\//i.test(value);
    }

    function clampNodeHeight(height, config, options = {}) {
        if (!Number.isFinite(height) || height <= 0) return null;
        const { isRestore = false } = options;
        if (isRestore) {
            const restoreHeightCap = Number(config?.restoreHeightCap);
            if (Number.isFinite(restoreHeightCap) && restoreHeightCap > 0 && height > restoreHeightCap) {
                const restoreHeightFallback = Number(config?.restoreHeightFallback);
                if (Number.isFinite(restoreHeightFallback) && restoreHeightFallback > 0) {
                    return restoreHeightFallback;
                }
                return restoreHeightCap;
            }
        }
        const maxHeight = Number(config?.maxHeight);
        if (Number.isFinite(maxHeight) && maxHeight > 0) {
            return Math.min(height, maxHeight);
        }
        return height;
    }

    function getPx(style, property) {
        const value = parseFloat(style?.getPropertyValue?.(property) || '0');
        return Number.isFinite(value) ? value : 0;
    }

    function getOuterHeight(el) {
        if (!el || el.offsetParent === null) return 0;
        const style = getComputedStyle(el);
        if (style.position === 'absolute') return 0;
        return Math.ceil(el.offsetHeight + getPx(style, 'margin-top') + getPx(style, 'margin-bottom'));
    }

    function getOuterWidth(el) {
        if (!el || el.offsetParent === null) return 0;
        const style = getComputedStyle(el);
        if (style.position === 'absolute') return 0;
        return Math.ceil(el.offsetWidth + getPx(style, 'margin-left') + getPx(style, 'margin-right'));
    }

    function getNonTextareaRequiredChildHeight(child) {
        if (!child || child.offsetParent === null) return 0;
        if (child.querySelector?.('textarea')) return getOuterHeight(child);

        const style = getComputedStyle(child);
        const marginY = getPx(style, 'margin-top') + getPx(style, 'margin-bottom');
        return Math.ceil(Math.max(child.offsetHeight || 0, child.scrollHeight || 0) + marginY);
    }

    function getNonTextareaRequiredChildWidth(child) {
        if (!child || child.offsetParent === null) return 0;
        const style = getComputedStyle(child);
        const marginX = getPx(style, 'margin-left') + getPx(style, 'margin-right');
        const minWidth = getPx(style, 'min-width');
        return Math.ceil(Math.max(child.offsetWidth || 0, child.scrollWidth || 0, minWidth) + marginX);
    }

    function getNonTextareaRequiredNodeSize(el, body) {
        const originalHeight = el.style.height;
        const originalBodyMaxHeight = body.style.maxHeight;
        const originalBodyOverflowY = body.style.overflowY;

        el.style.height = 'auto';
        body.style.maxHeight = 'none';
        body.style.overflowY = 'visible';

        const bodyStyle = getComputedStyle(body);
        const bodyPaddingX = getPx(bodyStyle, 'padding-left') + getPx(bodyStyle, 'padding-right');
        const bodyPaddingY = getPx(bodyStyle, 'padding-top') + getPx(bodyStyle, 'padding-bottom');
        const bodyGap = getPx(bodyStyle, 'row-gap') || getPx(bodyStyle, 'gap');
        let bodyHeight = bodyPaddingY;
        let bodyWidth = 0;
        let visibleBodyChildren = 0;

        Array.from(body.children).forEach((child) => {
            if (child.offsetParent === null) return;
            visibleBodyChildren += 1;
            bodyHeight += getNonTextareaRequiredChildHeight(child);
            bodyWidth = Math.max(bodyWidth, getNonTextareaRequiredChildWidth(child));
        });

        bodyHeight += Math.max(0, visibleBodyChildren - 1) * bodyGap;

        let chromeHeight = 0;
        let chromeWidth = 0;
        Array.from(el.children).forEach((child) => {
            if (child === body) return;
            chromeHeight += getOuterHeight(child);
            chromeWidth = Math.max(chromeWidth, getOuterWidth(child));
        });

        const requiredSize = {
            width: Math.ceil(Math.max(chromeWidth, bodyWidth + bodyPaddingX)),
            height: Math.ceil(chromeHeight + bodyHeight)
        };

        el.style.height = originalHeight;
        body.style.maxHeight = originalBodyMaxHeight;
        body.style.overflowY = originalBodyOverflowY;
        return requiredSize;
    }

    function getTextNodeRequiredHeight(el, body) {
        const textarea = body.querySelector('.node-field-expand textarea');
        if (!textarea) return null;

        const bodyStyle = getComputedStyle(body);
        const bodyPaddingY = getPx(bodyStyle, 'padding-top') + getPx(bodyStyle, 'padding-bottom');
        const bodyGap = getPx(bodyStyle, 'row-gap') || getPx(bodyStyle, 'gap');
        const textareaStyle = getComputedStyle(textarea);
        const textareaMinHeight = getPx(textareaStyle, 'min-height');
        const previousTextareaHeight = textarea.style.height;
        const previousTextareaFlex = textarea.style.flex;
        textarea.style.height = 'auto';
        textarea.style.flex = '0 0 auto';
        const textareaHeight = Math.max(textareaMinHeight, textarea.scrollHeight);
        textarea.style.height = previousTextareaHeight;
        textarea.style.flex = previousTextareaFlex;
        let bodyHeight = bodyPaddingY;
        let visibleBodyChildren = 0;

        Array.from(body.children).forEach((child) => {
            if (child.offsetParent === null) return;
            visibleBodyChildren += 1;

            if (child.classList.contains('node-field') && child.contains(textarea)) {
                const childStyle = getComputedStyle(child);
                const label = child.querySelector(':scope > label');
                const fieldGap = getPx(childStyle, 'row-gap') || getPx(childStyle, 'gap');
                bodyHeight += (label?.offsetHeight || 0) + (label ? fieldGap : 0) + textareaHeight;
                return;
            }

            bodyHeight += child.scrollHeight || child.offsetHeight || 0;
        });

        bodyHeight += Math.max(0, visibleBodyChildren - 1) * bodyGap;

        const chromeHeight = Array.from(el.children).reduce((total, child) => {
            return child === body ? total : total + getOuterHeight(child);
        }, 0);

        return Math.ceil(chromeHeight + bodyHeight);
    }

    function fitNodeToContent(nodeId, options = {}) {
        const node = state.nodes.get(nodeId);
        if (!node || !node.el) return;
        const { allowShrink = false } = options;

        const el = node.el;
        const body = el.querySelector('.node-body');
        if (!body) return;

        const originalHeight = el.style.height;
        const originalBodyMaxHeight = body.style.maxHeight;

        el.style.height = 'auto';
        body.style.maxHeight = 'none';

        const textNodeRequiredHeight = node.type === 'Text' ? getTextNodeRequiredHeight(el, body) : null;
        const rawRequiredHeight = Number.isFinite(textNodeRequiredHeight) && textNodeRequiredHeight > 0
            ? textNodeRequiredHeight
            : el.offsetHeight;
        const requiredHeight = node.maxHeight
            ? Math.min(rawRequiredHeight, node.maxHeight)
            : rawRequiredHeight;
        const currentPx = parseFloat(originalHeight) || el.offsetHeight;
        const heightChanged = allowShrink
            ? Math.abs(requiredHeight - currentPx) > 2
            : requiredHeight > currentPx + 2;

        if (heightChanged) {
            el.style.height = requiredHeight + 'px';
            node.height = requiredHeight;
            node.observedWidth = el.offsetWidth || Number(node.width) || 0;
            node.observedHeight = requiredHeight;
            updateAllConnections();
            scheduleSave();
        } else {
            el.style.height = originalHeight;
        }
        body.style.maxHeight = originalBodyMaxHeight;
    }

    function ensureNodeContentVisible(nodeId, options = {}) {
        const node = state.nodes.get(nodeId);
        if (!node || !node.el) return;

        const el = node.el;
        const body = el.querySelector('.node-body');
        if (!body) return;

        const requiredSize = getNonTextareaRequiredNodeSize(el, body);
        const currentWidth = el.offsetWidth || Number(node.width) || 0;
        const currentHeight = el.offsetHeight || Number(node.height) || 0;
        const nextWidth = Math.max(currentWidth, requiredSize.width);
        const nextHeight = Math.max(currentHeight, requiredSize.height);
        const widthChanged = nextWidth > currentWidth + 2;
        const heightChanged = nextHeight > currentHeight + 2;

        if (!widthChanged && !heightChanged) return;

        if (widthChanged) {
            el.style.width = nextWidth + 'px';
            node.width = nextWidth;
            node.observedWidth = nextWidth;
        }
        if (heightChanged) {
            el.style.height = nextHeight + 'px';
            node.height = nextHeight;
            node.observedHeight = nextHeight;
        }

        updateAllConnections();
        if (options.save !== false) scheduleSave();
    }

    function scheduleEnsureNodeContentVisible(nodeId, options = {}) {
        const requestFrame = view.requestAnimationFrame || ((callback) => view.setTimeout(callback, 16));
        requestFrame(() => {
            ensureNodeContentVisible(nodeId, options);
        });
    }

    function normalizeNodeType(type) {
        if (type === 'TextInput' || type === 'TextDisplay') return 'Text';
        return type;
    }

    function addNode(type, x, y, restoreData, silent = false) {
        if (!silent) pushHistory();
        const normalizedType = normalizeNodeType(type);
        const config = nodeConfigs[normalizedType];
        if (!config) return;
        const id = restoreData?.id ? restoreData.id : generateId();
        const el = documentRef.createElement('div');
        el.className = `node ${config.cssClass}`;
        el.id = id;
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        if (restoreData && restoreData.width) el.style.width = restoreData.width + 'px';
        else if (config.defaultWidth) el.style.width = config.defaultWidth + 'px';

        const initialHeight = clampNodeHeight(
            restoreData?.height || config.defaultHeight || null,
            config,
            { isRestore: Boolean(restoreData?.height) }
        );
        if (initialHeight) el.style.height = initialHeight + 'px';

        el.innerHTML = createNodeMarkup({ type: normalizedType, id, config, restoreData, state });
        nodesLayer.appendChild(el);

        if (restoreData && restoreData.height) {
            el.querySelectorAll('.preview-container, .save-preview-container, .file-drop-zone').forEach((container) => {
                container.style.maxHeight = 'none';
            });
        }

        const nodeData = {
            id,
            type: normalizedType,
            x,
            y,
            el,
            data: {},
            imageData: null,
            compareImageA: null,
            compareImageB: null,
            importMode: restoreData?.importMode === 'url' ? 'url' : 'upload',
            imageUrl: restoreData?.imageUrl || '',
            previewZoom: 1,
            resizePreviewData: null,
            resizePreviewMeta: null,
            resizePreviewToken: 0,
            width: restoreData?.width || config.defaultWidth || null,
            height: initialHeight,
            maxHeight: config.maxHeight || null,
            dirHandle: null,
            enabled: restoreData?.enabled !== false,
            isSucceeded: restoreData?.isSucceeded || false,
            lastDuration: restoreData?.lastDuration || null,
            lastResponse: restoreData?.lastResponse || '',
            originalWidth: restoreData?.originalWidth || 0,
            originalHeight: restoreData?.originalHeight || 0,
            outputWidth: restoreData?.outputWidth || 0,
            outputHeight: restoreData?.outputHeight || 0,
            outputFormat: restoreData?.outputFormat || '',
            outputQuality: restoreData?.outputQuality || null,
            estimatedBytes: restoreData?.estimatedBytes || null
        };
        if (nodeData.lastDuration) {
            const timeBadge = el.querySelector(`#${id}-time`);
            const timeContainer = el.querySelector(`#${id}-time-container`);
            if (timeBadge && timeContainer) {
                timeBadge.textContent = `${nodeData.lastDuration}s`;
                timeContainer.style.display = 'flex';
            }
        }
        if (restoreData?.lastText) {
            nodeData.data.text = restoreData.lastText;
        }
        if (nodeData.isSucceeded) el.classList.add('completed');
        if (!nodeData.enabled) el.classList.add('disabled');
        state.nodes.set(id, nodeData);
        el.addEventListener('load', (event) => {
            if (event.target?.tagName === 'IMG') {
                scheduleEnsureNodeContentVisible(id);
            }
        }, true);
        bindNodeSizeObserver(nodeData);

        if (normalizedType === 'ImageImport' || normalizedType === 'ImagePreview' || normalizedType === 'ImageSave' || normalizedType === 'ImageResize' || normalizedType === 'ImageCompare') {
            (async () => {
                const isImportUrlMode = normalizedType === 'ImageImport' && nodeData.importMode === 'url';
                const hasInitialData = !!(restoreData && restoreData.imageData);
                const data = isImportUrlMode
                    ? null
                    : (hasInitialData ? restoreData.imageData : await getImageAsset(id));

                if (!state.nodes.has(id)) return;

                if (isImportUrlMode && nodeData.imageUrl) {
                    nodeData.imageData = null;
                    nodeData.data.image = nodeData.imageUrl;
                    const urlInput = el.querySelector(`#${id}-url-input`);
                    if (urlInput) urlInput.value = nodeData.imageUrl;
                    onConnectionsChanged();
                    scheduleEnsureNodeContentVisible(id);
                    return;
                }

                if (data) {
                    nodeData.imageData = data;
                    nodeData.data.image = data;

                    if (hasInitialData && !isRemoteImageUrl(data)) {
                        await saveImageAsset(id, data);
                    }

                    if (normalizedType === 'ImageImport') {
                        const dropZone = el.querySelector(`#${id}-drop`);
                        if (dropZone) {
                            dropZone.classList.add('has-image');
                            dropZone.innerHTML = `<img src="${data}" alt="已导入图片" draggable="false" style="pointer-events: none;" />`;
                        }
                        showResolutionBadge(id, data);
                        onConnectionsChanged();
                    } else if (normalizedType === 'ImagePreview') {
                        const previewContainer = el.querySelector(`#${id}-preview`);
                        if (previewContainer) {
                            previewContainer.innerHTML = `<img src="${data}" alt="预览" draggable="false" style="pointer-events: none;" />`;
                        }
                        const controls = el.querySelector(`#${id}-controls`);
                        if (controls) controls.style.display = 'flex';
                        showResolutionBadge(id, data);
                        onConnectionsChanged();
                    } else if (normalizedType === 'ImageSave') {
                        const savePreview = el.querySelector(`#${id}-save-preview`);
                        if (savePreview) {
                            savePreview.innerHTML = `<img src="${data}" alt="待保存" draggable="false" style="pointer-events: none;" />`;
                        }
                        const manualSaveBtn = el.querySelector(`#${id}-manual-save`);
                        const viewFullBtn = el.querySelector(`#${id}-view-full`);
                        if (manualSaveBtn) manualSaveBtn.disabled = false;
                        if (viewFullBtn) viewFullBtn.disabled = false;
                        showResolutionBadge(id, data);
                        onConnectionsChanged();
                    } else if (normalizedType === 'ImageResize') {
                        restoreImageResizePreview(id, data, {
                            outputWidth: restoreData?.outputWidth || 0,
                            outputHeight: restoreData?.outputHeight || 0,
                            outputQuality: restoreData?.outputQuality || null,
                            estimatedBytes: restoreData?.estimatedBytes || null
                        });
                        onConnectionsChanged();
                    } else if (normalizedType === 'ImageCompare') {
                        nodeData.compareImageB = data;
                        const compareContainer = el.querySelector(`#${id}-compare`);
                        if (compareContainer) {
                            compareContainer.classList.add('has-images');
                            compareContainer.innerHTML = `<img class="image-compare-img image-compare-b" src="${data}" alt="B 输入图片" draggable="false" />`;
                        }
                        showResolutionBadge(id, data);
                        onConnectionsChanged();
                    }
                    scheduleEnsureNodeContentVisible(id);
                }
            })();
        }

        bindNodeInteractions({ id, type: normalizedType, el });
        scheduleEnsureNodeContentVisible(id);

        if (!restoreData && !silent) showToast(`已添加「${config.title}」节点`, 'success');
        if (!restoreData) scheduleSave();
        return id;
    }

    function createConnectionId() {
        return 'c_' + Math.random().toString(36).substr(2, 9);
    }

    function getPortDataType(nodeId, portName, direction) {
        const node = state.nodes.get(nodeId);
        const port = node?.el?.querySelector(`.node-port[data-port="${portName}"][data-direction="${direction}"]`);
        return port?.dataset?.type || '';
    }

    function getConnectionDataType(connection) {
        return connection.type ||
            getPortDataType(connection.from.nodeId, connection.from.port, 'output') ||
            getPortDataType(connection.to.nodeId, connection.to.port, 'input') ||
            '';
    }

    function buildPreservedConnections(idsToRemove) {
        const removeSet = new Set(idsToRemove);
        const candidates = [];

        idsToRemove.forEach((nid) => {
            const incoming = state.connections.filter((connection) => (
                connection.to.nodeId === nid &&
                !removeSet.has(connection.from.nodeId)
            ));
            const outgoing = state.connections.filter((connection) => (
                connection.from.nodeId === nid &&
                !removeSet.has(connection.to.nodeId)
            ));

            incoming.forEach((inConn) => {
                const inputType = getConnectionDataType(inConn);
                outgoing.forEach((outConn) => {
                    const outputType = getConnectionDataType(outConn);
                    if (!inputType || inputType !== outputType) return;
                    if (inConn.from.nodeId === outConn.to.nodeId) return;

                    candidates.push({
                        from: { nodeId: inConn.from.nodeId, port: inConn.from.port },
                        to: { nodeId: outConn.to.nodeId, port: outConn.to.port },
                        type: inputType
                    });
                });
            });
        });

        return candidates;
    }

    function appendPreservedConnections(candidates) {
        let added = 0;
        candidates.forEach((candidate) => {
            const hasSameConnection = state.connections.some((connection) => (
                connection.from.nodeId === candidate.from.nodeId &&
                connection.from.port === candidate.from.port &&
                connection.to.nodeId === candidate.to.nodeId &&
                connection.to.port === candidate.to.port
            ));
            const hasInputConnection = state.connections.some((connection) => (
                connection.to.nodeId === candidate.to.nodeId &&
                connection.to.port === candidate.to.port
            ));
            if (hasSameConnection || hasInputConnection) return;

            state.connections.push({
                id: createConnectionId(),
                from: candidate.from,
                to: candidate.to,
                type: candidate.type
            });
            added += 1;
        });
        return added;
    }

    function detachNodesFromConnections(idsToDetach, options = {}) {
        const ids = Array.from(new Set(Array.isArray(idsToDetach) ? idsToDetach : [idsToDetach]))
            .filter((nid) => state.nodes.has(nid));
        if (!ids.length) return { changed: false, removedConnectionCount: 0, preservedConnectionCount: 0 };

        const detachSet = new Set(ids);
        const preservedConnectionCandidates = buildPreservedConnections(ids);
        const before = state.connections.length;
        state.connections = state.connections.filter((connection) => (
            !detachSet.has(connection.from.nodeId) &&
            !detachSet.has(connection.to.nodeId)
        ));

        const removedConnectionCount = before - state.connections.length;
        const preservedConnectionCount = appendPreservedConnections(preservedConnectionCandidates);
        const changed = removedConnectionCount > 0 || preservedConnectionCount > 0;

        if (!changed) return { changed: false, removedConnectionCount, preservedConnectionCount };

        updateAllConnections();
        updatePortStyles();
        onConnectionsChanged();
        if (options.save !== false) scheduleSave();
        if (options.showToast !== false) {
            showToast(preservedConnectionCount > 0
                ? `节点已摘取，已保留 ${preservedConnectionCount} 条连线`
                : '节点已从连线中摘取', 'info');
        }

        return { changed, removedConnectionCount, preservedConnectionCount };
    }

    function removeNode(id, options = {}) {
        pushHistory();
        const idsToRemove = state.selectedNodes.has(id) ? Array.from(state.selectedNodes) : [id];
        const preservedConnectionCandidates = options.preserveConnections
            ? buildPreservedConnections(idsToRemove)
            : [];
        let removedConnections = false;
        idsToRemove.forEach((nid) => {
            const node = state.nodes.get(nid);
            if (!node) return;
            const before = state.connections.length;
            state.connections = state.connections.filter((connection) => connection.from.nodeId !== nid && connection.to.nodeId !== nid);
            if (state.connections.length !== before) removedConnections = true;
            node.el.querySelectorAll('textarea').forEach((textarea) => {
                if (Array.isArray(textarea._cleanupFns)) {
                    textarea._cleanupFns.forEach((cleanup) => {
                        if (typeof cleanup === 'function') cleanup();
                    });
                    textarea._cleanupFns = [];
                }
            });
            disconnectNodeSizeObserver(node);
            node.el.remove();
            state.nodes.delete(nid);
            state.selectedNodes.delete(nid);
            deleteImageAsset(nid);
        });
        const preservedConnectionCount = appendPreservedConnections(preservedConnectionCandidates);
        if (preservedConnectionCount > 0) removedConnections = true;
        updateAllConnections();
        updatePortStyles();
        if (removedConnections) onConnectionsChanged();
        if (preservedConnectionCount > 0) {
            showToast(idsToRemove.length > 1
                ? `已删除 ${idsToRemove.length} 个节点，已保留 ${preservedConnectionCount} 条连线`
                : '节点已删除，连线已保留', 'info');
        } else {
            showToast(idsToRemove.length > 1 ? `已删除 ${idsToRemove.length} 个节点` : '节点已删除', 'info');
        }
        scheduleSave();
        if (getCacheSidebarActive()) {
            updateCacheUsage();
        }
    }

    function selectNode(id, isMulti) {
        if (!isMulti) {
            state.selectedNodes.forEach((nid) => {
                const node = state.nodes.get(nid);
                if (node) node.el.classList.remove('selected');
            });
            state.selectedNodes.clear();
        }

        if (state.selectedNodes.has(id)) {
            state.selectedNodes.delete(id);
            const node = state.nodes.get(id);
            if (node) node.el.classList.remove('selected');
        } else {
            state.selectedNodes.add(id);
            const node = state.nodes.get(id);
            if (node) node.el.classList.add('selected');
        }
        updateAllConnections();
    }

    function toggleNodesEnabled(nodeIds, referenceNodeId = null) {
        if (!nodeIds || nodeIds.length === 0) return;

        const refId = referenceNodeId || nodeIds[0];
        const refNode = state.nodes.get(refId);
        if (!refNode) return;

        const targetState = !refNode.enabled;

        nodeIds.forEach((nid) => {
            const nodeData = state.nodes.get(nid);
            if (nodeData) {
                nodeData.enabled = targetState;
                nodeData.el.classList.toggle('disabled', !targetState);
                if (targetState) {
                    nodeData.el.classList.remove('completed', 'error', 'running');
                    const timeBadge = documentRef.getElementById(`${nid}-time`);
                    if (timeBadge && timeBadge.textContent === 'Skip') timeBadge.textContent = '';
                }
            }
        });

        showToast(targetState ? `已启用 ${nodeIds.length} 个节点` : `已禁用 ${nodeIds.length} 个节点`, 'info');
        scheduleSave();
    }

    return {
        fitNodeToContent,
        addNode,
        removeNode,
        detachNodesFromConnections,
        selectNode,
        toggleNodesEnabled
    };
}
