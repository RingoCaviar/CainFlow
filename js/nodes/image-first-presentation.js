const imageFirstCardTypes = new Set(['ImageGenerate', 'ECommerceImageSet', 'ImageImport', 'ImagePreview', 'ImageResize', 'ColorReset', 'ImageCompare', 'ImageMerge', 'ImageSave', 'CameraControl']);
const restoredSizes = new WeakMap();

/** Types whose image card owns geometry independently of its parameter editor. */
export function isImageFirstCardNode(node) {
    return imageFirstCardTypes.has(typeof node === 'string' ? node : node?.type);
}

/** A restored manual size may precede the current presentation's minimums. */
export function rememberImageFirstRestoredSize(node, restoreData) {
    if (!isImageFirstCardNode(node) || restoreData?.userResized !== true) return null;
    const size = Object.fromEntries(['width', 'height'].flatMap(key => {
        const value = Number(restoreData[key]);
        return Number.isFinite(value) && value > 0 ? [[key, value]] : [];
    }));
    if (Object.keys(size).length) restoredSizes.set(node, size);
    return size;
}

export function getImageFirstRestoredSize(node) {
    return restoredSizes.get(node) || null;
}
