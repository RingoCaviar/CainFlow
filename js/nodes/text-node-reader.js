/** A read-only, unscaled view of a text card and its retained text batch. */
export function bindTextNodeReader({ el, editor, id, documentRef = document, getTexts, getIndex, setIndex, showToast }) {
    const tools = el.querySelector('.text-node-tools');
    if (!tools || !editor) return () => {};
    const windowRef = documentRef.defaultView;
    const cleanups = [];
    const listen = (target, name, handler) => {
        target.addEventListener(name, handler);
        cleanups.push(() => target.removeEventListener(name, handler));
    };
    const make = (tag, className, text) => {
        const element = documentRef.createElement(tag);
        element.className = className;
        if (text != null) element.textContent = text;
        return element;
    };
    const opener = make('button', 'text-node-reader-open', '查看全文');
    opener.type = 'button';
    opener.setAttribute('aria-haspopup', 'dialog');
    tools.append(opener);

    const panel = make('section', 'text-node-reader');
    panel.id = `${id}-text-reader`;
    panel.setAttribute('popover', 'auto');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', `${panel.id}-title`);
    opener.setAttribute('aria-controls', panel.id);
    opener.setAttribute('aria-expanded', 'false');
    const header = make('div', 'text-node-reader-header');
    const title = make('h3', 'text-node-reader-title', '文本全文');
    title.id = `${panel.id}-title`;
    const close = make('button', 'text-node-reader-close', '关闭');
    close.type = 'button';
    header.append(title, close);
    const batch = make('div', 'text-node-reader-batch');
    const batchLabel = make('span', 'text-node-reader-batch-label', '切换文本');
    const selector = make('select', 'text-node-reader-select');
    selector.setAttribute('aria-label', '切换文本');
    const navigation = make('div', 'text-node-reader-navigation');
    const previous = make('button', 'text-node-reader-previous', '上一条');
    const next = make('button', 'text-node-reader-next', '下一条');
    previous.type = next.type = 'button';
    navigation.append(previous, selector, next);
    batch.append(batchLabel, navigation);
    const content = make('pre', 'text-node-reader-content');
    content.tabIndex = 0;
    content.setAttribute('aria-label', '只读文本全文');
    const footer = make('div', 'text-node-reader-footer');
    const status = make('span', 'text-node-reader-status', '只读查看，不修改正文');
    status.setAttribute('role', 'status');
    const copy = make('button', 'text-node-reader-copy', '复制全文');
    copy.type = 'button';
    footer.append(status, copy);
    panel.append(header, batch, content, footer);
    documentRef.body.append(panel);
    let returnTarget = opener;
    let disposed = false;
    let previousTexts = '';
    let previousIndex = -1;

    const refresh = () => {
        const retained = getTexts?.();
        const texts = Array.isArray(retained) && retained.length ? retained.map(value => String(value ?? '')) : [editor.value];
        const index = Math.max(0, Math.min(texts.length - 1, Number(getIndex?.()) || 0));
        texts[index] = editor.value;
        const signature = JSON.stringify(texts);
        const changed = signature !== previousTexts || index !== previousIndex;
        if (signature !== previousTexts) {
            selector.replaceChildren();
            texts.forEach((text, position) => {
                const summary = text.trim().replace(/\s+/g, ' ') || '空文本';
                const option = make('option', '', `${position + 1}. ${summary.slice(0, 72)}${summary.length > 72 ? '…' : ''}`);
                option.value = String(position);
                selector.append(option);
            });
        }
        selector.value = String(index);
        batch.hidden = texts.length < 2;
        previous.disabled = index === 0;
        next.disabled = index === texts.length - 1;
        const name = el.querySelector('.node-title')?.textContent?.trim() || '文本';
        const heading = `${name} · 全文${texts.length > 1 ? ` · ${index + 1}/${texts.length}` : ''}`;
        if (title.textContent !== heading) title.textContent = heading;
        const nextContent = texts[index] || '暂无文本';
        const scrollTop = content.scrollTop;
        if (content.textContent !== nextContent) content.textContent = nextContent;
        content.dataset.empty = String(!texts[index]);
        if (index !== previousIndex) content.scrollTop = 0;
        else content.scrollTop = scrollTop;
        copy.disabled = !texts[index];
        if (changed) status.textContent = '只读查看，不修改正文';
        previousTexts = signature;
        previousIndex = index;
    };
    const position = () => {
        const rect = el.getBoundingClientRect();
        const width = panel.getBoundingClientRect().width;
        const height = panel.getBoundingClientRect().height;
        panel.style.left = `${Math.max(16, Math.min(rect.right + 12, windowRef.innerWidth - width - 16))}px`;
        panel.style.top = `${Math.max(16, Math.min(rect.top, windowRef.innerHeight - height - 16))}px`;
    };
    const open = event => {
        event.preventDefault();
        event.stopPropagation();
        returnTarget = event.currentTarget;
        if (panel.matches(':popover-open')) { panel.hidePopover(); return; }
        refresh();
        el.classList.add('is-text-reader-open');
        panel.showPopover();
        position();
        content.focus({ preventScroll: true });
    };
    const dismiss = () => {
        panel.hidePopover();
        if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
        else if (el.isConnected) el.focus({ preventScroll: true });
    };
    listen(opener, 'click', open);
    const counter = el.querySelector('.text-multi-counter');
    if (counter) {
        const attributes = ['role', 'tabindex', 'title', 'aria-haspopup', 'aria-controls'];
        const original = attributes.map(name => counter.getAttribute(name));
        counter.setAttribute('role', 'button');
        counter.tabIndex = 0;
        counter.title = '查看全文与文本列表';
        counter.setAttribute('aria-haspopup', 'dialog');
        counter.setAttribute('aria-controls', panel.id);
        listen(counter, 'click', open);
        listen(counter, 'mousedown', event => event.stopPropagation());
        if (counter.tagName !== 'BUTTON') listen(counter, 'keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') open(event);
        });
        cleanups.push(() => attributes.forEach((name, index) => {
            if (original[index] == null) counter.removeAttribute(name);
            else counter.setAttribute(name, original[index]);
        }));
    }
    listen(close, 'click', dismiss);
    listen(panel, 'keydown', event => {
        if (event.key !== 'Escape' || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
    });
    listen(panel, 'toggle', () => {
        const isOpen = panel.matches(':popover-open');
        opener.setAttribute('aria-expanded', String(isOpen));
        el.classList.toggle('is-text-reader-open', isOpen);
    });
    listen(selector, 'change', () => {
        setIndex?.(Number(selector.value));
        refresh();
    });
    listen(previous, 'click', () => { setIndex?.(Number(selector.value) - 1); refresh(); });
    listen(next, 'click', () => { setIndex?.(Number(selector.value) + 1); refresh(); });
    listen(windowRef, 'resize', () => { if (panel.matches(':popover-open')) position(); });
    listen(copy, 'click', async () => {
        try {
            await windowRef.navigator.clipboard.writeText(content.textContent);
            if (disposed) return;
            status.textContent = '已复制全文';
        } catch {
            if (disposed) return;
            status.textContent = '复制失败，请选中正文后按 Ctrl/Cmd+C 复制';
            showToast?.('复制失败，可选中正文后手动复制', 'warning');
        }
    });
    const refreshOpenReader = () => {
        if (!disposed && panel.matches(':popover-open')) { refresh(); position(); }
    };
    el._refreshTextReader = refreshOpenReader;
    listen(editor, 'input', refreshOpenReader);
    const nodeTitle = el.querySelector('.node-title');
    const titleObserver = nodeTitle && new windowRef.MutationObserver(refreshOpenReader);
    titleObserver?.observe(nodeTitle, { childList: true, characterData: true, subtree: true });
    const dispose = () => {
        disposed = true;
        titleObserver?.disconnect();
        if (el._refreshTextReader === refreshOpenReader) delete el._refreshTextReader;
        cleanups.forEach(cleanup => cleanup());
        panel.remove();
        opener.remove();
        el.classList.remove('is-text-reader-open');
    };
    dispose.refresh = refreshOpenReader;
    return dispose;
}
