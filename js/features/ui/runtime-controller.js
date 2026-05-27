import { canUseCanvasShortcuts, isTextEditingTarget } from './shortcut-guard.js';

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
    pasteNode,
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

    function initCanvasChromePeek() {
        const body = documentRef.body;
        const toolbar = documentRef.getElementById('toolbar');
        const sidebar = documentRef.getElementById('side-bar');
        if (!body || !toolbar || !sidebar) return;

        let lastToolbarPeek = false;
        let lastSidebarPeek = false;

        function getCssPx(element, propertyName, fallback) {
            const raw = windowRef.getComputedStyle(element).getPropertyValue(propertyName);
            const value = Number.parseFloat(raw);
            return Number.isFinite(value) ? value : fallback;
        }

        function isImmersivePreviewOpen() {
            if (documentRef.querySelector('.fullscreen-overlay')) return true;
            const historyPreview = documentRef.getElementById('history-preview-modal');
            if (historyPreview && !historyPreview.classList.contains('hidden')) return true;
            return false;
        }

        function updatePeekState(event) {
            if (isImmersivePreviewOpen()) {
                body.classList.remove('toolbar-peek-active', 'sidebar-peek-active');
                lastToolbarPeek = false;
                lastSidebarPeek = false;
                return;
            }

            const toolbarDistance = getCssPx(documentRef.getElementById('app-container') || toolbar, '--toolbar-peek-height', 100);
            const sidebarDistance = getCssPx(sidebar, '--side-bar-peek-width', 100);
            const toolbarRect = toolbar.getBoundingClientRect();
            const sidebarRect = sidebar.getBoundingClientRect();
            const toolbarBottom = Math.max(toolbarRect.bottom, toolbarRect.top + toolbar.offsetHeight);
            const sidebarRight = Math.max(sidebarRect.right, sidebarRect.left + sidebar.offsetWidth);
            const toolbarPeek = !body.classList.contains('toolbar-pinned') && event.clientY <= toolbarBottom + toolbarDistance;
            const sidebarPeek = !body.classList.contains('sidebar-pinned') && event.clientX <= sidebarRight + sidebarDistance;

            if (toolbarPeek !== lastToolbarPeek) {
                body.classList.toggle('toolbar-peek-active', toolbarPeek);
                lastToolbarPeek = toolbarPeek;
            }
            if (sidebarPeek !== lastSidebarPeek) {
                body.classList.toggle('sidebar-peek-active', sidebarPeek);
                lastSidebarPeek = sidebarPeek;
            }
        }

        windowRef.addEventListener('pointermove', updatePeekState, { passive: true });
        windowRef.addEventListener('blur', () => {
            body.classList.remove('toolbar-peek-active', 'sidebar-peek-active');
            lastToolbarPeek = false;
            lastSidebarPeek = false;
        });
    }

    function initKeyboardShortcuts() {
        documentRef.addEventListener('keydown', (e) => {
            const activeElement = documentRef.activeElement;
            const inInput = isTextEditingTarget(activeElement);
            const hasTextSelection = windowRef.getSelection()?.toString().length > 0;
            const canvasShortcutsEnabled = canUseCanvasShortcuts({
                event: e,
                state,
                canvasContainer,
                documentRef,
                windowRef
            });

            if (e.code === 'Space' && canvasShortcutsEnabled) {
                if (!state.isSpacePressed) {
                    state.isSpacePressed = true;
                    canvasContainer.classList.add('space-pan-active');
                }
                if (e.target === documentRef.body || e.target === canvasContainer) e.preventDefault();
            }

            if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A') && canvasShortcutsEnabled) {
                e.preventDefault();
                selectionApi.selectAllNodes();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runWorkflow(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveState(); showToast('工作流已保存', 'success'); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'e') { e.preventDefault(); exportWorkflow(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); documentRef.getElementById('import-file')?.click(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'c' && canvasShortcutsEnabled && !hasTextSelection) { e.preventDefault(); copySelectedNode(); }
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V') && canvasShortcutsEnabled) {
                e.preventDefault();
                e.stopPropagation();
                state.skipNextClipboardPasteUntil = Date.now() + 300;
                pasteNode({ includeExternalConnections: true });
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
                e.preventDefault();
                undo();
            }

            if (e.key === 'Delete' && state.selectedNodes.size > 0 && canvasShortcutsEnabled) {
                e.preventDefault();
                Array.from(state.selectedNodes).forEach((id) => removeNode(id));
            }
            if ((e.key === 'f' || e.key === 'F') && canvasShortcutsEnabled) {
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
        initCanvasChromePeek();
    }

    return {
        initRuntimeBindings
    };
}
