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
    updateAllConnections = () => {},
    applyGlobalAnimationSetting = () => {},
    fitNodeToContent = () => {},
    documentRef = document,
    windowRef = window,
    localStorageRef = localStorage,
    fetchImpl = fetch
}) {
    const providerCollapseState = new Map();
    const modelCollapseState = new Map();
    const getProxyHeaders = createProxyHeadersGetter(() => state);
    const modelFetchDialogState = {
        providerId: '',
        models: [],
        query: '',
        loading: false,
        error: ''
    };
    let openModelProviderPanelId = '';

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

    function getModelFetchProtocol(provider) {
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

    function normalizeFetchedModelId(rawId) {
        return String(rawId || '').replace(/^models\//, '').trim();
    }

    function inferFetchedModelTaskType(modelId, sourceModel = {}) {
        const fingerprint = `${modelId} ${sourceModel.displayName || ''} ${sourceModel.name || ''}`.toLowerCase();
        if (
            fingerprint.includes('image') ||
            fingerprint.includes('banana') ||
            fingerprint.includes('dall-e') ||
            fingerprint.includes('gpt-image') ||
            fingerprint.includes('imagen')
        ) {
            return 'image';
        }
        return 'chat';
    }

    function inferFetchedModelProtocol(provider, fetchedModel = {}) {
        const fingerprint = `${fetchedModel.id || ''} ${fetchedModel.name || ''}`.toLowerCase();
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
        return String(sourceModel.displayName || sourceModel.id || modelId || '').replace(/^models\//, '').trim() || modelId;
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

    function findMatchingModelConfig(modelId, protocol, taskType) {
        return state.models.find((model) => {
            const provider = getResolvedModelProvider(model);
            return model.modelId === modelId &&
                normalizeModelTaskType(model.taskType, model) === normalizeModelTaskType(taskType, model) &&
                normalizeModelProtocol(model.protocol, model, provider) === protocol;
        }) || null;
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
        const saveBtn = documentRef.getElementById('btn-test-proxy');
        const fieldsDiv = documentRef.getElementById('proxy-settings-fields');

        try {
            const res = await fetchImpl('/api/proxy');
            if (!res.ok) return;

            const config = await res.json();
            const newCheck = enabledCheck.cloneNode(true);
            const newIp = ipInput.cloneNode(true);
            const newPort = portInput.cloneNode(true);
            const newTestBtn = saveBtn.cloneNode(true);

            enabledCheck.parentNode.replaceChild(newCheck, enabledCheck);
            ipInput.parentNode.replaceChild(newIp, ipInput);
            portInput.parentNode.replaceChild(newPort, portInput);
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
                } catch (e) {
                    showToast('保存代理设置异常: ' + e, 'error');
                }
            };

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
            ? '正在获取模型列表...'
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

        const protocol = getModelFetchProtocol(provider);
        const url = getProviderModelListUrl(provider, protocol);
        modelFetchDialogState.providerId = providerId;
        modelFetchDialogState.models = [];
        modelFetchDialogState.error = '';
        modelFetchDialogState.loading = true;
        renderProviderModelsDialog();

        try {
            if (!url) throw new Error('请先填写供应商 API 地址');
            if (!provider.apikey && protocol === 'google') throw new Error('请先填写供应商 API 密钥');

            const headers = protocol === 'openai' && provider.apikey
                ? getProxyHeaders(url, 'GET', {
                    Accept: 'application/json',
                    Authorization: `Bearer ${provider.apikey}`
                })
                : getProxyHeaders(url, 'GET', { Accept: 'application/json' });
            const response = await fetchImpl('/proxy', {
                method: 'POST',
                headers
            });
            const responseText = await response.text();
            if (!response.ok) {
                throw new Error(responseText || `请求失败 (${response.status})`);
            }

            let payload = null;
            try {
                payload = JSON.parse(responseText);
            } catch {
                throw new Error('供应商没有返回有效的 JSON 模型列表');
            }

            const models = parseFetchedModels(payload, protocol);
            modelFetchDialogState.models = models;
            modelFetchDialogState.error = models.length ? '' : '供应商返回的模型列表为空';
            showToast(`已获取 ${models.length} 个模型`, models.length ? 'success' : 'info');
        } catch (error) {
            const message = error?.message || String(error);
            modelFetchDialogState.error = `获取失败：${message}`;
            showToast(modelFetchDialogState.error, 'error');
        } finally {
            modelFetchDialogState.loading = false;
            renderProviderModelsDialog();
        }
    }

    function renderProviders() {
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
                        ${prov.id !== 'prov_default' ? `<button class="card-btn-delete" data-id="${prov.id}" data-target="provider" title="删除此供应商">×</button>` : ''}
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
                        <div class="card-field"><label>API 地址</label><input type="text" value="${prov.endpoint}" placeholder="Endpoint URL" data-id="${prov.id}" data-field="endpoint" /></div>
                    </div>
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px;">
                        <div class="endpoint-preview" id="ep-preview-${prov.id}" style="font-size:12px;color:var(--text-dim);word-break:break-all;line-height:1.4;opacity:0.75;flex:1;">连接说明：${getProviderEndpointPreview(prov.endpoint, prov.autoComplete, normalizeProviderType(prov.type, prov))}</div>
                        <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-dim);cursor:pointer;white-space:nowrap;flex-shrink:0;">
                            <input type="checkbox" ${prov.autoComplete !== false ? 'checked' : ''} data-id="${prov.id}" data-field="autoComplete" style="accent-color:var(--accent-purple);cursor:pointer;" />
                            自动补全
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
                        <button class="card-btn-collapse" data-id="${mod.id}" data-target="model" title="${isCollapsed ? '展开此模型' : '折叠此模型'}" aria-expanded="${isCollapsed ? 'false' : 'true'}">${isCollapsed ? '▸' : '▾'}</button>
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

        modelsList.querySelectorAll('.card-btn-collapse').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const { id } = e.currentTarget.dataset;
                toggleConfigCard(modelCollapseState, id, renderModels);
            });
        });

        modelsList.querySelectorAll('.api-config-card .card-header').forEach((header) => {
            header.addEventListener('click', (e) => {
                if (isCardHeaderControlClick(e)) return;
                const id = header.querySelector('.card-btn-collapse')?.dataset.id;
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
        const globalAnimationEnabled = state.globalAnimationEnabled !== false;
        const updateStatus = localStorageRef.getItem('cainflow_update_status') || 'unknown';
        const lastCheck = localStorageRef.getItem('cainflow_last_update_check');
        const latestVer = localStorageRef.getItem('cainflow_update_version') || '';
        const updateError = localStorageRef.getItem('cainflow_update_error') || '检查失败，请检查网络连接或代理设置';
        const serverVersionText = latestVer || (updateStatus === 'checking' ? '检查中...' : '尚未获取');
        const escapeHtml = (value) => String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        let statusHtml = '';
        const timeStr = lastCheck ? new Date(parseInt(lastCheck, 10)).toLocaleString() : '从未检查';

        if (updateStatus === 'checking') statusHtml = `<span class="update-status-loading">正在检查中...</span>`;
        else if (updateStatus === 'latest') statusHtml = `<span class="update-status-latest">✓ 当前已是最新版本</span>`;
        else if (updateStatus === 'new_version') {
            statusHtml = `
                <div style="display:flex; align-items:center; gap:10px;">
                    <span class="update-status-new">发现新版本 ${latestVer}</span>
                    <button id="btn-goto-download" class="btn btn-secondary btn-sm" style="animation: glow-pulse 2.5s infinite">前往下载</button>
                </div>
            `;
        } else if (updateStatus === 'error') statusHtml = `<span class="update-status-error" title="${escapeHtml(updateError)}">✗ ${escapeHtml(updateError)}</span>`;

        list.innerHTML = `
        <div style="display: flex; gap: 16px; align-items: stretch; margin-bottom: 16px;">
            <div class="api-config-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">图片处理设置</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
                    <div class="card-field" style="margin-bottom: 14px;">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px;">
                            <label style="margin:0;">导入时自动缩放</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-auto-resize-enabled" ${autoResizeEnabled ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); line-height: 1.4;">开启后，超出阈值的大图会在导入时自动缩小；关闭后将保留原图。</p>
                    </div>
                    <div class="card-field">
                        <label>图片导入自适应缩放阈值 (边长)</label>
                        <div style="display:flex; align-items:center; gap:8px; opacity:${autoResizeEnabled ? '1' : '0.55'};">
                            <input type="number" id="setting-max-side" value="${currentSide}" placeholder="如: 2048" style="flex:1" ${autoResizeEnabled ? '' : 'disabled'} />
                            <span id="pixels-hint" style="font-size:11px; color:var(--text-dim); min-width:60px;">${(state.imageMaxPixels / 1000000).toFixed(1)} MP</span>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px; line-height: 1.4;">提示：阈值按边长换算为总像素上限，仅在自动缩放开启时生效。</p>
                    </div>
                </div>
            </div>

            <div class="api-config-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">存储设置</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
                    <div class="card-field">
                        <label>全局图片保存目录</label>
                        <div style="display:flex; align-items:center; gap:8px;">
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
                </div>
            </div>

            <div class="api-config-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">自动化与重试</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 14px;">
                    <div class="card-field">
                        <label>最大自动重试次数</label>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <div class="retry-input-group" style="display:flex; align-items:center; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.1); border-radius:6px; overflow:hidden; flex:1;">
                                <button class="btn-retry-step" data-step="-1" style="background:transparent; border:none; color:var(--text-secondary); width:32px; height:32px; cursor:pointer; font-size:16px; transition:all 0.2s; display:flex; align-items:center; justify-content:center;">-</button>
                                <input type="number" id="setting-max-retries" value="${state.maxRetries || 15}" min="1" max="100" style="flex:1; background:transparent; border:none; border-left:1px solid rgba(255,255,255,0.05); border-right:1px solid rgba(255,255,255,0.05); text-align:center; padding:0; height:32px; color:var(--accent-purple); font-weight:600; -moz-appearance: textfield;" />
                                <button class="btn-retry-step" data-step="1" style="background:transparent; border:none; color:var(--text-secondary); width:32px; height:32px; cursor:pointer; font-size:16px; transition:all 0.2s; display:flex; align-items:center; justify-content:center;">+</button>
                            </div>
                            <span style="font-size:11px; color:var(--text-dim); min-width:20px;">轮</span>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px; line-height: 1.4;">提示：初始失败后，最多允许再尝试执行多少轮。</p>
                    </div>
                    <div class="card-field">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px;">
                            <label style="margin:0;">请求超时设置</label>
                            <label class="switch">
                                <input type="checkbox" id="setting-timeout-enabled" ${state.requestTimeoutEnabled ? 'checked' : ''}>
                                <span class="slider"></span>
                            </label>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px; opacity:${state.requestTimeoutEnabled ? '1' : '0.55'};">
                            <input type="number" id="setting-timeout-seconds" value="${state.requestTimeoutSeconds || 60}" min="1" step="1" ${state.requestTimeoutEnabled ? '' : 'disabled'} style="flex:1" />
                            <span style="font-size:11px; color:var(--text-dim); min-width:20px;">秒</span>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px; line-height: 1.4;">默认关闭。关闭时会一直等待服务器返回；开启后超过设定秒数仍未返回则判定超时失败。</p>
                    </div>
                </div>
            </div>
        </div>

        <div style="display: flex; gap: 16px; align-items: stretch;">
            <div class="api-config-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">画布连线</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
                    <div class="card-field">
                        <label>连线类型</label>
                        <select id="setting-connection-line-type" style="width:100%;">
                            <option value="bezier" ${connectionLineType === 'bezier' ? 'selected' : ''}>贝塞尔曲线</option>
                            <option value="orthogonal" ${connectionLineType === 'orthogonal' ? 'selected' : ''}>直角连线（圆角）</option>
                        </select>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px; line-height:1.4;">切换后会立即更新当前画布中的全部连线，直角连线会在拐点保留小圆角。</p>
                    </div>
                    <div class="card-field" style="margin-top:14px;">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px;">
                            <label style="margin:0;">全局动画开关</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-global-animation-enabled" ${globalAnimationEnabled ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); line-height:1.4;">默认开启。关闭后会禁用全局动画效果，包括连线流动箭头、弹窗渐入渐出、按钮过渡和提示动画，以释放最大性能。</p>
                    </div>
                </div>
            </div>
            <div class="api-config-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">通知设置</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
                    <div class="card-field">
                        <label>完成音效音量</label>
                        <div style="display:flex; align-items:center; gap:12px;">
                            <input type="range" id="setting-notify-volume" class="notification-volume-slider" min="0" max="1" step="0.05" value="${state.notificationVolume}" style="flex:1" />
                            <span id="volume-hint" style="font-size:12px; color:var(--text-dim); min-width:40px;">${Math.round(state.notificationVolume * 100)}%</span>
                            <button id="btn-test-sound" class="btn btn-ghost" style="padding:4px 8px; font-size:11px;">测试音效</button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="api-config-card" style="flex: 1; margin-top: 0; display: flex; flex-direction: column;">
                <div class="card-header">
                    <span style="font-size:14px; font-weight:500; color:var(--text-secondary)">系统版本与更新</span>
                </div>
                <div class="card-row" style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
                    <div class="card-field">
                        <label>当前版本与检查结果</label>
                        <div style="display:flex; flex-direction:column; gap:12px; width:100%;">
                            <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
                                <span class="version-badge">${appVersion}</span>
                                <div class="update-status-indicator">${statusHtml}</div>
                            </div>
                            <div class="update-version-summary">
                                <span>本地版本</span>
                                <strong>${appVersion}</strong>
                                <span>服务端版本</span>
                                <strong>${serverVersionText}</strong>
                            </div>
                            <div style="display:flex; flex-direction:column; gap:8px; width:100%;">
                                <button id="btn-goto-download" class="btn btn-secondary" style="width:100%; ${updateStatus === 'new_version' ? 'animation: glow-pulse 2.5s infinite;' : ''}">前往下载</button>
                                <button id="btn-check-update" class="btn btn-secondary" style="width:100%;">检查更新</button>
                            </div>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); margin-top:8px;">最后检查: ${timeStr}</p>
                    </div>
                </div>
            </div>
        </div>
    `;

        const input = documentRef.getElementById('setting-max-side');
        const hint = documentRef.getElementById('pixels-hint');
        const autoResizeInput = documentRef.getElementById('setting-auto-resize-enabled');
        const volInput = documentRef.getElementById('setting-notify-volume');
        const volHint = documentRef.getElementById('volume-hint');
        const testBtn = documentRef.getElementById('btn-test-sound');
        const btnCheckUpdate = documentRef.getElementById('btn-check-update');
        const btnGotoDownload = documentRef.getElementById('btn-goto-download');
        const timeoutEnabledInput = documentRef.getElementById('setting-timeout-enabled');
        const timeoutSecondsInput = documentRef.getElementById('setting-timeout-seconds');
        const connectionLineTypeInput = documentRef.getElementById('setting-connection-line-type');
        const globalAnimationInput = documentRef.getElementById('setting-global-animation-enabled');
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

        btnGotoDownload?.addEventListener('click', () => {
            windowRef.open(`https://github.com/${githubRepo}/releases/latest`, '_blank');
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

        globalAnimationInput?.addEventListener('change', (e) => {
            state.globalAnimationEnabled = e.target.checked;
            state.connectionFlowAnimationEnabled = state.globalAnimationEnabled;
            applyGlobalAnimationSetting();
            updateAllConnections();
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
                        fitNodeToContent(id, { allowShrink: true });
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

    async function getStoreSizeMB(storeName) {
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
                        const val = cursor.value;
                        if (typeof val === 'string') bytes += val.length;
                        else bytes += JSON.stringify(val).length;
                        cursor.continue();
                    } else {
                        resolve((bytes / (1024 * 1024)).toFixed(2));
                    }
                };
                req.onerror = () => resolve('0.00');
            });
        } catch (e) {
            return '0.00';
        }
    }

    function getLocalStorageMB() {
        let bytes = 0;
        try {
            for (let i = 0; i < localStorageRef.length; i++) {
                const key = localStorageRef.key(i);
                const val = localStorageRef.getItem(key);
                bytes += (key.length + val.length) * 2;
            }
        } catch (e) {
            // ignore
        }
        return (bytes / (1024 * 1024)).toFixed(2);
    }

    async function updateCacheUsage(force = false) {
        const display = documentRef.getElementById('cache-size-display');
        const historyEl = documentRef.getElementById('usage-history');
        const assetsEl = documentRef.getElementById('usage-assets');
        const localEl = documentRef.getElementById('usage-local');
        if (!display) return;

        try {
            if (windowRef.navigator.storage && windowRef.navigator.storage.estimate) {
                const estimate = await windowRef.navigator.storage.estimate();
                const mb = (estimate.usage / (1024 * 1024)).toFixed(2);
                display.textContent = `${mb} MB`;
            }

            if (force) {
                state.cacheSizes[storeHistoryName] = null;
                state.cacheSizes[storeAssetsName] = null;
            }

            const historySize = await getStoreSizeMB(storeHistoryName);
            const assetsSize = await getStoreSizeMB(storeAssetsName);
            const localSize = getLocalStorageMB();

            if (historyEl) historyEl.textContent = `${Number(historySize).toFixed(2)} MB`;
            if (assetsEl) assetsEl.textContent = `${Number(assetsSize).toFixed(2)} MB`;
            if (localEl) localEl.textContent = `${Number(localSize).toFixed(2)} MB`;
        } catch (e) {
            display.textContent = '获取失败';
            console.error('Cache audit failed:', e);
        }
    }

    function initSettingsUI({ settingsModalApi }) {
        documentRef.getElementById('btn-settings').addEventListener('click', () => {
            settingsModalApi.openSettingsModal();
        });
        documentRef.getElementById('settings-close').addEventListener('click', () => {
            settingsModalApi.closeSettingsModal(() => state.notificationAudio?.pause());
        });
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) {
                settingsModalApi.closeSettingsModal(() => state.notificationAudio?.pause());
            }
        });

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
