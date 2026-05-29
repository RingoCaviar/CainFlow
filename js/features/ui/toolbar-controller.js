/**
 * 管理顶部工具栏交互，包括运行、保存、导入导出、缩放与清空画布等操作。
 */
export function createToolbarControllerApi({
    state,
    canvasContainer,
    viewportApi,
    documentRef = document,
    confirmRef = confirm,
    runWorkflow,
    saveState,
    saveCurrentWorkflow = null,
    undo,
    exportWorkflow,
    importWorkflow,
    showToast,
    scheduleSave,
    updateAllConnections,
    autoArrangeNodes = null,
    zoomToFitTarget = null,
    cleanupNodeElement = (node) => node?.el?.remove(),
    clearUndoStack = () => {},
    clearImageAssets = null,
    clearWorkflowAssets = null,
    updateCacheUsage = () => {}
}) {
    function withZoomInteraction(callback) {
        documentRef.body.classList.add('is-interacting');
        canvasContainer.classList.add('is-zooming');
        callback();
        setTimeout(() => {
            canvasContainer.classList.remove('is-zooming');
            documentRef.body.classList.remove('is-interacting');
            viewportApi.refreshNodeTextRendering();
            scheduleSave();
        }, 120);
    }

    function isChromeActive(element, activeClass) {
        if (!element) return false;
        const body = documentRef.body;
        return body.classList.contains(activeClass)
            || element.matches(':hover')
            || element.matches(':focus-within')
            || element.querySelector('.btn.active, [aria-expanded="true"]');
    }

    function getViewportSafeInsets() {
        const toolbar = documentRef.getElementById('toolbar');
        const sidebar = documentRef.getElementById('side-bar');
        const topInset = isChromeActive(toolbar, 'toolbar-peek-active')
            ? ((toolbar?.offsetHeight || 48) + 8)
            : 0;
        const leftInset = isChromeActive(sidebar, 'sidebar-peek-active')
            ? (sidebar?.offsetWidth || 60)
            : 0;
        return { topInset, leftInset };
    }

    function zoomToFit(targetNodes = null) {
        let nodesToFit = targetNodes;
        if (!nodesToFit) {
            nodesToFit = state.selectedNodes.size > 0
                ? Array.from(state.selectedNodes).map((id) => state.nodes.get(id)).filter(Boolean)
                : Array.from(state.nodes.values());
        }

        if (nodesToFit.length === 0) {
            state.canvas.x = canvasContainer.clientWidth / 2;
            state.canvas.y = canvasContainer.clientHeight / 2;
            state.canvas.zoom = 1;
            viewportApi.updateCanvasTransform();
            return;
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        nodesToFit.forEach((node) => {
            const w = node.el.offsetWidth || 300;
            const h = node.el.offsetHeight || 200;
            minX = Math.min(minX, node.x);
            minY = Math.min(minY, node.y);
            maxX = Math.max(maxX, node.x + w);
            maxY = Math.max(maxY, node.y + h);
        });

        const padding = 60;
        const worldW = (maxX - minX) + padding * 2;
        const worldH = (maxY - minY) + padding * 2;
        const viewW = canvasContainer.clientWidth;
        const viewH = canvasContainer.clientHeight;
        const { topInset, leftInset } = getViewportSafeInsets();
        const safeViewW = Math.max(120, viewW - leftInset);
        const safeViewH = Math.max(120, viewH - topInset);

        const zoom = Math.min(safeViewW / worldW, safeViewH / worldH, 1.2);
        const finalZoom = Math.max(0.1, zoom);
        const safeCenterX = leftInset + safeViewW / 2;
        const safeCenterY = topInset + safeViewH / 2;

        state.canvas.zoom = finalZoom;
        state.canvas.x = safeCenterX - (minX + maxX) / 2 * finalZoom;
        state.canvas.y = safeCenterY - (minY + maxY) / 2 * finalZoom;

        viewportApi.updateCanvasTransform();
    }

    function initToolbarControls() {
        documentRef.getElementById('btn-run')?.addEventListener('click', () => runWorkflow());
        documentRef.getElementById('btn-stop')?.addEventListener('click', () => {
            if (state.isRunning) {
                state.abortReason = 'manual';
                if (typeof state.abortAllWorkflowRuns === 'function') {
                    state.abortAllWorkflowRuns('manual');
                } else if (state.runAbortControllers instanceof Set && state.runAbortControllers.size > 0) {
                    state.runAbortControllers.forEach((controller) => controller.abort());
                } else {
                    state.abortController?.abort();
                }
            }
        });
        documentRef.getElementById('toggle-retry')?.addEventListener('change', (e) => {
            state.autoRetry = e.target.checked;
            saveState();
        });
        documentRef.getElementById('btn-save')?.addEventListener('click', () => {
            if (typeof saveCurrentWorkflow === 'function') {
                saveCurrentWorkflow();
            } else {
                saveState();
                showToast('工作流已手动保存', 'success');
            }
        });
        documentRef.getElementById('btn-undo')?.addEventListener('click', undo);
        documentRef.getElementById('btn-export')?.addEventListener('click', exportWorkflow);
        documentRef.getElementById('btn-import')?.addEventListener('click', () => {
            documentRef.getElementById('import-file')?.click();
        });
        documentRef.getElementById('import-file')?.addEventListener('change', (e) => {
            if (e.target.files[0]) importWorkflow(e.target.files[0]);
        });

        documentRef.getElementById('btn-zoom-in')?.addEventListener('click', () => {
            withZoomInteraction(() => {
                const nz = Math.min(5, state.canvas.zoom * 1.2);
                const cx = canvasContainer.clientWidth / 2;
                const cy = canvasContainer.clientHeight / 2;
                state.canvas.x = cx - (cx - state.canvas.x) * (nz / state.canvas.zoom);
                state.canvas.y = cy - (cy - state.canvas.y) * (nz / state.canvas.zoom);
                state.canvas.zoom = nz;
                viewportApi.updateCanvasTransform();
            });
        });

        documentRef.getElementById('btn-zoom-out')?.addEventListener('click', () => {
            withZoomInteraction(() => {
                const nz = Math.max(0.1, state.canvas.zoom * 0.8);
                const cx = canvasContainer.clientWidth / 2;
                const cy = canvasContainer.clientHeight / 2;
                state.canvas.x = cx - (cx - state.canvas.x) * (nz / state.canvas.zoom);
                state.canvas.y = cy - (cy - state.canvas.y) * (nz / state.canvas.zoom);
                state.canvas.zoom = nz;
                viewportApi.updateCanvasTransform();
            });
        });

        documentRef.getElementById('btn-zoom-reset')?.addEventListener('click', () => {
            withZoomInteraction(() => {
                state.canvas.x = canvasContainer.clientWidth / 2;
                state.canvas.y = canvasContainer.clientHeight / 2;
                state.canvas.zoom = 1;
                viewportApi.updateCanvasTransform();
            });
        });

        documentRef.getElementById('btn-focus-selection')?.addEventListener('click', () => {
            withZoomInteraction(() => {
                if (zoomToFitTarget) zoomToFitTarget();
                else zoomToFit();
            });
        });

        documentRef.getElementById('btn-auto-arrange')?.addEventListener('click', () => {
            if (typeof autoArrangeNodes === 'function') {
                autoArrangeNodes();
            }
        });

        documentRef.getElementById('btn-clear')?.addEventListener('click', async () => {
            if (state.nodes.size === 0) return showToast('画布已经是空的', 'info');
            if (confirmRef('确定要清除所有节点和连接吗？')) {
                if (state.runningNodeIds?.size > 0) {
                    showToast('有节点正在运行，暂不能清空画布', 'warning');
                    return;
                }
                state.connections = [];
                for (const [, node] of state.nodes) cleanupNodeElement(node);
                state.nodes.clear();
                state.selectedNodes.clear();
                clearUndoStack();
                if (typeof clearWorkflowAssets === 'function') {
                    await clearWorkflowAssets({ includeCanvas: false });
                } else if (clearImageAssets) {
                    await clearImageAssets({ preserveHistory: true });
                    updateCacheUsage();
                }
                updateAllConnections();
                showToast('画布已清除', 'info');
                scheduleSave();
            }
        });
    }

    return {
        initToolbarControls,
        zoomToFit
    };
}
