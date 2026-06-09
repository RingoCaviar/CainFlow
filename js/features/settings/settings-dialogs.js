/**
 * Manages settings-owned floating panels, help overlays, and dialogs.
 */
export function createSettingsDialogs({ ctx, store, getDeps }) {
    const {
        state,
        settingsModal,
        modelsList,
        documentRef,
        windowRef
    } = ctx;

    const {
        modelFetchDialogState,
        networkProxyStatusState
    } = store;

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function cleanupFloatingModelProviderPanelListeners() {
        store.floatingModelProviderPanelCleanup.forEach((cleanup) => {
            try {
                cleanup();
            } catch {}
        });
        store.floatingModelProviderPanelCleanup = [];
    }

    function closeFloatingModelProviderPanel({ preserveOpenState = false } = {}) {
        cleanupFloatingModelProviderPanelListeners();
        if (store.floatingModelProviderPanel) {
            store.floatingModelProviderPanel.remove();
            store.floatingModelProviderPanel = null;
        }
        if (!preserveOpenState) {
            store.openModelProviderPanelId = '';
            modelsList?.querySelectorAll?.('.provider-multiselect-trigger')
                .forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'));
        }
    }

    function getModelProviderTrigger(modelId) {
        if (!modelId) return null;
        return modelsList?.querySelector?.(`.provider-multiselect-trigger[data-id="${modelId}"]`) || null;
    }

    function syncFloatingModelProviderPanelPosition() {
        if (!store.floatingModelProviderPanel || !store.openModelProviderPanelId) return;
        const trigger = getModelProviderTrigger(store.openModelProviderPanelId);
        if (!trigger) {
            closeFloatingModelProviderPanel();
            return;
        }
        const rect = trigger.getBoundingClientRect();
        const viewportWidth = windowRef.innerWidth || documentRef.documentElement.clientWidth || 0;
        const viewportHeight = windowRef.innerHeight || documentRef.documentElement.clientHeight || 0;
        const width = Math.max(rect.width, 220);
        const maxHeight = Math.min(280, Math.floor(viewportHeight * 0.42));
        store.floatingModelProviderPanel.style.setProperty('--provider-panel-width', `${width}px`);
        store.floatingModelProviderPanel.style.maxHeight = `${Math.max(160, maxHeight)}px`;

        const panelHeight = Math.min(store.floatingModelProviderPanel.scrollHeight, Math.max(160, maxHeight));
        const spaceBelow = viewportHeight - rect.bottom - 6;
        const spaceAbove = rect.top - 6;
        const top = (spaceBelow >= panelHeight || spaceBelow >= spaceAbove)
            ? rect.bottom + 6
            : Math.max(8, rect.top - panelHeight - 6);
        const left = Math.min(
            Math.max(8, rect.left),
            Math.max(8, viewportWidth - width - 8)
        );

        store.floatingModelProviderPanel.style.top = `${Math.round(top)}px`;
        store.floatingModelProviderPanel.style.left = `${Math.round(left)}px`;
    }

    function renderFloatingModelProviderPanel(modelId, onToggleProvider) {
        closeFloatingModelProviderPanel({ preserveOpenState: true });
        if (!modelId) return;

        const deps = getDeps();
        const model = state.models.find((candidate) => candidate.id === modelId);
        const trigger = getModelProviderTrigger(modelId);
        if (!model || !trigger) {
            store.openModelProviderPanelId = '';
            return;
        }

        const visibleProviders = deps.getVisibleSettingsProviders();
        if (visibleProviders.length === 0) {
            store.openModelProviderPanelId = '';
            return;
        }

        const boundProviderIds = new Set(deps.getModelProviderIds(model));
        const panel = documentRef.createElement('div');
        panel.className = 'provider-multiselect-panel provider-multiselect-panel-floating';
        panel.dataset.id = modelId;
        panel.innerHTML = visibleProviders.map((providerItem) => `
            <div class="provider-multiselect-option" role="option" aria-selected="${boundProviderIds.has(providerItem.id) ? 'true' : 'false'}" data-id="${modelId}" data-provider-id="${providerItem.id}">
                <input type="checkbox" tabindex="-1" aria-hidden="true" data-id="${modelId}" data-field="providerIds" value="${providerItem.id}" ${boundProviderIds.has(providerItem.id) ? 'checked' : ''} />
                <span>${escapeHtml(providerItem.name || providerItem.id)}</span>
            </div>
        `).join('');
        panel.addEventListener('click', (event) => {
            event.stopPropagation();
            const option = event.target.closest('.provider-multiselect-option');
            if (!option) return;
            event.preventDefault();
            onToggleProvider(option.dataset.id, option.dataset.providerId);
        });
        documentRef.body.appendChild(panel);
        store.floatingModelProviderPanel = panel;
        syncFloatingModelProviderPanelPosition();

        const handlePointerDown = (event) => {
            if (panel.contains(event.target)) return;
            const activeTrigger = getModelProviderTrigger(store.openModelProviderPanelId);
            if (activeTrigger?.contains(event.target)) return;
            closeFloatingModelProviderPanel();
            deps.renderModels();
        };
        const handleReposition = () => {
            syncFloatingModelProviderPanelPosition();
        };
        const handleEscape = (event) => {
            if (event.key !== 'Escape') return;
            closeFloatingModelProviderPanel();
            deps.renderModels();
        };

        documentRef.addEventListener('pointerdown', handlePointerDown, true);
        windowRef.addEventListener('resize', handleReposition);
        windowRef.addEventListener('scroll', handleReposition, true);
        documentRef.addEventListener('keydown', handleEscape);
        store.floatingModelProviderPanelCleanup = [
            () => documentRef.removeEventListener('pointerdown', handlePointerDown, true),
            () => windowRef.removeEventListener('resize', handleReposition),
            () => windowRef.removeEventListener('scroll', handleReposition, true),
            () => documentRef.removeEventListener('keydown', handleEscape)
        ];
    }

    function formatGeneralSettingsHelpContent(value) {
        return escapeHtml(value).replace(/\n/g, '<br>');
    }

    function renderGeneralSettingsHelpLabel(title, description, options = {}) {
        const labelClass = options.emphasis ? 'general-settings-toggle-title' : 'general-settings-label-text';
        const safeTitle = escapeHtml(title);
        const safeDescriptionAttr = escapeHtml(description).replace(/\n/g, '&#10;');
        return `
            <div class="general-settings-label-main">
                <span class="${labelClass}">${safeTitle}</span>
                <div class="general-settings-help">
                    <button
                        type="button"
                        class="general-settings-help-trigger"
                        aria-expanded="false"
                        aria-label="查看“${safeTitle}”说明"
                        data-help-title="${safeTitle}"
                        data-help-description="${safeDescriptionAttr}"
                    >?</button>
                </div>
            </div>
        `;
    }

    function ensureGeneralSettingsHelpOverlay() {
        if (store.generalSettingsHelpOverlay?.isConnected) return store.generalSettingsHelpOverlay;

        const overlay = documentRef.createElement('div');
        overlay.className = 'general-settings-floating-help hidden';
        overlay.setAttribute('role', 'tooltip');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML = `
            <strong class="general-settings-floating-help-title"></strong>
            <span class="general-settings-floating-help-body"></span>
        `;
        (documentRef.body || documentRef.documentElement).appendChild(overlay);
        store.generalSettingsHelpOverlay = overlay;
        return overlay;
    }

    function syncGeneralSettingsHelpState(container, activeTrigger = null) {
        if (!container) return;
        container.querySelectorAll('.general-settings-help').forEach((helpRoot) => {
            const trigger = helpRoot.querySelector('.general-settings-help-trigger');
            const shouldOpen = !!trigger && trigger === activeTrigger;
            helpRoot.classList.toggle('is-open', shouldOpen);
            if (trigger) trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
        });
    }

    function positionGeneralSettingsHelpOverlay(trigger, overlay) {
        if (!trigger || !overlay) return;

        const triggerRect = trigger.getBoundingClientRect();
        const viewportWidth = Math.max(windowRef.innerWidth || 0, documentRef.documentElement?.clientWidth || 0);
        const viewportHeight = Math.max(windowRef.innerHeight || 0, documentRef.documentElement?.clientHeight || 0);
        const margin = 12;
        const gap = 10;
        const maxWidth = Math.min(320, Math.max(220, viewportWidth - (margin * 2)));

        overlay.style.maxWidth = `${maxWidth}px`;
        overlay.style.left = '0px';
        overlay.style.top = '0px';

        const overlayRect = overlay.getBoundingClientRect();
        const preferTop = triggerRect.bottom + gap + overlayRect.height > viewportHeight - margin
            && triggerRect.top - gap - overlayRect.height >= margin;
        const naturalTop = preferTop
            ? triggerRect.top - overlayRect.height - gap
            : triggerRect.bottom + gap;
        const top = Math.min(
            Math.max(margin, naturalTop),
            Math.max(margin, viewportHeight - overlayRect.height - margin)
        );
        const preferredLeft = triggerRect.left - 10;
        const left = Math.min(
            Math.max(margin, preferredLeft),
            Math.max(margin, viewportWidth - overlayRect.width - margin)
        );
        const arrowLeft = Math.min(
            Math.max(20, (triggerRect.left + (triggerRect.width / 2)) - left),
            overlayRect.width - 20
        );

        overlay.dataset.placement = preferTop ? 'top' : 'bottom';
        overlay.style.left = `${left}px`;
        overlay.style.top = `${top}px`;
        overlay.style.setProperty('--general-settings-floating-help-arrow-left', `${arrowLeft}px`);
    }

    function closeGeneralSettingsHelpPopovers(container) {
        store.activeGeneralSettingsHelpTrigger = null;
        syncGeneralSettingsHelpState(container, null);
        if (!store.generalSettingsHelpOverlay) return;
        store.generalSettingsHelpOverlay.classList.add('hidden');
        store.generalSettingsHelpOverlay.setAttribute('aria-hidden', 'true');
    }

    function openGeneralSettingsHelpPopover(trigger, container) {
        if (!trigger || !container) return;

        const overlay = ensureGeneralSettingsHelpOverlay();
        const title = trigger.getAttribute('data-help-title') || '';
        const description = trigger.getAttribute('data-help-description') || '';
        const titleEl = overlay.querySelector('.general-settings-floating-help-title');
        const bodyEl = overlay.querySelector('.general-settings-floating-help-body');

        if (titleEl) titleEl.textContent = title;
        if (bodyEl) bodyEl.innerHTML = formatGeneralSettingsHelpContent(description);

        overlay.classList.remove('hidden');
        overlay.setAttribute('aria-hidden', 'false');
        store.activeGeneralSettingsHelpTrigger = trigger;
        syncGeneralSettingsHelpState(container, trigger);
        positionGeneralSettingsHelpOverlay(trigger, overlay);
    }

    function refreshGeneralSettingsHelpPopoverPosition() {
        if (
            !store.activeGeneralSettingsHelpTrigger ||
            !store.generalSettingsHelpOverlay ||
            store.generalSettingsHelpOverlay.classList.contains('hidden')
        ) {
            return;
        }
        if (!store.activeGeneralSettingsHelpTrigger.isConnected) {
            closeGeneralSettingsHelpPopovers(documentRef.getElementById('general-settings'));
            return;
        }
        positionGeneralSettingsHelpOverlay(store.activeGeneralSettingsHelpTrigger, store.generalSettingsHelpOverlay);
    }

    function initGeneralSettingsHelpInteractions(container) {
        if (!container || container.dataset.generalSettingsHelpBound === '1') return;

        container.addEventListener('click', (event) => {
            const trigger = event.target.closest('.general-settings-help-trigger');
            if (!trigger || !container.contains(trigger)) return;

            event.preventDefault();
            event.stopPropagation();

            const shouldOpen = (
                store.activeGeneralSettingsHelpTrigger !== trigger ||
                !store.generalSettingsHelpOverlay ||
                store.generalSettingsHelpOverlay.classList.contains('hidden')
            );

            if (!shouldOpen) {
                closeGeneralSettingsHelpPopovers(container);
                return;
            }

            openGeneralSettingsHelpPopover(trigger, container);
        });

        if (!store.generalSettingsHelpDismissBound) {
            documentRef.addEventListener('click', (event) => {
                const activeContainer = documentRef.getElementById('general-settings');
                if (!activeContainer) return;

                const helpRoot = event.target.closest('.general-settings-help');
                if (helpRoot && activeContainer.contains(helpRoot)) return;
                if (store.generalSettingsHelpOverlay?.contains(event.target)) return;

                closeGeneralSettingsHelpPopovers(activeContainer);
            });
            windowRef.addEventListener('resize', refreshGeneralSettingsHelpPopoverPosition);
            store.generalSettingsHelpDismissBound = true;
        }

        container.dataset.generalSettingsHelpBound = '1';
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
        const attemptsSummary = getNetworkProxyAttemptSummary(result.attempts);

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
                        <p>当前检测到后端发出的请求可以访问常见境外探测目标，但是设置中的代理选项没有打开。你可能是开启了代理软件的 <code>TUN</code> 模式或者虚拟网卡模式，或者配置了软路由，也可能是其他透明代理规则让请求实际走了代理链路。</p>
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
                            <li><strong>API 地址：</strong>填写服务商的基础地址，例如 <code>https://api.openai.com</code>、<code>https://generativelanguage.googleapis.com</code>，也可以使用 <code>192.168.1.10:11434</code> 这类 IP / 本地地址。</li>
                            <li><strong>自动补全：</strong>推荐开启。CainFlow 会按模型协议自动补齐 <code>/v1/chat/completions</code>、Gemini 路径或生图路径。</li>
                        </ul>
                    </section>
                    <section class="api-settings-help-section">
                        <h4>3. 添加模型并绑定供应商</h4>
                        <p>供应商保存后，可以点击“获取模型列表”自动拉取，也可以在“模型管理”里手动添加模型 ID。模型需要绑定到可用供应商，节点里的模型下拉才会出现。</p>
                        <ul>
                            <li>对话模型选择“对话”，用于 TextChat 等文本生成节点。</li>
                            <li>图片模型选择“生图”，用于 ImageGenerate 等图片生成节点。</li>
                            <li>视频模型选择“视频”，用于 VideoGenerate 等视频生成节点。</li>
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
        const deps = getDeps();
        const provider = state.providers.find((candidate) => candidate.id === modelFetchDialogState.providerId);
        if (!provider) {
            dialog.classList.add('hidden');
            return;
        }

        const providerProtocol = deps.getModelFetchProtocol(provider);
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
            const modelProtocol = deps.inferFetchedModelProtocol(provider, model);
            const exists = deps.modelAlreadyExists(provider.id, model.id, modelProtocol);
            return `
                <div class="provider-models-row">
                    <div class="provider-models-row-main">
                        <div class="provider-models-row-name">${escapeHtml(model.name)}</div>
                        <div class="provider-models-row-id">${escapeHtml(model.id)}</div>
                    </div>
                    <span class="provider-models-badge">${escapeHtml(deps.getFetchedModelTaskTypeLabel(model.taskType))} · ${modelProtocol === 'openai' ? 'OpenAI' : 'Gemini'}</span>
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
                        <div class="provider-models-subtitle">${escapeHtml(deps.getSafeProviderName(provider))} · ${providerProtocol === 'google' ? 'Google / Gemini' : 'OpenAI 兼容'}</div>
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
            deps.fetchProviderModels(provider.id);
        });
        dialog.querySelector('#provider-models-search')?.addEventListener('input', (event) => {
            modelFetchDialogState.query = event.target.value;
            renderProviderModelsDialog({ keepSearchFocus: true });
        });
        dialog.querySelectorAll('.provider-models-add').forEach((button) => {
            button.addEventListener('click', (event) => {
                const modelId = event.currentTarget.dataset.modelId;
                const fetchedModel = modelFetchDialogState.models.find((model) => model.id === modelId);
                deps.addFetchedModel(provider, fetchedModel);
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

    function closeAllSettingsOverlays() {
        closeApiSettingsHelpDialog();
        closeProviderModelsDialog();
        closeNetworkProxyHintDialog();
        closeGeneralSettingsHelpPopovers(documentRef.getElementById('general-settings'));
        closeFloatingModelProviderPanel();
    }

    return {
        escapeHtml,
        renderFloatingModelProviderPanel,
        closeFloatingModelProviderPanel,
        renderGeneralSettingsHelpLabel,
        initGeneralSettingsHelpInteractions,
        closeGeneralSettingsHelpPopovers,
        refreshGeneralSettingsHelpPopoverPosition,
        renderApiSettingsHelpDialog,
        closeApiSettingsHelpDialog,
        renderProviderModelsDialog,
        closeProviderModelsDialog,
        renderNetworkProxyHintDialog,
        closeNetworkProxyHintDialog,
        openSettingsProxyTab,
        getNetworkProxyAttemptSummary,
        closeAllSettingsOverlays
    };
}
