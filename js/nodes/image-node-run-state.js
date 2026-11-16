const RUN_LABELS = { waiting: '待运行', running: '运行中', completed: '完成', error: '失败', aborted: '已取消' };

function readProgress(node) {
    const batch = node.type === 'ImageGenerate' ? node.data?.concurrentRequestStatus : null;
    if (Array.isArray(batch?.requests) && batch.requests.length > 0 && batch.requests.length === batch.total) {
        return { completed: batch.requests.filter(request => request.status === 'success').length, total: batch.total };
    }
    const progress = node.apiGenerationProgress;
    if (Number.isInteger(progress?.completed) && Number.isInteger(progress?.total)
        && progress.total > 0 && progress.completed >= 0 && progress.completed <= progress.total) return progress;
    return null;
}

export function projectImageCardRunStatus(node, running) {
    const status = node.runStatus;
    if (status === 'waiting' && running) return { status, label: '等待执行' };
    if (status === 'running' && running) {
        const stage = node.productRetouchStage;
        const label = stage === 'analyzing' ? '分析中' : stage === 'retouching' ? '精修中' : '运行中';
        const progress = readProgress(node);
        const count = progress && `${progress.completed}/${progress.total}`;
        return { status, label: count ? `${label} · ${node.type === 'ECommerceImageSet' ? '已完成 ' : ''}${count}` : label };
    }
    if (status === 'error' && !running) return { status, label: '执行失败' };
    if (status === 'completed' && !running) {
        const progress = node.type === 'ECommerceImageSet' ? node.commerceRunPartial : node.type === 'ImageGenerate' ? readProgress(node) : null;
        const partial = node.type === 'ECommerceImageSet' ? Boolean(progress)
            : node.type === 'ImageGenerate' && (node.generationAttemptIncomplete === true
                || (progress && progress.completed > 0 && progress.completed < progress.total));
        if (partial) return { status: 'partial', label: progress ? `部分完成 · ${progress.completed}/${progress.total}` : '部分完成' };
    }
    return null;
}

export function queryImageNodeRunControl(node, selector) {
    return node?.el?.querySelector?.(selector) || node?.parameterRoot?.querySelector?.(selector);
}

export function renderImageNodeRunState(node) {
    if (node?.type !== 'ImageGenerate') return;
    const status = node.runStatus || (node.isFailed ? 'error' : node.isSucceeded ? 'completed' : 'waiting');
    const output = queryImageNodeRunControl(node, '.image-node-run-status');
    if (output) {
        output.textContent = status === 'completed' && node.generationAttemptIncomplete === true ? '部分完成' : RUN_LABELS[status] || RUN_LABELS.waiting;
        output.dataset.status = status;
    }
    const feedback = queryImageNodeRunControl(node, '.image-parameter-run-feedback');
    if (feedback) feedback.dataset.status = status;
    const progress = queryImageNodeRunControl(node, '.api-generation-progress');
    if (progress) {
        const { completed, total } = node.apiGenerationProgress || {};
        const known = status !== 'waiting' && Number.isInteger(completed) && Number.isInteger(total) && total > 0 && completed >= 0 && completed <= total;
        const field = progress.closest('.node-generation-progress-field');
        if (progress.hidden !== !known) progress.hidden = !known;
        if (field && field.hidden !== !known) field.hidden = !known;
        const label = `${completed}/${total}`;
        if (known && progress.textContent !== label) progress.textContent = label;
    }
    const dirty = queryImageNodeRunControl(node, '[data-image-generation-dirty]');
    if (dirty) dirty.hidden = node.generationDirty !== true;
    const message = node.executionFailure?.message || '';
    const summary = queryImageNodeRunControl(node, '.node-failure-summary');
    if (summary) {
        const short = message.replace(/\s+/g, ' ').trim();
        summary.textContent = short.length > 140 ? `${short.slice(0, 139)}…` : short;
        summary.classList.toggle('hidden', !message);
    }
    const details = queryImageNodeRunControl(node, '[data-image-run-action=details]');
    if (details) details.hidden = !message;
    const full = node.parameterRoot?.querySelector('.node-error-msg') || node.el?.querySelector('.node-error-msg');
    if (full) {
        if (full.textContent !== message) full.textContent = message;
        full.classList.toggle('hidden', !message);
        full.style.display = message ? 'block' : 'none';
    }
}
