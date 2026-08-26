export function createWorkflowRuntimeDisposer(resources) {
    let disposed = false;

    function attempt(action) {
        try { action?.(); } catch (error) { resources.onError?.(error); }
    }

    return function disposeWorkflowRuntime({ keepNodes = false } = {}) {
        if (disposed) return false;
        disposed = true;

        attempt(() => resources.nodeLifecycle?.cancelPendingImageRestores?.());
        attempt(() => resources.connections?.destroy?.());
        if (!keepNodes) {
            resources.state?.nodes?.forEach((node) => attempt(() => resources.cleanupNode?.(node)));
            resources.state?.nodes?.clear?.();
        }
        if (resources.state) resources.state.connections = [];
        attempt(() => resources.elements?.wrapper?.remove?.());
        attempt(() => resources.layoutHost?.dispose?.());
        attempt(() => resources.registry?.delete?.(resources.contextId));
        return true;
    };
}
