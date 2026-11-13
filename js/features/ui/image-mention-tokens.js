const IMAGE_TOKEN = /@图片[1-9]\d*(?![\d\[])/g;
const metrics = [
    'fontFamily', 'fontSize', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontKerning',
    'fontFeatureSettings', 'fontVariationSettings', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize',
    'textAlign', 'textIndent', 'textTransform', 'direction', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'
];
const editors = new WeakMap();

function observeEditors(documentRef, input, refresh) {
    let entry = editors.get(documentRef);
    if (!entry) {
        const bindings = new Map();
        const observer = new documentRef.defaultView.MutationObserver(records => {
            for (const [control, update] of bindings) {
                if (!control.value.includes('@图片') && !update.hasTokens) continue;
                if (records.some(({ target, addedNodes, removedNodes }) => target === control || target.contains(control)
                    || [...addedNodes, ...removedNodes].some(node => node.contains(control)))) update();
            }
        });
        observer.observe(documentRef.body, { subtree: true, childList: true, attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'open', 'disabled', 'readonly', 'popover', 'data-app-theme'] });
        entry = { bindings, observer };
        editors.set(documentRef, entry);
    }
    entry.bindings.set(input, refresh);
    return () => {
        entry.bindings.delete(input);
        if (!entry.bindings.size) {
            entry.observer.disconnect();
            editors.delete(documentRef);
        }
    };
}

function getOccurrences(text, getMention) {
    return [...text.matchAll(IMAGE_TOKEN)].flatMap(match => {
        const candidate = getMention(match[0]);
        return candidate ? [{ token: match[0], start: match.index, end: match.index + match[0].length, candidate }] : [];
    });
}

export function bindImageMentionTokens({ input, getMention, readThumbnail, onReplace }) {
    const doc = input.ownerDocument;
    const view = doc.defaultView;
    let layer, mirror, preview, hoverTimer, frame, hoverTarget, lastLayout, rows = [];
    let previewGeneration = 0;
    const thumbnails = new Map();

    function hidePreview() {
        previewGeneration++;
        view.clearTimeout(hoverTimer);
        hoverTarget = null;
        preview?.remove();
        preview = null;
    }

    function showPreview(button, occurrence) {
        hidePreview();
        hoverTarget = button;
        const generation = previewGeneration;
        hoverTimer = view.setTimeout(async () => {
            const candidate = getMention(occurrence.token);
            if (!candidate || !button.isConnected || input.disabled || input.readOnly) return;
            const load = value => Promise.resolve().then(() => readThumbnail?.(value)).catch(() => '');
            let source = candidate.previewUrl;
            if (!source && readThumbnail) {
                if (candidate.connectionId) source = await load(candidate);
                else if (!thumbnails.has(candidate.id)) {
                    if (thumbnails.size >= 24) thumbnails.delete(thumbnails.keys().next().value);
                    const result = load(candidate);
                    thumbnails.set(candidate.id, result);
                    result.then(url => { if (!url && thumbnails.get(candidate.id) === result) thumbnails.delete(candidate.id); });
                }
                if (!candidate.connectionId) source = await thumbnails.get(candidate.id);
            }
            if (generation !== previewGeneration || !button.isConnected) return;
            preview = doc.createElement('div');
            preview.className = 'image-mention-preview';
            preview.setAttribute('aria-hidden', 'true');
            const img = doc.createElement('img');
            img.alt = '';
            const caption = doc.createElement('div');
            caption.textContent = candidate.name || occurrence.token;
            const status = doc.createElement('div');
            status.className = 'image-mention-preview-status';
            status.textContent = '暂无缩略图';
            status.hidden = Boolean(source);
            img.hidden = !source;
            let fallback = false;
            img.addEventListener('error', async () => {
                if (!fallback && candidate.previewUrl && readThumbnail) {
                    fallback = true;
                    const url = await load({ ...candidate, previewUrl: '' });
                    if (generation !== previewGeneration || !img.isConnected) return;
                    if (url && url !== source) { img.src = url; return; }
                }
                img.hidden = true;
                status.hidden = false;
            });
            preview.append(img, status, caption);
            if (source) img.src = source;
            if (input.closest(':popover-open') && preview.showPopover) preview.setAttribute('popover', 'manual');
            doc.body.append(preview);
            if (preview.hasAttribute('popover')) preview.showPopover();
            const anchor = button.getBoundingClientRect(), box = preview.getBoundingClientRect();
            const left = Math.min(anchor.left, view.innerWidth - box.width - 8);
            const above = anchor.top - box.height - 7;
            const top = above >= 8 ? above : Math.min(anchor.bottom + 7, view.innerHeight - box.height - 8);
            preview.style.left = `${Math.max(8, left)}px`;
            preview.style.top = `${Math.max(8, top)}px`;
        }, 1000);
    }

    function createButton(occurrence) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'image-mention-token';
        button.dataset.mentionToken = occurrence.token;
        button.setAttribute('aria-haspopup', 'listbox');
        button.addEventListener('pointerenter', () => showPreview(button, occurrence));
        button.addEventListener('pointerleave', () => { if (hoverTarget === button) hidePreview(); });
        button.addEventListener('focus', () => showPreview(button, occurrence));
        button.addEventListener('blur', () => { if (hoverTarget === button) hidePreview(); });
        button.addEventListener('pointerdown', event => { if (event.button === 0) event.preventDefault(); });
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            hidePreview();
            const candidate = getMention(occurrence.token);
            if (candidate && input.value.slice(occurrence.start, occurrence.end) === occurrence.token && !input.disabled && !input.readOnly) {
                onReplace({ ...occurrence, candidate });
            }
        });
        return button;
    }

    function clearLayer() {
        hidePreview();
        layer?.remove();
        layer = null; mirror = null; lastLayout = null; rows = [];
    }

    function render() {
        frame = undefined;
        const value = input.value;
        const occurrences = getOccurrences(value, getMention);
        const host = input.closest('label')?.parentElement || input.parentElement;
        if (!occurrences.length || !host || !input.isConnected || input.disabled || input.readOnly || !input.getClientRects().length
            || !input.clientWidth || !input.clientHeight || input.closest('[inert]')) {
            if (layer) clearLayer();
            schedule.hasTokens = false;
            return;
        }
        schedule.hasTokens = true;
        if (layer?.parentElement !== host) {
            clearLayer();
            layer = doc.createElement('div');
            layer.className = 'image-mention-token-layer';
            mirror = doc.createElement('div');
            mirror.className = 'image-mention-token-mirror';
            const measurement = doc.createElement('div');
            measurement.className = 'image-mention-token-measurement';
            measurement.setAttribute('aria-hidden', 'true');
            measurement.append(mirror);
            layer.append(measurement);
            host.append(layer);
        }
        const style = view.getComputedStyle(input);
        if (style.visibility !== 'visible') {
            clearLayer();
            return;
        }
        const typography = metrics.map(key => style[key]);
        const singleLine = input.tagName === 'INPUT' || input.wrap === 'off';
        const layout = [value, input.clientWidth, singleLine, ...typography,
            ...occurrences.map(({ token, candidate }) => `${token}:${candidate.id}:${candidate.name}`)];
        if (lastLayout?.length !== layout.length || layout.some((item, index) => item !== lastLayout[index])) {
            // Measure wrapped text without replacing the native editor or its undo history.
            lastLayout = layout;
            metrics.forEach((key, index) => { mirror.style[key] = typography[index]; });
            mirror.style.width = `${input.clientWidth}px`;
            mirror.style.whiteSpace = singleLine ? 'pre' : 'pre-wrap';
            if (input.tagName === 'INPUT') mirror.style.lineHeight = `${input.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)}px`;
            let previous = 0;
            mirror.replaceChildren();
            rows = occurrences.map(occurrence => {
                mirror.append(value.slice(previous, occurrence.start));
                const span = doc.createElement('span');
                span.textContent = occurrence.token;
                mirror.append(span);
                previous = occurrence.end;
                return { occurrence, span };
            });
            mirror.append(value.slice(previous));
        }
        const inputBox = input.getBoundingClientRect(), layerBox = layer.getBoundingClientRect(), mirrorBox = mirror.getBoundingClientRect();
        const scaleX = layerBox.width || 1, scaleY = layerBox.height || 1;
        const originX = (inputBox.left - layerBox.left) / scaleX + input.clientLeft;
        const originY = (inputBox.top - layerBox.top) / scaleY + input.clientTop;
        const editorRight = originX + input.clientWidth, editorBottom = originY + input.clientHeight;
        const buttons = Array.from(layer.querySelectorAll('.image-mention-token'));
        let count = 0;
        for (const { occurrence, span } of rows) {
            let first = true;
            for (const rect of span.getClientRects()) {
                const x = (rect.left - mirrorBox.left) / scaleX + originX - input.scrollLeft;
                const y = (rect.top - mirrorBox.top) / scaleY + originY - input.scrollTop;
                const left = Math.max(originX, x - 1), right = Math.min(editorRight, x + rect.width / scaleX + 1);
                const top = Math.max(originY, y - 1), bottom = Math.min(editorBottom, y + rect.height / scaleY + 1);
                if (right - left < 2 || bottom - top < 2) continue;
                let button = buttons[count];
                if (!button || button.mentionStart !== occurrence.start || button.dataset.mentionToken !== occurrence.token) {
                    const replacement = createButton(occurrence);
                    replacement.mentionStart = occurrence.start;
                    if (button) {
                        if (hoverTarget === button) hidePreview();
                        button.replaceWith(replacement);
                    } else layer.append(replacement);
                    button = replacement;
                }
                const label = `更换参考图：${occurrence.candidate.name || occurrence.token}`;
                if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
                if (button.tabIndex !== (first ? 0 : -1)) button.tabIndex = first ? 0 : -1;
                if (first) button.removeAttribute('aria-hidden');
                else if (!button.hasAttribute('aria-hidden')) button.setAttribute('aria-hidden', 'true');
                const geometry = `${left},${top},${right - left},${bottom - top}`;
                if (button.mentionGeometry !== geometry) {
                    button.mentionGeometry = geometry;
                    Object.assign(button.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
                    if (hoverTarget === button) hidePreview();
                }
                first = false;
                count++;
            }
        }
        for (const button of buttons.slice(count)) {
            if (hoverTarget === button) hidePreview();
            button.remove();
        }
    }

    function schedule() {
        if (frame !== undefined || (!layer && !input.value.includes('@图片'))) return;
        frame = view.requestAnimationFrame(render);
    }

    const onScroll = () => { hidePreview(); schedule(); };
    const onAncestorScroll = event => { if (event.target !== input && hoverTarget) hidePreview(); };
    const stopObserving = observeEditors(doc, input, schedule);
    const observer = view.ResizeObserver && new view.ResizeObserver(schedule);
    observer?.observe(input);
    input.addEventListener('input', schedule);
    input.addEventListener('scroll', onScroll);
    input.addEventListener('focus', schedule);
    view.addEventListener('resize', onScroll);
    doc.addEventListener('scroll', onAncestorScroll, true);
    doc.addEventListener('cainflow:canvas-transform', onAncestorScroll);
    schedule();
    return { refresh: schedule, hidePreview, destroy() {
        view.cancelAnimationFrame(frame);
        observer?.disconnect();
        stopObserving();
        input.removeEventListener('input', schedule);
        input.removeEventListener('scroll', onScroll);
        input.removeEventListener('focus', schedule);
        view.removeEventListener('resize', onScroll);
        doc.removeEventListener('scroll', onAncestorScroll, true);
        doc.removeEventListener('cainflow:canvas-transform', onAncestorScroll);
        clearLayer();
    } };
}
