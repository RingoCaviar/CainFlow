/**
 * Handles model rendering, fetched model workflows, request previews, and node model dropdown refresh.
 */
import {
    getEffectiveProtocol,
    getImageResolutionOptionsForModel,
    getModelProviderIds,
    getModelsForTask,
    normalizeAutoCompleteBase,
    normalizeImageResolutionForModel,
    normalizeModelProtocol,
    normalizeModelTaskType,
    resolveProviderUrl,
    validateOpenAiImageSize
} from '../execution/provider-request-utils.js';
import {
    getModelProtocolHelpText,
    getProtocolSelectOptions
} from '../execution/model-protocol-registry.js';
import { API_PROVIDERS_LOCKED } from '../../core/constants.js';

export function createModelSettings({ ctx, store, dialogs, providerSettings, getDeps }) {
    const {
        state,
        modelsList,
        documentRef,
        windowRef,
        showToast,
        saveState,
        updateAllConnections,
        fitNodeToContent,
        fetchImpl
    } = ctx;

    const {
        modelFetchDialogState,
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

    function getProviderModelListUrl(provider, protocol) {
        const endpoint = String(provider?.endpoint || '').trim().replace(/\/+$/, '');
        if (!endpoint) return '';
        let base = normalizeAutoCompleteBase(endpoint, protocol).replace(/\/models\/?$/i, '');
        if (protocol === 'google') {
            const query = provider?.apikey ? `?key=${encodeURIComponent(provider.apikey)}` : '';
            return `${base}/v1beta/models${query}`;
        }
        if (protocol === 'ttapi' || protocol === 'ttapi-openai') {
            return '';
        }
        if (!/\/v\d+(?:beta)?$/i.test(base)) {
            base = `${base}/v1`;
        }
        return `${base}/models`;
    }

    function shouldFetchVectorEnginePricing(provider, protocol) {
        const fingerprint = `${provider?.endpoint || ''} ${provider?.name || ''}`.toLowerCase();
        return providerSettings.isVectorEngineEndpoint(provider?.endpoint) || fingerprint.includes('vectorengine');
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
            fingerprint.includes('veo') ||
            fingerprint.includes('seedance') ||
            fingerprint.includes('sora') ||
            fingerprint.includes('kling') ||
            fingerprint.includes('hailuo') ||
            fingerprint.includes('runway') ||
            fingerprint.includes('wanx') ||
            fingerprint.includes('wan-') ||
            fingerprint.includes('video') ||
            fingerprint.includes('视频')
        ) {
            return 'video';
        }
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

    function getFetchedModelTaskTypeLabel(taskType) {
        if (taskType === 'image') return '生图';
        if (taskType === 'video') return '视频';
        return '对话';
    }

    function inferFetchedModelProtocol(provider, fetchedModel = {}) {
        const fingerprint = `${fetchedModel.id || ''} ${fetchedModel.name || ''}`.toLowerCase();
        if (providerSettings.isTtapiOpenAiEndpoint(provider?.endpoint)) return 'ttapi-openai';
        if (providerSettings.isTtapiEndpoint(provider?.endpoint)) return 'ttapi';
        const supportedEndpointTypes = Array.isArray(fetchedModel.raw?.supported_endpoint_types)
            ? fetchedModel.raw.supported_endpoint_types.map((type) => String(type || '').toLowerCase())
            : Array.isArray(fetchedModel.supported_endpoint_types)
                ? fetchedModel.supported_endpoint_types.map((type) => String(type || '').toLowerCase())
                : [];
        if (fingerprint.includes('doubao') || fingerprint.includes('seedance')) {
            return 'doubao-video';
        }
        if (fingerprint.includes('veo') || fingerprint.includes('sora') || fingerprint.includes('video')) {
            return 'veo-openai';
        }
        if (fingerprint.includes('nana-banana') || fingerprint.includes('banana')) {
            return 'newapi-image-async';
        }
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
        return providerSettings.getModelFetchProtocol(provider);
    }

    function normalizeFetchedModelName(modelId, sourceModel = {}) {
        return String(sourceModel.displayName || sourceModel.name || sourceModel.id || modelId || '')
            .replace(/^models\//, '')
            .trim() || modelId;
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
        }, constants.MODEL_FETCH_CLIENT_TIMEOUT_SECONDS, timeoutMessage);
        const responseText = await readResponseTextWithTimeout(
            response,
            constants.MODEL_FETCH_CLIENT_TIMEOUT_SECONDS,
            `读取模型列表响应超时（${constants.MODEL_FETCH_CLIENT_TIMEOUT_SECONDS} 秒）。供应商已经响应，但本地代理返回体没有正常结束，请重启 CainFlow 后重试`
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
            `获取 VectorEngine 完整模型价格表超时（${constants.MODEL_FETCH_CLIENT_TIMEOUT_SECONDS} 秒）。请检查供应商地址、代理设置或 /api/pricing 接口是否可用`
        );
        return parseFetchedModels(parseNewApiPricingModels(payload), 'openai');
    }

    function findMatchingModelConfig(modelId, protocol, taskType) {
        return state.models.find((model) => {
            const provider = providerSettings.getResolvedModelProvider(model);
            return model.modelId === modelId &&
                normalizeModelTaskType(model.taskType, model) === normalizeModelTaskType(taskType, model) &&
                normalizeModelProtocol(model.protocol, model, provider) === protocol;
        }) || null;
    }

    function modelAlreadyExists(providerId, modelId, protocol, taskType = '') {
        return state.models.some((model) => {
            if (model.modelId !== modelId) return false;
            if (!getModelProviderIds(model).includes(providerId)) return false;
            const provider = state.providers.find((candidate) => candidate.id === providerId) || providerSettings.getResolvedModelProvider(model);
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
            const providerIds = providerSettings.syncModelProviderBindings(existingModel);
            if (providerIds.includes(provider.id)) {
                showToast('该模型已在模型列表中', 'info');
                return;
            }
            existingModel.providerIds = [...providerIds, provider.id];
            existingModel.providerId = existingModel.providerIds[0] || '';
            renderModels();
            updateAllNodeModelDropdowns();
            saveState();
            dialogs.renderProviderModelsDialog({ preserveListScroll: true });
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
        store.modelCollapseState.set(newModelId, true);
        renderModels();
        updateAllNodeModelDropdowns();
        saveState();
        dialogs.renderProviderModelsDialog({ preserveListScroll: true });
        showToast(`已添加模型：${fetchedModel.id}`, 'success');
    }

    async function fetchProviderModels(providerId) {
        const provider = state.providers.find((candidate) => candidate.id === providerId);
        if (!provider) return;

        const requestId = store.activeModelFetchRequestId + 1;
        store.activeModelFetchRequestId = requestId;
        const protocol = providerSettings.getModelFetchProtocol(provider);
        const url = getProviderModelListUrl(provider, protocol);
        modelFetchDialogState.providerId = providerId;
        modelFetchDialogState.models = [];
        modelFetchDialogState.error = '';
        modelFetchDialogState.status = '正在准备模型列表请求...';
        modelFetchDialogState.loading = true;
        dialogs.renderProviderModelsDialog();
        showToast(`正在获取 ${providerSettings.getSafeProviderName(provider)} 的模型列表...`, 'info', 4000);

        try {
            if (protocol === 'ttapi' || protocol === 'ttapi-openai') throw new Error('TTAPI 请求格式暂不支持自动获取模型列表，请在模型卡片里手动填写模型 ID');
            if (!url) throw new Error('请先填写供应商 API 地址');
            if (!provider.apikey && protocol === 'google') throw new Error('请先填写供应商 API 密钥');

            modelFetchDialogState.status = '正在请求供应商模型列表...';
            dialogs.renderProviderModelsDialog();
            let primaryModels = [];
            let primaryError = null;
            try {
                const payload = await fetchProviderModelPayload(
                    url,
                    protocol,
                    provider,
                    `获取模型列表超时（${constants.MODEL_FETCH_CLIENT_TIMEOUT_SECONDS} 秒）。请检查供应商地址、密钥、代理设置或该供应商的 /models 接口是否可用`
                );
                if (requestId !== store.activeModelFetchRequestId || modelFetchDialogState.providerId !== providerId) return;
                modelFetchDialogState.status = '正在解析供应商返回...';
                dialogs.renderProviderModelsDialog();
                primaryModels = parseFetchedModels(payload, protocol);
            } catch (error) {
                primaryError = error;
            }

            if (requestId !== store.activeModelFetchRequestId || modelFetchDialogState.providerId !== providerId) return;
            const extraStatus = primaryModels.length
                ? '正在补充 VectorEngine 完整模型列表...'
                : '正在尝试从 VectorEngine 完整模型表兜底...';
            const shouldFetchPricing = shouldFetchVectorEnginePricing(provider, protocol);
            if (shouldFetchPricing) {
                modelFetchDialogState.status = extraStatus;
                dialogs.renderProviderModelsDialog();
            }
            const pricingModels = shouldFetchPricing
                ? await fetchVectorEnginePricingModels(provider, protocol)
                : [];
            const models = mergeFetchedModels(primaryModels, pricingModels);
            if (!models.length && primaryError) throw primaryError;
            if (requestId !== store.activeModelFetchRequestId || modelFetchDialogState.providerId !== providerId) return;
            modelFetchDialogState.models = models;
            modelFetchDialogState.error = models.length ? '' : '供应商返回的模型列表为空';
            modelFetchDialogState.status = '';
            modelFetchDialogState.loading = false;
            dialogs.renderProviderModelsDialog();
            showToast(`已获取 ${models.length} 个模型`, models.length ? 'success' : 'info');
        } catch (error) {
            if (requestId !== store.activeModelFetchRequestId || modelFetchDialogState.providerId !== providerId) return;
            const message = error?.message || String(error);
            modelFetchDialogState.error = `获取失败：${message}`;
            modelFetchDialogState.models = [];
            modelFetchDialogState.status = '';
            modelFetchDialogState.loading = false;
            dialogs.renderProviderModelsDialog();
            showToast(modelFetchDialogState.error, 'error');
        } finally {
            if (
                requestId === store.activeModelFetchRequestId &&
                modelFetchDialogState.providerId === providerId &&
                modelFetchDialogState.loading
            ) {
                modelFetchDialogState.status = '';
                modelFetchDialogState.loading = false;
                dialogs.renderProviderModelsDialog();
            }
        }
    }

    function collapseAllModelConfigCards() {
        state.models.forEach((model) => {
            store.modelCollapseState.set(model.id, true);
        });
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

    function getModelRequestPreview(model) {
        const provider = providerSettings.getResolvedModelProvider(model);
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
                modelId: model.modelId || '{模型ID}'
            },
            normalizeModelTaskType(model.taskType, model)
        );
    }

    function getModelProtocolHelp(model) {
        const provider = providerSettings.getResolvedModelProvider(model);
        const protocol = getEffectiveProtocol(model, provider);
        return getModelProtocolHelpText(protocol, '当前兼容格式说明暂未配置。');
    }

    function toggleModelProviderSelection(modelId, providerId) {
        const mod = state.models.find((candidate) => candidate.id === modelId);
        if (!mod) return;
        const selectableProviders = providerSettings.getVisibleSettingsProviders();
        const validProviderIds = new Set(selectableProviders.map((provider) => provider.id));
        if (!validProviderIds.has(providerId)) return;
        store.openModelProviderPanelId = modelId;
        const current = new Set(API_PROVIDERS_LOCKED
            ? getModelProviderIds(mod)
            : getModelProviderIds(mod).filter((id) => validProviderIds.has(id)));
        if (current.has(providerId)) {
            current.delete(providerId);
        } else {
            current.add(providerId);
        }
        const orderedProviderIds = API_PROVIDERS_LOCKED
            ? [
                ...state.providers.map((provider) => provider.id),
                ...Array.from(current)
            ]
            : state.providers.map((provider) => provider.id);
        mod.providerIds = orderedProviderIds.filter((id, index, ids) => current.has(id) && ids.indexOf(id) === index);
        providerSettings.syncModelProviderBindings(mod);
        saveState();
        renderModels();
        updateAllNodeModelDropdowns();
    }

    function renderModels() {
        modelsList.innerHTML = '';
        if (state.models.length === 0) {
            modelsList.innerHTML = '<div style="color:var(--text-secondary);text-align:center;padding:20px;font-size:12px;">暂无模型配置</div>';
            return;
        }

        syncCollapseState(state.models, store.modelCollapseState);

        state.models.forEach((mod) => {
            providerSettings.syncModelProviderBindings(mod);
            const isCollapsed = store.modelCollapseState.get(mod.id) !== false;
            const el = documentRef.createElement('div');
            el.className = `api-config-card model-config-card${isCollapsed ? ' is-collapsed' : ''}`;
            el.dataset.modelId = mod.id;
            const taskType = normalizeModelTaskType(mod.taskType, mod);
            const provider = providerSettings.getResolvedModelProvider(mod);
            const protocol = getEffectiveProtocol(mod, provider);
            const protocolOptions = getProtocolSelectOptions(taskType)
                .map((option) => `
                    <option value="${option.value}" ${protocol === option.value ? 'selected' : ''}>${dialogs.escapeHtml(option.label)}</option>
                `)
                .join('');
            const isProviderPanelOpen = store.openModelProviderPanelId === mod.id;
            const visibleProviders = providerSettings.getVisibleSettingsProviders();
            const providerDropdown = visibleProviders.length > 0
                ? `
                    <div class="provider-multiselect" data-id="${mod.id}">
                        <button type="button" class="provider-multiselect-trigger" data-id="${mod.id}" aria-expanded="${isProviderPanelOpen ? 'true' : 'false'}">
                            <span class="provider-multiselect-summary">${dialogs.escapeHtml(providerSettings.getModelProviderSummary(mod))}</span>
                            <span class="provider-multiselect-caret">▾</span>
                        </button>
                    </div>
                `
                : '<div style="font-size:11px;color:var(--text-dim);padding-top:8px;">请先添加供应商</div>';
            el.innerHTML = `
                <div class="card-header">
                    <input type="text" class="card-name" value="${mod.name}" placeholder="自定义名称，显示在节点中" data-id="${mod.id}" data-field="name" ${isCollapsed ? 'readonly tabindex="-1" aria-label="点击展开模型配置"' : ''} style="background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.2);padding:2px 4px;font-size:14px;color:#a855f7;width:200px" />
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
                                <option value="video" ${taskType === 'video' ? 'selected' : ''}>视频</option>
                            </select>
                        </div>
                        <div class="card-field">
                            <label>兼容格式</label>
                            <select data-id="${mod.id}" data-field="protocol">${protocolOptions}</select>
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

        modelsList.querySelectorAll('input:not([data-field="providerIds"]), select').forEach((input) => {
            input.addEventListener('change', (event) => {
                const id = event.target.dataset.id;
                const field = event.target.dataset.field;
                const mod = state.models.find((candidate) => candidate.id === id);
                if (!mod) return;
                const provider = providerSettings.getResolvedModelProvider(mod);
                mod[field] = field === 'taskType'
                    ? normalizeModelTaskType(event.target.value, mod)
                    : field === 'protocol'
                        ? normalizeModelProtocol(event.target.value, mod, provider)
                        : event.target.value;
                saveState();
                renderModels();
                updateAllNodeModelDropdowns();
            });
        });

        modelsList.querySelectorAll('.provider-multiselect-trigger').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const { id } = event.currentTarget.dataset;
                store.openModelProviderPanelId = store.openModelProviderPanelId === id ? '' : id;
                renderModels();
            });
        });

        modelsList.querySelectorAll('.card-btn-delete').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                if (!windowRef.confirm('确定删除此模型配置吗？')) return;
                if (store.openModelProviderPanelId === event.target.dataset.id) {
                    store.openModelProviderPanelId = '';
                }
                state.models = state.models.filter((candidate) => candidate.id !== event.target.dataset.id);
                renderModels();
                updateAllNodeModelDropdowns();
                saveState();
            });
        });

        modelsList.querySelectorAll('.model-config-card').forEach((card) => {
            card.addEventListener('click', (event) => {
                const isCollapsedCard = card.classList.contains('is-collapsed');
                const clickedHeader = event.target.closest('.card-header');
                if (!isCollapsedCard && !clickedHeader) return;
                if (event.target.closest('.card-btn-delete, button, select, textarea, label, a')) return;
                if (!!event.target.closest('input, select, textarea, button, label, a') && !isCollapsedCard) return;

                const id = card.dataset.modelId || card.querySelector('.card-name')?.dataset.id;
                if (!id) return;
                event.preventDefault();
                store.modelCollapseState.set(id, !(store.modelCollapseState.get(id) !== false));
                renderModels();
            });
        });

        if (store.openModelProviderPanelId) {
            windowRef.requestAnimationFrame(() => {
                dialogs.renderFloatingModelProviderPanel(store.openModelProviderPanelId, toggleModelProviderSelection);
            });
        } else {
            dialogs.closeFloatingModelProviderPanel();
        }
    }

    function syncImageGenerateResolutionOptions(id) {
        const modelSelect = documentRef.getElementById(`${id}-apiconfig`);
        const providerSelect = documentRef.getElementById(`${id}-provider`);
        const resolutionSelect = documentRef.getElementById(`${id}-resolution`);
        if (!modelSelect || !resolutionSelect) return;

        const model = state.models.find((candidate) => candidate.id === modelSelect.value);
        const selectedProviderId = providerSelect?.value || '';
        const provider = providerSettings.getResolvedModelProvider(model, selectedProviderId);
        const normalizedProviderId = providerSettings.getResolvedModelProviderId(model, selectedProviderId);
        if (providerSelect && providerSelect.value !== normalizedProviderId) {
            providerSelect.value = normalizedProviderId;
        }
        const normalizedValue = normalizeImageResolutionForModel(resolutionSelect.value, model, state.providers, normalizedProviderId);
        resolutionSelect.innerHTML = getImageResolutionOptionsForModel(model, state.providers, normalizedProviderId)
            .map((option) => `<option value="${option.value}">${option.label}</option>`)
            .join('');
        resolutionSelect.value = normalizedValue;
        const protocol = getEffectiveProtocol(model, provider);
        const isOpenAiModel = protocol === 'openai';
        const isTtapiOpenAiModel = protocol === 'ttapi-openai';
        const usesOpenAiImageControls = isOpenAiModel || isTtapiOpenAiModel;
        const isNewApiAsyncImage = protocol === 'newapi-image-async';
        const aspectField = documentRef.getElementById(`${id}-aspect-field`);
        if (aspectField) aspectField.classList.toggle('hidden', usesOpenAiImageControls);
        const qualityField = documentRef.getElementById(`${id}-quality-field`);
        if (qualityField) qualityField.classList.toggle('hidden', !usesOpenAiImageControls);
        [
            `${id}-moderation-field`,
            `${id}-background-field`
        ].forEach((fieldId) => {
            const field = documentRef.getElementById(fieldId);
            if (field) field.classList.toggle('hidden', !usesOpenAiImageControls);
        });
        const note = documentRef.getElementById(`${id}-resolution-param-note`);
        if (note) note.classList.toggle('hidden', !usesOpenAiImageControls);
        const searchField = documentRef.getElementById(`${id}-search-field`);
        if (searchField) searchField.classList.toggle('hidden', usesOpenAiImageControls || isNewApiAsyncImage);
        const maskPort = documentRef.querySelector(`.node-port[data-node-id="${id}"][data-port="mask"][data-direction="input"]`);
        if (maskPort) {
            const wasHidden = maskPort.classList.contains('hidden');
            maskPort.classList.toggle('hidden', !usesOpenAiImageControls || isNewApiAsyncImage);
            maskPort.setAttribute('aria-hidden', usesOpenAiImageControls && !isNewApiAsyncImage ? 'false' : 'true');
            if (wasHidden !== maskPort.classList.contains('hidden')) updateAllConnections();
        }
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
            if (node.type === 'ImageGenerate' || node.type === 'VideoGenerate' || node.type === 'TextChat') {
                const modelSelect = documentRef.getElementById(`${id}-apiconfig`);
                const providerSelect = documentRef.getElementById(`${id}-provider`);
                const providerField = documentRef.getElementById(`${id}-provider-field`);
                if (!modelSelect) continue;

                const currentModelId = modelSelect.value;
                const currentProviderId = providerSelect?.value || node.providerId || '';
                const taskType = node.type === 'ImageGenerate'
                    ? 'image'
                    : (node.type === 'VideoGenerate' ? 'video' : 'chat');
                const models = getModelsForTask(state.models, taskType);
                if (models.length === 0) {
                    modelSelect.innerHTML = '<option value="">-- 暂无可用模型 --</option>';
                    modelSelect.value = '';
                    if (providerSelect) providerSelect.innerHTML = '<option value="">-- 暂无可用供应商 --</option>';
                    if (providerField) providerField.classList.add('hidden');
                    node.providerId = '';
                    continue;
                }

                modelSelect.innerHTML = models
                    .map((model) => `<option value="${model.id}">${dialogs.escapeHtml(model.name || model.modelId || model.id)}</option>`)
                    .join('');
                const selectedModel = models.find((model) => model.id === currentModelId) || models[0];
                modelSelect.value = selectedModel.id;

                if (providerSelect && providerField) {
                    const boundProviders = providerSettings.getModelBoundProviders(selectedModel);
                    if (boundProviders.length > 0) {
                        providerSelect.innerHTML = boundProviders
                            .map((provider) => `<option value="${provider.id}">${dialogs.escapeHtml(provider.name || provider.id)}</option>`)
                            .join('');
                        providerSelect.value = providerSettings.getResolvedModelProviderId(selectedModel, currentProviderId);
                        providerField.classList.remove('hidden');
                    } else {
                        providerSelect.innerHTML = '<option value="">-- 暂无可用供应商 --</option>';
                        providerSelect.value = providerSettings.getResolvedModelProviderId(selectedModel, currentProviderId);
                        providerField.classList.add('hidden');
                    }
                }

                node.providerId = providerSettings.getResolvedModelProviderId(selectedModel, providerSelect?.value || currentProviderId);
                if (node.type === 'ImageGenerate') syncImageGenerateResolutionOptions(id);
                if (node.type === 'VideoGenerate' || node.type === 'TextChat') {
                    providerSelect?.dispatchEvent(new windowRef.Event('change', { bubbles: true }));
                }
            }
        }
    }

    function addModel() {
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
        store.modelCollapseState.set(newModelId, false);
        renderModels();
        updateAllNodeModelDropdowns();
        saveState();
        windowRef.setTimeout(() => {
            documentRef.getElementById('settings-body').scrollTop = 9999;
        }, 50);
    }

    return {
        getProviderModelListUrl,
        shouldFetchVectorEnginePricing,
        getOpenAiProviderBaseUrl,
        getNewApiPricingUrl,
        normalizeFetchedModelId,
        inferFetchedModelTaskType,
        getFetchedModelTaskTypeLabel,
        inferFetchedModelProtocol,
        normalizeFetchedModelName,
        parseNewApiPricingModels,
        parseFetchedModels,
        mergeFetchedModels,
        fetchProviderModelPayload,
        fetchVectorEnginePricingModels,
        findMatchingModelConfig,
        modelAlreadyExists,
        addFetchedModel,
        getModelRequestPreview,
        getModelProtocolHelp,
        fetchProviderModels,
        renderModels,
        syncImageGenerateResolutionOptions,
        updateAllNodeModelDropdowns,
        collapseAllModelConfigCards,
        addModel
    };
}
