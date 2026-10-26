import { normalizeImageList, getImageImportMediaAssetReferences } from '../features/execution/execution-data-utils.js';
import { orderInputConnections } from './reference-image-ports.js';

// A disposable projection of connections and existing outputs, never an attachment store.
export function createImageReferenceOverview({ state, documentRef, getCachedOutputValue,
    createThumbnail = async source => source, readSourceImages = async () => [], openPreview = () => {},
    focusNode = () => {}, getWorkflowId = () => '', showToast = () => {}, onLayout = () => {},
    moveSource = () => false, disconnectSource = () => false }) {
    const views = new WeakMap();
    const assetsOf = source => {
        if (source?.type === 'ImageImport') return getImageImportMediaAssetReferences(source);
        if (source?.data?.mediaAssetKeys?.length) return source.data.mediaAssetKeys;
        return source?.data?.imageAssetKey
            ? Array.from({ length: Math.max(1, Number(source.data.imageCount) || 0) }, (_, index) => `${source.data.imageAssetKey}:${index}`)
            : [];
    };
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
        if (!view) { view = { expanded: false, groups: [], revision: 0 }; views.set(container, view); }
        const disabled = state.runningNodeIds?.has(nodeId) === true || target.runStatus === 'waiting';
        const groups = orderInputConnections('ImageGenerate', state.connections.filter(connection => connection.to.nodeId === nodeId
            && (connection.to.port === 'referenceImages' || /^image_\d+$/.test(connection.to.port))))
            .map(connection => {
                const source = state.nodes.get(connection.from.nodeId);
                const images = normalizeImageList(getCachedOutputValue(source, connection.from.port));
                const assets = [...assetsOf(source)];
                const running = state.runningNodeIds?.has(source?.id) === true || source?.runStatus === 'waiting';
                return { connection, source, images: running ? [] : images, assets: running ? [] : assets,
                    count: running ? 0 : Math.max(images.length, assets.length, Number(source?.data?.imageCount) || 0),
                    name: source?.customTitle || source?.el?.querySelector('.node-title')?.textContent || source?.type || '来源已不存在',
                    missing: source?.data?.mediaIntegrity?.state === 'missing', enabled: source?.enabled !== false,
                    running, thumbnail: source?.data?.imagePreviewThumbnail || '' };
            });
        if (view.disabled === disabled && view.groups.length === groups.length && groups.every((group, index) => {
            const old = view.groups[index];
            return old.connection.id === group.connection.id && old.source === group.source && old.name === group.name
                && old.count === group.count && old.missing === group.missing && old.enabled === group.enabled
                && old.running === group.running && old.thumbnail === group.thumbnail
                && sameList(old.images, group.images) && sameList(old.assets, group.assets);
        })) return;
        view.groups = groups; view.disabled = disabled; view.revision += 1;
        const revision = view.revision;
        container.replaceChildren();
        if (!groups.length) { container.textContent = '连接参考图来源后，在此核对图片与输入顺序。'; onLayout(nodeId); return; }
        let number = 0, hidden = 0;
        const moveLocked = disabled || groups.some(group => group.running);
        const mutate = (operation, connectionId) => {
            if (state.nodes.get(nodeId) !== target) return;
            try {
                if (!operation()) { showToast('当前不能修改来源连接，请检查运行状态。', 'warning'); return; }
                render(nodeId);
                const row = [...container.querySelectorAll('.image-reference-group')].find(item => item.dataset.referenceConnection === connectionId);
                const control = row?.querySelector('.image-reference-locate') || container.querySelector('.image-reference-locate') || target.el.querySelector('textarea');
                control?.focus({ preventScroll: true });
            } catch (error) { showToast(error.message || '来源连接修改失败', 'warning'); }
        };
        for (const [groupIndex, group] of groups.entries()) {
            const row = documentRef.createElement('div'); row.className = 'image-reference-group';
            row.dataset.referenceConnection = group.connection.id;
            const heading = documentRef.createElement('div'); heading.className = 'image-reference-heading';
            const locate = button(`${group.name} · ${group.count} 张`, () => focusNode(group.source.id), disabled || !group.source);
            locate.className = 'image-reference-locate'; locate.title = '定位来源节点';
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
            heading.append(drag, locate, up, down); row.append(heading);
            const strip = documentRef.createElement('div'); strip.className = 'image-reference-thumbnails';
            for (let index = 0; index < group.count; index += 1) {
                number += 1;
                if (!view.expanded && number > 4) { hidden += 1; continue; }
                const label = `参考图 ${number}，来自${group.name}，源批次第 ${index + 1} 张`;
                const asset = group.assets[index], original = group.images[index];
                const preview = button(String(number), async control => {
                    control.focus();
                    const workflowId = getWorkflowId();
                    try {
                        const images = await readSourceImages(group.source.id);
                        if (getWorkflowId() !== workflowId || state.nodes.get(nodeId) !== target || state.nodes.get(group.source.id) !== group.source
                            || state.runningNodeIds?.has(group.source.id) || group.source.runStatus === 'waiting') return;
                        const currentAsset = assetsOf(group.source)[index];
                        const currentImage = normalizeImageList(getCachedOutputValue(group.source, group.connection.from.port))[index];
                        if ((asset && asset !== currentAsset) || (!asset && original !== currentImage)) throw new Error('来源图片已改变，请重新查看。');
                        if (!images[index]) throw new Error('原图缺失，请定位来源恢复。');
                        render(nodeId);
                        await openPreview(images, index, () => {
                            if (getWorkflowId() !== workflowId || state.nodes.get(nodeId) !== target) return;
                            const row = [...container.querySelectorAll('.image-reference-group')].find(item => item.dataset.referenceConnection === group.connection.id);
                            const current = [...(row?.querySelectorAll('[data-source-image-index]') || [])].find(item => Number(item.dataset.sourceImageIndex) === index);
                            if (current?.isConnected && !current.disabled && !current.closest('[inert]')) current.focus({ preventScroll: true });
                        });
                    } catch (error) {
                        if (getWorkflowId() === workflowId && state.nodes.get(nodeId) === target) showToast(error.message || '原图不可用', 'warning');
                    }
                }, disabled || !group.enabled || group.missing || (!asset && !original));
                preview.className = 'image-reference-thumbnail'; preview.dataset.referenceNumber = String(number);
                preview.dataset.sourceImageIndex = String(index);
                preview.setAttribute('aria-label', label); preview.title = label;
                const image = documentRef.createElement('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
                const thumbnail = /^data:image\//i.test(original || '') ? original : (group.count === 1 ? group.thumbnail : '');
                if (thumbnail) {
                    preview.prepend(image);
                    void createThumbnail(thumbnail).then(src => {
                        if (views.get(container)?.revision === revision && image.isConnected) image.src = src;
                    }).catch(() => { image.remove(); });
                } else {
                    const hint = documentRef.createElement('small'); hint.textContent = '按需预览'; preview.append(hint);
                }
                strip.append(preview);
            }
            row.append(strip);
            const disconnect = connectionButton(`断开 ${group.count} 张`, () => mutate(() => disconnectSource(nodeId, group.connection.id), group.connection.id), disabled || group.running, 'image-reference-disconnect');
            disconnect.title = '仅断开此来源连接，保留源节点和原图';
            disconnect.setAttribute('aria-label', `断开${group.name}来源连接，影响 ${group.count} 张图片，保留源节点和原图`);
            row.append(disconnect);
            if (!group.source || !group.enabled || group.missing || !group.count) {
                const status = documentRef.createElement('p'); status.className = 'image-reference-source-status';
                status.textContent = !group.source ? '来源节点已不存在' : !group.enabled ? '来源已禁用'
                    : group.missing ? '原图缺失，请定位来源恢复' : group.running ? '来源运行中，尚无本轮输出' : '尚无输出';
                row.append(status);
            }
            container.append(row);
        }
        if (hidden || view.expanded && number > 4) {
            const expand = button(view.expanded ? '收起参考图' : `展开其余 ${hidden} 张`, () => {
                view.expanded = !view.expanded; view.disabled = undefined; render(nodeId);
                container.querySelector('.image-reference-expand')?.focus(); onLayout(nodeId);
            }, disabled);
            expand.className = 'image-reference-expand'; expand.setAttribute('aria-expanded', String(view.expanded));
            container.append(expand);
        }
        onLayout(nodeId);
    }

    function refreshSource(sourceNodeId) {
        const targets = new Set(state.connections.filter(c => c.from.nodeId === sourceNodeId && (c.to.port === 'referenceImages' || /^image_\d+$/.test(c.to.port))).map(c => c.to.nodeId));
        if (state.nodes.get(sourceNodeId)?.type === 'ImageGenerate') targets.add(sourceNodeId);
        targets.forEach(render);
    }
    return { render, refreshSource };
}
