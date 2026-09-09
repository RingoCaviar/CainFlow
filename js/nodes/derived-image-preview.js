const PREVIEW_FIELDS = Object.freeze({
    ImageResize: 'resizePreviewData',
    ColorReset: 'colorResetPreviewData'
});

function getPreviewField(node) {
    return PREVIEW_FIELDS[node?.type] || '';
}

export function isDerivedImagePreviewNode(node) {
    return Boolean(getPreviewField(node));
}

export function getDerivedImagePreview(node) {
    const field = getPreviewField(node);
    return field ? node?.[field] || null : null;
}

export function setDerivedImagePreview(node, image) {
    const field = getPreviewField(node);
    if (!field || !node) return false;
    node[field] = image || null;
    return true;
}

export function clearDerivedImagePreview(node) {
    return setDerivedImagePreview(node, null);
}
