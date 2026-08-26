export function createCardToggleGestureGuard({ scheduleClear = (callback) => setTimeout(callback, 0) } = {}) {
    let suppressNextToggle = false;
    let gestureRevision = 0;

    return {
        beginTitleSelection() {
            suppressNextToggle = true;
            gestureRevision += 1;
        },
        endPointerGesture() {
            if (!suppressNextToggle) return;
            const endingRevision = gestureRevision;
            scheduleClear(() => {
                if (gestureRevision === endingRevision) suppressNextToggle = false;
            });
        },
        consumeToggleSuppression() {
            if (!suppressNextToggle) return false;
            suppressNextToggle = false;
            gestureRevision += 1;
            return true;
        }
    };
}

export function bindCardToggleGestureGuard({ card, documentRef, windowRef }) {
    const guard = createCardToggleGestureGuard({
        scheduleClear: (callback) => windowRef.setTimeout(callback, 0)
    });

    card.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !event.target.closest('.card-name:not([readonly])')) return;
        guard.beginTitleSelection();

        const finishPointerGesture = () => {
            documentRef.removeEventListener('pointerup', finishPointerGesture, true);
            documentRef.removeEventListener('pointercancel', finishPointerGesture, true);
            guard.endPointerGesture();
        };
        documentRef.addEventListener('pointerup', finishPointerGesture, { once: true, capture: true });
        documentRef.addEventListener('pointercancel', finishPointerGesture, { once: true, capture: true });
    });

    return guard;
}
