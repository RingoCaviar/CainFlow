/**
 * 根据节点类型与恢复数据生成节点的 HTML 结构。
 */
import {
    DOUBAO_VIDEO_RATIO_OPTIONS,
    DOUBAO_VIDEO_RESOLUTION_OPTIONS,
    getEffectiveProtocol,
    getImageResolutionOptionsForModel,
    getModelProviders,
    getResolvedProviderForModel,
    getResolvedProviderIdForModel,
    getModelsForTask,
    getVideoProtocolOptionMeta,
    normalizeImageResolutionForModel,
    VIDEO_ASPECT_OPTIONS
} from '../features/execution/provider-request-utils.js';
import { splitTextForTextSplitNode } from '../core/common-utils.js';
import { applyReferenceImagePorts } from './reference-image-ports.js';
import { getCustomParamsInputPorts } from './types/custom-params.js';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderPorts(id, ports, direction) {
    if (!ports.length) return '';

    const items = ports.map((port) => {
        if (direction === 'input') {
            return `<div class="node-port input" data-node-id="${id}" data-port="${port.name}" data-type="${port.type}" data-direction="input">
                <div class="port-dot type-${port.type}"></div>
                <span class="port-label">${port.label}</span>
            </div>`;
        }

        return `<div class="node-port output" data-node-id="${id}" data-port="${port.name}" data-type="${port.type}" data-direction="output">
                <span class="port-label">${port.label}</span>
                <div class="port-dot type-${port.type}"></div>
            </div>`;
    }).join('');

    return `<div class="node-${direction === 'input' ? 'inputs' : 'outputs'}-section">${items}</div>`;
}

function getTextSplitTextValue(restoreData = {}) {
    const rd = restoreData || {};
    return rd.text || rd.lastText || '';
}

function getTextSplitDelimiterValue(restoreData = {}) {
    const rd = restoreData || {};
    return rd.delimiter !== undefined ? rd.delimiter : '\n\n';
}

function getTextSplitRemoveEmptyLinesValue(restoreData = {}) {
    const rd = restoreData || {};
    return rd.removeEmptyLines === true;
}

function getTextSplitPreviewEnabledValue(restoreData = {}) {
    const rd = restoreData || {};
    return rd.previewEnabled !== false;
}

function getTextSplitMergeOutputEnabledValue(restoreData = {}) {
    const rd = restoreData || {};
    return rd.mergeOutputEnabled === true;
}

function normalizeTextSplitOutputCountValue(value, fallback = 1) {
    const parsed = parseInt(value ?? fallback, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : Math.max(0, fallback);
}

function getTextSplitPartsFromRestoreData(restoreData = {}) {
    const rd = restoreData || {};
    if (Array.isArray(rd.parts) && rd.parts.length > 0) return rd.parts;
    return splitTextForTextSplitNode(
        getTextSplitTextValue(rd),
        getTextSplitDelimiterValue(rd),
        { removeEmptyLines: getTextSplitRemoveEmptyLinesValue(rd) }
    );
}

function getTextSplitOutputCountSettingValue(restoreData = {}) {
    const rd = restoreData || {};
    if (getTextSplitMergeOutputEnabledValue(rd)) return 0;
    if (rd.outputCount !== undefined && rd.outputCount !== '') {
        return normalizeTextSplitOutputCountValue(rd.outputCount);
    }
    return 0;
}

function getTextSplitRenderedOutputCountValue(restoreData = {}) {
    const setting = getTextSplitOutputCountSettingValue(restoreData);
    if (setting > 0) return setting;
    return Math.max(1, getTextSplitPartsFromRestoreData(restoreData).length);
}

function getTextSplitOutputPorts(restoreData = {}) {
    if (getTextSplitMergeOutputEnabledValue(restoreData)) {
        return [{
            name: 'text',
            type: 'text',
            label: '多文本输出'
        }];
    }
    const count = getTextSplitRenderedOutputCountValue(restoreData);
    return Array.from({ length: count }, (_, index) => ({
        name: `part_${index + 1}`,
        type: 'text',
        label: `片段 ${index + 1}`
    }));
}

function normalizeImageMergeInputCountValue(value, fallback = 1) {
    const parsed = parseInt(value ?? fallback, 10);
    return Number.isFinite(parsed) ? Math.max(1, parsed) : Math.max(1, fallback);
}

function getImageMergeInputPorts(restoreData = {}) {
    const count = normalizeImageMergeInputCountValue(restoreData?.inputCount || restoreData?.imageMergeInputCount || 1);
    return Array.from({ length: count }, (_, index) => ({
        name: `image_${index + 1}`,
        type: 'image',
        label: `图片 ${index + 1}`
    }));
}

function getTextMergeInputPorts(restoreData = {}) {
    const count = normalizeImageMergeInputCountValue(restoreData?.inputCount || restoreData?.textMergeInputCount || 1);
    return Array.from({ length: count }, (_, index) => ({
        name: `text_${index + 1}`,
        type: 'text',
        label: `文本 ${index + 1}`
    }));
}

function renderPortSections(id, config) {
    const inputPorts = renderPorts(id, config.inputs || [], 'input');
    const outputPorts = renderPorts(id, config.outputs || [], 'output');

    if (!inputPorts && !outputPorts) return '';

    const rowClasses = ['node-ports-row'];
    if (inputPorts && outputPorts) rowClasses.push('has-inputs', 'has-outputs');
    else if (inputPorts) rowClasses.push('has-inputs-only');
    else if (outputPorts) rowClasses.push('has-outputs-only');

    return `
        <div class="${rowClasses.join(' ')}">
            ${inputPorts}
            ${outputPorts}
        </div>
    `;
}

function renderNodeHeader(id, config, options = {}) {
    const collapseTitle = options.collapsed ? '展开节点' : '折叠节点';
    const collapseStateClass = options.collapsed ? 'is-collapsed' : '';
    const displayTitle = options.customTitle || config.title;
    const cloneBadge = options.isClone
        ? `
        <button type="button" class="node-clone-badge" data-node-id="${id}" title="跳转到源节点" aria-label="跳转到源节点">
            <span class="node-clone-badge__icon" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                    <rect x="9" y="9" width="11" height="11" rx="2"></rect>
                    <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"></path>
                </svg>
            </span>
            <span class="node-clone-badge__label">克隆</span>
        </button>`
        : '';
    return `
        <div class="node-glass-bg"></div>
        ${cloneBadge}
        <div class="node-header" data-node-id="${id}" title="双击折叠或展开">
            <div class="header-left">
                ${config.icon}
                <span class="node-title">${escapeHtml(displayTitle)}</span>
            </div>
            <div class="header-right">
                <span class="node-time-badge" id="${id}-time-container" style="display:none">
                    <div class="heartbeat-dot" id="${id}-heartbeat" title="连接正常"></div>
                    <span id="${id}-time"></span>
                </span>
                <button class="node-collapse-btn ${collapseStateClass}" data-node-id="${id}" title="${collapseTitle}" aria-label="${collapseTitle}" aria-expanded="${options.collapsed ? 'false' : 'true'}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </button>
                <button class="node-bypass-btn" data-node-id="${id}" title="启用/禁用节点">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
                </button>
                <button class="node-delete" data-node-id="${id}" title="删除节点">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        </div>
        <div class="node-resize-handle" data-node-id="${id}"></div>
    `;
}

function renderNodeRunCancelButton(id) {
    return `
        <button type="button" class="node-run-cancel-btn" data-node-id="${id}" title="长按 2 秒取消此节点运行" aria-label="长按 2 秒取消此节点运行">
            <span class="node-run-cancel-btn__icon" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </span>
            <span class="node-run-cancel-btn__label">取消</span>
        </button>
    `;
}

function renderApiConfigOptions(models, providers, selectedId, taskType) {
    const filteredModels = getModelsForTask(models, taskType);
    const hasSelectedModel = filteredModels.some((model) => model.id === selectedId);
    const missingSelectedOption = selectedId && !hasSelectedModel
        ? `<option value="${selectedId}" selected>缺失模型：${selectedId}</option>`
        : '';
    if (filteredModels.length === 0) {
        return missingSelectedOption || '<option value="">-- 暂无可用模型 --</option>';
    }

    return missingSelectedOption + filteredModels.map((model) => {
        const selected = selectedId === model.id ? 'selected' : '';
        return `<option value="${model.id}" ${selected}>${model.name || model.modelId || model.id}</option>`;
    }).join('');
}

function getSelectedModelForTask(models, selectedId, taskType) {
    const filteredModels = getModelsForTask(models, taskType);
    return filteredModels.find((model) => model.id === selectedId) || filteredModels[0] || null;
}

function renderImageResolutionOptions(model, providers, selectedResolution) {
    const normalizedResolution = normalizeImageResolutionForModel(selectedResolution, model, providers);
    return getImageResolutionOptionsForModel(model, providers)
        .map((option) => {
            const selected = option.value === normalizedResolution ? 'selected' : '';
            return `<option value="${option.value}" ${selected}>${option.label}</option>`;
        })
        .join('');
}

function getTextareaHeightStyle(restoreData = {}, key) {
    const height = Number(restoreData?.textareaHeights?.[key]);
    return Number.isFinite(height) && height > 0 ? ` style="height:${Math.round(height)}px"` : '';
}

function getResponseAreaHeightStyle(restoreData = {}, key) {
    const height = Number(restoreData?.textareaHeights?.[key]);
    return Number.isFinite(height) && height > 0 ? ` style="height:${Math.round(height)}px"` : '';
}

function renderNodeFormField({
    label = '',
    content = '',
    fieldClass = '',
    fieldId = '',
    note = ''
} = {}) {
    const classes = ['node-field', 'node-form-field'];
    if (fieldClass) classes.push(fieldClass);
    const idAttr = fieldId ? ` id="${fieldId}"` : '';
    return `
        <div class="${classes.join(' ')}"${idAttr}>
            ${label ? `<label>${label}</label>` : ''}
            ${content}
            ${note ? `<div class="node-form-note">${note}</div>` : ''}
        </div>
    `;
}

function renderNodeFormToggleField({
    label = '',
    inputId = '',
    checked = false,
    hidden = false,
    fieldId = '',
    note = ''
} = {}) {
    return renderNodeFormField({
        fieldClass: `node-field-row node-field-row-compact${hidden ? ' hidden' : ''}`,
        fieldId,
        content: `
            <label class="node-field-inline-label" for="${inputId}">${label}</label>
            <label class="toggle-switch">
                <input type="checkbox" id="${inputId}" ${checked ? 'checked' : ''} />
                <span class="toggle-slider"></span>
            </label>
        `,
        note
    });
}

function renderNodeFormNote(note, options = {}) {
    return renderNodeFormField({
        fieldClass: `${options.fieldClass || ''} node-field-note`.trim(),
        fieldId: options.fieldId || '',
        content: note ? `<div class="video-generate-note">${note}</div>` : ''
    });
}

function renderImageImportUrlPreviewContent(imageUrl, message = '') {
    const safeUrl = escapeHtml(imageUrl || '');
    const fallbackMessage = imageUrl ? '请输入有效的图片 URL' : '输入 URL 后自动显示预览';
    if (imageUrl) {
        return `
            <img src="${safeUrl}" alt="URL 图片预览" draggable="false" style="pointer-events: none;" loading="eager" decoding="async" fetchpriority="high" referrerpolicy="no-referrer" />
            <button type="button" class="image-import-url-refresh" title="重新加载预览" aria-label="重新加载 URL 图片预览">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
            </button>
        `;
    }
    return `<div class="drop-text">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        ${escapeHtml(message || fallbackMessage)}
    </div>`;
}

function renderImageImportBody(id, restoreData) {
    const rd = restoreData || {};
    const importMode = rd.importMode === 'url' ? 'url' : 'upload';
    const imageUrl = rd.imageUrl || '';
    const hasLocalImage = !!rd.imageData;
    const hasUrlImage = importMode === 'url' && !!imageUrl;

    return `
        <div class="image-resize-mode-shell image-import-mode-shell">
            <div class="image-resize-mode-group image-import-mode-group">
                <button type="button" class="image-resize-mode-btn image-import-mode-btn ${importMode === 'upload' ? 'active' : ''}" data-target="${id}" data-mode="upload">上传</button>
                <button type="button" class="image-resize-mode-btn image-import-mode-btn ${importMode === 'url' ? 'active' : ''}" data-target="${id}" data-mode="url">URL</button>
            </div>
        </div>
        <input type="hidden" id="${id}-import-mode" value="${importMode}" />

        <div class="image-import-upload-section ${importMode === 'upload' ? '' : 'hidden'}" id="${id}-upload-section">
            <div class="file-drop-zone${hasLocalImage ? ' has-image' : ''}" id="${id}-drop">
                ${hasLocalImage
                    ? `<div class="drop-text">正在恢复图片预览...</div>`
                    : `<div class="drop-text">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                        拖拽图片到此处
                    </div>`}
            </div>
            <button class="select-file-btn" id="${id}-select-btn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                选择文件
            </button>
            <input type="file" accept="image/*" id="${id}-file" style="display:none" />
        </div>

        <div class="image-import-url-section ${importMode === 'url' ? '' : 'hidden'}" id="${id}-url-section">
            <div class="node-field">
                <label>图片链接</label>
                <input type="url" id="${id}-url-input" value="${escapeHtml(imageUrl)}" placeholder="https://example.com/image.png" />
            </div>
            <div class="file-drop-zone image-import-url-preview${hasUrlImage ? ' has-image' : ''}" id="${id}-url-preview">
                ${hasUrlImage ? renderImageImportUrlPreviewContent(imageUrl) : renderImageImportUrlPreviewContent('')}
            </div>
            <div class="image-import-url-note">URL 模式仅支持 OpenAI 兼容参考图，不支持缩放和保存节点。</div>
        </div>

        <div class="image-resolution-badge" id="${id}-res" style="display:none"></div>
    `;
}

function renderImageGenerateBody(id, restoreData, models, providers) {
    const rd = restoreData || {};
    const opts = renderApiConfigOptions(models, providers, rd.apiConfigId, 'image');
    const selectedModel = getSelectedModelForTask(models, rd.apiConfigId, 'image');
    const selectedProviderId = getResolvedProviderIdForModel(selectedModel, providers, rd.providerId || '');
    const modelProviders = getModelProviders(selectedModel, providers);
    const providerOptions = modelProviders
        .map((provider) => `<option value="${provider.id}" ${selectedProviderId === provider.id ? 'selected' : ''}>${provider.name || provider.id}</option>`)
        .join('');
    const resolutionOptions = renderImageResolutionOptions(selectedModel, providers, rd.resolution);
    const selectedProvider = getResolvedProviderForModel(selectedModel, providers, selectedProviderId);
    const protocol = getEffectiveProtocol(selectedModel, selectedProvider);
    const isOpenAiModel = !!selectedModel && protocol === 'openai';
    const isTtapiOpenAiModel = !!selectedModel && protocol === 'ttapi-openai';
    const isNewApiAsyncImage = !!selectedModel && protocol === 'newapi-image-async';
    const usesOpenAiImageControls = isOpenAiModel || isTtapiOpenAiModel;
    const showResolutionParamNote = usesOpenAiImageControls;
    const showCustomResolution = rd.resolution === 'custom';
    const imageQuality = ['low', 'medium', 'high'].includes(String(rd.quality || '').toLowerCase())
        ? String(rd.quality).toLowerCase()
        : 'auto';
    const imageModeration = ['low', 'auto'].includes(String(rd.moderation || '').toLowerCase())
        ? String(rd.moderation).toLowerCase()
        : 'auto';
    const imageBackground = ['transparent', 'opaque', 'auto'].includes(String(rd.background || '').toLowerCase())
        ? String(rd.background).toLowerCase()
        : 'auto';
    const customResolutionMatch = String(rd.customResolution || '').match(/^(\d{2,5})x(\d{2,5})$/i);
    const customWidth = rd.customWidth || customResolutionMatch?.[1] || '';
    const customHeight = rd.customHeight || customResolutionMatch?.[2] || '';
    const generationCount = Math.max(1, parseInt(rd.generationCount || '1', 10) || 1);

    return `
        ${renderNodeFormField({
            label: 'API 配置',
            content: `<select id="${id}-apiconfig">${opts}</select>`
        })}
        ${renderNodeFormField({
            label: '供应商',
            fieldId: `${id}-provider-field`,
            content: `<select id="${id}-provider">${providerOptions || '<option value="">-- 暂无可用供应商 --</option>'}</select>`
        })}
        ${renderNodeFormField({
            label: '生成次数',
            content: `
                <div class="generation-count-control">
                    <button type="button" class="generation-count-btn" data-target="${id}" data-delta="-1" title="减少生成次数">-</button>
                    <input type="number" id="${id}-generation-count" class="generation-count-input" value="${generationCount}" min="1" step="1" />
                    <button type="button" class="generation-count-btn" data-target="${id}" data-delta="1" title="增加生成次数">+</button>
                </div>
            `
        })}
        ${renderNodeFormField({
            label: '宽高比',
            fieldClass: usesOpenAiImageControls ? 'hidden' : '',
            fieldId: `${id}-aspect-field`,
            content: `<select id="${id}-aspect">
                <option value="" ${!rd.aspect ? 'selected' : ''}>自动</option>
                <option value="1:1" ${rd.aspect === '1:1' ? 'selected' : ''}>1:1</option>
                <option value="1:4" ${rd.aspect === '1:4' ? 'selected' : ''}>1:4</option>
                <option value="1:8" ${rd.aspect === '1:8' ? 'selected' : ''}>1:8</option>
                <option value="2:3" ${rd.aspect === '2:3' ? 'selected' : ''}>2:3</option>
                <option value="3:2" ${rd.aspect === '3:2' ? 'selected' : ''}>3:2</option>
                <option value="3:4" ${rd.aspect === '3:4' ? 'selected' : ''}>3:4</option>
                <option value="4:1" ${rd.aspect === '4:1' ? 'selected' : ''}>4:1</option>
                <option value="4:3" ${rd.aspect === '4:3' ? 'selected' : ''}>4:3</option>
                <option value="4:5" ${rd.aspect === '4:5' ? 'selected' : ''}>4:5</option>
                <option value="5:4" ${rd.aspect === '5:4' ? 'selected' : ''}>5:4</option>
                <option value="8:1" ${rd.aspect === '8:1' ? 'selected' : ''}>8:1</option>
                <option value="9:16" ${rd.aspect === '9:16' ? 'selected' : ''}>9:16</option>
                <option value="16:9" ${rd.aspect === '16:9' ? 'selected' : ''}>16:9</option>
                <option value="21:9" ${rd.aspect === '21:9' ? 'selected' : ''}>21:9</option>
            </select>`,
            note: showResolutionParamNote ? '' : ''
        })}
        ${renderNodeFormField({
            label: '分辨率',
            content: `
                <select id="${id}-resolution">
                    ${resolutionOptions}
                </select>
                <div class="image-resolution-param-note ${showResolutionParamNote ? '' : 'hidden'}" id="${id}-resolution-param-note">很多中转 API 并不支持 Size 参数，所以你设置分辨率是无效的</div>
            `
        })}
        ${renderNodeFormField({
            label: '质量',
            fieldClass: usesOpenAiImageControls && !isNewApiAsyncImage ? '' : 'hidden',
            fieldId: `${id}-quality-field`,
            content: `<select id="${id}-quality">
                <option value="auto" ${imageQuality === 'auto' ? 'selected' : ''}>自动</option>
                <option value="low" ${imageQuality === 'low' ? 'selected' : ''}>低</option>
                <option value="medium" ${imageQuality === 'medium' ? 'selected' : ''}>中</option>
                <option value="high" ${imageQuality === 'high' ? 'selected' : ''}>高</option>
            </select>`
        })}
        ${renderNodeFormField({
            label: '内容审核',
            fieldClass: usesOpenAiImageControls && !isNewApiAsyncImage ? '' : 'hidden',
            fieldId: `${id}-moderation-field`,
            content: `<select id="${id}-moderation">
                <option value="auto" ${imageModeration === 'auto' ? 'selected' : ''}>自动（auto）</option>
                <option value="low" ${imageModeration === 'low' ? 'selected' : ''}>低限制（low）</option>
            </select>`
        })}
        ${renderNodeFormField({
            label: '背景',
            fieldClass: usesOpenAiImageControls && !isNewApiAsyncImage ? '' : 'hidden',
            fieldId: `${id}-background-field`,
            content: `<select id="${id}-background">
                <option value="auto" ${imageBackground === 'auto' ? 'selected' : ''}>自动（auto）</option>
                <option value="transparent" ${imageBackground === 'transparent' ? 'selected' : ''}>透明（transparent）</option>
                <option value="opaque" ${imageBackground === 'opaque' ? 'selected' : ''}>不透明（opaque）</option>
            </select>`
        })}
        ${renderNodeFormField({
            label: '自定义分辨率',
            fieldClass: showCustomResolution ? '' : 'hidden',
            fieldId: `${id}-custom-resolution-field`,
            content: `
                <div style="display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:6px;">
                    <input type="number" id="${id}-custom-resolution-width" value="${customWidth}" placeholder="宽度" min="1" max="99999" />
                    <span style="color:var(--text-dim);font-size:12px;">x</span>
                    <input type="number" id="${id}-custom-resolution-height" value="${customHeight}" placeholder="高度" min="1" max="99999" />
                </div>
                <div class="custom-resolution-hint" id="${id}-custom-resolution-hint" aria-live="polite"></div>
            `
        })}
        ${renderNodeFormToggleField({
            label: '启用搜索',
            inputId: `${id}-search`,
            checked: rd.search === true,
            hidden: usesOpenAiImageControls || isNewApiAsyncImage,
            fieldId: `${id}-search-field`
        })}

        ${renderNodeFormField({
            label: '提示词',
            fieldId: `${id}-prompt-field`,
            fieldClass: 'node-field-expand',
            content: `<textarea class="image-generate-prompt" id="${id}-prompt" placeholder="描述你想生成的图片..." rows="3"${getTextareaHeightStyle(rd, 'prompt')}>${rd.prompt || ''}</textarea>`
        })}
        ${renderNodeFormField({
            label: '系统提示词',
            fieldId: `${id}-system-prompt-field`,
            fieldClass: 'node-field-expand',
            content: `<textarea class="image-generate-system-prompt" id="${id}-system-prompt" placeholder="设定生成规则、风格或限制..." rows="2"${getTextareaHeightStyle(rd, 'systemPrompt')}>${rd.systemPrompt || ''}</textarea>`
        })}
        <div class="node-field ${isNewApiAsyncImage ? '' : 'hidden'}" id="${id}-image-async-result-field">
            <label>异步任务</label>
            <div class="chat-response-wrapper" id="${id}-image-async-wrapper">
                <div class="video-generation-status video-generation-status-${rd.imageTaskStatus === 'completed' ? 'success' : (rd.imageTaskId ? 'progress' : 'idle')}" id="${id}-image-async-status" aria-live="polite">${escapeHtml(rd.imageTaskStatusText || '异步模式：运行后显示任务状态')}</div>
                <div class="chat-response-area" id="${id}-image-async-response">${rd.imageTaskUrl
                    ? `<div><strong>图片异步任务</strong></div><div>任务 ID：${escapeHtml(rd.imageTaskId || '')}</div><div style="margin-top:6px;"><a href="${escapeHtml(rd.imageTaskUrl)}" target="_blank" rel="noreferrer">打开图片结果</a></div>`
                    : `<div class="chat-response-placeholder">${escapeHtml(rd.imageTaskStatusText || '创建任务后会自动轮询 /v1/videos/{id}')}</div>`}</div>
            </div>
        </div>
        ${renderNodeFormField({
            label: '生成进度',
            fieldClass: 'node-generation-progress-field',
            content: `<div class="image-generation-progress api-generation-progress" id="${id}-generation-progress" aria-live="polite">0/${generationCount}</div>`
        })}
        <div class="node-field ${isNewApiAsyncImage ? '' : 'hidden'}" id="${id}-resume-image-id-field">
            <label>恢复任务 ID</label>
            <input type="text" id="${id}-resume-image-id" value="${escapeHtml(rd.imageTaskId || '')}" placeholder="输入或粘贴任务 ID" />
        </div>
        <div class="node-field node-field-row ${isNewApiAsyncImage ? '' : 'hidden'}" id="${id}-resume-image-field">
            <button type="button" class="save-btn-secondary" id="${id}-resume-image" ${rd.imageTaskId ? '' : 'disabled'} style="width:100%;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3.16-6.84"/><polyline points="21 3 21 9 15 9"/></svg>
                恢复进度
            </button>
        </div>
        <div class="node-error-msg hidden" id="${id}-error"></div>
    `;
}

function renderVideoGenerateBody(id, restoreData, models, providers) {
    const rd = restoreData || {};
    const opts = renderApiConfigOptions(models, providers, rd.apiConfigId, 'video');
    const selectedModel = getSelectedModelForTask(models, rd.apiConfigId, 'video');
    const selectedProviderId = getResolvedProviderIdForModel(selectedModel, providers, rd.providerId || '');
    const modelProviders = getModelProviders(selectedModel, providers);
    const providerOptions = modelProviders
        .map((provider) => `<option value="${provider.id}" ${selectedProviderId === provider.id ? 'selected' : ''}>${provider.name || provider.id}</option>`)
        .join('');
    const selectedProvider = getResolvedProviderForModel(selectedModel, providers, selectedProviderId);
    const protocol = getEffectiveProtocol(selectedModel, selectedProvider);
    const protocolMeta = getVideoProtocolOptionMeta(protocol);
    const doubaoRatioOptions = DOUBAO_VIDEO_RATIO_OPTIONS;
    const doubaoResolutionOptions = DOUBAO_VIDEO_RESOLUTION_OPTIONS;
    const aspectOptions = protocol === 'doubao-video' ? doubaoRatioOptions : VIDEO_ASPECT_OPTIONS;
    const defaultAspect = protocol === 'doubao-video' ? '16:9' : '16:9';
    const aspect = aspectOptions.some((option) => option.value === rd.aspect) ? rd.aspect : defaultAspect;
    const useVideoSizeParam = rd.useVideoSizeParam === true;
    const showSizeParamToggle = protocol === 'veo-unified' || protocol === 'veo-openai';
    const generationCount = Math.max(1, parseInt(rd.generationCount || '1', 10) || 1);
    const enhancePrompt = rd.enhancePrompt === true;
    const enableUpsample = rd.enableUpsample === true;
    const doubaoResolution = doubaoResolutionOptions.some((option) => option.value === rd.doubaoResolution) ? rd.doubaoResolution : '720p';
    const doubaoDuration = Math.max(1, parseInt(rd.doubaoDuration || '5', 10) || 5);
    const doubaoCameraFixed = rd.doubaoCameraFixed === true;
    const doubaoGenerateAudio = rd.doubaoGenerateAudio === true;
    const doubaoWatermark = rd.doubaoWatermark === true;
    const doubaoSeed = rd.doubaoSeed === '' || rd.doubaoSeed === undefined || rd.doubaoSeed === null ? '' : String(rd.doubaoSeed);
    const isDoubaoProtocol = protocol === 'doubao-video';
    const statusText = typeof rd.videoStatusText === 'string' && rd.videoStatusText.trim()
        ? rd.videoStatusText.trim()
        : '运行后显示视频结果';
    const videoUrl = typeof rd.videoUrl === 'string' ? rd.videoUrl.trim() : '';
    const createHttpStatus = rd.videoCreateHttpStatus !== undefined && rd.videoCreateHttpStatus !== null
        ? String(rd.videoCreateHttpStatus).trim()
        : '';
    const createStatus = typeof rd.videoCreateStatus === 'string' ? rd.videoCreateStatus.trim() : '';
    const statusUpdateTime = typeof rd.videoStatusUpdateTime === 'string' ? rd.videoStatusUpdateTime.trim() : '';
    const enhancedPromptText = typeof rd.videoEnhancedPrompt === 'string' ? rd.videoEnhancedPrompt.trim() : '';
    const createSummaryLines = [
        createHttpStatus ? `<div><strong>HTTP 状态：</strong>${escapeHtml(createHttpStatus)}</div>` : '',
        rd.videoId ? `<div><strong>任务 ID：</strong>${escapeHtml(rd.videoId)}</div>` : '',
        createStatus ? `<div><strong>创建状态：</strong>${escapeHtml(createStatus)}</div>` : '',
        statusUpdateTime ? `<div><strong>状态更新时间：</strong>${escapeHtml(statusUpdateTime)}</div>` : '',
        enhancedPromptText ? `<div><strong>增强提示词：</strong>${escapeHtml(enhancedPromptText)}</div>` : ''
    ].filter(Boolean).join('');
    const statusState = videoUrl
        ? 'success'
        : ((rd.videoStatus === 'processing' || rd.videoStatus === 'queued' || rd.videoStatus === 'submitted')
            ? 'progress'
            : 'idle');
    const doubaoDurationHint = escapeHtml(protocol === 'doubao-video'
        ? (String(selectedModel?.modelId || '').toLowerCase().includes('seedance-1-5-pro')
            ? '当前模型时长限制：4-12 秒'
            : '当前模型时长限制：2-12 秒')
        : '');

    return `
        ${renderNodeFormField({
            label: 'API 配置',
            content: `<select id="${id}-apiconfig">${opts}</select>`
        })}
        ${renderNodeFormField({
            label: '供应商',
            fieldId: `${id}-provider-field`,
            content: `<select id="${id}-provider">${providerOptions || '<option value="">-- 暂无可用供应商 --</option>'}</select>`
        })}
        ${renderNodeFormField({
            label: '生成次数',
            content: `
                <div class="generation-count-control">
                    <button type="button" class="generation-count-btn" data-target="${id}" data-delta="-1" title="减少生成次数">-</button>
                    <input type="number" id="${id}-generation-count" class="generation-count-input" value="${generationCount}" min="1" step="1" />
                    <button type="button" class="generation-count-btn" data-target="${id}" data-delta="1" title="增加生成次数">+</button>
                </div>
            `
        })}
        ${renderNodeFormField({
            label: '视频比例',
            content: `
                <div class="video-ratio-param-row">
                    <select id="${id}-aspect">
                        ${aspectOptions.map((option) => `<option value="${option.value}" ${option.value === aspect ? 'selected' : ''}>${option.label}</option>`).join('')}
                    </select>
                    <label class="video-size-param-toggle ${showSizeParamToggle ? '' : 'hidden'}" id="${id}-use-size-param-toggle" title="打开后请求体使用 size，关闭后使用 aspect_ratio">
                        <span class="video-size-param-toggle-text">使用size代替aspect_ratio</span>
                        <span class="toggle-switch">
                            <input type="checkbox" id="${id}-use-size-param" ${useVideoSizeParam ? 'checked' : ''} />
                            <span class="toggle-slider"></span>
                        </span>
                    </label>
                </div>
            `
        })}
        ${renderNodeFormToggleField({
            label: '增强提示词',
            inputId: `${id}-enhance-prompt`,
            checked: enhancePrompt,
            hidden: !protocolMeta.supportsEnhancePrompt,
            fieldId: `${id}-enhance-prompt-field`
        })}
        ${renderNodeFormToggleField({
            label: '启用超分',
            inputId: `${id}-enable-upsample`,
            checked: enableUpsample,
            hidden: !protocolMeta.supportsUpsample,
            fieldId: `${id}-enable-upsample-field`
        })}
        ${renderNodeFormField({
            label: '分辨率',
            fieldClass: isDoubaoProtocol ? '' : 'hidden',
            fieldId: `${id}-doubao-resolution-field`,
            content: `
                <select id="${id}-doubao-resolution">
                    ${doubaoResolutionOptions.map((option) => `<option value="${option.value}" ${option.value === doubaoResolution ? 'selected' : ''}>${option.label}</option>`).join('')}
                </select>
            `,
            note: `<div class="video-generate-note" id="${id}-doubao-resolution-hint">参考图场景不支持 1080p</div>`
        })}
        ${renderNodeFormField({
            label: '视频时长',
            fieldClass: isDoubaoProtocol ? '' : 'hidden',
            fieldId: `${id}-doubao-duration-field`,
            content: `<input type="number" id="${id}-doubao-duration" min="2" max="12" step="1" value="${doubaoDuration}" />`,
            note: `<div class="video-generate-note" id="${id}-doubao-duration-hint">${doubaoDurationHint}</div>`
        })}
        ${renderNodeFormToggleField({
            label: '固定镜头',
            inputId: `${id}-doubao-camera-fixed`,
            checked: doubaoCameraFixed,
            hidden: !isDoubaoProtocol,
            fieldId: `${id}-doubao-camera-fixed-field`
        })}
        ${renderNodeFormToggleField({
            label: '生成音频',
            inputId: `${id}-doubao-generate-audio`,
            checked: doubaoGenerateAudio,
            hidden: !isDoubaoProtocol,
            fieldId: `${id}-doubao-generate-audio-field`
        })}
        ${renderNodeFormToggleField({
            label: '添加水印',
            inputId: `${id}-doubao-watermark`,
            checked: doubaoWatermark,
            hidden: !isDoubaoProtocol,
            fieldId: `${id}-doubao-watermark-field`
        })}
        ${renderNodeFormField({
            label: '种子',
            fieldClass: isDoubaoProtocol ? '' : 'hidden',
            fieldId: `${id}-doubao-seed-field`,
            content: `<input type="number" id="${id}-doubao-seed" min="0" step="1" placeholder="留空为随机" value="${escapeHtml(doubaoSeed)}" />`
        })}
        ${renderNodeFormNote('豆包格式会按文档把 resolution、ratio、duration、camera_fixed、watermark、seed 等作为顶层字段发送；图片输入会按首帧、尾帧、参考图写入 content 的 role。', {
            fieldClass: isDoubaoProtocol ? '' : 'hidden',
            fieldId: `${id}-doubao-note-field`
        })}
        ${renderNodeFormField({
            label: '提示词',
            fieldClass: 'node-video-prompt-field',
            content: `<textarea class="video-generate-prompt" id="${id}-prompt" placeholder="描述你想生成的视频..." rows="3"${getTextareaHeightStyle(rd, 'prompt')}>${rd.prompt || ''}</textarea>`
        })}
        <div class="node-field node-video-result-field">
            <label>视频结果</label>
            <div class="chat-response-wrapper" id="${id}-wrapper">
                <div class="video-generation-status video-generation-status-${statusState}" id="${id}-video-status" aria-live="polite">${escapeHtml(statusText)}</div>
                <div class="chat-response-area" id="${id}-response">${videoUrl
                    ? `${createSummaryLines ? `<div><strong>视频创建响应</strong></div>${createSummaryLines}<div style="margin-top:8px;"></div>` : ''}<div><a href="${escapeHtml(videoUrl)}" target="_blank" rel="noreferrer">打开视频结果</a></div><div style="margin-top:6px;">${escapeHtml(statusText)}</div>`
                    : (createSummaryLines
                        ? `<div><strong>视频创建响应</strong></div>${createSummaryLines}<div style="margin-top:6px;color:var(--text-dim);">${escapeHtml(statusText)}</div>`
                        : `<div class="chat-response-placeholder">${escapeHtml(statusText)}</div>`)}</div>
            </div>
        </div>
        <div class="node-field">
            <label>生成进度</label>
            <div class="image-generation-progress api-generation-progress" id="${id}-generation-progress" aria-live="polite">0/${generationCount}</div>
        </div>
        <div class="node-field node-field-row">
            <button type="button" class="save-btn-secondary video-node-action-btn" id="${id}-download-video" ${videoUrl ? '' : 'disabled'} style="width:100%;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                下载视频
            </button>
        </div>
        <div class="node-field">
            <label>恢复任务 ID</label>
            <input type="text" id="${id}-resume-video-id" value="${escapeHtml(rd.videoId || '')}" placeholder="输入或粘贴任务 ID" />
        </div>
        <div class="node-field node-field-row">
            <button type="button" class="save-btn-secondary video-node-action-btn" id="${id}-resume-video" ${rd.videoId ? '' : 'disabled'} style="width:100%;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3.16-6.84"/><polyline points="21 3 21 9 15 9"/></svg>
                恢复进度
            </button>
        </div>
        <div class="node-error-msg hidden" id="${id}-error"></div>
    `;
}

function getCameraControlValue(restoreData = {}, key, fallback) {
    const value = Number(restoreData?.[key]);
    return Number.isFinite(value) ? value : fallback;
}

function renderCameraControlBody(id, restoreData) {
    const rd = restoreData || {};
    const hasReferenceImage = typeof rd.image === 'string' && rd.image.trim() !== '';
    const previewImage = typeof rd.cameraPreviewImage === 'string' ? rd.cameraPreviewImage : '';
    const placeholder = hasReferenceImage
        ? '点击“编辑视角”生成当前角度预览'
        : '等待参考图输入';

    return `
        <div class="camera-control-compact">
            <button type="button" class="camera-control-open-btn" id="${id}-camera-open">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 20h9"></path>
                    <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"></path>
                </svg>
                编辑视角
            </button>
            <div class="camera-control-node-preview ${previewImage ? 'has-image' : ''}" id="${id}-camera-preview">
                ${previewImage
        ? `<img src="${previewImage}" alt="视角预览图" draggable="false" loading="lazy" decoding="async" />`
        : `<div class="camera-control-node-preview-placeholder">${escapeHtml(placeholder)}</div>`}
            </div>
            <div class="camera-control-note" role="note">
                说明：本节点会输出结构化的英文视角提示词，用来更明确地约束机位、构图、镜头感和翻滚角；它仍然是提示词控制，不是底层相机参数直传。
            </div>
        </div>
    `;
}

function renderTextChatBody(id, restoreData, models, providers) {
    const rd = restoreData || {};
    const opts = renderApiConfigOptions(models, providers, rd.apiConfigId, 'chat');
    const selectedModel = getSelectedModelForTask(models, rd.apiConfigId, 'chat');
    const selectedProviderId = getResolvedProviderIdForModel(selectedModel, providers, rd.providerId || '');
    const modelProviders = getModelProviders(selectedModel, providers);
    const providerOptions = modelProviders
        .map((provider) => `<option value="${provider.id}" ${selectedProviderId === provider.id ? 'selected' : ''}>${provider.name || provider.id}</option>`)
        .join('');

    return `
        <div class="node-field"><label>API 配置</label><select id="${id}-apiconfig">${opts}</select></div>
        <div class="node-field" id="${id}-provider-field"><label>供应商</label><select id="${id}-provider">${providerOptions || '<option value="">-- 暂无可用供应商 --</option>'}</select></div>
        <div class="node-field node-chat-system-field"><label>系统提示语（可选）</label>
            <textarea id="${id}-sysprompt" placeholder="设定 AI 的角色或背景..." rows="2"${getTextareaHeightStyle(rd, 'sysprompt')}>${rd.sysprompt || ''}</textarea></div>
        <div class="node-field node-field-row"><label>启用搜索</label>
            <label class="toggle-switch"><input type="checkbox" id="${id}-search" ${rd.search ? 'checked' : ''} /><span class="toggle-slider"></span></label></div>
        <div class="node-field node-field-row"><label>固定结果</label>
            <label class="toggle-switch"><input type="checkbox" id="${id}-fixed" ${rd.fixed ? 'checked' : ''} /><span class="toggle-slider"></span></label></div>
        <div class="node-field node-chat-prompt-field"><label>提问内容</label>
            <textarea id="${id}-prompt" placeholder="输入你的问题..." rows="3"${getTextareaHeightStyle(rd, 'prompt')}>${rd.prompt || ''}</textarea></div>
        <div class="node-field node-field-expand"><label>对话回复</label>
            <div class="chat-response-wrapper" id="${id}-wrapper">
                <button class="chat-copy-btn" id="${id}-copy-btn" title="复制回复内容">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <div class="chat-response-area" id="${id}-response"${getResponseAreaHeightStyle(rd, 'response')}>${rd.lastResponse ? rd.lastResponse : '<div class="chat-response-placeholder">运行后显示对话结果</div>'}</div>
            </div>
        </div>
        <div class="node-field node-generation-progress-field">
            <label>生成进度</label>
            <div class="image-generation-progress api-generation-progress" id="${id}-generation-progress" aria-live="polite">0/1</div>
        </div>
    `;
}

function normalizeRestoreImageList(value) {
    if (Array.isArray(value)) {
        return value.flatMap((item) => normalizeRestoreImageList(item));
    }
    if (value && typeof value === 'object') {
        return normalizeRestoreImageList(
            value.imageList ??
            value.images ??
            value.image ??
            value.imageData ??
            []
        );
    }
    return typeof value === 'string' && value.trim() ? [value] : [];
}

function renderRestoredMultiImagePreview(imageList, previewIndex, altPrefix, placeholderClass, placeholderText, totalCount = imageList.length) {
    const safeTotal = Math.max(totalCount, imageList.length);
    const hasImages = imageList.length > 0;
    const index = safeTotal > 0 ? Math.max(0, Math.min(safeTotal - 1, previewIndex)) : 0;
    return `
        <div class="${placeholderClass}">${placeholderText}</div>
        ${safeTotal > 1 ? `
            <button type="button" class="image-save-preview-nav image-save-preview-prev" data-direction="-1" title="上一张" aria-label="上一张">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button type="button" class="image-save-preview-nav image-save-preview-next" data-direction="1" title="下一张" aria-label="下一张">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <div class="image-save-preview-counter">${index + 1}/${safeTotal}</div>
        ` : ''}
    `;
}

function renderImagePreviewBody(id, restoreData) {
    const rd = restoreData || {};
    const imageList = normalizeRestoreImageList(rd.imageList ?? rd.images ?? rd.imageData);
    const totalCount = Math.max(imageList.length, Math.max(0, parseInt(rd.imageCount || '0', 10) || 0));
    const previewIndex = Math.max(0, parseInt(rd.imagePreviewIndex || '0', 10) || 0);
    const hasMultipleImages = totalCount > 1;
    return `
        <div class="preview-container ${hasMultipleImages ? 'has-multiple-images' : ''}" id="${id}-preview">
            ${(imageList.length > 0 || totalCount > 0)
                ? renderRestoredMultiImagePreview(imageList, previewIndex, '预览', 'preview-placeholder', '运行后预览图片', totalCount)
                : `<div class="preview-placeholder">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                    运行后预览图片
                </div>`}
        </div>
        <div class="image-resolution-badge" id="${id}-res" style="display:none"></div>
        <div class="preview-controls" id="${id}-controls" style="display:${(imageList.length > 0 || totalCount > 0) ? 'flex' : 'none'}">
            <button class="preview-ctrl-btn" id="${id}-zoom-in" title="放大"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>
            <button class="preview-ctrl-btn" id="${id}-zoom-out" title="缩小"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>
            <button class="preview-ctrl-btn" id="${id}-zoom-reset" title="重置"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button>
            <button class="preview-ctrl-btn" id="${id}-fullscreen" title="全屏预览"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>
        </div>
    `;
}

function renderImageCompareBody(id) {
    return `
        <div class="image-compare-container" id="${id}-compare" style="--compare-x: 50%;">
            <div class="preview-placeholder">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                运行后对比图片
            </div>
        </div>
        <div class="image-resolution-badge" id="${id}-res" style="display:none"></div>
        <div class="preview-controls image-compare-controls">
            <button class="preview-ctrl-btn image-compare-advanced-btn" id="${id}-advanced-compare" title="高级对比">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/><path d="M12 5v14"/></svg>
                <span>高级对比</span>
            </button>
        </div>
    `;
}

function renderImageResizeBody(id, restoreData) {
    const rd = restoreData || {};
    const mode = rd.resizeMode || 'scale';
    const scalePercent = Math.max(1, Math.min(100, Number(rd.scalePercent) || 100));
    const targetWidth = rd.targetWidth || '';
    const targetHeight = rd.targetHeight || '';
    const keepAspect = rd.keepAspect !== false;
    const quality = rd.quality || 92;
    const previewImage = rd.imageData || '';
    const hasPreview = !!previewImage;
    return `
        <div class="image-resize-panel">
            <div class="image-resize-mode-shell">
                <div class="image-resize-mode-group">
                    <button type="button" class="image-resize-mode-btn ${mode === 'scale' ? 'active' : ''}" data-target="${id}" data-mode="scale">等比缩放</button>
                    <button type="button" class="image-resize-mode-btn ${mode === 'dimensions' ? 'active' : ''}" data-target="${id}" data-mode="dimensions">按尺寸</button>
                </div>
            </div>
            <input type="hidden" id="${id}-resize-mode" value="${mode}" />

            <div class="image-resize-scale-section ${mode === 'scale' ? '' : 'hidden'}" id="${id}-scale-section">
                <div class="node-field image-resize-slider-field">
                    <div class="image-resize-slider-header">
                        <label>缩放比例</label>
                        <span class="image-resize-inline-value" id="${id}-scale-value">${scalePercent}%</span>
                    </div>
                    <div class="image-resize-range-row">
                        <input type="range" id="${id}-scale-percent" min="1" max="100" step="1" value="${scalePercent}" />
                    </div>
                </div>
            </div>

            <div class="image-resize-dimensions-section ${mode === 'dimensions' ? '' : 'hidden'}" id="${id}-dimensions-section">
                <div class="image-resize-dimensions-grid">
                    <div class="node-field">
                        <label>宽度</label>
                        <input type="number" id="${id}-target-width" min="1" step="1" placeholder="自动" value="${targetWidth}" />
                    </div>
                    <div class="node-field">
                        <label>高度</label>
                        <input type="number" id="${id}-target-height" min="1" step="1" placeholder="自动" value="${targetHeight}" />
                    </div>
                </div>
                <div class="node-field node-field-row">
                    <label>保持比例</label>
                    <label class="toggle-switch"><input type="checkbox" id="${id}-keep-aspect" ${keepAspect ? 'checked' : ''} /><span class="toggle-slider"></span></label>
                </div>
            </div>

            <div class="node-field image-resize-quality-field image-resize-slider-field" id="${id}-quality-field">
                <div class="image-resize-slider-header">
                    <label>质量</label>
                    <span class="image-resize-inline-value" id="${id}-quality-value">${quality}%</span>
                </div>
                <div class="image-resize-range-row">
                    <input type="range" id="${id}-quality" min="1" max="100" step="1" value="${quality}" />
                </div>
            </div>

            <div class="image-resize-preview-frame">
                <div class="preview-container image-resize-preview" id="${id}-resize-preview">
                    ${hasPreview
                        ? `<div class="preview-placeholder">正在恢复缩放预览...</div>`
                        : `<div class="preview-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>等待上游图片</div>`}
                </div>
            </div>

            <div class="image-resize-meta image-resize-meta-primary" id="${id}-resize-size-label">${rd.originalWidth && rd.originalHeight && rd.outputWidth && rd.outputHeight ? `${rd.originalWidth} × ${rd.originalHeight} → ${rd.outputWidth} × ${rd.outputHeight}` : '等待上游图片'}</div>
            <div class="image-resize-meta image-resize-meta-secondary" id="${id}-resize-bytes-label">${rd.estimatedBytes ? `预计大小 ${(rd.estimatedBytes / 1024).toFixed(1)} KB` : ''}</div>
        </div>
    `;
}

function renderTextBody(id, restoreData) {
    const rd = restoreData || {};
    const texts = Array.isArray(rd.texts) && rd.texts.length > 0 ? rd.texts : [];
    const previewIndex = Math.max(0, Math.min(texts.length - 1, parseInt(rd.textPreviewIndex || '0', 10) || 0));
    const textValue = texts.length > 0 ? texts[previewIndex] : (rd.text || rd.lastText || '');
    return `
        <div class="node-field node-field-expand">
            <div class="text-multi-nav ${texts.length > 1 ? '' : 'hidden'}" id="${id}-text-nav">
                <button type="button" class="text-multi-nav-btn" data-direction="-1" title="上一条">‹</button>
                <span class="text-multi-counter" id="${id}-text-counter">${texts.length > 1 ? `${previewIndex + 1}/${texts.length}` : ''}</span>
                <button type="button" class="text-multi-nav-btn" data-direction="1" title="下一条">›</button>
            </div>
            <textarea id="${id}-text" placeholder="输入文本，或运行后预览上游文本..." rows="6"${getTextareaHeightStyle(rd, 'text')}>${escapeHtml(textValue)}</textarea>
        </div>
    `;
}

function renderImageMergeBody(id) {
    return `
        <div class="image-merge-panel">
            <div class="image-merge-summary" id="${id}-merge-summary">连接多个图片输入后，输出合并后的多图数据</div>
        </div>
    `;
}

function renderTextMergeBody(id) {
    return `
        <div class="text-merge-panel">
            <div class="text-merge-summary" id="${id}-merge-summary">连接多个文本输入后，输出合并后的多文本数据</div>
        </div>
    `;
}

function renderTextSplitBody(id, restoreData) {
    const rd = restoreData || {};
    const delimiter = getTextSplitDelimiterValue(rd);
    const outputCount = getTextSplitOutputCountSettingValue(rd);
    const removeEmptyLines = getTextSplitRemoveEmptyLinesValue(rd);
    const previewEnabled = getTextSplitPreviewEnabledValue(rd);
    const mergeOutputEnabled = getTextSplitMergeOutputEnabledValue(rd);
    return `
        <div class="node-field node-field-expand text-split-delimiter-field">
            <label>分隔字符串</label>
            <textarea id="${id}-delimiter" class="text-split-delimiter" placeholder="输入用于分割文本的字符串" rows="2"${getTextareaHeightStyle(rd, 'delimiter')}>${delimiter}</textarea>
        </div>
        <div class="node-field">
            <label>输出数量</label>
            <div class="text-split-output-count-control">
                <button type="button" class="text-split-output-count-btn" data-target="${id}" data-delta="-1" title="减少输出数量" ${mergeOutputEnabled ? 'disabled' : ''}>-</button>
                <input type="text" id="${id}-output-count" class="text-split-output-count-input" inputmode="numeric" pattern="[0-9]*" value="${outputCount}" ${mergeOutputEnabled ? 'disabled' : ''} />
                <button type="button" class="text-split-output-count-btn" data-target="${id}" data-delta="1" title="增加输出数量" ${mergeOutputEnabled ? 'disabled' : ''}>+</button>
            </div>
            <div class="text-split-output-hint">设为 0 时根据分割结果自动生成输出端口</div>
        </div>
        <div class="node-field node-field-row">
            <label>删除空行</label>
            <label class="toggle-switch">
                <input type="checkbox" id="${id}-remove-empty-lines" ${removeEmptyLines ? 'checked' : ''} />
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="node-field node-field-row">
            <label>多合一输出</label>
            <label class="toggle-switch">
                <input type="checkbox" id="${id}-merge-output-enabled" ${mergeOutputEnabled ? 'checked' : ''} />
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="node-field node-field-row">
            <label>开启节点内预览</label>
            <label class="toggle-switch">
                <input type="checkbox" id="${id}-preview-enabled" ${previewEnabled ? 'checked' : ''} />
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="text-split-summary" id="${id}-split-summary"></div>
        <div class="node-field node-field-expand text-split-preview-field ${previewEnabled ? '' : 'hidden'}">
            <label>片段预览</label>
            <div class="text-split-preview" id="${id}-split-preview"></div>
        </div>
    `;
}

function renderImageSaveBody(id, restoreData, hasGlobalSaveDirHandle) {
    const rd = restoreData || {};
    const showWarning = !hasGlobalSaveDirHandle;
    const imageList = normalizeRestoreImageList(rd.imageList ?? rd.images ?? rd.imageData);
    const totalCount = Math.max(imageList.length, Math.max(0, parseInt(rd.imageCount || '0', 10) || 0));
    const previewIndex = Math.max(0, parseInt(rd.imagePreviewIndex || '0', 10) || 0);
    const hasMultipleImages = totalCount > 1;
    const videoData = rd.video && typeof rd.video === 'object' ? rd.video : null;
    const hasVideo = imageList.length === 0 && !!videoData?.url;
    const defaultFilename = hasVideo ? 'generated_video' : 'generated_image';
    const previewActionLabel = hasVideo ? '查看视频' : '查看图片';

    return `
        <div class="save-no-path-warning" id="${id}-path-warning" style="color:#ef4444; font-size:11px; margin-bottom:10px; display:${showWarning ? 'block' : 'none'}; font-weight:500;">
            ⚠️ 未设置全局保存目录，保存节点无法自动落盘
        </div>
        <div class="save-preview-container ${hasMultipleImages ? 'has-multiple-images' : ''}" id="${id}-save-preview" data-save-mode="${hasVideo ? 'video' : 'image'}">
            ${(imageList.length > 0 || totalCount > 0)
                ? renderRestoredMultiImagePreview(imageList, previewIndex, '待保存', 'save-preview-placeholder', '运行后显示图片', totalCount)
                : (hasVideo
                    ? `<video src="${escapeHtml(videoData.url || '')}" controls preload="metadata" playsinline style="width:100%;height:100%;object-fit:contain;border-radius:12px;background:rgba(0,0,0,0.08);"></video>`
                    : '<div class="save-preview-placeholder">运行后显示图片或视频</div>')}
        </div>
        <div class="image-resolution-badge" id="${id}-res" style="display:none"></div>
        <div class="node-field"><label>文件名前缀/文件名</label>
            <input type="text" id="${id}-filename" value="${rd.filename || defaultFilename}" placeholder="不填则默认生成" /></div>
        <div class="save-btn-group">
            <button class="save-btn-secondary" id="${id}-view-full" ${(imageList.length > 0 || totalCount > 0 || hasVideo) ? '' : 'disabled'}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                ${previewActionLabel}
            </button>
            <button class="save-btn" id="${id}-manual-save" ${(imageList.length > 0 || totalCount > 0 || hasVideo) ? '' : 'disabled'}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                保存
            </button>
        </div>
    `;
}

function normalizeCustomParamRows(restoreData = {}) {
    const rd = restoreData || {};
    const rows = Array.isArray(rd.params)
        ? rd.params
        : (Array.isArray(rd.customParams) ? rd.customParams : []);
    return rows
        .map((row) => ({
            key: typeof row?.key === 'string' ? row.key : '',
            value: row?.value === undefined || row?.value === null ? '' : String(row.value)
        }))
        .filter((row) => row.key || row.value);
}

function renderCustomParamRow(id, row, index) {
    return `
        <div class="custom-param-row" data-param-row>
            <input type="text" class="custom-param-key" id="${id}-param-key-${index}" value="${escapeHtml(row.key)}" placeholder="参数名" />
            <span class="custom-param-separator">:</span>
            <input type="text" class="custom-param-value" id="${id}-param-value-${index}" value="${escapeHtml(row.value)}" placeholder="参数值" />
            <button type="button" class="custom-param-remove" title="删除这一行" aria-label="删除这一行">−</button>
        </div>
    `;
}

function renderCustomParamsBody(id, restoreData = {}) {
    const rows = normalizeCustomParamRows(restoreData);
    const renderedRows = (rows.length > 0 ? rows : [{ key: '', value: '' }])
        .map((row, index) => renderCustomParamRow(id, row, index))
        .join('');

    return `
        <div class="node-field custom-param-field">
            <label>请求参数</label>
            <div class="custom-param-list" id="${id}-params-list">
                ${renderedRows}
            </div>
            <button type="button" class="custom-param-add" id="${id}-add-param" title="添加参数" aria-label="添加参数">+</button>
        </div>
    `;
}

function renderNodeBody(type, id, restoreData, state) {
    if (type === 'ImageImport') return renderImageImportBody(id, restoreData);
    if (type === 'ImageResize') return renderImageResizeBody(id, restoreData);
    if (type === 'ImageGenerate') return renderImageGenerateBody(id, restoreData, state.models, state.providers);
    if (type === 'VideoGenerate') return renderVideoGenerateBody(id, restoreData, state.models, state.providers);
    if (type === 'CameraControl') return renderCameraControlBody(id, restoreData);
    if (type === 'TextChat') return renderTextChatBody(id, restoreData, state.models, state.providers);
    if (type === 'ImagePreview') return renderImagePreviewBody(id, restoreData);
    if (type === 'ImageMerge') return renderImageMergeBody(id);
    if (type === 'ImageCompare') return renderImageCompareBody(id);
    if (type === 'Text') return renderTextBody(id, restoreData);
    if (type === 'TextMerge') return renderTextMergeBody(id);
    if (type === 'TextSplit') return renderTextSplitBody(id, restoreData);
    if (type === 'CustomParams') return renderCustomParamsBody(id, restoreData);
    if (type === 'ImageSave') return renderImageSaveBody(id, restoreData, state.globalSaveDirHandle);
    return '';
}

export function createNodeMarkup({ type, id, config, restoreData, state }) {
    let effectiveConfig = config;
    if (type === 'TextSplit') {
        effectiveConfig = { ...config, outputs: getTextSplitOutputPorts(restoreData) };
    } else if (type === 'TextMerge') {
        effectiveConfig = { ...config, inputs: getTextMergeInputPorts(restoreData) };
    } else if (type === 'ImageMerge') {
        effectiveConfig = { ...config, inputs: getImageMergeInputPorts(restoreData) };
    } else if (type === 'ImageGenerate' || type === 'VideoGenerate' || type === 'TextChat') {
        effectiveConfig = applyReferenceImagePorts(config, restoreData);
    } else if (type === 'CustomParams') {
        effectiveConfig = { ...config, inputs: getCustomParamsInputPorts(restoreData) };
    }
    const isCollapsed = restoreData?.collapsed === true;
    const isClone = restoreData?.isClone === true && typeof restoreData?.cloneSourceId === 'string' && restoreData.cloneSourceId;
    const customTitle = typeof restoreData?.customTitle === 'string' && restoreData.customTitle.trim()
        ? restoreData.customTitle.trim()
        : '';
    const bodyClasses = ['node-body'];
    if (isCollapsed) bodyClasses.push('is-collapsed');
    if (type === 'ImageGenerate' || type === 'TextChat') {
        bodyClasses.push('node-body-has-generation-progress');
    }
    const bodyClassName = bodyClasses.join(' ');
    return [
        renderNodeHeader(id, effectiveConfig, { collapsed: isCollapsed, customTitle, isClone }),
        renderPortSections(id, effectiveConfig),
        `<div class="${bodyClassName}">`,
        renderNodeBody(type, id, restoreData, state),
        '</div>',
        renderNodeRunCancelButton(id)
    ].join('');
}
