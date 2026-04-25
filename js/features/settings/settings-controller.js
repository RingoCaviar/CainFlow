/**
 * 负责设置面板的数据渲染、保存、代理检测、模型管理与通用设置同步。
 */
import {
    getEffectiveProtocol,
    getModelOptionLabel,
    getModelsForTask,
    normalizeAutoCompleteBase,
    normalizeModelProtocol,
    normalizeModelTaskType,
    normalizeProviderType,
    resolveProviderUrl
} from '../execution/provider-request-utils.js';

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
    fitNodeToContent = () => {},
    documentRef = document,
    windowRef = window,
    localStorageRef = localStorage,
    fetchImpl = fetch
}) {
    const providerCollapseState = new Map();
    const modelCollapseState = new Map();

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
        const provider = state.providers.find((candidate) => candidate.id === model.providerId);
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
        const provider = state.providers.find((candidate) => candidate.id === model.providerId);
        const protocol = getEffectiveProtocol(model, provider);
        if (protocol === 'google') {
            return 'Google / Gemini 格式会走 generateContent，请求体按 Gemini 协议构造。';
        }
        return 'OpenAI 兼容格式会按模型用途，分别走 /chat/completions 或 /images/generations。';
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
                state.providers = state.providers.filter((candidate) => candidate.id !== e.target.dataset.id);
                renderProviders();
                renderModels();
                saveState();
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
            const isCollapsed = modelCollapseState.get(mod.id) !== false;
            const el = documentRef.createElement('div');
            el.className = 'api-config-card';
            const providerOptions = state.providers.map((provider) => `<option value="${provider.id}" ${mod.providerId === provider.id ? 'selected' : ''}>${provider.name}</option>`).join('');
            const taskType = normalizeModelTaskType(mod.taskType, mod);
            const provider = state.providers.find((candidate) => candidate.id === mod.providerId);
            const protocol = getEffectiveProtocol(mod, provider);
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
                            <select data-id="${mod.id}" data-field="providerId">
                                <option value="">-- 请选择供应商 --</option>
                                ${providerOptions}
                            </select>
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
                const nextProviderId = field === 'providerId' ? e.target.value : mod.providerId;
                const provider = state.providers.find((candidate) => candidate.id === nextProviderId);
                mod[field] = field === 'taskType'
                    ? normalizeModelTaskType(e.target.value, mod)
                    : field === 'protocol'
                        ? normalizeModelProtocol(e.target.value, mod, provider)
                        : e.target.value;
                saveState();
                renderModels();
                updateAllNodeModelDropdowns();
            });
        });

        modelsList.querySelectorAll('.card-btn-delete').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                if (!windowRef.confirm('确定删除此模型配置吗？')) return;
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
        const connectionFlowAnimationEnabled = state.connectionFlowAnimationEnabled !== false;
        const updateStatus = localStorageRef.getItem('cainflow_update_status') || 'unknown';
        const lastCheck = localStorageRef.getItem('cainflow_last_update_check');
        const latestVer = localStorageRef.getItem('cainflow_update_version');

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
        } else if (updateStatus === 'error') statusHtml = `<span class="update-status-error">✗ 检查失败 (网络原因)</span>`;

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
                            <label style="margin:0;">流动箭头动画</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-connection-flow-animation-enabled" ${connectionFlowAnimationEnabled ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <p style="font-size:11px; color:var(--text-dim); line-height:1.4;">默认开启。关闭后，选中节点相关连线上的流动小箭头会被隐藏。</p>
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
        const connectionFlowAnimationInput = documentRef.getElementById('setting-connection-flow-animation-enabled');
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

        connectionFlowAnimationInput?.addEventListener('change', (e) => {
            state.connectionFlowAnimationEnabled = e.target.checked;
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

    function updateAllNodeModelDropdowns() {
        for (const [id, node] of state.nodes) {
            if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
                const select = documentRef.getElementById(`${id}-apiconfig`);
                if (select) {
                    const currentVal = select.value;
                    const taskType = node.type === 'ImageGenerate' ? 'image' : 'chat';
                    const models = getModelsForTask(state.models, taskType);
                    if (models.length === 0) {
                        select.innerHTML = '<option value="">-- 暂无可用模型 --</option>';
                        select.value = '';
                        continue;
                    }
                    select.innerHTML = models.map((model) => `<option value="${model.id}">${getModelOptionLabel(model, state.providers)}</option>`).join('');
                    if (models.find((model) => model.id === currentVal)) select.value = currentVal;
                    else select.value = models[0].id;
                }
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
