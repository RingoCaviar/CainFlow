export const NODE_CAPABILITIES = Object.freeze({
    IMAGE_RESULT: 'imageResult',
    CANONICAL_IMAGES: 'canonicalImages',
    RECOVERABLE_IMAGE_ASSET: 'recoverableImageAsset',
    IMAGE_RESTORE: 'imageRestore',
    INLINE_IMAGE_DATA: 'inlineImageData',
    NODE_ID_IMAGE_ASSET: 'nodeIdImageAsset',
    PREVIEW_THUMBNAIL_RESTORE: 'previewThumbnailRestore'
});

export function definitionHasCapability(definition, capability) {
    return Array.isArray(definition?.capabilities) && definition.capabilities.includes(capability);
}
