import { canUseCanvasShortcuts, isModalOrFullscreenOpen, isTextEditingTarget } from './shortcut-guard.js';
import { AGENT_RESULT_DRAG_TYPE, takeAgentResultDrag } from '../prompt-agent/prompt-agent-result-drag.js';
import { normalizeFileImport } from '../workflow/file-import.js';

/**
 * Handles global interactions such as image drag/drop, paste, and Escape.
 */
export function createGlobalInteractionsApi({
    state,
    settingsModal,
    canvasContainer,
    viewportApi,
    loadImageFile,
    loadImageData,
    addNode,
    pasteNode,
    clipboardControllerApi,
    toggleNodesEnabled,
    showToast,
    scheduleSave,
    pushHistory,
    getActiveWorkflowId = () => '',
    appendInactiveFileImports = () => false,
    documentRef = document,
    windowRef = window
}) {
    function getImageDropTargetNodeId(event) {
        const targetNodeEl = event.target.closest('.node');
        if (!targetNodeEl) return null;

        const node = state.nodes.get(targetNodeEl.id);
        return node?.type === 'ImageImport' ? targetNodeEl.id : null;
    }

    function isNodeRunning(nodeId) {
        return state.runningNodeIds?.has(nodeId) || state.nodes.get(nodeId)?.el?.classList.contains('running');
    }

    function waitForStableCanvas() {
        const root = documentRef.documentElement;
        if (root?.dataset.canvasLoadState !== 'loading') return;
        return new Promise(resolve => {
            const observer = new windowRef.MutationObserver(() => {
                if (root.dataset.canvasLoadState === 'loading') return;
                observer.disconnect();
                resolve();
            });
            observer.observe(root, { attributes: true, attributeFilter: ['data-canvas-load-state'] });
        });
    }

    function importImageDataAtDrop(event, imageData, message, { forceCreate = false } = {}) {
        const targetNodeId = forceCreate ? null : getImageDropTargetNodeId(event);
        if (targetNodeId) {
            if (isNodeRunning(targetNodeId)) {
                showToast('节点正在运行，暂不能修改图片', 'warning');
                return;
            }
            loadImageData(targetNodeId, imageData);
            showToast(message.update, 'success');
            return;
        }

        const pos = viewportApi.screenToCanvas(event.clientX, event.clientY);
        const nodeId = addNode('ImageImport', pos.x, pos.y);
        if (nodeId) {
            loadImageData(nodeId, imageData);
            showToast(message.create, 'success');
        }
    }

    function initGlobalInteractions() {
        const native = windowRef.chrome?.webview;
        const pendingFileDrops = new Map();
        native?.addEventListener?.('message', ({ data }) => {
            if (data?.type !== 'cainflow-file-import-result') return;
            const drop = pendingFileDrops.get(data.nodeId);
            if (!drop) return;
            clearTimeout(drop.timer);
            pendingFileDrops.delete(data.nodeId);
            const fileImport = normalizeFileImport(data.fileImport);
            drop.resolve(fileImport?.id ? { id: data.nodeId, fileImport } : { error: data.error || '无法登记原文件。' });
        });
        canvasContainer.addEventListener('auxclick', (e) => {
            if (e.button === 1) e.preventDefault();
        });

        windowRef.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        windowRef.addEventListener('drop', async (e) => {
            e.preventDefault();

            if (Array.from(e.dataTransfer?.types || []).includes(AGENT_RESULT_DRAG_TYPE)) {
                if (!e.target.closest?.('#canvas-container')) return;
                const image = takeAgentResultDrag(e.dataTransfer);
                if (!image) { showToast('生成图片拖拽已失效，请重新拖拽', 'warning'); return; }
                importImageDataAtDrop(e, image.dataUrl, { create: '已从 Agent 生成结果导入原图' }, { forceCreate: true });
                return;
            }

            const historyDrag = state.draggedHistoryImage;
            if (historyDrag?.image || historyDrag?.imagePromise) {
                if (!e.target.closest?.('#canvas-container')) return;
                const historyImage = historyDrag.image || await historyDrag.imagePromise.catch(() => '');
                if (!historyImage) {
                    state.draggedHistoryImage = null;
                    showToast('读取历史原图失败', 'error');
                    return;
                }
                importImageDataAtDrop(e, historyImage, {
                    update: '已使用历史原图更新现有图片节点',
                    create: '已从历史记录导入原始分辨率图片'
                }, { forceCreate: true });
                state.draggedHistoryImage = null;
                return;
            }

            const droppedFiles = Array.from(e.dataTransfer?.files || []);
            if (typeof native?.postMessageWithAdditionalObjects === 'function' && droppedFiles.length) {
                if (!e.target.closest?.('#canvas-container') || isModalOrFullscreenOpen({ documentRef, windowRef })) return;
                if (documentRef.documentElement?.dataset.canvasLoadState === 'loading') return;
                const workflowId = getActiveWorkflowId();
                if (!workflowId) return;
                const position = viewportApi.screenToCanvas(e.clientX, e.clientY);
                const results = await Promise.all(droppedFiles.map(file => new Promise(resolve => {
                    const nodeId = 'file-' + windowRef.crypto.randomUUID();
                    const unavailable = () => {
                        clearTimeout(timer);
                        pendingFileDrops.delete(nodeId);
                        resolve({ error: '无法读取拖入文件的原始位置。' });
                    };
                    const timer = setTimeout(unavailable, 10000);
                    pendingFileDrops.set(nodeId, { timer, resolve });
                    try {
                        native.postMessageWithAdditionalObjects({ type: 'cainflow-file-import', workflowId, nodeId }, [file]);
                    } catch {
                        unavailable();
                    }
                })));
                await waitForStableCanvas();
                const nodes = results.filter(result => result.fileImport).map((result, index) => ({
                    ...result,
                    type: 'FileImport',
                    x: position.x + (index % 4) * 300,
                    y: position.y + Math.floor(index / 4) * 230
                }));
                if (nodes.length) {
                    if (getActiveWorkflowId() === workflowId) {
                        pushHistory?.();
                        nodes.forEach(node => addNode(node.type, node.x, node.y, node, Boolean(pushHistory)));
                        scheduleSave();
                    } else if (!appendInactiveFileImports(workflowId, nodes)) {
                        showToast('原工作流已关闭，无法添加这批文件。', 'warning');
                    }
                }
                const failures = results.flatMap((result, index) => result.error
                    ? [`${droppedFiles[index].name}：${result.error}`] : []);
                if (failures.length) showToast(failures.join('\n'), 'warning');
                return;
            }
            const files = droppedFiles.filter((file) => file.type.startsWith('image/'));
            if (files.length > 0) {
                const targetNodeId = getImageDropTargetNodeId(e);
                if (targetNodeId && files.length === 1) {
                    if (isNodeRunning(targetNodeId)) {
                        showToast('节点正在运行，暂不能修改图片', 'warning');
                        return;
                    }
                    loadImageFile(targetNodeId, files[0]);
                    showToast('已更新现有的图片节点', 'success');
                    return;
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
            const isInput = isTextEditingTarget(active);

            if (e.key === 'Escape') {
                if (settingsModal && !settingsModal.classList.contains('hidden')) {
                    e.preventDefault();
                    windowRef.__cainflowSettingsModalApi?.handleEscape?.();
                    return;
                }
                documentRef.getElementById('history-preview-modal')?.classList.add('hidden');
                documentRef.getElementById('history-fullscreen-modal')?.classList.add('hidden');
                documentRef.getElementById('history-sidebar')?.classList.remove('active');
                documentRef.getElementById('log-drawer')?.classList.remove('active');
            } else if ((e.key === 'm' || e.key === 'M' || e.key === 'd' || e.key === 'D') && !isInput && !e.repeat) {
                if (!canUseCanvasShortcuts({ event: e, state, canvasContainer, documentRef, windowRef })) return;
                if (state.selectedNodes.size > 0) {
                    e.preventDefault();
                    toggleNodesEnabled(Array.from(state.selectedNodes));
                }
            }
        });

        documentRef.addEventListener('paste', (e) => {
            const now = Date.now();
            if (state.skipNextClipboardPasteUntil && now < state.skipNextClipboardPasteUntil) {
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
            const active = documentRef.activeElement;
            if (isTextEditingTarget(active) || isModalOrFullscreenOpen({ documentRef, windowRef })) return;
            if (!canUseCanvasShortcuts({ event: e, state, canvasContainer, documentRef, windowRef })) return;

            const data = e.clipboardData;
            if (!data) return;

            const items = Array.from(data.items || []);
            let imageFile = null;
            const textContent = data.getData?.('text/plain') || '';

            for (const item of items) {
                if (item.kind === 'file') {
                    const file = item.getAsFile?.();
                    if (file && (file.type?.startsWith('image/') || item.type?.startsWith('image/'))) {
                        imageFile = file;
                        break;
                    }
                }
            }
            if (!imageFile) {
                imageFile = Array.from(data.files || []).find((file) => file?.type?.startsWith('image/')) || null;
            }

            const pos = state.mouseCanvas || {
                x: (windowRef.innerWidth / 2 - state.canvas.x) / state.canvas.zoom,
                y: (windowRef.innerHeight / 2 - state.canvas.y) / state.canvas.zoom
            };

            if (imageFile) {
                e.preventDefault();
                e.stopImmediatePropagation();

                let targetNodeId = null;
                const selectedId = getSingleSelectedNodeId();
                if (selectedId) {
                    const node = state.nodes.get(selectedId);
                    if (node && node.type === 'ImageImport') {
                        targetNodeId = selectedId;
                    }
                }

                if (targetNodeId) {
                    if (isNodeRunning(targetNodeId)) {
                        showToast('节点正在运行，暂不能修改图片', 'warning');
                        return;
                    }
                    loadImageFile(targetNodeId, imageFile);
                    showToast('图片已导入选中的节点', 'success');
                } else {
                    const nodeId = addNode('ImageImport', pos.x, pos.y, null, true);
                    if (nodeId) {
                        loadImageFile(nodeId, imageFile);
                        showToast('已从剪贴板导入图片', 'success');
                    }
                }
            } else if (clipboardControllerApi.shouldPreferInternalClipboard()) {
                e.preventDefault();
                e.stopImmediatePropagation();
                pasteNode();
            } else if (textContent && textContent.trim().length > 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const nodeId = addNode('Text', pos.x, pos.y, null, true);
                if (nodeId) {
                    const textEl = documentRef.getElementById(`${nodeId}-text`);
                    if (textEl) {
                        textEl.value = textContent;
                        textEl.dispatchEvent(new Event('change'));
                    }
                    showToast('已从剪贴板导入文本', 'success');
                    scheduleSave();
                }
            } else if (clipboardControllerApi.hasClipboardNodes()) {
                e.preventDefault();
                e.stopImmediatePropagation();
                pasteNode();
            }
        });
    }

    function getSingleSelectedNodeId() {
        if (state.selectedNodes.size === 1) {
            const selectedId = Array.from(state.selectedNodes)[0];
            if (state.nodes.has(selectedId)) return selectedId;
        }
        return null;
    }

    return {
        initGlobalInteractions
    };
}
