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

export function createImageGenerationBatchView({ node, documentRef, progress, progressFallback, retryImage, openPreview }) {
    const element = documentRef.createElement('section');
    element.className = 'image-generation-batch';
    element.hidden = true;
    element.setAttribute('aria-labelledby', `${node.id}-generation-batch-title`);
    element.innerHTML = `<header class="image-generation-batch-heading">
        <h3>生成队列</h3>
        <div class="image-generation-batch-totals">
            <span class="image-generation-batch-failures" hidden></span>
            <span class="image-generation-batch-count" hidden></span>
        </div>
    </header>
    <ol class="image-generation-batch-list" role="list"></ol>
    <p class="image-generation-batch-note" role="status" hidden></p>`;
    element.querySelector('h3').id = `${node.id}-generation-batch-title`;
    const totals = element.querySelector('.image-generation-batch-totals');
    const count = totals.querySelector('.image-generation-batch-count');
    const failures = totals.querySelector('.image-generation-batch-failures');
    const list = element.querySelector('ol');
    const note = element.querySelector('.image-generation-batch-note');
    const rows = [];
    let batchId;
    let retrying = false;
    let blocked = true;
    let activeRun = false;
    let retryMessage = '';

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
                <span class="image-generation-batch-status"></span>
                <button type="button" class="image-generation-batch-retry" data-image-batch-retry hidden>重试</button>
            </div>
        </div>
        <details class="image-generation-batch-error" hidden><summary>失败原因</summary><p></p></details>`;
        const name = `第 ${index + 1} 张`;
        setText(row.querySelector('.image-generation-batch-name'), name);
        const preview = row.querySelector('[data-image-batch-preview]');
        preview.setAttribute('aria-label', `预览${name}图片`);
        const retry = row.querySelector('[data-image-batch-retry]');
        retry.setAttribute('aria-label', `重试${name}图片`);
        const error = row.querySelector('details');
        const slot = { row, preview, retry, error, message: error.querySelector('p'), image: preview.querySelector('img'), status: row.querySelector('.image-generation-batch-status'), source: '' };
        preview.addEventListener('click', () => {
            const available = rows.filter(item => item.source);
            const activeIndex = available.indexOf(slot);
            if (activeIndex < 0) return;
            openPreview(available.map(item => item.source), activeIndex, () => {
                if (!preview.disabled && preview.isConnected && preview.checkVisibility() && !preview.closest('[inert]')) preview.focus({ preventScroll: true });
            });
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
                    retryMessage = error ? (error === node.executionFailure?.message ? '' : error)
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
        const hasRetryRecord = Boolean(batch?.batchId && batch?.recipeFingerprint);
        if (batchId !== batch?.batchId) {
            batchId = batch?.batchId;
            retryMessage = '';
            for (const { error } of rows) error.open = false;
        }
        setHidden(element, !requests.length);
        const progressParent = requests.length ? totals : progressFallback;
        if (progress && progressParent && progress.parentNode !== progressParent) progressParent.append(progress);
        while (rows.length > requests.length) rows.pop().row.remove();
        if (!requests.length) return;
        const savedImages = getCanonicalImageList(node);
        let completed = 0, failed = 0, hasRetryableSlot = false;
        for (const [index, request] of requests.entries()) {
            const slot = rows[index] ?? (rows[index] = createRow(index));
            const recordedStatus = displayStatus[request.status] || 'pending';
            const status = !activeRun && (recordedStatus === 'pending' || recordedStatus === 'running') ? 'interrupted' : recordedStatus;
            if (slot.row.dataset.status !== status) slot.row.dataset.status = status;
            setText(slot.status, statusLabels[status]);
            if (status === 'completed') completed += 1;
            if (status === 'failed') failed += 1;
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
            setText(slot.message, request.error || '本次请求没有返回图片。');
            setHidden(slot.error, status !== 'failed' || (requests.length === 1 && !!node.executionFailure?.message));
            if (slot.error.hidden && slot.error.open) slot.error.open = false;
        }
        setHidden(failures, failed === 0);
        setText(failures, `${failed} 张失败`);
        setHidden(count, !!progress && !progress.hidden);
        setText(count, `${completed}/${requests.length} 完成`);
        const message = retryMessage || (hasRetryableSlot && !hasRetryRecord ? '此批次缺少重试所需的记录，重新生成后可逐张重试。' : '');
        setText(note, message);
        setHidden(note, !message);
    }

    return { element, refresh };
}
