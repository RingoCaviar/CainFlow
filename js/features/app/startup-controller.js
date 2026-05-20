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
    checkNetworkProxyMismatch = async () => {},
    loadDefaultWorkflow,
    applyDefaultWorkflow,
    updateCanvasTransform,
    scheduleAutoUpdateCheck,
    checkRefreshNotice,
    documentRef = document,
    performanceRef = typeof performance !== 'undefined' ? performance : null,
    consoleRef = console
}) {
    function isReloadNavigation() {
        const navigationEntry = performanceRef?.getEntriesByType?.('navigation')?.[0];
        if (navigationEntry?.type) {
            return navigationEntry.type === 'reload';
        }

        const legacyNavigation = performanceRef?.navigation;
        if (legacyNavigation && typeof legacyNavigation.type === 'number') {
            return legacyNavigation.type === 1;
        }

        return false;
    }

    async function bootstrapApp() {
        consoleRef.log('CainFlow Initializing...');
        try {
            initUI();
            const restored = await loadState();
            initLogs();
            await syncProxyToServer();
            if (restored) {
                showToast('已从本地存储恢复工作状态', 'success');
            } else if (state.nodes.size === 0) {
                const defaultData = await loadDefaultWorkflow();
                if (defaultData) {
                    if (applyDefaultWorkflow(defaultData) !== false) {
                        showToast('已自动加载默认工作流', 'info');
                    }
                } else {
                    updateCanvasTransform();
                }
            }
            consoleRef.log('CainFlow Initialized successfully.');

            scheduleAutoUpdateCheck();
            checkRefreshNotice();
            if (isReloadNavigation()) {
                await checkNetworkProxyMismatch();
            }
        } catch (error) {
            consoleRef.error('CainFlow Initialization Failed:', error);
            showToast('初始化失败，请查看控制台日志', 'error');
        }
    }

    function initStartup() {
        documentRef.addEventListener('DOMContentLoaded', bootstrapApp);
    }

    return {
        bootstrapApp,
        initStartup
    };
}
