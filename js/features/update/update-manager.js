import { formatProxyErrorMessage } from '../../services/api-client.js';

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
    floatingNoticesApi = null,
    documentRef = document,
    windowRef = window,
    localStorageRef = localStorage,
    fetchImpl = fetch,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
}) {
    let autoCheckCountdownTimer = null;
    let autoCheckCountdownToast = null;
    let latestReleaseData = null;
    let updateDownloadInProgress = false;
    let updateDownloadPollTimer = null;
    let activeUpdateJobId = '';
    let handledTerminalUpdateJobId = '';
    const updateDownloadTextKey = 'cainflow_update_download_text';
    const updateDownloadSnapshotKey = 'cainflow_update_download_snapshot';
    const activeDownloadStatuses = new Set(['starting', 'resolving', 'downloading', 'extracting', 'replacing', 'canceling']);

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
        if (releaseData) latestReleaseData = releaseData;
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
        const btnCancel = documentRef.getElementById('btn-update-cancel');

        if (btnDownload) {
            btnDownload.onclick = () => {
                downloadLatestUpdate(releaseData);
            };
        }
        if (btnCancel) {
            btnCancel.onclick = () => {
                cancelUpdateDownload();
            };
        }
        syncUpdateDownloadControls();

        if (btnBackup) {
            btnBackup.onclick = () => {
                exportWorkflow();
                showToast('当前工作流备份已导出，请仍手动备份 workflows 文件夹', 'success', 5000);
            };
        }
    }

    function showUpdateCanvasNotice(releaseData) {
        if (releaseData) latestReleaseData = releaseData;
        const settingsBtn = documentRef.getElementById('btn-settings');

        if (settingsBtn) settingsBtn.classList.add('has-update');
        floatingNoticesApi?.upsertNotice({
            id: 'update-canvas',
            elementId: 'update-canvas-notice',
            priority: 30,
            className: 'update-canvas-notice',
            role: 'alert',
            icon: '↑',
            title: ['发现新版本 ', { tag: 'span', text: releaseData.tag_name || '' }],
            meta: ['当前版本 ', { tag: 'span', text: appVersion }],
            actions: [
                {
                    id: 'btn-update-canvas-details',
                    label: '更新通知',
                    onClick: () => showUpdateModal(releaseData)
                },
                {
                    id: 'btn-update-canvas-download',
                    label: '下载更新',
                    onClick: () => {
                        downloadLatestUpdate(releaseData);
                    }
                }
            ]
        });
    }

    function hideUpdateCanvasNotice() {
        floatingNoticesApi?.hideNotice('update-canvas');
        documentRef.getElementById('btn-settings')?.classList.remove('has-update');
    }

    function setUpdateError(message) {
        localStorageRef.setItem('cainflow_update_status', 'error');
        localStorageRef.setItem('cainflow_update_error', message || '检查更新失败');
    }

    function clearUpdateError() {
        localStorageRef.removeItem('cainflow_update_error');
    }

    function formatBytes(bytes) {
        const value = Number(bytes) || 0;
        if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
        if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
        if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
        return `${value} B`;
    }

    function formatSpeed(bytesPerSecond) {
        return `${formatBytes(bytesPerSecond)}/s`;
    }

    function clampPercent(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return null;
        return Math.max(0, Math.min(100, number));
    }

    function getDownloadProgressPercent(snapshot) {
        const explicitPercent = clampPercent(snapshot?.percent);
        if (explicitPercent !== null) return explicitPercent;

        const downloaded = Number(snapshot?.downloadedBytes) || 0;
        const total = Number(snapshot?.totalBytes) || 0;
        if (downloaded >= 0 && total > 0) {
            return Math.max(0, Math.min(100, (downloaded / total) * 100));
        }
        return null;
    }

    function getStoredDownloadSnapshotPayload(snapshot) {
        if (!snapshot) return null;
        return {
            status: snapshot.status || '',
            message: snapshot.message || '',
            downloadedBytes: Number(snapshot.downloadedBytes) || 0,
            totalBytes: Number(snapshot.totalBytes) || 0,
            speedBytesPerSecond: Number(snapshot.speedBytesPerSecond) || 0,
            percent: getDownloadProgressPercent(snapshot)
        };
    }

    function getDownloadSnapshotText(snapshot) {
        if (!snapshot) return '';
        const message = snapshot.message || '';
        if (snapshot.status === 'downloading') {
            const downloaded = formatBytes(snapshot.downloadedBytes || 0);
            const total = snapshot.totalBytes ? formatBytes(snapshot.totalBytes) : '未知大小';
            const speed = formatSpeed(snapshot.speedBytesPerSecond || 0);
            const percent = Number.isFinite(snapshot.percent) ? `${snapshot.percent}%` : '';
            return `正在下载更新：${percent ? `${percent}，` : ''}${downloaded} / ${total}，${speed}`;
        }
        if (snapshot.status === 'canceling') return message || '正在取消下载并清理临时文件...';
        return message || '';
    }

    function setStoredDownloadText(message = '') {
        if (message) localStorageRef.setItem(updateDownloadTextKey, message);
        else localStorageRef.removeItem(updateDownloadTextKey);
    }

    function setStoredDownloadSnapshot(snapshot = null) {
        const payload = getStoredDownloadSnapshotPayload(snapshot);
        if (payload) localStorageRef.setItem(updateDownloadSnapshotKey, JSON.stringify(payload));
        else localStorageRef.removeItem(updateDownloadSnapshotKey);
    }

    function createUpdateDownloadProgressElement(snapshot, message) {
        const wrapper = documentRef.createElement('div');
        wrapper.className = 'update-download-progress';

        const topRow = documentRef.createElement('div');
        topRow.className = 'update-download-progress__row';

        const title = documentRef.createElement('span');
        title.className = 'update-download-progress__title';
        title.textContent = snapshot?.status === 'downloading' ? '正在下载更新' : (message || '正在准备更新');
        topRow.appendChild(title);

        const percent = getDownloadProgressPercent(snapshot);
        const percentText = documentRef.createElement('span');
        percentText.className = 'update-download-progress__percent';
        percentText.textContent = percent === null ? '计算中' : `${percent.toFixed(percent >= 10 || percent === 0 ? 0 : 1)}%`;
        topRow.appendChild(percentText);
        wrapper.appendChild(topRow);

        const track = documentRef.createElement('div');
        track.className = 'update-download-progress__track';
        const bar = documentRef.createElement('div');
        bar.className = 'update-download-progress__bar';
        if (percent === null) {
            track.classList.add('is-indeterminate');
        } else {
            bar.style.width = `${percent}%`;
        }
        track.appendChild(bar);
        wrapper.appendChild(track);

        const detailRow = documentRef.createElement('div');
        detailRow.className = 'update-download-progress__detail';

        const downloaded = formatBytes(snapshot?.downloadedBytes || 0);
        const total = snapshot?.totalBytes ? formatBytes(snapshot.totalBytes) : '未知大小';
        const sizeText = documentRef.createElement('span');
        sizeText.textContent = snapshot?.status === 'downloading' ? `${downloaded} / ${total}` : (message || '');
        detailRow.appendChild(sizeText);

        const speedText = documentRef.createElement('span');
        const speed = Number(snapshot?.speedBytesPerSecond) || 0;
        speedText.textContent = snapshot?.status === 'downloading'
            ? `速度：${speed > 0 ? formatSpeed(speed) : '等待数据'}`
            : '';
        detailRow.appendChild(speedText);
        wrapper.appendChild(detailRow);

        return wrapper;
    }

    function shouldRenderDownloadProgress(snapshot) {
        return snapshot && activeDownloadStatuses.has(snapshot.status || '');
    }

    function setUpdateDownloadStatus(message = '', type = 'info', snapshot = null) {
        const status = documentRef.getElementById('update-download-status');
        if (!status) return;

        if (!message) {
            status.textContent = '';
            status.className = 'update-download-status hidden';
            return;
        }

        status.textContent = '';
        status.className = `update-download-status ${type}`;
        if (shouldRenderDownloadProgress(snapshot)) {
            status.appendChild(createUpdateDownloadProgressElement(snapshot, message));
        } else {
            status.textContent = message;
        }
    }

    function syncUpdateDownloadControls() {
        const buttons = Array.from(documentRef.querySelectorAll('#btn-update-download, [data-action="download-update"]'));
        buttons.forEach((button) => {
            button.disabled = updateDownloadInProgress;
            button.textContent = updateDownloadInProgress ? '正在下载更新...' : '下载并更新';
        });

        const cancelButtons = Array.from(documentRef.querySelectorAll('#btn-update-cancel, [data-action="cancel-update"]'));
        cancelButtons.forEach((button) => {
            button.classList.toggle('hidden', !updateDownloadInProgress);
            button.disabled = localStorageRef.getItem('cainflow_update_status') === 'canceling';
            button.textContent = button.disabled ? '正在取消...' : '取消下载';
        });
    }

    async function readUpdateDownloadError(response) {
        const text = await response.text();
        try {
            const data = JSON.parse(text);
            if (data?.detail) return `${data.error || '下载更新失败'}：${data.detail}`;
            if (data?.error) return data.error;
        } catch {
            // Ignore non-JSON error bodies.
        }
        return text || `下载更新失败：HTTP ${response.status}`;
    }

    function confirmUpdateDownload(releaseData = null) {
        const tagName = releaseData?.tag_name || localStorageRef.getItem('cainflow_update_version') || '最新版';
        const message = `即将从 GitHub 下载 ${tagName} 的 Release ZIP，并只覆盖 CainFlow 主程序。\n\n由于网络环境问题，下载速度可能不稳定；下载和替换期间请不要关闭 CainFlow。\n\n是否继续？`;
        if (typeof windowRef.confirm === 'function') {
            return windowRef.confirm(message);
        }
        return true;
    }

    async function downloadLatestUpdate(releaseData = null) {
        if (releaseData) latestReleaseData = releaseData;
        const activeRelease = releaseData || latestReleaseData;

        if (updateDownloadInProgress) {
            showToast('更新正在下载中，请稍候...', 'info', 4000);
            return;
        }

        if (!confirmUpdateDownload(activeRelease)) return;

        updateDownloadInProgress = true;
        activeUpdateJobId = '';
        handledTerminalUpdateJobId = '';
        localStorageRef.setItem('cainflow_update_status', 'downloading');
        clearUpdateError();
        const initialSnapshot = {
            status: 'starting',
            message: '正在连接 GitHub，下载速度会在开始传输后显示...',
            downloadedBytes: 0,
            totalBytes: 0,
            speedBytesPerSecond: 0,
            percent: null
        };
        setStoredDownloadText(initialSnapshot.message);
        setStoredDownloadSnapshot(initialSnapshot);
        setUpdateDownloadStatus(initialSnapshot.message, 'info', initialSnapshot);
        syncUpdateDownloadControls();
        renderGeneralSettings();
        showToast('正在从 GitHub 下载更新，网络环境不同速度可能不稳定...', 'info', 8000);

        try {
            const response = await fetchImpl('/api/update/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    repo: githubRepo,
                    tagName: activeRelease?.tag_name || ''
                })
            });

            if (!response.ok) {
                throw new Error(await readUpdateDownloadError(response));
            }

            const snapshot = await response.json();
            if (snapshot?.id) activeUpdateJobId = snapshot.id;
            applyUpdateDownloadSnapshot(snapshot);
            scheduleUpdateDownloadPoll();
        } catch (error) {
            const message = error?.message || '下载更新失败，请稍后重试';
            updateDownloadInProgress = false;
            setUpdateError(message);
            setStoredDownloadText('');
            setStoredDownloadSnapshot(null);
            setUpdateDownloadStatus(message, 'error');
            showToast(message, 'error', 9000);
            renderGeneralSettings();
            syncUpdateDownloadControls();
        }
    }

    async function cancelUpdateDownload() {
        if (!updateDownloadInProgress) {
            showToast('当前没有正在下载的更新', 'info', 3000);
            return;
        }

        localStorageRef.setItem('cainflow_update_status', 'canceling');
        const cancelSnapshot = {
            status: 'canceling',
            message: '正在取消下载并清理临时文件...',
            downloadedBytes: 0,
            totalBytes: 0,
            speedBytesPerSecond: 0,
            percent: null
        };
        setStoredDownloadText(cancelSnapshot.message);
        setStoredDownloadSnapshot(cancelSnapshot);
        setUpdateDownloadStatus(cancelSnapshot.message, 'info', cancelSnapshot);
        renderGeneralSettings();
        syncUpdateDownloadControls();

        try {
            const response = await fetchImpl('/api/update/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: activeUpdateJobId })
            });
            const snapshot = await response.json();
            if (!response.ok) throw new Error(snapshot?.error || '取消更新下载失败');
            applyUpdateDownloadSnapshot(snapshot);
            scheduleUpdateDownloadPoll(400);
        } catch (error) {
            const message = error?.message || '取消更新下载失败';
            showToast(message, 'error', 6000);
            setUpdateDownloadStatus(message, 'error');
        }
    }

    function sendCancelUpdateDownloadOnPageLeave() {
        if (!updateDownloadInProgress) return false;

        const payload = JSON.stringify({
            jobId: activeUpdateJobId,
            reason: 'page_leave'
        });

        try {
            const navigatorRef = windowRef.navigator;
            if (navigatorRef?.sendBeacon) {
                const body = typeof windowRef.Blob === 'function'
                    ? new windowRef.Blob([payload], { type: 'application/json' })
                    : payload;
                if (navigatorRef.sendBeacon('/api/update/cancel', body)) {
                    return true;
                }
            }
        } catch {
            // Fall through to keepalive fetch.
        }

        try {
            fetchImpl('/api/update/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
                keepalive: true
            }).catch(() => {});
            return true;
        } catch {
            return false;
        }
    }

    function handleUpdateBeforeUnload(event) {
        if (!updateDownloadInProgress) return undefined;
        event.preventDefault();
        event.returnValue = '';
        return '';
    }

    function handleUpdatePageHide() {
        if (!updateDownloadInProgress) return;
        localStorageRef.setItem('cainflow_update_status', 'canceling');
        setStoredDownloadText('页面已关闭，正在取消下载并清理临时文件...');
        setStoredDownloadSnapshot({
            status: 'canceling',
            message: '页面已关闭，正在取消下载并清理临时文件...',
            downloadedBytes: 0,
            totalBytes: 0,
            speedBytesPerSecond: 0,
            percent: null
        });
        sendCancelUpdateDownloadOnPageLeave();
        clearUpdateDownloadPollTimer();
    }

    function initUpdateDownloadWindowGuards() {
        if (!windowRef?.addEventListener) return;
        windowRef.addEventListener('beforeunload', handleUpdateBeforeUnload);
        windowRef.addEventListener('pagehide', handleUpdatePageHide);
    }

    async function syncExistingUpdateDownloadJob() {
        const storedStatus = localStorageRef.getItem('cainflow_update_status') || '';
        if (storedStatus !== 'downloading' && storedStatus !== 'canceling') return;

        try {
            const response = await fetchImpl('/api/update/status');
            const snapshot = await response.json();
            if (!response.ok) throw new Error(snapshot?.error || '读取更新下载状态失败');

            if (snapshot?.id) activeUpdateJobId = snapshot.id;
            applyUpdateDownloadSnapshot(snapshot);
            if (activeDownloadStatuses.has(snapshot?.status)) {
                scheduleUpdateDownloadPoll();
            }
        } catch {
            updateDownloadInProgress = false;
            activeUpdateJobId = '';
            setStoredDownloadText('');
            setStoredDownloadSnapshot(null);
            const latestVersion = localStorageRef.getItem('cainflow_update_version');
            localStorageRef.setItem('cainflow_update_status', latestVersion ? 'new_version' : 'unknown');
            renderGeneralSettings();
            syncUpdateDownloadControls();
        }
    }

    function clearUpdateDownloadPollTimer() {
        if (updateDownloadPollTimer !== null) {
            clearTimeoutImpl(updateDownloadPollTimer);
            updateDownloadPollTimer = null;
        }
    }

    function scheduleUpdateDownloadPoll(delayMs = 800) {
        clearUpdateDownloadPollTimer();
        if (!updateDownloadInProgress || !activeUpdateJobId) return;
        updateDownloadPollTimer = setTimeoutImpl(pollUpdateDownloadStatus, delayMs);
    }

    async function pollUpdateDownloadStatus() {
        if (!activeUpdateJobId) return;
        try {
            const response = await fetchImpl(`/api/update/status?jobId=${encodeURIComponent(activeUpdateJobId)}`);
            const snapshot = await response.json();
            if (!response.ok) throw new Error(snapshot?.error || '读取更新下载状态失败');
            applyUpdateDownloadSnapshot(snapshot);
            scheduleUpdateDownloadPoll();
        } catch (error) {
            const message = error?.message || '读取更新下载状态失败';
            updateDownloadInProgress = false;
            setUpdateError(message);
            setStoredDownloadText('');
            setStoredDownloadSnapshot(null);
            setUpdateDownloadStatus(message, 'error');
            showToast(message, 'error', 7000);
            renderGeneralSettings();
            syncUpdateDownloadControls();
        }
    }

    function applyUpdateDownloadSnapshot(snapshot = {}) {
        const status = snapshot.status || 'idle';
        const jobId = snapshot.id || activeUpdateJobId || '';
        if (jobId) activeUpdateJobId = jobId;

        if (activeDownloadStatuses.has(status)) {
            updateDownloadInProgress = true;
            localStorageRef.setItem('cainflow_update_status', status === 'canceling' ? 'canceling' : 'downloading');
            const text = getDownloadSnapshotText(snapshot) || '正在下载更新...';
            setStoredDownloadText(text);
            setStoredDownloadSnapshot(snapshot);
            setUpdateDownloadStatus(text, 'info', snapshot);
            renderGeneralSettings();
            syncUpdateDownloadControls();
            return;
        }

        updateDownloadInProgress = false;
        clearUpdateDownloadPollTimer();
        syncUpdateDownloadControls();

        if (status === 'completed') {
            const result = snapshot.result || {};
            const successMessage = snapshot.message || result.message || '更新已完成，请重启 CainFlow 主程序。';
            if (result.tagName) localStorageRef.setItem('cainflow_update_version', result.tagName);
            localStorageRef.setItem('cainflow_update_status', 'downloaded');
            clearUpdateError();
            setStoredDownloadText('');
            setStoredDownloadSnapshot(null);
            setUpdateDownloadStatus(successMessage, 'success');
            renderGeneralSettings();
            if (handledTerminalUpdateJobId !== jobId) {
                handledTerminalUpdateJobId = jobId;
                showToast(successMessage, 'success', 12000);
                if (typeof windowRef.alert === 'function') {
                    windowRef.alert(`${successMessage}\n\n请重启 CainFlow 主程序。`);
                }
            }
            return;
        }

        if (status === 'canceled') {
            const message = snapshot.message || '下载已取消，未完成的临时文件已删除。';
            const latestVersion = localStorageRef.getItem('cainflow_update_version');
            localStorageRef.setItem('cainflow_update_status', latestVersion ? 'new_version' : 'unknown');
            setStoredDownloadText('');
            setStoredDownloadSnapshot(null);
            setUpdateDownloadStatus(message, 'info');
            renderGeneralSettings();
            if (handledTerminalUpdateJobId !== jobId) {
                handledTerminalUpdateJobId = jobId;
                showToast(message, 'info', 6000);
            }
            return;
        }

        if (status === 'error') {
            const message = snapshot.message || snapshot.error || '下载更新失败，请稍后重试';
            setUpdateError(message);
            setStoredDownloadText('');
            setStoredDownloadSnapshot(null);
            setUpdateDownloadStatus(message, 'error');
            renderGeneralSettings();
            if (handledTerminalUpdateJobId !== jobId) {
                handledTerminalUpdateJobId = jobId;
                showToast(message, 'error', 9000);
            }
            return;
        }

        setStoredDownloadText('');
        setStoredDownloadSnapshot(null);
        if (localStorageRef.getItem('cainflow_update_status') === 'downloading' || localStorageRef.getItem('cainflow_update_status') === 'canceling') {
            const latestVersion = localStorageRef.getItem('cainflow_update_version');
            localStorageRef.setItem('cainflow_update_status', latestVersion ? 'new_version' : 'unknown');
        }
        renderGeneralSettings();
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
                const responseText = await response.text();
                const friendlyMessage = formatProxyErrorMessage(response.status, responseText, '检查更新失败', { url });
                const msg = friendlyMessage || getUpdateFailureMessage(null, response);
                setUpdateError(msg);
                showToast(msg, 'error', 6000);
                renderGeneralSettings();
                return;
            }

            const data = await response.json();
            latestReleaseData = data;
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
        localStorageRef.removeItem('cainflow_refresh_notice_dismissed');
    }

    function initRefreshNotice() {
        checkRefreshNotice();
    }

    initUpdateDownloadWindowGuards();
    setTimeoutImpl(syncExistingUpdateDownloadJob, 0);

    return {
        checkUpdate,
        downloadLatestUpdate,
        cancelUpdateDownload,
        scheduleAutoUpdateCheck,
        checkRefreshNotice,
        initRefreshNotice
    };
}
