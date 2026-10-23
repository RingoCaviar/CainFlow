import { createPromptAgentModelMenus } from './prompt-agent-model-menu.js';
import { getEffectiveProtocol } from '../execution/provider-request-utils.js';
import { resolveAgentSize, sizeCapabilities } from './prompt-agent-size.js';

// Mounts the Agent's image-size settings inside the image model's advanced panel.
// The caller owns the popover lifecycle; model selectors are registered as child popovers.
export function createAgentSizeSettings({ documentRef, parent, popoverId, getModel, getProvider, getValue, onChange }) {
    if (!parent) return { render() {}, destroy() {}, getSummary: () => '' };
    const section = documentRef.createElement('section');
    section.className = 'prompt-agent-size-settings';
    section.setAttribute('aria-label', '生成尺寸');
    const controls = {};
    const fields = documentRef.createElement('div'); fields.className = 'prompt-agent-size-fields'; section.appendChild(fields);
    for (const [key, title] of [['resolution', '分辨率'], ['aspectRatio', '画面比例']]) {
        const label = documentRef.createElement('label');
        const caption = documentRef.createElement('span'); caption.textContent = title; label.appendChild(caption);
        const select = documentRef.createElement('select');
        select.id = `prompt-agent-size-${key}`; select.setAttribute('aria-label', title);
        label.appendChild(select); fields.appendChild(label); controls[key] = select;
    }
    const aspectHint = documentRef.createElement('small'); aspectHint.className = 'prompt-agent-size-aspect-hint';
    controls.aspectRatio.parentElement.appendChild(aspectHint);
    const dimensions = documentRef.createElement('div'); dimensions.className = 'prompt-agent-size-dimensions'; section.appendChild(dimensions);
    for (const [key, title] of [['customWidth', '宽度（px）'], ['customHeight', '高度（px）']]) {
        const label = documentRef.createElement('label'); label.textContent = title;
        const input = documentRef.createElement('input'); input.type = 'number'; input.min = '1'; input.step = '1';
        input.setAttribute('aria-label', title); label.appendChild(input); dimensions.appendChild(label); controls[key] = input;
    }
    const hint = documentRef.createElement('small'); hint.className = 'prompt-agent-size-hint prompt-agent-settings-footer';
    hint.setAttribute('role', 'status'); hint.setAttribute('aria-live', 'polite');
    parent.append(section, hint);
    const menus = createPromptAgentModelMenus({ documentRef, parent: popoverId, selects: [
        { select: controls.resolution, searchLabel: '分辨率' },
        { select: controls.aspectRatio, searchLabel: '画面比例' }
    ] });
    let destroyed = false;
    const getSummary = () => {
        const model = getModel(), value = getValue(model?.id) || {};
        const resolution = value.resolution === undefined ? '跟随方案' : value.resolution || '自动';
        const parts = [resolution];
        if (value.resolution !== 'custom' && value.aspectRatio) parts.push(value.aspectRatio);
        if (value.resolution === 'custom') parts.push(`${value.customWidth || '—'}×${value.customHeight || '—'}`);
        return parts.join(' · ');
    };
    const render = () => {
        if (destroyed) return;
        const model = getModel(), value = getValue(model?.id) || {};
        const capabilities = sizeCapabilities(getEffectiveProtocol(model || {}, getProvider(model)));
        for (const [key, options] of [['resolution', capabilities.resolutions], ['aspectRatio', capabilities.aspects]]) {
            const select = controls[key]; select.replaceChildren();
            const values = [{ value: '__inherit__', label: '跟随方案' }, ...options];
            if (value[key] !== undefined && !values.some(item => item.value === String(value[key]))) values.push({ value: String(value[key]), label: `${value[key]}（当前不可用）`, disabled: true });
            for (const item of values) { const option = documentRef.createElement('option'); option.value = item.value; option.textContent = item.label; option.disabled = Boolean(item.disabled); select.appendChild(option); }
            select.value = value[key] === undefined ? '__inherit__' : String(value[key]); select.disabled = !model;
        }
        const locked = capabilities.automaticLocksAspect && (value.resolution === '' || value.resolution === 'custom');
        controls.aspectRatio.disabled = !model || locked;
        aspectHint.textContent = !model || !locked ? '' : value.resolution === 'custom'
            ? '由宽高决定' : '自动分辨率由模型决定';
        dimensions.hidden = value.resolution !== 'custom';
        for (const key of ['customWidth', 'customHeight']) controls[key].value = value[key] ?? '';
        let message = !model ? '请先选择生图模型。' : '';
        if (model && Object.keys(value).length) {
            try { resolveAgentSize({ protocol: getEffectiveProtocol(model, getProvider(model)), parameters: value }); }
            catch (error) { message = error.message; }
        }
        hint.textContent = message;
        menus.refresh();
    };
    for (const [key, control] of Object.entries(controls)) control.addEventListener('change', () => {
        const model = getModel(); if (!model) return;
        const value = { ...getValue(model.id) };
        if (control.value === '__inherit__' || (control.type === 'number' && !control.value)) delete value[key];
        else value[key] = control.type === 'number' ? Number(control.value) : control.value;
        if (key === 'resolution' && value.resolution !== 'custom') { delete value.customWidth; delete value.customHeight; }
        onChange(model.id, value); render();
    });
    render();
    return { render, destroy() { destroyed = true; menus.destroy(); section.remove(); hint.remove(); }, getSummary };
}
