/** Create a durable image input from a saved image edited in the painter. */
export async function createEditedImageImport({ sourceNode, dataUrl, addNode, loadImageData, removeNode, selectNode }) {
    const sourceWidth = sourceNode.width || sourceNode.el?.getBoundingClientRect?.().width || 240;
    const importId = addNode('ImageImport', sourceNode.x + sourceWidth + 80, sourceNode.y);
    if (!importId) return false;

    try {
        if (await loadImageData(importId, dataUrl)) {
            selectNode(importId, false);
            return true;
        }
    } catch (error) {
        console.warn('Edited image import failed:', error);
    }

    await removeNode(importId, { onlyId: true, skipHistory: true, showToast: false });
    return false;
}
