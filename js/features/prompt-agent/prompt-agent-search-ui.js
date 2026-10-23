import { normalizeAgentSearch } from './prompt-agent-search-data.js';
import { renderAgentBody } from './prompt-agent-body.js';

export function createAgentSearchMenu({ documentRef, getSettings, setSettings,
    getCurrentModel = () => null, onChange = () => {} }) {
    const toggle = documentRef.getElementById('prompt-agent-search-enabled');
    const render = () => {
        if (!toggle) return;
        toggle.disabled = false;
        toggle.checked = getSettings().mode !== 'off';
    };
    toggle?.addEventListener('change', () => {
        setSettings({ ...getSettings(), mode: toggle.checked ? 'auto' : 'off' });
        onChange(); render();
    });
    render();
    return { close() {}, render, open: render };
}

function link(documentRef, source, label) {
    const element = documentRef.createElement('a');
    element.href = source.url; element.target = '_blank'; element.rel = 'noopener noreferrer'; element.textContent = label || source.title;
    return element;
}

export function renderAgentSearch({ documentRef, container, body, text, search, isCurrent, readImage, preview, importImage }) {
    const result = normalizeAgentSearch(search);
    if (!result) return;
    renderAgentBody({ documentRef, body, text, sources: result.sources });
    const section = documentRef.createElement('section'); section.className = 'prompt-agent-search-results';
    const status = documentRef.createElement('p'); status.className = 'prompt-agent-search-status'; status.setAttribute('aria-live', 'polite');
    status.textContent = [result.searched ? '已联网搜索' : '本轮未确认联网', result.notice].filter(Boolean).join(' · ');
    section.appendChild(status);
    if (result.sources.length) {
        const details = documentRef.createElement('details'), summary = documentRef.createElement('summary');
        summary.textContent = `来源（${result.sources.length}）`; details.appendChild(summary);
        for (const [index, source] of result.sources.entries()) {
            const item = documentRef.createElement('div'); item.appendChild(link(documentRef, source, `${index + 1}. ${source.title}`)); details.appendChild(item);
        }
        section.appendChild(details);
    }
    if (result.suggestionsHtml) {
        const frame = documentRef.createElement('iframe'); frame.title = 'Google 搜索建议';
        frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
        frame.referrerPolicy = 'no-referrer';
        frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src https: data:; base-uri \'none\'; form-action \'none\'">' + result.suggestionsHtml;
        section.appendChild(frame);
    }
    const grid = documentRef.createElement('div'); grid.className = 'prompt-agent-search-images';
    for (const image of result.images) {
        const card = documentRef.createElement('div'); card.className = 'prompt-agent-search-image';
        const thumb = documentRef.createElement('img'); thumb.alt = image.title; thumb.referrerPolicy = 'no-referrer';
        // All remote pixels use the bounded public-image reader, including thumbnails.
        const load = async () => {
            if (!isCurrent()) return;
            try {
                let data;
                try { data = await readImage(image.thumbnailUrl || image.imageUrl); }
                catch (error) {
                    if (!image.thumbnailUrl || image.thumbnailUrl === image.imageUrl || !isCurrent()) throw error;
                    data = await readImage(image.imageUrl);
                }
                if (isCurrent()) thumb.src = data;
            }
            catch { if (isCurrent()) { thumb.alt = '图片暂不可用'; card.classList.add('is-missing'); } }
        };
        const Observer = documentRef.defaultView?.IntersectionObserver;
        if (Observer) {
            const observer = new Observer(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); } });
            observer.observe(thumb);
            // Controller supplies cleanup for old transcript views.
            isCurrent.onCleanup?.(() => observer.disconnect());
        } else load();
        card.appendChild(thumb);
        card.appendChild(link(documentRef, { url: image.pageUrl, title: image.title }));
        const actions = documentRef.createElement('div'); actions.className = 'prompt-agent-actions';
        const view = documentRef.createElement('button'); view.type = 'button'; view.textContent = '预览';
        view.addEventListener('click', async () => {
            if (!isCurrent()) return;
            view.disabled = true;
            try { const data = await readImage(image.imageUrl); if (isCurrent()) preview([data], 0); }
            catch (error) { if (isCurrent()) status.textContent = `原图读取失败：${error.message}`; }
            finally { view.disabled = false; }
        });
        const add = documentRef.createElement('button'); add.type = 'button'; add.textContent = '加入参考图';
        add.addEventListener('click', async () => {
            if (!isCurrent()) return;
            add.disabled = true;
            try { await importImage(image); } finally { add.disabled = false; }
        });
        actions.appendChild(view); actions.appendChild(add); card.appendChild(actions); grid.appendChild(card);
    }
    section.appendChild(grid); container.appendChild(section);
}
