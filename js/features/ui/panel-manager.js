/**
 * 统一管理侧边栏与抽屉类面板的开关状态，避免多个面板交互时相互冲突。
 */
import { bindPromptAgentCanvasDismiss } from '../prompt-agent/prompt-agent-canvas-dismiss.js';
import { getSurfaceCoordinator } from './surface-coordinator.js';

export function createPanelManager(documentRef = document, canvasContainer = null) {
    const surfaces = getSurfaceCoordinator(documentRef);
    const panels = {
        history: { id: 'history-sidebar', btn: 'btn-history' },
        workflow: { id: 'workflow-sidebar', btn: 'btn-toggle-workflow' },
        cache: { id: 'cache-sidebar', btn: 'btn-toggle-cache' },
        statistics: { id: 'statistics-sidebar', btn: 'btn-toggle-statistics' },
        logs: { id: 'log-drawer', btn: 'btn-logs' },
        agent: { id: 'prompt-agent-panel', btn: 'btn-prompt-agent' },
        help: { id: 'help-panel', btn: 'btn-help' }
    };
    let canvasBlankCloseBound = false;
    documentRef.addEventListener?.('keydown', event => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if (documentRef.getElementById('toolbar-workflow-more')?.open) return;
        const active = Object.keys(panels).find(key => documentRef.getElementById(panels[key].id)?.classList.contains('active'));
        if (!active) return;
        event.preventDefault(); event.stopImmediatePropagation(); close(active);
    }, true);

    function close(panelKey) {
        const target = panels[panelKey];
        if (!target) return;
        if (target.close) { target.close(); return; }
        const button = documentRef.getElementById(target.btn);
        const element = documentRef.getElementById(target.id);
        element?.classList.remove('active');
        element?.setAttribute?.('inert', '');
        element?.setAttribute?.('aria-hidden', 'true');
        button?.classList.remove('active');
        button?.setAttribute?.('aria-expanded', 'false');
        if (button && documentRef.activeElement === button) {
            button.blur();
        }
    }

    function toggle(panelKey, onOpen = null) {
        const target = panels[panelKey];
        if (!target) return;
        const el = documentRef.getElementById(target.id);
        const isOpen = el?.classList.contains('active');

        beforeOpen(panelKey);

        const btn = documentRef.getElementById(target.btn);
        if (isOpen) {
            close(panelKey);
        } else {
            el?.classList.add('active');
            el?.removeAttribute?.('inert');
            el?.setAttribute?.('aria-hidden', 'false');
            btn?.classList.add('active');
            btn?.setAttribute?.('aria-expanded', 'true');
            if (onOpen) onOpen();
        }
    }

    function closeAll() {
        Object.keys(panels).forEach((key) => close(key));
    }

    function beforeOpen(panelKey) {
        surfaces?.closePopovers();
        Object.keys(panels).forEach(key => { if (key !== panelKey) close(key); });
    }

    function register(panelKey, callbacks) { Object.assign(panels[panelKey], callbacks); }

    function bindCanvasBlankClose() {
        if (!canvasContainer || canvasBlankCloseBound) return;

        bindPromptAgentCanvasDismiss({ documentRef, close: closeAll });

        canvasBlankCloseBound = true;
    }

    return {
        panels,
        toggle,
        close,
        closeAll,
        beforeOpen,
        register,
        bindCanvasBlankClose
    };
}
