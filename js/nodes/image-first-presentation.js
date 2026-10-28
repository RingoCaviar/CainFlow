const imageFirstCardTypes = new Set(['ImageGenerate', 'ImageImport', 'ImagePreview', 'ImageResize', 'ColorReset', 'ImageCompare', 'ImageMerge', 'ImageSave']);

/** Types whose image card owns geometry independently of its parameter editor. */
export function isImageFirstCardNode(node) {
    return imageFirstCardTypes.has(typeof node === 'string' ? node : node?.type);
}
