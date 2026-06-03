/**
 * 负责主界面各类面板与按钮的事件装配，是通用 UI 行为的集中控制器。
 */
import { getModelProviderIds, normalizeModelConfig, normalizeProviderType } from '../execution/provider-request-utils.js';
import {
    createConfigArchiveBlob,
    jsonEntry,
    readConfigArchive,
    readJsonEntry,
    readWorkflowEntries
} from '../settings/config-archive.js';
import {
    clearWorkflowFiles,
    fetchWorkflows,
    loadWorkflowFromFile,
    saveWorkflowToFile
} from '../../services/workflow-api.js';
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
    clearImageImportAssets = null,
    clearOrphanedHistoryAssets = null,
    clearOrphanedNodeAssets = null,
    collectRetainedNodeAssetIds = () => new Set(),
    refreshRecoverableMediaNodes = async () => {},
    getHistory,
    getHistoryMetadata = getHistory,
    getHistoryEntry = async (id) => (await getHistory()).find((item) => item.id === id) || null,
    renderHistoryList,
    renderLogs,
    historyPreviewApi,
    historyFullscreenApi,
    settingsControllerApi,
    logPanelApi = null,
    requestStatisticsApi = null,
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
    syncOpenWorkflowsBeforeConfigExport = () => {},
    onConfigWorkflowsImported = async () => {},
    applyWorkflowSidebarWidth = () => {},
    documentRef = document,
    localStorageRef = localStorage,
    indexedDbRef = indexedDB,
    locationRef = location,
    notificationRef = typeof Notification !== 'undefined' ? Notification : null,
    systemNotificationApi = null,
    confirmRef = confirm,
    alertRef = alert
}) {
    const CONFIG_SECTION_KEYS = ['providers', 'models', 'settings', 'prompts', 'workflows'];
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
            settings: raw.settings !== false,
            prompts: raw.prompts !== false,
            workflows: raw.workflows !== false
        };
    }

    function hasAnySelectedConfigSection(selection) {
        return !!selection && CONFIG_SECTION_KEYS.some((key) => selection[key]);
    }

    function hasAnySelectedConfigDataSection(selection) {
        return !!selection && CONFIG_SECTION_KEYS.some((key) => key !== 'workflows' && selection[key]);
    }

    function getConfigSelectionFromUi() {
        return normalizeConfigSelection({
            providers: documentRef.getElementById('config-export-providers')?.checked,
            models: documentRef.getElementById('config-export-models')?.checked,
            settings: documentRef.getElementById('config-export-settings')?.checked,
            prompts: documentRef.getElementById('config-export-prompts')?.checked,
            workflows: documentRef.getElementById('config-export-workflows')?.checked
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
            ? '可选择只导入供应商、模型、通用设置、提示词库或工作流数据，也可任意组合。'
            : '可选择导出全部配置，或只导出供应商 / 模型 / 通用设置 / 提示词库 / 工作流数据中的任意组合。';
    }

    function getConfigModalFileHint(mode) {
        return mode === 'import'
            ? '支持新版 ZIP 配置包，也兼容旧版 JSON 配置；导入时会按所选范围处理。'
            : '导出的 ZIP 会按数据类型分目录保存，包含 API 密钥时请妥善保管。';
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

    function getWindowRef() {
        return documentRef.defaultView || window;
    }

    function idbRequestToBoolean(request) {
        return new Promise((resolve) => {
            request.onsuccess = () => resolve(true);
            request.onerror = () => resolve(false);
            request.onblocked = () => resolve(false);
        });
    }

    async function unregisterServiceWorkersForOrigin() {
        const serviceWorker = getWindowRef().navigator?.serviceWorker;
        if (!serviceWorker?.getRegistrations) return true;
        try {
            const registrations = await serviceWorker.getRegistrations();
            const results = await Promise.all(registrations.map((registration) => registration.unregister()));
            return results.every(Boolean);
        } catch (error) {
            console.warn('Service Worker cleanup failed:', error);
            return false;
        }
    }

    async function clearCacheStorageForOrigin() {
        const cacheStorage = getWindowRef().caches;
        if (!cacheStorage?.keys || !cacheStorage?.delete) return true;
        try {
            const keys = await cacheStorage.keys();
            const results = await Promise.all(keys.map((key) => cacheStorage.delete(key)));
            return results.every(Boolean);
        } catch (error) {
            console.warn('Cache Storage cleanup failed:', error);
            return false;
        }
    }

    async function deleteIndexedDbDatabase(name) {
        if (!indexedDbRef?.deleteDatabase || !name) return true;
        try {
            return await idbRequestToBoolean(indexedDbRef.deleteDatabase(name));
        } catch (error) {
            console.warn('IndexedDB cleanup failed:', error);
            return false;
        }
    }

    async function deleteIndexedDbDatabasesForOrigin() {
        if (!indexedDbRef?.deleteDatabase) return true;
        try {
            if (typeof indexedDbRef.databases === 'function') {
                const databases = await indexedDbRef.databases();
                const names = Array.from(new Set(
                    (Array.isArray(databases) ? databases : [])
                        .map((database) => database?.name)
                        .filter(Boolean)
                ));
                if (names.length > 0) {
                    const results = await Promise.all(names.map((name) => deleteIndexedDbDatabase(name)));
                    return results.every(Boolean);
                }
            }
            return await deleteIndexedDbDatabase(dbName);
        } catch (error) {
            console.warn('IndexedDB database enumeration failed:', error);
            return await deleteIndexedDbDatabase(dbName);
        }
    }

    async function requestBrowserSiteDataClear() {
        const fetchRef = getWindowRef().fetch || fetch;
        if (!fetchRef) return true;
        try {
            await fetchRef('/api/site-data/clear', {
                method: 'POST',
                cache: 'no-store',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: '{}'
            });
            return true;
        } catch (error) {
            console.warn('Clear-Site-Data request failed:', error);
            return false;
        }
    }

    async function clearOriginStorageForFactoryReset() {
        const win = getWindowRef();
        const results = [];
        results.push(await unregisterServiceWorkersForOrigin());
        results.push(await clearCacheStorageForOrigin());
        try {
            win.sessionStorage?.clear?.();
        } catch (error) {
            console.warn('sessionStorage cleanup failed:', error);
            results.push(false);
        }
        try {
            localStorageRef.clear();
        } catch (error) {
            console.warn('localStorage cleanup failed:', error);
            results.push(false);
        }
        results.push(await deleteIndexedDbDatabasesForOrigin());
        results.push(await requestBrowserSiteDataClear());
        return results.every(Boolean);
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

        if (settings.imageSaveUsePromptFilename !== undefined) {
            state.imageSaveUsePromptFilename = settings.imageSaveUsePromptFilename === true;
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

        if (Array.isArray(settings.workflowOrder)) {
            state.workflowOrder = settings.workflowOrder.filter((name) => typeof name === 'string' && name);
        }

        if (Array.isArray(settings.workflowFolders)) {
            state.workflowFolders = settings.workflowFolders
                .map((folder) => ({
                    id: typeof folder?.id === 'string' ? folder.id : '',
                    name: typeof folder?.name === 'string' ? folder.name : '',
                    collapsed: folder?.collapsed === true,
                    items: Array.isArray(folder?.items) ? folder.items.filter((name) => typeof name === 'string' && name) : []
                }))
                .filter((folder) => folder.id && folder.name);
        }

        if (settings.workflowSidebarWidth !== undefined) {
            const workflowSidebarWidth = Number(settings.workflowSidebarWidth);
            if (Number.isFinite(workflowSidebarWidth) && workflowSidebarWidth > 0) {
                state.workflowSidebarWidth = Math.round(workflowSidebarWidth);
                applyWorkflowSidebarWidth(state.workflowSidebarWidth);
            }
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
                imageSaveUsePromptFilename: state.imageSaveUsePromptFilename === true,
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
                historyGridCols: state.historyGridCols,
                workflowOrder: Array.isArray(state.workflowOrder) ? state.workflowOrder.filter((name) => typeof name === 'string' && name) : [],
                workflowFolders: Array.isArray(state.workflowFolders)
                    ? state.workflowFolders
                        .map((folder) => ({
                            id: typeof folder?.id === 'string' ? folder.id : '',
                            name: typeof folder?.name === 'string' ? folder.name : '',
                            collapsed: folder?.collapsed === true,
                            items: Array.isArray(folder?.items) ? folder.items.filter((name) => typeof name === 'string' && name) : []
                        }))
                        .filter((folder) => folder.id && folder.name)
                    : [],
                workflowSidebarWidth: Number.isFinite(Number(state.workflowSidebarWidth)) && Number(state.workflowSidebarWidth) > 0
                    ? Math.round(Number(state.workflowSidebarWidth))
                    : 320
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

    function getSafeArchiveWorkflowFileName(name, fallbackIndex = 0) {
        const safeName = String(name || '')
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
            .replace(/^\.+$/, '')
            .trim();
        return safeName || `workflow_${fallbackIndex + 1}`;
    }

    function validateWorkflowImportName(name) {
        const value = String(name || '').trim();
        if (!value) throw new Error('工作流名称不能为空');
        if (value === '.' || value === '..' || /[\\/:*?"<>|]/.test(value)) {
            throw new Error(`工作流名称包含非法字符：${value}`);
        }
        return value;
    }

    async function collectWorkflowArchiveItems() {
        syncOpenWorkflowsBeforeConfigExport();
        const names = await fetchWorkflows();
        const workflowMap = new Map();
        for (const name of names) {
            const data = await loadWorkflowFromFile(name);
            if (data?.ok === false) throw new Error(data.message || `读取工作流失败：${name}`);
            workflowMap.set(name, { name, data });
        }
        (state.workflowTabs || []).forEach((tab) => {
            if (tab?.name && tab?.data && typeof tab.data === 'object') {
                workflowMap.set(tab.name, { name: tab.name, data: tab.data });
            }
        });
        return Array.from(workflowMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    async function buildConfigArchiveEntries(selection = normalizeConfigSelection()) {
        const exportedAt = new Date().toISOString();
        const entries = [];
        const includedSections = [];

        if (selection.providers) {
            includedSections.push('providers');
            entries.push(jsonEntry('providers/providers.json', state.providers.map((provider) => ({ ...provider }))));
        }
        if (selection.models) {
            includedSections.push('models');
            entries.push(jsonEntry('models/models.json', state.models.map((model) => ({ ...model }))));
        }
        if (selection.settings) {
            includedSections.push('settings');
            entries.push(jsonEntry('settings/settings.json', buildConfigPayload({ providers: false, models: false, settings: true, prompts: false, workflows: false }).settings || {}));
        }
        if (selection.prompts) {
            includedSections.push('prompts');
            entries.push(jsonEntry('prompts/prompt-library.json', {
                storageKey: PROMPT_LIBRARY_STORAGE_KEY,
                prompts: getStoredPromptLibrary()
            }));
        }
        if (selection.workflows) {
            includedSections.push('workflows');
            const workflows = await collectWorkflowArchiveItems();
            entries.push(jsonEntry('workflows/index.json', workflows.map((workflow, index) => ({
                name: workflow.name,
                file: `${getSafeArchiveWorkflowFileName(workflow.name, index)}.json`
            }))));
            workflows.forEach((workflow, index) => {
                entries.push(jsonEntry(`workflows/${getSafeArchiveWorkflowFileName(workflow.name, index)}.json`, workflow.data));
            });
        }

        entries.unshift(jsonEntry('manifest.json', {
            type: 'cainflow-config-archive',
            version: '2.0',
            exportedAt,
            includedSections,
            layout: {
                providers: 'providers/providers.json',
                models: 'models/models.json',
                settings: 'settings/settings.json',
                prompts: 'prompts/prompt-library.json',
                workflows: 'workflows/*.json'
            }
        }));

        return entries;
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
        const currentById = new Map((state.providers || []).map((provider) => [provider.id, provider]));
        const defaultProviderIds = new Set(DEFAULT_PROVIDERS.map((provider) => provider.id));
        const lockedDefaults = DEFAULT_PROVIDERS.map((provider) => {
            const current = state.providers.find((candidate) => candidate.id === provider.id);
            const imported = importedById.get(provider.id);
            return {
                ...provider,
                name: current?.name || imported?.name || provider.name,
                apikey: current?.apikey || imported?.apikey || provider.apikey
            };
        });
        const hiddenProviders = [
            ...Array.from(currentById.values()),
            ...Array.from(importedById.values())
        ].filter((provider) => provider && !defaultProviderIds.has(provider.id));
        return mergeItemsById(lockedDefaults, hiddenProviders);
    }

    function bindModelToAvailableProviders(model, providers) {
        const providerIds = getModelProviderIds(model);
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

        if (finalSelection.models && !API_PROVIDERS_LOCKED) {
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

    async function applyImportedWorkflows(workflows, importMode = CONFIG_IMPORT_MODES.replace) {
        if (!Array.isArray(workflows)) return 0;
        const validWorkflows = workflows
            .filter((workflow) => workflow?.name && workflow?.data && typeof workflow.data === 'object')
            .map((workflow) => ({
                name: validateWorkflowImportName(workflow.name),
                data: workflow.data
            }));
        if (validWorkflows.length === 0) return 0;

        if (importMode === CONFIG_IMPORT_MODES.replace) {
            const result = await clearWorkflowFiles();
            if (result !== true) throw new Error(result?.message || '清空工作流文件夹失败');
        }

        for (const workflow of validWorkflows) {
            const result = await saveWorkflowToFile(workflow.name, workflow.data);
            if (result !== true) throw new Error(result?.message || `保存工作流失败：${workflow.name}`);
        }

        await onConfigWorkflowsImported(validWorkflows, importMode);
        return validWorkflows.length;
    }

    function buildConfigDataFromArchiveEntries(entries) {
        const configData = { type: 'cainflow-config', version: '2.0' };
        const providers = readJsonEntry(entries, 'providers/providers.json');
        const models = readJsonEntry(entries, 'models/models.json');
        const settings = readJsonEntry(entries, 'settings/settings.json');
        const promptLibrary = readJsonEntry(entries, 'prompts/prompt-library.json');

        if (providers !== null) configData.providers = providers;
        if (models !== null) configData.models = models;
        if (settings !== null) configData.settings = settings;
        if (promptLibrary !== null) configData.promptLibrary = promptLibrary;

        return configData;
    }

    async function applyImportedConfigArchive(file, { selection, importMode } = {}) {
        const entries = await readConfigArchive(file);
        const finalSelection = normalizeConfigSelection(selection);
        const configData = buildConfigDataFromArchiveEntries(entries);
        const workflowItems = finalSelection.workflows ? readWorkflowEntries(entries) : [];
        const nonWorkflowSelection = {
            ...finalSelection,
            workflows: false
        };

        if (hasAnySelectedConfigDataSection(nonWorkflowSelection)) {
            applyImportedConfig(configData, {
                selection: nonWorkflowSelection,
                importMode
            });
        }

        const workflowCount = await applyImportedWorkflows(workflowItems, importMode);
        saveState();
        return { workflowCount };
    }

    async function exportConfig(selection = normalizeConfigSelection()) {
        try {
            if (!hasAnySelectedConfigSection(selection)) {
                throw new Error('请至少选择一个要导出的数据块');
            }
            const blob = createConfigArchiveBlob(await buildConfigArchiveEntries(selection));
            const url = URL.createObjectURL(blob);
            const link = documentRef.createElement('a');
            const time = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

            link.href = url;
            link.download = `CainFlow_Config_${time}.zip`;
            link.click();

            URL.revokeObjectURL(url);
            showToast('配置 ZIP 已导出，请妥善保管文件（包含 API 密钥）', 'success', 5000);
        } catch (error) {
            showToast('导出配置失败: ' + error.message, 'error');
        }
    }

    async function importConfig(file, selection = normalizeConfigSelection(), importMode = CONFIG_IMPORT_MODES.replace) {
        if (!file) return;

        const isZip = /\.zip$/i.test(file.name || '') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
        if (isZip) {
            try {
                const result = await applyImportedConfigArchive(file, { selection, importMode });
                const workflowText = result.workflowCount > 0 ? `，已导入 ${result.workflowCount} 个工作流` : '';
                showToast(`配置 ZIP 已导入并生效${workflowText}`, 'success', 5000);
            } catch (error) {
                showToast('导入配置失败: ' + error.message, 'error', 5000);
            }
            return;
        }

        if (selection.workflows && !hasAnySelectedConfigDataSection(selection)) {
            showToast('旧版 JSON 配置不包含工作流数据，请选择 CainFlow 配置 ZIP', 'warning', 5000);
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                applyImportedConfig(data, {
                    selection: {
                        ...selection,
                        workflows: false
                    },
                    importMode
                });
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
        const statisticsSidebar = documentRef.getElementById('statistics-sidebar');
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

        const btnStatistics = documentRef.getElementById('btn-toggle-statistics');
        if (btnStatistics && statisticsSidebar) {
            btnStatistics.addEventListener('click', () => {
                panelManager.toggle('statistics', () => {
                    const retentionSelect = documentRef.getElementById('statistics-retention-days');
                    if (retentionSelect && requestStatisticsApi?.getRetentionDays) {
                        retentionSelect.value = String(requestStatisticsApi.getRetentionDays());
                    }
                    requestStatisticsApi?.render?.();
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

        documentRef.getElementById('btn-close-statistics')?.addEventListener('click', () => {
            panelManager.close?.('statistics');
        });

        documentRef.getElementById('statistics-retention-days')?.addEventListener('change', (e) => {
            const retentionDays = parseInt(e.target.value, 10);
            if (!Number.isNaN(retentionDays) && retentionDays >= 1) {
                const nextDays = requestStatisticsApi?.setRetentionDays?.(retentionDays);
                if (nextDays) {
                    showToast(`统计信息保留时长已更新为 ${nextDays} 天`, 'success');
                }
            }
        });

        documentRef.getElementById('statistics-ranking-sort')?.addEventListener('change', (e) => {
            requestStatisticsApi?.setSortBy?.(e.target.value);
        });

        documentRef.getElementById('statistics-prev-day')?.addEventListener('click', () => {
            requestStatisticsApi?.shiftSelectedDay?.(-1);
        });

        documentRef.getElementById('statistics-next-day')?.addEventListener('click', () => {
            requestStatisticsApi?.shiftSelectedDay?.(1);
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

        documentRef.getElementById('config-modal-action')?.addEventListener('click', async () => {
            const selection = getConfigSelectionFromUi();
            if (configModalMode === 'export') {
                await exportConfig(selection);
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
            void importConfig(file, pendingConfigImportFile.selection, pendingConfigImportFile.importMode);
            pendingConfigImportFile = null;
            closeConfigModal();
        });

        documentRef.getElementById('btn-factory-reset')?.addEventListener('click', async () => {
            const confirmed = confirmRef('确定要恢复出厂设置吗？\n这将清空所有画布节点、API 配置、图片历史记录、浏览器缓存、IndexedDB、Cache Storage 和 Service Worker，且无法撤销。');
            if (!confirmed) return;

            try {
                const ok = await clearOriginStorageForFactoryReset();
                if (!ok) {
                    alertRef('已尽力清理本页面数据，但浏览器可能阻止了部分缓存清理。页面刷新后如仍异常，请在浏览器设置中手动清除此站点数据。');
                }
            } catch (error) {
                console.error('Factory reset failed:', error);
                alertRef('恢复出厂设置过程中出现错误，请在浏览器设置中手动清除此站点数据。');
            } finally {
                locationRef.reload();
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
        if (clearOrphanedNodeAssets) {
            await refreshRecoverableMediaNodes();
            const cleared = await clearOrphanedNodeAssets(collectRetainedNodeAssetIds());
            if (!cleared) return false;
            if (clearOrphanedHistoryAssets) await clearOrphanedHistoryAssets();
            return true;
        }

        const db = await openDB();
        const tx = db.transaction(storeAssetsName, 'readwrite');
        const store = tx.objectStore(storeAssetsName);
        const retainedNodeIds = collectRetainedNodeAssetIds();
        const req = store.openKeyCursor();
        req.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor) return;
            if (!isHistoryAssetKey(cursor.key) && !retainedNodeIds.has(String(cursor.key))) store.delete(cursor.key);
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
            if (!confirmRef('确定要清理可删除的节点缓存吗？\n\n这只会删除旧节点遗留资产和可由上游重新恢复的重复预览缓存，当前节点中的源图片和生成结果会被保留。')) return;

            try {
                const ok = await clearCurrentNodeAssetsOnly();
                if (!ok) throw new Error('IndexedDB 节点资产清理未完成');

                showToast('可删除节点缓存已清理，当前节点图片已保留', 'success');
                settingsControllerApi?.updateCacheUsage();
            } catch (e) {
                showToast('资产清理失败: ' + e.message, 'error');
            }
        });

        documentRef.getElementById('btn-clear-image-import-assets')?.addEventListener('click', async () => {
            if (!confirmRef('确定要清理所有图片导入节点缓存吗？\n\n已保存工作流中的图片导入节点可能无法再从本地缓存恢复图片。')) return;
            if (typeof clearImageImportAssets !== 'function') {
                showToast('当前环境不支持清理图片导入节点缓存', 'warning');
                return;
            }

            try {
                const ok = await clearImageImportAssets();
                if (!ok) throw new Error('IndexedDB 图片导入缓存清理未完成');
                showToast('图片导入节点缓存已清理', 'success');
                settingsControllerApi?.updateCacheUsage();
            } catch (e) {
                showToast('图片导入缓存清理失败: ' + e.message, 'error');
            }
        });
    }

    return {
        initUI,
        initCache
    };
}
