/**
 * Handles general settings rendering, notification sound, image save warnings, and cache usage.
 */
import { AUTO_UPDATE_CHECK_DISABLED } from '../../core/constants.js';

export function createGeneralSettings({ ctx, dialogs }) {
    const {
        appVersion,
        githubRepo,
        state,
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
        documentRef,
        windowRef,
        localStorageRef
    } = ctx;

    function playNotificationSound(isTest = false) {
        if (!isTest && !state.notificationsEnabled) return;

        const soundPath = 'sounds/Sweet_Resolution_notice.mp3';
        const volume = state.notificationVolume !== undefined ? state.notificationVolume : 1.0;

        if (!state.notificationAudio) {
            state.notificationAudio = new Audio();
        }

        const audio = state.notificationAudio;
        try {
            audio.pause();
            audio.muted = false;
            audio.loop = false;
            audio.volume = volume;

            if (audio.src.includes(soundPath)) {
                audio.currentTime = 0;
            } else {
                audio.src = soundPath;
            }

            const promise = audio.play();
            if (promise !== undefined) {
                promise.catch((error) => {
                    console.warn('Audio play failed (interaction required):', error);
                });
            }
        } catch (error) {
            console.error('Audio object reuse failed:', error);
        }
    }

    function renderGeneralSettings() {
        const list = documentRef.getElementById('general-settings');
        const currentSide = Math.round(Math.sqrt(state.imageMaxPixels || 4194304));
        const autoResizeEnabled = state.imageAutoResizeEnabled !== false;
        const connectionLineType = state.connectionLineType || 'bezier';
        const toolbarPinned = state.toolbarPinned === true;
        const sidebarPinned = state.sidebarPinned === true;
        const globalAnimationEnabled = state.globalAnimationEnabled !== false;
        const autoCheckUpdatesOnLoad = state.autoCheckUpdatesOnLoad !== false;
        const concurrentRequestMode = state.concurrentRequestMode === true;
        const imageSaveUsePromptFilename = state.imageSaveUsePromptFilename === true;
        const updateStatus = localStorageRef.getItem('cainflow_update_status') || 'unknown';
        const lastCheck = localStorageRef.getItem('cainflow_last_update_check');
        const latestVer = localStorageRef.getItem('cainflow_update_version') || '';
        const updateError = localStorageRef.getItem('cainflow_update_error') || '检查失败，请检查网络连接或代理设置';
        const updateDownloadText = localStorageRef.getItem('cainflow_update_download_text') || '';
        let updateDownloadSnapshot = null;
        try {
            const rawDownloadSnapshot = localStorageRef.getItem('cainflow_update_download_snapshot');
            updateDownloadSnapshot = rawDownloadSnapshot ? JSON.parse(rawDownloadSnapshot) : null;
        } catch {
            updateDownloadSnapshot = null;
        }
        const serverVersionText = latestVer || (updateStatus === 'checking' ? '检查中...' : '尚未获取');
        const generalHelpText = {
            updateStatus: '显示本地版本、服务端版本和当前更新状态，也可以在这里执行检查、下载或取消下载。',
            autoCheckUpdatesOnLoad: '默认开启。关闭后，页面加载时不会再自动倒计时检查更新，但仍可手动检查。',
            autoResize: '开启后，超出阈值的大图会在导入时自动缩小；关闭后将保留原图。',
            maxSide: '阈值按边长换算为总像素上限，仅在自动缩放开启时生效。',
            globalSaveDir: [
                '设置全局目录可统一管理生成的图片。',
                '注意：受浏览器安全限制，无法读取完整路径，请自行记住所使用的文件夹位置。',
                '局域网其他设备访问时无法使用自动保存功能。'
            ].join('\n'),
            promptFilename: '开启后，保存节点会用生成该图片时的提示词加时间作为文件名。注意：如果提示词过长，可能导致部分环境下出现文件名相关问题。',
            maxRetries: '初始失败后，最多允许再尝试执行多少轮。',
            concurrentRequestMode: '默认开启。开启后，节点一旦需要执行多次，会并发发起这些请求；默认不会重试失败项，只把成功结果继续传递到下游。只有手动开启自动重试时，失败项才会按最大重试次数补试。',
            timeout: '默认关闭。关闭时会一直等待服务器返回；开启后超过设定秒数仍未返回则判定超时失败。',
            connectionLineType: '切换后会立即更新当前画布中的全部连线，直角连线会在拐点保留小圆角。',
            toolbarPinned: '默认关闭。开启后顶部菜单栏会一直显示，不再靠近顶部才弹出。',
            sidebarPinned: '默认关闭。开启后左侧工具栏会一直显示，不再靠近左侧才弹出。',
            globalAnimation: '默认开启。关闭后会禁用全局动画效果，包括连线流动箭头、弹窗渐入渐出、按钮过渡和提示动画，以释放最大性能。',
            notificationVolume: '调整工作流完成时通知音效的播放音量，可用“测试音效”立即预览当前设置。'
        };

        const formatBytes = (bytes) => {
            const value = Number(bytes) || 0;
            if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
            if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
            if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
            return `${value} B`;
        };

        const getDownloadPercent = (snapshot) => {
            const explicitPercent = Number(snapshot?.percent);
            if (Number.isFinite(explicitPercent)) return Math.max(0, Math.min(100, explicitPercent));

            const downloaded = Number(snapshot?.downloadedBytes) || 0;
            const total = Number(snapshot?.totalBytes) || 0;
            if (downloaded >= 0 && total > 0) return Math.max(0, Math.min(100, (downloaded / total) * 100));
            return null;
        };

        const renderUpdateDownloadProgressHtml = (snapshot, fallbackText) => {
            const status = snapshot?.status || updateStatus;
            const percent = getDownloadPercent(snapshot);
            const percentLabel = percent === null ? '计算中' : `${percent.toFixed(percent >= 10 || percent === 0 ? 0 : 1)}%`;
            const trackClass = percent === null ? 'update-download-progress__track is-indeterminate' : 'update-download-progress__track';
            const barStyle = percent === null ? '' : ` style="width:${percent}%"`;
            const title = status === 'downloading' ? '正在下载更新' : (fallbackText || '正在处理更新');
            const detailText = status === 'downloading'
                ? `${formatBytes(snapshot?.downloadedBytes || 0)} / ${snapshot?.totalBytes ? formatBytes(snapshot.totalBytes) : '未知大小'}`
                : (fallbackText || '');
            const speed = Number(snapshot?.speedBytesPerSecond) || 0;
            const speedHtml = status === 'downloading'
                ? `<span>速度：${speed > 0 ? dialogs.escapeHtml(`${formatBytes(speed)}/s`) : '等待数据'}</span>`
                : '';

            return `
                <div class="update-download-progress update-download-progress--settings">
                    <div class="update-download-progress__row">
                        <span class="update-download-progress__title">${dialogs.escapeHtml(title)}</span>
                        <span class="update-download-progress__percent">${dialogs.escapeHtml(percentLabel)}</span>
                    </div>
                    <div class="${trackClass}">
                        <div class="update-download-progress__bar"${barStyle}></div>
                    </div>
                    <div class="update-download-progress__detail">
                        <span>${dialogs.escapeHtml(detailText)}</span>
                        ${speedHtml}
                    </div>
                </div>
            `;
        };

        let statusHtml = '';
        let updateDownloadProgressHtml = '';
        const timeStr = lastCheck ? new Date(parseInt(lastCheck, 10)).toLocaleString() : '从未检查';

        if (updateStatus === 'checking') {
            statusHtml = '<span class="update-status-loading">正在检查中...</span>';
        } else if (updateStatus === 'downloading') {
            statusHtml = '<span class="update-status-loading">正在下载更新...</span>';
            updateDownloadProgressHtml = renderUpdateDownloadProgressHtml(
                updateDownloadSnapshot || { status: 'downloading', message: updateDownloadText },
                updateDownloadText || '正在下载更新...'
            );
        } else if (updateStatus === 'canceling') {
            statusHtml = '<span class="update-status-loading">正在取消下载...</span>';
            updateDownloadProgressHtml = renderUpdateDownloadProgressHtml(
                updateDownloadSnapshot || { status: 'canceling', message: updateDownloadText },
                updateDownloadText || '正在取消下载...'
            );
        } else if (updateStatus === 'downloaded') {
            statusHtml = '<span class="update-status-latest">✓ 更新已完成，请重启 CainFlow 主程序</span>';
        } else if (updateStatus === 'latest') {
            statusHtml = '<span class="update-status-latest">✓ 当前已是最新版本</span>';
        } else if (updateStatus === 'new_version') {
            statusHtml = `
                <div class="general-settings-status-row">
                    <span class="update-status-new">发现新版本 ${latestVer}</span>
                    <button class="btn btn-secondary btn-sm" data-action="download-update" style="animation: glow-pulse 2.5s infinite">下载并更新</button>
                </div>
            `;
        } else if (updateStatus === 'error') {
            statusHtml = `<span class="update-status-error" title="${dialogs.escapeHtml(updateError)}">✗ ${dialogs.escapeHtml(updateError)}</span>`;
        }

        let updateActionButtonHtml = '<button class="btn btn-secondary" data-action="goto-download" style="width:100%;">前往下载</button>';
        if (updateStatus === 'new_version') {
            updateActionButtonHtml = '<button class="btn btn-primary" data-action="download-update" style="width:100%; animation: glow-pulse 2.5s infinite;">下载并更新</button>';
        } else if (updateStatus === 'downloading') {
            updateActionButtonHtml = '<button class="btn btn-secondary" data-action="cancel-update" style="width:100%;">取消下载</button>';
        } else if (updateStatus === 'canceling') {
            updateActionButtonHtml = '<button class="btn btn-secondary" style="width:100%;" disabled>正在取消...</button>';
        }

        const updateSettingsCardHtml = AUTO_UPDATE_CHECK_DISABLED ? '' : `
            <div class="api-config-card general-settings-card general-settings-card--update" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">系统版本与更新</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: flex-start;">
                    <div class="card-field">
                        <div class="general-settings-label-row">
                            ${dialogs.renderGeneralSettingsHelpLabel('当前版本与检查结果', generalHelpText.updateStatus)}
                        </div>
                        <div style="display:flex; flex-direction:column; gap:12px; width:100%;">
                            <div class="general-settings-update-header" style="display:flex; align-items:center; justify-content:space-between; width:100%;">
                                <span class="version-badge">${appVersion}</span>
                                <div class="update-status-indicator">${statusHtml}</div>
                            </div>
                            <div class="update-version-summary">
                                <span>本地版本</span>
                                <strong>${appVersion}</strong>
                                <span>服务端版本</span>
                                <strong>${serverVersionText}</strong>
                            </div>
                            ${updateDownloadProgressHtml}
                            <div class="general-settings-update-actions" style="display:flex; flex-direction:column; gap:8px; width:100%;">
                                ${updateActionButtonHtml}
                                <button id="btn-check-update" class="btn btn-secondary" style="width:100%;">检查更新</button>
                            </div>
                            <div class="general-settings-field-divider" aria-hidden="true"></div>
                            <div class="card-field">
                                <div class="general-settings-control-row">
                                    ${dialogs.renderGeneralSettingsHelpLabel('加载页面时自动检查更新', generalHelpText.autoCheckUpdatesOnLoad, { emphasis: true })}
                                    <label class="toggle-switch">
                                        <input type="checkbox" id="setting-auto-check-updates-on-load" ${autoCheckUpdatesOnLoad ? 'checked' : ''}>
                                        <span class="toggle-slider"></span>
                                    </label>
                                </div>
                            </div>
                        </div>
                        <div class="general-settings-meta-text">最后检查: ${timeStr}</div>
                    </div>
                </div>
            </div>
        `;

        list.innerHTML = `
        <div class="general-settings-grid">
            <div class="api-config-card general-settings-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">图片处理设置</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: flex-start;">
                    <div class="card-field">
                        <div class="general-settings-control-row">
                            ${dialogs.renderGeneralSettingsHelpLabel('导入时自动缩放', generalHelpText.autoResize, { emphasis: true })}
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-auto-resize-enabled" ${autoResizeEnabled ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <div class="general-settings-label-row">
                            ${dialogs.renderGeneralSettingsHelpLabel('图片导入自适应缩放阈值 (边长)', generalHelpText.maxSide)}
                        </div>
                        <div class="general-settings-inline-input" style="display:flex; align-items:center; gap:8px; opacity:${autoResizeEnabled ? '1' : '0.55'};">
                            <input type="number" id="setting-max-side" value="${currentSide}" placeholder="如: 2048" style="flex:1" ${autoResizeEnabled ? '' : 'disabled'} />
                            <span id="pixels-hint" style="font-size:11px; color:var(--text-dim); min-width:60px;">${(state.imageMaxPixels / 1000000).toFixed(1)} MP</span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="api-config-card general-settings-card">
                <div class="card-header">
                    <span>存储设置</span>
                </div>
                <div class="card-row">
                    <div class="card-field">
                        <div class="general-settings-label-row">
                            ${dialogs.renderGeneralSettingsHelpLabel('全局图片保存目录', generalHelpText.globalSaveDir)}
                        </div>
                        <div class="general-settings-dir-row">
                            <span id="global-dir-badge" class="${state.globalSaveDirHandle ? 'is-set' : 'is-missing'}">
                                ${state.globalSaveDirHandle ? `已选择: ${state.globalSaveDirHandle.name}` : '<span class="general-settings-warning-text">⚠️ 未设置</span>'}
                            </span>
                            <button id="btn-set-global-dir" class="btn btn-secondary btn-xs general-settings-dir-action">更改</button>
                            ${state.globalSaveDirHandle ? '<button id="btn-clear-global-dir" class="btn btn-ghost btn-xs general-settings-dir-action general-settings-dir-action--danger">清除</button>' : ''}
                        </div>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <div class="general-settings-control-row">
                            ${dialogs.renderGeneralSettingsHelpLabel('保存图片时使用提示词命名', generalHelpText.promptFilename, { emphasis: true })}
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-image-save-use-prompt-filename" ${imageSaveUsePromptFilename ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                </div>
            </div>

            <div class="api-config-card general-settings-card">
                <div class="card-header">
                    <span>自动化与重试</span>
                </div>
                <div class="card-row">
                    <div class="card-field">
                        <div class="general-settings-label-row">
                            ${dialogs.renderGeneralSettingsHelpLabel('最大自动重试次数', generalHelpText.maxRetries)}
                        </div>
                        <div class="general-settings-inline-input">
                            <div class="retry-input-group">
                                <button class="btn-retry-step" data-step="-1">-</button>
                                <input type="number" id="setting-max-retries" value="${state.maxRetries || 15}" min="1" max="100" />
                                <button class="btn-retry-step" data-step="1">+</button>
                            </div>
                            <span class="general-settings-unit">轮</span>
                        </div>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <div class="general-settings-control-row">
                            ${dialogs.renderGeneralSettingsHelpLabel('并发请求模式', generalHelpText.concurrentRequestMode, { emphasis: true })}
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-concurrent-request-mode" ${concurrentRequestMode ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <div class="general-settings-control-row">
                            ${dialogs.renderGeneralSettingsHelpLabel('请求超时设置', generalHelpText.timeout, { emphasis: true })}
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-timeout-enabled" ${state.requestTimeoutEnabled ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="general-settings-inline-input" style="display:flex; align-items:center; gap:8px; opacity:${state.requestTimeoutEnabled ? '1' : '0.55'};">
                            <input type="number" id="setting-timeout-seconds" value="${state.requestTimeoutSeconds || 60}" min="1" step="1" ${state.requestTimeoutEnabled ? '' : 'disabled'} style="flex:1" />
                            <span style="font-size:11px; color:var(--text-dim); min-width:20px;">秒</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="api-config-card general-settings-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">画布UI</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: flex-start;">
                    <div class="card-field">
                        <div class="general-settings-label-row">
                            ${dialogs.renderGeneralSettingsHelpLabel('连线类型', generalHelpText.connectionLineType)}
                        </div>
                        <select id="setting-connection-line-type" style="width:100%;">
                            <option value="bezier" ${connectionLineType === 'bezier' ? 'selected' : ''}>贝塞尔曲线</option>
                            <option value="orthogonal" ${connectionLineType === 'orthogonal' ? 'selected' : ''}>直角连线（圆角）</option>
                        </select>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <div class="general-settings-control-row">
                            ${dialogs.renderGeneralSettingsHelpLabel('顶部菜单栏固定显示', generalHelpText.toolbarPinned, { emphasis: true })}
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-toolbar-pinned" ${toolbarPinned ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <div class="general-settings-control-row">
                            ${dialogs.renderGeneralSettingsHelpLabel('左侧工具栏固定显示', generalHelpText.sidebarPinned, { emphasis: true })}
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-sidebar-pinned" ${sidebarPinned ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <div class="general-settings-control-row">
                            ${dialogs.renderGeneralSettingsHelpLabel('全局动画开关', generalHelpText.globalAnimation, { emphasis: true })}
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-global-animation-enabled" ${globalAnimationEnabled ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                </div>
            </div>
            <div class="api-config-card general-settings-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">通知设置</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: flex-start;">
                    <div class="card-field">
                        <div class="general-settings-label-row">
                            ${dialogs.renderGeneralSettingsHelpLabel('完成音效音量', generalHelpText.notificationVolume)}
                        </div>
                        <div class="general-settings-volume-row" style="display:flex; align-items:center; gap:12px;">
                            <input type="range" id="setting-notify-volume" class="notification-volume-slider" min="0" max="1" step="0.05" value="${state.notificationVolume}" style="flex:1" />
                            <span id="volume-hint" style="font-size:12px; color:var(--text-dim); min-width:40px;">${Math.round(state.notificationVolume * 100)}%</span>
                            <button id="btn-test-sound" class="btn btn-ghost" style="padding:4px 8px; font-size:11px;">测试音效</button>
                        </div>
                    </div>
                </div>
            </div>

            ${updateSettingsCardHtml}
        </div>
    `;
        dialogs.initGeneralSettingsHelpInteractions(list);
        dialogs.closeGeneralSettingsHelpPopovers(list);

        const input = documentRef.getElementById('setting-max-side');
        const hint = documentRef.getElementById('pixels-hint');
        const autoResizeInput = documentRef.getElementById('setting-auto-resize-enabled');
        const volInput = documentRef.getElementById('setting-notify-volume');
        const volHint = documentRef.getElementById('volume-hint');
        const testBtn = documentRef.getElementById('btn-test-sound');
        const btnCheckUpdate = documentRef.getElementById('btn-check-update');
        const btnGotoDownloadList = Array.from(documentRef.querySelectorAll('[data-action="goto-download"]'));
        const btnDownloadUpdateList = Array.from(documentRef.querySelectorAll('[data-action="download-update"]'));
        const btnCancelUpdateList = Array.from(documentRef.querySelectorAll('[data-action="cancel-update"]'));
        const timeoutEnabledInput = documentRef.getElementById('setting-timeout-enabled');
        const timeoutSecondsInput = documentRef.getElementById('setting-timeout-seconds');
        const concurrentRequestModeInput = documentRef.getElementById('setting-concurrent-request-mode');
        const connectionLineTypeInput = documentRef.getElementById('setting-connection-line-type');
        const toolbarPinnedInput = documentRef.getElementById('setting-toolbar-pinned');
        const sidebarPinnedInput = documentRef.getElementById('setting-sidebar-pinned');
        const globalAnimationInput = documentRef.getElementById('setting-global-animation-enabled');
        const autoCheckUpdatesOnLoadInput = documentRef.getElementById('setting-auto-check-updates-on-load');
        const imageSaveUsePromptFilenameInput = documentRef.getElementById('setting-image-save-use-prompt-filename');
        const btnSetGlobal = documentRef.getElementById('btn-set-global-dir');
        const btnClearGlobal = documentRef.getElementById('btn-clear-global-dir');
        const updateVolumeSliderProgress = () => {
            if (!volInput) return;
            const min = parseFloat(volInput.min || '0');
            const max = parseFloat(volInput.max || '1');
            const value = parseFloat(volInput.value || '0');
            const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
            volInput.style.setProperty('--notify-volume-progress', `${Math.max(0, Math.min(100, percent))}%`);
        };
        updateVolumeSliderProgress();

        btnGotoDownloadList.forEach((button) => {
            button.addEventListener('click', () => {
                windowRef.open(`https://github.com/${githubRepo}/releases/latest`, '_blank');
            });
        });
        btnDownloadUpdateList.forEach((button) => {
            button.addEventListener('click', () => {
                downloadLatestUpdate();
            });
        });
        btnCancelUpdateList.forEach((button) => {
            button.addEventListener('click', () => {
                cancelUpdateDownload();
            });
        });

        btnSetGlobal?.addEventListener('click', async () => {
            try {
                const handle = await windowRef.showDirectoryPicker();
                if (handle) {
                    state.globalSaveDirHandle = handle;
                    await saveHandle('GLOBAL_SAVE_DIR', handle);
                    renderGeneralSettings();
                    updateImageSaveWarnings();
                    showToast('全局保存目录设置成功', 'success');
                    addLog('success', '存储设置已变更', `全局目录已设置为: ${handle.name}`);
                }
            } catch (error) {
                if (error.name !== 'AbortError') showToast('设置失败: ' + error.message, 'error');
            }
        });

        btnClearGlobal?.addEventListener('click', async () => {
            state.globalSaveDirHandle = null;
            await deleteHandle('GLOBAL_SAVE_DIR');
            renderGeneralSettings();
            updateImageSaveWarnings();
            showToast('全局保存目录已清除', 'info');
        });

        volInput?.addEventListener('input', (event) => {
            const vol = parseFloat(event.target.value);
            state.notificationVolume = vol;
            volHint.textContent = Math.round(vol * 100) + '%';
            updateVolumeSliderProgress();
            saveState();
        });

        documentRef.getElementById('setting-max-retries')?.addEventListener('change', (event) => {
            const val = parseInt(event.target.value, 10);
            if (val >= 1 && val <= 100) {
                state.maxRetries = val;
                saveState();
            } else {
                event.target.value = state.maxRetries;
            }
        });

        documentRef.querySelectorAll('.btn-retry-step').forEach((btn) => {
            btn.onclick = () => {
                const step = parseInt(btn.dataset.step, 10);
                const retriesInput = documentRef.getElementById('setting-max-retries');
                if (!retriesInput) return;
                let val = (parseInt(retriesInput.value, 10) || 0) + step;
                val = Math.max(1, Math.min(100, val));
                retriesInput.value = val;
                state.maxRetries = val;
                saveState();
            };
        });

        concurrentRequestModeInput?.addEventListener('change', (event) => {
            state.concurrentRequestMode = event.target.checked;
            saveState();
        });

        timeoutEnabledInput?.addEventListener('change', (event) => {
            state.requestTimeoutEnabled = event.target.checked;
            if (timeoutSecondsInput) timeoutSecondsInput.disabled = !state.requestTimeoutEnabled;
            const wrapper = timeoutSecondsInput?.parentElement;
            if (wrapper) wrapper.style.opacity = state.requestTimeoutEnabled ? '1' : '0.55';
            saveState();
        });

        timeoutSecondsInput?.addEventListener('change', (event) => {
            const val = parseInt(event.target.value, 10);
            if (!Number.isNaN(val) && val >= 1) {
                state.requestTimeoutSeconds = val;
                saveState();
            } else {
                event.target.value = state.requestTimeoutSeconds;
            }
        });

        connectionLineTypeInput?.addEventListener('change', (event) => {
            state.connectionLineType = event.target.value === 'orthogonal' ? 'orthogonal' : 'bezier';
            updateAllConnections();
            saveState();
        });

        toolbarPinnedInput?.addEventListener('change', (event) => {
            state.toolbarPinned = event.target.checked;
            applyCanvasUiSetting();
            saveState();
        });

        sidebarPinnedInput?.addEventListener('change', (event) => {
            state.sidebarPinned = event.target.checked;
            applyCanvasUiSetting();
            saveState();
        });

        globalAnimationInput?.addEventListener('change', (event) => {
            state.globalAnimationEnabled = event.target.checked;
            state.connectionFlowAnimationEnabled = state.globalAnimationEnabled;
            applyGlobalAnimationSetting();
            updateAllConnections();
            saveState();
        });

        autoCheckUpdatesOnLoadInput?.addEventListener('change', (event) => {
            state.autoCheckUpdatesOnLoad = event.target.checked;
            saveState();
        });

        imageSaveUsePromptFilenameInput?.addEventListener('change', (event) => {
            state.imageSaveUsePromptFilename = event.target.checked;
            saveState();
        });

        testBtn?.addEventListener('click', () => {
            playNotificationSound(true);
        });
        btnCheckUpdate?.addEventListener('click', () => {
            checkUpdate(true);
        });
        autoResizeInput?.addEventListener('change', (event) => {
            state.imageAutoResizeEnabled = event.target.checked;
            if (input) input.disabled = !state.imageAutoResizeEnabled;
            const wrapper = input?.parentElement;
            if (wrapper) wrapper.style.opacity = state.imageAutoResizeEnabled ? '1' : '0.55';
            saveState();
        });
        input?.addEventListener('input', (event) => {
            const side = parseInt(event.target.value, 10) || 0;
            const total = side * side;
            state.imageMaxPixels = total;
            hint.textContent = (total / 1000000).toFixed(1) + ' MP';
            saveState();
        });
    }

    function updateImageSaveWarnings() {
        const hasDir = !!state.globalSaveDirHandle;
        for (const [id, node] of state.nodes) {
            if (node.type === 'ImageSave') {
                const warning = documentRef.getElementById(`${id}-path-warning`);
                if (warning) {
                    warning.style.display = hasDir ? 'none' : 'block';
                    windowRef.requestAnimationFrame(() => {
                        fitNodeToContent(id);
                    });
                }
            }
        }
    }

    let storageTextEncoder = null;

    function getStringStorageBytes(value) {
        const text = String(value ?? '');
        const Encoder = windowRef.TextEncoder || globalThis.TextEncoder;
        if (Encoder) {
            storageTextEncoder = storageTextEncoder || new Encoder();
            return storageTextEncoder.encode(text).length;
        }
        return text.length * 2;
    }

    function getValueStorageBytes(value) {
        if (value === undefined || value === null) return 0;
        if (typeof value === 'string') return getStringStorageBytes(value);
        try {
            return getStringStorageBytes(JSON.stringify(value));
        } catch {
            return getStringStorageBytes(String(value));
        }
    }

    function formatMB(bytes) {
        return `${(Math.max(0, bytes) / (1024 * 1024)).toFixed(2)} MB`;
    }

    function isHistoryAssetKey(key) {
        return typeof key === 'string' && key.startsWith('history:');
    }

    function isImageImportAssetKey(key) {
        return typeof key === 'string' && key.startsWith('image-import:');
    }

    async function getStoreSizeBytes(storeName, includeEntry = () => true) {
        try {
            const db = await openDB();
            return new Promise((resolve) => {
                let bytes = 0;
                const tx = db.transaction(storeName, 'readonly');
                const store = tx.objectStore(storeName);
                const req = store.openCursor();
                req.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        if (includeEntry(cursor.key, cursor.value)) {
                            bytes += getValueStorageBytes(cursor.key);
                            bytes += getValueStorageBytes(cursor.value);
                        }
                        cursor.continue();
                    } else {
                        resolve(bytes);
                    }
                };
                req.onerror = () => resolve(0);
            });
        } catch {
            return 0;
        }
    }

    function getLocalStorageBytes() {
        let bytes = 0;
        try {
            for (let i = 0; i < localStorageRef.length; i++) {
                const key = localStorageRef.key(i);
                const val = localStorageRef.getItem(key);
                bytes += getStringStorageBytes(key);
                bytes += getStringStorageBytes(val);
            }
        } catch {
            // ignore
        }
        return bytes;
    }

    async function updateCacheUsage(force = false) {
        const display = documentRef.getElementById('cache-size-display');
        const historyEl = documentRef.getElementById('usage-history');
        const assetsEl = documentRef.getElementById('usage-assets');
        const importAssetsEl = documentRef.getElementById('usage-image-import-assets');
        const localEl = documentRef.getElementById('usage-local');
        if (!display) return;

        try {
            if (force) {
                state.cacheSizes[storeHistoryName] = null;
                state.cacheSizes[storeAssetsName] = null;
            }

            const historyStoreBytes = await getStoreSizeBytes(storeHistoryName);
            const historyAssetBytes = await getStoreSizeBytes(storeAssetsName, (key) => isHistoryAssetKey(key));
            const imageImportAssetBytes = await getStoreSizeBytes(storeAssetsName, (key) => isImageImportAssetKey(key));
            const nodeAssetBytes = await getStoreSizeBytes(storeAssetsName, (key) => !isHistoryAssetKey(key) && !isImageImportAssetKey(key));
            const localBytes = getLocalStorageBytes();
            const historyBytes = historyStoreBytes + historyAssetBytes;
            const totalBytes = historyBytes + nodeAssetBytes + imageImportAssetBytes + localBytes;

            display.textContent = formatMB(totalBytes);
            if (historyEl) historyEl.textContent = formatMB(historyBytes);
            if (assetsEl) assetsEl.textContent = formatMB(nodeAssetBytes);
            if (importAssetsEl) importAssetsEl.textContent = formatMB(imageImportAssetBytes);
            if (localEl) localEl.textContent = formatMB(localBytes);
        } catch (error) {
            display.textContent = '获取失败';
            console.error('Cache audit failed:', error);
        }
    }

    return {
        playNotificationSound,
        renderGeneralSettings,
        updateImageSaveWarnings,
        updateCacheUsage
    };
}
