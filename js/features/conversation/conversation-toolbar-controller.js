export function createConversationToolbarController({
    documentRef = document,
    workspaceModeController,
    conversationWorkbenchController,
    showToast = () => {}
} = {}) {
    const element = (id) => documentRef.getElementById(id);

    function sync(snapshot = conversationWorkbenchController?.getToolbarSnapshot?.() || {}) {
        const running = Boolean(snapshot.isRunning);
        const title = snapshot.title || '新对话';
        const workflow = snapshot.workflowLabel || '画布';
        const status = element('conversation-toolbar-status');
        const returnButton = element('conversation-toolbar-return-canvas');
        const stopButton = element('conversation-toolbar-stop');
        const contextButton = element('conversation-toolbar-context');
        if (status) status.textContent = running ? '生成中' : '就绪';
        if (returnButton) {
            returnButton.textContent = `返回画布 · ${workflow}`;
            returnButton.title = `返回 ${workflow} 画布；对话${running ? '将继续在后台运行' : '状态会被保留'}`;
        }
        if (stopButton) {
            stopButton.hidden = !running;
            stopButton.disabled = !running;
        }
        if (contextButton) contextButton.textContent = `上下文${snapshot.stagedContextCount ? ` · ${snapshot.stagedContextCount}` : ''}`;
        const heading = element('conversation-toolbar-title');
        if (heading) heading.textContent = title;
    }

    function bind(id, callback) {
        element(id)?.addEventListener('click', () => {
            Promise.resolve(callback()).catch((error) => showToast(error.message, 'error'));
        });
    }

    function init() {
        bind('conversation-toolbar-new', () => conversationWorkbenchController?.createConversation());
        bind('conversation-toolbar-list', () => conversationWorkbenchController?.togglePane('list'));
        bind('conversation-toolbar-context', () => conversationWorkbenchController?.togglePane('context'));
        bind('conversation-toolbar-stage-nodes', () => conversationWorkbenchController?.stageSelectedNodes());
        bind('conversation-toolbar-stage-history', () => conversationWorkbenchController?.stageSelectedHistory());
        bind('conversation-toolbar-record', () => conversationWorkbenchController?.showExecutionRecord());
        bind('conversation-toolbar-stop', () => conversationWorkbenchController?.stopCurrentRun());
        bind('conversation-toolbar-return-canvas', () => workspaceModeController?.activate('canvas'));
        bind('conversation-toolbar-theme', () => element('btn-theme-toggle')?.click());
        bind('conversation-toolbar-settings', () => element('btn-settings')?.click());
        sync();
    }

    return { init, sync };
}
