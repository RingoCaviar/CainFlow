import { getCanonicalImageList } from '../execution/execution-data-utils.js';

const statusLabels = {
    pending: '排队中', running: '生成中', completed: '已完成', failed: '生成失败', cancelled: '已取消', interrupted: '已中断'
};
const displayStatus = { queued: 'pending', running: 'running', success: 'completed', failed: 'failed', canceled: 'cancelled' };
const retryableStatuses = new Set(['failed', 'cancelled']);

function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
}

function setHidden(element, hidden) {
    if (element.hidden !== hidden) element.hidden = hidden;
}

export function createImageGenerationBatchView({ node, documentRef, retryImage, openPreview, openError, openRunError }) {
    const element = documentRef.createElement('section');
    element.className = 'image-generation-batch';
    element.hidden = true;
    element.setAttribute('aria-label', '本轮生成');
    element.innerHTML = `<div class="image-generation-batch-heading" hidden>
        <div class="image-generation-batch-totals" role="status">
            <span class="image-generation-batch-count functional-animation"></span>
            <span class="image-generation-batch-issues" hidden></span>
        </div>
        <button type="button" class="image-generation-batch-toggle" data-image-batch-toggle data-node-read-action
            aria-expanded="false" hidden>查看明细</button>
    </div>
    <ol class="image-generation-batch-list" role="list" hidden></ol>
    <p class="image-generation-batch-note" role="status" hidden></p>`;
    const heading = element.querySelector('.image-generation-batch-heading');
    const count = heading.querySelector('.image-generation-batch-count');
    const issues = heading.querySelector('.image-generation-batch-issues');
    const toggle = heading.querySelector('button');
    const list = element.querySelector('ol');
    list.id = `${node.id}-generation-batch-list`;
    toggle.setAttribute('aria-controls', list.id);
    const note = element.querySelector('.image-generation-batch-note');
    const rows = [];
    let batchId;
    let retrying = false;
    let blocked = true;
    let activeRun = false;
    let retryMessage = '';
    let expanded = false;

    toggle.addEventListener('click', () => {
        expanded = !expanded;
        refresh({ blocked });
    });

    function createRow(index) {
        const row = documentRef.createElement('li');
        row.className = 'image-generation-batch-row';
        row.dataset.imageBatchSlot = String(index);
        row.tabIndex = -1;
        row.innerHTML = `<div class="image-generation-batch-item">
            <div class="image-generation-batch-identity">
                <span class="image-generation-batch-name"></span>
                <button type="button" class="image-generation-batch-preview" data-image-batch-preview data-node-read-action hidden><img alt=""></button>
            </div>
            <div class="image-generation-batch-actions">
                <span class="image-generation-batch-status functional-animation"></span>
                <button type="button" class="image-parameter-failure-button" data-image-batch-error data-node-read-action
                    aria-haspopup="dialog" hidden>查看原因</button>
                <button type="button" class="image-generation-batch-retry" data-image-batch-retry hidden>重试</button>
            </div>
        </div>`;
        const name = `第 ${index + 1} 张`;
        const nameLabel = row.querySelector('.image-generation-batch-name');
        setText(nameLabel, name);
        const preview = row.querySelector('[data-image-batch-preview]');
        preview.setAttribute('aria-label', `预览${name}图片`);
        const retry = row.querySelector('[data-image-batch-retry]');
        retry.setAttribute('aria-label', `重试${name}图片`);
        const error = row.querySelector('[data-image-batch-error]');
        error.setAttribute('aria-label', `查看原因（${name}）`);
        const slot = { row, nameLabel, preview, retry, error, image: preview.querySelector('img'), status: row.querySelector('.image-generation-batch-status'), source: '' };
        preview.addEventListener('click', () => {
            const available = rows.filter(item => item.source);
            const activeIndex = available.indexOf(slot);
            if (activeIndex < 0) return;
            openPreview(available.map(item => item.source), activeIndex, () => {
                if (!preview.disabled && preview.isConnected && preview.checkVisibility() && !preview.closest('[inert]')) preview.focus({ preventScroll: true });
            });
        });
        error.addEventListener('click', () => {
            if (error.hidden) return;
            const requests = node.data?.concurrentRequestStatus?.requests;
            if (requests?.length === 1 && node.executionFailure && openRunError()) return;
            openError(name, requests?.[index]?.error || node.executionFailure?.message || '本次请求没有返回图片。');
        });
        retry.addEventListener('click', async () => {
            if (retry.disabled || blocked || retrying || !batchId || !retryableStatuses.has(row.dataset.status)) return;
            const retryBatchId = batchId;
            retrying = true;
            retryMessage = '';
            if (documentRef.activeElement === retry) row.focus({ preventScroll: true });
            refresh({ blocked });
            try {
                const result = await retryImage(index, retryBatchId);
                if (batchId === retryBatchId) {
                    const error = result?.error || result?.nodeResults?.find(item => item.nodeId === node.id)?.error;
                    retryMessage = error ? (error === node.executionFailure?.message && row.dataset.status === 'failed' ? '' : error)
                        : result?.executed === false || result === false ? '重试未启动，请检查当前参数后再试。' : '';
                }
            } catch (error) {
                if (batchId === retryBatchId) retryMessage = error?.message || '重试未启动，请稍后再试。';
            } finally {
                retrying = false;
                refresh({ blocked });
            }
        });
        list.append(row);
        return slot;
    }

    function refresh({ blocked: controlsLocked, running = activeRun }) {
        blocked = controlsLocked;
        activeRun = running;
        const batch = node.data?.concurrentRequestStatus;
        const requests = batch?.requests || [];
        const single = requests.length === 1;
        const multiple = requests.length > 1;
        const waiting = node.runStatus === 'waiting';
        const visible = requests.length > 0 || activeRun;
        const hasRetryRecord = Boolean(batch?.batchId && batch?.recipeFingerprint);
        if (batchId !== batch?.batchId) {
            batchId = batch?.batchId;
            retryMessage = '';
            expanded = false;
        }
        if (!multiple) expanded = false;
        setHidden(element, !visible);
        setHidden(heading, single);
        setHidden(toggle, !multiple);
        setHidden(list, !single && !expanded);
        if (toggle.getAttribute('aria-expanded') !== String(expanded)) toggle.setAttribute('aria-expanded', String(expanded));
        setText(toggle, expanded ? '收起明细' : '查看明细');
        while (rows.length > requests.length) rows.pop().row.remove();
        const savedImages = requests.length ? getCanonicalImageList(node) : [];
        let completed = 0, failed = 0, cancelled = 0, interrupted = 0, hasRetryableSlot = false;
        for (const [index, request] of requests.entries()) {
            const slot = rows[index] ?? (rows[index] = createRow(index));
            const recordedStatus = displayStatus[request.status] || 'pending';
            const status = !activeRun && (recordedStatus === 'pending' || recordedStatus === 'running') ? 'interrupted' : recordedStatus;
            if (slot.row.dataset.status !== status) slot.row.dataset.status = status;
            const label = single && status === 'running' ? '正在生成 1 张图片'
                : single && status === 'completed' ? '已生成 1 张图片' : statusLabels[status];
            setText(slot.status, label);
            setHidden(slot.nameLabel, single);
            setHidden(slot.error, status !== 'failed');
            if (single && !slot.status.hasAttribute('aria-live')) slot.status.setAttribute('aria-live', 'polite');
            if (!single) slot.status.removeAttribute('aria-live');
            if (status === 'completed') completed += 1;
            if (status === 'failed') failed += 1;
            if (status === 'cancelled') cancelled += 1;
            if (status === 'interrupted') interrupted += 1;
            const resultIndex = Number.isInteger(request.resultIndex) ? request.resultIndex : -1;
            const assetKey = node.data?.mediaAssetKeys?.[resultIndex];
            const assetUrl = typeof assetKey === 'string' && assetKey.startsWith('media:') ? `/api/storage/assets/${encodeURIComponent(assetKey)}` : '';
            const source = status === 'completed'
                ? node.imageGenerationRequestImages?.[index] || assetUrl || savedImages[resultIndex] || '' : '';
            if (slot.source !== source) {
                slot.source = source;
                if (source) slot.image.src = source;
                else slot.image.removeAttribute('src');
            }
            setHidden(slot.preview, !source);
            const retryable = retryableStatuses.has(status);
            hasRetryableSlot ||= retryable;
            setHidden(slot.retry, !retryable);
            const disabled = blocked || retrying || !hasRetryRecord;
            if (slot.retry.disabled !== disabled) slot.retry.disabled = disabled;
        }
        const status = single ? rows[0].row.dataset.status : activeRun ? (waiting ? 'pending' : 'running')
            : failed ? 'failed' : completed === requests.length ? 'completed' : cancelled ? 'cancelled' : 'interrupted';
        if (element.dataset.status !== status) element.dataset.status = status;
        element.classList.toggle('is-single', single);
        element.classList.toggle('has-failures', failed > 0);
        const activeLabel = node.data?.imageTaskId ? '正在恢复图片任务' : '正在准备生成';
        setText(count, multiple ? `已完成 ${completed}/${requests.length} 张` : waiting ? '等待上游' : activeLabel);
        const issueText = [failed && `${failed} 张失败`, cancelled && `${cancelled} 张已取消`, interrupted && `${interrupted} 张已中断`].filter(Boolean).join(' · ');
        setText(issues, issueText);
        setHidden(issues, !issueText);
        const message = retryMessage || (hasRetryableSlot && !hasRetryRecord && (single || expanded) ? '此批次缺少重试所需的记录，重新生成后可逐张重试。' : '');
        setText(note, message);
        setHidden(note, !message);
        return { hasRequests: requests.length > 0, allFailed: failed > 0 && failed === requests.length };
    }

    return { element, refresh };
}
