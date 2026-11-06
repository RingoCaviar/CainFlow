import { normalizeImageList } from '../features/execution/execution-data-utils.js';
import { getImageOutputAssets } from './image-output-projection.js';
import { projectImageReferences } from './image-reference-projection.js';
import { getImageDescription } from '../features/execution/reference-image-description.js';


// A disposable projection of connections and existing outputs, never an attachment store.
export function createImageReferenceOverview({ state, documentRef, getCachedOutputValue,
    createThumbnail = async source => source, readSourceImages = async () => [], readAsset = null, openPreview = () => {},
    focusNode = () => {}, getWorkflowId = () => '', showToast = () => {}, onLayout = () => {},
    moveSource = () => false, disconnectSource = () => false }) {
    const views = new WeakMap();
    const assetsOf = getImageOutputAssets;
    const sameList = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
    const button = (label, action, disabled) => {
        const control = documentRef.createElement('button');
        control.type = 'button'; control.textContent = label; control.disabled = disabled;
        control.dataset.nodeReadAction = 'true';
        control.addEventListener('click', event => { event.stopPropagation(); action(control); });
        return control;
    };
    const connectionButton = (label, action, disabled, className) => {
        const control = button(label, action, disabled);
        delete control.dataset.nodeReadAction;
        control.dataset.nodeConnectionAction = 'true'; control.className = className;
        return control;
    };

    function render(nodeId) {
        const target = state.nodes.get(nodeId);
        const container = documentRef.getElementById(`${nodeId}-reference-sources`);
        if (target?.type !== 'ImageGenerate' || !container) return;
        let view = views.get(container);
        if (!view) {
            view = { groups: [], revision: 0 };
            views.set(container, view);
            if (!Array.isArray(target.el._cleanupFns)) target.el._cleanupFns = [];
            target.el._cleanupFns.push(() => {
                view.stopThumbnails?.();
                views.delete(container);
            });
        }
        const disabled = state.runningNodeIds?.has(nodeId) === true || target.runStatus === 'waiting';
        const projection = projectImageReferences({ state, targetId: nodeId, getOutput: getCachedOutputValue });
        const groups = projection.groups.map(group => {
            const downstreamIds = [...new Set(state.connections.filter(edge => edge.from.nodeId === group.source?.id).map(edge => edge.to.nodeId))];
            return { ...group, downstreamIds,
                descriptions: Array.from({ length: Math.max(1, group.count) }, (_, index) => getImageDescription(group.source, index)),
                downstreamRunning: downstreamIds.some(id => state.runningNodeIds?.has(id) || ['waiting', 'running'].includes(state.nodes.get(id)?.runStatus))
            };
        });
        if (view.disabled === disabled && view.groups.length === groups.length && groups.every((group, index) => {
            const old = view.groups[index];
            return old.connection.id === group.connection.id && old.source === group.source && old.name === group.name
                && old.count === group.count && old.missing === group.missing && old.enabled === group.enabled
                && old.running === group.running && old.remote === group.remote && old.thumbnail === group.thumbnail
                && old.downstreamRunning === group.downstreamRunning
                && sameList(old.descriptions, group.descriptions) && sameList(old.downstreamIds, group.downstreamIds)
                && sameList(old.missingPositions, group.missingPositions)
                && sameList(old.images, group.images) && sameList(old.assets, group.assets);
        })) return;
        view.stopThumbnails?.();
        view.drag = null;
        view.groups = groups; view.disabled = disabled; view.revision += 1;
        const revision = view.revision;
        const scrollTop = container.querySelector('.image-reference-grid')?.scrollTop || 0;
        container.replaceChildren();
        if (!groups.length) { container.textContent = '连接参考图来源后，在此核对图片与输入顺序。'; onLayout(nodeId); return; }
        const gallery = documentRef.createElement('div'); gallery.className = 'image-reference-grid';
        gallery.setAttribute('role', 'group'); gallery.setAttribute('aria-label', '参考图，拖动缩略图调整来源顺序，图片较多时可滚动');
        gallery.tabIndex = 0;
        container.append(gallery);
        const pendingThumbnails = new Map();
        const Observer = documentRef.defaultView?.IntersectionObserver;
        let thumbnailObserver = null;
        view.stopThumbnails = () => { thumbnailObserver?.disconnect(); pendingThumbnails.clear(); };
        const watchThumbnail = (control, image, source) => {
            if (!Observer) {
                // Native lazy images are the fallback; do not eagerly create
                // a mipmap for every source when visibility observation is absent.
                if (typeof source === 'string') image.src = source;
                else void source().then(src => { if (image.isConnected) image.src = src; }).catch(() => image.remove());
                return;
            }
            pendingThumbnails.set(control, () => {
                void Promise.resolve().then(() => typeof source === 'function' ? source() : source).then(createThumbnail).then(src => {
                    if (views.get(container) === view && view.revision === revision && image.isConnected) image.src = src;
                }).catch(() => { image.remove(); });
            });
            if (!thumbnailObserver) {
                thumbnailObserver = new Observer(entries => {
                    if (views.get(container) !== view || view.revision !== revision) return;
                    for (const entry of entries) {
                        // An editor parked in the hidden store has no layout.
                        if (!entry.isIntersecting || !gallery.getClientRects().length || !entry.target.getClientRects().length) continue;
                        const load = pendingThumbnails.get(entry.target);
                        if (!load) continue;
                        pendingThumbnails.delete(entry.target);
                        thumbnailObserver.unobserve(entry.target);
                        load();
                    }
                }, { root: gallery, rootMargin: '32px 0px', threshold: 0 });
            }
            thumbnailObserver.observe(control);
        };
        const slots = new Map(projection.slots.map(slot => [`${slot.connection.id}:${slot.index}`, slot]));
        const moveLocked = disabled || groups.some(group => group.running);
        const mutate = (operation, connectionId, focusSelector = '.image-reference-thumbnail:not(:disabled)') => {
            if (state.nodes.get(nodeId) !== target) return;
            try {
                if (!operation()) { showToast('当前不能修改来源连接，请检查运行状态。', 'warning'); return; }
                render(nodeId);
                const row = [...container.querySelectorAll('.image-reference-group')].find(item => item.dataset.referenceConnection === connectionId);
                const control = row?.querySelector(focusSelector) || row?.querySelector('.image-reference-disconnect:not(:disabled)')
                    || container.querySelector('.image-reference-thumbnail:not(:disabled), .image-reference-disconnect:not(:disabled)')
                    || target.parameterRoot?.querySelector('textarea') || target.el.querySelector('textarea');
                const grid = control?.closest('.image-reference-grid');
                if (grid) {
                    const bounds = grid.getBoundingClientRect(), rect = control.getBoundingClientRect();
                    if (rect.top < bounds.top) grid.scrollTop -= bounds.top - rect.top + 2;
                    else if (rect.bottom > bounds.bottom) grid.scrollTop += rect.bottom - bounds.bottom + 2;
                }
                control?.focus({ preventScroll: true });
            } catch (error) { showToast(error.message || '来源连接修改失败', 'warning'); }
        };
        const clearDrag = () => {
            view.drag = null;
            gallery.querySelectorAll('.is-dragging, .is-drop-target').forEach(row => row.classList.remove('is-dragging', 'is-drop-target'));
        };
        for (const [groupIndex, group] of groups.entries()) {
            const row = documentRef.createElement('div'); row.className = `image-reference-group${group.count === 1 ? ' image-reference-single' : group.count > 1 ? ' image-reference-batch' : ''}`;
            row.dataset.referenceConnection = group.connection.id;
            row.dataset.enabled = String(group.enabled);
            row.setAttribute('role', 'group'); row.setAttribute('aria-label', `${group.name} · ${group.count} 张`);
            row.addEventListener('dragstart', event => {
                if (moveLocked || groups.length < 2 || event.target.closest('.image-reference-disconnect')) { event.preventDefault(); return; }
                event.stopPropagation();
                view.drag = { workflowId: getWorkflowId(), target, connectionId: group.connection.id };
                event.dataTransfer?.setData('application/x-cainflow-reference', group.connection.id);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                row.classList.add('is-dragging');
            });
            row.addEventListener('dragend', clearDrag);
            row.addEventListener('dragover', event => {
                if (!view.drag || moveLocked) return;
                event.preventDefault(); event.stopPropagation();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                gallery.querySelectorAll('.is-drop-target').forEach(other => other.classList.remove('is-drop-target'));
                if (view.drag.connectionId !== group.connection.id) row.classList.add('is-drop-target');
            });
            row.addEventListener('dragleave', event => { if (!row.contains(event.relatedTarget)) row.classList.remove('is-drop-target'); });
            row.addEventListener('drop', event => {
                if (!view.drag) return;
                event.preventDefault(); event.stopPropagation();
                const pending = view.drag; clearDrag();
                if (moveLocked || pending.workflowId !== getWorkflowId() || pending.target !== state.nodes.get(nodeId) || pending.connectionId === group.connection.id) return;
                mutate(() => moveSource(nodeId, pending.connectionId, group.connection.id), pending.connectionId);
            });
            const disconnectLocked = disabled || group.running;
            const disconnect = () => {
                if (disconnectLocked) return;
                const next = groups[groupIndex + 1] || groups[groupIndex - 1];
                mutate(() => disconnectSource(nodeId, group.connection.id), next?.connection.id);
            };
            row.addEventListener('keydown', event => {
                if (event.target.closest('.image-reference-disconnect')) return;
                if (event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); disconnect(); }
                else if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
                    event.preventDefault(); event.stopPropagation();
                    const neighbor = groups[groupIndex + (event.key === 'ArrowLeft' ? -1 : 1)];
                    if (!moveLocked && neighbor) mutate(() => moveSource(nodeId, group.connection.id, neighbor.connection.id), group.connection.id);
                } else if (event.altKey && event.key === 'Enter' && group.source) {
                    event.preventDefault(); event.stopPropagation(); focusNode(group.source.id);
                }
            });
            const strip = documentRef.createElement('div'); strip.className = 'image-reference-thumbnails';
            let sourceImages;
            for (let index = 0; index < Math.max(1, group.count); index += 1) {
                const empty = group.count === 0;
                const number = slots.get(`${group.connection.id}:${index}`)?.number;
                const label = `${number ? `参考图 ${number}` : group.running ? '来源运行中' : empty ? '等待来源输出' : '已停用来源'}，来自${group.name}${empty ? '' : `，源批次第 ${index + 1} 张`}`;
                const asset = group.assets[index], original = group.images[index];
                const missing = group.missingPositions.includes(index);
                const tile = documentRef.createElement('div'); tile.className = 'image-reference-item image-reference-drag';
                tile.draggable = !moveLocked && groups.length > 1;
                tile.dataset.reorderDisabled = String(moveLocked);
                const preview = button('', async control => {
                    if (empty) { if (group.source) focusNode(group.source.id); return; }
                    control.focus();
                    const workflowId = getWorkflowId();
                    try {
                        const durable = readAsset && group.assets.length && group.assets.every(key => key.startsWith('media:'));
                        const images = group.remote ? group.images.slice() : durable ? await Promise.all(group.assets.map(key => readAsset(key).catch(() => '')))
                            : await readSourceImages(group.source.id);
                        if (!durable && images.length !== group.count) throw new Error('原图批次不完整，请定位来源恢复。');
                        if (getWorkflowId() !== workflowId || state.nodes.get(nodeId) !== target || state.nodes.get(group.source.id) !== group.source
                            || state.runningNodeIds?.has(group.source.id) || group.source.runStatus === 'waiting') return;
                        const currentAsset = assetsOf(group.source)[index];
                        const currentImage = normalizeImageList(getCachedOutputValue(group.source, group.connection.from.port))[index];
                        if ((asset && asset !== currentAsset) || (!asset && original !== currentImage)) throw new Error('来源图片已改变，请重新查看。');
                        if (!images[index]) throw new Error('原图缺失，请定位来源恢复。');
                        render(nodeId);
                        const complete = images.every(Boolean);
                        await openPreview(complete ? images : [images[index]], complete ? index : 0, () => {
                            if (getWorkflowId() !== workflowId || state.nodes.get(nodeId) !== target) return;
                            documentRef.defaultView.requestAnimationFrame(() => {
                                if (getWorkflowId() !== workflowId || state.nodes.get(nodeId) !== target) return;
                                target.onImageFirstSelect?.('reference');
                                const row = [...container.querySelectorAll('.image-reference-group')].find(item => item.dataset.referenceConnection === group.connection.id);
                                const current = [...(row?.querySelectorAll('[data-source-image-index]') || [])].find(item => Number(item.dataset.sourceImageIndex) === index);
                                if (current?.isConnected && !current.disabled && !current.closest('[inert]')) current.focus({ preventScroll: true });
                            });
                        });
                    } catch (error) {
                        if (getWorkflowId() === workflowId && state.nodes.get(nodeId) === target) showToast(error.message || '原图不可用', 'warning');
                    }
                }, disabled || group.running || missing || (!empty && !asset && !original));
                preview.className = 'image-reference-thumbnail';
                if (number) preview.dataset.referenceNumber = String(number);
                if (!empty) preview.dataset.sourceImageIndex = String(index);
                preview.setAttribute('aria-label', label);
                preview.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight Delete Alt+Enter');
                preview.title = `${label}\n拖动排序；Alt+←/→调整来源顺序；Delete断开来源；Alt+Enter定位来源`;
                preview.innerHTML = '<svg class="image-reference-placeholder" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 5 5 3-3 4 4"/></svg>';
                const image = documentRef.createElement('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.draggable = false;
                const thumbnail = missing || group.running || empty ? '' : /^data:image\//i.test(original || '') ? original : (group.count === 1 ? group.thumbnail : '');
                if (thumbnail) {
                    preview.append(image);
                    watchThumbnail(preview, image, thumbnail);
                } else if (!empty && !missing && !group.running && !group.remote) {
                    preview.append(image);
                    watchThumbnail(preview, image, () => asset?.startsWith('media:') && readAsset ? readAsset(asset)
                        : (sourceImages ||= readSourceImages(group.source.id)).then(images => images[index]));
                }
                if (number) {
                    const badge = documentRef.createElement('span'); badge.className = 'image-reference-number'; badge.textContent = String(number); badge.setAttribute('aria-hidden', 'true'); preview.append(badge);
                }
                if (missing || group.running || empty) {
                    const hint = documentRef.createElement('small'); hint.textContent = group.running ? '运行中' : missing ? '缺图' : '待输出'; preview.append(hint);
                }
                const remove = connectionButton('', disconnect, disconnectLocked, 'image-reference-disconnect');
                remove.setAttribute('aria-label', `断开参考来源：${group.name}${group.count > 1 ? `（整组 ${group.count} 张）` : ''}`); remove.title = remove.getAttribute('aria-label');
                remove.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
                tile.append(preview, remove); strip.append(tile);
            }
            row.append(strip);
            gallery.append(row);
        }
        gallery.scrollTop = scrollTop;
        onLayout(nodeId);
    }

    function refreshSource(sourceNodeId) {
        const targets = new Set(state.connections.filter(c => c.from.nodeId === sourceNodeId && (c.to.port === 'referenceImages' || /^image_\d+$/.test(c.to.port))).map(c => c.to.nodeId));
        if (state.nodes.get(sourceNodeId)?.type === 'ImageGenerate') targets.add(sourceNodeId);
        targets.forEach(render);
    }
    return { render, refreshSource };
}
