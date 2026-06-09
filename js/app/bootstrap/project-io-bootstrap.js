import { createProjectIoApi } from '../../features/persistence/project-io.js';

/**
 * Creates the project IO bootstrap wiring without leaking import/export/load-state setup
 * details into the main app bootstrap.
 */
export function createProjectIoFeature({
    registry,
    state,
    storageKey,
    nodeSerializer,
    getHandle,
    addLog,
    addNode,
    applyHistoryGridCols,
    updateAllConnections,
    updatePortStyles,
    onConnectionsChanged = () => {},
    viewportApi,
    showToast,
    applyTheme = () => {},
    applyGlobalAnimationSetting = () => {},
    applyCanvasUiSetting = () => {},
    applyWorkflowSidebarWidth = () => {},
    clearImageAssets = null,
    clearOrphanedNodeAssets = async () => true,
    clearOrphanedImageImportAssets = async () => true,
    trimHistoryCache = async () => true,
    cleanupRecoverableNodeAssetCache = null,
    clearUndoStack = () => {},
    updateCacheUsage = () => {},
    beginMediaRestoreBatch = () => {},
    endMediaRestoreBatch = () => {},
    finalizeMediaRestoreBatch = async () => {}
}) {
    function getProjectIoApi() {
        if (!registry.projectIoApi) {
            registry.projectIoApi = createProjectIoApi({
                state,
                storageKey,
                nodeSerializer,
                getHandle,
                addLog,
                addNode,
                applyHistoryGridCols,
                updateAllConnections,
                updatePortStyles,
                onConnectionsChanged,
                viewportApi,
                showToast,
                applyTheme,
                applyGlobalAnimationSetting,
                applyCanvasUiSetting,
                applyWorkflowSidebarWidth,
                clearImageAssets,
                clearOrphanedNodeAssets,
                clearOrphanedImageImportAssets,
                trimHistoryCache,
                cleanupRecoverableNodeAssetCache,
                clearUndoStack,
                updateCacheUsage,
                beginMediaRestoreBatch,
                endMediaRestoreBatch,
                finalizeMediaRestoreBatch
            });
        }
        return registry.projectIoApi;
    }

    function exportWorkflow(...args) {
        return getProjectIoApi().exportWorkflow(...args);
    }

    function importWorkflow(...args) {
        return getProjectIoApi().importWorkflow(...args);
    }

    function loadState(...args) {
        return getProjectIoApi().loadState(...args);
    }

    return {
        getProjectIoApi,
        exportWorkflow,
        importWorkflow,
        loadState
    };
}
