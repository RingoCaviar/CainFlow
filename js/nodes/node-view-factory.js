/**
 * 根据节点类型与恢复数据生成节点的 HTML 结构。
 */
import {
    getEffectiveProtocol,
    getImageResolutionOptionsForModel,
    getModelOptionLabel,
    getModelsForTask,
    normalizeImageResolutionForModel
} from '../features/execution/provider-request-utils.js';

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

function renderNodeHeader(id, config) {
    return `
        <div class="node-glass-bg"></div>
        <div class="node-header">
            <div class="header-left">
                ${config.icon}
                <span class="node-title">${config.title}</span>
            </div>
            <div class="header-right">
                <span class="node-time-badge" id="${id}-time-container" style="display:none">
                    <div class="heartbeat-dot" id="${id}-heartbeat" title="连接正常"></div>
                    <span id="${id}-time"></span>
                </span>
                <button class="node-bypass-btn" data-node-id="${id}" title="启用/禁用节点">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
                </button>
                <button class="node-delete" data-node-id="${id}" title="删除节点">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        </div>
        <div class="node-resize-handle" data-node-id="${id}"></div>
        <div class="node-body">
    `;
}

function renderApiConfigOptions(models, providers, selectedId, taskType) {
    const filteredModels = getModelsForTask(models, taskType);
    if (filteredModels.length === 0) {
        return '<option value="">-- 暂无可用模型 --</option>';
    }

    return filteredModels.map((model) => {
        const selected = selectedId === model.id ? 'selected' : '';
        return `<option value="${model.id}" ${selected}>${getModelOptionLabel(model, providers)}</option>`;
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
                    ? `<img src="${rd.imageData}" alt="已导入图片" draggable="false" style="pointer-events: none;" />`
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
                <input type="url" id="${id}-url-input" value="${imageUrl}" placeholder="https://example.com/image.png" />
            </div>
            <div class="file-drop-zone image-import-url-preview${hasUrlImage ? ' has-image' : ''}" id="${id}-url-preview">
                ${hasUrlImage
                    ? `<img src="${imageUrl}" alt="URL 图片预览" draggable="false" style="pointer-events: none;" />`
                    : `<div class="drop-text">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                        输入 URL 后自动显示预览
                    </div>`}
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
    const resolutionOptions = renderImageResolutionOptions(selectedModel, providers, rd.resolution);
    const selectedProvider = providers?.find?.((provider) => provider.id === selectedModel?.providerId) || null;
    const isOpenAiModel = !!selectedModel && getEffectiveProtocol(selectedModel, selectedProvider) === 'openai';
    const showResolutionParamNote = isOpenAiModel;
    const showCustomResolution = rd.resolution === 'custom';
    const customResolutionMatch = String(rd.customResolution || '').match(/^(\d{2,5})x(\d{2,5})$/i);
    const customWidth = rd.customWidth || customResolutionMatch?.[1] || '';
    const customHeight = rd.customHeight || customResolutionMatch?.[2] || '';
    const generationCount = Math.max(1, parseInt(rd.generationCount || '1', 10) || 1);

    return `
        <div class="node-field"><label>API 配置</label><select id="${id}-apiconfig">${opts}</select></div>
        <div class="node-field">
            <label>生成次数</label>
            <div class="generation-count-control">
                <button type="button" class="generation-count-btn" data-target="${id}" data-delta="-1" title="减少生成次数">-</button>
                <input type="number" id="${id}-generation-count" class="generation-count-input" value="${generationCount}" min="1" step="1" />
                <button type="button" class="generation-count-btn" data-target="${id}" data-delta="1" title="增加生成次数">+</button>
            </div>
        </div>
        <div class="node-field ${isOpenAiModel ? 'hidden' : ''}" id="${id}-aspect-field"><label>宽高比</label>
            <select id="${id}-aspect">
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
            </select>
        </div>
        <div class="node-field"><label>分辨率</label>
            <select id="${id}-resolution">
                ${resolutionOptions}
            </select>
            <div class="image-resolution-param-note ${showResolutionParamNote ? '' : 'hidden'}" id="${id}-resolution-param-note">很多中转 API 并不支持 Size 参数，所以你设置分辨率是无效的</div>
        </div>
        <div class="node-field ${showCustomResolution ? '' : 'hidden'}" id="${id}-custom-resolution-field">
            <label>自定义分辨率</label>
            <div style="display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:6px;">
                <input type="number" id="${id}-custom-resolution-width" value="${customWidth}" placeholder="宽度" min="1" max="99999" />
                <span style="color:var(--text-dim);font-size:12px;">x</span>
                <input type="number" id="${id}-custom-resolution-height" value="${customHeight}" placeholder="高度" min="1" max="99999" />
            </div>
            <div class="custom-resolution-hint" id="${id}-custom-resolution-hint" aria-live="polite"></div>
        </div>
        <div class="node-field node-field-row"><label>启用搜索</label>
            <label class="toggle-switch"><input type="checkbox" id="${id}-search" ${rd.search ? 'checked' : ''} /><span class="toggle-slider"></span></label></div>
        <div class="node-field" style="margin-top:-4px;">
            <div style="font-size:11px;color:var(--text-dim);line-height:1.45;">提示：这些额外参数是否生效，取决于所选模型的兼容格式。Google / Gemini 生图通常支持宽高比和搜索，OpenAI 兼容图片接口大多只使用提示词和 size。</div>
        </div>
        <div class="node-field node-field-expand"><label>提示词</label>
            <textarea id="${id}-prompt" placeholder="描述你想生成的图片..." rows="3">${rd.prompt || ''}</textarea></div>
        <div class="node-error-msg" id="${id}-error"></div>
    `;
}

function renderTextChatBody(id, restoreData, models, providers) {
    const rd = restoreData || {};
    const opts = renderApiConfigOptions(models, providers, rd.apiConfigId, 'chat');

    return `
        <div class="node-field"><label>API 配置</label><select id="${id}-apiconfig">${opts}</select></div>
        <div class="node-field"><label>系统提示语（可选）</label>
            <textarea id="${id}-sysprompt" placeholder="设定 AI 的角色或背景..." rows="2">${rd.sysprompt || ''}</textarea></div>
        <div class="node-field node-field-row"><label>启用搜索</label>
            <label class="toggle-switch"><input type="checkbox" id="${id}-search" ${rd.search ? 'checked' : ''} /><span class="toggle-slider"></span></label></div>
        <div class="node-field node-field-row"><label>固定结果</label>
            <label class="toggle-switch"><input type="checkbox" id="${id}-fixed" ${rd.fixed ? 'checked' : ''} /><span class="toggle-slider"></span></label></div>
        <div class="node-field"><label>提问内容</label>
            <textarea id="${id}-prompt" placeholder="输入你的问题..." rows="3">${rd.prompt || ''}</textarea></div>
        <div class="node-field node-field-expand"><label>对话回复</label>
            <div class="chat-response-wrapper" id="${id}-wrapper">
                <button class="chat-copy-btn" id="${id}-copy-btn" title="复制回复内容">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <div class="chat-response-area" id="${id}-response">${rd.lastResponse ? rd.lastResponse : '<div class="chat-response-placeholder">运行后显示对话结果</div>'}</div>
            </div>
        </div>
    `;
}

function renderImagePreviewBody(id) {
    return `
        <div class="preview-container" id="${id}-preview">
            <div class="preview-placeholder">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                运行后预览图片
            </div>
        </div>
        <div class="image-resolution-badge" id="${id}-res" style="display:none"></div>
        <div class="preview-controls" id="${id}-controls" style="display:none">
            <button class="preview-ctrl-btn" id="${id}-zoom-in" title="放大"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>
            <button class="preview-ctrl-btn" id="${id}-zoom-out" title="缩小"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>
            <button class="preview-ctrl-btn" id="${id}-zoom-reset" title="重置"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button>
            <button class="preview-ctrl-btn" id="${id}-fullscreen" title="全屏预览"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>
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
                        ? `<img src="${previewImage}" alt="缩放结果预览" draggable="false" />`
                        : `<div class="preview-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>等待上游图片</div>`}
                </div>
            </div>

            <div class="image-resize-meta image-resize-meta-primary" id="${id}-resize-size-label">${rd.originalWidth && rd.originalHeight && rd.outputWidth && rd.outputHeight ? `${rd.originalWidth} × ${rd.originalHeight} → ${rd.outputWidth} × ${rd.outputHeight}` : '等待上游图片'}</div>
            <div class="image-resize-meta image-resize-meta-secondary" id="${id}-resize-bytes-label">${rd.estimatedBytes ? `预计大小 ${(rd.estimatedBytes / 1024).toFixed(1)} KB` : ''}</div>
        </div>
    `;
}

function renderTextInputBody(id, restoreData) {
    const rd = restoreData || {};
    return `
        <div class="node-field node-field-expand">
            <textarea id="${id}-text" placeholder="输入你想传递的文本..." rows="6">${rd.text || ''}</textarea>
        </div>
    `;
}

function renderTextDisplayBody(id) {
    return `
        <div class="node-field node-field-expand">
            <div class="text-display-box" id="${id}-display">等待输入文本...</div>
        </div>
    `;
}

function renderImageSaveBody(id, restoreData, hasGlobalSaveDirHandle) {
    const rd = restoreData || {};
    const showWarning = !hasGlobalSaveDirHandle;

    return `
        <div class="save-no-path-warning" id="${id}-path-warning" style="color:#ef4444; font-size:11px; margin-bottom:10px; display:${showWarning ? 'block' : 'none'}; font-weight:500;">
            ⚠️ 未设置全局保存目录，图片无法自动落盘
        </div>
        <div class="save-preview-container" id="${id}-save-preview">
            <div class="save-preview-placeholder">运行后显示图片</div>
        </div>
        <div class="image-resolution-badge" id="${id}-res" style="display:none"></div>
        <div class="node-field"><label>文件名前缀/文件名</label>
            <input type="text" id="${id}-filename" value="${rd.filename || 'generated_image'}" placeholder="不填则默认生成" /></div>
        <div class="save-btn-group">
            <button class="save-btn-secondary" id="${id}-view-full" disabled>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                查看图片
            </button>
            <button class="save-btn" id="${id}-manual-save" disabled>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                保存
            </button>
        </div>
    `;
}

function renderNodeBody(type, id, restoreData, state) {
    if (type === 'ImageImport') return renderImageImportBody(id, restoreData);
    if (type === 'ImageResize') return renderImageResizeBody(id, restoreData);
    if (type === 'ImageGenerate') return renderImageGenerateBody(id, restoreData, state.models, state.providers);
    if (type === 'TextChat') return renderTextChatBody(id, restoreData, state.models, state.providers);
    if (type === 'ImagePreview') return renderImagePreviewBody(id);
    if (type === 'TextInput') return renderTextInputBody(id, restoreData);
    if (type === 'TextDisplay') return renderTextDisplayBody(id);
    if (type === 'ImageSave') return renderImageSaveBody(id, restoreData, state.globalSaveDirHandle);
    return '';
}

export function createNodeMarkup({ type, id, config, restoreData, state }) {
    return [
        renderNodeHeader(id, config),
        renderPorts(id, config.inputs, 'input'),
        renderNodeBody(type, id, restoreData, state),
        renderPorts(id, config.outputs, 'output'),
        '</div>'
    ].join('');
}
