import { getAgentSearchCapability, normalizeAgentSearch } from './prompt-agent-search-data.js';

export function createAgentSearchMenu({ documentRef, getSettings, setSettings, getModels, onChange, closeModels = () => {} }) {
    const button = documentRef.getElementById('prompt-agent-search-button');
    const menu = documentRef.getElementById('prompt-agent-search-menu');
    const mode = documentRef.getElementById('prompt-agent-search-mode');
    const select = documentRef.getElementById('prompt-agent-search-model');
    if (!button || !menu || !mode || !select || !documentRef.body) return { close() {}, render() {} };
    // The panel is a CSS containment boundary. Portal floating settings just like
    // model options so viewport positioning cannot be clipped by the transcript.
    documentRef.body.appendChild(menu);
    const close = () => { closeModels(); menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
    const position = () => {
        const rect = button.getBoundingClientRect(), view = documentRef.defaultView;
        menu.style.width = `${Math.min(280, view.innerWidth - 16)}px`;
        menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, view.innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, rect.top - menu.offsetHeight - 6)}px`;
        menu.style.maxHeight = `${Math.max(80, rect.top - 16)}px`;
    };
    const render = () => {
        const settings = getSettings();
        mode.value = settings.mode;
        button.textContent = settings.mode === 'off' ? '联网关' : '联网';
        button.title = settings.mode === 'off' ? '联网已关闭' : '允许 Agent 按需联网搜索';
        select.replaceChildren();
        const add = (id, text, disabled = false) => {
            const option = documentRef.createElement('option');
            option.value = id; option.textContent = text; option.disabled = disabled; select.appendChild(option);
        };
        add('', '未指定，使用对话模型的搜索能力');
        const models = getModels().filter(item => getAgentSearchCapability(item) !== 'none');
        if (settings.modelId && !models.some(item => item.id === settings.modelId)) add(settings.modelId, '已选搜索模型不可用', true);
        for (const model of models) add(model.id, `${model.name || model.modelId} · ${getAgentSearchCapability(model) === 'images' ? '网页及搜图' : '网页'}`);
        select.value = settings.modelId;
        if (!menu.hidden) position();
    };
    button.addEventListener('click', () => {
        const opening = menu.hidden;
        closeModels(); render(); menu.hidden = !opening;
        button.setAttribute('aria-expanded', String(opening));
        if (opening) { position(); mode.focus(); }
    });
    for (const element of [mode, select]) element.addEventListener('change', () => {
        setSettings({ mode: mode.value, modelId: select.value }); onChange(); render();
    });
    documentRef.addEventListener?.('pointerdown', event => {
        if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)
            && !event.target.closest?.('#prompt-agent-search-model-menu')) close();
    });
    menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.stopPropagation(); closeModels(); close(); button.focus(); }
    });
    menu.addEventListener('focusout', event => {
        if (event.relatedTarget && !menu.contains(event.relatedTarget) && !event.relatedTarget.closest?.('#prompt-agent-search-model-menu')) close();
    });
    documentRef.defaultView?.addEventListener('resize', close);
    render();
    return { close, render };
}

function link(documentRef, source, label) {
    const element = documentRef.createElement('a');
    element.href = source.url; element.target = '_blank'; element.rel = 'noopener noreferrer'; element.textContent = label || source.title;
    return element;
}

export function renderAgentSearch({ documentRef, container, body, text, search, isCurrent, readImage, preview, importImage }) {
    const result = normalizeAgentSearch(search);
    if (!result) return;
    body.textContent = '';
    for (const part of text.split(/(\[\[source:[^\]]+\]\])/g)) {
        const id = /^\[\[source:([^\]]+)\]\]$/.exec(part)?.[1];
        const index = result.sources.findIndex(source => source.id === id);
        if (index >= 0) body.appendChild(link(documentRef, result.sources[index], `[${index + 1}]`));
        else { const span = documentRef.createElement('span'); span.textContent = id ? '' : part; body.appendChild(span); }
    }
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
            try { const data = await readImage(image.thumbnailUrl || image.imageUrl); if (isCurrent()) thumb.src = data; }
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
