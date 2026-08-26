const DEFAULT_HOLD_MS = 2000;
const DEFAULT_DRAG_THRESHOLD = 8;
const REDUCED_MOTION_STEPS = 4;

export function bindMouseNodeRunCancelHold({
    button,
    nodeId,
    isNodeRunning,
    cancelRunningNode,
    showToast,
    documentRef = document,
    holdMs = DEFAULT_HOLD_MS,
    dragThreshold = DEFAULT_DRAG_THRESHOLD,
    now = () => documentRef.defaultView?.performance?.now?.() ?? Date.now(),
    setTimeoutRef = (callback, delay) => setTimeout(callback, delay),
    clearTimeoutRef = (timer) => clearTimeout(timer),
    requestAnimationFrameRef = (callback) => (documentRef.defaultView?.requestAnimationFrame || requestAnimationFrame)(callback),
    cancelAnimationFrameRef = (frame) => (documentRef.defaultView?.cancelAnimationFrame || cancelAnimationFrame)(frame)
}) {
    const view = documentRef.defaultView;
    const reducedMotion = view?.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
    let holdTimer = null;
    let progressFrame = null;
    let activePointerId = null;
    let startedAt = 0;
    let startX = 0;
    let startY = 0;
    let didTriggerCancel = false;

    const setProgress = (rawProgress) => {
        const bounded = Math.max(0, Math.min(1, rawProgress));
        const progress = reducedMotion?.matches && bounded < 1
            ? Math.floor(bounded * REDUCED_MOTION_STEPS) / REDUCED_MOTION_STEPS
            : bounded;
        button.style.setProperty('--node-cancel-progress', String(progress));
    };

    const clearProgressFrame = () => {
        if (progressFrame === null) return;
        cancelAnimationFrameRef(progressFrame);
        progressFrame = null;
    };

    const renderProgress = () => {
        if (activePointerId === null || didTriggerCancel) return;
        setProgress((now() - startedAt) / holdMs);
        progressFrame = requestAnimationFrameRef(renderProgress);
    };

    const clearHoldTimer = () => {
        if (holdTimer === null) return;
        clearTimeoutRef(holdTimer);
        holdTimer = null;
    };

    const releasePointer = () => {
        const pointerId = activePointerId;
        activePointerId = null;
        if (pointerId !== null && button.hasPointerCapture?.(pointerId)) {
            button.releasePointerCapture(pointerId);
        }
    };

    const removeSessionGuards = () => {
        view?.removeEventListener?.('blur', abortHold);
        documentRef.removeEventListener?.('visibilitychange', handleVisibilityChange);
    };

    const resetHold = ({ keepCanceling = false } = {}) => {
        clearHoldTimer();
        clearProgressFrame();
        button.classList.remove('is-holding');
        if (!keepCanceling) button.classList.remove('is-canceling');
        releasePointer();
        removeSessionGuards();
        if (!keepCanceling) setProgress(0);
    };

    function abortHold() {
        if (activePointerId !== null) resetHold();
    }

    function handleVisibilityChange() {
        if (documentRef.visibilityState === 'hidden') abortHold();
    }

    const handlePointerDown = (event) => {
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        if (activePointerId !== null || !isNodeRunning(nodeId)) return;

        event.preventDefault();
        event.stopPropagation();

        activePointerId = event.pointerId;
        startedAt = now();
        startX = event.clientX;
        startY = event.clientY;
        didTriggerCancel = false;

        button.classList.remove('is-canceling', 'is-holding');
        setProgress(0);
        button.classList.add('is-holding');
        button.setPointerCapture?.(event.pointerId);
        view?.addEventListener?.('blur', abortHold);
        documentRef.addEventListener?.('visibilitychange', handleVisibilityChange);
        progressFrame = requestAnimationFrameRef(renderProgress);

        holdTimer = setTimeoutRef(() => {
            holdTimer = null;
            if (!isNodeRunning(nodeId)) {
                resetHold();
                return;
            }
            didTriggerCancel = true;
            setProgress(1);
            clearProgressFrame();
            button.classList.remove('is-holding');
            button.classList.add('is-canceling');

            const handled = typeof cancelRunningNode === 'function'
                ? cancelRunningNode(nodeId)
                : false;
            if (!handled) {
                button.classList.remove('is-canceling');
                showToast('这个节点当前没有可取消的运行任务', 'warning');
            }
        }, holdMs);
    };

    const handlePointerMove = (event) => {
        if (activePointerId === null || event.pointerId !== activePointerId || didTriggerCancel) return;
        if (Math.hypot(event.clientX - startX, event.clientY - startY) > dragThreshold) resetHold();
    };

    const endPointerHold = (event) => {
        if (activePointerId === null || event.pointerId !== activePointerId) return;
        event.preventDefault();
        event.stopPropagation();
        resetHold({ keepCanceling: didTriggerCancel });
    };

    const suppressAction = (event) => {
        event.preventDefault();
        event.stopPropagation();
    };

    button.addEventListener('pointerdown', handlePointerDown);
    button.addEventListener('pointermove', handlePointerMove);
    button.addEventListener('pointerup', endPointerHold);
    button.addEventListener('pointercancel', endPointerHold);
    button.addEventListener('contextmenu', suppressAction);
    button.addEventListener('mousedown', suppressAction);
    button.addEventListener('click', suppressAction);

    return () => {
        resetHold();
        button.removeEventListener('pointerdown', handlePointerDown);
        button.removeEventListener('pointermove', handlePointerMove);
        button.removeEventListener('pointerup', endPointerHold);
        button.removeEventListener('pointercancel', endPointerHold);
        button.removeEventListener('contextmenu', suppressAction);
        button.removeEventListener('mousedown', suppressAction);
        button.removeEventListener('click', suppressAction);
    };
}
