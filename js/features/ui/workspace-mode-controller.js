export function normalizeWorkspaceMode(value) {
    return 'canvas';
}

export function createWorkspaceModeController({
    state,
    documentRef = document,
    saveState = () => {}
}) {
    function activate(requestedMode, { persist = true } = {}) {
        const mode = normalizeWorkspaceMode(requestedMode);
        const canvasWorkspace = documentRef.getElementById('canvas-container');
        const sideBar = documentRef.getElementById('side-bar');
        if (!canvasWorkspace) return false;

        state.workspaceMode = 'canvas';
        documentRef.body.dataset.workspaceMode = 'canvas';
        documentRef.body.classList.remove?.('workspace-mode-conversation');
        canvasWorkspace.hidden = false;
        canvasWorkspace.inert = false;
        if (sideBar) {
            sideBar.hidden = false;
            sideBar.inert = false;
        }
        if (persist) saveState();
        return true;
    }

    function init() {
        documentRef.addEventListener('keydown', (event) => {
            if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
            const digit = event.code === 'Digit1' ? '1'
                : (event.code === 'Digit2' ? '2' : event.key);
            if (digit !== '1') return;
            event.preventDefault();
            activate('canvas');
        });
        activate(state.workspaceMode, { persist: false });
    }

    return { activate, getCurrentMode: () => state.workspaceMode, init };
}
