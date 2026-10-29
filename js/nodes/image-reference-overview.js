import { normalizeImageList } from '../features/execution/execution-data-utils.js';
import { getImageOutputAssets } from './image-output-projection.js';
import { projectImageReferences } from './image-reference-projection.js';
import { getImageDescription } from '../features/execution/reference-image-description.js';


// A disposable projection of connections and existing outputs, never an attachment store.
export function createImageReferenceOverview({ state, documentRef, getCachedOutputValue,
    createThumbnail = async source => source, readSourceImages = async () => [], readAsset = null, openPreview = () => {},
    focusNode = () => {}, getWorkflowId = () => '', showToast = () => {}, onLayout = () => {},
    moveSource = () => false }) {
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
            view = { expanded: false, groups: [], revision: 0 };
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
        view.groups = groups; view.disabled = disabled; view.revision += 1;
        const revision = view.revision;
        const scrollTop = container.querySelector('.image-reference-grid')?.scrollTop || 0;
        container.replaceChildren();
        if (!groups.length) { container.textContent = '连接参考图来源后，在此核对图片与输入顺序。'; onLayout(nodeId); return; }
        container.dataset.expanded = String(view.expanded);
        const gallery = documentRef.createElement('div'); gallery.className = 'image-reference-grid';
        gallery.setAttribute('role', 'group'); gallery.setAttribute('aria-label', '参考图来源，图片较多时可滚动');
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
                image.src = source;
                return;
            }
            pendingThumbnails.set(control, () => {
                void Promise.resolve().then(() => createThumbnail(source)).then(src => {
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
        const mutate = (operation, connectionId, focusSelector = '.image-reference-locate') => {
            if (state.nodes.get(nodeId) !== target) return;
            try {
                if (!operation()) { showToast('当前不能修改来源连接，请检查运行状态。', 'warning'); return; }
                render(nodeId);
                const row = [...container.querySelectorAll('.image-reference-group')].find(item => item.dataset.referenceConnection === connectionId);
                const control = row?.querySelector(focusSelector) || container.querySelector('.image-reference-locate') || target.el.querySelector('textarea');
                const grid = row?.closest('.image-reference-grid');
                if (grid) {
                    if (row.offsetHeight > grid.clientHeight || row.offsetTop < grid.scrollTop) grid.scrollTop = row.offsetTop;
                    else if (row.offsetTop + row.offsetHeight > grid.scrollTop + grid.clientHeight) {
                        grid.scrollTop = row.offsetTop + row.offsetHeight - grid.clientHeight;
                    }
                }
                control?.focus({ preventScroll: true });
            } catch (error) { showToast(error.message || '来源连接修改失败', 'warning'); }
        };
        for (const [groupIndex, group] of groups.entries()) {
            const row = documentRef.createElement('div'); row.className = `image-reference-group${group.count === 1 ? ' image-reference-single' : group.count > 1 ? ' image-reference-batch' : ''}`;
            row.dataset.referenceConnection = group.connection.id;
            row.dataset.enabled = String(group.enabled);
            const heading = documentRef.createElement('div'); heading.className = 'image-reference-heading';
            const locate = button(`${group.name} · ${group.running ? '运行中' : `${group.count} 张`}`, () => focusNode(group.source.id), disabled || !group.source);
            locate.className = 'image-reference-locate'; locate.title = `定位来源：${group.name} · ${group.count} 张`;
            const drag = connectionButton('⠿', () => {}, moveLocked, 'image-reference-drag');
            drag.setAttribute('aria-label', `拖动${group.name}来源组`); drag.draggable = !moveLocked;
            drag.addEventListener('dragstart', event => {
                if (moveLocked) { event.preventDefault(); return; }
                event.stopPropagation();
                view.drag = { workflowId: getWorkflowId(), target, connectionId: group.connection.id };
                event.dataTransfer?.setData('application/x-cainflow-reference', group.connection.id);
            });
            drag.addEventListener('dragend', () => { view.drag = null; });
            row.addEventListener('dragover', event => {
                if (!view.drag || moveLocked) return;
                event.preventDefault(); event.stopPropagation();
            });
            row.addEventListener('drop', event => {
                if (!view.drag) return;
                event.preventDefault(); event.stopPropagation();
                const pending = view.drag; view.drag = null;
                if (moveLocked || pending.workflowId !== getWorkflowId() || pending.target !== state.nodes.get(nodeId) || pending.connectionId === group.connection.id) return;
                mutate(() => moveSource(nodeId, pending.connectionId, group.connection.id), pending.connectionId);
            });
            const up = connectionButton('↑', () => mutate(() => moveSource(nodeId, group.connection.id, groups[groupIndex - 1]?.connection.id), group.connection.id), moveLocked || groupIndex === 0, 'image-reference-move-up');
            up.setAttribute('aria-label', `前移${group.name}来源组`); up.title = '前移来源组';
            const down = connectionButton('↓', () => mutate(() => moveSource(nodeId, group.connection.id, groups[groupIndex + 1]?.connection.id), group.connection.id), moveLocked || groupIndex === groups.length - 1, 'image-reference-move-down');
            down.setAttribute('aria-label', `后移${group.name}来源组`); down.title = '后移来源组';
            heading.append(drag, locate); row.append(heading);
            const strip = documentRef.createElement('div'); strip.className = 'image-reference-thumbnails';
            for (let index = 0; index < group.count; index += 1) {
                const number = slots.get(`${group.connection.id}:${index}`)?.number;
                const label = `${number ? `参考图 ${number}` : group.running ? '来源运行中' : '已停用来源'}，来自${group.name}，源批次第 ${index + 1} 张`;
                const asset = group.assets[index], original = group.images[index];
                const missing = group.missingPositions.includes(index);
                const preview = button(String(number || index + 1), async control => {
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
                            const row = [...container.querySelectorAll('.image-reference-group')].find(item => item.dataset.referenceConnection === group.connection.id);
                            const current = [...(row?.querySelectorAll('[data-source-image-index]') || [])].find(item => Number(item.dataset.sourceImageIndex) === index);
                            if (current?.isConnected && !current.disabled && !current.closest('[inert]')) current.focus({ preventScroll: true });
                        });
                    } catch (error) {
                        if (getWorkflowId() === workflowId && state.nodes.get(nodeId) === target) showToast(error.message || '原图不可用', 'warning');
                    }
                }, disabled || group.running || missing || (!asset && !original));
                preview.className = 'image-reference-thumbnail';
                if (number) preview.dataset.referenceNumber = String(number);
                preview.dataset.sourceImageIndex = String(index);
                preview.setAttribute('aria-label', label); preview.title = label;
                const image = documentRef.createElement('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
                const thumbnail = missing || group.running ? '' : /^data:image\//i.test(original || '') ? original : (group.count === 1 ? group.thumbnail : '');
                if (thumbnail) {
                    preview.prepend(image);
                    watchThumbnail(preview, image, thumbnail);
                } else {
                    const hint = documentRef.createElement('small'); hint.textContent = group.running ? '运行中' : missing ? '原图缺失' : '按需预览'; preview.append(hint);
                }
                strip.append(preview);
            }
            row.append(strip);
            const tools = documentRef.createElement('div'); tools.className = 'image-reference-tools';
            tools.append(up, down); row.append(tools);
            gallery.append(row);
        }
        if (projection.count > 4 || groups.length > 4) {
            const expand = button(view.expanded ? '收起参考图' : `展开查看 · ${projection.count} 张 / ${groups.length} 个来源`, () => {
                view.expanded = !view.expanded; view.disabled = undefined; render(nodeId);
                container.querySelector('.image-reference-expand')?.focus(); onLayout(nodeId);
            }, disabled);
            expand.className = 'image-reference-expand'; expand.setAttribute('aria-expanded', String(view.expanded));
            container.append(expand);
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
