/** Identity of one output position and the exact original displayed there. */
export function createCanvasImageSourceId(nodeId, port, index, identity, legacyAssetIndex) {
    return JSON.stringify(['canvas', nodeId, port, index, identity, legacyAssetIndex ?? null]);
}
