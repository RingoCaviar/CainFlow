import { VISUAL_STYLE_FIELDS, VISUAL_STYLE_PRESETS, normalizeVisualStyle } from '../features/visual-style/visual-style.js';
import { getModelsForTask } from '../features/execution/provider-request-utils.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const modelOptions = (state, selected) => '<option value="">选择模型</option>' + getModelsForTask(state.models || [], 'chat')
    .filter(model => model.capabilities?.imageInput !== false)
    .map(model => `<option value="${escape(model.id)}" ${selected === model.id ? 'selected' : ''}>${escape(model.name || model.modelId)}</option>`).join('');

export function renderVisualStyleBody(id, restored = {}, state = {}) {
    const style = normalizeVisualStyle(restored.visualStyle);
    const field = key => `<div class="node-field"><label for="${id}-style-${key}">${VISUAL_STYLE_FIELDS[key]}</label><textarea id="${id}-style-${key}" data-style-field="${key}" rows="2" maxlength="2000">${escape(style[key])}</textarea></div>`;
    return `<div class="visual-style-settings">
        <div class="node-field"><label for="${id}-style-preset">风格预设</label><select class="ui-select" id="${id}-style-preset" data-style-field="preset">${Object.entries(VISUAL_STYLE_PRESETS).map(([key, value]) => `<option value="${key}" ${style.preset === key ? 'selected' : ''}>${value.label}</option>`).join('')}</select></div>
        ${field('description')}
        <details><summary>视觉细节</summary>${Object.keys(VISUAL_STYLE_FIELDS).filter(key => !['description', 'typography'].includes(key)).map(field).join('')}</details>
        <details><summary>图文排版（可选）</summary>${field('typography')}<p>仅用于任务要求的文字，不新增文案。</p></details>
        <details><summary>从参考图提取风格</summary>
            <p>连接风格参考图后，选择需要提取的维度。提取会替换所选字段，其他编辑保留。</p>
            <div class="visual-style-scope">${Object.entries(VISUAL_STYLE_FIELDS).filter(([key]) => !['description', 'avoid'].includes(key)).map(([key, label]) => `<label><input type="checkbox" data-style-scope="${key}" checked> ${label}</label>`).join('')}</div>
            <div class="node-field"><label for="${id}-style-model">分析模型</label><select class="ui-select" id="${id}-style-model" data-style-model>${modelOptions(state, restored.styleModelId)}</select></div>
            <div class="node-field"><label for="${id}-style-provider">供应商</label><select class="ui-select" id="${id}-style-provider" data-style-provider></select></div>
            <button type="button" class="save-btn-secondary" data-style-extract>提取所选风格</button>
        </details>
        <p data-style-status role="status">连接到图片生成或电商套图，共用这份风格。</p>
    </div>`;
}

export function bindVisualStyleNode(node, { state, runToNode, scheduleSave, pushHistory, fitNodeToContent }) {
    const root = node.el;
    const save = () => { scheduleSave(); pushHistory(); };
    const refresh = () => {
        for (const control of root.querySelectorAll('[data-style-field]')) control.value = node.data.visualStyle[control.dataset.styleField] || '';
    };
    for (const control of root.querySelectorAll('[data-style-field]')) {
        control.addEventListener('change', () => {
            if (node.isClone || state.isRunning || state.runningNodeIds?.has(node.id)) { refresh(); return; }
            const key = control.dataset.styleField;
            node.data.visualStyle = key === 'preset' ? normalizeVisualStyle({ preset: control.value })
                : normalizeVisualStyle({ ...node.data.visualStyle, [key]: control.value });
            refresh();
            root.querySelector('[data-style-status]').textContent = '风格已更新；已有图片保留，下一次生成采用新风格。';
            save();
        });
    }
    const modelControl = root.querySelector('[data-style-model]');
    const providerControl = root.querySelector('[data-style-provider]');
    const providers = () => {
        const model = state.models.find(item => item.id === modelControl.value);
        const options = (model?.providerIds || []).map(id => state.providers.find(item => item.id === id)).filter(Boolean);
        providerControl.innerHTML = '<option value="">选择供应商</option>' + options.map(item => `<option value="${escape(item.id)}">${escape(item.name || item.id)}</option>`).join('');
        providerControl.value = options.some(item => item.id === node.data.styleProviderId) ? node.data.styleProviderId : options[0]?.id || '';
        node.data.styleProviderId = providerControl.value;
    };
    providers();
    const refreshModels = () => { modelControl.innerHTML = modelOptions(state, node.data.styleModelId); providers(); };
    modelControl.addEventListener('focus', refreshModels);
    providerControl.addEventListener('focus', providers);
    modelControl.addEventListener('change', () => { node.data.styleModelId = modelControl.value; providers(); save(); });
    providerControl.addEventListener('change', () => { node.data.styleProviderId = providerControl.value; save(); });
    let extracting = false;
    root.querySelector('[data-style-extract]').addEventListener('click', async () => {
        if (extracting || node.isClone || state.isRunning || state.runningNodeIds?.size) return;
        const visualStyleFields = [...root.querySelectorAll('[data-style-scope]:checked')].map(control => control.dataset.styleScope);
        extracting = true;
        try { await runToNode(node.id, { visualStyleFields }); refresh(); }
        finally { extracting = false; }
    });
    for (const details of root.querySelectorAll('details')) details.addEventListener('toggle', () => {
        if (details.open) refreshModels();
        fitNodeToContent(node.id, { preserveCurrentWidth: true });
    });
}
