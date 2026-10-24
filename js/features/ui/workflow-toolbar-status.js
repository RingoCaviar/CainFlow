/** Project the current workflow's existing record and editor dirty state into chrome. */
export function renderWorkflowToolbarStatus({ snapshot, dirty = false, documentRef = document }) {
    const title = documentRef.getElementById('toolbar-workflow-name');
    const status = documentRef.getElementById('toolbar-workflow-status');
    if (!title || !status) return;
    const active = snapshot?.active;
    const record = snapshot?.open?.find(item => item.workflowId === active?.workflowId);
    const label = active?.label || '未打开工作流';
    const state = !active ? 'empty' : dirty ? 'modified' : record?.pendingExplicitSave ? 'pending' : 'saved';
    const message = { empty: '新建或打开工作流', modified: '有修改', pending: '待保存', saved: '已保存' }[state];
    if (title.textContent !== label) title.textContent = label;
    title.title = label;
    if (status.textContent !== message) status.textContent = message;
    status.dataset.state = state;
}
