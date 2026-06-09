/**
 * 存放入口装配阶段的延迟初始化单例，避免继续把一长串 `let ...Api`
 * 留在真正的入口文件里。
 */
export function createAppRegistry() {
    return {
        connectionRefreshSchedulerApi: null,
        logPanelApi: null,
        requestStatisticsApi: null,
        historyPanelApi: null,
        historyFullscreenApi: null,
        sessionManagerApi: null,
        projectIoApi: null,
        executionCoreApi: null,
        workflowRunnerApi: null,
        uiControllerApi: null,
        clipboardControllerApi: null,
        globalInteractionsApi: null,
        toolbarControllerApi: null,
        canvasInteractionsApi: null,
        batchConnectionModeApi: null,
        nodeAutoLayoutApi: null,
        nodeLifecycleApi: null,
        contextMenuControllerApi: null,
        runtimeControllerApi: null,
        startupControllerApi: null,
        errorModalControllerApi: null,
        toastControllerApi: null,
        floatingNoticesApi: null,
        systemNotificationApi: null,
        themeControllerApi: null,
        promptLibraryApi: null,
        workflowRuntimeManagerApi: null
    };
}
