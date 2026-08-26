import { cleanupElementResources } from '../../core/common-utils.js';
import { createPreparedWorkflowEditorView } from './workflow-editor-view.js';

export function createDetachedWorkflowViewBuilder({
    liveState,
    visibleNodesLayer,
    createRuntimeContext,
    bindVisibleNodeInteractions = () => {},
    visibleConnectionProjectionMaintenance = null
}) {
    async function prepare(workflowReference, workflowData) {
        if (!visibleNodesLayer) throw new Error('Visible workflow editor root is unavailable');
        const context = createRuntimeContext(workflowReference, workflowData);
        try {
            await context.waitForImageRestores();
        } catch (error) {
            context.dispose();
            throw error;
        }
        context.refreshConnectionProjection();
        const targetProjectionHandoff = context.captureConnectionProjectionHandoff();
        const preparedView = createPreparedWorkflowEditorView({
            liveState,
            liveRoot: visibleNodesLayer,
            targetState: context.state,
            targetRoot: context.elements.nodesLayer,
            capturePrevious: () => visibleConnectionProjectionMaintenance?.captureViewHandoff?.(),
            adoptTarget: (targetState) => {
                targetState.nodes.forEach((node) => bindVisibleNodeInteractions({ id: node.id, type: node.type, el: node.el }));
                visibleConnectionProjectionMaintenance?.adoptViewHandoff?.(targetProjectionHandoff);
            },
            restorePrevious: (handoff) => visibleConnectionProjectionMaintenance?.adoptViewHandoff?.(handoff),
            disposeTarget: (options) => context.dispose(options),
            disposePrevious: (previousState) => {
                previousState.nodes?.forEach((node) => {
                    try { cleanupElementResources(node.el); } catch (error) {
                        console.warn('Previous workflow node cleanup failed:', error);
                    }
                });
            },
            onFinalizeError: (error) => console.warn('Workflow editor finalization failed:', error)
        });
        return {
            commit: () => preparedView.commit(),
            rollback: () => preparedView.rollback(),
            finalize: () => preparedView.finalize(),
            dispose: () => preparedView.dispose()
        };
    }

    return { prepare };
}
