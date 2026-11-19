export function createPromptAgentPanelWidth({ panel, handle, windowRef, read = () => null, write = () => {} }) {
    const valid = value => Number.isFinite(Number(value)) && Number(value) >= 300 && Number(value) <= 960;
    const saved = read();
    let preferred = valid(saved) ? Math.round(Number(saved)) : null;
    let migrated = preferred !== null;
    let gesture = null;
    let navigationSpace = 0;
    const navigation = panel?.ownerDocument?.getElementById?.('canvas-navigation');
    const parameters = panel?.ownerDocument?.getElementById?.('image-parameter-panel');
    const bounds = () => {
        const available = panel?.parentElement?.clientWidth || windowRef?.innerWidth || 1200;
        // Smaller desktops reserve a usable editor beside Agent. Clamping the
        // presentation never replaces a saved preference from a wider window.
        const reserve = available > 800 && available <= 1200 ? 360 : 124;
        const max = Math.max(1, Math.min(960, available - reserve));
        return { min: Math.min(300, max), max };
    };
    const clamp = (value, limits = bounds()) => Math.max(limits.min, Math.min(limits.max, value));
    const updateNavigationSpace = () => {
        if (!navigation || !panel.classList.contains('active')) return;
        const rail = navigation.getBoundingClientRect();
        const editor = panel.getBoundingClientRect();
        const gap = 8;
        const overlaps = rail.width > 0 && rail.right + gap > editor.left && rail.left - gap < editor.right;
        const space = overlaps ? Math.ceil(panel.parentElement.getBoundingClientRect().bottom - rail.top + gap) : 0;
        if (space === navigationSpace) return;
        navigationSpace = space;
        panel.classList.toggle('needs-navigation-space', space > 0);
        if (space > 0) panel.style.setProperty('--prompt-agent-navigation-space', `${space}px`);
        else panel.style.removeProperty('--prompt-agent-navigation-space');
    };
    const apply = () => {
        if (!panel) return;
        const limits = bounds();
        const width = Math.round(clamp(preferred ?? Math.max(320, (windowRef?.innerWidth || 1200) * 0.34), limits));
        panel.style.width = `${width}px`;
        panel.parentElement?.style.setProperty('--prompt-agent-width', `${width}px`);
        panel.ownerDocument?.body?.style.setProperty('--prompt-agent-width', `${width}px`);
        updateNavigationSpace();
        handle?.setAttribute('aria-valuemin', String(limits.min));
        handle?.setAttribute('aria-valuemax', String(limits.max));
        handle?.setAttribute('aria-valuenow', String(width));
    };
    const commit = () => { if (preferred !== null) { migrated = true; write(preferred); } };
    const setWidth = width => {
        preferred = Math.max(300, Math.round(clamp(width)));
        apply();
        commit();
    };
    const adjust = direction => {
        const width = panel.getBoundingClientRect().width;
        const next = clamp(width + direction * 16);
        if (next !== width) setWidth(next);
    };
    const finish = () => {
        if (!gesture) return;
        const id = gesture.id;
        gesture = null;
        if (handle?.hasPointerCapture?.(id)) handle.releasePointerCapture(id);
        panel?.classList.remove('is-resizing');
        commit();
    };
    handle?.addEventListener('pointerdown', event => {
        if (event.button !== 0 || gesture) return;
        event.preventDefault(); event.stopPropagation();
        gesture = { id: event.pointerId, x: event.clientX, width: panel.getBoundingClientRect().width };
        handle.setPointerCapture?.(event.pointerId);
        panel.classList.add('is-resizing');
    });
    windowRef?.addEventListener('pointermove', event => {
        if (!gesture || gesture.id !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        preferred = Math.max(300, Math.round(clamp(gesture.width + gesture.x - event.clientX)));
        apply();
    });
    for (const name of ['pointerup', 'pointercancel']) windowRef?.addEventListener(name, event => {
        if (gesture?.id === event.pointerId) { event.stopPropagation(); finish(); }
    });
    handle?.addEventListener('lostpointercapture', finish);
    windowRef?.addEventListener('blur', finish);
    windowRef?.addEventListener('resize', apply);
    if (navigation && windowRef?.ResizeObserver) {
        // Selection can add rail controls or open a dock that shifts Agent horizontally.
        const observer = new windowRef.ResizeObserver(updateNavigationSpace);
        observer.observe(navigation, { box: 'border-box' });
        if (parameters) observer.observe(parameters, { box: 'border-box' });
    }
    handle?.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Home') setWidth(bounds().min);
        else if (event.key === 'End') setWidth(bounds().max);
        else adjust(event.key === 'ArrowLeft' ? 1 : -1);
    });
    apply();
    return {
        apply,
        adjust,
        migrate(value) {
            if (migrated) return;
            migrated = true;
            if (valid(value)) { preferred = Math.round(Number(value)); apply(); commit(); }
        }
    };
}
