const RUN_LABELS = { waiting: '待运行', running: '运行中', completed: '完成', error: '失败', aborted: '已取消' };

export function renderImageNodeRunState(node) {
    if (node?.type !== 'ImageGenerate') return;
    const status = node.runStatus || (node.isFailed ? 'error' : node.isSucceeded ? 'completed' : 'waiting');
    const output = node.el?.querySelector('.image-node-run-status');
    if (output) { output.textContent = RUN_LABELS[status] || RUN_LABELS.waiting; output.dataset.status = status; }
}
