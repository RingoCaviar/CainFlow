import { normalizeVisualStyle, visualStyleText, VISUAL_STYLE_DETAIL_LEVELS, VISUAL_STYLE_PRESETS, normalizeVisualStyleDetailLevel } from '../features/visual-style/visual-style.js';
import { getModelsForTask } from '../features/execution/provider-request-utils.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const modelOptions = (state, selected) => '<option value="">选择模型</option>' + getModelsForTask(state.models || [], 'chat')
    .filter(model => model.capabilities?.imageInput !== false)
    .map(model => `<option value="${escape(model.id)}" ${selected === model.id ? 'selected' : ''}>${escape(model.name || model.modelId)}</option>`).join('');

export function hasVisualStyleReference(state, nodeId) {
    return (state.connections || []).some(edge => edge.to.nodeId === nodeId && edge.to.port === 'image'
        && state.nodes.has(edge.from.nodeId) && state.nodes.get(edge.from.nodeId).enabled !== false);
}

export function renderVisualStyleBody(id, restored = {}, state = {}) {
    restored = restored || {};
    const text = visualStyleText(restored.visualStyle);
    return `<div class="visual-style-preview" data-style-preview>${escape(text || '画面风格')}</div>
        <div class="visual-style-settings">
            <div class="node-field visual-style-preset"><label for="${id}-style-preset">风格预设</label><select class="ui-select" id="${id}-style-preset" data-style-preset aria-label="选择风格预设，替换当前文本"><option value="">选择预设，替换当前文本</option>${Object.entries(VISUAL_STYLE_PRESETS).filter(([key]) => key !== 'custom').map(([key, preset]) => `<option value="${key}">${escape(preset.label)}</option>`).join('')}</select></div>
            <textarea id="${id}-style-description" data-style-field="description" aria-label="风格描述" rows="4" maxlength="20000" placeholder="输入画面风格，或连接参考图后提取…">${escape(text)}</textarea>
            <div class="node-field visual-style-detail"><label for="${id}-style-detail">提取精细度</label><select class="ui-select" id="${id}-style-detail" data-style-detail title="仅影响下一次提取，不修改当前风格文本">${Object.entries(VISUAL_STYLE_DETAIL_LEVELS).map(([value, { label }]) => `<option value="${value}" ${value === normalizeVisualStyleDetailLevel(restored.styleDetailLevel) ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
            <details class="visual-style-model-settings"><summary>提取模型</summary>
                <div class="visual-style-model-fields">
                    <div class="node-field"><label for="${id}-style-model">模型</label><select class="ui-select" id="${id}-style-model" data-style-model>${modelOptions(state, restored.styleModelId)}</select></div>
                    <div class="node-field"><label for="${id}-style-provider">供应商</label><select class="ui-select" id="${id}-style-provider" data-style-provider></select></div>
                </div>
            </details>
            <p data-style-status role="status"></p>
        </div>`;
}

export function bindVisualStyleNode(node, { state, runToNode, scheduleSave, pushHistory }) {
    const root = node.el;
    // Keep the original controls: the shared parameter panel moves this subtree.
    const settings = root.querySelector('.visual-style-settings');
    const text = settings.querySelector('[data-style-field]');
    const detailControl = settings.querySelector('[data-style-detail]');
    const preview = root.querySelector('[data-style-preview]');
    const status = settings.querySelector('[data-style-status]');
    const save = () => { scheduleSave(); pushHistory(); };
    const locked = () => node.isClone || state.isRunning || state.runningNodeIds?.size;
    const refresh = () => {
        const hasReference = hasVisualStyleReference(state, node.id);
        settings.querySelector('.visual-style-detail').hidden = !hasReference;
        settings.querySelector('details').hidden = !hasReference;
        status.hidden = !hasReference;
        const value = visualStyleText(node.data.visualStyle);
        if (text.value !== value && text.ownerDocument.activeElement !== text) text.value = value;
        const label = value || '画面风格';
        if (preview.textContent !== label) preview.textContent = label;
        preview.classList.toggle('is-empty', !value);
        detailControl.value = normalizeVisualStyleDetailLevel(node.data.styleDetailLevel);
    };
    node.refreshVisualStyle = refresh;
    const presetControl = settings.querySelector('[data-style-preset]');
    const applyPreset = () => {
        const preset = presetControl.value;
        presetControl.value = '';
        if (locked() || !preset || preset === 'custom' || !Object.hasOwn(VISUAL_STYLE_PRESETS, preset)) return;
        const description = visualStyleText({ preset });
        node.data.visualStyle = normalizeVisualStyle({ description });
        text.value = description;
        status.textContent = '';
        refresh();
        save();
    };
    presetControl.addEventListener('input', applyPreset);
    presetControl.addEventListener('change', applyPreset);
    const saveDetail = () => {
        if (locked()) { refresh(); return; }
        const level = normalizeVisualStyleDetailLevel(detailControl.value);
        if (level === node.data.styleDetailLevel) return;
        node.data.styleDetailLevel = level;
        save();
    };
    // Native selects emit input before change; commit before the shared form refresh.
    detailControl.addEventListener('input', saveDetail);
    detailControl.addEventListener('change', saveDetail);
    text.addEventListener('input', () => {
        if (locked()) { text.value = visualStyleText(node.data.visualStyle); return; }
        node.data.visualStyle = normalizeVisualStyle({ description: text.value });
        status.textContent = '';
        refresh();
        save();
    });
    const modelControl = settings.querySelector('[data-style-model]');
    const providerControl = settings.querySelector('[data-style-provider]');
    const providers = () => {
        const model = state.models.find(item => item.id === modelControl.value);
        const options = (model?.providerIds || []).map(id => state.providers.find(item => item.id === id)).filter(Boolean);
        providerControl.innerHTML = '<option value="">选择供应商</option>' + options.map(item => `<option value="${escape(item.id)}">${escape(item.name || item.id)}</option>`).join('');
        providerControl.value = options.some(item => item.id === node.data.styleProviderId) ? node.data.styleProviderId : options[0]?.id || '';
    };
    const refreshModels = () => { modelControl.innerHTML = modelOptions(state, node.data.styleModelId); providers(); };
    refreshModels();
    modelControl.addEventListener('focus', refreshModels);
    providerControl.addEventListener('focus', providers);
    modelControl.addEventListener('change', () => {
        if (locked()) { refreshModels(); return; }
        node.data.styleModelId = modelControl.value; providers(); node.data.styleProviderId = providerControl.value; save();
    });
    providerControl.addEventListener('change', () => {
        if (locked()) { providers(); return; }
        node.data.styleProviderId = providerControl.value; save();
    });
    settings.querySelector('details').addEventListener('toggle', event => {
        if (event.target.open) refreshModels();
    });
    let extracting = false;
    node.extractVisualStyle = async () => {
        if (extracting || locked()) return;
        if (!modelControl.value) {
            settings.querySelector('details').open = true;
            status.textContent = '请选择支持图片输入的模型，再提取风格。';
            modelControl.focus();
            return;
        }
        if (!state.connections.some(edge => edge.to.nodeId === node.id && edge.to.port === 'image'
            && state.nodes.get(edge.from.nodeId)?.enabled !== false)) {
            status.textContent = '请连接风格参考图，再提取风格。';
            return;
        }
        node.data.styleProviderId = providerControl.value;
        extracting = true;
        status.textContent = '正在提取风格…';
        try {
            await runToNode(node.id, { visualStyleFields: ['description'] });
            text.value = visualStyleText(node.data.visualStyle);
            refresh();
            status.textContent = node.executionFailure?.message || '';
        } catch (error) {
            status.textContent = error.message || '提取失败，请重试。';
        } finally { extracting = false; }
    };
    refresh();
}
