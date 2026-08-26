/**
 * Distinguishes a backdrop click from a gesture that merely ends there.
 */
export function createBackdropDismissalGuard({ overlay, panel }) {
    let pointerDownStartedOnBackdrop = false;

    function recordPointerDown(event) {
        pointerDownStartedOnBackdrop = event.target === overlay && !panel?.contains(event.target);
    }

    function shouldDismiss(event) {
        const shouldClose = pointerDownStartedOnBackdrop && event.target === overlay;
        pointerDownStartedOnBackdrop = false;
        return shouldClose;
    }

    return {
        recordPointerDown,
        shouldDismiss
    };
}
