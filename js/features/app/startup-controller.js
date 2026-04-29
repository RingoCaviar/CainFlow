/**
 * 编排应用启动流程，包括 UI 初始化、状态恢复、默认工作流加载与更新检查。
 */
export function createStartupControllerApi({
    state,
    initUI,
    loadState,
    showToast,
    syncProxyToServer,
    loadDefaultWorkflow,
    applyDefaultWorkflow,
    updateCanvasTransform,
    scheduleAutoUpdateCheck,
    checkRefreshNotice,
    documentRef = document,
    consoleRef = console
}) {
    async function bootstrapApp() {
        consoleRef.log('CainFlow Initializing...');
        try {
            initUI();
            const restored = await loadState();
            if (restored) {
                showToast('已从本地存储恢复工作状态', 'success');
                syncProxyToServer();
            } else if (state.nodes.size === 0) {
                const defaultData = await loadDefaultWorkflow();
                if (defaultData) {
                    applyDefaultWorkflow(defaultData);
                    showToast('已自动加载默认工作流', 'info');
                } else {
                    updateCanvasTransform();
                }
            }
            consoleRef.log('CainFlow Initialized successfully.');

            scheduleAutoUpdateCheck();
            checkRefreshNotice();
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
