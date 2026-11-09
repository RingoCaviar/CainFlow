import { confirmAction } from '../ui/app-dialogs.js';
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
import { bindSettingsCardOrder, reorderItemsById } from './settings-card-order.js';
import { bindCardToggleGestureGuard } from './card-toggle-gesture.js';

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

    function isVectorEngineEndpoint(endpoint) {
        const host = getEndpointHost(endpoint);
        return host === 'vectorengine.ai' || host === 'api.vectorengine.ai' || host.endsWith('.vectorengine.ai');
    }

    function isTtapiEndpoint(endpoint) {
        const host = getEndpointHost(endpoint);
        return host === 'ttapi.org' || host === 'api.ttapi.org' || host.endsWith('.ttapi.org');
    }

    function isTtapiOpenAiEndpoint(endpoint) {
        const host = getEndpointHost(endpoint);
        return host === 'ttapi.io' || host === 'api.ttapi.io' || host.endsWith('.ttapi.io');
    }

    function getModelFetchProtocol(provider) {
        if (getEndpointHost(provider?.endpoint) === 'api.openai.com') return 'openai';
        if (isVectorEngineEndpoint(provider?.endpoint)) return 'openai';
        if (isTtapiOpenAiEndpoint(provider?.endpoint)) return 'ttapi-openai';
        if (isTtapiEndpoint(provider?.endpoint)) return 'ttapi';
        return normalizeProviderType(provider?.type, provider, 'openai') || 'openai';
    }

    function syncModelProviderBindings(model) {
        const rawProviderIds = getModelProviderIds(model);
        const providerIds = rawProviderIds.filter((providerId) => (
            state.providers.some((provider) => provider.id === providerId)
        ));
        model.providerIds = providerIds;
        model.providerId = providerIds[0] || '';
        return providerIds;
    }

    function getVisibleSettingsProviders() {
        return state.providers;
    }

    function getModelBoundProviders(model) {
        const boundProviderIds = new Set(getModelProviderIds(model));
        return state.providers.filter((provider) => boundProviderIds.has(provider.id));
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
        return !!event.target.closest('input, select, textarea, button, label, a, .card-drag-handle');
    }

    function toggleProviderConfigCard(id) {
        store.providerCollapseState.set(id, !(store.providerCollapseState.get(id) !== false));
        renderProviders();
    }

    function addProvider() {
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
            addProviderButton.classList.remove('hidden');
            addProviderButton.disabled = false;
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
            const controlId = `provider-${encodeURIComponent(prov.id)}`;
            const toggleLabel = `${isCollapsed ? '展开' : '收起'}供应商配置：${getSafeProviderName(prov)}`;
            const el = documentRef.createElement('div');
            el.className = `api-config-card provider-config-card${isCollapsed ? ' is-collapsed' : ''}`;
            el.dataset.providerId = prov.id;
            el.innerHTML = `
                <div class="card-header">
                    <span class="card-drag-handle" draggable="true" role="img" aria-label="拖动以调整供应商顺序" title="拖动排序">⠿</span>
                    <label class="card-name-editor">
                        <input type="text" class="card-name" value="${dialogs.escapeHtml(prov.name || '')}" placeholder="供应商名称" aria-label="供应商名称" data-id="${prov.id}" data-field="name" />
                        <svg class="card-name-edit-icon" aria-hidden="true" focusable="false"><use href="#icon-pencil" /></svg>
                    </label>
                    <div class="card-header-actions">
                        <button type="button" class="card-btn-disclosure" id="${controlId}-toggle" data-id="${prov.id}" aria-expanded="${!isCollapsed}" aria-controls="${controlId}-details" aria-label="${dialogs.escapeHtml(toggleLabel)}" title="${isCollapsed ? '展开' : '收起'}供应商配置">
                            <svg class="card-disclosure-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6" /></svg>
                        </button>
                        <button class="card-btn-fetch-models" data-id="${prov.id}" title="获取此供应商的模型列表" aria-label="获取此供应商的模型列表"><svg class="card-fetch-icon" aria-hidden="true" focusable="false"><use href="#icon-download" /></svg><span class="card-fetch-label">获取模型列表</span></button>
                        ${prov.id !== 'prov_default' ? `<button type="button" class="card-btn-delete" data-id="${prov.id}" data-target="provider" title="删除此供应商" aria-label="删除此供应商"><svg class="card-delete-icon" aria-hidden="true" focusable="false"><use href="#icon-trash" /></svg></button>` : ''}
                    </div>
                </div>
                <div class="card-collapsible" id="${controlId}-details" style="display:${isCollapsed ? 'none' : 'flex'};">
                    <div class="card-row">
                        <div class="card-field">
                            <label for="${controlId}-apikey">API 密钥</label>
                            <form class="password-wrapper" onsubmit="return false;">
                                <input type="text" value="${dialogs.escapeHtml(prov.name || '')}" autocomplete="username" tabindex="-1" aria-hidden="true" style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;" />
                                <input id="${controlId}-apikey" type="password" value="${prov.apikey}" placeholder="API Key" data-id="${prov.id}" data-field="apikey" spellcheck="false" autocomplete="new-password" />
                                <button type="button" class="eye-toggle-btn" data-id="${prov.id}" title="显示/隐藏密钥">
                                    <svg class="icon-xs"><use href="#icon-eye"/></svg>
                                </button>
                            </form>
                        </div>
                        <div class="card-field"><label for="${controlId}-endpoint">API 地址</label><input id="${controlId}-endpoint" type="text" value="${prov.endpoint}" placeholder="Endpoint URL" data-id="${prov.id}" data-field="endpoint" /></div>
                        <div class="card-field"><label for="${controlId}-responses-endpoint">独立 Responses 地址（关闭自动补全时用于 Agent 搜索）</label><input id="${controlId}-responses-endpoint" type="text" value="${String(prov.responsesEndpoint || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}" placeholder="https://…/v1/responses" data-id="${prov.id}" data-field="responsesEndpoint" /></div>
                    </div>
                    <div class="provider-toggle-row">
                        <div class="endpoint-preview" id="ep-preview-${prov.id}" style="font-size:12px;word-break:break-all;line-height:1.4;flex:1;">连接说明：${getProviderEndpointPreview(prov.endpoint, prov.autoComplete, normalizeProviderType(prov.type, prov))}</div>
                        <label class="settings-toggle-row provider-toggle-label">
                            <span class="settings-toggle-text">自动补全</span>
                            <span class="toggle-switch">
                                <input type="checkbox" ${prov.autoComplete !== false ? 'checked' : ''} data-id="${prov.id}" data-field="autoComplete" />
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

                if (field === 'autoComplete') {
                    prov.autoComplete = event.target.checked;
                    updatePreview(id);
                } else if (field === 'responsesEndpoint') {
                    const value = event.target.value.trim();
                    const validation = value ? validateProviderEndpoint(value) : { valid: true, sanitized: '' };
                    if (!validation.valid) { event.target.value = prov.responsesEndpoint || ''; showToast(validation.message, 'warning'); return; }
                    prov.responsesEndpoint = validation.sanitized;
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

                if (field === 'name') {
                    const toggle = event.target.closest('.provider-config-card')?.querySelector('.card-btn-disclosure');
                    const action = store.providerCollapseState.get(id) !== false ? '展开' : '收起';
                    toggle?.setAttribute('aria-label', `${action}供应商配置：${getSafeProviderName(prov)}`);
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
                    const sanitized = sanitizeProviderEndpointInput(event.target.value);
                    if (sanitized !== event.target.value) {
                        event.target.value = sanitized;
                    }
                    updatePreview(id, sanitized);
                });
            }
        });

        providersList.querySelectorAll('.card-btn-delete').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const providerId = btn.dataset.id;
                if (!await confirmAction({ documentRef, title: '删除供应商', message: '确定删除此供应商吗？绑定的模型可能会失效。', confirmLabel: '删除供应商', danger: true })) return;
                const deps = getDeps();
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

        providersList.querySelectorAll('.card-btn-disclosure').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                const { id } = event.currentTarget.dataset;
                const toggleId = event.currentTarget.id;
                toggleProviderConfigCard(id);
                documentRef.getElementById(toggleId)?.focus({ preventScroll: true });
            });
        });

        providersList.querySelectorAll('.provider-config-card').forEach((card) => {
            const toggleGestureGuard = bindCardToggleGestureGuard({ card, documentRef, windowRef });
            card.addEventListener('click', (event) => {
                if (toggleGestureGuard.consumeToggleSuppression()) return;
                const isCollapsedCard = card.classList.contains('is-collapsed');
                const clickedHeader = event.target.closest('.card-header');
                if (!isCollapsedCard && !clickedHeader) return;
                if (event.target.closest('.card-btn-fetch-models, .card-btn-delete, button, select, textarea, label, a, .card-drag-handle')) return;
                if (isCardHeaderControlClick(event)) return;

                const id = card.dataset.providerId;
                if (!id) return;
                event.preventDefault();
                toggleProviderConfigCard(id);
            });
        });

        bindSettingsCardOrder({
            list: providersList,
            cardSelector: '.provider-config-card',
            idAttribute: 'providerId',
            documentRef,
            windowRef,
            onCommit(orderedIds) {
                const deps = getDeps();
                state.providers = reorderItemsById(state.providers, orderedIds);
                renderProviders();
                deps.renderModels();
                deps.updateAllNodeModelDropdowns();
                saveState();
            }
        });
    }

    return {
        getEndpointHost,
        getSafeProviderName,
        isVectorEngineEndpoint,
        isTtapiEndpoint,
        isTtapiOpenAiEndpoint,
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
