import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';

export function chooseCommerceStyleReference({ documentRef, catalog, targetId, signal }) {
    if (signal?.aborted) return Promise.resolve(null);
    const dialog = documentRef.createElement('dialog');
    const surfaces = getSurfaceCoordinator(documentRef);
    dialog.className = 'dialog-style-1 commerce-reference-picker';
    dialog.setAttribute('aria-labelledby', 'commerce-reference-picker-title');
    dialog.innerHTML = `
        <div class="dialog-style-1-panel">
            <header class="dialog-style-1-header">
                <h2 id="commerce-reference-picker-title">选择风格参考图</h2>
                <button type="button" class="dialog-style-1-close" aria-label="关闭选图">×</button>
            </header>
            <div class="dialog-style-1-body">
                <div class="commerce-candidate-options" role="group" aria-label="图片来源">
                    <button type="button" class="btn" data-reference-source="canvas" autofocus>当前场景</button>
                    <button type="button" class="btn" data-reference-source="history">目录历史</button>
                </div>
                <p class="dialog-style-1-note" role="status"></p>
                <div class="commerce-reference-picker-images"></div>
                <button type="button" class="btn" data-reference-more hidden>加载更多</button>
            </div>
        </div>`;
    const tabs = dialog.querySelectorAll('[data-reference-source]');
    const choices = dialog.querySelector('.commerce-reference-picker-images');
    const feedback = dialog.querySelector('[role=status]');
    const more = dialog.querySelector('[data-reference-more]');
    const opener = documentRef.activeElement;
    let source, candidates, displayed, revision = 0;
    return new Promise(resolve => {
        function finish(candidate) {
            revision++;
            signal?.removeEventListener('abort', cancel);
            dialog.close();
            dialog.remove();
            surfaces?.refresh();
            if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
            resolve(candidate);
        }
        function cancel(event) {
            event?.preventDefault();
            finish(null);
        }
        function appendChoices() {
            const batch = candidates.slice(displayed, displayed + 48);
            for (const candidate of batch) {
                const button = documentRef.createElement('button');
                button.type = 'button';
                if (candidate.historyId) button.dataset.referenceHistory = candidate.historyId;
                else button.dataset.referenceNode = candidate.sourceNodeId;
                const image = documentRef.createElement('img');
                image.alt = '';
                image.loading = 'lazy';
                if (candidate.previewUrl) image.src = candidate.previewUrl;
                else if (candidate.assetKey?.startsWith('media:')) image.src = `/api/storage/assets/${encodeURIComponent(candidate.assetKey)}`;
                else void catalog.readThumbnail(candidate).then(src => {
                    if (src && image.isConnected) image.src = src;
                }).catch(() => {});
                const name = documentRef.createElement('span');
                name.textContent = candidate.name;
                button.title = candidate.name;
                button.append(image, name);
                button.addEventListener('click', () => finish(candidate));
                choices.append(button);
            }
            displayed += batch.length;
            more.hidden = displayed >= candidates.length;
        }
        async function showSource(next) {
            source = next;
            const request = ++revision;
            choices.replaceChildren();
            more.hidden = true;
            tabs.forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.referenceSource === next)));
            feedback.textContent = '正在读取图片…';
            try {
                const items = next === 'canvas' ? catalog.getCanvas() : await catalog.getScene();
                if (request !== revision) return;
                candidates = next === 'canvas' ? items.filter(item => item.sourceNodeId !== targetId)
                    : items.filter(item => item.kind === 'history');
                feedback.textContent = items.warning || (candidates.length ? ''
                    : next === 'canvas' ? '当前场景没有可用图片。' : '当前保存目录没有历史图片。');
                displayed = 0;
                appendChoices();
            } catch {
                if (request === revision) feedback.textContent = '读取图片失败，请重新选择来源。';
            }
        }
        tabs.forEach(tab => tab.addEventListener('click', () => {
            if (tab.dataset.referenceSource !== source || !choices.childElementCount) void showSource(tab.dataset.referenceSource);
        }));
        more.addEventListener('click', appendChoices);
        dialog.querySelector('.dialog-style-1-close').addEventListener('click', cancel);
        dialog.addEventListener('cancel', cancel);
        signal?.addEventListener('abort', cancel, { once: true });
        documentRef.body.append(dialog);
        dialog.showModal();
        surfaces?.registerEscape(dialog, cancel);
        void showSource('canvas');
    });
}
