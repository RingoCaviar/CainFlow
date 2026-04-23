/**
 * 统一管理侧边栏与抽屉类面板的开关状态，避免多个面板交互时相互冲突。
 */
export function createPanelManager(documentRef = document) {
    const panels = {
        history: { id: 'history-sidebar', btn: 'btn-history' },
        workflow: { id: 'workflow-sidebar', btn: 'btn-toggle-workflow' },
        cache: { id: 'cache-sidebar', btn: 'btn-toggle-cache' },
        logs: { id: 'log-drawer', btn: 'btn-logs' }
    };

    function close(panelKey) {
        const target = panels[panelKey];
        if (!target) return;
        documentRef.getElementById(target.id)?.classList.remove('active');
        documentRef.getElementById(target.btn)?.classList.remove('active');
    }

    function toggle(panelKey, onOpen = null) {
        const target = panels[panelKey];
        if (!target) return;
        const el = documentRef.getElementById(target.id);
        const isOpen = el?.classList.contains('active');

        Object.keys(panels).forEach((key) => {
            if (key !== panelKey) close(key);
        });

        const btn = documentRef.getElementById(target.btn);
        if (isOpen) {
            close(panelKey);
        } else {
            el?.classList.add('active');
            btn?.classList.add('active');
            if (onOpen) onOpen();
        }
    }

    function closeAll() {
        Object.keys(panels).forEach((key) => close(key));
    }

    return {
        panels,
        toggle,
        close,
        closeAll
    };
}
