import { getCanonicalImageList } from '../features/execution/execution-data-utils.js';
import { projectImageOutput } from './image-output-projection.js';
import { getSurfaceCoordinator } from '../features/ui/surface-coordinator.js';

// This view retains only thumbnails. Original reads and the authoritative
// browsing index remain with the media controller and its existing consumer.
export function createImagePreviewBatchNavigation({ state, documentRef, windowRef = documentRef.defaultView,
    getNodeById = id => state.nodes.get(id), readOriginalAt, createThumbnail,
    onSelect, showToast = () => {} }) {
    const views = new WeakMap();
    const surfaces = getSurfaceCoordinator(documentRef);
    let serial = 0;
    const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
    function snapshot(node, captureInline = false) {
        const originals = getCanonicalImageList(node);
        const output = projectImageOutput(node, originals);
        const durable = output.assets.length === output.count && output.assets.every(key => key.startsWith('media:'));
        return { assets: output.assets, count: output.count, durable,
            originals: captureInline && !durable ? originals : null, missingPositions: output.missingPositions.slice() };
    }
    const sameBatch = (left, right) => left.count === right.count
        && same(left.assets, right.assets) && (!left.originals || !right.originals || same(left.originals, right.originals))
        && same(left.missingPositions, right.missingPositions);
    const isCurrent = view => !view.disposed && views.get(view.node) === view
        && getNodeById(view.node.id) === view.node && sameBatch(view.batch, snapshot(view.node, view.open));

    function hide(view, restoreFocus = false) {
        view.open = false;
        view.readSession = null;
        view.batch.originals = null;
        view.requests.clear();
        if (!view.batch.durable) {
            view.thumbnails.clear();
            view.missing = new Set(view.batch.missingPositions);
            view.grid.querySelectorAll('[data-preview-batch-index]').forEach(item => {
                item.querySelector('img')?.remove();
                const missing = view.missing.has(Number(item.dataset.previewBatchIndex));
                item.classList.toggle('is-missing', missing);
                item.querySelector('.image-node-result-thumbnail-state').textContent = missing ? '原图缺失' : '载入预览…';
            });
        }
        view.gallery.hidden = true;
        view.counter?.setAttribute('aria-expanded', 'false');
        view.observer?.disconnect();
        surfaces?.forgetPopover(view.popoverId);
        if (restoreFocus && view.counter?.isConnected) view.counter.focus({ preventScroll: true });
    }
    function dispose(view) {
        view.disposed = true;
        hide(view);
        view.unbindCounter?.();
        view.gallery.remove();
        view.thumbnails.clear();
        view.requests.clear();
    }
    function destroy(node) {
        const view = views.get(node);
        if (!view) return;
        dispose(view);
        views.delete(node);
    }
    function updateSelection(view) {
        const index = Math.max(0, Math.min(view.batch.count - 1, parseInt(view.node.imagePreviewIndex, 10) || 0));
        view.counter.textContent = `${index + 1}/${view.batch.count}`;
        view.counter.setAttribute('aria-label', `查看整批 ${view.batch.count} 张图片，当前第 ${index + 1} 张`);
        view.grid.querySelectorAll('[data-preview-batch-index]').forEach(item => {
            item.setAttribute('aria-pressed', String(Number(item.dataset.previewBatchIndex) === index));
        });
    }
    function loadItem(view, item) {
        const index = Number(item.dataset.previewBatchIndex);
        const readSession = view.readSession;
        const canApply = () => isCurrent(view) && view.open && view.readSession === readSession;
        const apply = thumbnail => {
            if (!canApply() || !item.isConnected) return;
            const image = documentRef.createElement('img');
            image.alt = ''; image.decoding = 'async'; image.draggable = false; image.src = thumbnail;
            item.querySelector('img')?.remove(); item.prepend(image);
            item.querySelector('.image-node-result-thumbnail-state').textContent = '';
        };
        if (view.missing.has(index) || item.querySelector('img')) return;
        if (view.thumbnails.has(index)) { apply(view.thumbnails.get(index)); return; }
        if (!view.requests.has(index)) {
            const request = (async () => {
                if (!canApply()) return '';
                let original = await readOriginalAt(view.node, index, view.batch.assets[index] || '');
                if (!canApply()) return '';
                if (!/^data:image\//i.test(original || '')) throw new Error('原图缺失');
                const thumbnail = await createThumbnail(original);
                original = '';
                if (!canApply()) return '';
                if (!/^data:image\//i.test(thumbnail || '')) throw new Error('无法生成图片预览');
                view.thumbnails.set(index, thumbnail);
                return thumbnail;
            })().finally(() => { if (view.requests.get(index) === request) view.requests.delete(index); });
            view.requests.set(index, request);
        }
        void view.requests.get(index).then(thumbnail => { if (thumbnail) apply(thumbnail); }).catch(() => {
            if (!canApply() || !item.isConnected) return;
            view.missing.add(index); item.classList.add('is-missing');
            item.querySelector('.image-node-result-thumbnail-state').textContent = '原图缺失';
        });
    }
    function show(view) {
        if (!view) return;
        if (!isCurrent(view)) return;
        if (!view.open) { view.readSession = {}; view.batch = snapshot(view.node, true); }
        view.open = true; view.gallery.hidden = false;
        view.counter.setAttribute('aria-expanded', 'true');
        view.observer?.disconnect();
        const Observer = windowRef?.IntersectionObserver;
        if (Observer) {
            view.observer = new Observer(entries => {
                if (!isCurrent(view) || !view.open) return;
                for (const entry of entries) if (entry.isIntersecting) {
                    view.observer.unobserve(entry.target);
                    loadItem(view, entry.target);
                }
            }, { root: view.grid, rootMargin: '32px' });
            view.grid.querySelectorAll('[data-preview-batch-index]').forEach(item => view.observer.observe(item));
        } else {
            const viewport = view.grid.getBoundingClientRect();
            if (viewport.width > 0 && viewport.height > 0) view.grid.querySelectorAll('[data-preview-batch-index]').forEach(item => {
                const rect = item.getBoundingClientRect();
                if (rect.bottom >= viewport.top && rect.top <= viewport.bottom) loadItem(view, item);
            });
        }
        surfaces?.openPopover(view.popoverId, { element: view.gallery, trigger: view.counter, close: () => hide(view) });
    }
    function makeView(node, container, batch) {
        const popoverId = `image-preview-batch-${node.id}-${++serial}`;
        const gallery = documentRef.createElement('section');
        gallery.id = popoverId;
        gallery.className = 'image-node-result-batch image-preview-batch-navigation';
        gallery.hidden = true; gallery.setAttribute('aria-label', '整批图片预览');
        const heading = documentRef.createElement('div'); heading.className = 'image-node-result-batch-heading';
        const title = documentRef.createElement('span'); title.textContent = `完整输出 ${batch.count} 张`;
        const close = documentRef.createElement('button'); close.type = 'button'; close.textContent = '×';
        close.dataset.nodeReadAction = 'true'; close.setAttribute('aria-label', '关闭整批导航');
        heading.append(title, close); gallery.append(heading);
        const grid = documentRef.createElement('div'); grid.className = 'image-node-result-batch-grid'; gallery.append(grid);
        const view = { node, container, batch, gallery, grid, popoverId, open: false,
            missing: new Set(batch.missingPositions), thumbnails: new Map(), requests: new Map() };
        const stop = event => event.stopPropagation();
        gallery.addEventListener('pointerdown', stop);
        gallery.addEventListener('mousedown', stop);
        gallery.addEventListener('click', stop);
        gallery.addEventListener('keydown', stop);
        close.addEventListener('click', () => hide(view, true));
        for (let index = 0; index < batch.count; index += 1) {
            const item = documentRef.createElement('button'); item.type = 'button';
            item.className = 'image-node-result-thumbnail'; item.dataset.previewBatchIndex = String(index);
            item.dataset.nodeReadAction = 'true'; item.setAttribute('aria-label', `查看第 ${index + 1} 张图片`);
            const number = documentRef.createElement('span'); number.className = 'image-node-result-thumbnail-number'; number.textContent = String(index + 1);
            const status = documentRef.createElement('span'); status.className = 'image-node-result-thumbnail-state';
            status.id = `${popoverId}-slot-${index}-state`; item.setAttribute('aria-describedby', status.id);
            status.textContent = view.missing.has(index) ? '原图缺失' : '载入预览…';
            item.classList.toggle('is-missing', view.missing.has(index)); item.append(number, status);
            item.addEventListener('click', () => {
                if (!isCurrent(view)) return;
                void Promise.resolve().then(() => { if (isCurrent(view)) return onSelect(node, index); }).catch(error => {
                    if (isCurrent(view)) showToast(error?.message || '无法切换图片', 'warning');
                });
            });
            grid.append(item);
        }
        grid.addEventListener('scroll', () => { if (view.open && !view.observer) show(view); });
        return view;
    }
    function render(node, previewContainer) {
        if (!['ImagePreview', 'ImageMerge', 'ImageSave'].includes(node?.type) || !previewContainer) return;
        const batch = snapshot(node, views.get(node)?.open);
        if (batch.count <= 1) { destroy(node); return; }
        let view = views.get(node);
        if (view && (view.container !== previewContainer || !sameBatch(view.batch, batch))) { dispose(view); view = null; }
        if (!view) { view = makeView(node, previewContainer, batch); views.set(node, view); }
        let counter = previewContainer.querySelector('.image-save-preview-counter');
        if (counter?.tagName !== 'BUTTON') {
            const button = documentRef.createElement('button'); button.type = 'button';
            if (counter) counter.replaceWith(button); else previewContainer.append(button);
            counter = button;
        }
        counter.classList.add('image-save-preview-counter', 'image-node-result-count');
        counter.dataset.nodeReadAction = 'true';
        counter.setAttribute('aria-controls', view.gallery.id); counter.setAttribute('aria-expanded', String(view.open));
        if (view.counter !== counter) {
            view.unbindCounter?.(); view.counter = counter;
            const stop = event => event.stopPropagation();
            const toggle = event => {
                event.stopPropagation();
                if (view.open) hide(view);
                else { render(node, previewContainer); show(views.get(node)); }
            };
            counter.addEventListener('pointerdown', stop); counter.addEventListener('mousedown', stop); counter.addEventListener('click', toggle);
            view.unbindCounter = () => {
                counter.removeEventListener('pointerdown', stop); counter.removeEventListener('mousedown', stop); counter.removeEventListener('click', toggle);
            };
        }
        previewContainer.append(view.gallery);
        updateSelection(view);
        if (view.open) show(view);
    }
    return { render, destroy };
}
