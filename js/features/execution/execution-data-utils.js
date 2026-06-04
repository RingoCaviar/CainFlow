/**
 * 执行链路里的图片/文本输入输出归一化工具。
 */
export function normalizeImageList(value) {
    if (typeof value === 'string') {
        return value.trim() ? [value] : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap((item) => normalizeImageList(item));
    }
    if (value && typeof value === 'object') {
        return normalizeImageList(
            value.imageList ??
            value.images ??
            value.image ??
            value.dataUrl ??
            value.url ??
            []
        );
    }
    return [];
}

export function getFirstNonEmptyImageList(...values) {
    for (const value of values) {
        const images = normalizeImageList(value);
        if (images.length > 0) return images;
    }
    return [];
}

export function getCanonicalImageList(node, options = {}) {
    if (!node) return [];
    const includeResizePreview = options.includeResizePreview !== false;
    const candidates = [
        node.data?.imageList,
        node.data?.images,
        node.imageDataList,
        node.generatedImages,
        node.data?.image,
        node.imageData
    ];
    if (includeResizePreview) {
        candidates.push(node.resizePreviewData);
    }

    for (const candidate of candidates) {
        const images = normalizeImageList(candidate);
        if (images.length > 0) return images;
    }
    return [];
}

export function getCanonicalImageIndex(node, images = getCanonicalImageList(node), options = {}) {
    const imageList = Array.isArray(images) ? images : normalizeImageList(images);
    if (imageList.length === 0) return 0;
    const fallbackIndex = options.defaultToLast === true ? imageList.length - 1 : 0;
    const rawIndex = Number.isFinite(node?.imagePreviewIndex)
        ? node.imagePreviewIndex
        : (Number.isFinite(node?.data?.imageIndex) ? node.data.imageIndex : fallbackIndex);
    return Math.max(0, Math.min(imageList.length - 1, parseInt(rawIndex, 10) || 0));
}

export function getCanonicalImage(node, options = {}) {
    const images = getCanonicalImageList(node, options);
    if (images.length === 0) return '';
    return images[getCanonicalImageIndex(node, images, options)] || images[0] || '';
}

export function setCanonicalImageOutput(node, images = [], options = {}) {
    if (!node) return [];
    const imageList = normalizeImageList(images);
    node.data = node.data || {};

    delete node.data.images;
    delete node.data.image;

    node.imageData = null;
    node.imageDataList = [];
    node.generatedImages = [];

    if (imageList.length === 0) {
        delete node.data.imageList;
        if (options.clearPromptList !== false) delete node.data.imagePromptList;
        if (options.preserveAssetKey !== true) delete node.data.imageAssetKey;
        if (options.preserveImageCount !== true) delete node.data.imageCount;
        if (options.preservePreviewThumbnail !== true) delete node.data.imagePreviewThumbnail;
        delete node.data.imageMemoryReleased;
        delete node.data.imageAssetReady;
        delete node.data.imageHydratedAt;
        node.imagePreviewIndex = 0;
        return [];
    }

    const defaultIndex = options.defaultToFirst === true ? 0 : imageList.length - 1;
    const requestedIndex = Number.isFinite(options.currentIndex) ? options.currentIndex : defaultIndex;
    const currentIndex = Math.max(0, Math.min(imageList.length - 1, parseInt(requestedIndex, 10) || 0));

    node.data.imageList = imageList.slice();
    node.imagePreviewIndex = currentIndex;
    if (options.imagePromptList) {
        node.data.imagePromptList = Array.isArray(options.imagePromptList)
            ? options.imagePromptList.slice(0, imageList.length)
            : imageList.map(() => String(options.imagePromptList || ''));
    }

    if (options.assetKey !== undefined) {
        if (options.assetKey) node.data.imageAssetKey = options.assetKey;
        else delete node.data.imageAssetKey;
    } else if (options.preserveAssetKey !== true) {
        delete node.data.imageAssetKey;
    }

    if (options.imageCount !== undefined || options.trackImageCount === true) {
        node.data.imageCount = Math.max(
            imageList.length,
            Math.max(0, parseInt(options.imageCount ?? imageList.length, 10) || 0)
        );
    } else if (options.preserveImageCount !== true) {
        delete node.data.imageCount;
    }

    delete node.data.imageMemoryReleased;

    if (options.assetReady === true) {
        node.data.imageAssetReady = true;
    } else if (options.assetReady === false) {
        delete node.data.imageAssetReady;
    }

    if (options.hydratedAt !== undefined) {
        if (options.hydratedAt) node.data.imageHydratedAt = options.hydratedAt;
        else delete node.data.imageHydratedAt;
    }

    return imageList;
}

export function clearCanonicalImageOutput(node, options = {}) {
    if (!node) return;
    node.data = node.data || {};
    delete node.data.images;
    delete node.data.imageList;
    delete node.data.image;
    if (options.clearPromptList !== false) delete node.data.imagePromptList;
    if (options.preserveAssetKey !== true) delete node.data.imageAssetKey;
    if (options.preserveImageCount !== true) delete node.data.imageCount;
    if (options.preservePreviewThumbnail !== true) delete node.data.imagePreviewThumbnail;
    if (options.preserveMemoryReleased !== true) delete node.data.imageMemoryReleased;
    delete node.data.imageAssetReady;
    delete node.data.imageHydratedAt;
    node.imageData = null;
    node.imageDataList = [];
    node.generatedImages = [];
    if (options.preservePreviewIndex !== true) node.imagePreviewIndex = 0;
}

export function normalizeTextList(value) {
    if (typeof value === 'string') {
        return value ? [value] : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap((item) => normalizeTextList(item));
    }
    if (value && typeof value === 'object') {
        return normalizeTextList(
            value.texts ??
            value.text ??
            value.content ??
            value.message ??
            []
        );
    }
    return [];
}

export function getPrimaryImageInput(value) {
    return normalizeImageList(value)[0] || '';
}

export function getLastImageInput(value) {
    const images = normalizeImageList(value);
    return images.length > 0 ? images[images.length - 1] : '';
}

export function getPrimaryTextInput(value) {
    return normalizeTextList(value)[0] || '';
}

export function getTextInputList(value) {
    return normalizeTextList(value);
}
