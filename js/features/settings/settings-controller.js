/**
 * 负责设置面板的数据渲染、保存、代理检测、模型管理与通用设置同步。
 */
import {
    getEffectiveProtocol,
    getImageResolutionOptionsForModel,
    getModelOptionLabel,
    getModelProviderIds,
    getModelsForTask,
    getResolvedProviderForModel,
    getResolvedProviderIdForModel,
    normalizeAutoCompleteBase,
    normalizeImageResolutionForModel,
    normalizeModelProtocol,
    normalizeModelTaskType,
    normalizeProviderType,
    resolveProviderUrl,
    validateOpenAiImageSize
} from '../execution/provider-request-utils.js';
import { createProxyHeadersGetter } from '../../services/api-client.js';
import { API_PROVIDERS_LOCKED, AUTO_UPDATE_CHECK_DISABLED } from '../../core/constants.js';

export function createSettingsControllerApi({
    appVersion,
    githubRepo,
    state,
    settingsModal,
    providersList,
    modelsList,
    storeHistoryName,
    storeAssetsName,
    openDB,
    saveHandle,
    showToast,
    saveState,
    addLog,
    checkUpdate,
    downloadLatestUpdate = () => {},
    cancelUpdateDownload = () => {},
    updateAllConnections = () => {},
    applyGlobalAnimationSetting = () => {},
    applyCanvasUiSetting = () => {},
    fitNodeToContent = () => {},
    floatingNoticesApi = null,
    documentRef = document,
    windowRef = window,
    localStorageRef = localStorage,
    fetchImpl = fetch
}) {
    const providerCollapseState = new Map();
    const modelCollapseState = new Map();
    const getProxyHeaders = createProxyHeadersGetter(() => state);
    const MODEL_FETCH_TIMEOUT_SECONDS = 30;
    const MODEL_FETCH_CLIENT_TIMEOUT_SECONDS = 35;
    localStorageRef.removeItem('cainflow_network_proxy_mismatch_dismissed');
    const modelFetchDialogState = {
        providerId: '',
        models: [],
        query: '',
        loading: false,
        error: '',
        status: ''
    };
    const networkProxyNoticeId = 'network-proxy-mismatch';
    const networkProxyDetectionCooldownMs = 10 * 60 * 1000;
    const networkProxyDetectionStorageKey = 'cainflow_network_proxy_detection';
    const networkProxyDetectionCacheVersion = 4;
    const NETWORK_PROBE_TARGETS = [
        { name: 'Google 204', url: 'https://www.google.com/generate_204' }
    ];
    const networkProxyDetectionTargetsSignature = JSON.stringify(
        NETWORK_PROBE_TARGETS.map((target) => ({
            name: String(target?.name || ''),
            url: String(target?.url || '')
        }))
    );
    const networkProxyStatusState = {
        checking: false,
        result: null
    };
    const HISTORY_ASSET_KEY_PREFIX = 'history:';
    let activeModelFetchRequestId = 0;
    let openModelProviderPanelId = '';

    function getEndpointHost(endpoint) {
        const raw = String(endpoint || '').trim();
        if (!raw) return '';
        try {
            const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
            return String(url.hostname || '').trim().toLowerCase().replace(/\.$/, '');
        } catch {
            return '';
        }
    }

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

    async function readResponseTextWithTimeout(response, timeoutSeconds = 30, timeoutMessage = '读取响应超时') {
        let timeoutId = null;
        try {
            return await Promise.race([
                response.text(),
                new Promise((_, reject) => {
                    timeoutId = windowRef.setTimeout(() => reject(new Error(timeoutMessage)), timeoutSeconds * 1000);
                })
            ]);
        } finally {
            if (timeoutId !== null) windowRef.clearTimeout(timeoutId);
        }
    }


    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getSafeProviderName(provider) {
        return String(provider?.name || '').trim() || '未命名供应商';
    }

    function is6789ApiEndpoint(endpoint) {
        const host = getEndpointHost(endpoint);
        return host === '6789api.top' || host.endsWith('.6789api.top');
    }

    function getModelFetchProtocol(provider) {
        if (is6789ApiEndpoint(provider?.endpoint)) return 'openai';
        if (isVectorEngineEndpoint(provider?.endpoint)) return 'openai';
        return normalizeProviderType(provider?.type, provider, 'openai') || 'openai';
    }

    function syncModelProviderBindings(model) {
        const providerIds = getModelProviderIds(model).filter((providerId) => (
            state.providers.some((provider) => provider.id === providerId)
        ));
        model.providerIds = providerIds;
        model.providerId = providerIds[0] || '';
        return providerIds;
    }

    function getModelBoundProviders(model) {
        return getModelProviderIds(model)
            .map((providerId) => state.providers.find((provider) => provider.id === providerId))
            .filter(Boolean);
    }

    function getResolvedModelProvider(model, preferredProviderId = '') {
        return getResolvedProviderForModel(model, state.providers, preferredProviderId);
    }

    function getResolvedModelProviderId(model, preferredProviderId = '') {
        return getResolvedProviderIdForModel(model, state.providers, preferredProviderId);
    }

    function getModelProviderSummary(model) {
        const providers = getModelBoundProviders(model);
        if (providers.length === 0) return '未绑定供应商';
        if (providers.length === 1) return providers[0].name || providers[0].id;
        const names = providers.slice(0, 2).map((provider) => provider.name || provider.id);
        if (providers.length === 2) return names.join('、');
        return `${names.join('、')} 等 ${providers.length} 个`;
    }

    function getProviderModelListUrl(provider, protocol) {
        const endpoint = String(provider?.endpoint || '').trim().replace(/\/+$/, '');
        if (!endpoint) return '';
        let base = normalizeAutoCompleteBase(endpoint, protocol).replace(/\/models\/?$/i, '');
        if (protocol === 'google') {
            const query = provider?.apikey ? `?key=${encodeURIComponent(provider.apikey)}` : '';
            return `${base}/v1beta/models${query}`;
        }
        if (!/\/v\d+(?:beta)?$/i.test(base)) {
            base = `${base}/v1`;
        }
        return `${base}/models`;
    }

    function isVectorEngineEndpoint(endpoint) {
        const host = getEndpointHost(endpoint);
        return host === 'vectorengine.ai' || host === 'api.vectorengine.ai' || host.endsWith('.vectorengine.ai');
    }

    function shouldFetchVectorEnginePricing(provider, protocol) {
        const fingerprint = `${provider?.endpoint || ''} ${provider?.name || ''}`.toLowerCase();
        return isVectorEngineEndpoint(provider?.endpoint) || fingerprint.includes('vectorengine');
    }

    function getOpenAiProviderBaseUrl(provider, protocol) {
        const endpoint = String(provider?.endpoint || '').trim().replace(/\/+$/, '');
        if (!endpoint) return '';
        let base = normalizeAutoCompleteBase(endpoint, protocol).replace(/\/models\/?$/i, '');
        base = base.replace(/\/v\d+(?:beta)?$/i, '');
        return base.replace(/\/+$/, '');
    }

    function getNewApiPricingUrl(provider, protocol) {
        const base = getOpenAiProviderBaseUrl(provider, protocol);
        return base ? `${base}/api/pricing` : '';
    }

    function normalizeFetchedModelId(rawId) {
        return String(rawId || '').replace(/^models\//, '').trim();
    }

    function inferFetchedModelTaskType(modelId, sourceModel = {}) {
        const tags = Array.isArray(sourceModel.tags) ? sourceModel.tags.join(' ') : '';
        const fingerprint = `${modelId} ${sourceModel.displayName || ''} ${sourceModel.name || ''} ${sourceModel.supplier || ''} ${tags}`.toLowerCase();
        if (
            fingerprint.includes('image') ||
            fingerprint.includes('banana') ||
            fingerprint.includes('dall-e') ||
            fingerprint.includes('gpt-image') ||
            fingerprint.includes('imagen') ||
            fingerprint.includes('绘画') ||
            fingerprint.includes('生图') ||
            fingerprint.includes('图像生成')
        ) {
            return 'image';
        }
        return 'chat';
    }

    function inferFetchedModelProtocol(provider, fetchedModel = {}) {
        const fingerprint = `${fetchedModel.id || ''} ${fetchedModel.name || ''}`.toLowerCase();
        const supportedEndpointTypes = Array.isArray(fetchedModel.raw?.supported_endpoint_types)
            ? fetchedModel.raw.supported_endpoint_types.map((type) => String(type || '').toLowerCase())
            : Array.isArray(fetchedModel.supported_endpoint_types)
                ? fetchedModel.supported_endpoint_types.map((type) => String(type || '').toLowerCase())
                : [];
        if (supportedEndpointTypes.length === 1) {
            if (supportedEndpointTypes[0] === 'gemini') return 'google';
            if (supportedEndpointTypes[0] === 'openai') return 'openai';
        }
        if (
            fingerprint.includes('gpt-') ||
            fingerprint.includes('gpt ') ||
            fingerprint.includes('dall-e') ||
            fingerprint.includes('openai') ||
            fingerprint.includes('o1-') ||
            fingerprint.includes('o3-') ||
            fingerprint.includes('o4-')
        ) {
            return 'openai';
        }
        if (fingerprint.includes('gemini')) return 'google';
        return getModelFetchProtocol(provider);
    }

    function normalizeFetchedModelName(modelId, sourceModel = {}) {
        return String(sourceModel.displayName || sourceModel.name || sourceModel.id || modelId || '').replace(/^models\//, '').trim() || modelId;
    }

    function parseNewApiPricingModels(payload) {
        const modelInfo = payload?.data?.model_info || payload?.model_info || null;
        if (!modelInfo || typeof modelInfo !== 'object' || Array.isArray(modelInfo)) return [];
        return Object.entries(modelInfo).map(([modelId, info]) => {
            const item = info && typeof info === 'object' && !Array.isArray(info)
                ? { ...info }
                : {};
            return {
                id: modelId,
                name: item.name || modelId,
                ...item,
                source: item.source || 'new-api-pricing'
            };
        });
    }

    function parseFetchedModels(payload, protocol) {
        const rawModels = protocol === 'google'
            ? (Array.isArray(payload?.models) ? payload.models : [])
            : (Array.isArray(payload?.data)
                ? payload.data
                : Array.isArray(payload?.models)
                    ? payload.models
                    : Array.isArray(payload)
                        ? payload
                        : []);

        const seen = new Set();
        return rawModels
            .map((item) => {
                const rawId = protocol === 'google' ? item?.name : (item?.id || item?.name);
                const modelId = normalizeFetchedModelId(rawId);
                if (!modelId || seen.has(modelId)) return null;
                seen.add(modelId);
                return {
                    id: modelId,
                    name: normalizeFetchedModelName(modelId, item),
                    taskType: inferFetchedModelTaskType(modelId, item),
                    raw: item
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    function mergeFetchedModels(...modelLists) {
        const seen = new Set();
        return modelLists
            .flat()
            .filter((model) => {
                const modelId = String(model?.id || '').trim();
                if (!modelId || seen.has(modelId)) return false;
                seen.add(modelId);
                return true;
            })
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    async function fetchProviderModelPayload(url, protocol, provider, timeoutMessage) {
        const response = await fetchWithTimeout('/api/provider_models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url,
                protocol,
                apikey: provider?.apikey || '',
                proxy: state.proxy || null
            })
        }, MODEL_FETCH_CLIENT_TIMEOUT_SECONDS, timeoutMessage);
        const responseText = await readResponseTextWithTimeout(
            response,
            MODEL_FETCH_CLIENT_TIMEOUT_SECONDS,
            `读取模型列表响应超时（${MODEL_FETCH_CLIENT_TIMEOUT_SECONDS} 秒）。供应商已经响应，但本地代理返回体没有正常结束，请重启 CainFlow 后重试`
        );
        if (!response.ok) {
            throw new Error(responseText || `请求失败 (${response.status})`);
        }
        try {
            return JSON.parse(responseText);
        } catch {
            throw new Error('供应商没有返回有效的 JSON 模型列表');
        }
    }

    async function fetchVectorEnginePricingModels(provider, protocol) {
        if (!shouldFetchVectorEnginePricing(provider, protocol)) return [];
        const pricingUrl = getNewApiPricingUrl(provider, 'openai');
        if (!pricingUrl) return [];
        const payload = await fetchProviderModelPayload(
            pricingUrl,
            'new-api-pricing',
            { ...provider, apikey: '' },
            `获取 VectorEngine 完整模型价格表超时（${MODEL_FETCH_CLIENT_TIMEOUT_SECONDS} 秒）。请检查供应商地址、代理设置或 /api/pricing 接口是否可用`
        );
        return parseFetchedModels(parseNewApiPricingModels(payload), 'openai');
    }

    function findMatchingModelConfig(modelId, protocol, taskType) {
        return state.models.find((model) => {
            const provider = getResolvedModelProvider(model);
            return model.modelId === modelId &&
                normalizeModelTaskType(model.taskType, model) === normalizeModelTaskType(taskType, model) &&
                normalizeModelProtocol(model.protocol, model, provider) === protocol;
        }) || null;
    }

    function modelAlreadyExists(providerId, modelId, protocol, taskType = '') {
        return state.models.some((model) => {
            if (model.modelId !== modelId) return false;
            if (!getModelProviderIds(model).includes(providerId)) return false;
            const provider = state.providers.find((candidate) => candidate.id === providerId) || getResolvedModelProvider(model);
            if (normalizeModelProtocol(model.protocol, model, provider) !== protocol) return false;
            return !taskType || normalizeModelTaskType(model.taskType, model) === normalizeModelTaskType(taskType, model);
        });
    }

    function addFetchedModel(provider, fetchedModel) {
        if (!provider || !fetchedModel) return;
        const protocol = inferFetchedModelProtocol(provider, fetchedModel);
        const taskType = normalizeModelTaskType(fetchedModel.taskType, fetchedModel);
        const existingModel = findMatchingModelConfig(fetchedModel.id, protocol, taskType);
        if (existingModel) {
            const providerIds = syncModelProviderBindings(existingModel);
            if (providerIds.includes(provider.id)) {
                showToast('该模型已在模型列表中', 'info');
                return;
            }
            existingModel.providerIds = [...providerIds, provider.id];
            existingModel.providerId = existingModel.providerIds[0] || '';
            renderModels();
            updateAllNodeModelDropdowns();
            saveState();
            renderProviderModelsDialog({ preserveListScroll: true });
            showToast(`已将供应商绑定到模型：${fetchedModel.id}`, 'success');
            return;
        }

        const newModelId = 'mod_' + Math.random().toString(36).substr(2, 9);
        state.models.push({
            id: newModelId,
            name: fetchedModel.name || fetchedModel.id,
            modelId: fetchedModel.id,
            providerIds: [provider.id],
            providerId: provider.id,
            taskType,
            protocol
        });
        modelCollapseState.set(newModelId, true);
        renderModels();
        updateAllNodeModelDropdowns();
        saveState();
        renderProviderModelsDialog({ preserveListScroll: true });
        showToast(`已添加模型：${fetchedModel.id}`, 'success');
    }

    function syncCollapseState(items, collapseState, defaultCollapsed = true) {
        const itemIds = new Set(items.map((item) => item.id));
        Array.from(collapseState.keys()).forEach((id) => {
            if (!itemIds.has(id)) collapseState.delete(id);
        });
        items.forEach((item) => {
            if (!collapseState.has(item.id)) {
                collapseState.set(item.id, defaultCollapsed);
            }
        });
    }

    function collapseAllConfigCards() {
        state.providers.forEach((provider) => {
            providerCollapseState.set(provider.id, true);
        });
        state.models.forEach((model) => {
            modelCollapseState.set(model.id, true);
        });
    }

    function isCardHeaderControlClick(event) {
        return !!event.target.closest('input, select, textarea, button, label, a');
    }

    function toggleConfigCard(collapseState, id, render) {
        collapseState.set(id, !(collapseState.get(id) !== false));
        render();
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
                            localStorageRef.removeItem(networkProxyDetectionStorageKey);
                            checkNetworkProxyMismatch(true);
                        }
                    }
                } catch (e) {
                    showToast('保存代理设置异常: ' + e, 'error');
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
                } catch (e) {
                    showToast('自动检测代理失败: ' + e, 'error');
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
                } catch (e) {
                    showToast('检测请求失败: ' + e, 'error');
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
        } catch (e) {
            console.error('Failed to init proxy modal', e);
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
            console.log('Restored proxy config from localStorage to server.');
        } catch (e) {
            console.error('Failed to sync proxy state to server on startup:', e);
        }
    }

    function getProviderEndpointPreview(endpoint, autoComplete, protocol = '') {
        const base = (endpoint || '').replace(/\/+$/, '');
        const normalizedBase = normalizeAutoCompleteBase(base, protocol);
        if (!base) return '请输入 API 地址';
        if (autoComplete === false) return `${base} (直接使用，不补全)`;
        return `${base} (作为基址；最终路径由模型兼容格式自动补全)`;
    }

    function getModelRequestPreview(model) {
        const provider = getResolvedModelProvider(model);
        if (!provider) return '请先绑定供应商';

        const base = (provider.endpoint || '').replace(/\/+$/, '');
        if (!base) return '请先填写供应商 API 地址';
        if (provider.autoComplete === false) return `${base} (直接使用，不补全)`;

        return resolveProviderUrl(
            {
                ...provider,
                apikey: '***'
            },
            {
                ...model,
                modelId: model.modelId || '{妯″瀷ID}'
            },
            normalizeModelTaskType(model.taskType, model)
        );

        const protocol = getEffectiveProtocol(model, provider);
        const taskType = normalizeModelTaskType(model.taskType, model);
        if (protocol === 'google') {
            return `${base}/v1beta/models/${model.modelId || '{模型ID}'}:generateContent?key=***`;
        }

        return taskType === 'image'
            ? `${base}/images/generations`
            : `${base}/chat/completions`;
    }

    function getModelProtocolHelp(model) {
        const provider = getResolvedModelProvider(model);
        const protocol = getEffectiveProtocol(model, provider);
        if (protocol === 'google') {
            return 'Google / Gemini 格式会走 generateContent，请求体按 Gemini 协议构造。';
        }
        return 'OpenAI 兼容格式会按模型用途，分别走 /chat/completions 或 /images/generations；生图节点有参考图输入时自动改走 /images/edits。';
    }

    function getProviderModelsDialog() {
        let dialog = documentRef.getElementById('provider-models-dialog');
        if (dialog) return dialog;

        dialog = documentRef.createElement('div');
        dialog.id = 'provider-models-dialog';
        dialog.className = 'provider-models-dialog hidden';
        (documentRef.body || settingsModal).appendChild(dialog);
        return dialog;
    }

    function closeProviderModelsDialog() {
        const dialog = getProviderModelsDialog();
        dialog.classList.add('hidden');
        modelFetchDialogState.providerId = '';
        modelFetchDialogState.models = [];
        modelFetchDialogState.query = '';
        modelFetchDialogState.loading = false;
        modelFetchDialogState.error = '';
        modelFetchDialogState.status = '';
    }

    function getApiSettingsHelpDialog() {
        let dialog = documentRef.getElementById('api-settings-help-dialog');
        if (dialog) return dialog;

        dialog = documentRef.createElement('div');
        dialog.id = 'api-settings-help-dialog';
        dialog.className = 'api-settings-help-dialog hidden';
        (documentRef.body || settingsModal).appendChild(dialog);
        return dialog;
    }

    function closeApiSettingsHelpDialog() {
        getApiSettingsHelpDialog().classList.add('hidden');
    }

    function getNetworkProxyHintDialog() {
        let dialog = documentRef.getElementById('network-proxy-hint-dialog');
        if (dialog) return dialog;

        dialog = documentRef.createElement('div');
        dialog.id = 'network-proxy-hint-dialog';
        dialog.className = 'api-settings-help-dialog hidden';
        (documentRef.body || settingsModal).appendChild(dialog);
        return dialog;
    }

    function closeNetworkProxyHintDialog() {
        getNetworkProxyHintDialog().classList.add('hidden');
    }

    function openSettingsProxyTab() {
        const settingsModalApi = windowRef.__cainflowSettingsModalApi;
        settingsModalApi?.openSettingsModal();
        const targetBtn = documentRef.querySelector('.modal-tab-btn[data-tab="proxy"]');
        targetBtn?.click();
    }

    function getNetworkProxyAttemptSummary(attempts = []) {
        if (!Array.isArray(attempts) || attempts.length === 0) return '';
        return attempts.map((attempt) => {
            const label = String(attempt?.name || attempt?.url || '检测目标').trim();
            if (attempt?.success) {
                const latencyText = Number.isFinite(attempt?.latency) && attempt.latency > 0 ? `，${attempt.latency}ms` : '';
                return `• ${label}：可访问${latencyText}`;
            }
            return `• ${label}：${attempt?.detail || '访问失败'}`;
        }).join('<br>');
    }

    function renderNetworkProxyHintDialog() {
        const dialog = getNetworkProxyHintDialog();
        const result = networkProxyStatusState.result || {};
        const checkedTarget = result.checkedTarget || '国外站点';
        const latencyText = Number.isFinite(result.latency) && result.latency > 0 ? `${result.latency}ms` : '未知';
        const attemptsSummary = getNetworkProxyAttemptSummary(result.attempts);
        const effectiveModeText = result.effectiveMode === 'proxy' ? '代理' : '直连';

        dialog.innerHTML = `
            <div class="api-settings-help-backdrop" data-close-network-proxy-hint="true"></div>
            <div class="api-settings-help-panel network-proxy-hint-panel" role="dialog" aria-modal="true" aria-labelledby="network-proxy-hint-title">
                <div class="api-settings-help-header">
                    <div>
                        <h3 id="network-proxy-hint-title">网络设置提醒</h3>
                        <div class="api-settings-help-subtitle">当前检测结果显示，请求链路和设置中的代理开关状态可能并不一致。</div>
                    </div>
                    <button type="button" class="api-settings-help-close" data-close-network-proxy-hint="true" title="关闭">×</button>
                </div>
                <div class="api-settings-help-body">
                    <section class="api-settings-help-section">
                        <h4>详细说明</h4>
                        <p>当前检测到后端发出的请求是走的代理，但是设置中的代理选项没有打开。你可能是开启了代理软件的 <code>TUN</code> 模式或者虚拟网卡模式，或者配置了软路由，也可能是其他原因导致的请求走了代理。</p>
                        <p>此时向 API 供应商发出的请求，可能会被代理软件判定为需要走代理，从而导致链接不稳定。有些国内中转站会更容易出现这种情况。</p>
                        <p>建议关闭 <code>TUN</code> 模式，或者在代理软件中添加规则解决此问题。</p>
                    </section>
                    ${attemptsSummary ? `
                    <section class="api-settings-help-section">
                        <h4>本次检测目标</h4>
                        <p>${attemptsSummary}</p>
                    </section>` : ''}
                </div>
                <div class="modal-footer network-proxy-hint-footer">
                    <button type="button" class="btn btn-secondary" data-close-network-proxy-hint="true">我知道了</button>
                    <button type="button" class="btn btn-primary" id="btn-open-proxy-settings-from-hint">打开代理设置</button>
                </div>
            </div>
        `;

        dialog.classList.remove('hidden');
        dialog.querySelectorAll('[data-close-network-proxy-hint="true"]').forEach((element) => {
            element.addEventListener('click', closeNetworkProxyHintDialog);
        });
        dialog.querySelector('#btn-open-proxy-settings-from-hint')?.addEventListener('click', () => {
            closeNetworkProxyHintDialog();
            openSettingsProxyTab();
        });
    }

    function hideNetworkProxyMismatchNotice() {
        floatingNoticesApi?.hideNotice(networkProxyNoticeId);
    }

    function showNetworkProxyMismatchNotice(result) {
        if (!floatingNoticesApi) return;
        const checkedTarget = result?.checkedTarget || '国外网络';
        floatingNoticesApi.upsertNotice({
            id: networkProxyNoticeId,
            priority: 25,
            className: 'update-canvas-notice network-proxy-notice',
            role: 'alert',
            icon: '!',
            clickable: true,
            onClick: () => renderNetworkProxyHintDialog(),
            title: ['请注意网络设置'],
            meta: ['检测到当前会以 ', { tag: 'span', text: result?.effectiveMode === 'proxy' ? '代理' : '直连' }, ' 模式访问 ', { tag: 'span', text: checkedTarget }, '。这条链路和真实 API 请求一致。点击查看说明。'],
            actions: [
                {
                    id: 'btn-network-proxy-hint-details',
                    label: '查看说明',
                    onClick: () => renderNetworkProxyHintDialog()
                },
                {
                    id: 'btn-network-proxy-open-settings',
                    label: '代理设置',
                    onClick: () => openSettingsProxyTab()
                }
            ],
            dismissible: true,
            closeLabel: '关闭网络设置提醒'
        });
    }

    function saveNetworkProxyDetectionCache(result) {
        try {
            localStorageRef.setItem(networkProxyDetectionStorageKey, JSON.stringify({
                version: networkProxyDetectionCacheVersion,
                targetsSignature: networkProxyDetectionTargetsSignature,
                checkedAt: Date.now(),
                result
            }));
        } catch {
            // ignore
        }
    }

    function readNetworkProxyDetectionCache() {
        try {
            const parsed = JSON.parse(localStorageRef.getItem(networkProxyDetectionStorageKey) || 'null');
            if (!parsed || typeof parsed !== 'object') return null;
            if (Number(parsed.version) !== networkProxyDetectionCacheVersion) return null;
            if (String(parsed.targetsSignature || '') !== networkProxyDetectionTargetsSignature) return null;
            const checkedAt = Number(parsed.checkedAt);
            if (!Number.isFinite(checkedAt)) return null;
            if (Date.now() - checkedAt > networkProxyDetectionCooldownMs) return null;
            const result = parsed.result || null;
            const attempts = Array.isArray(result?.attempts) ? result.attempts : [];
            const hasLegacyGithubTarget = attempts.some((attempt) => {
                const name = String(attempt?.name || '').toLowerCase();
                const url = String(attempt?.url || '').toLowerCase();
                return name.includes('github') || url.includes('api.github.com');
            });
            if (hasLegacyGithubTarget) return null;
            return result;
        } catch {
            return null;
        }
    }

    function isReachableProbeStatus(status) {
        const code = Number(status);
        if (!Number.isFinite(code) || code <= 0) return false;
        return code < 500;
    }

    async function probeNetworkTarget(target) {
        const startedAt = Date.now();
        try {
            const probeUrl = `${target.url}${target.url.includes('?') ? '&' : '?'}_cf_network_probe=${Date.now()}`;
            const response = await fetchWithTimeout('/proxy', {
                method: 'POST',
                headers: getProxyHeaders(probeUrl, 'GET', {
                    Accept: '*/*',
                    'Content-Type': null,
                    'Cache-Control': 'no-cache',
                    Pragma: 'no-cache'
                })
            }, 12, '网络探测超时');

            const latency = Math.max(0, Date.now() - startedAt);
            const reachable = isReachableProbeStatus(response.status);
            return {
                name: target.name,
                url: target.url,
                success: reachable,
                status: response.status,
                latency,
                detail: reachable
                    ? `请求成功返回 HTTP ${response.status}`
                    : `请求失败，HTTP ${response.status}`
            };
        } catch (error) {
            return {
                name: target.name,
                url: target.url,
                success: false,
                status: 0,
                latency: Math.max(0, Date.now() - startedAt),
                detail: error?.message || String(error)
            };
        }
    }

    async function checkNetworkProxyMismatch(force = false) {
        if (state.proxy?.enabled) {
            networkProxyStatusState.result = null;
            hideNetworkProxyMismatchNotice();
            return null;
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
            return cachedResult;
        }

        networkProxyStatusState.checking = true;
        try {
            const attempts = [];
            let reachableAttempt = null;

            for (const target of NETWORK_PROBE_TARGETS) {
                const attempt = await probeNetworkTarget(target);
                attempts.push(attempt);
                if (attempt.success && !reachableAttempt) {
                    reachableAttempt = attempt;
                    break;
                }
            }

            const result = {
                proxyEnabled: false,
                effectiveMode: 'direct',
                reachable: !!reachableAttempt,
                latency: reachableAttempt?.latency || 0,
                checkedTarget: reachableAttempt?.name || '',
                detail: reachableAttempt?.detail || (attempts[0]?.detail || '网络探测失败'),
                attempts,
                shouldNotify: !!reachableAttempt
            };
            networkProxyStatusState.result = result;
            saveNetworkProxyDetectionCache(result);
            if (result?.shouldNotify) {
                showNetworkProxyMismatchNotice(result);
            } else {
                hideNetworkProxyMismatchNotice();
            }
            return result;
        } catch (error) {
            console.error('Failed to detect network proxy mismatch', error);
            return null;
        } finally {
            networkProxyStatusState.checking = false;
        }
    }

    function renderApiSettingsHelpDialog() {
        const dialog = getApiSettingsHelpDialog();
        dialog.innerHTML = `
            <div class="api-settings-help-backdrop" data-close-api-help="true"></div>
            <div class="api-settings-help-panel" role="dialog" aria-modal="true" aria-labelledby="api-settings-help-title">
                <div class="api-settings-help-header">
                    <div>
                        <h3 id="api-settings-help-title">API 设置帮助</h3>
                        <div class="api-settings-help-subtitle">从密钥到模型，按这几步填就能跑起来。</div>
                    </div>
                    <button type="button" class="api-settings-help-close" data-close-api-help="true" title="关闭">×</button>
                </div>
                <div class="api-settings-help-body">
                    <section class="api-settings-help-section">
                        <h4>1. 创建或复制 API 密钥</h4>
                        <p>先到你的模型服务商控制台创建 API Key。常见位置是“API Keys”“开发者”“密钥管理”或“令牌”。复制后粘贴到 CainFlow 的“API 密钥”输入框。</p>
                        <p>不要发给他人，也不要写进工作流文件或截图里。</p>
                    </section>
                    <section class="api-settings-help-section">
                        <h4>2. 设置 API 供应商</h4>
                        <ul>
                            <li><strong>供应商名称：</strong>随便起一个好认的名字，例如 Gemini、OpenAI、公司网关。</li>
                            <li><strong>API 密钥：</strong>填写服务商给你的 Key。如果使用本地接口且不需要密钥，可以留空。</li>
                            <li><strong>API 地址：</strong>填写服务商的基础地址，例如 <code>https://api.openai.com</code> 或 <code>https://generativelanguage.googleapis.com</code>。</li>
                            <li><strong>自动补全：</strong>推荐开启。CainFlow 会按模型协议自动补齐 <code>/v1/chat/completions</code>、Gemini 路径或生图路径。</li>
                        </ul>
                    </section>
                    <section class="api-settings-help-section">
                        <h4>3. 添加模型并绑定供应商</h4>
                        <p>供应商保存后，可以点击“获取模型列表”自动拉取，也可以在“模型管理”里手动添加模型 ID。模型需要绑定到可用供应商，节点里的模型下拉才会出现。</p>
                        <ul>
                            <li>对话模型选择“对话”，用于 TextChat 等文本生成节点。</li>
                            <li>图片模型选择“生图”，用于 ImageGenerate 等图片生成节点。</li>
                            <li>OpenAI 兼容服务通常选 OpenAI 协议；Gemini 官方接口选 Gemini / Google 协议。</li>
                        </ul>
                    </section>
                    <section class="api-settings-help-section">
                        <h4>4. 常见问题</h4>
                        <ul>
                            <li>请求失败或超时：检查 API 地址、密钥、代理设置，以及供应商后台余额或权限。</li>
                            <li>本地或局域网接口无法访问：到“常规设置 > 安全”开启“允许内网 / 本地 API 地址”。</li>
                            <li>节点找不到模型：确认模型已经添加，并且绑定了当前存在的供应商。</li>
                        </ul>
                    </section>
                </div>
            </div>
        `;
        dialog.classList.remove('hidden');
        dialog.querySelectorAll('[data-close-api-help="true"]').forEach((element) => {
            element.addEventListener('click', closeApiSettingsHelpDialog);
        });
    }

    function renderProviderModelsDialog(options = {}) {
        const dialog = getProviderModelsDialog();
        const previousListScrollTop = options.preserveListScroll
            ? dialog.querySelector('.provider-models-list')?.scrollTop || 0
            : 0;
        const provider = state.providers.find((candidate) => candidate.id === modelFetchDialogState.providerId);
        if (!provider) {
            dialog.classList.add('hidden');
            return;
        }

        const providerProtocol = getModelFetchProtocol(provider);
        const query = modelFetchDialogState.query.trim().toLowerCase();
        const filteredModels = query
            ? modelFetchDialogState.models.filter((model) => (
                model.id.toLowerCase().includes(query) ||
                model.name.toLowerCase().includes(query)
            ))
            : modelFetchDialogState.models;
        const totalCount = modelFetchDialogState.models.length;
        const visibleCount = filteredModels.length;
        const countText = modelFetchDialogState.loading
            ? (totalCount ? `已获取 ${totalCount} 个模型` : (modelFetchDialogState.status || '正在获取模型列表...'))
            : query
                ? `匹配 ${visibleCount} 个 / 共 ${totalCount} 个模型`
                : `共获取 ${totalCount} 个模型`;
        const modelRows = filteredModels.map((model) => {
            const modelProtocol = inferFetchedModelProtocol(provider, model);
            const exists = modelAlreadyExists(provider.id, model.id, modelProtocol);
            return `
                <div class="provider-models-row">
                    <div class="provider-models-row-main">
                        <div class="provider-models-row-name">${escapeHtml(model.name)}</div>
                        <div class="provider-models-row-id">${escapeHtml(model.id)}</div>
                    </div>
                    <span class="provider-models-badge">${model.taskType === 'image' ? '生图' : '对话'} · ${modelProtocol === 'openai' ? 'OpenAI' : 'Gemini'}</span>
                    <button type="button" class="provider-models-add" data-model-id="${escapeHtml(model.id)}" ${exists ? 'disabled' : ''} title="${exists ? '模型已添加' : '添加到模型列表'}">${exists ? '已添加' : '+'}</button>
                </div>
            `;
        }).join('');

        const emptyText = modelFetchDialogState.loading
            ? (modelFetchDialogState.status || '正在获取模型列表...')
            : modelFetchDialogState.error
                ? modelFetchDialogState.error
                : query
                    ? '没有匹配的模型'
                    : '暂无可显示的模型';

        dialog.innerHTML = `
            <div class="provider-models-backdrop" data-close-models="true"></div>
            <div class="provider-models-panel" role="dialog" aria-modal="true" aria-labelledby="provider-models-title">
                <div class="provider-models-header">
                    <div>
                        <h3 id="provider-models-title">获取模型列表</h3>
                        <div class="provider-models-subtitle">${escapeHtml(getSafeProviderName(provider))} · ${providerProtocol === 'google' ? 'Google / Gemini' : 'OpenAI 兼容'}</div>
                    </div>
                    <button type="button" class="provider-models-close" data-close-models="true" title="关闭">×</button>
                </div>
                <div class="provider-models-search-row">
                    <input id="provider-models-search" type="search" value="${escapeHtml(modelFetchDialogState.query)}" placeholder="搜索模型 ID 或名称" autocomplete="off" />
                    <button type="button" class="btn btn-secondary btn-sm" id="provider-models-refresh" ${modelFetchDialogState.loading ? 'disabled' : ''}>重新获取</button>
                </div>
                <div class="provider-models-count">${escapeHtml(countText)}</div>
                <div class="provider-models-list">
                    ${modelRows || `<div class="provider-models-empty">${escapeHtml(emptyText)}</div>`}
                </div>
            </div>
        `;
        dialog.classList.remove('hidden');

        dialog.querySelectorAll('[data-close-models="true"]').forEach((element) => {
            element.addEventListener('click', closeProviderModelsDialog);
        });
        dialog.querySelector('#provider-models-refresh')?.addEventListener('click', () => {
            fetchProviderModels(provider.id);
        });
        dialog.querySelector('#provider-models-search')?.addEventListener('input', (event) => {
            modelFetchDialogState.query = event.target.value;
            renderProviderModelsDialog({ keepSearchFocus: true });
        });
        dialog.querySelectorAll('.provider-models-add').forEach((button) => {
            button.addEventListener('click', (event) => {
                const modelId = event.currentTarget.dataset.modelId;
                const fetchedModel = modelFetchDialogState.models.find((model) => model.id === modelId);
                addFetchedModel(provider, fetchedModel);
            });
        });

        if (options.keepSearchFocus) {
            const searchInput = dialog.querySelector('#provider-models-search');
            searchInput?.focus();
            searchInput?.setSelectionRange(searchInput.value.length, searchInput.value.length);
        }
        if (options.preserveListScroll) {
            const list = dialog.querySelector('.provider-models-list');
            if (list) list.scrollTop = previousListScrollTop;
        }
    }

    async function fetchProviderModels(providerId) {
        const provider = state.providers.find((candidate) => candidate.id === providerId);
        if (!provider) return;

        const requestId = activeModelFetchRequestId + 1;
        activeModelFetchRequestId = requestId;
        const protocol = getModelFetchProtocol(provider);
        const url = getProviderModelListUrl(provider, protocol);
        modelFetchDialogState.providerId = providerId;
        modelFetchDialogState.models = [];
        modelFetchDialogState.error = '';
        modelFetchDialogState.status = '正在准备模型列表请求...';
        modelFetchDialogState.loading = true;
        renderProviderModelsDialog();
        showToast(`正在获取 ${getSafeProviderName(provider)} 的模型列表...`, 'info', 4000);

        try {
            if (!url) throw new Error('请先填写供应商 API 地址');
            if (!provider.apikey && protocol === 'google') throw new Error('请先填写供应商 API 密钥');


            modelFetchDialogState.status = '正在请求供应商模型列表...';
            renderProviderModelsDialog();
            let primaryModels = [];
            let primaryError = null;
            try {
                const payload = await fetchProviderModelPayload(
                    url,
                    protocol,
                    provider,
                    `获取模型列表超时（${MODEL_FETCH_CLIENT_TIMEOUT_SECONDS} 秒）。请检查供应商地址、密钥、代理设置或该供应商的 /models 接口是否可用`
                );
                if (requestId !== activeModelFetchRequestId || modelFetchDialogState.providerId !== providerId) return;
                modelFetchDialogState.status = '正在解析供应商返回...';
                renderProviderModelsDialog();
                primaryModels = parseFetchedModels(payload, protocol);
            } catch (error) {
                primaryError = error;
            }

            if (requestId !== activeModelFetchRequestId || modelFetchDialogState.providerId !== providerId) return;
            const extraStatus = primaryModels.length
                ? '正在补充 VectorEngine 完整模型列表...'
                : '正在尝试从 VectorEngine 完整模型表兜底...';
            const shouldFetchPricing = shouldFetchVectorEnginePricing(provider, protocol);
            if (shouldFetchPricing) {
                modelFetchDialogState.status = extraStatus;
                renderProviderModelsDialog();
            }
            const pricingModels = shouldFetchPricing
                ? await fetchVectorEnginePricingModels(provider, protocol)
                : [];
            const models = mergeFetchedModels(primaryModels, pricingModels);
            if (!models.length && primaryError) throw primaryError;
            if (requestId !== activeModelFetchRequestId || modelFetchDialogState.providerId !== providerId) return;
            modelFetchDialogState.models = models;
            modelFetchDialogState.error = models.length ? '' : '供应商返回的模型列表为空';
            modelFetchDialogState.status = '';
            modelFetchDialogState.loading = false;
            renderProviderModelsDialog();
            showToast(`已获取 ${models.length} 个模型`, models.length ? 'success' : 'info');
        } catch (error) {
            if (requestId !== activeModelFetchRequestId || modelFetchDialogState.providerId !== providerId) return;
            const message = error?.message || String(error);
            modelFetchDialogState.error = `获取失败：${message}`;
            modelFetchDialogState.models = [];
            modelFetchDialogState.status = '';
            modelFetchDialogState.loading = false;
            renderProviderModelsDialog();
            showToast(modelFetchDialogState.error, 'error');
        } finally {
            if (requestId === activeModelFetchRequestId && modelFetchDialogState.providerId === providerId && modelFetchDialogState.loading) {
                modelFetchDialogState.status = '';
                modelFetchDialogState.loading = false;
                renderProviderModelsDialog();
            }
        }
    }

    function renderProviders() {
        const addProviderButton = documentRef.getElementById('btn-add-provider');
        if (addProviderButton) {
            addProviderButton.classList.toggle('hidden', API_PROVIDERS_LOCKED);
            addProviderButton.disabled = API_PROVIDERS_LOCKED;
        }

        providersList.innerHTML = '';
        if (state.providers.length === 0) {
            providersList.innerHTML = '<div style="color:var(--text-secondary);text-align:center;padding:20px;font-size:12px;">暂无供应商配置</div>';
            return;
        }

        syncCollapseState(state.providers, providerCollapseState);

        state.providers.forEach((prov) => {
            const isCollapsed = providerCollapseState.get(prov.id) !== false;
            const el = documentRef.createElement('div');
            el.className = 'api-config-card';
            el.innerHTML = `
                <div class="card-header">
                    <input type="text" class="card-name" value="${prov.name}" placeholder="供应商名称" data-id="${prov.id}" data-field="name" style="background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.2);padding:2px 4px;font-size:14px;color:var(--accent-cyan);width:150px" />
                    <div class="card-header-actions">
                        <button class="card-btn-fetch-models" data-id="${prov.id}" title="获取此供应商的模型列表">获取模型列表</button>
                        <button class="card-btn-collapse" data-id="${prov.id}" data-target="provider" title="${isCollapsed ? '展开此供应商' : '折叠此供应商'}" aria-expanded="${isCollapsed ? 'false' : 'true'}">${isCollapsed ? '▸' : '▾'}</button>
                        ${!API_PROVIDERS_LOCKED && prov.id !== 'prov_default' ? `<button class="card-btn-delete" data-id="${prov.id}" data-target="provider" title="删除此供应商">×</button>` : ''}
                    </div>
                </div>
                <div class="card-collapsible" style="display:${isCollapsed ? 'none' : 'flex'};">
                    <div class="card-row">
                        <div class="card-field">
                            <label>API 密钥</label>
                            <form class="password-wrapper" onsubmit="return false;">
                                <input type="text" value="${prov.name}" autocomplete="username" tabindex="-1" aria-hidden="true" style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;" />
                                <input type="password" value="${prov.apikey}" placeholder="API Key" data-id="${prov.id}" data-field="apikey" spellcheck="false" autocomplete="new-password" />
                                <button type="button" class="eye-toggle-btn" data-id="${prov.id}" title="显示/隐藏密钥">
                                    <svg class="icon-xs"><use href="#icon-eye"/></svg>
                                </button>
                            </form>
                        </div>
                        <div class="card-field"><label>API 地址</label><input type="text" value="${prov.endpoint}" placeholder="Endpoint URL" data-id="${prov.id}" data-field="endpoint" ${API_PROVIDERS_LOCKED ? 'readonly aria-readonly="true" title="供应商已锁定，API 地址不可修改"' : ''} /></div>
                    </div>
                    <div class="provider-toggle-row">
                        <div class="endpoint-preview" id="ep-preview-${prov.id}" style="font-size:12px;color:var(--text-dim);word-break:break-all;line-height:1.4;opacity:0.75;flex:1;">连接说明：${getProviderEndpointPreview(prov.endpoint, prov.autoComplete, normalizeProviderType(prov.type, prov))}</div>
                        <label class="settings-toggle-row provider-toggle-label">
                            <span class="settings-toggle-text">自动补全</span>
                            <span class="toggle-switch">
                                <input type="checkbox" ${prov.autoComplete !== false ? 'checked' : ''} data-id="${prov.id}" data-field="autoComplete" ${API_PROVIDERS_LOCKED ? 'disabled title="供应商已锁定，自动补全不可修改"' : ''} />
                                <span class="toggle-slider"></span>
                            </span>
                        </label>
                    </div>
                </div>
            `;
            providersList.appendChild(el);

            const toggleBtn = el.querySelector('.eye-toggle-btn');
            const passInput = el.querySelector('input[data-field="apikey"]');
            if (toggleBtn && passInput) {
                toggleBtn.onclick = () => {
                    const isPass = passInput.type === 'password';
                    passInput.type = isPass ? 'text' : 'password';
                    toggleBtn.innerHTML = `<svg class="icon-xs"><use href="#${isPass ? 'icon-eye-off' : 'icon-eye'}"/></svg>`;
                };
            }
        });

        providersList.querySelectorAll('input').forEach((input) => {
            const updatePreview = (id) => {
                const prov = state.providers.find((candidate) => candidate.id === id);
                const previewEl = documentRef.getElementById(`ep-preview-${id}`);
                if (prov && previewEl) {
                    previewEl.textContent = '连接说明：' + getProviderEndpointPreview(prov.endpoint, prov.autoComplete, normalizeProviderType(prov.type, prov));
                }
            };

            input.addEventListener('change', (e) => {
                const id = e.target.dataset.id;
                const field = e.target.dataset.field;
                const prov = state.providers.find((candidate) => candidate.id === id);
                if (!prov) return;
                if (API_PROVIDERS_LOCKED && (field === 'endpoint' || field === 'autoComplete')) {
                    e.target.value = prov[field] ?? '';
                    if (field === 'autoComplete') e.target.checked = prov.autoComplete !== false;
                    updatePreview(id);
                    return;
                }

                if (field === 'autoComplete') {
                    prov.autoComplete = e.target.checked;
                    updatePreview(id);
                } else {
                    prov[field] = e.target.value;
                }

                saveState();
                renderModels();
                updatePreview(id);
            });

            if (input.dataset.field === 'endpoint') {
                input.addEventListener('input', (e) => {
                    const id = e.target.dataset.id;
                    const prov = state.providers.find((candidate) => candidate.id === id);
                    if (!prov) return;
                    if (API_PROVIDERS_LOCKED) {
                        e.target.value = prov.endpoint || '';
                        updatePreview(id);
                        return;
                    }
                    prov.endpoint = e.target.value;
                    updatePreview(id);
                });
            }
        });

        providersList.querySelectorAll('.card-btn-delete').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                if (!windowRef.confirm('确定删除此供应商吗？绑定的模型可能会失效。')) return;
                const providerId = e.target.dataset.id;
                state.providers = state.providers.filter((candidate) => candidate.id !== providerId);
                state.models.forEach((model) => {
                    model.providerIds = getModelProviderIds(model).filter((id) => id !== providerId);
                    syncModelProviderBindings(model);
                });
                renderProviders();
                renderModels();
                updateAllNodeModelDropdowns();
                saveState();
            });
        });

        providersList.querySelectorAll('.card-btn-fetch-models').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const { id } = e.currentTarget.dataset;
                fetchProviderModels(id);
            });
        });

        providersList.querySelectorAll('.card-btn-collapse').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const { id } = e.currentTarget.dataset;
                toggleConfigCard(providerCollapseState, id, renderProviders);
            });
        });

        providersList.querySelectorAll('.api-config-card .card-header').forEach((header) => {
            header.addEventListener('click', (e) => {
                if (isCardHeaderControlClick(e)) return;
                const id = header.querySelector('.card-btn-collapse')?.dataset.id;
                if (!id) return;
                toggleConfigCard(providerCollapseState, id, renderProviders);
            });
        });
    }

    function renderModels() {
        modelsList.innerHTML = '';
        if (state.models.length === 0) {
            modelsList.innerHTML = '<div style="color:var(--text-secondary);text-align:center;padding:20px;font-size:12px;">暂无模型配置</div>';
            return;
        }

        syncCollapseState(state.models, modelCollapseState);

        state.models.forEach((mod) => {
            syncModelProviderBindings(mod);
            const isCollapsed = modelCollapseState.get(mod.id) !== false;
            const el = documentRef.createElement('div');
            el.className = 'api-config-card';
            const taskType = normalizeModelTaskType(mod.taskType, mod);
            const provider = getResolvedModelProvider(mod);
            const protocol = getEffectiveProtocol(mod, provider);
            const boundProviderIds = getModelProviderIds(mod);
            const isProviderPanelOpen = openModelProviderPanelId === mod.id;
            const providerDropdown = state.providers.length > 0
                ? `
                    <div class="provider-multiselect" data-id="${mod.id}">
                        <button type="button" class="provider-multiselect-trigger" data-id="${mod.id}" aria-expanded="${isProviderPanelOpen ? 'true' : 'false'}">
                            <span class="provider-multiselect-summary">${escapeHtml(getModelProviderSummary(mod))}</span>
                            <span class="provider-multiselect-caret">▾</span>
                        </button>
                        <div class="provider-multiselect-panel ${isProviderPanelOpen ? '' : 'hidden'}" data-id="${mod.id}">
                            ${state.providers.map((providerItem) => `
                                <label class="provider-multiselect-option">
                                    <input type="checkbox" data-id="${mod.id}" data-field="providerIds" value="${providerItem.id}" ${boundProviderIds.includes(providerItem.id) ? 'checked' : ''} />
                                    <span>${escapeHtml(providerItem.name || providerItem.id)}</span>
                                </label>
                            `).join('')}
                        </div>
                    </div>
                `
                : '<div style="font-size:11px;color:var(--text-dim);padding-top:8px;">请先添加供应商</div>';
            el.innerHTML = `
                <div class="card-header">
                    <input type="text" class="card-name" value="${mod.name}" placeholder="自定义名称，显示在节点中" data-id="${mod.id}" data-field="name" style="background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.2);padding:2px 4px;font-size:14px;color:#a855f7;width:200px" />
                    <div class="card-header-actions">
                        ${mod.id !== 'default' ? `<button class="card-btn-delete" data-id="${mod.id}" data-target="model" title="删除此模型">×</button>` : ''}
                    </div>
                </div>
                <div class="card-collapsible" style="display:${isCollapsed ? 'none' : 'flex'};">
                    <div class="card-row">
                        <div class="card-field"><label>模型代码 (Model ID)</label><input type="text" value="${mod.modelId}" placeholder="如: gemini-2.5-flash" data-id="${mod.id}" data-field="modelId" /></div>
                        <div class="card-field"><label>绑定供应商</label>
                            <div style="display:flex;flex-direction:column;gap:2px;padding-top:4px;">${providerDropdown}</div>
                        </div>
                    </div>
                    <div class="card-row">
                        <div class="card-field">
                            <label>模型用途</label>
                            <select data-id="${mod.id}" data-field="taskType">
                                <option value="chat" ${taskType === 'chat' ? 'selected' : ''}>对话</option>
                                <option value="image" ${taskType === 'image' ? 'selected' : ''}>生图</option>
                            </select>
                        </div>
                        <div class="card-field">
                            <label>兼容格式</label>
                            <select data-id="${mod.id}" data-field="protocol">
                                <option value="google" ${protocol === 'google' ? 'selected' : ''}>Google / Gemini</option>
                                <option value="openai" ${protocol === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
                            </select>
                        </div>
                    </div>
                    <div class="card-row">
                        <div class="card-field">
                            <label>请求示例</label>
                            <div style="font-size:11px;color:var(--text-dim);line-height:1.45;padding-top:8px;word-break:break-all;">${getModelRequestPreview(mod)}</div>
                        </div>
                        <div class="card-field">
                            <label>格式说明</label>
                            <div style="font-size:11px;color:var(--text-dim);line-height:1.45;padding-top:8px;">${getModelProtocolHelp(mod)}</div>
                        </div>
                    </div>
                </div>
            `;
            modelsList.appendChild(el);
        });

        modelsList.querySelectorAll('input, select').forEach((input) => {
            input.addEventListener('change', (e) => {
                const id = e.target.dataset.id;
                const field = e.target.dataset.field;
                const mod = state.models.find((candidate) => candidate.id === id);
                if (!mod) return;
                if (field === 'providerIds') {
                    openModelProviderPanelId = id;
                    const panel = modelsList.querySelector(`.provider-multiselect-panel[data-id="${id}"]`);
                    const checkedValues = panel
                        ? Array.from(panel.querySelectorAll('input[data-field="providerIds"]:checked')).map((inputEl) => inputEl.value)
                        : [];
                    mod.providerIds = checkedValues;
                    syncModelProviderBindings(mod);
                } else {
                    const provider = getResolvedModelProvider(mod);
                    mod[field] = field === 'taskType'
                        ? normalizeModelTaskType(e.target.value, mod)
                        : field === 'protocol'
                            ? normalizeModelProtocol(e.target.value, mod, provider)
                            : e.target.value;
                }
                saveState();
                renderModels();
                updateAllNodeModelDropdowns();
            });
        });

        modelsList.querySelectorAll('.provider-multiselect-trigger').forEach((button) => {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const { id } = e.currentTarget.dataset;
                const wrapper = modelsList.querySelector(`.provider-multiselect[data-id="${id}"]`);
                if (!wrapper) return;
                const panel = wrapper.querySelector('.provider-multiselect-panel');
                const willOpen = panel?.classList.contains('hidden');
                modelsList.querySelectorAll('.provider-multiselect-panel').forEach((element) => element.classList.add('hidden'));
                modelsList.querySelectorAll('.provider-multiselect-trigger').forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'));
                openModelProviderPanelId = '';
                if (panel && willOpen) {
                    panel.classList.remove('hidden');
                    e.currentTarget.setAttribute('aria-expanded', 'true');
                    openModelProviderPanelId = id;
                }
            });
        });

        modelsList.querySelectorAll('.provider-multiselect-panel').forEach((panel) => {
            panel.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });

        documentRef.addEventListener('click', () => {
            modelsList.querySelectorAll('.provider-multiselect-panel').forEach((element) => element.classList.add('hidden'));
            modelsList.querySelectorAll('.provider-multiselect-trigger').forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'));
            openModelProviderPanelId = '';
        }, { once: true });

        modelsList.querySelectorAll('.card-btn-delete').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                if (!windowRef.confirm('确定删除此模型配置吗？')) return;
                if (openModelProviderPanelId === e.target.dataset.id) openModelProviderPanelId = '';
                state.models = state.models.filter((candidate) => candidate.id !== e.target.dataset.id);
                renderModels();
                updateAllNodeModelDropdowns();
                saveState();
            });
        });

        modelsList.querySelectorAll('.api-config-card .card-header').forEach((header) => {
            header.addEventListener('click', (e) => {
                if (isCardHeaderControlClick(e)) return;
                const id = header.querySelector('.card-name')?.dataset.id;
                if (!id) return;
                toggleConfigCard(modelCollapseState, id, renderModels);
            });
        });
    }

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

            const p = audio.play();
            if (p !== undefined) {
                p.catch((err) => {
                    console.warn('Audio play failed (interaction required):', err);
                });
            }
        } catch (err) {
            console.error('Audio object reuse failed:', err);
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
        const escapeHtml = (value) => String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

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
                ? `<span>速度：${speed > 0 ? escapeHtml(`${formatBytes(speed)}/s`) : '等待数据'}</span>`
                : '';

            return `
                <div class="update-download-progress update-download-progress--settings">
                    <div class="update-download-progress__row">
                        <span class="update-download-progress__title">${escapeHtml(title)}</span>
                        <span class="update-download-progress__percent">${escapeHtml(percentLabel)}</span>
                    </div>
                    <div class="${trackClass}">
                        <div class="update-download-progress__bar"${barStyle}></div>
                    </div>
                    <div class="update-download-progress__detail">
                        <span>${escapeHtml(detailText)}</span>
                        ${speedHtml}
                    </div>
                </div>
            `;
        };

        let statusHtml = '';
        let updateDownloadProgressHtml = '';
        const timeStr = lastCheck ? new Date(parseInt(lastCheck, 10)).toLocaleString() : '从未检查';

        if (updateStatus === 'checking') statusHtml = `<span class="update-status-loading">正在检查中...</span>`;
        else if (updateStatus === 'downloading') {
            statusHtml = '<span class="update-status-loading">正在下载更新...</span>';
            updateDownloadProgressHtml = renderUpdateDownloadProgressHtml(
                updateDownloadSnapshot || { status: 'downloading', message: updateDownloadText },
                updateDownloadText || '正在下载更新...'
            );
        }
        else if (updateStatus === 'canceling') {
            statusHtml = '<span class="update-status-loading">正在取消下载...</span>';
            updateDownloadProgressHtml = renderUpdateDownloadProgressHtml(
                updateDownloadSnapshot || { status: 'canceling', message: updateDownloadText },
                updateDownloadText || '正在取消下载...'
            );
        }
        else if (updateStatus === 'downloaded') statusHtml = `<span class="update-status-latest">✓ 更新已完成，请重启 CainFlow 主程序</span>`;
        else if (updateStatus === 'latest') statusHtml = `<span class="update-status-latest">✓ 当前已是最新版本</span>`;
        else if (updateStatus === 'new_version') {
            statusHtml = `
                <div class="general-settings-status-row">
                    <span class="update-status-new">发现新版本 ${latestVer}</span>
                    <button class="btn btn-secondary btn-sm" data-action="download-update" style="animation: glow-pulse 2.5s infinite">下载并更新</button>
                </div>
            `;
        } else if (updateStatus === 'error') statusHtml = `<span class="update-status-error" title="${escapeHtml(updateError)}">✗ ${escapeHtml(updateError)}</span>`;

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
                        <label>当前版本与检查结果</label>
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
                                <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px;">
                                    <label class="general-settings-toggle-title" style="margin:0;">加载页面时自动检查更新</label>
                                    <label class="toggle-switch">
                                        <input type="checkbox" id="setting-auto-check-updates-on-load" ${autoCheckUpdatesOnLoad ? 'checked' : ''}>
                                        <span class="toggle-slider"></span>
                                    </label>
                                </div>
                                <p style="font-size:11px; color:var(--text-dim); line-height:1.4;">默认开启。关闭后，页面加载时不会再自动倒计时检查更新，但仍可手动检查。</p>
                            </div>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px;">最后检查: ${timeStr}</p>
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
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px;">
                            <label class="general-settings-toggle-title" style="margin:0;">导入时自动缩放</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-auto-resize-enabled" ${autoResizeEnabled ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); line-height: 1.4;">开启后，超出阈值的大图会在导入时自动缩小；关闭后将保留原图。</p>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <label>图片导入自适应缩放阈值 (边长)</label>
                        <div class="general-settings-inline-input" style="display:flex; align-items:center; gap:8px; opacity:${autoResizeEnabled ? '1' : '0.55'};">
                            <input type="number" id="setting-max-side" value="${currentSide}" placeholder="如: 2048" style="flex:1" ${autoResizeEnabled ? '' : 'disabled'} />
                            <span id="pixels-hint" style="font-size:11px; color:var(--text-dim); min-width:60px;">${(state.imageMaxPixels / 1000000).toFixed(1)} MP</span>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px; line-height: 1.4;">提示：阈值按边长换算为总像素上限，仅在自动缩放开启时生效。</p>
                    </div>
                </div>
            </div>

            <div class="api-config-card general-settings-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">存储设置</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: flex-start;">
                    <div class="card-field">
                        <label>全局图片保存目录</label>
                        <div class="general-settings-dir-row" style="display:flex; align-items:center; gap:8px;">
                            <span id="global-dir-badge" style="font-size:12px; color:var(--text-primary); padding:6px 10px; border-radius:6px; flex:1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; ${state.globalSaveDirHandle ? 'background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1);' : 'background:rgba(239, 68, 68, 0.08); border:1px solid rgba(239, 68, 68, 0.2);'}">
                                ${state.globalSaveDirHandle ? `已选择: ${state.globalSaveDirHandle.name}` : '<span style="color:var(--accent-red); font-weight:500;">⚠️ 未设置</span>'}
                            </span>
                            <button id="btn-set-global-dir" class="btn btn-secondary btn-xs" style="padding: 4px 8px;">更改</button>
                            ${state.globalSaveDirHandle ? `<button id="btn-clear-global-dir" class="btn btn-ghost btn-xs" style="color:var(--accent-red); padding: 4px 8px;">清除</button>` : ''}
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px; line-height: 1.4;">提示：设置全局目录可统一管理生成的图片。</p>
                        <p style="font-size:11px; color:var(--accent-orange); opacity:0.8; margin-top:4px; line-height: 1.3;">⚠️ 注意：受浏览器安全限制，无法读取完整路径，请自行记住所使用的文件夹位置。</p>
                        <p style="font-size:11px; color:var(--accent-orange); opacity:0.8; margin-top:4px; line-height: 1.3;">局域网其他设备访问时无法使用自动保存功能。</p>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px;">
                            <label class="general-settings-toggle-title" style="margin:0;">保存图片时使用提示词命名</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-image-save-use-prompt-filename" ${imageSaveUsePromptFilename ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); line-height:1.4;">开启后，保存节点会用生成该图片时的提示词加时间作为文件名。⚠️但如果提示词过长可能导致一些未知问题。</p>
                    </div>
                </div>
            </div>

            <div class="api-config-card general-settings-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">自动化与重试</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: flex-start;">
                    <div class="card-field">
                        <label>最大自动重试次数</label>
                        <div class="general-settings-inline-input" style="display:flex; align-items:center; gap:8px;">
                            <div class="retry-input-group" style="display:flex; align-items:center; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.1); border-radius:6px; overflow:hidden; flex:1;">
                                <button class="btn-retry-step" data-step="-1" style="background:transparent; border:none; color:var(--text-secondary); width:32px; height:32px; cursor:pointer; font-size:16px; transition:all 0.2s; display:flex; align-items:center; justify-content:center;">-</button>
                                <input type="number" id="setting-max-retries" value="${state.maxRetries || 15}" min="1" max="100" style="flex:1; background:transparent; border:none; border-left:1px solid rgba(255,255,255,0.05); border-right:1px solid rgba(255,255,255,0.05); text-align:center; padding:0; height:32px; color:var(--accent-purple); font-weight:600; -moz-appearance: textfield;" />
                                <button class="btn-retry-step" data-step="1" style="background:transparent; border:none; color:var(--text-secondary); width:32px; height:32px; cursor:pointer; font-size:16px; transition:all 0.2s; display:flex; align-items:center; justify-content:center;">+</button>
                            </div>
                            <span style="font-size:11px; color:var(--text-dim); min-width:20px;">轮</span>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px; line-height: 1.4;">提示：初始失败后，最多允许再尝试执行多少轮。</p>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px;">
                            <label class="general-settings-toggle-title" style="margin:0;">并发请求模式</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-concurrent-request-mode" ${concurrentRequestMode ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); line-height:1.4;">默认开启。开启后，节点一旦需要执行多次，会并发发起这些请求；默认不会重试失败项，只把成功结果继续传递到下游。只有手动开启自动重试时，失败项才会按最大重试次数补试。</p>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px;">
                            <label class="general-settings-toggle-title" style="margin:0;">请求超时设置</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-timeout-enabled" ${state.requestTimeoutEnabled ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="general-settings-inline-input" style="display:flex; align-items:center; gap:8px; opacity:${state.requestTimeoutEnabled ? '1' : '0.55'};">
                            <input type="number" id="setting-timeout-seconds" value="${state.requestTimeoutSeconds || 60}" min="1" step="1" ${state.requestTimeoutEnabled ? '' : 'disabled'} style="flex:1" />
                            <span style="font-size:11px; color:var(--text-dim); min-width:20px;">秒</span>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px; line-height: 1.4;">默认关闭。关闭时会一直等待服务器返回；开启后超过设定秒数仍未返回则判定超时失败。</p>
                    </div>
                </div>
            </div>
            <div class="api-config-card general-settings-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">画布UI</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: flex-start;">
                    <div class="card-field">
                        <label>连线类型</label>
                        <select id="setting-connection-line-type" style="width:100%;">
                            <option value="bezier" ${connectionLineType === 'bezier' ? 'selected' : ''}>贝塞尔曲线</option>
                            <option value="orthogonal" ${connectionLineType === 'orthogonal' ? 'selected' : ''}>直角连线（圆角）</option>
                        </select>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px; line-height:1.4;">切换后会立即更新当前画布中的全部连线，直角连线会在拐点保留小圆角。</p>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px;">
                            <label class="general-settings-toggle-title" style="margin:0;">顶部菜单栏固定显示</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-toolbar-pinned" ${toolbarPinned ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); line-height:1.4;">默认关闭。开启后顶部菜单栏会一直显示，不再靠近顶部才弹出。</p>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px;">
                            <label class="general-settings-toggle-title" style="margin:0;">左侧工具栏固定显示</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-sidebar-pinned" ${sidebarPinned ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); line-height:1.4;">默认关闭。开启后左侧工具栏会一直显示，不再靠近左侧才弹出。</p>
                    </div>
                    <div class="general-settings-field-divider" aria-hidden="true"></div>
                    <div class="card-field">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px;">
                            <label class="general-settings-toggle-title" style="margin:0;">全局动画开关</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-global-animation-enabled" ${globalAnimationEnabled ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); line-height:1.4;">默认开启。关闭后会禁用全局动画效果，包括连线流动箭头、弹窗渐入渐出、按钮过渡和提示动画，以释放最大性能。</p>
                    </div>
                </div>
            </div>
            <div class="api-config-card general-settings-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">通知设置</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: flex-start;">
                    <div class="card-field">
                        <label>完成音效音量</label>
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
            } catch (e) {
                if (e.name !== 'AbortError') showToast('设置失败: ' + e.message, 'error');
            }
        });

        btnClearGlobal?.addEventListener('click', async () => {
            state.globalSaveDirHandle = null;
            renderGeneralSettings();
            updateImageSaveWarnings();
            showToast('全局保存目录已清除', 'info');
        });

        volInput?.addEventListener('input', (e) => {
            const vol = parseFloat(e.target.value);
            state.notificationVolume = vol;
            volHint.textContent = Math.round(vol * 100) + '%';
            updateVolumeSliderProgress();
            saveState();
        });

        documentRef.getElementById('setting-max-retries')?.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10);
            if (val >= 1 && val <= 100) {
                state.maxRetries = val;
                saveState();
            } else {
                e.target.value = state.maxRetries;
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

        concurrentRequestModeInput?.addEventListener('change', (e) => {
            state.concurrentRequestMode = e.target.checked;
            saveState();
        });

        timeoutEnabledInput?.addEventListener('change', (e) => {
            state.requestTimeoutEnabled = e.target.checked;
            if (timeoutSecondsInput) timeoutSecondsInput.disabled = !state.requestTimeoutEnabled;
            const wrapper = timeoutSecondsInput?.parentElement;
            if (wrapper) wrapper.style.opacity = state.requestTimeoutEnabled ? '1' : '0.55';
            saveState();
        });

        timeoutSecondsInput?.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10);
            if (!Number.isNaN(val) && val >= 1) {
                state.requestTimeoutSeconds = val;
                saveState();
            } else {
                e.target.value = state.requestTimeoutSeconds;
            }
        });

        connectionLineTypeInput?.addEventListener('change', (e) => {
            state.connectionLineType = e.target.value === 'orthogonal' ? 'orthogonal' : 'bezier';
            updateAllConnections();
            saveState();
        });

        toolbarPinnedInput?.addEventListener('change', (e) => {
            state.toolbarPinned = e.target.checked;
            applyCanvasUiSetting();
            saveState();
        });

        sidebarPinnedInput?.addEventListener('change', (e) => {
            state.sidebarPinned = e.target.checked;
            applyCanvasUiSetting();
            saveState();
        });

        globalAnimationInput?.addEventListener('change', (e) => {
            state.globalAnimationEnabled = e.target.checked;
            state.connectionFlowAnimationEnabled = state.globalAnimationEnabled;
            applyGlobalAnimationSetting();
            updateAllConnections();
            saveState();
        });

        autoCheckUpdatesOnLoadInput?.addEventListener('change', (e) => {
            state.autoCheckUpdatesOnLoad = e.target.checked;
            saveState();
        });

        imageSaveUsePromptFilenameInput?.addEventListener('change', (e) => {
            state.imageSaveUsePromptFilename = e.target.checked;
            saveState();
        });

        testBtn?.addEventListener('click', () => {
            playNotificationSound(true);
        });
        btnCheckUpdate?.addEventListener('click', () => {
            checkUpdate(true);
        });
        autoResizeInput?.addEventListener('change', (e) => {
            state.imageAutoResizeEnabled = e.target.checked;
            if (input) input.disabled = !state.imageAutoResizeEnabled;
            const wrapper = input?.parentElement;
            if (wrapper) wrapper.style.opacity = state.imageAutoResizeEnabled ? '1' : '0.55';
            saveState();
        });
        input?.addEventListener('input', (e) => {
            const side = parseInt(e.target.value, 10) || 0;
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

    function syncImageGenerateResolutionOptions(id) {
        const modelSelect = documentRef.getElementById(`${id}-apiconfig`);
        const providerSelect = documentRef.getElementById(`${id}-provider`);
        const resolutionSelect = documentRef.getElementById(`${id}-resolution`);
        if (!modelSelect || !resolutionSelect) return;

        const model = state.models.find((candidate) => candidate.id === modelSelect.value);
        const selectedProviderId = providerSelect?.value || '';
        const provider = getResolvedModelProvider(model, selectedProviderId);
        const normalizedProviderId = getResolvedModelProviderId(model, selectedProviderId);
        if (providerSelect && providerSelect.value !== normalizedProviderId) {
            providerSelect.value = normalizedProviderId;
        }
        const normalizedValue = normalizeImageResolutionForModel(resolutionSelect.value, model, state.providers, normalizedProviderId);
        resolutionSelect.innerHTML = getImageResolutionOptionsForModel(model, state.providers, normalizedProviderId)
            .map((option) => `<option value="${option.value}">${option.label}</option>`)
            .join('');
        resolutionSelect.value = normalizedValue;
        const isOpenAiModel = getEffectiveProtocol(model, provider) === 'openai';
        const aspectField = documentRef.getElementById(`${id}-aspect-field`);
        if (aspectField) aspectField.classList.toggle('hidden', isOpenAiModel);
        const qualityField = documentRef.getElementById(`${id}-quality-field`);
        if (qualityField) qualityField.classList.toggle('hidden', !isOpenAiModel);
        const note = documentRef.getElementById(`${id}-resolution-param-note`);
        if (note) note.classList.toggle('hidden', !isOpenAiModel);
        const customField = documentRef.getElementById(`${id}-custom-resolution-field`);
        if (customField) customField.classList.toggle('hidden', resolutionSelect.value !== 'custom');
        const widthInput = documentRef.getElementById(`${id}-custom-resolution-width`);
        const heightInput = documentRef.getElementById(`${id}-custom-resolution-height`);
        const hint = documentRef.getElementById(`${id}-custom-resolution-hint`);
        if (widthInput && heightInput && hint) {
            const validation = resolutionSelect.value === 'custom'
                ? validateOpenAiImageSize(widthInput.value, heightInput.value)
                : { valid: true, errors: [] };
            hint.textContent = validation.valid ? '' : validation.errors.join(' ');
            hint.style.display = validation.valid ? 'none' : 'block';
            widthInput.classList.toggle('invalid', !validation.valid);
            heightInput.classList.toggle('invalid', !validation.valid);
        }
    }

    function updateAllNodeModelDropdowns() {
        for (const [id, node] of state.nodes) {
            if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
                const modelSelect = documentRef.getElementById(`${id}-apiconfig`);
                const providerSelect = documentRef.getElementById(`${id}-provider`);
                const providerField = documentRef.getElementById(`${id}-provider-field`);
                if (!modelSelect) continue;

                const currentModelId = modelSelect.value;
                const currentProviderId = providerSelect?.value || node.providerId || '';
                const taskType = node.type === 'ImageGenerate' ? 'image' : 'chat';
                const models = getModelsForTask(state.models, taskType);
                if (models.length === 0) {
                    modelSelect.innerHTML = '<option value="">-- 暂无可用模型 --</option>';
                    modelSelect.value = '';
                    if (providerSelect) providerSelect.innerHTML = '<option value="">-- 暂无可用供应商 --</option>';
                    if (providerField) providerField.classList.add('hidden');
                    node.providerId = '';
                    continue;
                }

                modelSelect.innerHTML = models.map((model) => `<option value="${model.id}">${escapeHtml(model.name || model.modelId || model.id)}</option>`).join('');
                const selectedModel = models.find((model) => model.id === currentModelId) || models[0];
                modelSelect.value = selectedModel.id;

                if (providerSelect && providerField) {
                    const boundProviders = getModelBoundProviders(selectedModel);
                    if (boundProviders.length > 1) {
                        providerSelect.innerHTML = boundProviders
                            .map((provider) => `<option value="${provider.id}">${escapeHtml(provider.name || provider.id)}</option>`)
                            .join('');
                        providerSelect.value = getResolvedModelProviderId(selectedModel, currentProviderId);
                        providerField.classList.remove('hidden');
                    } else {
                        providerSelect.innerHTML = boundProviders.length === 1
                            ? `<option value="${boundProviders[0].id}">${escapeHtml(boundProviders[0].name || boundProviders[0].id)}</option>`
                            : '<option value="">-- 暂无可用供应商 --</option>';
                        providerSelect.value = getResolvedModelProviderId(selectedModel, currentProviderId);
                        providerField.classList.add('hidden');
                    }
                }

                node.providerId = getResolvedModelProviderId(selectedModel, providerSelect?.value || currentProviderId);
                if (node.type === 'ImageGenerate') syncImageGenerateResolutionOptions(id);
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

    function isHistoryAssetKey(key) {
        return typeof key === 'string' && key.startsWith(HISTORY_ASSET_KEY_PREFIX);
    }

    async function getStoreSizeBytes(storeName, includeEntry = () => true) {
        try {
            const db = await openDB();
            return new Promise((resolve) => {
                let bytes = 0;
                const tx = db.transaction(storeName, 'readonly');
                const store = tx.objectStore(storeName);
                const req = store.openCursor();
                req.onsuccess = (e) => {
                    const cursor = e.target.result;
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
        } catch (e) {
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
        } catch (e) {
            // ignore
        }
        return bytes;
    }

    async function updateCacheUsage(force = false) {
        const display = documentRef.getElementById('cache-size-display');
        const historyEl = documentRef.getElementById('usage-history');
        const assetsEl = documentRef.getElementById('usage-assets');
        const localEl = documentRef.getElementById('usage-local');
        if (!display) return;

        try {
            if (force) {
                state.cacheSizes[storeHistoryName] = null;
                state.cacheSizes[storeAssetsName] = null;
            }

            const historyStoreBytes = await getStoreSizeBytes(storeHistoryName);
            const historyAssetBytes = await getStoreSizeBytes(storeAssetsName, (key) => isHistoryAssetKey(key));
            const nodeAssetBytes = await getStoreSizeBytes(storeAssetsName, (key) => !isHistoryAssetKey(key));
            const localBytes = getLocalStorageBytes();
            const historyBytes = historyStoreBytes + historyAssetBytes;
            const totalBytes = historyBytes + nodeAssetBytes + localBytes;

            display.textContent = formatMB(totalBytes);
            if (historyEl) historyEl.textContent = formatMB(historyBytes);
            if (assetsEl) assetsEl.textContent = formatMB(nodeAssetBytes);
            if (localEl) localEl.textContent = formatMB(localBytes);
        } catch (e) {
            display.textContent = '获取失败';
            console.error('Cache audit failed:', e);
        }
    }

    function initSettingsUI({ settingsModalApi }) {
        windowRef.__cainflowSettingsModalApi = settingsModalApi;
        documentRef.getElementById('btn-settings').addEventListener('click', () => {
            settingsModalApi.openSettingsModal();
        });
        documentRef.getElementById('settings-close').addEventListener('click', () => {
            closeApiSettingsHelpDialog();
            closeProviderModelsDialog();
            closeNetworkProxyHintDialog();
            settingsModalApi.closeSettingsModal(() => state.notificationAudio?.pause());
        });
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) {
                closeApiSettingsHelpDialog();
                closeProviderModelsDialog();
                closeNetworkProxyHintDialog();
                settingsModalApi.closeSettingsModal(() => state.notificationAudio?.pause());
            }
        });

        documentRef.getElementById('btn-api-settings-help')?.addEventListener('click', renderApiSettingsHelpDialog);

        documentRef.querySelectorAll('.modal-tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const targetTab = btn.dataset.tab;
                documentRef.querySelectorAll('.modal-tab-btn').forEach((button) => button.classList.remove('active'));
                btn.classList.add('active');
                documentRef.querySelectorAll('.settings-tab-pane').forEach((pane) => {
                    pane.classList.toggle('active', pane.id === `settings-tab-${targetTab}`);
                });
            });
        });

        documentRef.getElementById('btn-add-provider').addEventListener('click', () => {
            if (API_PROVIDERS_LOCKED) {
                showToast('API 供应商已锁定，无法添加供应商', 'info');
                return;
            }
            const newProviderId = 'prov_' + Math.random().toString(36).substr(2, 9);
            state.providers.push({
                id: newProviderId,
                name: '新供应商',
                type: 'google',
                apikey: '',
                endpoint: 'https://generativelanguage.googleapis.com',
                autoComplete: true
            });
            providerCollapseState.set(newProviderId, false);
            renderProviders();
            renderModels();
            saveState();
        });

        documentRef.getElementById('btn-add-model').addEventListener('click', () => {
            const defaultProvider = state.providers.length > 0 ? state.providers[0] : null;
            const newModelId = 'mod_' + Math.random().toString(36).substr(2, 9);
            state.models.push({
                id: newModelId,
                name: '新模型配置',
                modelId: '',
                providerIds: defaultProvider ? [defaultProvider.id] : [],
                providerId: defaultProvider ? defaultProvider.id : '',
                taskType: 'chat',
                protocol: normalizeModelProtocol('', { taskType: 'chat' }, defaultProvider)
            });
            modelCollapseState.set(newModelId, false);
            renderModels();
            updateAllNodeModelDropdowns();
            saveState();
            setTimeout(() => {
                documentRef.getElementById('settings-body').scrollTop = 9999;
            }, 50);
        });
    }

    return {
        initProxyPanel,
        checkNetworkProxyMismatch,
        syncProxyToServer,
        collapseAllConfigCards,
        renderProviders,
        renderModels,
        playNotificationSound,
        renderGeneralSettings,
        updateImageSaveWarnings,
        updateAllNodeModelDropdowns,
        updateCacheUsage,
        initSettingsUI
    };
}
