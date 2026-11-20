import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';
import { COMMERCE_SCENE_DESCRIPTION_LIMIT } from './commerce-image-set-plan.js';

export function openCommerceDetailPage({ documentRef, opener, getPage, onLayout, onClose }) {
    const windowRef = documentRef.defaultView;
    const surfaces = getSurfaceCoordinator(documentRef);
    const dialog = documentRef.createElement('dialog');
    dialog.id = 'commerce-detail-page-dialog';
    dialog.className = 'dialog-style-1 commerce-detail-page-dialog';
    dialog.setAttribute('aria-labelledby', 'commerce-detail-page-title');
    dialog.innerHTML = `
        <div class="dialog-style-1-panel">
            <header class="dialog-style-1-header">
                <h2 id="commerce-detail-page-title">详情图连续预览</h2>
                <button type="button" class="dialog-style-1-close" aria-label="关闭详情图预览">×</button>
            </header>
            <div class="dialog-style-1-body commerce-detail-page-body">
                <div class="commerce-detail-page-preview" tabindex="0" aria-label="详情图成图预览">
                    <p class="dialog-style-1-note" data-detail-preview-feedback role="status"></p>
                    <div data-detail-preview-art></div>
                </div>
                <div class="commerce-detail-page-controls">
                    <label>调整范围<select class="ui-select" data-detail-section autofocus></select></label>
                    <form class="commerce-detail-page-layout">
                        <label>排版指令<textarea rows="2" maxlength="${COMMERCE_SCENE_DESCRIPTION_LIMIT}" data-detail-direction></textarea></label>
                        <button type="submit" class="btn btn-primary" data-detail-revise disabled>更新版式方案</button>
                    </form>
                    <p class="dialog-style-1-note" data-detail-feedback role="status" hidden></p>
                    <p class="dialog-style-1-note commerce-detail-page-error" data-detail-error role="alert" hidden></p>
                </div>
            </div>
        </div>`;

    const select = dialog.querySelector('[data-detail-section]');
    const direction = dialog.querySelector('[data-detail-direction]');
    const revise = dialog.querySelector('[data-detail-revise]');
    const viewport = dialog.querySelector('.commerce-detail-page-preview');
    const art = dialog.querySelector('[data-detail-preview-art]');
    const previewFeedback = dialog.querySelector('[data-detail-preview-feedback]');
    const feedback = dialog.querySelector('[data-detail-feedback]');
    const errorFeedback = dialog.querySelector('[data-detail-error]');
    const previews = new Map();
    const failures = new Set();
    let projection;
    let optionsKey = '';
    let imageKey = '';
    let running = false;
    let closed = false;

    function setMessage(element, message) {
        element.hidden = !message;
        if (element.textContent !== message) element.textContent = message;
    }

    function setPreviewStatus() {
        const sections = projection?.sections || [];
        const missing = sections.filter(section => !section.image).length;
        const previous = sections.filter(section => section.previous && section.image).length;
        const visible = previews.size - failures.size;
        const messages = [
            visible === 0 && !failures.size ? '生成详情图后可在这里连续预览。' : '',
            visible > 0 && missing ? `还有 ${missing} 个图位未出图。` : '',
            previous ? `含 ${previous} 张上一版成图。` : '',
            failures.size ? `有 ${failures.size} 张成图无法读取，请检查原图。` : ''
        ];
        setMessage(previewFeedback, messages.filter(Boolean).join(' '));
    }

    function scrollToSection() {
        const image = previews.get(select.value);
        if (image && !image.hidden) viewport.scrollTop = image.offsetTop;
        else if (!select.value) viewport.scrollTop = 0;
    }

    function updateImages(sections) {
        const key = JSON.stringify(sections.map(({ shotId, label, image }) => [shotId, label, image]));
        if (key === imageKey) return;
        imageKey = key;
        previews.clear();
        failures.clear();
        for (const section of sections) {
            if (!section.image) continue;
            const image = documentRef.createElement('img');
            image.alt = section.label;
            image.dataset.detailPreviewShot = section.shotId;
            image.decoding = 'async';
            image.addEventListener('load', () => {
                if (select.value === section.shotId) scrollToSection();
            });
            image.addEventListener('error', () => {
                if (previews.get(section.shotId) !== image) return;
                failures.add(section.shotId);
                image.hidden = true;
                setPreviewStatus();
            });
            previews.set(section.shotId, image);
            image.src = section.image;
        }
        art.replaceChildren(...previews.values());
    }

    function setControls() {
        const section = projection?.sections.find(item => item.shotId === select.value);
        select.disabled = running || !projection?.sections.length;
        direction.disabled = running || projection?.busy || !projection?.editable || !!section?.finalized;
        direction.placeholder = section ? '例如：把标题放到图片右上角' : '例如：相邻两张统一背景色，过渡更自然';
        revise.disabled = direction.disabled || !direction.value.trim();
    }

    function refresh() {
        if (closed) return;
        projection = getPage();
        const sections = projection.sections;
        const choices = JSON.stringify(sections.map(section => [section.shotId, section.label]));
        if (optionsKey !== choices) {
            optionsKey = choices;
            const selection = select.value;
            select.replaceChildren(new windowRef.Option('整页', ''),
                ...sections.map(section => new windowRef.Option(section.label, section.shotId)));
            if (sections.some(section => section.shotId === selection)) select.value = selection;
        }
        updateImages(sections);
        setPreviewStatus();
        setControls();
    }

    function close(event) {
        event?.preventDefault();
        if (closed) return;
        closed = true;
        previews.clear();
        dialog.close();
        dialog.remove();
        surfaces?.refresh();
        if (opener?.isConnected && !opener.closest('[hidden], [inert]')) opener.focus({ preventScroll: true });
        onClose?.();
    }

    select.addEventListener('change', () => {
        direction.value = '';
        setMessage(errorFeedback, '');
        setControls();
        scrollToSection();
    });
    direction.addEventListener('input', setControls);
    dialog.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault();
        if (revise.disabled) return;
        const text = direction.value.trim();
        running = true;
        setMessage(errorFeedback, '');
        setMessage(feedback, '正在更新版式方案…');
        setControls();
        try {
            await onLayout(select.value || undefined, text);
            direction.value = '';
            setMessage(feedback, '版式方案已更新。重新生成相关图位后可查看调整效果。');
        } catch (error) {
            setMessage(feedback, '');
            setMessage(errorFeedback, error?.message || '更新版式方案失败，请重试。');
        } finally {
            running = false;
            refresh();
        }
    });
    dialog.querySelector('.dialog-style-1-close').addEventListener('click', close);
    dialog.addEventListener('cancel', close);
    dialog.addEventListener('close', close);
    documentRef.body.append(dialog);
    try {
        dialog.showModal();
        surfaces?.registerEscape(dialog, close);
        refresh();
    } catch (error) {
        close();
        throw error;
    }
    return { refresh, close };
}
