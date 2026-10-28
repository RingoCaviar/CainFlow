import { getCanonicalImageList, normalizeImageList, setCanonicalImageOutput } from '../execution/execution-data-utils.js';
import { isRemoteImageUrl } from './utils/image-validation-utils.js';

const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const imageCount = node => Math.max(getCanonicalImageList(node).length, node?.data?.mediaAssetKeys?.length || 0, Number(node?.data?.imageCount) || 0);
const videosOf = node => (Array.isArray(node?.data?.videos) && node.data.videos.length ? node.data.videos : [node?.data?.video])
    .filter(video => video && typeof video === 'object' && (video.url || video.assetKey));

export function resolveImagePreviewInputState(node, input) {
    return normalizeImageList(input).length ? 'current' : imageCount(node) ? 'stale' : 'empty';
}

/** Visible and detached saves use the same partial-input decision; image storage stays with their media adapter. */
export function applyImageSaveMediaState(node, imageData) {
    node.data ||= {};
    const images = normalizeImageList(imageData?.images ?? imageData);
    const videos = (Array.isArray(imageData?.videos) ? imageData.videos : [imageData?.video])
        .filter(video => video && typeof video === 'object' && (video.url || video.assetKey)).map(copy);
    const remote = images.some(isRemoteImageUrl);
    const input = { images: remote ? [] : images, videos, remote };
    if (videos.length) {
        node.data.videos = videos;
        node.data.video = copy(videos.at(-1));
    }
    const retained = imageCount(node) > 0 || input.images.length > 0 || videosOf(node).length > 0;
    const staleImage = Object.hasOwn(imageData || {}, 'images') && !input.images.length && imageCount(node) > 0;
    const staleVideo = (Object.hasOwn(imageData || {}, 'videos') || Object.hasOwn(imageData || {}, 'video')) && !videos.length && videosOf(node).length > 0;
    node.saveInputState = remote || staleImage || staleVideo || (!input.images.length && !videos.length)
        ? retained ? 'stale' : 'empty' : 'current';
    node.saveInputMessage = remote ? 'URL 图片不支持保存，原有媒体未更新'
        : staleImage && videos.length ? '图片输入未更新，保留原图片；视频已更新'
            : staleVideo && input.images.length ? '视频输入未更新，保留原视频；图片已更新'
                : node.saveInputState === 'stale' ? '无有效输入，保留原有媒体，未更新' : '';
    return { images: input.images.length ? input.images : getCanonicalImageList(node), videos: copy(videosOf(node)),
        video: copy(videosOf(node).at(-1) || null), input };
}

/** Project an existing result; retained pixels never constitute a new media input or owner write. */
export function applyImageDisplayResultProjection(node, source) {
    if (!source || source.id !== node.id || source.type !== node.type || !['ImagePreview', 'ImageSave'].includes(node.type)) return false;
    const images = getCanonicalImageList(source);
    const oldKeys = node.data?.mediaAssetKeys || [], keys = source.data?.mediaAssetKeys || [];
    const unchanged = keys.length && oldKeys.length ? same(oldKeys, keys) : same(getCanonicalImageList(node), images);
    const index = unchanged ? node.imagePreviewIndex ?? source.imagePreviewIndex ?? 0 : source.imagePreviewIndex || 0;
    const count = imageCount(source);
    setCanonicalImageOutput(node, images, { currentIndex: index });
    for (const field of ['mediaAssetKeys', 'imageAssetKey', 'imageCount', 'imageAssetReady', 'imageMemoryReleased',
        'imageHydratedAt', 'imagePreviewThumbnail', 'mediaIntegrity']) {
        if (source.data?.[field] !== undefined) node.data[field] = copy(source.data[field]);
        else delete node.data[field];
    }
    node.imagePreviewIndex = Math.max(0, Math.min(count - 1, index));
    if (!unchanged || node.previewZoom === undefined) node.previewZoom = source.previewZoom || 1;
    if (node.type === 'ImagePreview') {
        node.previewInputState = source.previewInputState || resolveImagePreviewInputState(source, images);
    } else {
        for (const field of ['videos', 'video']) {
            if (source.data?.[field] !== undefined) node.data[field] = copy(source.data[field]);
            else delete node.data[field];
        }
        node.saveInputState = source.saveInputState || (count || videosOf(source).length ? 'current' : 'empty');
        node.saveInputMessage = source.saveInputMessage || (node.saveInputState === 'stale' ? '无有效输入，保留原有媒体，未更新' : '');
    }
    return true;
}
