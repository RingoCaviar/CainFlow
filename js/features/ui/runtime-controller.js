import { canUseCanvasShortcuts, isTextEditingTarget } from './shortcut-guard.js';
import { installUiBoundaryAudit } from './ui-boundary-audit.js';

export function hasOpenImmersivePreview(documentRef = document) {
    return documentRef.querySelector('.fullscreen-overlay.active') !== null;
}

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
    saveCurrentWorkflow = null,
    showToast,
    exportWorkflow,
    undo,
    copySelectedNode,
    pasteNode,
    clipboardControllerApi,
    removeNode,
    zoomToFit,
    scheduleSave,
    scheduleConnectionRefresh = null,
    realignConnections = null,
    closeModal,
    documentRef = document,
    windowRef = window
}) {
    installUiBoundaryAudit({ documentRef, windowRef });

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

        const syncToolbarHeight = () => {
            const height = toolbar.offsetHeight;
            if (height > 0) {
                documentRef.documentElement.style.setProperty('--toolbar-height', `${height}px`);
            }
        };

        // ResizeObserver callbacks are asynchronous. Write the initial value now so
        // startup notices and dialogs never position themselves against the 48px fallback.
        syncToolbarHeight();

        const ResizeObserverCtor = documentRef.defaultView?.ResizeObserver;
        if (!ResizeObserverCtor) return;
        const observer = new ResizeObserverCtor(syncToolbarHeight);

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
            if (hasOpenImmersivePreview(documentRef)) return true;
            const historyPreview = documentRef.getElementById('history-preview-modal');
            if (historyPreview && !historyPreview.classList.contains('hidden')) return true;
            return false;
        }

        function isPointerOverActiveDrawer(event) {
            const drawerIds = ['history-sidebar', 'workflow-sidebar', 'cache-sidebar', 'statistics-sidebar', 'log-drawer'];
            return drawerIds.some((id) => {
                const drawer = documentRef.getElementById(id);
                if (!drawer?.classList.contains('active')) return false;
                if (drawer.contains(event.target)) return true;

                const rect = drawer.getBoundingClientRect();
                return event.clientX >= rect.left
                    && event.clientX <= rect.right
                    && event.clientY >= rect.top
                    && event.clientY <= rect.bottom;
            });
        }

        function updatePeekState(event) {
            if (state.batchConnectionMode?.sourceNodeId || isImmersivePreviewOpen()) {
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
            const toolbarPeek = !isPointerOverActiveDrawer(event)
                && !body.classList.contains('toolbar-pinned')
                && event.clientY <= toolbarBottom + toolbarDistance;
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
            if (documentRef.querySelector('.painter-overlay')) {
                return;
            }

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

            if ((e.ctrlKey || e.metaKey) && e.key === 'F5') {
                e.preventDefault();
                void hardReload();
                return;
            }

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
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                if (typeof saveCurrentWorkflow === 'function') {
                    saveCurrentWorkflow();
                } else {
                    saveState();
                    showToast('工作流已保存', 'success');
                }
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'e') { e.preventDefault(); exportWorkflow(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); documentRef.getElementById('import-file')?.click(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'c' && canvasShortcutsEnabled && !hasTextSelection) { e.preventDefault(); copySelectedNode(); }
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V') && canvasShortcutsEnabled) {
                e.preventDefault();
                e.stopPropagation();
                state.skipNextClipboardPasteUntil = Date.now() + 300;
                pasteNode({ includeExternalConnections: true });
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && canvasShortcutsEnabled) {
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

    async function hardReload() {
        if (state.isRunning && !windowRef.confirm('工作流正在运行。强制刷新会中断当前界面的运行状态，确定继续吗？')) return false;
        try {
            const settingsSaved = saveState();
            if (settingsSaved === false) {
                showToast('设置保存失败，已取消强制刷新', 'error');
                return false;
            }
            const saved = typeof saveCurrentWorkflow === 'function'
                ? await saveCurrentWorkflow()
                : true;
            if (!saved) {
                showToast('保存失败，已取消强制刷新', 'error');
                return false;
            }
        } catch (error) {
            showToast(`保存失败，已取消强制刷新：${error?.message || error}`, 'error');
            return false;
        }

        const url = new URL(windowRef.location.href);
        url.searchParams.set('__hard_reload', String(Date.now()));
        windowRef.location.replace(url.toString());
        return true;
    }

    function initWindowBindings() {
        // The ES module normally initializes after `load` (disk hydration happens first),
        // so registering only a load listener can miss the event entirely.
        initToolbarObserver();
        documentRef.addEventListener('copy', () => {
            clipboardControllerApi.markNativeClipboardEvent(Date.now());
        });
        documentRef.addEventListener('cut', () => {
            clipboardControllerApi.markNativeClipboardEvent(Date.now());
        });
        windowRef.addEventListener('focus', () => {
            state.lastFocusTime = Date.now();
        });
        windowRef.addEventListener('blur', () => {
            state.lastFocusTime = Date.now();
            state.isSpacePressed = false;
            canvasContainer.classList.remove('space-pan-active');
        });
        state.lastFocusTime = Date.now();
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
        documentRef.getElementById('btn-hard-reload')?.addEventListener('click', () => { void hardReload(); });
        documentRef.getElementById('btn-realign-connections')?.addEventListener('click', () => {
            const corrected = realignConnections?.() || 0;
            showToast(corrected > 0 ? `已重新对齐 ${corrected} 条连线` : '连线已重新对齐', 'success');
        });
        windowRef.addEventListener('resize', () => scheduleConnectionRefresh?.({ force: true, settle: true, reason: 'window-resize' }));
    }

    return {
        initRuntimeBindings
    };
}
