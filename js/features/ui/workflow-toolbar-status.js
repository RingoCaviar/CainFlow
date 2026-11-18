/** Project the current workflow's existing record and editor dirty state into chrome. */
export function renderWorkflowToolbarStatus({ snapshot, dirty = false, documentRef = document }) {
    const title = documentRef.getElementById('toolbar-workflow-name');
    const status = documentRef.getElementById('toolbar-workflow-status');
    if (!title || !status) return;
    const active = snapshot?.active;
    const label = active?.label || '未打开工作流';
    const state = active ? 'automatic' : 'empty';
    const message = active ? '' : '新建或打开工作流';
    status.hidden = !!active;
    if (title.textContent !== label) title.textContent = label;
    title.title = label;
    if (status.textContent !== message) status.textContent = message;
    status.dataset.state = state;
}

/** Execution chrome follows the visible workflow, independently of global run lifetime. */
export function renderWorkflowRunControls({ documentRef, starting = false, runCount = 0, stopping = false, canStopStarting = false }) {
    const phase = stopping ? 'stopping' : starting ? 'starting' : runCount > 0 ? 'running' : 'idle';
    const status = documentRef.getElementById('toolbar-workflow-run-status');
    const message = stopping ? '停止中' : starting ? '启动中' : runCount > 1 ? `运行中·${runCount}` : runCount > 0 ? '运行中' : '';
    if (status) {
        status.hidden = phase === 'idle';
        status.dataset.state = phase;
        if (status.textContent !== message) status.textContent = message;
        status.title = runCount > 0 ? `当前工作流：${message}（${runCount} 个执行范围）` : message;
    }
    const stop = documentRef.getElementById('btn-stop');
    if (stop) {
        stop.classList.remove('running');
        stop.hidden = phase === 'idle';
        stop.disabled = stopping || (runCount === 0 && !canStopStarting);
        stop.title = stopping ? '正在停止当前工作流' : '停止当前工作流的运行';
        stop.setAttribute('aria-busy', String(stopping));
    }
}
