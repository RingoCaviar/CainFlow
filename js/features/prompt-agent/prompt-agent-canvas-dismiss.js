export function bindPromptAgentCanvasDismiss({ documentRef, close }) {
    let press = null;
    let ready = false;
    const blank = target => ['canvas-container', 'nodes-layer', 'connections-layer', 'connections-svg', 'connections-group', 'origin-axes'].includes(target?.id);
    const move = event => {
        if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) press.dragged = true;
    };
    documentRef.addEventListener?.('pointerdown', event => {
        ready = false;
        press = event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && blank(event.target)
            ? { x: event.clientX, y: event.clientY, id: event.pointerId, dragged: false } : null;
    }, true);
    documentRef.addEventListener?.('pointermove', move, true);
    documentRef.addEventListener?.('pointerup', event => {
        if (event.button !== 0 || press?.id !== event.pointerId) return;
        move(event);
        ready = !press.dragged && blank(event.target);
        press = null;
    }, true);
    documentRef.addEventListener?.('click', event => {
        const dismiss = ready;
        ready = false;
        if (dismiss && event.button === 0 && !event.defaultPrevented && blank(event.target)) close();
    });
    const reset = () => { press = null; ready = false; };
    documentRef.addEventListener?.('pointercancel', reset, true);
    documentRef.defaultView?.addEventListener('blur', reset);
}
