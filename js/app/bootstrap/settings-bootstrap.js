import { createSettingsModalApi } from '../../features/settings/settings-modal.js';
import { createSettingsControllerApi } from '../../features/settings/settings-controller.js';
import { createProtocolDeveloperPanel } from '../../features/settings/protocol-developer-panel.js';
import { loadProtocols } from '../../features/execution/protocols/index.js';

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
    refreshImageGenerateNodes = null,
    documentRef = document
}) {
    const settingsModal = documentRef.getElementById('settings-modal');
    const providersList = documentRef.getElementById('providers-list');
    const modelsList = documentRef.getElementById('models-list');
    let protocolsLoaded = false;
    let protocolsLoadPromise = null;

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

    function refreshProtocolConsumers() {
        settingsControllerApi.renderModels();
        settingsControllerApi.updateAllNodeModelDropdowns();
    }

    function ensureProtocolsLoaded() {
        if (protocolsLoaded) return Promise.resolve(true);
        if (!protocolsLoadPromise) {
            protocolsLoadPromise = loadProtocols()
                .then(() => {
                    protocolsLoaded = true;
                    return true;
                })
                .catch((error) => {
                    console.error('加载协议失败:', error);
                    showToast?.('协议加载失败，兼容格式名称可能不是最新', 'warning');
                    return false;
                })
                .finally(() => {
                    protocolsLoadPromise = null;
                });
        }
        return protocolsLoadPromise;
    }

    function refreshProtocolConsumersAfterLoad() {
        ensureProtocolsLoaded().then((loaded) => {
            if (loaded) refreshProtocolConsumers();
        });
    }

    const settingsModalApi = createSettingsModalApi({
        settingsModal,
        onOpen: () => {
            settingsControllerApi.collapseAllConfigCards();
            settingsControllerApi.renderProviders();
            settingsControllerApi.renderModels();
            settingsControllerApi.renderGeneralSettings();
            settingsControllerApi.initProxyPanel();
            refreshProtocolConsumersAfterLoad();
        }
    });

    const protocolDeveloperPanelApi = createProtocolDeveloperPanel({
        documentRef,
        showToast,
        refreshImageGenerateNodes,
        onProtocolRegistryChange: () => {
            protocolsLoaded = true;
            refreshProtocolConsumers();
        }
    });

    function initSettingsFeature() {
        settingsControllerApi.initSettingsUI({ settingsModalApi, protocolDeveloperPanelApi });
        refreshProtocolConsumersAfterLoad();
    }

    return {
        settingsControllerApi,
        initSettingsFeature,
        syncProxyToServer: (...args) => settingsControllerApi.syncProxyToServer(...args),
        checkNetworkConnectivity: (...args) => settingsControllerApi.checkNetworkConnectivity(...args),
        checkNetworkProxyMismatch: (...args) => settingsControllerApi.checkNetworkProxyMismatch(...args)
    };
}
