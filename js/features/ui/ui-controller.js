/**
 * 负责主界面各类面板与按钮的事件装配，是通用 UI 行为的集中控制器。
 */
import { normalizeModelConfig, normalizeProviderType } from '../execution/provider-request-utils.js';

export function createUiControllerApi({
    state,
    panelManager,
    settingsModal,
    dbName = 'NodeFlowDB',
    openDB,
    storeHistoryName,
    storeAssetsName,
    clearHistory,
    getHistory,
    renderHistoryList,
    renderLogs,
    historyPreviewApi,
    settingsControllerApi,
    applyHistoryGridCols,
    applyTheme = () => {},
    saveState,
    showToast,
    copyToClipboard,
    downloadImage,
    initFeatureModules,
    documentRef = document,
    localStorageRef = localStorage,
    indexedDbRef = indexedDB,
    locationRef = location,
    notificationRef = typeof Notification !== 'undefined' ? Notification : null,
    confirmRef = confirm,
    alertRef = alert
}) {
    function buildConfigPayload() {
        return {
            type: 'cainflow-config',
            version: '1.0',
            exportedAt: new Date().toISOString(),
            providers: state.providers.map((provider) => ({ ...provider })),
            models: state.models.map((model) => ({ ...model })),
            settings: {
                themeMode: state.themeMode,
                notificationsEnabled: state.notificationsEnabled,
                notificationVolume: state.notificationVolume,
                autoRetry: state.autoRetry,
                maxRetries: state.maxRetries,
                imageAutoResizeEnabled: state.imageAutoResizeEnabled,
                imageMaxPixels: state.imageMaxPixels,
                proxy: state.proxy ? { ...state.proxy } : null,
                requestTimeoutEnabled: state.requestTimeoutEnabled,
                requestTimeoutSeconds: state.requestTimeoutSeconds,
                historyGridCols: state.historyGridCols
            }
        };
    }

    function normalizeProviders(providers) {
        if (!Array.isArray(providers)) throw new Error('配置文件缺少 providers 数组');

        return providers.map((provider, index) => ({
            id: String(provider?.id || `prov_import_${index + 1}`),
            name: typeof provider?.name === 'string' && provider.name.trim() ? provider.name.trim() : `导入供应商 ${index + 1}`,
            type: normalizeProviderType(provider?.type, provider),
            apikey: typeof provider?.apikey === 'string' ? provider.apikey : '',
            endpoint: typeof provider?.endpoint === 'string' ? provider.endpoint : '',
            autoComplete: provider?.autoComplete !== false
        }));
    }

    function normalizeModels(models, providers) {
        if (!Array.isArray(models)) throw new Error('配置文件缺少 models 数组');

        const providersById = new Map((providers || []).map((provider) => [provider.id, provider]));
        return models.map((model, index) => normalizeModelConfig(model, index, providersById));
    }

    function ensureUniqueIds(items, label) {
        const seen = new Set();
        items.forEach((item) => {
            if (seen.has(item.id)) {
                throw new Error(`${label}存在重复 ID：${item.id}`);
            }
            seen.add(item.id);
        });
    }

    function applyImportedConfig(configData) {
        if (!configData || typeof configData !== 'object') {
            throw new Error('配置文件格式无效');
        }

        const providers = normalizeProviders(configData.providers);
        const models = normalizeModels(configData.models, providers);
        const settings = configData.settings && typeof configData.settings === 'object'
            ? configData.settings
            : {};

        ensureUniqueIds(providers, '供应商配置');
        ensureUniqueIds(models, '模型配置');

        const providerIds = new Set(providers.map((provider) => provider.id));
        const invalidModel = models.find((model) => model.providerId && !providerIds.has(model.providerId));
        if (invalidModel) {
            throw new Error(`模型 ${invalidModel.name} 绑定了不存在的供应商：${invalidModel.providerId}`);
        }

        state.providers = providers;
        state.models = models;

        if (settings.themeMode !== undefined) {
            applyTheme(settings.themeMode);
        } else {
            applyTheme(state.themeMode);
        }

        if (settings.notificationsEnabled !== undefined) {
            state.notificationsEnabled = !!settings.notificationsEnabled;
            const toggle = documentRef.getElementById('toggle-notifications');
            if (toggle) toggle.checked = state.notificationsEnabled;
        }

        if (settings.notificationVolume !== undefined) {
            const volume = Number(settings.notificationVolume);
            if (!Number.isNaN(volume)) {
                state.notificationVolume = Math.max(0, Math.min(1, volume));
            }
        }

        if (settings.autoRetry !== undefined) {
            state.autoRetry = !!settings.autoRetry;
            const retryToggle = documentRef.getElementById('toggle-retry');
            if (retryToggle) retryToggle.checked = state.autoRetry;
        }

        if (settings.maxRetries !== undefined) {
            const maxRetries = parseInt(settings.maxRetries, 10);
            if (!Number.isNaN(maxRetries) && maxRetries >= 1) {
                state.maxRetries = Math.min(100, maxRetries);
            }
        }

        if (settings.imageAutoResizeEnabled !== undefined) {
            state.imageAutoResizeEnabled = !!settings.imageAutoResizeEnabled;
        }

        if (settings.imageMaxPixels !== undefined) {
            const imageMaxPixels = parseInt(settings.imageMaxPixels, 10);
            if (!Number.isNaN(imageMaxPixels) && imageMaxPixels > 0) {
                state.imageMaxPixels = imageMaxPixels;
            }
        }

        if (Object.prototype.hasOwnProperty.call(settings, 'proxy')) {
            state.proxy = settings.proxy && typeof settings.proxy === 'object'
                ? { ...settings.proxy }
                : null;
        }

        if (settings.requestTimeoutEnabled !== undefined) {
            state.requestTimeoutEnabled = !!settings.requestTimeoutEnabled;
        }

        if (settings.requestTimeoutSeconds !== undefined) {
            const timeoutSeconds = parseInt(settings.requestTimeoutSeconds, 10);
            if (!Number.isNaN(timeoutSeconds) && timeoutSeconds >= 1) {
                state.requestTimeoutSeconds = timeoutSeconds;
            }
        }

        if (settings.historyGridCols !== undefined) {
            applyHistoryGridCols(settings.historyGridCols);
        }

        settingsControllerApi?.updateAllNodeModelDropdowns();
        settingsControllerApi?.renderProviders();
        settingsControllerApi?.renderModels();
        settingsControllerApi?.renderGeneralSettings();
        settingsControllerApi?.syncProxyToServer();
        saveState();
    }

    function exportConfig() {
        try {
            const payload = buildConfigPayload();
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = documentRef.createElement('a');
            const time = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

            link.href = url;
            link.download = `CainFlow_Config_${time}.json`;
            link.click();

            URL.revokeObjectURL(url);
            showToast('配置已导出，请妥善保管文件（包含 API 密钥）', 'success', 5000);
        } catch (error) {
            showToast('导出配置失败: ' + error.message, 'error');
        }
    }

    function importConfig(file) {
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                applyImportedConfig(data);
                showToast('配置已导入并生效', 'success');
            } catch (error) {
                showToast('导入配置失败: ' + error.message, 'error', 5000);
            }
        };
        reader.onerror = () => {
            showToast('读取配置文件失败', 'error');
        };
        reader.readAsText(file, 'utf-8');
    }

    function initUI() {
        const btnHistory = documentRef.getElementById('btn-history');
        const sidebar = documentRef.getElementById('history-sidebar');
        const logDrawer = documentRef.getElementById('log-drawer');
        const btnImportConfig = documentRef.getElementById('btn-import-config');
        const btnExportConfig = documentRef.getElementById('btn-export-config');
        const inputConfigImport = documentRef.getElementById('input-config-import');

        if (btnHistory && sidebar) {
            btnHistory.addEventListener('click', () => {
                panelManager.toggle('history', () => {
                    renderHistoryList().catch((err) => console.error('Failed to render history:', err));
                });
            });
        } else {
            console.warn('History UI elements missing:', { btnHistory: !!btnHistory, sidebar: !!sidebar });
        }

        const btnLogs = documentRef.getElementById('btn-logs');
        if (btnLogs && logDrawer) {
            btnLogs.addEventListener('click', () => {
                panelManager.toggle('logs', () => {
                    btnLogs.classList.remove('has-new-error');
                    renderLogs();
                });
            });
        }

        documentRef.getElementById('btn-close-history')?.addEventListener('click', () => {
            sidebar?.classList.remove('active');
        });

        documentRef.getElementById('btn-clear-history')?.addEventListener('click', async () => {
            if (confirmRef('确定要清空所有历史记录吗？此操作无法撤销。')) {
                await clearHistory();
                renderHistoryList();
                showToast('历史记录已清空', 'info');
            }
        });

        documentRef.getElementById('btn-close-logs')?.addEventListener('click', () => {
            logDrawer?.classList.remove('active');
        });

        documentRef.getElementById('btn-col-decrease')?.addEventListener('click', () => {
            applyHistoryGridCols(state.historyGridCols - 1);
            saveState();
        });

        documentRef.getElementById('btn-col-increase')?.addEventListener('click', () => {
            applyHistoryGridCols(state.historyGridCols + 1);
            saveState();
        });

        documentRef.getElementById('btn-clear-logs')?.addEventListener('click', () => {
            state.logs = [];
            renderLogs();
            showToast('日志已清空', 'info');
        });

        documentRef.getElementById('btn-copy-error')?.addEventListener('click', () => {
            const title = documentRef.getElementById('error-modal-title').textContent;
            const msg = documentRef.getElementById('error-modal-msg').textContent;
            const detail = documentRef.getElementById('error-modal-detail').textContent;
            const suggestionItems = Array.from(documentRef.querySelectorAll('#error-modal-suggestions li'))
                .map((item) => `- ${item.textContent}`);
            const suggestionText = suggestionItems.length > 0
                ? `\n\n建议操作：\n${suggestionItems.join('\n')}`
                : '';
            const detailText = detail ? `\n\n技术详情：\n${detail}` : '';
            const fullText = `【${title}】\n${msg}${suggestionText}${detailText}`;
            copyToClipboard(fullText);
        });

        documentRef.getElementById('btn-history-batch')?.addEventListener('click', () => {
            state.historySelectionMode = true;
            state.selectedHistoryIds.clear();
            documentRef.getElementById('history-batch-toolbar').classList.remove('hidden');
            renderHistoryList();
        });

        documentRef.getElementById('btn-batch-select-all')?.addEventListener('click', async () => {
            const items = await getHistory();
            items.forEach((item) => state.selectedHistoryIds.add(item.id));
            renderHistoryList();
        });

        documentRef.getElementById('btn-batch-cancel')?.addEventListener('click', () => {
            state.historySelectionMode = false;
            state.selectedHistoryIds.clear();
            documentRef.getElementById('history-batch-toolbar').classList.add('hidden');
            renderHistoryList();
        });

        documentRef.getElementById('btn-batch-download')?.addEventListener('click', async () => {
            if (state.selectedHistoryIds.size === 0) {
                showToast('请先选择要下载的图片', 'warn');
                return;
            }

            const items = await getHistory();
            const selected = items.filter((item) => state.selectedHistoryIds.has(item.id));

            for (const item of selected) {
                downloadImage(item.image, `cainflow_${item.id}.png`);
                await new Promise((resolve) => setTimeout(resolve, 200));
            }

            showToast(`已开始下载 ${selected.length} 张图片`, 'success');
            state.historySelectionMode = false;
            state.selectedHistoryIds.clear();
            documentRef.getElementById('history-batch-toolbar').classList.add('hidden');
            renderHistoryList();
        });

        documentRef.getElementById('btn-batch-delete')?.addEventListener('click', async () => {
            if (state.selectedHistoryIds.size === 0) {
                showToast('请先选择要删除的记录', 'warn');
                return;
            }

            if (!confirmRef(`确定要删除选中的 ${state.selectedHistoryIds.size} 条记录吗？\n此操作无法撤销。`)) return;

            const idsToDelete = Array.from(state.selectedHistoryIds);
            await historyPreviewApi.deleteHistoryItems(idsToDelete);

            state.selectedHistoryIds.clear();
            state.historySelectionMode = false;
            documentRef.getElementById('history-batch-toolbar').classList.add('hidden');
            renderHistoryList();
            showToast(`已成功删除 ${idsToDelete.length} 条记录`, 'success');
        });

        btnExportConfig?.addEventListener('click', () => {
            exportConfig();
        });

        btnImportConfig?.addEventListener('click', () => {
            const confirmed = confirmRef('导入将覆盖当前 API 供应商、模型和通用设置，但不会影响画布节点与历史记录，确定继续吗？');
            if (!confirmed) return;

            if (inputConfigImport) {
                inputConfigImport.value = '';
                inputConfigImport.click();
            }
        });

        inputConfigImport?.addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            importConfig(file);
        });

        documentRef.getElementById('btn-factory-reset')?.addEventListener('click', () => {
            const confirmed = confirmRef('确定要恢复出厂设置吗？\n这将清空所有画布节点、API 配置和图片历史记录，且无法撤销。');
            if (confirmed) {
                localStorageRef.clear();
                const deleteRequest = indexedDbRef.deleteDatabase(dbName);

                deleteRequest.onsuccess = () => {
                    console.log('Database deleted successfully');
                    locationRef.reload();
                };

                deleteRequest.onerror = () => {
                    console.error('Error deleting database');
                    alertRef('数据库清理失败，请手动清除浏览器缓存。');
                    locationRef.reload();
                };

                deleteRequest.onblocked = () => {
                    console.warn('Delete blocked');
                    alertRef('数据库清理被阻塞，请关闭其他标签页后重试。');
                    locationRef.reload();
                };
            }
        });

        documentRef.getElementById('toggle-notifications')?.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            if (enabled && notificationRef && notificationRef.permission !== 'granted') {
                const permission = await notificationRef.requestPermission();
                if (permission !== 'granted') {
                    e.target.checked = false;
                    state.notificationsEnabled = false;
                    showToast('未开启通知权限，请在浏览器设置中手动允许此网站发送通知', 'warning', 5000);
                    saveState();
                    return;
                }
            }
            state.notificationsEnabled = enabled;

            if (!enabled && state.notificationAudio) {
                state.notificationAudio.pause();
                state.notificationAudio.src = '';
                state.notificationAudio = null;
            }

            saveState();
            if (enabled) showToast('运行完成通知已开启', 'success');
            else showToast('运行完成通知已关闭', 'info');
        });

        initFeatureModules();
    }

    function initCache() {
        const btnToggle = documentRef.getElementById('btn-toggle-cache');
        const cacheSidebar = documentRef.getElementById('cache-sidebar');
        const btnClose = documentRef.getElementById('btn-close-cache');
        const btnClear = documentRef.getElementById('btn-clear-cache');

        if (!btnToggle || !cacheSidebar) return;

        btnToggle.addEventListener('click', () => {
            panelManager.toggle('cache', () => {
                settingsControllerApi?.updateCacheUsage();
            });
        });

        btnClose?.addEventListener('click', () => {
            cacheSidebar.classList.remove('active');
            btnToggle.classList.remove('active');
        });

        btnClear?.addEventListener('click', async () => {
            if (!confirmRef('确定要清理所有历史记录吗？\n\n这将永久删除浏览器本地存储的历史生成图库，无法撤销。')) return;

            try {
                const db = await openDB();
                const tx = db.transaction(storeHistoryName, 'readwrite');
                await tx.objectStore(storeHistoryName).clear();

                showToast('历史生成记录已清空', 'success');
                settingsControllerApi?.updateCacheUsage();
                if (documentRef.getElementById('history-sidebar')?.classList.contains('active')) {
                    renderHistoryList();
                }
            } catch (e) {
                showToast('历史清理失败: ' + e.message, 'error');
            }
        });

        documentRef.getElementById('btn-clear-assets')?.addEventListener('click', async () => {
            if (!confirmRef('确定要清理所有节点资产吗？\n\n这会删除画布上当前正在显示的所有图片缓存。清理后刷新页面，图片将变成占位符！')) return;

            try {
                const db = await openDB();
                const tx = db.transaction(storeAssetsName, 'readwrite');
                await tx.objectStore(storeAssetsName).clear();

                showToast('当前画布资产已清理', 'success');
                settingsControllerApi?.updateCacheUsage();
            } catch (e) {
                showToast('资产清理失败: ' + e.message, 'error');
            }
        });
    }

    return {
        initUI,
        initCache
    };
}
