let deleting = false;

/** Runs confirmed file snapshots, keeping progress tied to completed requests. */
export async function deleteHistoryWithProgress(items, deleteEntry, documentRef = document) {
    if (deleting) throw new Error('正在删除历史记录，请等待完成');
    if (!items.length) return;
    deleting = true;
    let dialog;
    let completed = 0;
    let failed = 0;
    let firstError = '';
    try {
        if (items.length > 1) {
            dialog = documentRef.createElement('dialog');
            dialog.className = 'history-delete-progress';
            dialog.setAttribute('aria-label', '删除历史记录');
            dialog.innerHTML = '<h3>正在删除历史记录</h3><p class="history-delete-count" role="status" aria-live="polite"></p><progress aria-label="删除进度"></progress><p class="history-delete-result"></p><button type="button" disabled>完成</button>';
            dialog.addEventListener('cancel', event => {
                event.preventDefault();
                if (completed === items.length) { dialog.close(); dialog.remove(); }
            });
            dialog.querySelector('button').onclick = () => { dialog.close(); dialog.remove(); };
            documentRef.body.append(dialog);
            dialog.showModal();
        }
        const update = () => {
            if (!dialog) return;
            const progress = dialog.querySelector('progress');
            progress.max = items.length;
            progress.value = completed;
            dialog.querySelector('.history-delete-count').textContent = `已处理 ${completed} / ${items.length}（${Math.round(completed / items.length * 100)}%）`;
            dialog.querySelector('.history-delete-result').textContent = `已删除 ${completed - failed} · 失败 ${failed}`;
        };
        update();
        for (const item of items) {
            try { await deleteEntry(item); }
            catch (error) { failed++; firstError ||= error.message || '删除失败'; }
            completed++;
            update();
        }
        if (dialog) {
            dialog.querySelector('h3').textContent = failed ? '删除结束，部分文件未删除' : '删除完成';
            dialog.querySelector('button').disabled = false;
            dialog.querySelector('button').focus();
        }
        if (failed) throw new Error(`已删除 ${completed - failed} 项，${failed} 项失败：${firstError}`);
    } finally {
        deleting = false;
        if (dialog && completed !== items.length) { dialog.close(); dialog.remove(); }
    }
}
