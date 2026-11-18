import { COMMERCE_CANDIDATE_GENERATION_LIMIT } from './commerce-image-set-plan.js';
import { buildVisualStylePrompt } from '../visual-style/visual-style.js';
import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';

export function openCommerceShotCandidates({ documentRef, opener, shot, current, candidates, finalized, getAssetUrl, onApply, onClose, openPreview, onGenerate, onCancel, candidateCount = 1 }) {
    const dialog = documentRef.createElement('dialog');
    dialog.id = 'commerce-candidates-dialog';
    dialog.className = 'dialog-style-1 commerce-candidates-dialog';
    dialog.setAttribute('aria-labelledby', 'commerce-candidates-title');
    const preview = (type, label) => `<figure data-commerce-${type}-preview>
        <figcaption>${label}</figcaption>
        <button type="button" class="commerce-candidate-image" aria-label="预览${label}"><img alt="${label}"><span role="status" hidden></span></button>
        <p class="commerce-candidate-copy" hidden></p>
        <details class="commerce-candidate-prompt" hidden><summary>生图提示词</summary><p></p></details>
    </figure>`;
    dialog.innerHTML = `<div class="dialog-style-1-panel">
        <header class="dialog-style-1-header">
            <h2 id="commerce-candidates-title"></h2>
            <button type="button" class="dialog-style-1-close" aria-label="关闭候选对比">×</button>
        </header>
        <div class="dialog-style-1-body">
            <div class="commerce-candidate-comparison">
                ${preview('current', '当前成图')}
                ${preview('candidate', '候选版本')}
            </div>
            <div class="commerce-candidate-gallery">
                <h3>候选图片 <span data-commerce-candidate-count></span></h3>
                <div class="commerce-candidate-options" role="group" aria-label="选择对比候选"></div>
            </div>
            <div class="commerce-candidate-generation">
                <label>生成张数 <select class="ui-select" data-commerce-candidate-quantity aria-label="生成张数"></select></label>
                <button type="button" class="btn btn-secondary" data-commerce-candidate-generate>再生成</button>
                <button type="button" class="btn btn-secondary" data-commerce-candidate-cancel hidden>停止生成</button>
                <span>每张调用一次模型，生成后手动采用</span>
            </div>
            <p class="commerce-candidate-progress" role="status" hidden></p>
            <p class="commerce-candidate-hint"></p>
            <p class="commerce-candidate-error" role="alert" hidden></p>
        </div>
        <footer class="dialog-style-1-footer">
            <button type="button" class="btn btn-secondary" data-commerce-candidate-close>关闭</button>
            <button type="button" class="btn btn-primary" data-commerce-candidate-apply disabled>采用选中图片</button>
        </footer>
    </div>`;
    dialog.querySelector('h2').textContent = `${shot.label} · 候选对比`;
    dialog.querySelector('.commerce-candidate-hint').textContent = finalized
        ? '解锁图位后可采用候选。' : '点击上方图片可放大预览。采用后将一并恢复该版本的文案和提示词。';
    const currentPreview = dialog.querySelector('[data-commerce-current-preview]');
    const candidatePreview = dialog.querySelector('[data-commerce-candidate-preview]');
    const apply = dialog.querySelector('[data-commerce-candidate-apply]');
    const error = dialog.querySelector('.commerce-candidate-error');
    const closeButtons = Array.from(dialog.querySelectorAll('.dialog-style-1-close, [data-commerce-candidate-close]'));
    const surfaces = getSurfaceCoordinator(documentRef);
    let selected = candidates[0];
    let saving = false;
    let generating = false;
    let suspended = false;
    let unregisterEscape;
    const generate = dialog.querySelector('[data-commerce-candidate-generate]');
    const cancel = dialog.querySelector('[data-commerce-candidate-cancel]');
    const quantity = dialog.querySelector('[data-commerce-candidate-quantity]');
    const progress = dialog.querySelector('.commerce-candidate-progress');
    for (let count = 1; count <= COMMERCE_CANDIDATE_GENERATION_LIMIT; count++) {
        const option = documentRef.createElement('option');
        option.value = String(count);
        option.textContent = `${count} 张`;
        quantity.append(option);
    }
    quantity.value = String(candidateCount);
    dialog.querySelector('.commerce-candidate-generation').hidden = !onGenerate;
    generate.disabled = quantity.disabled = finalized;

    let closed = false;

    let options = [];
    const optionGroup = dialog.querySelector('.commerce-candidate-options');
    function renderOptions() {
        options = candidates.map((candidate, index) => {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.dataset.commerceCandidate = candidate.key;
            button.setAttribute('aria-label', `选择候选 ${index + 1}`);
            const image = documentRef.createElement('img');
            image.alt = '';
            image.loading = 'lazy';
            const source = getAssetUrl(candidate.assetKey);
            if (source) image.src = source;
            const label = documentRef.createElement('span');
            label.textContent = `候选 ${index + 1}`;
            image.addEventListener('error', () => { image.hidden = true; label.textContent = `候选 ${index + 1} · 无法读取`; });
            button.append(image, label);
            button.addEventListener('click', () => {
                selected = candidate;
                setError('');
                renderSelection();
            });
            return button;
        });
        optionGroup.replaceChildren(...options);
        dialog.querySelector('[data-commerce-candidate-count]').textContent = `（${candidates.length} 张）`;
    }

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
        const message = !image.hasAttribute('src') ? (figure === candidatePreview ? '暂无候选，可点击再生成' : '暂无当前成图')
            : available ? '' : image.complete ? '图片无法读取' : '正在加载…';
        if (status.textContent !== message) status.textContent = message;
        figure.querySelector('.commerce-candidate-image').disabled = !available || !openPreview || saving;
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
        apply.disabled = saving || finalized || !available || !selected?.draft;
    }

    function renderSelection() {
        for (const option of options) {
            option.disabled = saving;
            option.setAttribute('aria-pressed', String(option.dataset.commerceCandidate === selected?.key));
        }
        renderPreview(candidatePreview, selected);
        updateApply();
    }

    function close() {
        if (closed) return;
        closed = true;
        unregisterEscape?.();
        dialog.close();
        dialog.remove();
        surfaces?.refresh();
        if (opener?.isConnected && !opener.closest('[hidden], [inert]')) opener.focus({ preventScroll: true });
        onClose?.();
    }

    function requestClose(event) {
        event?.preventDefault();
        if (!saving && !suspended) close();
    }

    for (const event of ['load', 'error']) {
        currentPreview.querySelector('img').addEventListener(event, () => updateImageStatus(currentPreview));
        candidatePreview.querySelector('img').addEventListener(event, updateApply);
    }
    closeButtons.forEach(button => button.addEventListener('click', requestClose));
    dialog.addEventListener('cancel', requestClose);
    dialog.addEventListener('close', () => { if (!suspended && !dialog.open) close(); });
    apply.addEventListener('click', async () => {
        if (apply.disabled) return;
        saving = true;
        setError('');
        options.forEach(button => { button.disabled = true; });
        closeButtons.forEach(button => { button.disabled = true; });
        generate.disabled = quantity.disabled = true;
        updateImageStatus(currentPreview);
        apply.textContent = '正在采用…';
        updateApply();
        try {
            await onApply(selected?.key);
            close();
        } catch (cause) {
            if (closed) return;
            setError(cause?.message || '无法采用选中图片，请重试。');
            saving = false;
            closeButtons.forEach(button => { button.disabled = false; });
            generate.disabled = quantity.disabled = finalized;
            updateImageStatus(currentPreview);
            apply.textContent = '采用选中图片';
            renderSelection();
            (apply.disabled ? closeButtons[1] : apply).focus({ preventScroll: true });
        }
    });

    async function previewVersion(version, button) {
        if (!version || saving || !openPreview) return;
        const versions = [current, ...candidates].filter(item => item && getAssetUrl(item.assetKey));
        const index = versions.indexOf(version);
        if (index < 0) return;
        suspended = true;
        dialog.close();
        surfaces?.refresh();
        const restore = () => {
            if (closed || !suspended) return;
            suspended = false;
            dialog.showModal();
            surfaces?.refresh();
            button.focus({ preventScroll: true });
        };
        try { await openPreview(versions.map(item => getAssetUrl(item.assetKey)), index, restore); }
        catch (cause) { restore(); setError(cause?.message || '无法打开图片预览。'); }
    }
    const currentButton = currentPreview.querySelector('button');
    const candidateButton = candidatePreview.querySelector('button');
    currentButton.addEventListener('click', () => void previewVersion(current, currentButton));
    candidateButton.addEventListener('click', () => void previewVersion(selected, candidateButton));
    cancel.addEventListener('click', async () => {
        cancel.disabled = true;
        progress.textContent = '正在停止生成并保存已完成的候选…';
        try {
            if (await onCancel?.() === false) throw new Error('未能停止生成，请重试。');
        } catch (cause) {
            setError(cause?.message || '停止失败，请重试。');
            if (generating) cancel.disabled = false;
        }
    });
    generate.addEventListener('click', async () => {
        if (saving || finalized || !onGenerate) return;
        saving = generating = true;
        setError('');
        generate.disabled = quantity.disabled = true;
        cancel.hidden = !onCancel;
        cancel.disabled = false;
        closeButtons.forEach(button => { button.disabled = true; });
        const before = new Set(candidates.map(item => item.key));
        const requested = Number(quantity.value);
        progress.hidden = false;
        progress.textContent = `正在生成 ${requested} 张候选…`;
        renderSelection();
        updateImageStatus(currentPreview);
        try {
            const result = await onGenerate(requested);
            if (closed) return;
            current = result.current;
            candidates = result.candidates;
            selected = candidates.find(item => item.key === selected?.key) || candidates[0];
            renderOptions();
            const added = candidates.filter(item => !before.has(item.key)).length;
            progress.textContent = result.message || `已新增 ${added} 张候选${added < requested ? `（请求 ${requested} 张，部分未生成或与已有图片重复）` : ''}，请选择后采用。`;
        } catch (cause) {
            progress.hidden = true;
            setError(cause?.message || '生成失败，请重试。');
        } finally {
            saving = generating = false;
            if (!closed) {
                generate.disabled = quantity.disabled = finalized;
                cancel.hidden = true;
                closeButtons.forEach(button => { button.disabled = false; });
                renderPreview(currentPreview, current);
                renderSelection();
                generate.focus({ preventScroll: true });
            }
        }
    });
    renderOptions();
    renderPreview(currentPreview, current);
    renderSelection();
    documentRef.body.append(dialog);
    try {
        dialog.showModal();
        unregisterEscape = surfaces?.registerEscape(dialog, requestClose);
        (options[0] || closeButtons[0]).focus({ preventScroll: true });
    } catch (cause) {
        close();
        throw cause;
    }
    return close;
}
