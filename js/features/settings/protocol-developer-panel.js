/**
 * 协议开发者面板
 * 提供可视化的协议参数编辑界面
 */

import { getAllProtocols, getProtocol, registerProtocol, loadProtocols, deleteProtocol as removeProtocol } from '../execution/protocols/index.js';
import { wrapConfigProtocol } from '../execution/protocols/request-builder.js';

export function createProtocolDeveloperPanel({ documentRef, showToast, refreshImageGenerateNodes = null, onProtocolRegistryChange = null }) {
    const panelId = 'protocol-developer-panel';
    let currentEditingProtocol = null;
    let draftProtocol = null;
    let protocolsLoaded = false;
    let livePreviewBound = false;
    const BUILT_IN_PROTOCOL_IDS = new Set([
        'google',
        'openai',
        'ttapi',
        'ttapi-openai',
        'newapi-image-async',
        'veo-unified',
        'veo-openai',
        'doubao-video',
        'agnesimage'
    ]);
    const PROTOCOL_CONFIG_KEYS = [
        'id',
        'label',
        'taskTypes',
        'helpText',
        'urlTemplate',
        'urlTemplates',
        'apikeyLocation',
        'apikeyField',
        'parameters',
        'responsePath',
        'fixedParams',
        'videoMeta'
    ];
    const PARAMETER_CONFIG_KEYS = [
        'id',
        'label',
        'exposed',
        'inputPort',
        'portType',
        'portCount',
        'portLabel',
        'portOnly',
        'required',
        'omitIfEmpty',
        'dataType',
        'uiControl',
        'options',
        'defaultValue',
        'requestField',
        'taskTypes',
        'min',
        'max',
        'step',
        'note',
        'description',
        'placeholder',
        'rows'
    ];

    function cloneSerializable(value) {
        if (value === undefined || value === null) return value;
        return JSON.parse(JSON.stringify(value));
    }

    function pickSerializableFields(source = {}, keys = []) {
        return keys.reduce((result, key) => {
            if (source[key] !== undefined && typeof source[key] !== 'function') {
                result[key] = cloneSerializable(source[key]);
            }
            return result;
        }, {});
    }

    function cleanParameterConfig(paramId, param = {}) {
        const cleanParam = pickSerializableFields(param, PARAMETER_CONFIG_KEYS);
        cleanParam.id = String(cleanParam.id || paramId || '').trim();
        cleanParam.label = String(cleanParam.label || cleanParam.id || paramId || '').trim();
        cleanParam.exposed = cleanParam.exposed === true;
        cleanParam.inputPort = cleanParam.inputPort === true;
        cleanParam.required = cleanParam.required === true;
        cleanParam.omitIfEmpty = cleanParam.omitIfEmpty !== false;
        cleanParam.dataType = cleanParam.dataType || 'string';
        cleanParam.uiControl = cleanParam.uiControl || 'text';
        if (cleanParam.inputPort && !cleanParam.portType) cleanParam.portType = 'text';
        return cleanParam;
    }

    function cleanProtocolConfig(protocol = {}) {
        const cleanProtocol = pickSerializableFields(protocol, PROTOCOL_CONFIG_KEYS);
        cleanProtocol.id = String(cleanProtocol.id || '').trim();
        cleanProtocol.label = String(cleanProtocol.label || cleanProtocol.id || '').trim();
        cleanProtocol.taskTypes = Array.isArray(cleanProtocol.taskTypes) ? cleanProtocol.taskTypes.filter(Boolean) : ['image'];
        cleanProtocol.urlTemplate = typeof cleanProtocol.urlTemplate === 'string' ? cleanProtocol.urlTemplate : '{{endpoint}}/v1/endpoint';
        cleanProtocol.apikeyLocation = cleanProtocol.apikeyLocation || 'header';
        cleanProtocol.apikeyField = cleanProtocol.apikeyField || 'Authorization';

        // 处理 urlTemplates（多路径配置）
        if (protocol.urlTemplates && typeof protocol.urlTemplates === 'object') {
            cleanProtocol.urlTemplates = { ...protocol.urlTemplates };
        }

        cleanProtocol.parameters = Object.entries(protocol.parameters || {}).reduce((params, [paramId, param]) => {
            const cleanParam = cleanParameterConfig(paramId, param);
            if (cleanParam.id) params[cleanParam.id] = cleanParam;
            return params;
        }, {});
        cleanProtocol.responsePath = cleanProtocol.responsePath || {
            image: 'data[0].url',
            chat: 'choices[0].message.content',
            video: 'data.video_url'
        };
        return cleanProtocol;
    }

    function setDraftProtocol(protocol) {
        draftProtocol = cleanProtocolConfig(protocol);
        currentEditingProtocol = draftProtocol;
    }

    function setSaveStatus(message = '', type = '') {
        const status = documentRef.getElementById('protocol-save-status');
        if (!status) return;
        status.textContent = message;
        status.dataset.status = type;
    }

    function notifyProtocolRegistryChange(protocolId = '') {
        if (typeof onProtocolRegistryChange !== 'function') return;
        try {
            onProtocolRegistryChange(protocolId);
        } catch (error) {
            console.error('刷新模型兼容格式失败:', error);
        }
    }

    function validateProtocolConfig(protocol) {
        if (!protocol || !/^[a-z][a-z0-9\-]*$/.test(protocol.id || '')) {
            throw new Error('协议ID格式不正确（小写字母、数字、连字符）');
        }
        if (!protocol.label) throw new Error('请填写协议显示名称');
        if (!Array.isArray(protocol.taskTypes) || protocol.taskTypes.length === 0) {
            throw new Error('至少选择一个适用用途');
        }
        if (!protocol.urlTemplate || typeof protocol.urlTemplate !== 'string') {
            throw new Error('请填写请求路径模板');
        }
        if (!protocol.apikeyField || typeof protocol.apikeyField !== 'string') {
            throw new Error('请填写 API Key 字段名');
        }

        const seenParamIds = new Set();
        Object.entries(protocol.parameters || {}).forEach(([paramId, param]) => {
            const normalizedParamId = String(param?.id || paramId || '').trim();
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(normalizedParamId)) {
                throw new Error(`参数ID格式不正确：${normalizedParamId || paramId}`);
            }
            if (seenParamIds.has(normalizedParamId)) {
                throw new Error(`参数ID重复：${normalizedParamId}`);
            }
            seenParamIds.add(normalizedParamId);

            if (param.uiControl === 'select') {
                const options = Array.isArray(param.options) ? param.options : [];
                if (options.length === 0) throw new Error(`参数 ${normalizedParamId} 的下拉选项不能为空`);
                options.forEach((option, index) => {
                    if (!String(option?.value ?? '').trim() && !String(option?.label ?? '').trim()) {
                        throw new Error(`参数 ${normalizedParamId} 的第 ${index + 1} 个下拉选项为空`);
                    }
                });
            }
        });
    }

    /**
     * 创建面板HTML
     */
    function createPanelHTML() {
        const panel = documentRef.createElement('div');
        panel.id = panelId;
        panel.className = 'protocol-developer-panel hidden';
        panel.innerHTML = `
            <!-- 头部 -->
            <div class="protocol-dev-header">
                <h2 id="panel-title">🛠️ 协议开发者面板</h2>
                <div class="header-actions">
                    <button id="btn-back-to-list" class="btn btn-ghost btn-sm hidden">← 返回</button>
                    <button id="btn-close-protocol-dev" class="btn btn-ghost btn-sm">✕</button>
                </div>
            </div>

            <!-- 主体区域 -->
            <div class="protocol-dev-body" id="protocol-dev-body">
                <!-- 协议列表视图 -->
                <div id="protocol-list-view" class="protocol-editor-left">
                    <div class="protocol-dev-section">
                        <div class="parameters-section-header">
                            <h3>已注册的协议</h3>
                            <button id="btn-create-protocol" class="btn btn-primary btn-sm">+ 创建新协议</button>
                        </div>
                        <div id="protocol-list" class="protocol-list"></div>
                    </div>
                </div>

                <!-- 协议编辑视图 -->
                <div id="protocol-editor-view" class="hidden" style="display: flex; flex: 1; overflow: hidden;">
                    <!-- 左侧：编辑器 -->
                    <div class="protocol-editor-left">
                        <!-- 基本信息 -->
                        <div class="protocol-field-group">
                            <h4 style="margin: 0 0 16px 0; font-size: 15px; color: var(--text-primary);">基本信息</h4>
                            <div class="protocol-field">
                                        <label>协议ID</label>
                                        <input type="text" id="protocol-id" disabled />
                                    </div>
                                    <div class="protocol-field">
                                        <label>显示名称</label>
                                        <input type="text" id="protocol-label" />
                                    </div>
                                    <div class="protocol-field">
                                        <label>适用用途</label>
                                        <div class="protocol-task-types-checkboxes">
                                            <label><input type="checkbox" id="task-type-chat" value="chat" /> 对话</label>
                                            <label><input type="checkbox" id="task-type-image" value="image" /> 生图</label>
                                            <label><input type="checkbox" id="task-type-video" value="video" /> 视频</label>
                                        </div>
                                        <small style="color: var(--text-secondary); font-size: 12px;">选中的用途在使用模型时可用，兼容格式只会显示包含对应用途的协议</small>
                                    </div>
                                    <div class="protocol-field">
                                        <label>请求路径模板</label>
                                        <input type="text" id="protocol-url-template" placeholder="例如: {{endpoint}}/v1/images/generations" />
                                        <small style="color: var(--text-secondary); font-size: 12px;">支持变量：{{endpoint}}, {{model}}, {{taskType}}</small>
                                    </div>
                                    <div class="protocol-field">
                                        <label>
                                            图片编辑路径（可选）
                                            <small style="color: var(--text-secondary); font-size: 12px; font-weight: normal; margin-left: 8px;">当生图节点有参考图输入时使用此路径</small>
                                        </label>
                                        <input type="text" id="protocol-url-template-image-edit" placeholder="例如: {{endpoint}}/v1/images/edits" />
                                        <small style="color: var(--text-secondary); font-size: 12px;">留空则使用默认路径模板。适用于支持图片编辑的API（如 OpenAI 的 /images/edits）</small>
                                    </div>
                                    <div class="protocol-field">
                                        <label>API Key 位置</label>
                                        <select id="protocol-apikey-location">
                                            <option value="header">Header (推荐)</option>
                                            <option value="query">URL Query 参数</option>
                                            <option value="body">请求体 Body</option>
                                        </select>
                                    </div>
                                    <div class="protocol-field">
                                        <label>API Key 字段名</label>
                                        <input type="text" id="protocol-apikey-field" placeholder="例如: Authorization: Bearer {apikey}" />
                                        <small style="color: var(--text-secondary); font-size: 12px;">支持模板格式，使用 {apikey} 作为 API Key 的占位符</small>
                                    </div>
                                </div>

                                <!-- 参数列表 -->
                                <div class="protocol-field-group">
                                    <div class="protocol-section-header">
                                        <h4>参数配置</h4>
                                        <div style="display: flex; gap: 8px;">
                                            <button id="btn-add-parameter" class="btn btn-accent btn-sm">+ 添加参数</button>
                                        </div>
                                    </div>
                                    <div id="parameters-list" class="parameters-list"></div>
                                </div>
                            </div>

                            <!-- 中间：节点UI预览 -->
                            <div class="protocol-editor-middle">
                                <h3>🎨 节点UI预览</h3>
                                <div id="node-ui-preview" class="node-preview-container"></div>
                            </div>

                            <!-- 右侧：请求体预览 -->
                            <div class="protocol-editor-right">
                                <h3>📄 请求体预览</h3>
                                <div id="protocol-preview" class="preview-container"></div>
                            </div>
                    </div>
                </div>
            </div>

            <!-- 底部操作栏 -->
            <div class="protocol-dev-footer" id="protocol-footer">
                <div class="footer-actions">
                    <button id="btn-delete-protocol-footer" class="btn btn-danger btn-sm hidden">删除协议</button>
                    <span id="protocol-save-status" class="protocol-save-status" role="status" aria-live="polite"></span>
                </div>
                <div class="footer-actions">
                    <button id="btn-export-protocol" class="btn btn-secondary btn-sm hidden">导出JSON</button>
                    <button id="btn-save-protocol" class="btn btn-primary hidden">💾 保存配置</button>
                </div>
            </div>
        `;
        documentRef.body.appendChild(panel);
    }

    /**
     * 渲染协议列表
     */
    function renderProtocolList() {
        const listContainer = documentRef.getElementById('protocol-list');
        const protocols = getAllProtocols();

        console.log('协议开发者面板 - 获取到的协议数量:', protocols.length);
        console.log('协议开发者面板 - 协议列表:', protocols);

        if (protocols.length === 0) {
            listContainer.innerHTML = '<div class="no-parameters">暂无已注册的协议。请确保协议系统已正确加载。</div>';
            return;
        }

        // 按ID字母顺序排序，保证每次显示顺序一致
        const sortedProtocols = protocols.sort((a, b) => a.id.localeCompare(b.id));

        listContainer.innerHTML = sortedProtocols.map(protocol => {
            const isBuiltInProtocol = BUILT_IN_PROTOCOL_IDS.has(protocol.id);
            return `
            <div class="protocol-card" data-protocol-id="${protocol.id}">
                <div class="protocol-card-header">
                    <strong>${protocol.label}</strong>
                    <span class="protocol-id-badge">${protocol.id}</span>
                </div>
                <div class="protocol-card-body">
                    <div class="protocol-meta">
                        <span class="protocol-task-badges">
                            ${protocol.taskTypes.map(t => `<span class="task-badge task-badge-${t}">${t}</span>`).join('')}
                        </span>
                        <span class="protocol-param-count">
                            ${Object.keys(protocol.parameters || {}).length} 个参数
                        </span>
                    </div>
                </div>
                <div class="protocol-card-footer">
                    <button class="btn btn-sm btn-ghost btn-edit-protocol" data-protocol-id="${protocol.id}">
                        编辑参数
                    </button>
                    <button class="btn btn-sm btn-ghost btn-view-json" data-protocol-id="${protocol.id}">
                        查看JSON
                    </button>
                    <button class="btn btn-sm btn-ghost btn-delete-protocol ${isBuiltInProtocol ? 'hidden' : ''}" data-protocol-id="${protocol.id}" style="color: var(--danger-color, #ef4444);">
                        删除
                    </button>
                </div>
            </div>
        `;
        }).join('');

        // 绑定编辑按钮
        listContainer.querySelectorAll('.btn-edit-protocol').forEach(btn => {
            btn.addEventListener('click', () => {
                const protocolId = btn.dataset.protocolId;
                editProtocol(protocolId);
            });
        });

        // 绑定查看JSON按钮
        listContainer.querySelectorAll('.btn-view-json').forEach(btn => {
            btn.addEventListener('click', () => {
                const protocolId = btn.dataset.protocolId;
                viewProtocolJSON(protocolId);
            });
        });

        // 绑定删除按钮
        listContainer.querySelectorAll('.btn-delete-protocol').forEach(btn => {
            btn.addEventListener('click', () => {
                const protocolId = btn.dataset.protocolId;
                deleteProtocol(protocolId);
            });
        });
    }

    /**
     * 编辑协议
     */
    function editProtocol(protocolId) {
        const protocol = getProtocol(protocolId);
        if (!protocol) {
            showToast('协议不存在', 'error');
            return;
        }
        setSaveStatus();

        // 使用干净草稿编辑，避免直接修改注册表中的运行时协议对象。
        setDraftProtocol(protocol);

        // 如果协议的 parameters 中没有 model 参数，自动添加一个
        if (!draftProtocol.parameters) {
            draftProtocol.parameters = {};
        }
        if (!draftProtocol.parameters.model) {
            draftProtocol.parameters.model = {
                id: 'model',
                label: '模型',
                exposed: false,
                inputPort: false,
                dataType: 'string',
                uiControl: 'text',
                defaultValue: '{{modelId}}',
                required: true,
                omitIfEmpty: false,
                requestField: 'model'
            };
        }

        // 切换视图
        documentRef.getElementById('protocol-list-view').classList.add('hidden');
        documentRef.getElementById('protocol-editor-view').classList.remove('hidden');

        // 显示底部按钮
        documentRef.getElementById('btn-save-protocol').classList.remove('hidden');
        documentRef.getElementById('btn-export-protocol').classList.remove('hidden');
        documentRef.getElementById('btn-delete-protocol-footer').classList.toggle('hidden', BUILT_IN_PROTOCOL_IDS.has(draftProtocol.id));

        // 显示返回按钮
        documentRef.getElementById('btn-back-to-list').classList.remove('hidden');

        // 更新标题
        documentRef.getElementById('panel-title').textContent = `编辑协议: ${draftProtocol.label}`;

        // 填充基本信息
        documentRef.getElementById('protocol-id').value = draftProtocol.id;
        documentRef.getElementById('protocol-label').value = draftProtocol.label || '';
        documentRef.getElementById('protocol-url-template').value = draftProtocol.urlTemplate || '';

        // 填充图片编辑路径（如果有配置）
        const imageEditPath = draftProtocol.urlTemplates?.imageEdit || '';
        documentRef.getElementById('protocol-url-template-image-edit').value = imageEditPath;

        // 填充协议用途复选框
        const taskTypes = draftProtocol.taskTypes || [];
        documentRef.getElementById('task-type-chat').checked = taskTypes.includes('chat');
        documentRef.getElementById('task-type-image').checked = taskTypes.includes('image');
        documentRef.getElementById('task-type-video').checked = taskTypes.includes('video');

        // 填充API Key配置
        documentRef.getElementById('protocol-apikey-location').value = draftProtocol.apikeyLocation || 'header';
        documentRef.getElementById('protocol-apikey-field').value = draftProtocol.apikeyField || '';

        // 渲染参数列表
        renderParametersList(draftProtocol.parameters || {});

        // 初始化预览
        refreshPreview();

        // 绑定实时预览事件
        setupLivePreview();
    }

    /**
     * 渲染下拉选项编辑器
     */
    function renderOptionsEditor(paramId, options) {
        const optionsList = options.map((opt, index) => `
            <div class="option-item" data-param-id="${paramId}" data-index="${index}">
                <div class="option-item-grip" title="拖动排序">⋮⋮</div>
                <input type="text" class="option-value" value="${opt.value || ''}" placeholder="值 (value)" />
                <input type="text" class="option-label" value="${opt.label || ''}" placeholder="显示文本 (label)" />
                <button type="button" class="btn-icon btn-remove-option" data-param-id="${paramId}" data-index="${index}" title="删除选项">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        `).join('');

        return `
            <div class="options-list" data-param-id="${paramId}">
                ${optionsList}
            </div>
            <button type="button" class="btn-add-option" data-param-id="${paramId}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                添加选项
            </button>
        `;
    }

    /**
     * 渲染参数列表
     */
    function renderParametersList(parameters) {
        const container = documentRef.getElementById('parameters-list');

        if (Object.keys(parameters).length === 0) {
            container.innerHTML = '<div class="no-parameters">暂无参数，点击上方"添加参数"按钮创建</div>';
            return;
        }

        container.innerHTML = Object.entries(parameters).map(([paramId, param]) => `
            <div class="parameter-card collapsed" data-param-id="${paramId}">
                <div class="parameter-card-header" data-param-id="${paramId}">
                    <div class="parameter-header-left">
                        <button class="btn-drag-handle" data-param-id="${paramId}" title="拖动排序" draggable="true">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="8" y1="6" x2="16" y2="6"></line>
                                <line x1="8" y1="12" x2="16" y2="12"></line>
                                <line x1="8" y1="18" x2="16" y2="18"></line>
                            </svg>
                        </button>
                        <button class="btn-toggle-param" data-param-id="${paramId}" title="展开/折叠">
                            <svg class="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                        </button>
                        <input type="text" class="param-field-title" value="${param.label || paramId}" data-param-id="${paramId}" placeholder="参数说明（备注）" title="参数说明（备注）" />
                    </div>
                    <div class="parameter-header-right">
                        <span class="parameter-id-badge">${paramId}</span>
                        <button class="btn-icon btn-remove-param" data-param-id="${paramId}" title="删除参数">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>
                </div>
                <div class="parameter-card-body">
                    <!-- 基本信息 -->
                    <div class="parameter-section">
                        <div class="parameter-section-title">基本信息</div>
                        <div class="parameter-row">
                            <label>参数名称</label>
                            <input type="text" class="param-field-id" value="${paramId}" data-param-id="${paramId}" placeholder="如: size, quality" />
                        </div>
                    </div>

                    <!-- 类型与控件 -->
                    <div class="parameter-section">
                        <div class="parameter-section-title">类型与控件</div>
                        <div class="parameter-row">
                            <label>数据类型</label>
                            <select class="param-field-data-type" data-param-id="${paramId}">
                                <option value="string" ${(param.dataType || 'string') === 'string' ? 'selected' : ''}>字符串 (string)</option>
                                <option value="number" ${param.dataType === 'number' ? 'selected' : ''}>数字 (number)</option>
                                <option value="boolean" ${param.dataType === 'boolean' ? 'selected' : ''}>布尔值 (boolean)</option>
                                <option value="array" ${param.dataType === 'array' ? 'selected' : ''}>数组 (array)</option>
                                <option value="object" ${param.dataType === 'object' ? 'selected' : ''}>对象 (object)</option>
                            </select>
                        </div>
                        <div class="parameter-row">
                            <label>UI控件类型</label>
                            <select class="param-field-ui-control" data-param-id="${paramId}">
                                <option value="text" ${param.uiControl === 'text' ? 'selected' : ''}>文本输入 (text)</option>
                                <option value="number" ${param.uiControl === 'number' ? 'selected' : ''}>数字输入 (number)</option>
                                <option value="select" ${param.uiControl === 'select' ? 'selected' : ''}>下拉选择 (select)</option>
                                <option value="toggle" ${param.uiControl === 'toggle' ? 'selected' : ''}>开关 (toggle)</option>
                                <option value="textarea" ${param.uiControl === 'textarea' ? 'selected' : ''}>多行文本 (textarea)</option>
                            </select>
                        </div>
                        <div class="parameter-row ${param.uiControl === 'select' ? '' : 'hidden'}" data-param-id="${paramId}" data-field="options">
                            <label>下拉选项</label>
                            <div class="options-editor" data-param-id="${paramId}">
                                ${renderOptionsEditor(paramId, param.options || [])}
                            </div>
                        </div>
                    </div>

                    <!-- 参数配置 -->
                    <div class="parameter-section">
                        <div class="parameter-section-title">参数配置</div>
                        <div class="parameter-row">
                            <label>适用用途</label>
                            <div class="parameter-task-types-checkboxes" data-param-id="${paramId}">
                                <label><input type="checkbox" class="param-task-type-chat" data-param-id="${paramId}" value="chat" ${(param.taskTypes || []).includes('chat') ? 'checked' : ''} /> 对话</label>
                                <label><input type="checkbox" class="param-task-type-image" data-param-id="${paramId}" value="image" ${(param.taskTypes || []).includes('image') ? 'checked' : ''} /> 生图</label>
                                <label><input type="checkbox" class="param-task-type-video" data-param-id="${paramId}" value="video" ${(param.taskTypes || []).includes('video') ? 'checked' : ''} /> 视频</label>
                            </div>
                            <small style="color: var(--text-secondary); font-size: 12px; display: block; margin-top: 4px;">留空表示适用所有用途</small>
                        </div>
                        <div class="parameter-row parameter-checkboxes">
                            <label><input type="checkbox" class="param-field-exposed" data-param-id="${paramId}" ${param.exposed ? 'checked' : ''} /> 暴露在节点UI</label>
                            <label><input type="checkbox" class="param-field-input-port" data-param-id="${paramId}" ${param.inputPort ? 'checked' : ''} /> 生成输入端口</label>
                        </div>
                        <div class="parameter-row parameter-checkboxes">
                            <label><input type="checkbox" class="param-field-required" data-param-id="${paramId}" ${param.required ? 'checked' : ''} /> 必填参数</label>
                            <label><input type="checkbox" class="param-field-omit-empty" data-param-id="${paramId}" ${param.omitIfEmpty !== false ? 'checked' : ''} /> 空值时不发送</label>
                        </div>
                        <div class="parameter-row ${param.inputPort ? '' : 'hidden'}" data-param-id="${paramId}" data-field="port-type">
                            <label>端口数据类型</label>
                            <select class="param-field-port-type" data-param-id="${paramId}">
                                <option value="text" ${(param.portType || 'text') === 'text' ? 'selected' : ''}>文本 (text)</option>
                                <option value="image" ${param.portType === 'image' ? 'selected' : ''}>图像 (image)</option>
                                <option value="video" ${param.portType === 'video' ? 'selected' : ''}>视频 (video)</option>
                                <option value="audio" ${param.portType === 'audio' ? 'selected' : ''}>音频 (audio)</option>
                                <option value="file" ${param.portType === 'file' ? 'selected' : ''}>文件 (file)</option>
                                <option value="json" ${param.portType === 'json' ? 'selected' : ''}>JSON数据 (json)</option>
                            </select>
                        </div>
                        <div class="parameter-row">
                            <label>默认值</label>
                            <input type="text" class="param-field-default" value="${param.defaultValue !== undefined ? param.defaultValue : ''}" data-param-id="${paramId}" placeholder="留空表示无默认值，可使用 {{modelId}} 获取模型ID" />
                        </div>
                        <div class="parameter-row">
                            <label>输入框占位符 (Placeholder)</label>
                            <input type="text" class="param-field-placeholder" value="${param.placeholder !== undefined ? param.placeholder : ''}" data-param-id="${paramId}" placeholder="如: 设定生成规则、风格或限制..." />
                        </div>
                        <div class="parameter-row">
                            <label>文本框行数 (Rows)</label>
                            <input type="number" class="param-field-rows" value="${param.rows !== undefined ? param.rows : ''}" data-param-id="${paramId}" placeholder="对多行文本有效，如: 2" min="1" step="1" />
                        </div>
                        <div class="parameter-row">
                            <label>请求体字段名</label>
                            <input type="text" class="param-field-request-field" value="${param.requestField || ''}" data-param-id="${paramId}" placeholder="默认使用参数ID，如需不同请指定" />
                        </div>
                    </div>
                </div>
            </div>
        `).join('');

        // 绑定折叠/展开按钮
        container.querySelectorAll('.parameter-card-header').forEach(element => {
            element.addEventListener('click', (e) => {
                // 如果点击的是输入框、删除按钮或ID徽章，不触发折叠
                if (e.target.classList.contains('param-field-title') ||
                    e.target.classList.contains('parameter-id-badge') ||
                    e.target.classList.contains('btn-remove-param') ||
                    e.target.closest('.btn-remove-param') ||
                    e.target.closest('.parameter-header-right')) {
                    return;
                }

                const paramId = element.dataset.paramId;
                const card = container.querySelector(`.parameter-card[data-param-id="${paramId}"]`);
                card.classList.toggle('collapsed');
            });
        });

        // 输入框阻止冒泡，避免触发折叠
        container.querySelectorAll('.param-field-title').forEach(input => {
            input.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });

        // 绑定删除按钮
        container.querySelectorAll('.btn-remove-param').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // 阻止触发折叠
                if (confirm(`确定要删除参数"${btn.dataset.paramId}"吗？`)) {
                    delete currentEditingProtocol.parameters[btn.dataset.paramId];
                    renderParametersList(currentEditingProtocol.parameters);
                    refreshPreview();
                }
            });
        });

        // 绑定UI控件类型变化，显示/隐藏选项字段
        container.querySelectorAll('.param-field-ui-control').forEach(select => {
            select.addEventListener('change', (e) => {
                const paramId = e.target.dataset.paramId;
                const optionsRow = container.querySelector(`[data-param-id="${paramId}"][data-field="options"]`);
                if (optionsRow) {
                    optionsRow.classList.toggle('hidden', e.target.value !== 'select');
                }
            });
        });

        // 绑定输入端口勾选，显示/隐藏端口类型选择
        container.querySelectorAll('.param-field-input-port').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const paramId = e.target.dataset.paramId;
                const portTypeRow = container.querySelector(`[data-param-id="${paramId}"][data-field="port-type"]`);
                if (portTypeRow) {
                    portTypeRow.classList.toggle('hidden', !e.target.checked);
                }
            });
        });

        // 绑定添加选项按钮
        container.querySelectorAll('.btn-add-option').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const paramId = btn.dataset.paramId;
                const optionsList = container.querySelector(`.options-list[data-param-id="${paramId}"]`);
                if (!optionsList) return;

                const newIndex = optionsList.querySelectorAll('.option-item').length;
                const newOptionHtml = `
                    <div class="option-item" data-param-id="${paramId}" data-index="${newIndex}">
                        <div class="option-item-grip" title="拖动排序">⋮⋮</div>
                        <input type="text" class="option-value" value="" placeholder="值 (value)" />
                        <input type="text" class="option-label" value="" placeholder="显示文本 (label)" />
                        <button type="button" class="btn-icon btn-remove-option" data-param-id="${paramId}" data-index="${newIndex}" title="删除选项">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>
                `;
                optionsList.insertAdjacentHTML('beforeend', newOptionHtml);

                // 绑定新选项的删除按钮
                const newOption = optionsList.lastElementChild;
                const removeBtn = newOption.querySelector('.btn-remove-option');
                removeBtn.addEventListener('click', () => {
                    newOption.remove();
                });

                // MutationObserver 会自动为新选项绑定拖拽事件
            });
        });

        // 绑定删除选项按钮
        container.querySelectorAll('.btn-remove-option').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const optionItem = btn.closest('.option-item');
                if (optionItem) {
                    optionItem.remove();
                }
            });
        });

        // 拖放排序
        let draggedCard = null;

        container.querySelectorAll('.parameter-card').forEach(card => {
            const dragHandle = card.querySelector('.btn-drag-handle');

            if (!dragHandle) return;

            // 只在拖拽手柄上绑定拖拽开始事件
            dragHandle.addEventListener('dragstart', (e) => {
                draggedCard = card;
                card.style.opacity = '0.4';
                e.dataTransfer.effectAllowed = 'move';
                // 阻止事件冒泡，避免影响其他元素
                e.stopPropagation();
            });

            dragHandle.addEventListener('dragend', (e) => {
                if (!draggedCard) return;

                card.style.opacity = '';
                container.querySelectorAll('.parameter-card').forEach(c => {
                    c.classList.remove('drag-over');
                });

                // 拖放结束后更新参数顺序并刷新预览
                const newOrder = {};
                container.querySelectorAll('.parameter-card').forEach(c => {
                    const paramId = c.dataset.paramId;
                    if (currentEditingProtocol.parameters[paramId]) {
                        newOrder[paramId] = currentEditingProtocol.parameters[paramId];
                    }
                });
                currentEditingProtocol.parameters = newOrder;
                refreshPreview();

                draggedCard = null;
            });

            // 在卡片上处理拖拽覆盖事件
            card.addEventListener('dragover', (e) => {
                if (!draggedCard) return;

                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';

                if (draggedCard && card !== draggedCard) {
                    const rect = card.getBoundingClientRect();
                    const midpoint = rect.top + rect.height / 2;

                    if (e.clientY < midpoint) {
                        card.parentNode.insertBefore(draggedCard, card);
                    } else {
                        card.parentNode.insertBefore(draggedCard, card.nextSibling);
                    }
                }
            });

            card.addEventListener('dragenter', (e) => {
                if (draggedCard && card !== draggedCard) {
                    card.classList.add('drag-over');
                }
            });

            card.addEventListener('dragleave', (e) => {
                card.classList.remove('drag-over');
            });

            card.addEventListener('drop', (e) => {
                e.preventDefault();
                card.classList.remove('drag-over');
            });
        });

        // 下拉选项拖放排序
        container.querySelectorAll('.options-list').forEach(optionsList => {
            let draggedOption = null;
            let observer = null;

            // 为每个选项的拖拽手柄绑定事件
            const bindOptionDrag = () => {
                optionsList.querySelectorAll('.option-item').forEach(option => {
                    const grip = option.querySelector('.option-item-grip');
                    if (!grip) return;

                    // 检查是否已经绑定过
                    if (grip.getAttribute('data-drag-bound') === 'true') return;

                    // 标记已绑定
                    grip.setAttribute('data-drag-bound', 'true');
                    grip.setAttribute('draggable', 'true');

                    grip.addEventListener('dragstart', (e) => {
                        draggedOption = option;
                        option.style.opacity = '0.4';
                        e.dataTransfer.effectAllowed = 'move';
                        e.stopPropagation();

                        // 暂停 MutationObserver
                        if (observer) {
                            observer.disconnect();
                        }
                    });

                    grip.addEventListener('dragend', (e) => {
                        if (!draggedOption) return;

                        option.style.opacity = '';
                        optionsList.querySelectorAll('.option-item').forEach(o => {
                            o.classList.remove('drag-over');
                        });

                        draggedOption = null;

                        // 恢复 MutationObserver
                        if (observer) {
                            observer.observe(optionsList, {
                                childList: true
                            });
                        }
                    });
                });

                // 在选项上处理拖拽覆盖事件（只绑定一次）
                optionsList.querySelectorAll('.option-item').forEach(option => {
                    // 检查是否已经绑定过
                    if (option.getAttribute('data-drop-bound') === 'true') return;

                    // 标记已绑定
                    option.setAttribute('data-drop-bound', 'true');

                    option.addEventListener('dragover', (e) => {
                        if (!draggedOption || draggedOption === option) return;

                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';

                        const rect = option.getBoundingClientRect();
                        const midpoint = rect.top + rect.height / 2;

                        // 判断应该插入的位置
                        const shouldInsertBefore = e.clientY < midpoint;
                        const nextSibling = option.nextSibling;

                        // 只有当位置真正改变时才移动
                        if (shouldInsertBefore && draggedOption.nextSibling !== option) {
                            optionsList.insertBefore(draggedOption, option);
                        } else if (!shouldInsertBefore && draggedOption !== nextSibling) {
                            optionsList.insertBefore(draggedOption, nextSibling);
                        }
                    });

                    option.addEventListener('dragenter', (e) => {
                        if (draggedOption && option !== draggedOption) {
                            option.classList.add('drag-over');
                        }
                    });

                    option.addEventListener('dragleave', (e) => {
                        option.classList.remove('drag-over');
                    });

                    option.addEventListener('drop', (e) => {
                        e.preventDefault();
                        option.classList.remove('drag-over');
                    });
                });
            };

            // 初始化拖拽
            bindOptionDrag();

            // 监听选项添加，重新绑定拖拽
            observer = new MutationObserver(() => {
                bindOptionDrag();
            });

            observer.observe(optionsList, {
                childList: true
            });
        });
    }

    /**
     * 查看协议JSON
     */
    function viewProtocolJSON(protocolId) {
        const protocol = getProtocol(protocolId);
        if (!protocol) {
            showToast('协议不存在', 'error');
            return;
        }

        const json = JSON.stringify(cleanProtocolConfig(protocol), null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = documentRef.createElement('a');
        a.href = url;
        a.download = `protocol-${protocolId}.json`;
        a.click();
        URL.revokeObjectURL(url);

        showToast(`协议 ${protocolId} 已导出`, 'success');
    }

    /**
     * 收集编辑器数据
     */
    function collectEditorData({ validate = true } = {}) {
        if (!currentEditingProtocol) return null;

        const nextProtocol = cleanProtocolConfig({
            ...currentEditingProtocol,
            label: documentRef.getElementById('protocol-label').value.trim(),
            urlTemplate: documentRef.getElementById('protocol-url-template').value.trim(),
            apikeyLocation: documentRef.getElementById('protocol-apikey-location').value,
            apikeyField: documentRef.getElementById('protocol-apikey-field').value.trim()
        });

        // 收集协议用途
        const taskTypes = [];
        if (documentRef.getElementById('task-type-chat').checked) taskTypes.push('chat');
        if (documentRef.getElementById('task-type-image').checked) taskTypes.push('image');
        if (documentRef.getElementById('task-type-video').checked) taskTypes.push('video');
        nextProtocol.taskTypes = taskTypes;

        // 收集图片编辑路径配置
        const imageEditPath = documentRef.getElementById('protocol-url-template-image-edit').value.trim();
        if (imageEditPath) {
            // 如果配置了图片编辑路径，创建 urlTemplates 对象
            if (!nextProtocol.urlTemplates) {
                nextProtocol.urlTemplates = {};
            }
            nextProtocol.urlTemplates.imageEdit = imageEditPath;
            // 同时保存主路径作为 image 路径（生成路径）
            nextProtocol.urlTemplates.image = nextProtocol.urlTemplate;
        } else {
            // 如果清空了图片编辑路径，删除 imageEdit 配置
            if (nextProtocol.urlTemplates) {
                delete nextProtocol.urlTemplates.imageEdit;
                // 如果 urlTemplates 为空对象，删除它
                if (Object.keys(nextProtocol.urlTemplates).length === 0) {
                    delete nextProtocol.urlTemplates;
                }
            }
        }

        // 参数
        const parameters = {};
        documentRef.querySelectorAll('.parameter-card').forEach(card => {
            const paramId = card.querySelector('.param-field-id').value.trim();
            if (!paramId) return;

            const originalParamId = card.dataset.paramId;
            const originalParam = currentEditingProtocol.parameters?.[originalParamId] || currentEditingProtocol.parameters?.[paramId] || {};
            const uiControl = card.querySelector('.param-field-ui-control').value;
            const defaultValue = card.querySelector('.param-field-default').value;
            const placeholder = card.querySelector('.param-field-placeholder')?.value.trim() || '';
            const rowsVal = card.querySelector('.param-field-rows')?.value.trim() || '';
            const requestField = card.querySelector('.param-field-request-field')?.value.trim() || '';

            // 收集参数的适用用途
            const paramTaskTypes = [];
            // 注意：不能用 data-param-id 查找，因为用户可能修改了参数ID
            // 应该在当前卡片内部查找
            const chatCheckbox = card.querySelector('.param-task-type-chat');
            const imageCheckbox = card.querySelector('.param-task-type-image');
            const videoCheckbox = card.querySelector('.param-task-type-video');

            if (chatCheckbox && chatCheckbox.checked) paramTaskTypes.push('chat');
            if (imageCheckbox && imageCheckbox.checked) paramTaskTypes.push('image');
            if (videoCheckbox && videoCheckbox.checked) paramTaskTypes.push('video');

            const newParam = cleanParameterConfig(paramId, {
                ...originalParam,
                id: paramId,
                label: card.querySelector('.param-field-title').value,
                exposed: card.querySelector('.param-field-exposed').checked,
                inputPort: card.querySelector('.param-field-input-port').checked,
                portType: card.querySelector('.param-field-port-type')?.value || 'text',
                required: card.querySelector('.param-field-required').checked,
                omitIfEmpty: card.querySelector('.param-field-omit-empty').checked,
                dataType: card.querySelector('.param-field-data-type').value,
                uiControl: uiControl
            });

            // 只在有选择时添加 taskTypes（留空表示适用所有用途）
            if (paramTaskTypes.length > 0) {
                newParam.taskTypes = paramTaskTypes;
            } else {
                delete newParam.taskTypes;
            }

            // 占位符与文本框行数
            if (placeholder) {
                newParam.placeholder = placeholder;
            } else {
                delete newParam.placeholder;
            }
            if (rowsVal) {
                newParam.rows = parseInt(rowsVal, 10) || 2;
            } else {
                delete newParam.rows;
            }

            // 请求体字段名（如果不为空）
            if (requestField) {
                newParam.requestField = requestField;
            } else {
                delete newParam.requestField;
            }

            // 默认值（根据数据类型转换）
            if (defaultValue !== '') {
                if (newParam.dataType === 'number') {
                    newParam.defaultValue = parseFloat(defaultValue);
                } else if (newParam.dataType === 'boolean') {
                    newParam.defaultValue = defaultValue === 'true';
                } else {
                    newParam.defaultValue = defaultValue;
                }
            } else {
                delete newParam.defaultValue;
            }

            // 如果是select类型，收集选项
            if (uiControl === 'select') {
                const optionsList = card.querySelector('.options-list');
                if (optionsList) {
                    const options = [];
                    optionsList.querySelectorAll('.option-item').forEach(item => {
                        const value = item.querySelector('.option-value').value.trim();
                        const label = item.querySelector('.option-label').value.trim();
                        if (value || label) {
                            options.push({
                                value: value,
                                label: label || value
                            });
                        }
                    });
                    newParam.options = options;
                }
            } else {
                delete newParam.options;
            }

            parameters[paramId] = newParam;
        });

        nextProtocol.parameters = parameters;

        if (validate) validateProtocolConfig(nextProtocol);

        draftProtocol = nextProtocol;
        currentEditingProtocol = draftProtocol;
        return cleanProtocolConfig(nextProtocol);
    }

    /**
     * 保存协议
     */
    async function saveProtocol() {
        setSaveStatus('正在保存配置...', 'saving');
        try {
            const data = collectEditorData();
            if (!data) {
                setSaveStatus();
                return;
            }

            // 准备覆盖配置数据（只保存可配置的部分）
            const overrideData = {
                label: data.label,
                helpText: data.helpText,
                urlTemplate: data.urlTemplate,
                urlTemplates: data.urlTemplates,
                taskTypes: data.taskTypes,
                apikeyLocation: data.apikeyLocation,
                apikeyField: data.apikeyField,
                parameters: data.parameters,
                responsePath: data.responsePath,
                fixedParams: data.fixedParams,
                videoMeta: data.videoMeta
            };

            // 调用后端API保存到文件
            const response = await fetch('/api/protocol/save', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    id: data.id,
                    config: overrideData
                })
            });

            const result = await response.json();

            if (response.ok && result.success) {
                setDraftProtocol(data);
                documentRef.getElementById('panel-title').textContent = `编辑协议: ${data.label}`;
                documentRef.getElementById('protocol-label').value = data.label || '';

                // 重新注册协议（包装后的完整协议对象）
                registerProtocol(data);
                notifyProtocolRegistryChange(data.id);

                // 重新渲染参数列表，确保显示最新的保存数据
                renderParametersList(data.parameters);

                setSaveStatus(`已保存：${data.label}`, 'success');
                showToast(`协议 ${data.id} 配置已保存到本地文件`, 'success');

                // 刷新所有使用该协议的图片生成节点
                if (typeof refreshImageGenerateNodes === 'function') {
                    try {
                        refreshImageGenerateNodes(data.id);
                        showToast('画布节点UI已更新', 'success');
                    } catch (error) {
                        console.error('刷新节点失败:', error);
                        showToast('节点UI更新失败，请刷新页面', 'warning');
                    }
                }

                // 保持在编辑界面，不返回列表
            } else {
                throw new Error(result.message || result.error || '保存失败');
            }
        } catch (error) {
            console.error('保存协议失败:', error);
            setSaveStatus(`保存失败：${error.message}`, 'error');
            showToast(`保存失败: ${error.message}`, 'error');
        }
    }

    /**
     * 导出协议JSON
     */
    function exportProtocol() {
        let data = null;
        try {
            data = collectEditorData();
            if (!data) return;
        } catch (error) {
            showToast(`导出失败: ${error.message}`, 'error');
            return;
        }

        const json = JSON.stringify(cleanProtocolConfig(data), null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = documentRef.createElement('a');
        a.href = url;
        a.download = `protocol-${data.id}-config.json`;
        a.click();
        URL.revokeObjectURL(url);

        showToast(`协议配置已导出`, 'success');
    }

    /**
     * 返回列表
     */
    function backToList() {
        // 切换视图
        documentRef.getElementById('protocol-editor-view').classList.add('hidden');
        documentRef.getElementById('protocol-list-view').classList.remove('hidden');

        // 隐藏底部按钮
        documentRef.getElementById('btn-save-protocol').classList.add('hidden');
        documentRef.getElementById('btn-export-protocol').classList.add('hidden');
        documentRef.getElementById('btn-delete-protocol-footer').classList.add('hidden');

        // 隐藏返回按钮
        documentRef.getElementById('btn-back-to-list').classList.add('hidden');

        // 恢复标题
        documentRef.getElementById('panel-title').textContent = '🛠️ 协议开发者面板';

        setSaveStatus();
        currentEditingProtocol = null;
        draftProtocol = null;
        renderProtocolList();
    }

    /**
     * 添加新参数
     */
    function addParameter() {
        if (!currentEditingProtocol) return;

        const paramId = prompt('输入新参数的ID（英文，如: myParam）:');
        if (!paramId || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(paramId)) {
            showToast('参数ID格式不正确', 'error');
            return;
        }

        if (currentEditingProtocol.parameters[paramId]) {
            showToast('参数ID已存在', 'error');
            return;
        }

        currentEditingProtocol.parameters[paramId] = {
            id: paramId,
            label: paramId,
            exposed: true,
            inputPort: false,
            uiControl: 'text',
            defaultValue: ''
        };

        renderParametersList(currentEditingProtocol.parameters);
    }

    /**
     * 创建新协议
     */
    function createProtocol() {
        const protocolId = prompt('输入新协议的ID（英文，如: my-custom）:');
        if (!protocolId || !/^[a-z][a-z0-9\-]*$/.test(protocolId)) {
            showToast('协议ID格式不正确（小写字母、数字、连字符）', 'error');
            return;
        }

        if (getProtocol(protocolId)) {
            showToast('协议ID已存在', 'error');
            return;
        }

        // 创建新协议对象
        const newProtocol = {
            id: protocolId,
            label: protocolId,
            taskTypes: ['image'],
            urlTemplate: '{{endpoint}}/v1/images/generations',
            apikeyLocation: 'header',
            apikeyField: 'Authorization',
            parameters: {
                model: {
                    id: 'model',
                    label: '模型',
                    exposed: false,
                    inputPort: false,
                    dataType: 'string',
                    uiControl: 'text',
                    defaultValue: '{{modelId}}',
                    required: true,
                    omitIfEmpty: false,
                    requestField: 'model'
                },
                prompt: {
                    id: 'prompt',
                    label: '提示词',
                    exposed: true,
                    inputPort: true,
                    portType: 'text',
                    dataType: 'string',
                    uiControl: 'textarea',
                    required: true,
                    omitIfEmpty: false,
                    requestField: 'prompt'
                }
            }
        };

        // 注册协议
        registerProtocol(newProtocol);
        notifyProtocolRegistryChange(newProtocol.id);
        showToast(`协议 ${protocolId} 已创建`, 'success');

        // 刷新列表并进入编辑模式
        renderProtocolList();
        editProtocol(protocolId);
    }

    /**
     * 删除协议
     */
    function deleteProtocol(protocolId) {
        const protocol = getProtocol(protocolId);
        if (!protocol) {
            showToast('协议不存在', 'error');
            return;
        }
        if (BUILT_IN_PROTOCOL_IDS.has(protocolId)) {
            showToast('内置协议不能删除，只能编辑保存', 'warning');
            return;
        }

        const confirmMsg = `确定要删除协议 "${protocol.label}" (${protocolId}) 吗？\n\n注意：删除仅在当前会话有效，刷新页面后会恢复。`;
        if (!confirm(confirmMsg)) {
            return;
        }

        // 从注册表中删除
        if (removeProtocol(protocolId)) {
            notifyProtocolRegistryChange(protocolId);
            showToast(`协议 ${protocolId} 已删除`, 'success');
            renderProtocolList();
        } else {
            showToast('删除协议失败', 'error');
        }
    }

    /**
     * 初始化面板
     */
    function initPanel() {
        createPanelHTML();

        const panel = documentRef.getElementById(panelId);

        // 关闭按钮
        documentRef.getElementById('btn-close-protocol-dev').addEventListener('click', closePanel);

        // 点击背景关闭
        panel.addEventListener('click', (e) => {
            if (e.target === panel) {
                closePanel();
            }
        });

        // 返回列表按钮
        documentRef.getElementById('btn-back-to-list').addEventListener('click', backToList);

        // 创建协议按钮
        documentRef.getElementById('btn-create-protocol').addEventListener('click', createProtocol);

        // 保存按钮
        documentRef.getElementById('btn-save-protocol').addEventListener('click', saveProtocol);

        // 导出按钮
        documentRef.getElementById('btn-export-protocol').addEventListener('click', exportProtocol);

        // 添加参数按钮
        documentRef.getElementById('btn-add-parameter').addEventListener('click', addParameter);

        // 底部删除按钮
        documentRef.getElementById('btn-delete-protocol-footer').addEventListener('click', () => {
            if (currentEditingProtocol) {
                deleteProtocol(currentEditingProtocol.id);
            }
        });
    }

    /**
     * 渲染节点UI预览
     */
    function renderNodeUIPreview() {
        if (!currentEditingProtocol) return;

        const container = documentRef.getElementById('node-ui-preview');
        const taskType = currentEditingProtocol.taskTypes?.[0] || 'image';

        let html = '';

        // 收集所有暴露的协议参数
        const exposedParams = [];
        documentRef.querySelectorAll('.parameter-card').forEach(card => {
            const paramId = card.querySelector('.param-field-id').value.trim();
            if (!paramId) return;

            const exposed = card.querySelector('.param-field-exposed').checked;
            const uiControl = card.querySelector('.param-field-ui-control').value;
            const originalParam = currentEditingProtocol.parameters?.[card.dataset.paramId] || currentEditingProtocol.parameters?.[paramId] || {};

            // 只显示暴露的参数（不再筛选任务类型）
            if (exposed) {
                let options = [];

                // 如果是select类型，从可视化编辑器收集选项
                if (uiControl === 'select') {
                    const optionsList = card.querySelector(`.options-list[data-param-id="${paramId}"]`);
                    if (optionsList) {
                        optionsList.querySelectorAll('.option-item').forEach(item => {
                            const value = item.querySelector('.option-value').value.trim();
                            const label = item.querySelector('.option-label').value.trim();
                            if (value || label) {
                                options.push({
                                    value: value,
                                    label: label || value
                                });
                            }
                        });
                    }
                }

                exposedParams.push({
                    id: paramId,
                    label: card.querySelector('.param-field-title').value || paramId,
                    uiControl: uiControl,
                    dataType: card.querySelector('.param-field-data-type').value,
                    defaultValue: card.querySelector('.param-field-default').value || originalParam.portCount || '',
                    portOnly: originalParam.portOnly === true,
                    portCount: originalParam.portCount,
                    options: options
                });
            }
        });

        // 渲染每个协议参数的UI控件
        html = exposedParams.map(param => {
            const fieldId = `preview-${param.id}`;
            let controlHTML = '';

            switch (param.uiControl) {
                case 'select':
                    // options 已经是数组格式，直接使用
                    const options = param.options || [];

                    // 如果有默认值，选中它；否则选中第一个
                    const selectedValue = param.defaultValue || (options[0]?.value || '');

                    controlHTML = `<select id="${fieldId}" class="node-preview-control" data-param-id="${param.id}">
                        ${options.map(opt => `<option value="${opt.value}" ${opt.value === selectedValue ? 'selected' : ''}>${opt.label}</option>`).join('')}
                    </select>`;
                    break;

                case 'number':
                    controlHTML = `<input type="number" id="${fieldId}" class="node-preview-control" data-param-id="${param.id}" value="${param.defaultValue || 0}" />`;
                    break;

                case 'toggle':
                    const checked = param.defaultValue === 'true' || param.defaultValue === true;
                    controlHTML = `<div class="node-preview-toggle">
                        <input type="checkbox" id="${fieldId}" class="node-preview-control" data-param-id="${param.id}" ${checked ? 'checked' : ''} />
                        <label for="${fieldId}">${param.label}</label>
                    </div>`;
                    break;

                case 'textarea':
                    controlHTML = `<textarea id="${fieldId}" class="node-preview-control" data-param-id="${param.id}" rows="3" placeholder="${param.label}">${param.defaultValue || ''}</textarea>`;
                    break;

                case 'text':
                default:
                    controlHTML = `<input type="text" id="${fieldId}" class="node-preview-control" data-param-id="${param.id}" value="${param.defaultValue || ''}" placeholder="${param.label}" />`;
                    break;
            }

            // toggle类型不需要额外的label
            if (param.uiControl === 'toggle') {
                return `<div class="node-preview-field">${controlHTML}</div>`;
            } else {
                return `<div class="node-preview-field">
                    <label for="${fieldId}">${param.label}</label>
                    ${controlHTML}
                </div>`;
            }
        }).join('');

        if (!html) {
            container.innerHTML = '<div style="color: var(--text-secondary); text-align: center; padding: 16px;">没有暴露的参数<br><small>勾选参数的"暴露在节点UI"来显示预览</small></div>';
            return;
        }

        container.innerHTML = html;

        // 绑定输入事件，实时更新请求体预览
        container.querySelectorAll('.node-preview-control').forEach(control => {
            control.addEventListener('input', () => {
                updatePreviewWithNodeValues();
            });
            control.addEventListener('change', () => {
                updatePreviewWithNodeValues();
            });
        });
    }

    /**
     * 使用节点预览的值更新请求体预览
     */
    function updatePreviewWithNodeValues() {
        if (!currentEditingProtocol) return;

        const previewContainer = documentRef.getElementById('protocol-preview');
        const taskType = currentEditingProtocol.taskTypes?.[0] || 'image';

        try {
            // 读取API Key配置
            const apikeyLocation = documentRef.getElementById('protocol-apikey-location').value;
            const apikeyField = documentRef.getElementById('protocol-apikey-field').value || 'Authorization';
            const urlTemplate = documentRef.getElementById('protocol-url-template').value || '{{endpoint}}/v1/endpoint';
            const imageEditPath = documentRef.getElementById('protocol-url-template-image-edit').value.trim();

            // 收集当前编辑器中的参数定义
            const currentParameters = {};
            documentRef.querySelectorAll('.parameter-card').forEach(card => {
                const paramId = card.querySelector('.param-field-id').value.trim();
                if (!paramId) return;

                const defaultValueInput = card.querySelector('.param-field-default');
                const defaultValueRaw = defaultValueInput ? defaultValueInput.value : '';
                const dataType = card.querySelector('.param-field-data-type').value;
                const requestField = card.querySelector('.param-field-request-field')?.value.trim() || '';
                const originalParamId = card.dataset.paramId;
                const originalParam = currentEditingProtocol.parameters?.[originalParamId] || currentEditingProtocol.parameters?.[paramId] || {};

                currentParameters[paramId] = {
                    ...pickSerializableFields(originalParam, PARAMETER_CONFIG_KEYS),
                    id: paramId,
                    label: card.querySelector('.param-field-title').value,
                    exposed: card.querySelector('.param-field-exposed').checked,
                    inputPort: card.querySelector('.param-field-input-port').checked,
                    portType: card.querySelector('.param-field-port-type')?.value || 'text',
                    required: card.querySelector('.param-field-required').checked,
                    omitIfEmpty: card.querySelector('.param-field-omit-empty').checked,
                    dataType: dataType,
                    uiControl: card.querySelector('.param-field-ui-control').value
                };

                // 请求体字段名（如果不为空）
                if (requestField) {
                    currentParameters[paramId].requestField = requestField;
                }

                // 默认值（根据数据类型转换）
                if (defaultValueRaw !== '') {
                    if (dataType === 'number') {
                        currentParameters[paramId].defaultValue = parseFloat(defaultValueRaw);
                    } else if (dataType === 'boolean') {
                        currentParameters[paramId].defaultValue = defaultValueRaw === 'true';
                    } else {
                        currentParameters[paramId].defaultValue = defaultValueRaw;
                    }
                }
            });

            // 创建临时协议对象
            const tempProtocol = {
                ...currentEditingProtocol,
                urlTemplate: urlTemplate,
                apikeyLocation: apikeyLocation,
                apikeyField: apikeyField,
                parameters: currentParameters
            };

            // 如果配置了图片编辑路径，添加到 urlTemplates
            if (imageEditPath) {
                tempProtocol.urlTemplates = {
                    image: urlTemplate,
                    imageEdit: imageEditPath
                };
            }

            // 重新包装协议
            const wrappedProtocol = wrapConfigProtocol(tempProtocol);

            // 构建模拟上下文，使用节点预览的值
            const mockApiConfig = {
                endpoint: 'https://api.example.com'
            };

            const mockModelConfig = {
                modelId: 'test-model-id'
            };

            const mockContext = {
                apiConfig: mockApiConfig,
                modelConfig: mockModelConfig,
                taskType: taskType,
                parameters: {},
                inputs: {}
            };

            // 从节点预览UI中读取值
            documentRef.querySelectorAll('.node-preview-control').forEach(control => {
                const paramId = control.dataset.paramId;
                const param = currentParameters[paramId];
                if (!param) return;
                if (param.portOnly === true || paramId === 'referenceImages' || param.id === 'referenceImages') return;

                let value;
                if (control.type === 'checkbox') {
                    value = control.checked;
                } else if (param.dataType === 'number') {
                    value = parseFloat(control.value) || 0;
                } else {
                    value = control.value;
                }

                mockContext.parameters[paramId] = value;
            });

            // 添加默认的prompt（如果参数定义中有prompt但用户没有输入值）
            if (currentParameters.prompt && !mockContext.parameters.prompt) {
                mockContext.parameters.prompt = '这是一个测试提示词';
            }

            // 构建URL（两种情况：无参考图和有参考图）
            let requestUrlNoImages = 'https://api.example.com/v1/endpoint';
            let requestUrlWithImages = 'https://api.example.com/v1/endpoint';
            let showImageEditUrl = false;

            if (typeof wrappedProtocol.buildUrl === 'function') {
                try {
                    // 无参考图的情况
                    const contextNoImages = { ...mockContext, inputs: {} };
                    requestUrlNoImages = wrappedProtocol.buildUrl(mockApiConfig, mockModelConfig, taskType, contextNoImages);

                    // 有参考图的情况（仅当配置了图片编辑路径时才显示）
                    if (imageEditPath && taskType === 'image') {
                        const contextWithImages = {
                            ...mockContext,
                            inputs: {
                                image: 'https://example.com/reference-image.jpg'
                            }
                        };
                        requestUrlWithImages = wrappedProtocol.buildUrl(mockApiConfig, mockModelConfig, taskType, contextWithImages);
                        showImageEditUrl = requestUrlNoImages !== requestUrlWithImages;
                    }
                } catch (error) {
                    console.error('buildUrl 失败:', error);
                }
            }

            // 调用buildRequest生成请求体
            let requestBody;
            if (typeof wrappedProtocol.buildRequest === 'function') {
                requestBody = wrappedProtocol.buildRequest(mockContext);
            } else {
                requestBody = { error: 'buildRequest 函数不存在' };
            }

            // 构建完整的请求预览
            const preview = {
                method: 'POST',
                url: requestUrlNoImages,
                headers: {},
                query: {},
                body: requestBody
            };

            // 如果有图片编辑路径，添加到预览中
            if (showImageEditUrl) {
                preview.url_with_reference_images = requestUrlWithImages;
            }

            // 根据API Key位置添加到预览
            const mockApiKey = 'sk-example-api-key-1234567890';

            // 处理 API Key 字段名模板
            function processApiKeyField(fieldTemplate, apiKey) {
                if (!fieldTemplate) return apiKey;

                // 如果字段名包含 {apikey} 占位符，替换它
                if (fieldTemplate.includes('{apikey}')) {
                    return fieldTemplate.replace(/{apikey}/g, apiKey);
                }

                // 否则返回原始的 API Key
                return apiKey;
            }

            switch (apikeyLocation) {
                case 'header':
                    // 如果字段名包含冒号，说明是 "HeaderName: Value" 格式
                    if (apikeyField.includes(':')) {
                        const [headerName, ...valueParts] = apikeyField.split(':');
                        const valueTemplate = valueParts.join(':').trim();
                        preview.headers[headerName.trim()] = processApiKeyField(valueTemplate, mockApiKey);
                    } else {
                        preview.headers[apikeyField] = mockApiKey;
                    }
                    preview.headers['Content-Type'] = 'application/json';
                    break;
                case 'query':
                    preview.query[apikeyField] = processApiKeyField(apikeyField, mockApiKey);
                    preview.headers['Content-Type'] = 'application/json';
                    break;
                case 'body':
                    preview.body[apikeyField] = mockApiKey;
                    preview.headers['Content-Type'] = 'application/json';
                    break;
            }

            // 格式化并显示
            const formatted = JSON.stringify(preview, null, 2);
            previewContainer.innerHTML = `<pre><code>${escapeHtmlForPreview(formatted)}</code></pre>`;

        } catch (error) {
            console.error('更新预览失败:', error);
            previewContainer.innerHTML = `<pre style="color: var(--danger-color);">// 生成预览失败\n// ${error.message}</pre>`;
        }
    }

    /**
     * 刷新请求体预览
     */
    function refreshPreview() {
        if (!currentEditingProtocol) return;

        // 先渲染节点UI预览
        renderNodeUIPreview();

        // 然后更新请求体预览
        updatePreviewWithNodeValues();
    }

    /**
     * 设置实时预览
     */
    function setupLivePreview() {
        if (livePreviewBound) {
            refreshPreview();
            return;
        }
        livePreviewBound = true;

        // 参数变化时更新预览（使用防抖）
        let previewTimeout = null;
        const debouncedPreview = () => {
            clearTimeout(previewTimeout);
            previewTimeout = setTimeout(refreshPreview, 200);
        };

        // 监听参数列表的变化
        const parametersList = documentRef.getElementById('parameters-list');
        parametersList.addEventListener('input', debouncedPreview);
        parametersList.addEventListener('change', (e) => {
            // checkbox、select等立即刷新
            if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') {
                clearTimeout(previewTimeout);
                refreshPreview();
            } else {
                debouncedPreview();
            }
        });

        // 监听基本信息变化
        documentRef.getElementById('protocol-label').addEventListener('input', () => {
            setSaveStatus('显示名称已修改，尚未保存', 'dirty');
            debouncedPreview();
        });
        documentRef.getElementById('protocol-url-template').addEventListener('input', debouncedPreview);
        documentRef.getElementById('protocol-url-template-image-edit').addEventListener('input', debouncedPreview);
        documentRef.getElementById('protocol-apikey-location').addEventListener('change', refreshPreview);
        documentRef.getElementById('protocol-apikey-field').addEventListener('input', debouncedPreview);

        // 监听协议用途变化
        documentRef.getElementById('task-type-chat').addEventListener('change', refreshPreview);
        documentRef.getElementById('task-type-image').addEventListener('change', refreshPreview);
        documentRef.getElementById('task-type-video').addEventListener('change', refreshPreview);
    }

    /**
     * HTML转义（用于预览）
     */
    function escapeHtmlForPreview(str) {
        const div = documentRef.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * 打开面板
     */
    async function openPanel() {
        const panel = documentRef.getElementById(panelId);
        panel.classList.remove('hidden');

        // 首次打开时加载协议
        if (!protocolsLoaded) {
            // 显示加载提示
            const listContainer = documentRef.getElementById('protocol-list');
            listContainer.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">加载协议中...</div>';

            try {
                await loadProtocols();
                protocolsLoaded = true;
                notifyProtocolRegistryChange();
                renderProtocolList();
            } catch (error) {
                console.error('加载协议失败:', error);
                listContainer.innerHTML = '<div style="text-align:center;padding:40px;color:var(--danger-color);">❌ 加载协议失败，请刷新页面重试</div>';
                showToast('加载协议失败', 'error');
            }
        } else {
            renderProtocolList();
        }
    }

    /**
     * 关闭面板
     */
    function closePanel() {
        const panel = documentRef.getElementById(panelId);
        panel.classList.add('hidden');
        backToList();
    }

    // 初始化
    initPanel();

    return {
        openPanel,
        closePanel
    };
}
