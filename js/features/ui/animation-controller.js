/**
 * Applies the global animation setting to the document and keeps the legacy
 * connection animation flag aligned for older saved configs.
 */
export function applyGlobalAnimationSetting({
    state,
    documentRef = document
}) {
    const enabled = state.globalAnimationEnabled !== false;
    state.connectionFlowAnimationEnabled = enabled;
    documentRef.documentElement.classList.toggle('animations-disabled', !enabled);
    return enabled;
}
