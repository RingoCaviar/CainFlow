// Keep original pixels in memory, never in HTML/URL drag payloads. Only this
// application's live drag token can be consumed, once, by either drop target.
export const AGENT_RESULT_DRAG_TYPE = 'application/x-cainflow-agent-result';
let activeDrag = null;

function setResultDragImage(transfer, image) {
    if (!transfer.setDragImage || !image?.complete || !image.naturalWidth || !image.naturalHeight) return;
    // Rasterize the already-decoded image once, at drag start. The displayed
    // object-fit box can have a different ratio; never use it as the bitmap size.
    const scale = Math.min(1, 192 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = image.ownerDocument.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Keep the bitmap attached until Chromium has captured the native drag
    // image, without inserting layout or painting over the source panel.
    canvas.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:-1';
    image.ownerDocument.body.appendChild(canvas);
    try { transfer.setDragImage(canvas, canvas.width / 2, canvas.height / 2); }
    finally { setTimeout(() => canvas.remove(), 0); }
}

export function beginAgentResultDrag(transfer, { dataUrl, name, image, isCurrent = () => true }) {
    activeDrag = null;
    if (!transfer || !/^data:image\/[^;]+;base64,/i.test(dataUrl || '')) return null;
    const token = globalThis.crypto.randomUUID();
    activeDrag = { token, dataUrl, name, isCurrent };
    // Native image drags may otherwise retain a full data URL in text/html or
    // text/uri-list alongside our small, single-use in-memory token.
    transfer.clearData?.();
    transfer.effectAllowed = 'copy';
    transfer.setData(AGENT_RESULT_DRAG_TYPE, token);
    setResultDragImage(transfer, image);
    return token;
}

export function takeAgentResultDrag(transfer) {
    const token = transfer?.getData?.(AGENT_RESULT_DRAG_TYPE);
    if (!activeDrag || token !== activeDrag.token) return null;
    const drag = activeDrag;
    activeDrag = null;
    return drag.isCurrent() ? { name: drag.name, dataUrl: drag.dataUrl, type: drag.dataUrl.slice(5, drag.dataUrl.indexOf(';')) } : null;
}

export function endAgentResultDrag(token) {
    // The drop handler consumes synchronously; defer cleanup for browser event ordering.
    setTimeout(() => { if (activeDrag?.token === token) activeDrag = null; }, 0);
}
