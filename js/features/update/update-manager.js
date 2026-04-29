/**
 * 管理版本更新检查、刷新提示与更新前备份导出等流程。
 */
export function createUpdateManager({
    appVersion,
    githubRepo,
    getProxyHeaders,
    showToast,
    renderGeneralSettings,
    exportWorkflow,
    documentRef = document,
    windowRef = window,
    localStorageRef = localStorage,
    fetchImpl = fetch,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
}) {
    let autoCheckCountdownTimer = null;
    let autoCheckCountdownToast = null;

    function compareVersions(v1, v2) {
        const parse = (value) => {
            const match = String(value || '').trim().match(/\d+(?:\.\d+)*/);
            if (!match) return [0];
            return match[0].split('.').map((part) => {
                const num = Number.parseInt(part, 10);
                return Number.isFinite(num) ? num : 0;
            });
        };
        const a = parse(v1);
        const b = parse(v2);
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const numA = a[i] || 0;
            const numB = b[i] || 0;
            if (numA > numB) return 1;
            if (numA < numB) return -1;
        }
        return 0;
    }

    function showUpdateModal(releaseData) {
        const modal = documentRef.getElementById('modal-update');
        const tag = documentRef.getElementById('update-tag');
        const date = documentRef.getElementById('update-date');
        const changelog = documentRef.getElementById('update-changelog-content');
        const settingsBtn = documentRef.getElementById('btn-settings');

        if (tag) tag.textContent = releaseData.tag_name;
        if (date) date.textContent = new Date(releaseData.published_at).toLocaleDateString();

        if (changelog) {
            let body = releaseData.body || '暂无更新日志详情';
            body = body.replace(/### (.*)/g, '<h4>$1</h4>')
                .replace(/\n- (.*)/g, '\n<li>$1</li>')
                .replace(/<li>(.*)<\/li>/g, '<ul><li>$1</li></ul>')
                .replace(/<\/ul>\n<ul>/g, '')
                .replace(/\n/g, '<br>');
            changelog.innerHTML = body;
        }

        if (settingsBtn) settingsBtn.classList.add('has-update');
        modal?.classList.remove('hidden');
        modal?.classList.add('active');

        const btnDownload = documentRef.getElementById('btn-update-download');
        const btnBackup = documentRef.getElementById('btn-update-backup');

        if (btnDownload) {
            btnDownload.onclick = () => {
                windowRef.open(releaseData.html_url, '_blank');
            };
        }

        if (btnBackup) {
            btnBackup.onclick = () => {
                exportWorkflow();
                showToast('备份已导出，您可以放心更新', 'success');
            };
        }
    }

    function showUpdateCanvasNotice(releaseData) {
        const notice = documentRef.getElementById('update-canvas-notice');
        const latestVersion = documentRef.getElementById('update-canvas-version');
        const currentVersion = documentRef.getElementById('update-canvas-current-version');
        const detailsBtn = documentRef.getElementById('btn-update-canvas-details');
        const downloadBtn = documentRef.getElementById('btn-update-canvas-download');
        const settingsBtn = documentRef.getElementById('btn-settings');

        if (settingsBtn) settingsBtn.classList.add('has-update');
        if (!notice) return;

        if (latestVersion) latestVersion.textContent = releaseData.tag_name || '';
        if (currentVersion) currentVersion.textContent = appVersion;
        if (detailsBtn) detailsBtn.onclick = () => showUpdateModal(releaseData);
        if (downloadBtn) {
            downloadBtn.onclick = () => {
                windowRef.open(releaseData.html_url || `https://github.com/${githubRepo}/releases/latest`, '_blank');
            };
        }

        notice.classList.remove('hidden');
    }

    function hideUpdateCanvasNotice() {
        documentRef.getElementById('update-canvas-notice')?.classList.add('hidden');
        documentRef.getElementById('btn-settings')?.classList.remove('has-update');
    }

    function setUpdateError(message) {
        localStorageRef.setItem('cainflow_update_status', 'error');
        localStorageRef.setItem('cainflow_update_error', message || '检查更新失败');
    }

    function clearUpdateError() {
        localStorageRef.removeItem('cainflow_update_error');
    }

    function getUpdateFailureMessage(error, response = null) {
        if (error?.name === 'AbortError') {
            return '检查更新超时，请稍后重试';
        }
        if (response) {
            return `检查更新失败：GitHub API 返回 ${response.status} ${response.statusText || '响应异常'}`;
        }
        if (error?.message) {
            return `检查更新失败：${error.message}`;
        }
        return '检查更新失败，请检查网络连接或代理设置';
    }

    function getToastContainer() {
        return documentRef.getElementById('toast-container');
    }

    function renderAutoCheckCountdownToast(secondsRemaining) {
        const container = getToastContainer();
        if (!container) return;

        if (!autoCheckCountdownToast || !documentRef.body?.contains(autoCheckCountdownToast)) {
            const toast = documentRef.createElement('div');
            toast.className = 'toast info';

            const icon = documentRef.createElement('span');
            icon.textContent = '[i]';

            const message = documentRef.createElement('span');
            message.className = 'update-auto-check-countdown-message';

            toast.appendChild(icon);
            toast.appendChild(message);
            container.appendChild(toast);
            autoCheckCountdownToast = toast;
        }

        const message = autoCheckCountdownToast.querySelector('.update-auto-check-countdown-message');
        if (message) {
            message.textContent = `将在 ${secondsRemaining} 秒后自动检查更新`;
        }
    }

    function dismissAutoCheckCountdownToast(delay = 0) {
        if (!autoCheckCountdownToast) return;

        const toast = autoCheckCountdownToast;
        autoCheckCountdownToast = null;

        setTimeoutImpl(() => {
            toast.style.animation = 'toast-out 0.3s ease-out forwards';
            setTimeoutImpl(() => toast.remove(), 300);
        }, delay);
    }

    function scheduleAutoUpdateCheck(options = {}) {
        const {
            delayMs = 5000,
            force = true,
            showModal = false,
            showCanvasNotification = true
        } = options;

        if (autoCheckCountdownTimer !== null) {
            clearTimeoutImpl(autoCheckCountdownTimer);
            autoCheckCountdownTimer = null;
        }
        dismissAutoCheckCountdownToast();

        const targetTime = Date.now() + delayMs;

        const tick = () => {
            const remainingMs = targetTime - Date.now();
            const secondsRemaining = Math.ceil(remainingMs / 1000);

            if (secondsRemaining > 0) {
                renderAutoCheckCountdownToast(secondsRemaining);
                autoCheckCountdownTimer = setTimeoutImpl(tick, Math.min(1000, Math.max(remainingMs, 0)));
                return;
            }

            autoCheckCountdownTimer = null;
            if (autoCheckCountdownToast) {
                const message = autoCheckCountdownToast.querySelector('.update-auto-check-countdown-message');
                if (message) message.textContent = '正在自动检查更新...';
            }
            dismissAutoCheckCountdownToast(1200);
            checkUpdate(false, {
                force,
                showModal,
                showCanvasNotification,
                showProgressToast: false
            });
        };

        tick();
    }

    async function checkUpdate(isManual = false, options = {}) {
        const {
            force = false,
            showModal = isManual,
            showCanvasNotification = true,
            showProgressToast = true
        } = options;

        const checkInterval = 6 * 60 * 60 * 1000;
        const now = Date.now();
        const lastCheck = localStorageRef.getItem('cainflow_last_update_check');

        if (!force && !isManual && lastCheck && (now - parseInt(lastCheck, 10)) < checkInterval) {
            return;
        }

        if (showProgressToast) {
            showToast(isManual ? '正在检查更新...' : '系统正在自动检查更新...', 'info', isManual ? 3000 : 4500);
        }
        localStorageRef.setItem('cainflow_update_status', 'checking');
        clearUpdateError();
        renderGeneralSettings();

        localStorageRef.setItem('cainflow_last_update_check', now.toString());

        let timeoutId = null;
        try {
            const controller = new AbortController();
            timeoutId = setTimeoutImpl(() => controller.abort(), 10000);

            const url = `https://api.github.com/repos/${githubRepo}/releases/latest`;
            const response = await fetchImpl('/proxy', {
                method: 'POST',
                headers: getProxyHeaders(url, 'GET'),
                signal: controller.signal
            });
            clearTimeoutImpl(timeoutId);
            timeoutId = null;

            if (!response.ok) {
                const msg = getUpdateFailureMessage(null, response);
                setUpdateError(msg);
                showToast(msg, 'error', 6000);
                renderGeneralSettings();
                return;
            }

            const data = await response.json();
            const latestVersion = data.tag_name;
            localStorageRef.setItem('cainflow_update_version', latestVersion || '');
            const comparison = compareVersions(latestVersion, appVersion);

            if (comparison > 0) {
                localStorageRef.setItem('cainflow_update_status', 'new_version');
                clearUpdateError();
                if (showCanvasNotification) showUpdateCanvasNotice(data);
                if (showModal) showUpdateModal(data);
                showToast(`发现新版本 ${latestVersion || ''}`, 'success', 6000);
            } else {
                localStorageRef.setItem('cainflow_update_status', 'latest');
                clearUpdateError();
                hideUpdateCanvasNotice();
                showToast(`当前已是最新版本 (${appVersion})`, 'success', isManual ? 3000 : 4500);
            }

            renderGeneralSettings();
        } catch (e) {
            if (timeoutId !== null) clearTimeoutImpl(timeoutId);
            console.warn('Update check failed:', e);
            const msg = getUpdateFailureMessage(e);
            setUpdateError(msg);
            showToast(msg, 'error', 6000);
            renderGeneralSettings();
        }
    }

    function checkRefreshNotice() {
        if (localStorageRef.getItem('cainflow_refresh_notice_dismissed') === 'true') {
            const notice = documentRef.getElementById('refresh-notice');
            if (notice) notice.classList.add('hidden');
        }
    }

    function initRefreshNotice() {
        const closeBtn = documentRef.querySelector('.notice-close');
        closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            documentRef.getElementById('refresh-notice')?.classList.add('hidden');
            localStorageRef.setItem('cainflow_refresh_notice_dismissed', 'true');
        });
    }

    return {
        checkUpdate,
        scheduleAutoUpdateCheck,
        checkRefreshNotice,
        initRefreshNotice
    };
}
