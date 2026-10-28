import { getCanonicalImageList, getCanonicalImageIndex } from '../features/execution/execution-data-utils.js';
import { getImageOutputAssets, projectImageOutput } from './image-output-projection.js';
import { getSurfaceCoordinator } from '../features/ui/surface-coordinator.js';

export function createImageNodeResults({ state, documentRef, createActions = () => null, readAsset = async () => '',
    readSourceImages = async () => [], createThumbnail = async source => source, rememberThumbnail = () => {},
    scheduleSave = () => {}, onLayout = () => {}, showToast = () => {} }) {
    const views = new WeakMap();
    const surfaces = getSurfaceCoordinator(documentRef);
    const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
    function render(nodeId) {
        const node = state.nodes.get(nodeId), host = documentRef.getElementById(`${nodeId}-image-results`);
        if (node?.type !== 'ImageGenerate' || !host) return;
        const { images, assets, count: outputCount, compacted, missingPositions } = projectImageOutput(node, getCanonicalImageList(node));
        const running = state.runningNodeIds?.has(nodeId) === true || node.runStatus === 'waiting';
        const retained = images.length || Number(node.data?.imageCount) > 0 || node.data?.imageAssetReady === true
            || node.data?.imageMemoryReleased === true;
        const stopped = node.runStatus === 'aborted' || node.runStatus === 'error' || node.isFailed === true;
        const count = running || stopped || !retained ? 0 : outputCount;
        const index = count ? getCanonicalImageIndex(node, new Array(count)) : 0;
        const previous = views.get(host);
        const sameBatch = previous?.node === node && previous.count === count && same(previous.assets, assets)
            && (assets.length > 0 || same(previous.images, images));
        const missingSlots = sameBatch ? previous.missingSlots : new Set();
        missingPositions.forEach(position => missingSlots.add(position));
        const missing = missingSlots.has(index);
        const thumbnail = compacted || missing ? '' : node.data?.imagePreviewThumbnail || '';
        if (previous && previous.node === node && previous.count === count && previous.index === index && previous.missing === missing
            && previous.thumbnail === thumbnail && same(previous.images, images) && same(previous.assets, assets)) return;
        const galleryOpen = sameBatch && previous.galleryOpen;
        const scrollTop = previous?.grid?.scrollTop || 0;
        previous?.dispose?.();
        const menuId = `image-node-batch-${nodeId}`;
        const view = { node, images, assets, count, index, thumbnail, missing, missingSlots, galleryOpen,
            thumbnails: sameBatch ? previous.thumbnails : new Map(), thumbnailRequests: sameBatch ? previous.thumbnailRequests : new Map() };
        view.dispose = () => { view.stopTracking?.(); view.thumbnailObserver?.disconnect(); surfaces?.forgetPopover(menuId); };
        if (!previous) {
            host._cleanupFns ||= [];
            host._cleanupFns.push(() => views.get(host)?.dispose?.());
        }
        views.set(host, view);
        host.replaceChildren(); host.hidden = count === 0;
        if (!count) { onLayout(nodeId); return; }
        const assetKey = assets[index], original = images[index], legacyKey = node.data?.imageAssetKey;
        const isCurrent = () => state.nodes.get(nodeId) === node && !['waiting','error','aborted'].includes(node.runStatus) && !state.runningNodeIds?.has(nodeId)
            && (assetKey ? getImageOutputAssets(node)[index] === assetKey : original
                ? getCanonicalImageList(node)[index] === original : node.data?.imageAssetKey === legacyKey);
        const readOriginalAt = async slot => {
            const key = assets[slot], source = images[slot];
            if (key?.startsWith('media:')) return readAsset(key);
            if (/^data:image\//i.test(source || '')) return source;
            const loaded = await readSourceImages(nodeId);
            if (assets.length && loaded.length !== count) throw new Error('原图批次不完整，请恢复缺失原图。');
            return loaded[slot] || '';
        };
        const readOriginal = () => readOriginalAt(index);
        const loadThumbnail = slot => {
            if (missingSlots.has(slot)) return Promise.reject(new Error('原图缺失'));
            if (view.thumbnails.has(slot)) return Promise.resolve({ thumbnail: view.thumbnails.get(slot), original: images[slot] || '' });
            if (!view.thumbnailRequests.has(slot)) view.thumbnailRequests.set(slot, (async () => {
                const source = await readOriginalAt(slot);
                if (!/^data:image\//i.test(source || '')) throw new Error('原图缺失');
                const result = { original: source, thumbnail: await createThumbnail(source) };
                // Retain only display-sized pixels; the media owner controls originals.
                view.thumbnails.set(slot, result.thumbnail);
                return result;
            })().finally(() => view.thumbnailRequests.delete(slot)));
            return view.thumbnailRequests.get(slot);
        };
        const actions = createActions({ name: `${node.customTitle || '生成结果'} ${index + 1}`, assetKey, isCurrent, readOriginal,
            restoreFocus: () => documentRef.getElementById(`${nodeId}-image-results`)?.querySelector('[data-result-action=preview]')?.focus({ preventScroll: true }) });
        const preview = documentRef.createElement('button'); preview.type = 'button'; preview.className = 'image-node-result-preview';
        preview.dataset.nodeReadAction = 'true'; preview.setAttribute('aria-label', `放大第 ${index + 1} 张生成结果`);
        let pointerDragged = false;
        preview.addEventListener('mousedown', event => {
            view.stopTracking?.();
            pointerDragged = false;
            if (!node.parameterRoot || event.button !== 0) return;
            const { clientX, clientY } = event;
            const track = move => {
                if (Math.abs(move.clientX - clientX) > 2 || Math.abs(move.clientY - clientY) > 2) pointerDragged = true;
            };
            const stop = () => {
                documentRef.removeEventListener('mousemove', track);
                documentRef.removeEventListener('mouseup', stop);
                documentRef.defaultView?.removeEventListener('blur', stop);
                view.stopTracking = null;
            };
            view.stopTracking = stop;
            documentRef.addEventListener('mousemove', track);
            documentRef.addEventListener('mouseup', stop);
            documentRef.defaultView?.addEventListener('blur', stop);
        });
        preview.addEventListener('click', event => {
            if (node.parameterRoot && event.detail && (pointerDragged || state.justDragged)) { event.preventDefault(); event.stopPropagation(); return; }
            if (node.parameterRoot && event.detail === 1) { node.onImageFirstSelect?.(); return; }
            void actions?.execute('preview');
        });
        const image = documentRef.createElement('img'); image.alt = `生成结果 ${index + 1}`; image.decoding = 'async';
        const source = /^data:image\//i.test(original || '') ? original : thumbnail;
        if (source) {
            preview.append(image);
            void createThumbnail(source).then(src => {
                if (views.get(host) !== view || !image.isConnected) return;
                image.src = src;
                rememberThumbnail(nodeId, source, src);
            }).catch(() => {});
        } else {
            preview.textContent = missing ? '原图缺失，请从媒体管理恢复' : '载入图片预览…';
            if (!missing) void loadThumbnail(index).then(result => {
                if (views.get(host) !== view || !isCurrent()) return;
                image.src = result.thumbnail; preview.replaceChildren(image);
                if (result.original) rememberThumbnail(nodeId, result.original, result.thumbnail);
            }).catch(() => {
                if (views.get(host) !== view) return;
                missingSlots.add(index); preview.textContent = '原图缺失，请从媒体管理恢复';
            });
        }
        const media = documentRef.createElement('div'); media.className = 'image-node-result-media';
        media.append(preview); host.append(media);
        const choose = async (next, focusSelector) => {
            if (state.runningNodeIds?.has(nodeId) || state.nodes.get(nodeId) !== node) return;
            try {
                if (!assets[next]?.startsWith('media:') && !getCanonicalImageList(node).length) await readSourceImages(nodeId);
            } catch (error) { if (state.nodes.get(nodeId) === node) showToast(error.message || '原图不可用', 'warning'); return; }
            if (!isCurrent()) return;
            node.imagePreviewIndex = Math.max(0, Math.min(count - 1, next));
            delete node.data.imagePreviewThumbnail;
            render(nodeId); scheduleSave();
            if (focusSelector) host.querySelector(focusSelector)?.focus({ preventScroll: true });
        };
        const navigation = documentRef.createElement('div'); navigation.className = 'image-node-result-navigation';
        for (const direction of [-1, 1]) {
            const control = documentRef.createElement('button'); control.type = 'button'; control.textContent = direction < 0 ? '上一张' : '下一张';
            control.dataset.resultStep = String(direction); control.dataset.nodeReadAction = 'true';
            control.disabled = direction < 0 ? index === 0 : index === count - 1;
            control.addEventListener('click', event => {
                event.stopPropagation();
                void choose(index + direction, `[data-result-step="${direction}"]`);
            });
            navigation.append(control);
        }
        const status = documentRef.createElement('button'); status.type = 'button'; status.className = 'image-node-result-count';
        status.textContent = `${index + 1} / ${count}`; status.dataset.nodeReadAction = 'true';
        status.setAttribute('aria-label', `查看整批 ${count} 张结果，当前第 ${index + 1} 张`);
        status.setAttribute('aria-expanded', String(!!galleryOpen)); status.setAttribute('aria-controls', `${nodeId}-result-batch`);
        navigation.insertBefore(status, navigation.lastElementChild);
        host.append(navigation);
        const gallery = documentRef.createElement('section'); gallery.id = `${nodeId}-result-batch`;
        gallery.className = 'image-node-result-batch'; gallery.hidden = !galleryOpen;
        gallery.setAttribute('aria-label', '整批生成结果');
        const heading = documentRef.createElement('div'); heading.className = 'image-node-result-batch-heading';
        const title = documentRef.createElement('span'); title.textContent = `完整输出 ${count} 张`;
        const close = documentRef.createElement('button'); close.type = 'button'; close.textContent = '×';
        close.setAttribute('aria-label', '关闭整批导航'); close.dataset.nodeReadAction = 'true';
        heading.append(title, close); gallery.append(heading); media.append(gallery);
        function hideGallery() {
            view.galleryOpen = false; gallery.hidden = true; status.setAttribute('aria-expanded', 'false');
            view.thumbnailObserver?.disconnect(); surfaces?.forgetPopover(menuId);
        }
        function showGallery() {
            view.galleryOpen = true; gallery.hidden = false; status.setAttribute('aria-expanded', 'true');
            if (!view.grid) {
                const grid = documentRef.createElement('div'); grid.className = 'image-node-result-batch-grid';
                view.grid = grid;
                for (let slot = 0; slot < count; slot += 1) {
                    const item = documentRef.createElement('button'); item.type = 'button'; item.dataset.resultIndex = String(slot);
                    item.dataset.nodeReadAction = 'true'; item.className = 'image-node-result-thumbnail';
                    item.setAttribute('aria-label', `查看第 ${slot + 1} 张生成结果`); item.setAttribute('aria-pressed', String(slot === index));
                    const number = documentRef.createElement('span'); number.className = 'image-node-result-thumbnail-number'; number.textContent = String(slot + 1);
                    const stateLabel = documentRef.createElement('span'); stateLabel.className = 'image-node-result-thumbnail-state'; stateLabel.textContent = missingSlots.has(slot) ? '原图缺失' : '载入预览…';
                    item.append(number, stateLabel);
                    item.classList.toggle('is-missing', missingSlots.has(slot));
                    item.addEventListener('click', event => { event.stopPropagation(); void choose(slot, `[data-result-index="${slot}"]`); });
                    grid.append(item);
                }
                gallery.append(grid); grid.scrollTop = scrollTop;
            }
            const loadItem = item => {
                const slot = Number(item.dataset.resultIndex);
                void loadThumbnail(slot).then(result => {
                    if (views.get(host) !== view || !item.isConnected) return;
                    const thumbnailImage = documentRef.createElement('img'); thumbnailImage.alt = ''; thumbnailImage.decoding = 'async'; thumbnailImage.src = result.thumbnail;
                    item.querySelector('img')?.remove(); item.prepend(thumbnailImage);
                    item.querySelector('.image-node-result-thumbnail-state').textContent = '';
                }).catch(() => {
                    if (views.get(host) !== view || !item.isConnected) return;
                    missingSlots.add(slot); item.classList.add('is-missing'); item.querySelector('.image-node-result-thumbnail-state').textContent = '原图缺失';
                });
            };
            view.thumbnailObserver?.disconnect();
            const Observer = documentRef.defaultView?.IntersectionObserver;
            if (Observer) {
                view.thumbnailObserver = new Observer(entries => {
                    for (const entry of entries) if (entry.isIntersecting) { view.thumbnailObserver.unobserve(entry.target); loadItem(entry.target); }
                }, { root: view.grid, rootMargin: '32px' });
                view.grid.querySelectorAll('[data-result-index]').forEach(item => view.thumbnailObserver.observe(item));
            } else view.grid.querySelectorAll('[data-result-index]').forEach(loadItem);
            surfaces?.openPopover(menuId, { element: host, trigger: status, close: hideGallery });
        }
        status.addEventListener('click', event => { event.stopPropagation(); if (view.galleryOpen) hideGallery(); else showGallery(); });
        close.addEventListener('click', event => { event.stopPropagation(); hideGallery(); status.focus({ preventScroll: true }); });
        if (galleryOpen) showGallery();
        if (actions) host.append(actions.element);
        onLayout(nodeId);
    }
    return { render };
}
