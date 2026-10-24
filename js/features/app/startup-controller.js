/**
 * 编排应用启动流程，包括 UI 初始化、状态恢复、默认工作流加载与更新检查。
 */
export function createStartupControllerApi({
    state,
    initUI,
    initLogs = () => {},
    loadState,
    showToast,
    syncProxyToServer,
    checkNetworkConnectivity = async () => {},
    checkNetworkProxyMismatch = async () => {},
    ensureOpenWorkflow = async () => true,
    applyWorkspaceMode = () => {},
    updateCanvasTransform,
    scheduleAutoUpdateCheck,
    checkRefreshNotice,
    systemNotificationApi = null,
    documentRef = document,
    consoleRef = console
}) {
    const startupNetworkDetectionDelayMs = 2000;
    let startupNetworkDetectionTimer = null;

    function scheduleStartupNetworkDetection() {
        if (startupNetworkDetectionTimer !== null) {
            window.clearTimeout(startupNetworkDetectionTimer);
            startupNetworkDetectionTimer = null;
        }
        startupNetworkDetectionTimer = window.setTimeout(() => {
            startupNetworkDetectionTimer = null;
            Promise.resolve(checkNetworkConnectivity({ showResultToast: true }))
                .catch((error) => {
                    consoleRef.error('Failed to check startup network connectivity:', error);
                })
                .finally(() => {
                    window.setTimeout(() => {
                        Promise.resolve(checkNetworkProxyMismatch(true)).catch((error) => {
                            consoleRef.error('Failed to detect startup network proxy mismatch:', error);
                        });
                    }, 1600);
                });
        }, startupNetworkDetectionDelayMs);
    }

    async function bootstrapApp() {
        consoleRef.log('CainFlow Initializing...');
        try {
            initUI();
            const restored = await loadState();
            await ensureOpenWorkflow();
            applyWorkspaceMode(state.workspaceMode);
            initLogs();
            Promise.resolve(syncProxyToServer()).catch((error) => {
                consoleRef.error('Failed to sync proxy state to server on startup:', error);
            });
            if (restored) {
                showToast('已从本地存储恢复工作状态', 'success');
            } else if (state.nodes.size === 0) {
                updateCanvasTransform();
            }
            consoleRef.log('CainFlow Initialized successfully.');

            systemNotificationApi?.ensureReady?.();
            scheduleAutoUpdateCheck();
            checkRefreshNotice();
            scheduleStartupNetworkDetection();
        } catch (error) {
            consoleRef.error('CainFlow Initialization Failed:', error);
            showToast('初始化失败，请查看控制台日志', 'error');
            throw error;
        }
    }

    function initStartup() {
        if (documentRef.readyState === 'loading') {
            return new Promise((resolve, reject) => {
                documentRef.addEventListener(
                    'DOMContentLoaded',
                    () => Promise.resolve(bootstrapApp()).then(resolve, reject),
                    { once: true }
                );
            });
        }
        return Promise.resolve().then(bootstrapApp);
    }

    return {
        bootstrapApp,
        initStartup
    };
}
