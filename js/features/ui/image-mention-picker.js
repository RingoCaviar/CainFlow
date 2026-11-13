import { getSurfaceCoordinator } from './surface-coordinator.js';

const PAGE_SIZE = 24;
const SOURCES = { import: '导入图片', canvas: '节点输出', history: '目录历史', node: '画布节点' };
let serial = 0;

function currentMention(input) {
    if (input.disabled || input.readOnly || input.selectionStart !== input.selectionEnd) return null;
    const end = input.selectionEnd;
    const match = input.value.slice(0, end).match(/[@＠]([^\s@＠[\]，。；！？、]*)$/u);
    return match ? { start: end - match[0].length, end, query: match[1] } : null;
}

function icon(documentRef, kind) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = documentRef.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.65');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = documentRef.createElementNS(ns, 'path');
    path.setAttribute('d', {
        at: 'M16 8v5a2 2 0 0 0 4 0v-1a8 8 0 1 0-3.5 6.6M16 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z',
        image: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2ZM4 16l5-5 4 4 2-2 5 5M16.5 8.5h.01',
        node: 'M9 3h6v6H9ZM3 15h6v6H3Zm12 0h6v6h-6ZM12 9v3m-6 3v-3h12v3',
        close: 'm7 7 10 10M17 7 7 17'
    }[kind]);
    svg.append(path);
    return svg;
}

function sourceText(candidate, mode) {
    if (candidate.kind === 'node') return [candidate.description, candidate.sourceNodeId].filter(Boolean).join(' · ') || SOURCES.node;
    const origin = SOURCES[candidate.kind] || '图片资源';
    return mode === 'upstream' && candidate.referenceNumber != null ? `参考图 ${candidate.referenceNumber} · ${origin}` : origin;
}

function matchesQuery(candidate, mode, query) {
    const text = [candidate.name, sourceText(candidate, mode), candidate.description, candidate.searchText].filter(Boolean).join(' ');
    const normalize = value => String(value).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '');
    return normalize(text).includes(normalize(query));
}

export function bindImageMentionPicker({
    input, getUpstream, getScene, readThumbnail, onSelect, owner,
    surfaces = getSurfaceCoordinator(input?.ownerDocument), getExtraChoices, extraLabel = '节点'
}) {
    const doc = input.ownerDocument, view = doc.defaultView;
    const id = `image-mention-picker-${++serial}`;
    const modes = [
        { id: 'upstream', label: '上游输入', load: getUpstream },
        { id: 'scene', label: '场景图片', load: getScene },
        ...(getExtraChoices ? [{ id: 'extra', label: extraLabel, load: getExtraChoices }] : [])
    ];
    const element = (tag, className, content) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (content) node.textContent = content;
        return node;
    };
    let popup, list, status, tabs, empty, more, mode, mention, loading, failure, selecting, positionObserver, thumbnailObserver;
    let candidates = [], choices = [], rows = [], active = -1, generation = 0, composing = false, limit = PAGE_SIZE;
    let thumbnails = new Map();
    let cache = new Map();
    const pendingThumbnails = new WeakMap();
    const originalAria = Object.fromEntries(['aria-controls', 'aria-expanded', 'aria-activedescendant'].map(key => [key, input.getAttribute(key)]));

    function restoreAria() {
        for (const [key, value] of Object.entries(originalAria)) {
            if (value === null) input.removeAttribute(key);
            else input.setAttribute(key, value);
        }
    }

    function close() {
        if (!popup) return;
        generation++;
        popup.remove();
        popup = null; mention = null; selecting = false;
        rows = []; choices = []; candidates = []; cache.clear(); thumbnails.clear();
        positionObserver?.disconnect();
        thumbnailObserver?.disconnect();
        view.removeEventListener('resize', position);
        view.removeEventListener('scroll', handleScroll, true);
        doc.removeEventListener('focusin', handleFocus);
        doc.removeEventListener('pointerdown', handleOutside, true);
        restoreAria();
        surfaces?.forgetPopover(id);
    }

    function handleFocus(event) {
        if (event.target !== input && !popup?.contains(event.target)) close();
    }

    function handleOutside(event) {
        if (event.target !== input && !popup?.contains(event.target)) close();
    }

    function handleScroll(event) {
        if (!popup?.contains(event.target)) position();
    }

    function position() {
        if (!popup) return;
        const rect = input.getBoundingClientRect();
        if (!input.isConnected || !rect.width || !rect.height || rect.bottom < 0 || rect.top > view.innerHeight) {
            close(); return;
        }
        const inset = 8, gap = 6, desired = 406;
        const above = Math.max(0, rect.top - inset - gap);
        const below = Math.max(0, view.innerHeight - rect.bottom - inset - gap);
        const placeAbove = below < desired && above > below;
        const room = placeAbove ? above : below;
        const left = Math.max(inset, Math.min(rect.left, view.innerWidth - popup.offsetWidth - inset));
        const minHeight = Math.min(154, Math.max(0, view.innerHeight - 2 * inset));
        Object.assign(popup.style, {
            left: `${left}px`,
            top: placeAbove ? 'auto' : `${Math.min(rect.bottom + gap, view.innerHeight - minHeight - inset)}px`,
            bottom: placeAbove ? `${Math.min(view.innerHeight - rect.top + gap, view.innerHeight - minHeight - inset)}px` : 'auto',
            maxHeight: `${Math.min(desired, Math.max(minHeight, room))}px`
        });
    }

    function observeThumbnail(figure, candidate, immediately) {
        if (candidate.kind === 'node') return;
        const image = element('img');
        image.alt = '';
        image.decoding = 'sync';
        figure.append(image);
        let loadedFrom = '';
        const loadFallback = async () => {
            if (!readThumbnail) return;
            if (!thumbnails.has(candidate.id)) {
                const source = loadedFrom ? { ...candidate, previewUrl: '' } : candidate;
                thumbnails.set(candidate.id, Promise.resolve().then(() => readThumbnail(source)).catch(() => null));
            }
            const url = await thumbnails.get(candidate.id);
            if (image.isConnected && url && url !== loadedFrom) { loadedFrom = url; image.src = url; }
        };
        image.addEventListener('load', () => { figure.classList.add('has-image'); });
        image.addEventListener('error', () => { figure.classList.remove('has-image'); void loadFallback(); });
        const load = () => {
            if (candidate.previewUrl) { loadedFrom = candidate.previewUrl; image.src = loadedFrom; }
            else void loadFallback();
        };
        if (thumbnailObserver && !immediately) {
            pendingThumbnails.set(figure, load);
            thumbnailObserver.observe(figure);
        } else load();
    }

    function markActive(next, scroll = false) {
        if (active >= 0) rows[active]?.setAttribute('aria-selected', 'false');
        active = next;
        const row = rows[active];
        if (!row) { input.removeAttribute('aria-activedescendant'); return; }
        row.setAttribute('aria-selected', 'true');
        input.setAttribute('aria-activedescendant', row.id);
        if (scroll) row.scrollIntoView({ block: 'nearest' });
    }

    function render() {
        if (!popup) return;
        const selectedId = choices[active]?.id;
        const scrollTop = list.scrollTop;
        choices = candidates.filter(candidate => matchesQuery(candidate, mode.id, mention.query));
        thumbnailObserver?.disconnect();
        list.replaceChildren();
        list.setAttribute('aria-busy', String(loading || selecting));
        rows = choices.slice(0, limit).map((candidate, index) => {
            const button = element('button', 'image-mention-option');
            button.type = 'button';
            button.id = `${id}-option-${index}`;
            button.tabIndex = -1;
            button.dataset.mentionId = candidate.id;
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', 'false');
            const figure = element('span', 'image-mention-thumb');
            figure.append(icon(doc, candidate.kind === 'node' ? 'node' : 'image'));
            button.append(figure);
            const copy = element('span', 'image-mention-option-copy');
            const name = element('span', 'image-mention-name', candidate.name || '未命名图片');
            name.title = name.textContent;
            copy.append(name, element('span', 'image-mention-source', sourceText(candidate, mode.id)));
            button.append(copy);
            button.addEventListener('pointermove', () => { if (active !== index) markActive(index); });
            button.addEventListener('click', () => { void choose(candidate); });
            list.append(button);
            observeThumbnail(figure, candidate, index < 5);
            return button;
        });
        const warning = failure || candidates.warning;
        empty.hidden = rows.length > 0 && !warning;
        empty.textContent = warning || (loading ? '正在读取图片…' : mention.query ? '没有匹配的项目。试试其他名称。'
            : mode.id === 'upstream' ? '暂无可用的上游图片。可切换到「场景图片」。'
                : mode.id === 'extra' ? '当前画布暂无可用节点。' : '当前场景暂无图片资源。');
        const count = choices.length;
        status.textContent = loading ? '读取中' : mode.id === 'extra' ? `${count} 个节点` : `${count} 张图片`;
        more.hidden = count <= limit;
        const retained = choices.findIndex(candidate => candidate.id === selectedId);
        markActive(rows.length ? (retained >= 0 && retained < rows.length ? retained : 0) : -1);
        list.scrollTop = retained >= 0 ? scrollTop : 0;
        position();
    }

    function switchMode(next) {
        const request = ++generation;
        mode = next; loading = true; failure = ''; selecting = false; active = -1; limit = PAGE_SIZE;
        candidates = []; choices = [];
        tabs.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mentionMode === mode.id)));
        if (cache.has(next.id)) { candidates = cache.get(next.id); loading = false; render(); return; }
        render();
        Promise.resolve().then(() => next.load?.() || []).then(result => {
            if (!popup || request !== generation) return;
            candidates = Array.isArray(result) ? result : [];
            cache.set(next.id, candidates);
            loading = false;
            render();
        }).catch(() => {
            if (!popup || request !== generation) return;
            loading = false;
            failure = '图片列表读取失败。切换来源后可重试。';
            render();
        });
    }

    async function choose(candidate) {
        if (!popup || selecting) return;
        const selected = { ...mention, mode: mode.id };
        const request = generation;
        const before = input.value;
        const isCurrent = () => Boolean(popup && request === generation && input.isConnected && !input.disabled && !input.readOnly
            && input.value === before && input.selectionStart === selected.end && input.selectionEnd === selected.end);
        selecting = true;
        list.setAttribute('aria-busy', 'true');
        try {
            const selection = onSelect(candidate, { ...selected, isCurrent });
            const token = selection && typeof selection.then === 'function' ? await selection : selection;
            if (!isCurrent() || typeof token !== 'string' || !token) return;
            close();
            input.focus({ preventScroll: true });
            input.setSelectionRange(selected.start, selected.end);
            const text = `${token} `;
            // Native insertion joins the textarea's existing undo history.
            if (!doc.execCommand?.('insertText', false, text)) {
                input.setRangeText(text, selected.start, selected.end, 'end');
                input.dispatchEvent(new view.Event('input', { bubbles: true }));
            }
        } catch (error) {
            if (isCurrent()) { failure = error?.message || '无法引用这张图片，请重新选择。'; render(); }
        } finally {
            if (popup && request === generation) { selecting = false; list.setAttribute('aria-busy', String(loading)); }
        }
    }

    function open() {
        const trigger = currentMention(input);
        if (!trigger) { close(); return; }
        if (popup) {
            if (trigger.start === mention.start) {
                if (trigger.query !== mention.query) { mention = trigger; limit = PAGE_SIZE; failure = ''; render(); }
                return;
            }
            close();
        }
        mention = trigger; cache = new Map(); thumbnails = new Map();
        const parent = input.closest('.image-parameter-settings-popup:popover-open');
        popup = element('div', 'image-mention-picker');
        popup.id = id;
        popup.setAttribute('role', 'group');
        popup.setAttribute('aria-label', '提及图片');
        popup.addEventListener('mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
        if (!surfaces) popup.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || event.isComposing) return;
            event.preventDefault(); event.stopPropagation();
            close(); input.focus({ preventScroll: true });
        });
        const heading = element('div', 'image-mention-heading');
        heading.append(icon(doc, 'at'), element('strong', '', '提及图片'));
        const dismiss = element('button', 'image-mention-dismiss');
        dismiss.type = 'button'; dismiss.setAttribute('aria-label', '关闭图片选择');
        dismiss.append(icon(doc, 'close'));
        dismiss.addEventListener('click', () => { close(); input.focus({ preventScroll: true }); });
        heading.append(dismiss);
        const switcher = element('div', 'image-mention-modes');
        switcher.setAttribute('role', 'group');
        switcher.setAttribute('aria-label', '选择来源');
        tabs = modes.map(item => {
            const button = element('button', '', item.label);
            button.type = 'button'; button.dataset.mentionMode = item.id;
            button.addEventListener('click', () => {
                if (candidates.warning && mode === item) cache.delete(item.id);
                if (mode !== item || failure || candidates.warning) switchMode(item);
                input.focus({ preventScroll: true });
            });
            switcher.append(button);
            return button;
        });
        list = element('div', 'image-mention-list');
        list.id = `${id}-list`; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '可提及的资源');
        empty = element('div', 'image-mention-empty');
        empty.setAttribute('role', 'status');
        more = element('button', 'image-mention-more', '显示更多');
        more.type = 'button';
        more.addEventListener('click', () => { const next = limit; limit += PAGE_SIZE; render(); markActive(next, true); input.focus(); });
        const footer = element('div', 'image-mention-footer');
        footer.append(element('span', '', '↑↓ 浏览 · Enter 选中'));
        status = element('span');
        status.setAttribute('aria-live', 'polite');
        footer.append(status);
        const content = element('div', 'image-mention-results');
        content.append(list, empty, more);
        popup.append(heading, switcher, content, footer);
        if (parent && popup.showPopover) popup.setAttribute('popover', 'manual');
        doc.body.append(popup);
        if (popup.hasAttribute('popover')) popup.showPopover();
        input.setAttribute('aria-controls', list.id);
        input.setAttribute('aria-expanded', 'true');
        if (view.IntersectionObserver) thumbnailObserver = new view.IntersectionObserver(entries => {
            for (const entry of entries) if (entry.isIntersecting) {
                thumbnailObserver.unobserve(entry.target);
                pendingThumbnails.get(entry.target)?.();
                pendingThumbnails.delete(entry.target);
            }
        }, { root: list });
        if (view.ResizeObserver) {
            positionObserver = new view.ResizeObserver(position);
            positionObserver.observe(input);
        }
        view.addEventListener('resize', position);
        view.addEventListener('scroll', handleScroll, true);
        doc.addEventListener('focusin', handleFocus);
        if (!surfaces) doc.addEventListener('pointerdown', handleOutside, true);
        position();
        if (!popup) return;
        surfaces?.openPopover(id, { element: popup, trigger: input, parent: parent?.id, owner: typeof owner === 'function' ? owner() : owner, close });
        if (popup) switchMode(modes[0]);
    }

    function keydown(event) {
        if (!popup || event.isComposing || composing) return;
        const { key } = event;
        const switchBy = event.altKey && (key === 'ArrowLeft' || key === 'ArrowRight');
        if (!switchBy && (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(key))) return;
        if (key === 'Tab') { event.preventDefault(); tabs[modes.indexOf(mode)].focus(); return; }
        event.preventDefault(); event.stopImmediatePropagation();
        if (key === 'Escape') { close(); return; }
        if (switchBy) {
            const offset = key === 'ArrowRight' ? 1 : -1;
            switchMode(modes[(modes.indexOf(mode) + offset + modes.length) % modes.length]); return;
        }
        if (key === 'Enter') { if (choices[active]) void choose(choices[active]); return; }
        if (!rows.length) return;
        const next = active + (key === 'ArrowDown' ? 1 : -1);
        if (next === rows.length && next < choices.length) { limit += PAGE_SIZE; render(); }
        markActive((next + rows.length) % rows.length, true);
    }

    const onInput = event => { if (!composing && !event.isComposing) open(); };
    const onCompositionStart = () => { composing = true; close(); };
    const onCompositionEnd = () => { composing = false; open(); };
    const onCaretChange = () => {
        if (!popup || doc.activeElement !== input) return;
        const next = currentMention(input);
        if (!next || next.start !== mention.start || next.end !== mention.end) close();
    };
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', keydown, true);
    input.addEventListener('compositionstart', onCompositionStart);
    input.addEventListener('compositionend', onCompositionEnd);
    input.addEventListener('selectionchange', onCaretChange);
    return { open, close, destroy() {
        close();
        input.removeEventListener('input', onInput);
        input.removeEventListener('keydown', keydown, true);
        input.removeEventListener('compositionstart', onCompositionStart);
        input.removeEventListener('compositionend', onCompositionEnd);
        input.removeEventListener('selectionchange', onCaretChange);
    } };
}
