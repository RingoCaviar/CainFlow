/** Keep text-card actions reachable in screen pixels without moving their DOM ownership. */
export function bindTextNodeTools({ el, tools, documentRef = document }) {
    const view = documentRef.defaultView;
    let frame = 0;
    let disposed = false;
    const isVisible = () => el.matches(':hover, :focus-within, .selected, .is-text-reader-open');
    const place = () => {
        frame = 0;
        if (disposed || !el.isConnected || !isVisible() || !el.offsetWidth) return;
        const rect = el.getBoundingClientRect();
        const scale = rect.width / el.offsetWidth;
        if (!Number.isFinite(scale) || scale <= 0) return;
        tools.style.transform = `scale(${1 / scale})`;
        const width = tools.offsetWidth;
        const height = tools.offsetHeight;
        const left = Math.max(8, Math.min(rect.left, view.innerWidth - width - 8));
        let bottom = view.innerHeight - 8;
        const navigation = documentRef.getElementById('canvas-navigation');
        if (navigation?.checkVisibility()) {
            const nav = navigation.getBoundingClientRect();
            if (left < nav.right && left + width > nav.left) bottom = Math.min(bottom, nav.top - 8);
        }
        const top = Math.max(8, Math.min(rect.bottom, bottom - height));
        tools.style.left = `${(left - rect.left) / scale}px`;
        tools.style.top = `${(top - rect.top) / scale}px`;
    };
    const schedule = () => { if (!disposed && !frame && isVisible()) frame = view.requestAnimationFrame(place); };
    const observers = [];
    if (view.ResizeObserver) {
        const observer = new view.ResizeObserver(schedule);
        observer.observe(el);
        observer.observe(tools);
        observers.push(observer);
    }
    if (view.MutationObserver) {
        const observer = new view.MutationObserver(schedule);
        observer.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
        observers.push(observer);
    }
    const events = [[documentRef, 'cainflow:canvas-transform'], [view, 'resize'], [el, 'mouseenter'], [el, 'focusin']];
    events.forEach(([target, event]) => target.addEventListener(event, schedule));
    schedule();
    return () => {
        disposed = true;
        if (frame) view.cancelAnimationFrame(frame);
        observers.forEach(observer => observer.disconnect());
        events.forEach(([target, event]) => target.removeEventListener(event, schedule));
    };
}
