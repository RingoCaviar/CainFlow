export function createPromptAgentPanelWidth({ panel, handle, windowRef, read = () => null, write = () => {} }) {
    const valid = value => Number.isFinite(Number(value)) && Number(value) >= 300 && Number(value) <= 960;
    const saved = read();
    let preferred = valid(saved) ? Math.round(Number(saved)) : null;
    let migrated = preferred !== null;
    let gesture = null;
    const bounds = () => {
        const available = panel?.parentElement?.clientWidth || windowRef?.innerWidth || 1200;
        const max = Math.max(1, Math.min(960, available - 24));
        return { min: Math.min(300, max), max };
    };
    const clamp = value => Math.max(bounds().min, Math.min(bounds().max, value));
    const apply = () => {
        if (!panel) return;
        const width = Math.round(clamp(preferred ?? Math.max(320, (windowRef?.innerWidth || 1200) * 0.34)));
        panel.style.width = `${width}px`;
        handle?.setAttribute('aria-valuemin', String(bounds().min));
        handle?.setAttribute('aria-valuemax', String(bounds().max));
        handle?.setAttribute('aria-valuenow', String(Math.round(width)));
    };
    const commit = () => { if (preferred !== null) { migrated = true; write(preferred); } };
    const finish = () => {
        if (!gesture) return;
        const id = gesture.id;
        gesture = null;
        if (handle?.hasPointerCapture?.(id)) handle.releasePointerCapture(id);
        panel?.classList.remove('is-resizing');
        commit();
    };
    handle?.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
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
    handle?.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const width = panel.getBoundingClientRect().width;
        preferred = Math.max(300, Math.round(clamp(event.key === 'Home' ? bounds().min : event.key === 'End' ? bounds().max : width + (event.key === 'ArrowLeft' ? 16 : -16))));
        apply(); commit();
    });
    apply();
    return {
        apply,
        migrate(value) {
            if (migrated) return;
            migrated = true;
            if (valid(value)) { preferred = Math.round(Number(value)); apply(); commit(); }
        }
    };
}
