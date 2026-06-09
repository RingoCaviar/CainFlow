import { createUiControllerApi } from '../../features/ui/ui-controller.js';

/**
 * Creates the UI bootstrap wiring without leaking controller assembly details
 * into the main app bootstrap.
 */
export function createUiFeature({
    registry,
    state,
    panelManager,
    settingsModal,
    dbName,
    openDB,
    storeHistoryName,
    storeAssetsName,
    clearHistory,
    clearImageAssets = null,
    clearImageImportAssets = null,
    clearOrphanedHistoryAssets = null,
    clearOrphanedNodeAssets = null,
    collectRetainedNodeAssetIds = () => new Set(),
    refreshRecoverableMediaNodes = async () => {},
    getHistory,
    getHistoryMetadata = getHistory,
    getHistoryEntry,
    renderHistoryList,
    renderLogs,
    historyPreviewApi,
    getHistoryFullscreenApi,
    settingsControllerApi,
    getLogPanelApi,
    getRequestStatisticsApi,
    applyHistoryGridCols,
    applyTheme = () => {},
    applyGlobalAnimationSetting = () => {},
    applyCanvasUiSetting = () => {},
    updateAllConnections = () => {},
    saveState,
    showToast,
    copyToClipboard,
    downloadImage,
    initFeatureModules,
    syncOpenWorkflowsBeforeConfigExport = () => {},
    onConfigWorkflowsImported = async () => {},
    applyWorkflowSidebarWidth = () => {},
    getSystemNotificationApi,
    documentRef = document
}) {
    function getUiControllerApi() {
        if (!registry.uiControllerApi) {
            registry.uiControllerApi = createUiControllerApi({
                state,
                panelManager,
                settingsModal,
                dbName,
                openDB,
                storeHistoryName,
                storeAssetsName,
                clearHistory,
                clearImageAssets,
                clearImageImportAssets,
                clearOrphanedHistoryAssets,
                clearOrphanedNodeAssets,
                collectRetainedNodeAssetIds,
                refreshRecoverableMediaNodes,
                getHistory,
                getHistoryMetadata,
                getHistoryEntry,
                renderHistoryList,
                renderLogs,
                historyPreviewApi,
                historyFullscreenApi: getHistoryFullscreenApi(),
                settingsControllerApi,
                logPanelApi: getLogPanelApi(),
                requestStatisticsApi: getRequestStatisticsApi(),
                applyHistoryGridCols,
                applyTheme,
                applyGlobalAnimationSetting,
                applyCanvasUiSetting,
                updateAllConnections,
                saveState,
                showToast,
                copyToClipboard,
                downloadImage,
                initFeatureModules,
                syncOpenWorkflowsBeforeConfigExport,
                onConfigWorkflowsImported,
                applyWorkflowSidebarWidth,
                systemNotificationApi: getSystemNotificationApi(),
                documentRef
            });
        }
        return registry.uiControllerApi;
    }

    function initUI() {
        return getUiControllerApi().initUI();
    }

    function initCache() {
        return getUiControllerApi().initCache();
    }

    return {
        getUiControllerApi,
        initUI,
        initCache
    };
}
