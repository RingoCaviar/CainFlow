/**
 * Centralizes settings dependencies, DOM references, constants, and mutable UI state.
 */
export function createSettingsContext({
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
    deleteHandle = async () => false,
    showToast,
    saveState,
    addLog,
    checkUpdate,
    downloadLatestUpdate = () => {},
    cancelUpdateDownload = () => {},
    updateAllConnections = () => {},
    applyGlobalAnimationSetting = () => {},
    applyCanvasUiSetting = () => {},
    fitNodeToContent = () => {},
    floatingNoticesApi = null,
    documentRef = document,
    windowRef = window,
    localStorageRef = localStorage,
    fetchImpl = fetch
}) {
    localStorageRef.removeItem('cainflow_network_proxy_mismatch_dismissed');

    const ctx = {
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
        documentRef,
        windowRef,
        localStorageRef,
        fetchImpl
    };

    const constants = {
        MODEL_FETCH_TIMEOUT_SECONDS: 30,
        MODEL_FETCH_CLIENT_TIMEOUT_SECONDS: 35,
        networkProxyNoticeId: 'network-proxy-mismatch',
        networkProxyDetectionCooldownMs: 10 * 60 * 1000,
        networkProxyDetectionStorageKey: 'cainflow_network_proxy_detection',
        networkProxyDetectionCacheVersion: 5,
        NETWORK_PROBE_TARGETS: [
            { name: 'Google gstatic 204', url: 'https://www.gstatic.com/generate_204', method: 'HEAD' },
            { name: 'Google 204', url: 'https://www.google.com/generate_204', method: 'HEAD' },
            { name: 'YouTube', url: 'https://www.youtube.com/', method: 'GET' }
        ],
        NETWORK_CONNECTIVITY_TARGETS: [
            { name: '华为网络连通性检测', url: 'http://connectivitycheck.platform.hicloud.com/generate_204', method: 'HEAD' },
            { name: '百度', url: 'https://www.baidu.com/', method: 'GET' },
            { name: '阿里云', url: 'https://www.aliyun.com/', method: 'GET' }
        ],
        HISTORY_ASSET_KEY_PREFIX: 'history:',
        IMAGE_IMPORT_ASSET_KEY_PREFIX: 'image-import:'
    };

    constants.networkProxyDetectionTargetsSignature = JSON.stringify(
        constants.NETWORK_PROBE_TARGETS.map((target) => ({
            name: String(target?.name || ''),
            url: String(target?.url || '')
        }))
    );

    const store = {
        constants,
        providerCollapseState: new Map(),
        modelCollapseState: new Map(),
        modelFetchDialogState: {
            providerId: '',
            models: [],
            query: '',
            loading: false,
            error: '',
            status: ''
        },
        networkProxyStatusState: {
            checking: false,
            result: null
        },
        activeModelFetchRequestId: 0,
        openModelProviderPanelId: '',
        floatingModelProviderPanel: null,
        floatingModelProviderPanelCleanup: [],
        generalSettingsHelpDismissBound: false,
        generalSettingsHelpOverlay: null,
        activeGeneralSettingsHelpTrigger: null
    };

    return { ctx, store };
}
