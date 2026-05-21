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
    const reloadNetworkDetectionDelayMs = 2000;
    let reloadNetworkDetectionTimer = null;
    let reloadNetworkDetectionToast = null;

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

    function getToastContainer() {
        return documentRef.getElementById('toast-container');
    }

    function renderReloadNetworkDetectionCountdownToast(secondsRemaining) {
        const container = getToastContainer();
        if (!container) return;

        if (!reloadNetworkDetectionToast || !documentRef.body?.contains(reloadNetworkDetectionToast)) {
            const toast = documentRef.createElement('div');
            toast.className = 'toast info';

            const icon = documentRef.createElement('span');
            icon.textContent = '[i]';

            const message = documentRef.createElement('span');
            message.className = 'update-auto-check-countdown-message';

            toast.appendChild(icon);
            toast.appendChild(message);
            container.appendChild(toast);
            reloadNetworkDetectionToast = toast;
        }

        const message = reloadNetworkDetectionToast.querySelector('.update-auto-check-countdown-message');
        if (message) {
            message.textContent = `将在 ${secondsRemaining} 秒后检测网络环境是否正常`;
        }
    }

    function dismissReloadNetworkDetectionToast(delay = 0) {
        if (!reloadNetworkDetectionToast) return;

        const toast = reloadNetworkDetectionToast;
        reloadNetworkDetectionToast = null;

        window.setTimeout(() => {
            toast.style.animation = 'toast-out 0.3s ease-out forwards';
            window.setTimeout(() => toast.remove(), 300);
        }, delay);
    }

    function scheduleReloadNetworkDetection() {
        if (reloadNetworkDetectionTimer !== null) {
            window.clearTimeout(reloadNetworkDetectionTimer);
            reloadNetworkDetectionTimer = null;
        }
        dismissReloadNetworkDetectionToast();

        const targetTime = Date.now() + reloadNetworkDetectionDelayMs;

        const tick = () => {
            const remainingMs = targetTime - Date.now();
            const secondsRemaining = Math.ceil(remainingMs / 1000);

            if (secondsRemaining > 0) {
                renderReloadNetworkDetectionCountdownToast(secondsRemaining);
                reloadNetworkDetectionTimer = window.setTimeout(tick, Math.min(1000, Math.max(remainingMs, 0)));
                return;
            }

            reloadNetworkDetectionTimer = null;
            if (reloadNetworkDetectionToast) {
                const message = reloadNetworkDetectionToast.querySelector('.update-auto-check-countdown-message');
                if (message) message.textContent = '正在检测网络环境是否正常...';
            }
            dismissReloadNetworkDetectionToast(1200);
            void checkNetworkProxyMismatch();
        };

        tick();
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
                scheduleReloadNetworkDetection();
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
