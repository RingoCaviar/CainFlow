/**
 * Handles proxy settings, network connectivity checks, and proxy mismatch detection.
 */
export function createProxyNetworkSettings({ ctx, store, dialogs }) {
    const {
        state,
        showToast,
        saveState,
        floatingNoticesApi,
        documentRef,
        windowRef,
        localStorageRef,
        fetchImpl
    } = ctx;

    const {
        networkProxyStatusState,
        constants
    } = store;

    function createAbortErrorMessage(error, timeoutMessage) {
        if (error?.name === 'AbortError') return timeoutMessage;
        return error?.message || String(error);
    }

    async function fetchWithTimeout(url, options = {}, timeoutSeconds = 30, timeoutMessage = '请求超时') {
        const Controller = windowRef.AbortController || globalThis.AbortController;
        if (!Controller) {
            return Promise.race([
                fetchImpl(url, options),
                new Promise((_, reject) => {
                    windowRef.setTimeout(() => reject(new Error(timeoutMessage)), timeoutSeconds * 1000);
                })
            ]);
        }

        const controller = new Controller();
        const timeoutId = windowRef.setTimeout(() => controller.abort(), timeoutSeconds * 1000);
        try {
            return await fetchImpl(url, {
                ...options,
                signal: controller.signal
            });
        } catch (error) {
            throw new Error(createAbortErrorMessage(error, timeoutMessage));
        } finally {
            windowRef.clearTimeout(timeoutId);
        }
    }

    async function probeNetworkTargetFromBackend(target, timeoutSeconds = 5) {
        const start = Date.now();
        const result = {
            name: String(target?.name || target?.url || 'target'),
            url: String(target?.url || ''),
            success: false,
            status: 0,
            latency: 0,
            detail: ''
        };
        if (!result.url) {
            result.detail = '探测地址为空';
            return result;
        }

        try {
            const response = await fetchWithTimeout('/api/probe_network_target', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: result.name,
                    url: result.url,
                    method: target?.method || 'HEAD'
                })
            }, timeoutSeconds, '网络环境检测超时');
            if (!response.ok) {
                throw new Error(`网络环境检测失败，HTTP ${response.status}`);
            }
            const data = await response.json();
            result.success = !!data?.success;
            result.status = Number(data?.status) || 0;
            result.latency = Number(data?.latency) || (Date.now() - start);
            result.detail = data?.detail || (result.success ? '后端探测成功' : '后端探测失败');
        } catch (error) {
            result.latency = Date.now() - start;
            result.detail = createAbortErrorMessage(error, '网络环境检测超时');
        }
        return result;
    }

    async function detectNetworkPathFromBrowser() {
        const attempts = [];
        for (const target of constants.NETWORK_PROBE_TARGETS) {
            attempts.push(await probeNetworkTargetFromBackend(target, 5));
        }

        const successfulAttempts = attempts.filter((attempt) => attempt.success);
        const allTargetsReachable = attempts.length > 0 && successfulAttempts.length === attempts.length;
        const firstReachable = successfulAttempts[0] || null;
        const detailAttempt = firstReachable || attempts[0] || {};
        return {
            proxyEnabled: false,
            effectiveMode: allTargetsReachable ? 'proxy' : 'direct',
            reachable: successfulAttempts.length > 0,
            transparentProxyLikely: allTargetsReachable,
            localProxyDetected: false,
            localProxy: null,
            latency: Number(firstReachable?.latency) || 0,
            checkedTarget: successfulAttempts.map((attempt) => attempt.name).join(' / '),
            detail: detailAttempt.detail || '网络探测失败',
            attempts,
            proxyAttempts: [],
            shouldNotify: allTargetsReachable
        };
    }

    async function detectNetworkConnectivity() {
        const attempts = [];
        for (const target of constants.NETWORK_CONNECTIVITY_TARGETS) {
            const attempt = await probeNetworkTargetFromBackend(target, 5);
            attempts.push(attempt);
            if (attempt.success) break;
        }

        const successfulAttempts = attempts.filter((attempt) => attempt.success);
        const firstReachable = successfulAttempts[0] || null;
        const detailAttempt = firstReachable || attempts[0] || {};
        return {
            online: successfulAttempts.length > 0,
            reachable: successfulAttempts.length > 0,
            checkedTarget: String(firstReachable?.name || ''),
            latency: Number(firstReachable?.latency) || 0,
            detail: detailAttempt.detail || '网络探测失败',
            attempts
        };
    }

    function formatProxyDetectionSummary(attempts = []) {
        if (!Array.isArray(attempts) || attempts.length === 0) return '';
        return attempts.map((attempt) => {
            const endpoint = `${attempt?.ip || '127.0.0.1'}:${attempt?.port || ''}`;
            const name = String(attempt?.name || '').trim();
            const label = name ? `${endpoint} ${name}` : endpoint;
            const checkedTarget = attempt?.checkedTarget ? `，目标 ${attempt.checkedTarget}` : '';
            if (attempt?.available) {
                const latency = Number.isFinite(attempt?.latency) && attempt.latency > 0 ? `，${attempt.latency}ms` : '';
                return `• ${label}: 可用${latency}${checkedTarget}`;
            }
            if (attempt?.reachable) {
                return `• ${label}: 端口可达，但代理不可用${attempt?.detail ? `（${attempt.detail}）` : ''}`;
            }
            return `• ${label}: 不可用${attempt?.detail ? `（${attempt.detail}）` : ''}`;
        }).join('\n');
    }

    function hideNetworkProxyMismatchNotice() {
        floatingNoticesApi?.hideNotice(constants.networkProxyNoticeId);
    }

    function showNetworkProxyMismatchNotice(result) {
        if (!floatingNoticesApi) return;
        const checkedTarget = result?.checkedTarget || '国外网络';
        floatingNoticesApi.upsertNotice({
            id: constants.networkProxyNoticeId,
            priority: 25,
            className: 'update-canvas-notice network-proxy-notice',
            role: 'alert',
            icon: '!',
            clickable: true,
            onClick: () => dialogs.renderNetworkProxyHintDialog(),
            title: ['请注意网络设置'],
            meta: ['检测到当前会以 ', { tag: 'span', text: result?.effectiveMode === 'proxy' ? '代理/透明代理' : '直连' }, ' 模式访问 ', { tag: 'span', text: checkedTarget }, '。这条链路和真实 API 请求一致。点击查看说明。'],
            actions: [
                {
                    id: 'btn-network-proxy-hint-details',
                    label: '查看说明',
                    onClick: () => dialogs.renderNetworkProxyHintDialog()
                },
                {
                    id: 'btn-network-proxy-open-settings',
                    label: '代理设置',
                    onClick: () => dialogs.openSettingsProxyTab()
                }
            ],
            dismissible: true,
            closeLabel: '关闭网络设置提醒'
        });
    }

    function saveNetworkProxyDetectionCache(result) {
        try {
            localStorageRef.setItem(constants.networkProxyDetectionStorageKey, JSON.stringify({
                version: constants.networkProxyDetectionCacheVersion,
                targetsSignature: constants.networkProxyDetectionTargetsSignature,
                checkedAt: Date.now(),
                result
            }));
        } catch {
            // ignore
        }
    }

    function readNetworkProxyDetectionCache() {
        try {
            const parsed = JSON.parse(localStorageRef.getItem(constants.networkProxyDetectionStorageKey) || 'null');
            if (!parsed || typeof parsed !== 'object') return null;
            if (Number(parsed.version) !== constants.networkProxyDetectionCacheVersion) {
                localStorageRef.removeItem(constants.networkProxyDetectionStorageKey);
                return null;
            }
            if (String(parsed.targetsSignature || '') !== constants.networkProxyDetectionTargetsSignature) {
                localStorageRef.removeItem(constants.networkProxyDetectionStorageKey);
                return null;
            }
            const checkedAt = Number(parsed.checkedAt);
            if (!Number.isFinite(checkedAt)) {
                localStorageRef.removeItem(constants.networkProxyDetectionStorageKey);
                return null;
            }
            if (Date.now() - checkedAt > constants.networkProxyDetectionCooldownMs) {
                localStorageRef.removeItem(constants.networkProxyDetectionStorageKey);
                return null;
            }
            const result = parsed.result || null;
            const attempts = Array.isArray(result?.attempts) ? result.attempts : [];
            const hasLegacyGithubTarget = attempts.some((attempt) => {
                const name = String(attempt?.name || '').toLowerCase();
                const url = String(attempt?.url || '').toLowerCase();
                return name.includes('github') || url.includes('api.github.com');
            });
            if (hasLegacyGithubTarget) {
                localStorageRef.removeItem(constants.networkProxyDetectionStorageKey);
                return null;
            }
            return result;
        } catch {
            return null;
        }
    }

    function showNetworkProxyDetectionResultToast(result) {
        if (result?.skippedBecauseProxyEnabled) {
            showToast('已开启应用内代理，跳过网络环境检测', 'info', 5000);
            return;
        }
        if (result?.shouldNotify) {
            showToast('检测到网络环境可能经过代理/透明代理，请查看左侧通知', 'warning', 7000);
            return;
        }
        if (result?.reachable) {
            const targetText = result.checkedTarget ? `（${result.checkedTarget}）` : '';
            const latencyText = Number.isFinite(result.latency) && result.latency > 0 ? `，${result.latency}ms` : '';
            showToast(`网络环境检测正常${targetText}${latencyText}`, 'success', 5000);
            return;
        }
        showToast('网络环境检测完成，未检测到代理/透明代理异常', 'success', 5000);
    }

    function showNetworkConnectivityResultToast(result) {
        if (result?.online) {
            const targetText = result.checkedTarget ? `（${result.checkedTarget}）` : '';
            const latencyText = Number.isFinite(result.latency) && result.latency > 0 ? `，${result.latency}ms` : '';
            showToast(`网络连接正常${targetText}${latencyText}`, 'success', 5000);
            return;
        }

        const failedCount = Array.isArray(result?.attempts) ? result.attempts.length : 0;
        const suffix = failedCount > 0 ? `，已测试 ${failedCount} 个目标` : '';
        showToast(`网络连接不可用${suffix}，请检查网络或代理设置`, 'warning', 7000);
    }

    async function initProxyPanel() {
        const enabledCheck = documentRef.getElementById('proxy-enabled');
        const ipInput = documentRef.getElementById('proxy-ip');
        const portInput = documentRef.getElementById('proxy-port');
        const detectBtn = documentRef.getElementById('btn-detect-proxy');
        const saveBtn = documentRef.getElementById('btn-test-proxy');
        const fieldsDiv = documentRef.getElementById('proxy-settings-fields');

        try {
            const res = await fetchImpl('/api/proxy');
            if (!res.ok) return;

            const config = await res.json();
            const newCheck = enabledCheck.cloneNode(true);
            const newIp = ipInput.cloneNode(true);
            const newPort = portInput.cloneNode(true);
            const newDetectBtn = detectBtn.cloneNode(true);
            const newTestBtn = saveBtn.cloneNode(true);

            enabledCheck.parentNode.replaceChild(newCheck, enabledCheck);
            ipInput.parentNode.replaceChild(newIp, ipInput);
            portInput.parentNode.replaceChild(newPort, portInput);
            detectBtn.parentNode.replaceChild(newDetectBtn, detectBtn);
            saveBtn.parentNode.replaceChild(newTestBtn, saveBtn);

            newCheck.checked = config.enabled;
            newIp.value = config.ip || '127.0.0.1';
            newPort.value = config.port || '7890';

            if (!state.proxy) {
                state.proxy = { ...config };
                saveState();
            }

            const updateFields = () => {
                newIp.disabled = !newCheck.checked;
                newPort.disabled = !newCheck.checked;
                newTestBtn.disabled = !newCheck.checked;
                fieldsDiv.style.opacity = newCheck.checked ? '1' : '0.5';
            };
            updateFields();

            const handleSave = async () => {
                const newConfig = {
                    enabled: newCheck.checked,
                    ip: newIp.value.trim(),
                    port: newPort.value.trim()
                };

                state.proxy = { ...newConfig };
                saveState();

                try {
                    const postRes = await fetchImpl('/api/proxy', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(newConfig)
                    });
                    showToast(postRes.ok ? '代理设置已保存并立即生效' : '保存代理设置失败', postRes.ok ? 'success' : 'error');
                    if (postRes.ok) {
                        if (newConfig.enabled) {
                            hideNetworkProxyMismatchNotice();
                            networkProxyStatusState.result = null;
                        } else {
                            localStorageRef.removeItem(constants.networkProxyDetectionStorageKey);
                            checkNetworkProxyMismatch(true);
                        }
                    }
                } catch (error) {
                    showToast('保存代理设置异常: ' + error, 'error');
                }
            };

            newDetectBtn.addEventListener('click', async () => {
                newDetectBtn.disabled = true;
                newTestBtn.disabled = true;
                const originalText = newDetectBtn.textContent;
                newDetectBtn.textContent = '检测中...';

                try {
                    const response = await fetchImpl('/api/detect_proxy', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: '{}'
                    });
                    const data = await response.json();
                    const attemptSummary = formatProxyDetectionSummary(data?.attempts);
                    if (response.ok && data?.success && data?.proxy) {
                        newCheck.checked = true;
                        newIp.value = String(data.proxy.ip || '127.0.0.1');
                        newPort.value = String(data.proxy.port || '');
                        updateFields();
                        await handleSave();
                        const sourceText = data.source ? ` (${data.source})` : '';
                        const latencyText = Number.isFinite(data.latency) && data.latency > 0 ? `，延迟 ${data.latency}ms` : '';
                        const targetText = data.checkedTarget ? `，探测目标 ${data.checkedTarget}` : '';
                        const summaryText = attemptSummary ? `\n已测试端口：\n${attemptSummary}` : '';
                        showToast(`已检测到可用代理${sourceText}，已自动填入 ${newIp.value}:${newPort.value}${latencyText}${targetText}${summaryText}`, 'success', 12000);
                    } else {
                        const summaryText = attemptSummary ? `\n已测试端口：\n${attemptSummary}` : '';
                        showToast(`${data?.message || '未检测到可用的本地代理端口'}${summaryText}`, 'warning', 12000);
                    }
                } catch (error) {
                    showToast('自动检测代理失败: ' + error, 'error');
                } finally {
                    newDetectBtn.textContent = originalText;
                    newDetectBtn.disabled = false;
                    updateFields();
                }
            });

            newTestBtn.addEventListener('click', async () => {
                newTestBtn.disabled = true;
                const originalText = newTestBtn.textContent;
                newTestBtn.textContent = '测试中...';

                try {
                    const postRes = await fetchImpl('/api/test_proxy', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ip: newIp.value.trim(), port: newPort.value.trim() })
                    });
                    if (postRes.ok) {
                        const resData = await postRes.json();
                        const latency = resData.latency || 0;
                        showToast(`连通性测试成功，延迟: ${latency}ms (Google)`, 'success');
                    } else {
                        const errText = await postRes.text();
                        showToast('代理连通性测试失败！' + errText, 'error');
                    }
                } catch (error) {
                    showToast('检测请求失败: ' + error, 'error');
                } finally {
                    newTestBtn.textContent = originalText;
                    newTestBtn.disabled = false;
                }
            });

            newCheck.addEventListener('change', () => {
                updateFields();
                handleSave();
            });
            newIp.addEventListener('change', handleSave);
            newPort.addEventListener('change', handleSave);
        } catch (error) {
            console.error('Failed to init proxy modal', error);
        }
    }

    async function syncProxyToServer() {
        const proxyConfig = state.proxy
            ? { ...state.proxy }
            : { enabled: false, ip: '127.0.0.1', port: '7890' };
        try {
            await fetchImpl('/api/proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(proxyConfig)
            });
        } catch (error) {
            console.error('Failed to sync proxy state to server on startup:', error);
        }
    }

    async function checkNetworkConnectivity({ showResultToast = true } = {}) {
        try {
            const result = await detectNetworkConnectivity();
            if (showResultToast) {
                showNetworkConnectivityResultToast(result);
            }
            return result;
        } catch (error) {
            console.error('Failed to check network connectivity', error);
            const result = {
                online: false,
                reachable: false,
                checkedTarget: '',
                latency: 0,
                detail: error?.message || '网络连通性检测失败',
                attempts: []
            };
            if (showResultToast) {
                showToast(`${result.detail}，请检查网络或代理设置`, 'warning', 7000);
            }
            return result;
        }
    }

    async function checkNetworkProxyMismatch(force = false) {
        if (state.proxy?.enabled) {
            const result = {
                proxyEnabled: true,
                effectiveMode: 'proxy',
                reachable: null,
                latency: 0,
                checkedTarget: '',
                detail: '已开启应用内代理，跳过网络环境检测',
                attempts: [],
                proxyAttempts: [],
                shouldNotify: false,
                skippedBecauseProxyEnabled: true
            };
            networkProxyStatusState.result = result;
            hideNetworkProxyMismatchNotice();
            showNetworkProxyDetectionResultToast(result);
            return result;
        }
        if (networkProxyStatusState.checking) {
            return networkProxyStatusState.result;
        }

        const cachedResult = !force ? readNetworkProxyDetectionCache() : null;
        if (cachedResult) {
            networkProxyStatusState.result = cachedResult;
            if (cachedResult.shouldNotify) {
                showNetworkProxyMismatchNotice(cachedResult);
            } else {
                hideNetworkProxyMismatchNotice();
            }
            showNetworkProxyDetectionResultToast(cachedResult);
            return cachedResult;
        }

        networkProxyStatusState.checking = true;
        try {
            const result = await detectNetworkPathFromBrowser();
            networkProxyStatusState.result = result;
            saveNetworkProxyDetectionCache(result);
            if (result?.shouldNotify) {
                showNetworkProxyMismatchNotice(result);
            } else {
                hideNetworkProxyMismatchNotice();
            }
            showNetworkProxyDetectionResultToast(result);
            return result;
        } catch (error) {
            console.error('Failed to detect network proxy mismatch', error);
            hideNetworkProxyMismatchNotice();
            const isDetectionTimeout = String(error?.message || error || '').includes('网络环境检测超时');
            if (isDetectionTimeout) {
                const result = {
                    proxyEnabled: false,
                    effectiveMode: 'direct',
                    reachable: false,
                    transparentProxyLikely: false,
                    localProxyDetected: false,
                    localProxy: null,
                    latency: 0,
                    checkedTarget: '',
                    detail: '检测超时，未检测到代理/透明代理异常',
                    attempts: [],
                    proxyAttempts: [],
                    shouldNotify: false
                };
                networkProxyStatusState.result = result;
                showNetworkProxyDetectionResultToast(result);
                return result;
            }
            showToast(error?.message || '网络环境检测失败', 'warning', 7000);
            return null;
        } finally {
            networkProxyStatusState.checking = false;
        }
    }

    return {
        initProxyPanel,
        syncProxyToServer,
        checkNetworkConnectivity,
        checkNetworkProxyMismatch
    };
}
