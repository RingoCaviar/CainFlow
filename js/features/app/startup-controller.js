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
    ensureOpenWorkflow = async () => true,
    updateCanvasTransform,
    scheduleAutoUpdateCheck,
    checkRefreshNotice,
    systemNotificationApi = null,
    documentRef = document,
    consoleRef = console
}) {
    const startupNetworkDetectionDelayMs = 2000;
    let startupNetworkDetectionTimer = null;
    let startupNetworkDetectionToast = null;

    function getToastContainer() {
        return documentRef.getElementById('toast-container');
    }

    function renderStartupNetworkDetectionCountdownToast(secondsRemaining) {
        const container = getToastContainer();
        if (!container) return;

        if (!startupNetworkDetectionToast || !documentRef.body?.contains(startupNetworkDetectionToast)) {
            const toast = documentRef.createElement('div');
            toast.className = 'toast info';

            const icon = documentRef.createElement('span');
            icon.textContent = '[i]';

            const message = documentRef.createElement('span');
            message.className = 'update-auto-check-countdown-message';

            toast.appendChild(icon);
            toast.appendChild(message);
            container.appendChild(toast);
            startupNetworkDetectionToast = toast;
        }

        const message = startupNetworkDetectionToast.querySelector('.update-auto-check-countdown-message');
        if (message) {
            message.textContent = `将在 ${secondsRemaining} 秒后检测网络环境是否正常`;
        }
    }

    function dismissStartupNetworkDetectionToast(delay = 0) {
        if (!startupNetworkDetectionToast) return;

        const toast = startupNetworkDetectionToast;
        startupNetworkDetectionToast = null;

        window.setTimeout(() => {
            toast.style.animation = 'toast-out 0.3s ease-out forwards';
            window.setTimeout(() => toast.remove(), 300);
        }, delay);
    }

    function scheduleStartupNetworkDetection() {
        if (startupNetworkDetectionTimer !== null) {
            window.clearTimeout(startupNetworkDetectionTimer);
            startupNetworkDetectionTimer = null;
        }
        dismissStartupNetworkDetectionToast();

        const targetTime = Date.now() + startupNetworkDetectionDelayMs;

        const tick = () => {
            const remainingMs = targetTime - Date.now();
            const secondsRemaining = Math.ceil(remainingMs / 1000);

            if (secondsRemaining > 0) {
                renderStartupNetworkDetectionCountdownToast(secondsRemaining);
                startupNetworkDetectionTimer = window.setTimeout(tick, Math.min(1000, Math.max(remainingMs, 0)));
                return;
            }

            startupNetworkDetectionTimer = null;
            if (startupNetworkDetectionToast) {
                const message = startupNetworkDetectionToast.querySelector('.update-auto-check-countdown-message');
                if (message) message.textContent = '正在检测网络环境是否正常...';
            }
            Promise.resolve(checkNetworkProxyMismatch(true))
                .finally(() => dismissStartupNetworkDetectionToast(1200));
        };

        tick();
    }

    async function bootstrapApp() {
        consoleRef.log('CainFlow Initializing...');
        try {
            initUI();
            const restored = await loadState();
            await ensureOpenWorkflow();
            initLogs();
            await syncProxyToServer();
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
