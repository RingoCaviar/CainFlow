/**
 * Handles provider rendering, validation, bindings, and provider-side card state.
 */
import {
    getModelProviderIds,
    getResolvedProviderForModel,
    getResolvedProviderIdForModel,
    normalizeAutoCompleteBase,
    normalizeProviderEndpointUrl,
    normalizeProviderType
} from '../execution/provider-request-utils.js';
import { API_PROVIDERS_LOCKED, DEFAULT_PROVIDERS } from '../../core/constants.js';

export function createProviderSettings({ ctx, store, dialogs, getDeps }) {
    const {
        state,
        providersList,
        documentRef,
        windowRef,
        showToast,
        saveState
    } = ctx;

    function getEndpointHost(endpoint) {
        const raw = String(endpoint || '').trim();
        if (!raw) return '';
        try {
            const url = new URL(normalizeProviderEndpointUrl(raw));
            return String(url.hostname || '').trim().toLowerCase().replace(/\.$/, '');
        } catch {
            return '';
        }
    }

    function sanitizeProviderEndpointInput(value) {
        return String(value || '')
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/[\u0000-\u001F\u007F]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function validateProviderEndpoint(value) {
        const endpoint = sanitizeProviderEndpointInput(value);
        if (!endpoint) {
            return { valid: false, sanitized: endpoint, message: 'API 地址不能为空' };
        }
        if (endpoint.length > 2048) {
            return { valid: false, sanitized: endpoint.slice(0, 2048), message: 'API 地址过长，最多允许 2048 个字符' };
        }
        if (/\s/.test(endpoint)) {
            return { valid: false, sanitized: endpoint, message: 'API 地址不能包含空格、换行或制表符' };
        }

        let parsedUrl = null;
        const normalizedEndpoint = normalizeProviderEndpointUrl(endpoint);
        try {
            parsedUrl = new URL(normalizedEndpoint);
        } catch {
            return { valid: false, sanitized: endpoint, message: 'API 地址不是合法的 URL' };
        }

        const protocol = String(parsedUrl.protocol || '').toLowerCase();
        if (protocol !== 'http:' && protocol !== 'https:') {
            return { valid: false, sanitized: endpoint, message: 'API 地址只支持 HTTP 或 HTTPS' };
        }
        if (!parsedUrl.hostname || parsedUrl.hostname.length > 253) {
            return { valid: false, sanitized: endpoint, message: 'API 地址缺少有效主机名' };
        }

        return { valid: true, sanitized: normalizedEndpoint, message: '' };
    }

    function getSafeProviderName(provider) {
        return String(provider?.name || '').trim() || '未命名供应商';
    }

    function is6789ApiEndpoint(endpoint) {
        const host = getEndpointHost(endpoint);
        return host === '6789api.top' || host.endsWith('.6789api.top');
    }

    function isVectorEngineEndpoint(endpoint) {
        const host = getEndpointHost(endpoint);
        return host === 'vectorengine.ai' || host === 'api.vectorengine.ai' || host.endsWith('.vectorengine.ai');
    }

    function getModelFetchProtocol(provider) {
        if (is6789ApiEndpoint(provider?.endpoint)) return 'openai';
        if (isVectorEngineEndpoint(provider?.endpoint)) return 'openai';
        return normalizeProviderType(provider?.type, provider, 'openai') || 'openai';
    }

    function syncModelProviderBindings(model) {
        const rawProviderIds = getModelProviderIds(model);
        const fallbackProviderId = state.providers[0]?.id || '';
        const providerIds = API_PROVIDERS_LOCKED
            ? (rawProviderIds.length > 0 ? rawProviderIds : (fallbackProviderId ? [fallbackProviderId] : []))
            : rawProviderIds.filter((providerId) => (
                state.providers.some((provider) => provider.id === providerId)
            ));
        model.providerIds = providerIds;
        model.providerId = providerIds[0] || '';
        return providerIds;
    }

    function getVisibleSettingsProviders() {
        if (!API_PROVIDERS_LOCKED) return state.providers;
        const defaultProviderIds = new Set(DEFAULT_PROVIDERS.map((provider) => provider.id));
        return state.providers.filter((provider) => defaultProviderIds.has(provider.id));
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

    function getProviderEndpointPreview(endpoint, autoComplete, protocol = '') {
        const base = (endpoint || '').replace(/\/+$/, '');
        if (!base) return '请输入 API 地址';
        if (autoComplete === false) return `${base} (直接使用，不补全)`;
        normalizeAutoCompleteBase(base, protocol);
        return `${base} (作为基址；最终路径由模型兼容格式自动补全)`;
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

    function collapseAllProviderConfigCards() {
        state.providers.forEach((provider) => {
            store.providerCollapseState.set(provider.id, true);
        });
    }

    function isCardHeaderControlClick(event) {
        return !!event.target.closest('input, select, textarea, button, label, a');
    }

    function toggleProviderConfigCard(id) {
        store.providerCollapseState.set(id, !(store.providerCollapseState.get(id) !== false));
        renderProviders();
    }

    function addProvider() {
        if (API_PROVIDERS_LOCKED) {
            showToast('API 供应商已锁定，无法添加供应商', 'info');
            return;
        }

        const deps = getDeps();
        const newProviderId = 'prov_' + Math.random().toString(36).substr(2, 9);
        state.providers.push({
            id: newProviderId,
            name: '新供应商',
            type: 'google',
            apikey: '',
            endpoint: 'https://generativelanguage.googleapis.com',
            autoComplete: true
        });
        store.providerCollapseState.set(newProviderId, false);
        renderProviders();
        deps.renderModels();
        deps.updateAllNodeModelDropdowns();
        saveState();
    }

    function renderProviders() {
        const addProviderButton = documentRef.getElementById('btn-add-provider');
        if (addProviderButton) {
            addProviderButton.classList.toggle('hidden', API_PROVIDERS_LOCKED);
            addProviderButton.disabled = API_PROVIDERS_LOCKED;
        }

        providersList.innerHTML = '';
        const visibleProviders = getVisibleSettingsProviders();
        if (visibleProviders.length === 0) {
            providersList.innerHTML = '<div style="color:var(--text-secondary);text-align:center;padding:20px;font-size:12px;">暂无供应商配置</div>';
            return;
        }

        syncCollapseState(visibleProviders, store.providerCollapseState);

        visibleProviders.forEach((prov) => {
            const isCollapsed = store.providerCollapseState.get(prov.id) !== false;
            const el = documentRef.createElement('div');
            el.className = `api-config-card provider-config-card${isCollapsed ? ' is-collapsed' : ''}`;
            el.dataset.providerId = prov.id;
            el.innerHTML = `
                <div class="card-header">
                    <input type="text" class="card-name" value="${prov.name}" placeholder="供应商名称" data-id="${prov.id}" data-field="name" ${isCollapsed ? 'readonly tabindex="-1" aria-label="点击展开供应商配置"' : ''} style="background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.2);padding:2px 4px;font-size:14px;color:var(--accent-cyan);width:150px" />
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
            const updatePreview = (id, endpointOverride = null) => {
                const prov = state.providers.find((candidate) => candidate.id === id);
                const previewEl = documentRef.getElementById(`ep-preview-${id}`);
                if (prov && previewEl) {
                    const previewEndpoint = endpointOverride === null ? prov.endpoint : endpointOverride;
                    previewEl.textContent = '连接说明：' + getProviderEndpointPreview(previewEndpoint, prov.autoComplete, normalizeProviderType(prov.type, prov));
                }
            };

            input.addEventListener('change', (event) => {
                const deps = getDeps();
                const id = event.target.dataset.id;
                const field = event.target.dataset.field;
                const prov = state.providers.find((candidate) => candidate.id === id);
                if (!prov) return;
                if (API_PROVIDERS_LOCKED && (field === 'endpoint' || field === 'autoComplete')) {
                    event.target.value = prov[field] ?? '';
                    if (field === 'autoComplete') event.target.checked = prov.autoComplete !== false;
                    updatePreview(id);
                    return;
                }

                if (field === 'autoComplete') {
                    prov.autoComplete = event.target.checked;
                    updatePreview(id);
                } else if (field === 'endpoint') {
                    const validation = validateProviderEndpoint(event.target.value);
                    if (!validation.valid) {
                        event.target.value = prov.endpoint || '';
                        updatePreview(id);
                        showToast(validation.message, 'error');
                        return;
                    }
                    prov.endpoint = validation.sanitized;
                    event.target.value = validation.sanitized;
                } else {
                    prov[field] = event.target.value;
                }

                saveState();
                deps.renderModels();
                deps.updateAllNodeModelDropdowns();
                updatePreview(id);
            });

            if (input.dataset.field === 'endpoint') {
                input.addEventListener('input', (event) => {
                    const id = event.target.dataset.id;
                    const prov = state.providers.find((candidate) => candidate.id === id);
                    if (!prov) return;
                    if (API_PROVIDERS_LOCKED) {
                        event.target.value = prov.endpoint || '';
                        updatePreview(id);
                        return;
                    }
                    const sanitized = sanitizeProviderEndpointInput(event.target.value);
                    if (sanitized !== event.target.value) {
                        event.target.value = sanitized;
                    }
                    updatePreview(id, sanitized);
                });
            }
        });

        providersList.querySelectorAll('.card-btn-delete').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                if (!windowRef.confirm('确定删除此供应商吗？绑定的模型可能会失效。')) return;
                const deps = getDeps();
                const providerId = event.target.dataset.id;
                state.providers = state.providers.filter((candidate) => candidate.id !== providerId);
                state.models.forEach((model) => {
                    model.providerIds = getModelProviderIds(model).filter((id) => id !== providerId);
                    syncModelProviderBindings(model);
                });
                renderProviders();
                deps.renderModels();
                deps.updateAllNodeModelDropdowns();
                saveState();
            });
        });

        providersList.querySelectorAll('.card-btn-fetch-models').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                const deps = getDeps();
                const { id } = event.currentTarget.dataset;
                deps.fetchProviderModels(id);
            });
        });

        providersList.querySelectorAll('.card-btn-collapse').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                const { id } = event.currentTarget.dataset;
                toggleProviderConfigCard(id);
            });
        });

        providersList.querySelectorAll('.provider-config-card').forEach((card) => {
            card.addEventListener('click', (event) => {
                const isCollapsedCard = card.classList.contains('is-collapsed');
                const clickedHeader = event.target.closest('.card-header');
                if (!isCollapsedCard && !clickedHeader) return;
                if (event.target.closest('.card-btn-fetch-models, .card-btn-delete, .card-btn-collapse, button, select, textarea, label, a')) return;
                if (!isCollapsedCard && isCardHeaderControlClick(event)) return;

                const id = card.dataset.providerId || card.querySelector('.card-btn-collapse')?.dataset.id;
                if (!id) return;
                event.preventDefault();
                toggleProviderConfigCard(id);
            });
        });
    }

    return {
        getEndpointHost,
        getSafeProviderName,
        is6789ApiEndpoint,
        isVectorEngineEndpoint,
        getModelFetchProtocol,
        sanitizeProviderEndpointInput,
        validateProviderEndpoint,
        syncModelProviderBindings,
        getVisibleSettingsProviders,
        getModelBoundProviders,
        getResolvedModelProvider,
        getResolvedModelProviderId,
        getModelProviderSummary,
        getProviderEndpointPreview,
        collapseAllProviderConfigCards,
        renderProviders,
        addProvider
    };
}
