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
