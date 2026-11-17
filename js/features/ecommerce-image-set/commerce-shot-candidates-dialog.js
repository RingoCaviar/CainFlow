import { buildVisualStylePrompt } from '../visual-style/visual-style.js';
import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';

export function openCommerceShotCandidates({ documentRef, opener, shot, current, candidates, finalized, getAssetUrl, onApply, onClose }) {
    const dialog = documentRef.createElement('dialog');
    dialog.id = 'commerce-candidates-dialog';
    dialog.className = 'dialog-style-1 commerce-candidates-dialog';
    dialog.setAttribute('aria-labelledby', 'commerce-candidates-title');
    const preview = (type, label) => `<figure data-commerce-${type}-preview>
        <figcaption>${label}</figcaption>
        <div class="commerce-candidate-image"><img alt=""><p role="status" hidden></p></div>
        <p class="commerce-candidate-copy" hidden></p>
        <details class="commerce-candidate-prompt" hidden><summary>生图提示词</summary><p></p></details>
    </figure>`;
    dialog.innerHTML = `<div class="dialog-style-1-panel">
        <header class="dialog-style-1-header">
            <h2 id="commerce-candidates-title"></h2>
            <button type="button" class="dialog-style-1-close" aria-label="关闭候选对比">×</button>
        </header>
        <div class="dialog-style-1-body">
            <div class="commerce-candidate-options" role="group" aria-label="选择对比候选"></div>
            <div class="commerce-candidate-comparison">
                ${preview('current', '当前成图')}
                ${preview('candidate', '候选版本')}
            </div>
            <p class="commerce-candidate-hint"></p>
            <p class="commerce-candidate-error" role="alert" hidden></p>
        </div>
        <footer class="dialog-style-1-footer">
            <button type="button" class="btn btn-secondary" data-commerce-candidate-close>关闭</button>
            <button type="button" class="btn btn-primary" data-commerce-candidate-apply disabled>采用此版本</button>
        </footer>
    </div>`;
    dialog.querySelector('h2').textContent = `${shot.label} · 候选对比`;
    dialog.querySelector('.commerce-candidate-hint').textContent = finalized
        ? '解锁图位后可采用候选。' : '采用后将一并恢复该版本的文案和提示词。';
    const currentPreview = dialog.querySelector('[data-commerce-current-preview]');
    const candidatePreview = dialog.querySelector('[data-commerce-candidate-preview]');
    const apply = dialog.querySelector('[data-commerce-candidate-apply]');
    const error = dialog.querySelector('.commerce-candidate-error');
    const closeButtons = Array.from(dialog.querySelectorAll('.dialog-style-1-close, [data-commerce-candidate-close]'));
    const surfaces = getSurfaceCoordinator(documentRef);
    let selected = candidates[0];
    let saving = false;
    let closed = false;

    const options = candidates.map((candidate, index) => {
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.dataset.commerceCandidate = candidate.key;
        button.textContent = `候选 ${index + 1}`;
        if (!index) button.autofocus = true;
        button.addEventListener('click', () => {
            selected = candidate;
            setError('');
            renderSelection();
        });
        return button;
    });
    const optionGroup = dialog.querySelector('.commerce-candidate-options');
    optionGroup.append(...options);
    optionGroup.hidden = options.length === 1;

    function setError(message) {
        error.textContent = message;
        error.hidden = !message;
    }

    function updateImageStatus(figure) {
        const image = figure.querySelector('img');
        const status = figure.querySelector('[role="status"]');
        const available = image.complete && image.naturalWidth > 0;
        status.hidden = available;
        image.classList.toggle('is-available', available);
        const message = !image.hasAttribute('src') ? '暂无当前成图'
            : available ? '' : image.complete ? '图片无法读取' : '正在加载…';
        if (status.textContent !== message) status.textContent = message;
        return available;
    }

    function renderPreview(figure, version) {
        const image = figure.querySelector('img');
        const source = version ? getAssetUrl(version.assetKey) : '';
        if (!source) image.removeAttribute('src');
        else if (image.getAttribute('src') !== source) image.src = source;
        const copy = figure.querySelector('.commerce-candidate-copy');
        copy.textContent = [version?.draft?.headline, version?.draft?.body].filter(Boolean).join('\n');
        copy.hidden = !copy.textContent;
        const prompt = figure.querySelector('.commerce-candidate-prompt');
        prompt.querySelector('p').textContent = [version?.draft?.prompt, buildVisualStylePrompt(version?.draft?.visualStyleSnapshot, { lettering: !!(version?.draft?.headline || version?.draft?.body) })].filter(Boolean).join('\n\n');
        prompt.hidden = !version?.draft?.prompt;
        updateImageStatus(figure);
    }

    function updateApply() {
        const available = updateImageStatus(candidatePreview);
        apply.disabled = saving || finalized || !available || !selected.draft;
    }

    function renderSelection() {
        for (const option of options) {
            option.disabled = saving;
            option.setAttribute('aria-pressed', String(option.dataset.commerceCandidate === selected.key));
        }
        renderPreview(candidatePreview, selected);
        updateApply();
    }

    function close() {
        if (closed) return;
        closed = true;
        dialog.close();
        dialog.remove();
        surfaces?.refresh();
        if (opener?.isConnected && !opener.closest('[hidden], [inert]')) opener.focus({ preventScroll: true });
        onClose?.();
    }

    function requestClose(event) {
        event?.preventDefault();
        if (!saving) close();
    }

    for (const event of ['load', 'error']) {
        currentPreview.querySelector('img').addEventListener(event, () => updateImageStatus(currentPreview));
        candidatePreview.querySelector('img').addEventListener(event, updateApply);
    }
    closeButtons.forEach(button => button.addEventListener('click', requestClose));
    dialog.addEventListener('cancel', requestClose);
    dialog.addEventListener('close', close);
    apply.addEventListener('click', async () => {
        if (apply.disabled) return;
        saving = true;
        setError('');
        options.forEach(button => { button.disabled = true; });
        closeButtons.forEach(button => { button.disabled = true; });
        apply.textContent = '正在采用…';
        updateApply();
        try {
            await onApply(selected.key);
            close();
        } catch (cause) {
            if (closed) return;
            setError(cause?.message || '无法采用此版本，请重试。');
            saving = false;
            closeButtons.forEach(button => { button.disabled = false; });
            apply.textContent = '采用此版本';
            renderSelection();
            (apply.disabled ? closeButtons[1] : apply).focus({ preventScroll: true });
        }
    });

    renderPreview(currentPreview, current);
    renderSelection();
    documentRef.body.append(dialog);
    try {
        dialog.showModal();
        surfaces?.registerEscape(dialog, requestClose);
        if (optionGroup.hidden) closeButtons[0].focus({ preventScroll: true });
    } catch (cause) {
        close();
        throw cause;
    }
    return close;
}
