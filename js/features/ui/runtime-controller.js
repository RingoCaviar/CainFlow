/**
 * 负责运行时全局监听，包括快捷键、窗口焦点、模态框关闭与工具栏高度同步。
 */
export function createRuntimeControllerApi({
    state,
    canvasContainer,
    contextMenu,
    selectionApi,
    runWorkflow,
    saveState,
    showToast,
    exportWorkflow,
    undo,
    copySelectedNode,
    removeNode,
    zoomToFit,
    scheduleSave,
    closeModal,
    documentRef = document,
    windowRef = window
}) {
    function clearSelection() {
        state.selectedNodes.forEach((nodeId) => {
            const node = state.nodes.get(nodeId);
            if (node) node.el.classList.remove('selected');
        });
        state.selectedNodes.clear();
    }

    function initToolbarObserver() {
        const toolbar = documentRef.getElementById('toolbar');
        if (!toolbar) return;

        const observer = new ResizeObserver(() => {
            const height = toolbar.offsetHeight;
            documentRef.documentElement.style.setProperty('--toolbar-height', `${height}px`);
        });

        observer.observe(toolbar);
    }

    function initKeyboardShortcuts() {
        documentRef.addEventListener('keydown', (e) => {
            const activeElement = documentRef.activeElement;
            const inInput = activeElement && (
                activeElement.tagName === 'INPUT'
                || activeElement.tagName === 'TEXTAREA'
                || activeElement.tagName === 'SELECT'
                || activeElement.isContentEditable
            );
            const hasTextSelection = windowRef.getSelection().toString().length > 0;

            if (e.code === 'Space' && !inInput) {
                if (!state.isSpacePressed) {
                    state.isSpacePressed = true;
                    canvasContainer.classList.add('space-pan-active');
                }
                if (e.target === documentRef.body || e.target === canvasContainer) e.preventDefault();
            }

            if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A') && !inInput && state.isMouseOverCanvas) {
                e.preventDefault();
                selectionApi.selectAllNodes();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runWorkflow(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveState(); showToast('工作流已保存', 'success'); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'e') { e.preventDefault(); exportWorkflow(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); documentRef.getElementById('import-file')?.click(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !inInput && !hasTextSelection) { e.preventDefault(); copySelectedNode(); }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
                e.preventDefault();
                undo();
            }

            if (e.key === 'Delete' && state.selectedNodes.size > 0 && !inInput) {
                Array.from(state.selectedNodes).forEach((id) => removeNode(id));
            }
            if ((e.key === 'f' || e.key === 'F') && !inInput) {
                e.preventDefault();
                zoomToFit();
                scheduleSave();
            }
            if (e.key === 'Escape') {
                contextMenu.classList.add('hidden');
                clearSelection();
            }
        });

        documentRef.addEventListener('keyup', (e) => {
            if (e.code === 'Space') {
                state.isSpacePressed = false;
                canvasContainer.classList.remove('space-pan-active');
            }
        });
    }

    function initWindowBindings() {
        windowRef.addEventListener('focus', () => {
            state.lastFocusTime = Date.now();
        });
        windowRef.addEventListener('blur', () => {
            state.lastFocusTime = Date.now();
            state.isSpacePressed = false;
            canvasContainer.classList.remove('space-pan-active');
        });
        windowRef.addEventListener('load', () => {
            state.lastFocusTime = Date.now();
            initToolbarObserver();
        });
    }

    function initModalBindings() {
        documentRef.getElementById('modal-error')?.addEventListener('mousedown', (e) => {
            if (e.target === documentRef.getElementById('modal-error')) {
                closeModal('modal-error');
            }
        });
    }

    function initRuntimeBindings() {
        initKeyboardShortcuts();
        initWindowBindings();
        initModalBindings();
    }

    return {
        initRuntimeBindings
    };
}
