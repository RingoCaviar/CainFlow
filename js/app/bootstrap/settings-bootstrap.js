import { createSettingsModalApi } from '../../features/settings/settings-modal.js';
import { createSettingsControllerApi } from '../../features/settings/settings-controller.js';

/**
 * Creates the settings feature bootstrap wiring without leaking setup details into the main app bootstrap.
 */
export function createSettingsFeature({
    appVersion,
    githubRepo,
    state,
    storeHistoryName,
    storeAssetsName,
    openDB,
    saveHandle,
    deleteHandle,
    showToast,
    saveState,
    addLog,
    checkUpdate,
    downloadLatestUpdate,
    cancelUpdateDownload,
    updateAllConnections,
    applyGlobalAnimationSetting,
    applyCanvasUiSetting,
    fitNodeToContent,
    floatingNoticesApi,
    documentRef = document
}) {
    const settingsModal = documentRef.getElementById('settings-modal');
    const providersList = documentRef.getElementById('providers-list');
    const modelsList = documentRef.getElementById('models-list');

    const settingsControllerApi = createSettingsControllerApi({
        appVersion,
        githubRepo,
        state,
        settingsModal,
        providersList,
        modelsList,
        storeHistoryName,
        storeAssetsName,
        openDB,
        saveHandle,
        deleteHandle,
        showToast,
        saveState,
        addLog,
        checkUpdate,
        downloadLatestUpdate,
        cancelUpdateDownload,
        updateAllConnections,
        applyGlobalAnimationSetting,
        applyCanvasUiSetting,
        fitNodeToContent,
        floatingNoticesApi,
        documentRef
    });

    const settingsModalApi = createSettingsModalApi({
        settingsModal,
        onOpen: () => {
            settingsControllerApi.collapseAllConfigCards();
            settingsControllerApi.renderProviders();
            settingsControllerApi.renderModels();
            settingsControllerApi.renderGeneralSettings();
            settingsControllerApi.initProxyPanel();
        }
    });

    function initSettingsFeature() {
        settingsControllerApi.initSettingsUI({ settingsModalApi });
    }

    return {
        settingsControllerApi,
        initSettingsFeature,
        syncProxyToServer: (...args) => settingsControllerApi.syncProxyToServer(...args),
        checkNetworkConnectivity: (...args) => settingsControllerApi.checkNetworkConnectivity(...args),
        checkNetworkProxyMismatch: (...args) => settingsControllerApi.checkNetworkProxyMismatch(...args)
    };
}
