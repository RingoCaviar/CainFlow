// Keep original pixels in memory, never in HTML/URL drag payloads. Only this
// application's live drag token can be consumed, once, by either drop target.
export const AGENT_RESULT_DRAG_TYPE = 'application/x-cainflow-agent-result';
let activeDrag = null;

export function beginAgentResultDrag(transfer, { dataUrl, name, isCurrent = () => true }) {
    activeDrag = null;
    if (!transfer || !/^data:image\/[^;]+;base64,/i.test(dataUrl || '')) return null;
    const token = globalThis.crypto.randomUUID();
    activeDrag = { token, dataUrl, name, isCurrent };
    transfer.effectAllowed = 'copy';
    transfer.setData(AGENT_RESULT_DRAG_TYPE, token);
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
