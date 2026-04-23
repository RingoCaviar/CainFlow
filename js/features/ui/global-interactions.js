/**
 * 处理跨组件的全局交互事件，例如拖拽导图、全局粘贴与 Escape 快捷操作。
 */
export function createGlobalInteractionsApi({
    state,
    settingsModal,
    canvasContainer,
    viewportApi,
    loadImageFile,
    addNode,
    pasteNode,
    toggleNodesEnabled,
    showToast,
    scheduleSave,
    documentRef = document,
    windowRef = window
}) {
    let lastExternalPasteTime = 0;

    function initGlobalInteractions() {
        canvasContainer.addEventListener('auxclick', (e) => {
            if (e.button === 1) e.preventDefault();
        });

        windowRef.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        windowRef.addEventListener('drop', (e) => {
            e.preventDefault();
            const files = Array.from(e.dataTransfer.files).filter((file) => file.type.startsWith('image/'));
            if (files.length > 0) {
                const targetNodeEl = e.target.closest('.node');
                if (targetNodeEl && files.length === 1) {
                    const nodeId = targetNodeEl.id;
                    const node = state.nodes.get(nodeId);
                    if (node && node.type === 'ImageImport') {
                        loadImageFile(nodeId, files[0]);
                        showToast('已更新现有的图片节点', 'success');
                        return;
                    }
                }

                const pos = viewportApi.screenToCanvas(e.clientX, e.clientY);
                files.forEach((file, index) => {
                    const nid = addNode('ImageImport', pos.x + index * 20, pos.y + index * 20);
                    if (nid) loadImageFile(nid, file);
                });
                showToast(`已通过拖拽添加 ${files.length} 个图片节点`, 'success');
            }
        });

        windowRef.addEventListener('keydown', (e) => {
            const active = documentRef.activeElement;
            const isInput = active && (['INPUT', 'TEXTAREA'].includes(active.tagName) || active.isContentEditable);

            if (e.key === 'Escape') {
                documentRef.getElementById('history-preview-modal')?.classList.add('hidden');
                documentRef.getElementById('history-sidebar')?.classList.remove('active');
                documentRef.getElementById('log-drawer')?.classList.remove('active');
                if (settingsModal && !settingsModal.classList.contains('hidden')) {
                    settingsModal.classList.add('hidden');
                    state.notificationAudio?.pause();
                }
            } else if ((e.key === 'd' || e.key === 'D') && !isInput) {
                if (state.selectedNodes.size > 0) {
                    e.preventDefault();
                    toggleNodesEnabled(Array.from(state.selectedNodes));
                }
            }
        });

        documentRef.addEventListener('paste', (e) => {
            const now = Date.now();
            if (now - lastExternalPasteTime < 500) return;
            lastExternalPasteTime = now;

            const active = documentRef.activeElement;
            if (active && (['INPUT', 'TEXTAREA'].includes(active.tagName) || active.isContentEditable)) return;

            const data = e.clipboardData;
            if (!data) return;

            const items = Array.from(data.items);
            let imageFile = null;
            const textContent = data.getData('text/plain');

            for (const item of items) {
                if (item.kind === 'file' && item.type.includes('image')) {
                    imageFile = item.getAsFile();
                    if (imageFile) break;
                }
            }

            const pos = state.mouseCanvas || {
                x: (windowRef.innerWidth / 2 - state.canvas.x) / state.canvas.zoom,
                y: (windowRef.innerHeight / 2 - state.canvas.y) / state.canvas.zoom
            };

            const isInternalNewer = state.clipboard && state.clipboardTimestamp > state.lastFocusTime;

            if (isInternalNewer) {
                e.preventDefault();
                e.stopImmediatePropagation();
                pasteNode();
            } else if (imageFile) {
                e.preventDefault();
                e.stopImmediatePropagation();

                let targetNodeId = null;
                if (state.selectedNodes.size === 1) {
                    const selectedId = Array.from(state.selectedNodes)[0];
                    const node = state.nodes.get(selectedId);
                    if (node && node.type === 'ImageImport') {
                        targetNodeId = selectedId;
                    }
                }

                if (targetNodeId) {
                    loadImageFile(targetNodeId, imageFile);
                    showToast('图片已导入选中的节点', 'success');
                } else {
                    const nodeId = addNode('ImageImport', pos.x, pos.y, null, true);
                    if (nodeId) {
                        loadImageFile(nodeId, imageFile);
                        showToast('已从剪贴板导入图片', 'success');
                    }
                }
            } else if (state.clipboard && state.clipboard.nodes.length > 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                pasteNode();
            } else if (textContent && textContent.trim().length > 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const nodeId = addNode('TextInput', pos.x, pos.y, null, true);
                if (nodeId) {
                    const textEl = documentRef.getElementById(`${nodeId}-text`);
                    if (textEl) {
                        textEl.value = textContent;
                        textEl.dispatchEvent(new Event('change'));
                    }
                    showToast('已从剪贴板导入文本', 'success');
                    scheduleSave();
                }
            }
        });
    }

    return {
        initGlobalInteractions
    };
}
