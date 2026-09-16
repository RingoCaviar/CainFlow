const WORKSPACE_MODES = new Set(['canvas', 'conversation']);

export function normalizeWorkspaceMode(value) {
    return WORKSPACE_MODES.has(value) ? value : 'canvas';
}

export function createWorkspaceModeController({
    state,
    documentRef = document,
    saveState = () => {}
}) {
    function activate(requestedMode, { persist = true } = {}) {
        const mode = normalizeWorkspaceMode(requestedMode);
        const canvasWorkspace = documentRef.getElementById('canvas-container');
        const conversationWorkspace = documentRef.getElementById('conversation-workspace');
        const sideBar = documentRef.getElementById('side-bar');
        const canvasButton = documentRef.getElementById('btn-workspace-canvas');
        const conversationButton = documentRef.getElementById('btn-workspace-conversation');
        if (!canvasWorkspace || !conversationWorkspace) return false;

        const conversationActive = mode === 'conversation';
        state.workspaceMode = mode;
        documentRef.body.dataset.workspaceMode = mode;
        documentRef.body.classList.toggle?.('workspace-mode-conversation', conversationActive);
        canvasWorkspace.hidden = conversationActive;
        canvasWorkspace.inert = conversationActive;
        if (sideBar) {
            sideBar.hidden = conversationActive;
            sideBar.inert = conversationActive;
        }
        conversationWorkspace.hidden = !conversationActive;
        conversationWorkspace.inert = !conversationActive;
        canvasButton?.setAttribute('aria-pressed', String(!conversationActive));
        conversationButton?.setAttribute('aria-pressed', String(conversationActive));
        canvasButton?.classList.toggle?.('is-selected', !conversationActive);
        conversationButton?.classList.toggle?.('is-selected', conversationActive);
        if (persist) saveState();
        return true;
    }

    function init() {
        documentRef.getElementById('btn-workspace-canvas')?.addEventListener(
            'click', () => activate('canvas'));
        documentRef.getElementById('btn-workspace-conversation')?.addEventListener(
            'click', () => activate('conversation'));
        documentRef.addEventListener('keydown', (event) => {
            if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
            const digit = event.code === 'Digit1' ? '1'
                : (event.code === 'Digit2' ? '2' : event.key);
            if (digit !== '1' && digit !== '2') return;
            event.preventDefault();
            activate(digit === '1' ? 'canvas' : 'conversation');
        });
        activate(state.workspaceMode, { persist: false });
    }

    return { activate, getCurrentMode: () => state.workspaceMode, init };
}
