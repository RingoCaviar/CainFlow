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

        const requiredHeight = node.maxHeight
            ? Math.min(el.offsetHeight, node.maxHeight)
            : el.offsetHeight;
        const currentPx = parseFloat(originalHeight) || el.offsetHeight;
        const heightChanged = allowShrink
            ? Math.abs(requiredHeight - currentPx) > 2
            : requiredHeight > currentPx + 2;

        if (heightChanged) {
            el.style.height = requiredHeight + 'px';
            node.height = requiredHeight;
            updateAllConnections();
            scheduleSave();
        } else {
            el.style.height = originalHeight;
        }
        body.style.maxHeight = originalBodyMaxHeight;
    }

    function addNode(type, x, y, restoreData, silent = false) {
        if (!silent) pushHistory();
        const config = nodeConfigs[type];
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

        el.innerHTML = createNodeMarkup({ type, id, config, restoreData, state });
        nodesLayer.appendChild(el);

        if (restoreData && restoreData.height) {
            el.querySelectorAll('.preview-container, .save-preview-container, .file-drop-zone').forEach((container) => {
                container.style.maxHeight = 'none';
            });
        }

        const nodeData = {
            id,
            type,
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

        if (type === 'ImageImport' || type === 'ImagePreview' || type === 'ImageSave' || type === 'ImageResize' || type === 'ImageCompare') {
            (async () => {
                const isImportUrlMode = type === 'ImageImport' && nodeData.importMode === 'url';
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
                    return;
                }

                if (data) {
                    nodeData.imageData = data;
                    nodeData.data.image = data;

                    if (hasInitialData && !isRemoteImageUrl(data)) {
                        await saveImageAsset(id, data);
                    }

                    if (type === 'ImageImport') {
                        const dropZone = el.querySelector(`#${id}-drop`);
                        if (dropZone) {
                            dropZone.classList.add('has-image');
                            dropZone.innerHTML = `<img src="${data}" alt="已导入图片" draggable="false" style="pointer-events: none;" />`;
                        }
                        showResolutionBadge(id, data);
                        onConnectionsChanged();
                    } else if (type === 'ImagePreview') {
                        const previewContainer = el.querySelector(`#${id}-preview`);
                        if (previewContainer) {
                            previewContainer.innerHTML = `<img src="${data}" alt="预览" draggable="false" style="pointer-events: none;" />`;
                        }
                        const controls = el.querySelector(`#${id}-controls`);
                        if (controls) controls.style.display = 'flex';
                        showResolutionBadge(id, data);
                        onConnectionsChanged();
                    } else if (type === 'ImageSave') {
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
                    } else if (type === 'ImageResize') {
                        restoreImageResizePreview(id, data, {
                            outputWidth: restoreData?.outputWidth || 0,
                            outputHeight: restoreData?.outputHeight || 0,
                            outputQuality: restoreData?.outputQuality || null,
                            estimatedBytes: restoreData?.estimatedBytes || null
                        });
                        onConnectionsChanged();
                    } else if (type === 'ImageCompare') {
                        nodeData.compareImageB = data;
                        const compareContainer = el.querySelector(`#${id}-compare`);
                        if (compareContainer) {
                            compareContainer.classList.add('has-images');
                            compareContainer.innerHTML = `<img class="image-compare-img image-compare-b" src="${data}" alt="B 输入图片" draggable="false" />`;
                        }
                        showResolutionBadge(id, data);
                        onConnectionsChanged();
                    }
                }
            })();
        }

        bindNodeInteractions({ id, type, el });

        if (!restoreData && !silent) showToast(`已添加「${config.title}」节点`, 'success');
        if (!restoreData) scheduleSave();
        return id;
    }

    function removeNode(id) {
        pushHistory();
        const idsToRemove = state.selectedNodes.has(id) ? Array.from(state.selectedNodes) : [id];
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
            node.el.remove();
            state.nodes.delete(nid);
            state.selectedNodes.delete(nid);
            deleteImageAsset(nid);
        });
        updateAllConnections();
        updatePortStyles();
        if (removedConnections) onConnectionsChanged();
        showToast(idsToRemove.length > 1 ? `已删除 ${idsToRemove.length} 个节点` : '节点已删除', 'info');
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
        selectNode,
        toggleNodesEnabled
    };
}
