/**
 * 负责主界面各类面板与按钮的事件装配，是通用 UI 行为的集中控制器。
 */
import { getModelProviderIds, normalizeModelConfig, normalizeProviderType } from '../execution/provider-request-utils.js';
import { API_PROVIDERS_LOCKED, DEFAULT_PROVIDERS } from '../../core/constants.js';
const PROMPT_LIBRARY_STORAGE_KEY = 'cainflow_prompt_library';

export function createUiControllerApi({
    state,
    panelManager,
    settingsModal,
    dbName = 'NodeFlowDB',
    openDB,
    storeHistoryName,
    storeAssetsName,
    clearHistory,
    clearImageAssets = null,
    clearOrphanedHistoryAssets = null,
    getHistory,
    getHistoryMetadata = getHistory,
    getHistoryEntry = async (id) => (await getHistory()).find((item) => item.id === id) || null,
    renderHistoryList,
    renderLogs,
    historyPreviewApi,
    historyFullscreenApi,
    settingsControllerApi,
    logPanelApi = null,
    applyHistoryGridCols,
    applyTheme = () => {},
    applyGlobalAnimationSetting = () => {},
    applyCanvasUiSetting = () => {},
    updateAllConnections = () => {},
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
    systemNotificationApi = null,
    confirmRef = confirm,
    alertRef = alert
}) {
    const CONFIG_SECTION_KEYS = ['providers', 'models', 'settings', 'prompts'];
    const CONFIG_IMPORT_MODES = {
        replace: 'replace',
        append: 'append'
    };
    let pendingConfigImportFile = null;
    let configModalMode = 'export';

    function normalizeConfigSelection(raw = {}) {
        return {
            providers: raw.providers !== false,
            models: raw.models !== false,
            settings: raw.settings !== false
            ,prompts: raw.prompts !== false
        };
    }

    function hasAnySelectedConfigSection(selection) {
        return !!selection && CONFIG_SECTION_KEYS.some((key) => selection[key]);
    }

    function getConfigSelectionFromUi() {
        return normalizeConfigSelection({
            providers: documentRef.getElementById('config-export-providers')?.checked,
            models: documentRef.getElementById('config-export-models')?.checked,
            settings: documentRef.getElementById('config-export-settings')?.checked,
            prompts: documentRef.getElementById('config-export-prompts')?.checked
        });
    }

    function getConfigImportModeFromUi() {
        return documentRef.querySelector('input[name="config-import-mode"]:checked')?.value === CONFIG_IMPORT_MODES.append
            ? CONFIG_IMPORT_MODES.append
            : CONFIG_IMPORT_MODES.replace;
    }

    function getConfigModalTitle(mode) {
        return mode === 'import' ? '导入配置' : '导出配置';
    }

    function getConfigModalActionText(mode) {
        return mode === 'import' ? '选择文件并导入' : '立即导出';
    }

    function getConfigModalHint(mode) {
        return mode === 'import'
            ? '可选择只导入供应商、模型、通用设置或提示词库，也可任意组合。'
            : '可选择导出全部配置，或只导出供应商 / 模型 / 通用设置 / 提示词库中的任意组合。';
    }

    function getConfigModalFileHint(mode) {
        return mode === 'import'
            ? '导入时会按所选范围处理配置，支持替换或追加合并。'
            : '导出的 JSON 只会包含你勾选的数据块。';
    }

    function setConfigModalMode(mode) {
        configModalMode = mode;
        const title = documentRef.getElementById('config-modal-title');
        const actionBtn = documentRef.getElementById('config-modal-action');
        const hint = documentRef.getElementById('config-modal-hint');
        const fileHint = documentRef.getElementById('config-modal-file-hint');
        const importModeGroup = documentRef.getElementById('config-import-mode-group');
        const importModeReplace = documentRef.getElementById('config-import-mode-replace');
        const importModeAppend = documentRef.getElementById('config-import-mode-append');
        const fileInput = documentRef.getElementById('input-config-file');

        title.textContent = getConfigModalTitle(mode);
        actionBtn.textContent = getConfigModalActionText(mode);
        hint.textContent = getConfigModalHint(mode);
        fileHint.textContent = getConfigModalFileHint(mode);
        importModeGroup.classList.toggle('hidden', mode !== 'import');
        fileInput.value = '';

        if (mode === 'import') {
            importModeReplace.checked = true;
        } else {
            importModeReplace.checked = true;
            importModeAppend.checked = false;
        }
    }

    function openConfigModal(mode) {
        const modal = documentRef.getElementById('config-modal');
        if (!modal) return;
        setConfigModalMode(mode);
        modal.classList.remove('hidden');
    }

    function closeConfigModal() {
        documentRef.getElementById('config-modal')?.classList.add('hidden');
    }

    function mergeItemsById(currentItems = [], importedItems = []) {
        const merged = currentItems.map((item) => ({ ...item }));
        const indexById = new Map(merged.map((item, index) => [item.id, index]));

        importedItems.forEach((item) => {
            const existingIndex = indexById.get(item.id);
            if (existingIndex !== undefined) {
                merged[existingIndex] = { ...merged[existingIndex], ...item };
                return;
            }
            indexById.set(item.id, merged.length);
            merged.push({ ...item });
        });

        return merged;
    }

    function getStoredPromptLibrary() {
        try {
            const parsed = JSON.parse(localStorageRef.getItem(PROMPT_LIBRARY_STORAGE_KEY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    function setStoredPromptLibrary(prompts) {
        localStorageRef.setItem(PROMPT_LIBRARY_STORAGE_KEY, JSON.stringify(prompts));
    }

    function normalizePromptRecord(raw, index) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error(`第 ${index + 1} 条提示词不是有效对象`);
        }
        const content = typeof raw.content === 'string' ? raw.content : '';
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        if (!name && !content.trim()) {
            throw new Error(`第 ${index + 1} 条提示词缺少名称和内容`);
        }
        const now = new Date().toISOString();
        return {
            id: typeof raw.id === 'string' && raw.id ? raw.id : `prompt_${Date.now().toString(36)}_${index}`,
            name: name || '未命名提示词',
            content,
            createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now
        };
    }

    function normalizePromptLibrary(rawPrompts) {
        if (!Array.isArray(rawPrompts)) throw new Error('配置文件缺少 prompts 数组');
        return rawPrompts.map((item, index) => normalizePromptRecord(item, index));
    }

    function mergePromptsById(currentPrompts = [], importedPrompts = []) {
        return mergeItemsById(currentPrompts, importedPrompts);
    }

    function applyImportedSettings(settings) {
        if (!settings || typeof settings !== 'object') return;

        if (settings.themeId !== undefined || settings.themeMode !== undefined) {
            applyTheme(settings.themeId !== undefined ? settings.themeId : settings.themeMode);
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

        if (settings.concurrentRequestMode !== undefined) {
            state.concurrentRequestMode = !!settings.concurrentRequestMode;
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

        if (settings.connectionLineType !== undefined) {
            state.connectionLineType = settings.connectionLineType === 'orthogonal' ? 'orthogonal' : 'bezier';
            updateAllConnections();
        }

        if (settings.toolbarPinned !== undefined) {
            state.toolbarPinned = settings.toolbarPinned === true;
        }

        if (settings.sidebarPinned !== undefined) {
            state.sidebarPinned = settings.sidebarPinned === true;
        }

        applyCanvasUiSetting();

        if (settings.globalAnimationEnabled !== undefined || settings.connectionFlowAnimationEnabled !== undefined) {
            state.globalAnimationEnabled = settings.globalAnimationEnabled !== undefined
                ? settings.globalAnimationEnabled !== false
                : settings.connectionFlowAnimationEnabled !== false;
            state.connectionFlowAnimationEnabled = state.globalAnimationEnabled;
            applyGlobalAnimationSetting();
            updateAllConnections();
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

        if (settings.autoCheckUpdatesOnLoad !== undefined) {
            state.autoCheckUpdatesOnLoad = settings.autoCheckUpdatesOnLoad !== false;
        }

        if (settings.historyGridCols !== undefined) {
            applyHistoryGridCols(settings.historyGridCols);
        }

        settingsControllerApi?.renderGeneralSettings();
        settingsControllerApi?.syncProxyToServer();
    }

    function buildConfigPayload(selection = normalizeConfigSelection()) {
        const payload = {
            type: 'cainflow-config',
            version: '1.0',
            exportedAt: new Date().toISOString()
        };

        if (selection.providers) payload.providers = state.providers.map((provider) => ({ ...provider }));
        if (selection.models) payload.models = state.models.map((model) => ({ ...model }));
        if (selection.settings) {
            payload.settings = {
                themeId: state.themeId,
                notificationsEnabled: state.notificationsEnabled,
                notificationVolume: state.notificationVolume,
                autoRetry: state.autoRetry,
                maxRetries: state.maxRetries,
                concurrentRequestMode: state.concurrentRequestMode,
                imageAutoResizeEnabled: state.imageAutoResizeEnabled,
                imageMaxPixels: state.imageMaxPixels,
                connectionLineType: state.connectionLineType,
                toolbarPinned: state.toolbarPinned === true,
                sidebarPinned: state.sidebarPinned === true,
                globalAnimationEnabled: state.globalAnimationEnabled,
                connectionFlowAnimationEnabled: state.globalAnimationEnabled,
                proxy: state.proxy ? { ...state.proxy } : null,
                requestTimeoutEnabled: state.requestTimeoutEnabled,
                requestTimeoutSeconds: state.requestTimeoutSeconds,
                autoCheckUpdatesOnLoad: state.autoCheckUpdatesOnLoad !== false,
                historyGridCols: state.historyGridCols
            };
        }

        if (selection.prompts) {
            payload.promptLibrary = {
                storageKey: PROMPT_LIBRARY_STORAGE_KEY,
                prompts: getStoredPromptLibrary()
            };
        }

        return payload;
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

    function getLockedProviders(importedProviders = []) {
        const importedById = new Map((importedProviders || []).map((provider) => [provider.id, provider]));
        return DEFAULT_PROVIDERS.map((provider) => {
            const current = state.providers.find((candidate) => candidate.id === provider.id);
            const imported = importedById.get(provider.id);
            return {
                ...provider,
                name: current?.name || imported?.name || provider.name,
                apikey: current?.apikey || imported?.apikey || provider.apikey
            };
        });
    }

    function bindModelToAvailableProviders(model, providers) {
        const availableProviderIds = new Set((providers || []).map((provider) => provider.id));
        const providerIds = getModelProviderIds(model).filter((providerId) => availableProviderIds.has(providerId));
        const fallbackProviderId = providers?.[0]?.id || '';
        const nextProviderIds = providerIds.length > 0
            ? providerIds
            : (fallbackProviderId ? [fallbackProviderId] : []);
        return {
            ...model,
            providerIds: nextProviderIds,
            providerId: nextProviderIds[0] || ''
        };
    }

    function normalizeModels(models, providers) {
        if (!Array.isArray(models)) throw new Error('配置文件缺少 models 数组');

        const providersById = new Map((providers || []).map((provider) => [provider.id, provider]));
        return models
            .map((model, index) => normalizeModelConfig(model, index, providersById))
            .map((model) => API_PROVIDERS_LOCKED ? bindModelToAvailableProviders(model, providers) : model);
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

    function applyImportedConfig(configData, { selection, importMode } = {}) {
        if (!configData || typeof configData !== 'object') {
            throw new Error('配置文件格式无效');
        }

        const finalSelection = normalizeConfigSelection(selection);
        if (!hasAnySelectedConfigSection(finalSelection)) {
            throw new Error('请至少选择一个要导入的数据块');
        }

        const importedProvidersRaw = finalSelection.providers ? normalizeProviders(configData.providers) : [];
        const importedProviders = finalSelection.providers
            ? (API_PROVIDERS_LOCKED ? getLockedProviders(importedProvidersRaw) : importedProvidersRaw)
            : [];
        const nextProviders = finalSelection.providers
            ? (importMode === CONFIG_IMPORT_MODES.append
                ? mergeItemsById(state.providers, importedProviders)
                : importedProviders)
            : state.providers.map((provider) => ({ ...provider }));
        const importedModels = finalSelection.models
            ? normalizeModels(configData.models, finalSelection.providers && importMode === CONFIG_IMPORT_MODES.append ? nextProviders : state.providers)
            : [];
        const nextModels = finalSelection.models
            ? (importMode === CONFIG_IMPORT_MODES.append
                ? mergeItemsById(state.models, importedModels)
                : importedModels)
            : state.models.map((model) => ({ ...model }));
        const settings = finalSelection.settings && configData.settings && typeof configData.settings === 'object'
            ? configData.settings
            : {};
        const importedPromptLibrary = finalSelection.prompts
            ? normalizePromptLibrary(configData.promptLibrary?.prompts || configData.prompts || [])
            : [];

        if (finalSelection.providers) {
            ensureUniqueIds(importedProviders, '供应商配置');
        }
        if (finalSelection.models) {
            ensureUniqueIds(importedModels, '模型配置');
        }
        if (finalSelection.prompts) {
            ensureUniqueIds(importedPromptLibrary, '提示词预设');
        }

        if (finalSelection.models) {
            const providerIds = new Set(nextProviders.map((provider) => provider.id));
            const invalidModel = nextModels.find((model) => getModelProviderIds(model).some((providerId) => !providerIds.has(providerId)));
            if (invalidModel) {
                const invalidProviderId = getModelProviderIds(invalidModel).find((providerId) => !providerIds.has(providerId));
                throw new Error(`模型 ${invalidModel.name} 绑定了不存在的供应商：${invalidProviderId}`);
            }
        }

        if (finalSelection.providers) {
            state.providers = nextProviders;
        }
        if (finalSelection.models) {
            state.models = nextModels;
        }
        if (finalSelection.prompts) {
            const nextPrompts = importMode === CONFIG_IMPORT_MODES.append
                ? mergePromptsById(getStoredPromptLibrary(), importedPromptLibrary)
                : importedPromptLibrary;
            setStoredPromptLibrary(nextPrompts);
        }
        applyImportedSettings(settings);

        settingsControllerApi?.updateAllNodeModelDropdowns();
        settingsControllerApi?.renderProviders();
        settingsControllerApi?.renderModels();
        saveState();
    }

    function exportConfig(selection = normalizeConfigSelection()) {
        try {
            const payload = buildConfigPayload(selection);
            if (!hasAnySelectedConfigSection(selection)) {
                throw new Error('请至少选择一个要导出的数据块');
            }
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

    function importConfig(file, selection = normalizeConfigSelection(), importMode = CONFIG_IMPORT_MODES.replace) {
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                applyImportedConfig(data, { selection, importMode });
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
        panelManager.bindCanvasBlankClose?.();

        const btnHistory = documentRef.getElementById('btn-history');
        const sidebar = documentRef.getElementById('history-sidebar');
        const logDrawer = documentRef.getElementById('log-drawer');
        const btnImportConfig = documentRef.getElementById('btn-import-config');
        const btnExportConfig = documentRef.getElementById('btn-export-config');
        const inputConfigFile = documentRef.getElementById('input-config-file');

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

        documentRef.getElementById('btn-expand-history')?.addEventListener('click', () => {
            sidebar?.classList.remove('active');
            historyFullscreenApi?.open();
        });

        documentRef.getElementById('btn-clear-history')?.addEventListener('click', async () => {
            if (confirmRef('确定要清空所有历史记录吗？此操作无法撤销。')) {
                await clearHistory();
                renderHistoryList();
                historyFullscreenApi?.refresh();
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
            logPanelApi?.clearLogs?.();
            showToast('日志已清空', 'info');
        });

        documentRef.getElementById('log-retention-days')?.addEventListener('change', (e) => {
            const retentionDays = parseInt(e.target.value, 10);
            if (!Number.isNaN(retentionDays) && retentionDays >= 1) {
                logPanelApi?.setLogRetentionDays?.(retentionDays);
                showToast(`日志保留时长已更新为 ${retentionDays} 天`, 'success');
            }
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
            historyFullscreenApi?.refresh();
        });

        documentRef.getElementById('btn-batch-select-all')?.addEventListener('click', async () => {
            const items = await getHistoryMetadata();
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

            const items = await getHistoryMetadata();
            const selected = items.filter((item) => state.selectedHistoryIds.has(item.id));

            for (const item of selected) {
                const entry = await getHistoryEntry(item.id);
                if (entry?.image) downloadImage(entry.image, `cainflow_${entry.id}.png`);
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

        documentRef.getElementById('btn-close-config-modal')?.addEventListener('click', closeConfigModal);

        documentRef.getElementById('config-modal')?.addEventListener('click', (event) => {
            if (event.target?.id === 'config-modal') {
                closeConfigModal();
            }
        });

        btnExportConfig?.addEventListener('click', () => {
            openConfigModal('export');
        });

        btnImportConfig?.addEventListener('click', () => {
            openConfigModal('import');
        });

        documentRef.getElementById('config-modal-action')?.addEventListener('click', () => {
            const selection = getConfigSelectionFromUi();
            if (configModalMode === 'export') {
                exportConfig(selection);
                closeConfigModal();
                return;
            }

            if (!hasAnySelectedConfigSection(selection)) {
                showToast('请至少选择一个要导入的数据块', 'warn');
                return;
            }

            pendingConfigImportFile = { selection, importMode: getConfigImportModeFromUi() };
            inputConfigFile?.click();
        });

        inputConfigFile?.addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            if (!file || !pendingConfigImportFile) return;
            importConfig(file, pendingConfigImportFile.selection, pendingConfigImportFile.importMode);
            pendingConfigImportFile = null;
            closeConfigModal();
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
                    locationRef.reload();
                };
            }
        });

        documentRef.getElementById('toggle-notifications')?.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            const notificationApi = systemNotificationApi || {
                isSupported: () => !!notificationRef,
                getPermission: () => notificationRef?.permission || 'unsupported',
                requestPermission: () => notificationRef?.requestPermission?.() || 'unsupported',
                ensureReady: async () => true
            };
            if (enabled && !notificationApi.isSupported()) {
                e.target.checked = false;
                state.notificationsEnabled = false;
                showToast('当前浏览器环境不支持系统通知，无法开启运行通知', 'warning', 5000);
                saveState();
                return;
            }
            if (enabled && notificationApi.getPermission() !== 'granted') {
                let permission = notificationApi.getPermission();
                try {
                    permission = await notificationApi.requestPermission();
                } catch (err) {
                    console.warn('Notification permission request failed:', err);
                    permission = 'denied';
                }
                if (permission !== 'granted') {
                    e.target.checked = false;
                    state.notificationsEnabled = false;
                    showToast('未开启通知权限，请在浏览器设置中手动允许此网站发送通知', 'warning', 5000);
                    saveState();
                    return;
                }
            }
            state.notificationsEnabled = enabled;
            if (enabled) {
                await notificationApi.ensureReady?.();
            }

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

    function waitForTransaction(tx) {
        return new Promise((resolve) => {
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        });
    }

    function isHistoryAssetKey(key) {
        return typeof key === 'string' && key.startsWith('history:');
    }

    async function clearCurrentNodeAssetsOnly() {
        if (clearImageAssets) {
            const cleared = await clearImageAssets({ preserveHistory: true });
            if (!cleared) return false;
            if (clearOrphanedHistoryAssets) {
                await clearOrphanedHistoryAssets();
            }
            return true;
        }

        const db = await openDB();
        const tx = db.transaction(storeAssetsName, 'readwrite');
        const store = tx.objectStore(storeAssetsName);
        const req = store.openKeyCursor();
        req.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor) return;
            if (!isHistoryAssetKey(cursor.key)) store.delete(cursor.key);
            cursor.continue();
        };
        const cleared = await waitForTransaction(tx);
        if (!cleared) return false;
        if (clearOrphanedHistoryAssets) {
            await clearOrphanedHistoryAssets();
        }
        return true;
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
                const ok = await clearHistory();
                if (!ok) throw new Error('IndexedDB 历史清理未完成');

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
                const ok = await clearCurrentNodeAssetsOnly();
                if (!ok) throw new Error('IndexedDB 节点资产清理未完成');

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
