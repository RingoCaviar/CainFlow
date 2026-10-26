import { getCanonicalImageList, getCanonicalImageIndex } from '../features/execution/execution-data-utils.js';
import { getImageOutputAssets, projectImageOutput } from './image-output-projection.js';

export function createImageNodeResults({ state, documentRef, createActions = () => null, readAsset = async () => '',
    readSourceImages = async () => [], createThumbnail = async source => source, rememberThumbnail = () => {},
    scheduleSave = () => {}, onLayout = () => {}, showToast = () => {} }) {
    const views = new WeakMap();
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
        const previous = views.get(host), missing = missingPositions.includes(index);
        const thumbnail = compacted || missing ? '' : node.data?.imagePreviewThumbnail || '';
        if (previous && previous.node === node && previous.count === count && previous.index === index && previous.missing === missing
            && previous.thumbnail === thumbnail && same(previous.images, images) && same(previous.assets, assets)) return;
        const view = { node, images, assets, count, index, thumbnail, missing }; views.set(host, view);
        host.replaceChildren(); host.hidden = count === 0;
        if (!count) { onLayout(nodeId); return; }
        const assetKey = assets[index], original = images[index], legacyKey = node.data?.imageAssetKey;
        const isCurrent = () => state.nodes.get(nodeId) === node && !['waiting','error','aborted'].includes(node.runStatus) && !state.runningNodeIds?.has(nodeId)
            && (assetKey ? getImageOutputAssets(node)[index] === assetKey : original
                ? getCanonicalImageList(node)[index] === original : node.data?.imageAssetKey === legacyKey);
        const readOriginal = async () => {
            if (assetKey?.startsWith('media:')) return readAsset(assetKey);
            if (/^data:image\//i.test(original || '')) return original;
            return (await readSourceImages(nodeId))[index] || '';
        };
        const actions = createActions({ name: `${node.customTitle || '生成结果'} ${index + 1}`, assetKey, isCurrent, readOriginal,
            restoreFocus: () => documentRef.getElementById(`${nodeId}-image-results`)?.querySelector('[data-result-action=preview]')?.focus({ preventScroll: true }) });
        const preview = documentRef.createElement('button'); preview.type = 'button'; preview.className = 'image-node-result-preview';
        preview.dataset.nodeReadAction = 'true'; preview.setAttribute('aria-label', `放大第 ${index + 1} 张生成结果`);
        preview.addEventListener('click', () => { void actions?.execute('preview'); });
        const image = documentRef.createElement('img'); image.alt = `生成结果 ${index + 1}`; image.decoding = 'async';
        const source = /^data:image\//i.test(original || '') ? original : thumbnail;
        if (source) {
            preview.append(image);
            void createThumbnail(source).then(src => {
                if (views.get(host) !== view || !image.isConnected) return;
                image.src = src;
                rememberThumbnail(nodeId, source, src);
            }).catch(() => {});
        } else preview.textContent = missing ? '原图缺失，请从媒体管理恢复' : '按需载入原图';
        host.append(preview);
        const navigation = documentRef.createElement('div'); navigation.className = 'image-node-result-navigation';
        for (const direction of [-1, 1]) {
            const control = documentRef.createElement('button'); control.type = 'button'; control.textContent = direction < 0 ? '上一张' : '下一张';
            control.dataset.resultStep = String(direction); control.dataset.nodeReadAction = 'true';
            control.disabled = direction < 0 ? index === 0 : index === count - 1;
            control.addEventListener('click', async event => {
                event.stopPropagation();
                if (state.runningNodeIds?.has(nodeId) || state.nodes.get(nodeId) !== node) return;
                try {
                    if (!getCanonicalImageList(node).length) await readSourceImages(nodeId);
                } catch (error) { if (state.nodes.get(nodeId) === node) showToast(error.message || '原图不可用', 'warning'); return; }
                if (!isCurrent()) return;
                node.imagePreviewIndex = Math.max(0, Math.min(count - 1, index + direction));
                delete node.data.imagePreviewThumbnail;
                render(nodeId); scheduleSave();
                host.querySelector(`[data-result-step="${direction}"]`)?.focus({ preventScroll: true });
            });
            if (direction > 0) { const status = documentRef.createElement('output'); status.className = 'image-node-result-count'; status.textContent = `${index + 1} / ${count}`; navigation.append(status); }
            navigation.append(control);
        }
        host.append(navigation);
        if (actions) host.append(actions.element);
        onLayout(nodeId);
    }
    return { render };
}
