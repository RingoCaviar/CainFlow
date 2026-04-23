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
    function compareVersions(v1, v2) {
        const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
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

    async function checkUpdate(isManual = false) {
        if (isManual) {
            showToast('正在检查更新...', 'info');
            localStorageRef.setItem('cainflow_update_status', 'checking');
            renderGeneralSettings();
        }

        const checkInterval = 6 * 60 * 60 * 1000;
        const now = Date.now();
        const lastCheck = localStorageRef.getItem('cainflow_last_update_check');

        if (!isManual && lastCheck && (now - parseInt(lastCheck, 10)) < checkInterval) {
            return;
        }

        localStorageRef.setItem('cainflow_last_update_check', now.toString());

        try {
            const controller = new AbortController();
            const timeoutId = setTimeoutImpl(() => controller.abort(), 10000);

            const url = `https://api.github.com/repos/${githubRepo}/releases/latest`;
            const response = await fetchImpl('/proxy', {
                method: 'POST',
                headers: getProxyHeaders(url, 'GET'),
                signal: controller.signal
            });
            clearTimeoutImpl(timeoutId);

            if (!response.ok) {
                localStorageRef.setItem('cainflow_update_status', 'error');
                if (isManual) {
                    showToast('无法连接到更新服务器 (GitHub API 响应异常)', 'error');
                    renderGeneralSettings();
                }
                return;
            }

            const data = await response.json();
            const latestVersion = data.tag_name;
            const comparison = compareVersions(latestVersion, appVersion);

            if (comparison > 0) {
                localStorageRef.setItem('cainflow_update_status', 'new_version');
                localStorageRef.setItem('cainflow_update_version', latestVersion);
                showUpdateModal(data);
            } else {
                localStorageRef.setItem('cainflow_update_status', 'latest');
                if (isManual) showToast(`当前已是最新版本 (${appVersion})`, 'success');
            }

            if (isManual) renderGeneralSettings();
        } catch (e) {
            console.warn('Update check failed:', e);
            localStorageRef.setItem('cainflow_update_status', 'error');
            if (isManual) {
                const msg = e.name === 'AbortError'
                    ? '检查更新超时，请稍后重试'
                    : '检查更新失败，请检查网络连接或代理设置';
                showToast(msg, 'error');
                renderGeneralSettings();
            }
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
        checkRefreshNotice,
        initRefreshNotice
    };
}
