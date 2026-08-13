/**
 * Applies a reversible visual safety mode only when an active canvas
 * interaction is demonstrably missing its frame budget.
 */
export function createInteractionPerformanceGuard({
    state,
    canvasContainer,
    connectionsGroup,
    windowRef = window,
    requestAnimationFrameRef = requestAnimationFrame
} = {}) {
    const LONG_FRAME_MS = 50;
    const LONG_FRAME_WINDOW_MS = 1000;
    const RECOVERY_MS = 500;
    let frame = null;
    let previousTime = 0;
    let longFrameTimes = [];
    let lastLongFrameTime = 0;

    function isCanvasInteractionActive() {
        return state?.isInteracting === true ||
            state?.canvas?.isPanning === true ||
            !!state?.dragging ||
            !!state?.connecting;
    }

    function setProtected(active) {
        if (!state) return;
        if (state.performanceProtection?.active === active) return;
        state.performanceProtection = { active };
        canvasContainer?.classList.toggle('canvas-performance-protected', active);
        connectionsGroup?.classList.toggle('is-performance-protected', active);
    }

    function tick(now) {
        if (previousTime) {
            const frameTime = now - previousTime;
            if (isCanvasInteractionActive() && frameTime > LONG_FRAME_MS) {
                lastLongFrameTime = now;
                longFrameTimes.push(now);
            }
            longFrameTimes = longFrameTimes.filter((time) => now - time <= LONG_FRAME_WINDOW_MS);
            if (longFrameTimes.length >= 2) setProtected(true);
            if (state?.performanceProtection?.active && now - lastLongFrameTime >= RECOVERY_MS) {
                longFrameTimes = [];
                setProtected(false);
            }
            if (!isCanvasInteractionActive() && state?.performanceProtection?.active) {
                longFrameTimes = [];
                setProtected(false);
            }
        }
        previousTime = now;
        frame = requestAnimationFrameRef(tick);
    }

    function init() {
        if (frame === null) frame = requestAnimationFrameRef(tick);
    }

    function destroy() {
        if (frame !== null) windowRef.cancelAnimationFrame?.(frame);
        frame = null;
        setProtected(false);
    }

    return { init, destroy };
}
