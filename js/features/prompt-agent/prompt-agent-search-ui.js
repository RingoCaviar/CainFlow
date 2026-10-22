import { getAgentModelLabel } from './prompt-agent-model-menu.js';
import { getAgentSearchCapability, getAgentSearchAvailability, normalizeAgentSearch } from './prompt-agent-search-data.js';
import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';
import { renderAgentBody } from './prompt-agent-body.js';

export function createAgentSearchMenu({ documentRef, getSettings, setSettings, getModels, getProviders = () => [],
    getCurrentModel = () => null, getProviderId = () => '', configure = () => {}, onChange, closeModels = () => {}, refreshSelects = () => {} }) {
    const surfaces = getSurfaceCoordinator(documentRef);
    const button = documentRef.getElementById('prompt-agent-search-button');
    const menu = documentRef.getElementById('prompt-agent-search-menu');
    const mode = documentRef.getElementById('prompt-agent-search-mode');
    const select = documentRef.getElementById('prompt-agent-search-model');
    if (!button || !menu || !mode || !select || !documentRef.body) return { close() {}, render() {} };
    // The panel is a CSS containment boundary. Portal floating settings just like
    // model options so viewport positioning cannot be clipped by the transcript.
    documentRef.body.appendChild(menu);
    const close = () => { surfaces?.forgetPopover('agent-search'); closeModels(); menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
    const position = () => {
        const rect = button.getBoundingClientRect(), view = documentRef.defaultView;
        menu.style.width = `${Math.min(280, view.innerWidth - 16)}px`;
        menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, view.innerWidth - menu.offsetWidth - 8))}px`;
        const above = Math.max(0, rect.top - 16), below = Math.max(0, view.innerHeight - rect.bottom - 16);
        const up = above >= Math.min(320, menu.scrollHeight) || above >= below;
        menu.style.maxHeight = `${up ? above : below}px`;
        menu.style.top = `${up ? Math.max(8, rect.top - menu.offsetHeight - 6) : rect.bottom + 6}px`;
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
        add('', '未指定专用搜索模型');
        const models = getModels().filter(item => getAgentSearchCapability(item) !== 'none');
        if (settings.modelId && !models.some(item => item.id === settings.modelId)) add(settings.modelId, '已选搜索模型不可用', true);
        for (const model of models) add(model.id, `${getAgentModelLabel(model, getProviders())} · ${getAgentSearchCapability(model) === 'images' ? '网页及搜图' : '网页'}`);
        select.value = settings.modelId;
        select.disabled = settings.mode === 'off';
        refreshSelects();
        const status = documentRef.getElementById('prompt-agent-search-availability');
        if (status) {
            status.replaceChildren();
            for (const kind of ['web', 'images']) {
                const availability = getAgentSearchAvailability({ model: getCurrentModel(), models: getModels(), providers: getProviders(), providerId: getProviderId('chat', getCurrentModel()?.id), settings: { ...settings, providerId: getProviderId('search', settings.modelId) }, kind });
                const row = documentRef.createElement('div');
                const text = documentRef.createElement('p');
                text.textContent = `${kind === 'web' ? '网页' : '搜图'}：${availability.message}`;
                row.appendChild(text);
                if (!availability.available && availability.reason !== 'off') {
                    const action = documentRef.createElement('button'); action.type = 'button'; action.className = 'btn btn-ghost';
                    action.textContent = availability.target.providerId ? '配置 Provider 地址' : '配置搜索模型';
                    action.addEventListener('click', () => configure(availability.target)); row.appendChild(action);
                }
                status.appendChild(row);
            }
        }
        if (!menu.hidden) position();
    };
    const open = () => {
        closeModels(); render(); menu.hidden = false;
        surfaces?.openPopover('agent-search', { element: menu, trigger: button, close });
        button.setAttribute('aria-expanded', 'true'); position();
        (mode.nextElementSibling?.matches('.prompt-agent-model-trigger') ? mode.nextElementSibling : mode).focus();
    };
    button.addEventListener('click', () => {
        if (menu.hidden) open(); else close();
    });
    documentRef.getElementById('prompt-agent-search-settings')?.addEventListener('click', () => configure({
        modelId: getSettings().modelId || undefined, field: 'agentSearch'
    }));
    for (const element of [mode, select]) element.addEventListener('change', () => {
        setSettings({ mode: mode.value, modelId: select.value }); onChange(); render();
    });
    documentRef.addEventListener?.('pointerdown', event => {
        if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)
            && !event.target.closest?.('[data-agent-popover-parent="agent-search"]')) close();
    });
    menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.stopPropagation(); closeModels(); close(); button.focus(); }
    });
    menu.addEventListener('focusout', event => {
        if (event.relatedTarget && !menu.contains(event.relatedTarget) && !event.relatedTarget.closest?.('[data-agent-popover-parent="agent-search"]')) close();
    });
    documentRef.defaultView?.addEventListener('resize', close);
    render();
    return { close, render, open };
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
